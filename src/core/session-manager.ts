import { existsSync, readFileSync, unlinkSync } from 'fs';
import { join, resolve } from 'path';
import { query, type SDKResultMessage, type CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import { getConfig } from '../config/index.js';
import { getLogger } from '../logger/index.js';
import {
  readActiveSession,
  createActiveSession,
  clearActiveSession,
  archiveSession,
  appendConversation,
  readConversation,
  writeActiveSession,
  listArchivedSessions,
  conversationPath,
  readCumulativeSummary,
  writeCumulativeSummary,
  sessionsDir,
  type SessionMetadata,
  type ConversationEntry,
  type ConversationBlock,
  type CarryoverEntry,
  type CumulativeSummary,
} from './session-store.js';

// ─── 后台轮转状态 ────────────────────────────────────────────────────

/** 后台轮转准备状态。 */
interface BackgroundRotation {
  /** 当前状态：preparing=后台生成中，ready=已就绪待切换。 */
  state: 'preparing' | 'ready';
  /** 触发后台准备时的 messageCount（用于识别中间对话）。 */
  triggerMessageCount: number;
  /** 旧 session 的 localId（用于防护校验）。 */
  oldLocalId: string;
  /** 预生成的摘要文本。 */
  summary?: string;
  /** 后台任务 Promise（用于 force 时 await）。 */
  promise: Promise<void>;
}

/** 每用户后台轮转状态（内存中，进程重启后丢失）。 */
const bgRotations = new Map<string, BackgroundRotation>();

// ─── Carryover 提取（规则化 digest） ─────────────────────────────────

/** Digest 参数（从 config 读取）。 */
export interface DigestParams {
  userMaxChars: number;
  assistantHeadChars: number;
  assistantTailChars: number;
}

/**
 * 对用户消息内容进行 digest。
 * 超过阈值则截断并注明总长度。
 */
export function digestUserContent(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  return content.slice(0, maxChars) + `... (${content.length} chars total)`;
}

/**
 * 对 assistant 回复内容进行 digest。
 * 保留开头 + 结尾原文，中间省略并注明总长度。
 * 若总长度 ≤ headChars + tailChars，则保留全文。
 */
export function digestAssistantContent(
  content: string,
  headChars: number,
  tailChars: number,
): string {
  if (content.length <= headChars + tailChars) return content;
  return (
    content.slice(0, headChars) +
    `\n...(omitted, ${content.length} chars total)...\n` +
    content.slice(-tailChars)
  );
}

/**
 * 从对话记录中提取最后 N 轮的 carryover，并对内容做 digest。
 *
 * 一轮 = 1 条 user 消息 + 该轮最后 1 条 assistant 回复（agent 循环中的中间回复丢弃）。
 *
 * @param conversation - 完整对话记录。
 * @param maxTurns - 最多提取的轮次数。
 * @param digest - Digest 参数。
 * @returns CarryoverEntry 数组。
 */
export function extractCarryover(
  conversation: ConversationEntry[],
  maxTurns: number,
  digest: DigestParams,
): CarryoverEntry[] {
  if (maxTurns <= 0 || conversation.length === 0) return [];

  // 将对话分组为轮次：每轮以 user 消息开头，到下一条 user 消息前结束。
  // 每轮中只保留最后一条 assistant 回复。
  const turns: Array<{ user: ConversationEntry; assistant?: ConversationEntry }> = [];
  let currentTurn: { user: ConversationEntry; assistant?: ConversationEntry } | null = null;

  for (const entry of conversation) {
    if (entry.role === 'user') {
      if (currentTurn) turns.push(currentTurn);
      currentTurn = { user: entry };
    } else if (entry.role === 'assistant' && currentTurn) {
      // 始终用最新的 assistant 消息覆盖，只保留最后一条。
      currentTurn.assistant = entry;
    }
  }
  if (currentTurn) turns.push(currentTurn);

  // 取最后 N 轮。
  const recentTurns = turns.slice(-maxTurns);

  // 构建 carryover 条目并 digest。
  const result: CarryoverEntry[] = [];
  for (const turn of recentTurns) {
    result.push({
      timestamp: turn.user.timestamp,
      role: 'user',
      content: digestUserContent(turn.user.content, digest.userMaxChars),
    });
    if (turn.assistant) {
      result.push({
        timestamp: turn.assistant.timestamp,
        role: 'assistant',
        content: digestAssistantContent(
          turn.assistant.content,
          digest.assistantHeadChars,
          digest.assistantTailChars,
        ),
      });
    }
  }

  return result;
}

// ─── 轮转检查 ────────────────────────────────────────────────────────

/** 轮转原因。 */
export type RotationReason = 'timeout' | 'max_context' | 'manual';

/**
 * 检查是否需要自动轮转。
 *
 * @param userId - 用户 ID。
 * @returns 轮转原因，不需要轮转时返回 null。
 */
export function checkRotationNeeded(userId: string): RotationReason | null {
  const config = getConfig();
  const session = readActiveSession(userId);

  if (!session || !session.sdkSessionId) {
    // 没有活跃会话或会话尚未有 SDK session，不需要轮转。
    return null;
  }

  // 检查时间间隔。
  const lastActive = new Date(session.updatedAt).getTime();
  const now = Date.now();
  const hoursSinceLastActive = (now - lastActive) / (1000 * 60 * 60);

  if (hoursSinceLastActive >= config.session.rotationTimeoutHours) {
    return 'timeout';
  }

  // 检查 context token 占比（需要已知 context window 大小）。
  if (session.contextWindowTokens > 0) {
    const threshold = session.contextWindowTokens * config.session.rotationContextRatio;
    if (session.contextTokens >= threshold) {
      return 'max_context';
    }
  }

  return null;
}

// ─── 轮转执行 ────────────────────────────────────────────────────────

/**
 * 执行会话轮转：归档当前会话并创建新会话。
 *
 * @param userId - 用户 ID。
 * @param reason - 轮转原因。
 * @returns 新会话的元数据。
 */
export async function rotateSession(
  userId: string,
  reason: RotationReason,
): Promise<SessionMetadata> {
  const log = getLogger();
  const config = getConfig();

  // 取消任何进行中的后台轮转准备（手动轮转 / timeout 优先）。
  bgRotations.delete(userId);

  const currentSession = readActiveSession(userId);

  if (currentSession && currentSession.sdkSessionId) {
    const contextPct = currentSession.contextWindowTokens > 0
      ? `${(currentSession.contextTokens / currentSession.contextWindowTokens * 100).toFixed(1)}%`
      : 'N/A';
    log.info(
      {
        userId,
        reason,
        localId: currentSession.localId,
        messageCount: currentSession.messageCount,
        totalTurns: currentSession.totalTurns,
        contextTokens: currentSession.contextTokens,
        contextWindowTokens: currentSession.contextWindowTokens,
        contextUsage: contextPct,
        costUsd: currentSession.totalCostUsd,
      },
      'Rotating session',
    );

    // 生成摘要（如果启用）。
    let summary: string | undefined;
    if (config.session.summaryEnabled) {
      try {
        const conversation = readConversation(userId, currentSession.localId);
        const summaryPath = join(sessionsDir(userId), currentSession.localId, 'summary.txt');
        summary = await generateSummary(conversation, summaryPath);
      } catch (err) {
        log.error({ err, userId }, 'Failed to generate session summary');
        summary = `[Summary generation failed] Session had ${currentSession.messageCount} messages over ${currentSession.totalTurns} turns.`;
      }
    }

    // 归档当前会话。
    const archivedMetadata: SessionMetadata = {
      ...currentSession,
      endedAt: new Date().toISOString(),
      summary,
    };
    archiveSession(userId, archivedMetadata);

    log.info(
      {
        userId,
        localId: currentSession.localId,
        summary: summary?.slice(0, 100),
      },
      'Session archived',
    );
  }

  // 提取旧 session 最后 N 轮对话作为 carryover（规则化 digest）。
  let carryover: CarryoverEntry[] = [];
  if (currentSession) {
    const carryoverTurns = config.session.carryoverTurns ?? 5;
    const digest: DigestParams = {
      userMaxChars: config.session.carryoverUserMaxChars ?? 500,
      assistantHeadChars: config.session.carryoverAssistantHeadChars ?? 200,
      assistantTailChars: config.session.carryoverAssistantTailChars ?? 200,
    };
    try {
      const conversation = readConversation(userId, currentSession.localId);
      carryover = extractCarryover(conversation, carryoverTurns, digest);
    } catch (err) {
      log.warn({ err, userId }, 'Failed to extract carryover from old session');
    }
  }

  // 将超出短期窗口的旧 session 浓缩到累积摘要。
  try {
    await consolidateOldSessions(userId);
  } catch (err) {
    log.error({ err, userId }, 'Failed to consolidate old sessions into cumulative summary');
  }

  // 清除活跃会话并创建新的。
  clearActiveSession(userId);
  const newSession = createActiveSession(userId);

  // 写入 carryover 到新 session metadata。
  if (carryover.length > 0) {
    newSession.carryover = carryover;
    writeActiveSession(userId, newSession);
  }

  log.info(
    { userId, newLocalId: newSession.localId, carryoverEntries: carryover.length },
    'New session created',
  );

  return newSession;
}

// ─── 后台轮转准备 ────────────────────────────────────────────────────

/**
 * 启动后台轮转准备（异步生成摘要 + 浓缩旧 session）。
 *
 * 此函数立即返回，不阻塞调用方。后台任务完成后将 state 标记为 'ready'。
 *
 * @param userId - 用户 ID。
 * @param session - 当前活跃会话。
 */
function startBackgroundPrep(userId: string, session: SessionMetadata): void {
  const log = getLogger();

  log.info(
    { userId, localId: session.localId, messageCount: session.messageCount },
    'Starting background rotation prep',
  );

  const bg: BackgroundRotation = {
    state: 'preparing',
    triggerMessageCount: session.messageCount,
    oldLocalId: session.localId,
    promise: null!,  // 下面立即赋值。
  };

  bg.promise = (async () => {
    try {
      const config = getConfig();

      // 生成摘要。
      let summary: string | undefined;
      if (config.session.summaryEnabled) {
        const conversation = readConversation(userId, session.localId);
        const summaryPath = join(sessionsDir(userId), session.localId, 'summary.txt');
        summary = await generateSummary(conversation, summaryPath);
      }
      bg.summary = summary;

      // 预浓缩旧 session 到累积摘要。
      await consolidateOldSessions(userId);

      bg.state = 'ready';
      log.info({ userId, localId: session.localId }, 'Background rotation prep ready');
    } catch (err) {
      log.error({ err, userId }, 'Background rotation prep failed, using fallback summary');
      bg.summary = `[Summary generation failed] Session had ${session.messageCount} messages over ${session.totalTurns} turns.`;
      bg.state = 'ready';  // 仍然标记 ready，使用 fallback 摘要。
    }
  })();

  bgRotations.set(userId, bg);
}

/**
 * 利用预生成的摘要瞬间完成会话切换。
 *
 * @param userId - 用户 ID。
 * @param bg - 后台轮转状态（必须为 ready）。
 * @returns 新会话的元数据。
 */
function performInstantSwitch(userId: string, bg: BackgroundRotation): SessionMetadata {
  const log = getLogger();
  const currentSession = readActiveSession(userId);

  // 防护校验：确保 session 没有在后台期间被手动切换。
  if (!currentSession || currentSession.localId !== bg.oldLocalId) {
    log.warn(
      { userId, expected: bg.oldLocalId, actual: currentSession?.localId },
      'Session changed during background prep, skipping instant switch',
    );
    bgRotations.delete(userId);
    return currentSession || createActiveSession(userId);
  }

  // 提取 carryover：旧 session 最后 N 轮对话（规则化 digest）。
  const config = getConfig();
  const carryoverTurns = config.session.carryoverTurns ?? 5;
  const digest: DigestParams = {
    userMaxChars: config.session.carryoverUserMaxChars ?? 500,
    assistantHeadChars: config.session.carryoverAssistantHeadChars ?? 200,
    assistantTailChars: config.session.carryoverAssistantTailChars ?? 200,
  };
  const allConversations = readConversation(userId, currentSession.localId);
  const carryover = extractCarryover(allConversations, carryoverTurns, digest);

  // 归档旧 session（使用预生成的摘要）。
  const archivedMetadata: SessionMetadata = {
    ...currentSession,
    endedAt: new Date().toISOString(),
    summary: bg.summary,
  };
  archiveSession(userId, archivedMetadata);

  log.info(
    {
      userId,
      localId: currentSession.localId,
      summary: bg.summary?.slice(0, 100),
    },
    'Session archived (instant switch)',
  );

  // 创建新 session。
  clearActiveSession(userId);
  const newSession = createActiveSession(userId);

  // 写入 carryover 到新 session metadata。
  if (carryover.length > 0) {
    newSession.carryover = carryover;
    writeActiveSession(userId, newSession);
  }

  bgRotations.delete(userId);

  log.info(
    {
      userId,
      oldLocalId: bg.oldLocalId,
      newLocalId: newSession.localId,
      carryoverEntries: carryover.length,
    },
    'Instant session switch completed',
  );

  return newSession;
}

// ─── 会话生命周期 ────────────────────────────────────────────────────

/**
 * 确保用户有一个活跃会话。
 *
 * 实现三级轮转策略：
 * 1. timeout：超时直接同步轮转。
 * 2. softRatio（rotationContextRatio）：达到后在后台启动摘要生成，不阻塞。
 * 3. forceRatio（rotationForceRatio）：兜底，同步等待后台完成或直接同步轮转。
 *
 * 后台准备期间队列正常消费（不阻塞）；force 时阻塞直到轮转完成。
 *
 * @param userId - 用户 ID。
 * @returns 活跃会话元数据和可选的轮转原因。
 */
export async function ensureActiveSession(
  userId: string,
): Promise<{ session: SessionMetadata; rotated: boolean; reason?: RotationReason }> {
  const config = getConfig();
  const log = getLogger();

  // 读取或创建活跃会话。
  let session = readActiveSession(userId);
  if (!session) {
    session = createActiveSession(userId);
    return { session, rotated: false };
  }

  // 没有 SDK session 意味着还没发过消息，不需要轮转。
  if (!session.sdkSessionId) {
    return { session, rotated: false };
  }

  // ── 1. 检查 timeout ──
  const lastActive = new Date(session.updatedAt).getTime();
  const hoursSinceLastActive = (Date.now() - lastActive) / (1000 * 60 * 60);

  if (hoursSinceLastActive >= config.session.rotationTimeoutHours) {
    // Timeout 优先：如果有后台任务在跑，先 await 再做同步轮转。
    const bg = bgRotations.get(userId);
    if (bg) {
      await bg.promise;
      bgRotations.delete(userId);
    }
    const newSession = await rotateSession(userId, 'timeout');
    return { session: newSession, rotated: true, reason: 'timeout' };
  }

  // ── 2. 检查 context 占比 ──
  if (session.contextWindowTokens <= 0) {
    return { session, rotated: false };
  }

  const contextRatio = session.contextTokens / session.contextWindowTokens;
  const softRatio = config.session.rotationContextRatio;
  const forceRatio = config.session.rotationForceRatio ?? 0.9;
  const bg = bgRotations.get(userId);

  // ── 2a. 后台已就绪 → 瞬间切换 ──
  if (bg && bg.state === 'ready') {
    const newSession = performInstantSwitch(userId, bg);
    return { session: newSession, rotated: true, reason: 'max_context' };
  }

  // ── 2b. 后台准备中 ──
  if (bg && bg.state === 'preparing') {
    if (contextRatio >= forceRatio) {
      // Force 阈值命中 → 同步等待后台完成，期间队列不消费后续消息。
      log.info(
        { userId, contextRatio: contextRatio.toFixed(3), forceRatio },
        'Force rotation threshold hit, awaiting background prep',
      );
      await bg.promise;
      const newSession = performInstantSwitch(userId, bg);
      return { session: newSession, rotated: true, reason: 'max_context' };
    }
    // 尚未达到 force 阈值，继续使用旧 session。
    return { session, rotated: false };
  }

  // ── 2c. 无后台任务（idle）──
  if (contextRatio >= forceRatio) {
    // 直接达到 force 阈值（不应常见） → 同步轮转。
    log.warn(
      { userId, contextRatio: contextRatio.toFixed(3), forceRatio },
      'Force rotation without background prep (should not happen normally)',
    );
    const newSession = await rotateSession(userId, 'max_context');
    return { session: newSession, rotated: true, reason: 'max_context' };
  }

  if (contextRatio >= softRatio) {
    // 达到软阈值 → 启动后台准备，不阻塞当前消息。
    startBackgroundPrep(userId, session);
    return { session, rotated: false };
  }

  return { session, rotated: false };
}

/**
 * 查询完成后更新会话状态和对话记录。
 *
 * @param userId - 用户 ID。
 * @param localSessionId - 本次查询开始时的本地会话 ID（确保记录到正确的会话，
 *   即使 session_new 工具在查询期间触发了轮转）。
 * @param userMessage - 用户消息文本。
 * @param assistantResponse - 助手响应文本。
 * @param resultMeta - 查询结果元数据。
 */
export function updateSessionAfterQuery(
  userId: string,
  localSessionId: string,
  userMessage: string,
  assistantResponse: string,
  resultMeta: {
    costUsd?: number;
    turns?: number;
    durationMs?: number;
    contextTokens?: number;
    contextWindowTokens?: number;
  },
  blocks?: ConversationBlock[],
): void {
  const now = new Date().toISOString();

  // 追加对话记录到本次查询所属的会话。
  const assistantEntry: ConversationEntry = {
    timestamp: now,
    role: 'assistant',
    content: assistantResponse,
    metadata: {
      costUsd: resultMeta.costUsd,
      turns: resultMeta.turns,
      durationMs: resultMeta.durationMs,
    },
  };

  // 附加完整交互块（如果有）。
  if (blocks && blocks.length > 0) {
    assistantEntry.blocks = blocks;
  }

  const entries: ConversationEntry[] = [
    {
      timestamp: now,
      role: 'user',
      content: userMessage,
    },
    assistantEntry,
  ];
  appendConversation(userId, localSessionId, entries);

  // 更新活跃会话元数据（如果本次查询的会话仍然是活跃会话）。
  const session = readActiveSession(userId);
  if (session && session.localId === localSessionId) {
    session.messageCount += 1;
    session.totalTurns += resultMeta.turns ?? 0;
    session.totalCostUsd += resultMeta.costUsd ?? 0;
    // contextTokens 取最新值（每次 query 的 input_tokens 反映当前 context 大小）。
    if (resultMeta.contextTokens) {
      session.contextTokens = resultMeta.contextTokens;
    }
    // contextWindowTokens 取从 SDK 获取的模型 context window 大小。
    if (resultMeta.contextWindowTokens) {
      session.contextWindowTokens = resultMeta.contextWindowTokens;
    }
    // 保留 carryover 直到 session 轮转，确保模型在整个 session 生命周期内
    // 都能看到上一个 session 的最近对话上下文。
    session.updatedAt = now;
    writeActiveSession(userId, session);
  }
}

// ─── 会话信息查询 ────────────────────────────────────────────────────

/**
 * 获取当前会话信息（供 MCP 工具 / system prompt 使用）。
 *
 * @param userId - 用户 ID。
 * @returns 活跃会话信息。
 */
export function getCurrentSessionInfo(userId: string): SessionMetadata | null {
  return readActiveSession(userId);
}

/**
 * 获取用户的会话历史信息（供 system prompt 使用）。
 *
 * @param userId - 用户 ID。
 * @returns 格式化的会话历史文本。
 */
export function getSessionHistoryForPrompt(userId: string): string {
  const config = getConfig();
  const maxRecent = config.session.maxRecentSessions;
  const archived = listArchivedSessions(userId);
  const current = readActiveSession(userId);
  const cumulative = readCumulativeSummary(userId);

  if (archived.length === 0 && !current && !cumulative) {
    return '';
  }

  const lines: string[] = [];

  // 当前会话信息。
  if (current) {
    const contextPct = current.contextWindowTokens > 0
      ? ` (${(current.contextTokens / current.contextWindowTokens * 100).toFixed(1)}% of ${current.contextWindowTokens.toLocaleString()})`
      : '';
    lines.push(`### Current Session`);
    lines.push(`- ID: ${current.localId}`);
    lines.push(`- Started: ${current.createdAt}`);
    lines.push(`- Messages: ${current.messageCount}, Context: ${current.contextTokens.toLocaleString()} tokens${contextPct}`);
    lines.push('');

    // 渲染 carryover（上一个 session 轮转时携带的最近对话，保留直到本 session 轮转）。
    if (current.carryover && current.carryover.length > 0) {
      lines.push('### Carried Over from Previous Session');
      lines.push('The following recent conversations from the end of the previous session are provided for context continuity:');
      lines.push('');
      for (const entry of current.carryover) {
        const label = entry.role === 'user' ? 'User' : 'Assistant';
        lines.push(`**${label}**: ${entry.content}`);
      }
      lines.push('');
    }
  }

  // 最近的归档会话（短期记忆，显示详细摘要）。
  if (archived.length > 0) {
    const recentSessions = archived.slice(0, maxRecent);
    lines.push(`### Previous Sessions (${recentSessions.length} recent of ${archived.length} total)`);
    for (const s of recentSessions) {
      const timeRange = `${formatTime(s.createdAt)} → ${formatTime(s.endedAt!)}`;
      lines.push(`- **${s.localId}** (${timeRange}, ${s.messageCount} msgs)`);
      if (s.summary) {
        lines.push(`  Summary: ${s.summary}`);
      }
      lines.push(`  Conversation: ${conversationPath(userId, s.localId)}`);
    }
  }

  // 累积摘要（长期记忆，覆盖更早的所有 session）。
  if (cumulative?.text) {
    lines.push('');
    lines.push(`### Long-term Memory (condensed from ${cumulative.sessionCount} older sessions)`);
    lines.push(cumulative.text);
  }

  // 如果有超出短期窗口的旧 session，提示 AI 可以去目录查找详细对话记录。
  const olderCount = archived.length - Math.min(archived.length, maxRecent);
  if (olderCount > 0) {
    lines.push('');
    lines.push(`> **Note**: ${olderCount} older session(s) are condensed in Long-term Memory above. If you need detailed conversation logs, read files from: \`${sessionsDir(userId)}/\` (each subfolder contains metadata.json and conversation.json).`);
  }

  return lines.join('\n');
}

// ─── 累积摘要浓缩 ────────────────────────────────────────────────────

/**
 * 将超出短期窗口的旧 session 摘要浓缩到累积摘要中。
 *
 * 仅在归档 session 数量超过 maxRecentSessions 时触发。
 * 将最近 maxRecentSessions 个之外的 session 的摘要合并到累积摘要，
 * 然后通过 AI 重新浓缩整体累积摘要，控制长度。
 *
 * @param userId - 用户 ID。
 */
async function consolidateOldSessions(userId: string): Promise<void> {
  const log = getLogger();
  const config = getConfig();
  const maxRecent = config.session.maxRecentSessions;
  const archived = listArchivedSessions(userId); // 按创建时间倒序

  if (archived.length <= maxRecent) {
    // 还没超出短期窗口，无需浓缩。
    return;
  }

  // 超出短期窗口的旧 session（跳过最近 maxRecent 个）。
  const oldSessions = archived.slice(maxRecent);

  // 收集需要新浓缩的 session 摘要。
  const existing = readCumulativeSummary(userId);
  const existingSessionCount = existing?.sessionCount ?? 0;

  // 只处理尚未被浓缩过的 session。
  const newOldCount = oldSessions.length;
  if (newOldCount <= existingSessionCount) {
    // 没有新的旧 session 需要浓缩。
    return;
  }

  // 收集新增的旧 session 摘要（已浓缩的之外的部分）。
  // oldSessions 是按时间倒序的，取前面的（较新的）还没被浓缩的。
  const newSessionsToMerge = oldSessions.slice(0, newOldCount - existingSessionCount);
  const newSummaries = newSessionsToMerge
    .filter((s) => s.summary && !s.summary.startsWith('[Summary generation failed]'))
    .map((s) => {
      const timeRange = `${formatTime(s.createdAt)} → ${formatTime(s.endedAt!)}`;
      return `[${timeRange}] ${s.summary}`;
    });

  if (newSummaries.length === 0 && !existing?.text) {
    // 没有可浓缩的内容。
    writeCumulativeSummary(userId, {
      text: '',
      sessionCount: newOldCount,
      updatedAt: new Date().toISOString(),
    });
    return;
  }

  // 构建输入：已有累积摘要 + 新增的 session 摘要。
  const inputParts: string[] = [];
  if (existing?.text) {
    inputParts.push(`Existing cumulative summary:\n${existing.text}`);
  }
  if (newSummaries.length > 0) {
    inputParts.push(`New session summaries to incorporate:\n${newSummaries.join('\n')}`);
  }

  // 调用 AI 浓缩，LLM 直接写入临时文件。
  const condensedOutputPath = join(sessionsDir(userId), '.condensed-summary.txt');
  const condensedText = await condenseCumulativeSummary(inputParts.join('\n\n'), condensedOutputPath);

  writeCumulativeSummary(userId, {
    text: condensedText,
    sessionCount: newOldCount,
    updatedAt: new Date().toISOString(),
  });

  log.info(
    {
      userId,
      totalOldSessions: newOldCount,
      newlyMerged: newSessionsToMerge.length,
      summaryLength: condensedText.length,
    },
    'Consolidated old sessions into cumulative summary',
  );
}

/**
 * 通过 SDK query() 执行 LLM 调用，让模型直接把结果写入指定文件。
 *
 * 复用 Claude Code CLI 认证，无需单独配置 API Key。
 * 程序侧仅校验文件是否成功生成且非空，无需解析 LLM 返回文本。
 *
 * @param prompt - 发送给 LLM 的 prompt（需包含写入文件的指令和路径）。
 * @param outputPath - 期望 LLM 写入的文件路径。
 * @param model - 使用的模型 ID。
 * @returns 文件中的内容文本。
 */
export async function runQueryToFile(prompt: string, outputPath: string, model: string): Promise<string> {
  // 清理可能残留的旧文件。
  if (existsSync(outputPath)) {
    unlinkSync(outputPath);
  }

  // 将 outputPath 解析为绝对路径，确保与 LLM 传入的路径比较一致。
  const absOutputPath = resolve(outputPath);

  // 权限防护：
  // 1. tools: ['Write'] — 模型上下文中只存在 Write 工具，其他工具完全不可见。
  // 2. canUseTool — 即使使用了 Write，也只允许写入 outputPath 这一个文件。
  //    防止对话内容中的 prompt injection 诱导模型写入非预期路径。
  const canUseTool: CanUseTool = async (_toolName, input) => {
    const filePath = (input as Record<string, unknown>)?.file_path;
    if (typeof filePath === 'string' && resolve(filePath) === absOutputPath) {
      return { behavior: 'allow' as const, updatedInput: input as Record<string, unknown> };
    }
    return {
      behavior: 'deny' as const,
      message: `Write is only allowed to ${absOutputPath}. Denied: ${filePath}`,
    };
  };

  const q = query({
    prompt,
    options: {
      model,
      maxTurns: 2,  // Write(1) + result(1)，模型只能看到 Write 工具，不会浪费 turn
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      tools: ['Write'],
      canUseTool,
    },
  });

  for await (const msg of q) {
    if (msg.type === 'result') {
      const result = msg as SDKResultMessage;
      if (result.subtype !== 'success') {
        throw new Error(`SDK query failed: ${JSON.stringify(result)}`);
      }
    }
  }

  // 校验文件是否生成。
  if (!existsSync(outputPath)) {
    throw new Error(`LLM did not write to expected file: ${outputPath}`);
  }

  const content = readFileSync(outputPath, 'utf-8').trim();
  if (content.length === 0) {
    throw new Error(`LLM wrote an empty file: ${outputPath}`);
  }

  return content;
}

/**
 * 调用 LLM 将多个 session 摘要浓缩为一段累积摘要，直接写入指定文件。
 *
 * @param input - 包含已有累积摘要和新增摘要的文本。
 * @param outputPath - 摘要输出文件路径。
 * @returns 浓缩后的累积摘要文本。
 */
async function condenseCumulativeSummary(input: string, outputPath: string): Promise<string> {
  const config = getConfig();

  const prompt = `You are maintaining a long-term memory summary for a personal AI assistant. Your ONLY task is to write a condensed summary to a file.

Instructions:
1. Read the input below (existing summary + new session summaries)
2. Produce a single, cohesive summary that preserves all important facts, decisions, preferences, and outcomes
3. Remove redundant information, stay concise (aim for 3-8 sentences)
4. Organize by topic/theme rather than chronologically when possible
5. Write in the same language the user used (Chinese if the summaries are in Chinese)
6. Write ONLY the pure summary text to this EXACT file path: ${outputPath}
7. Do NOT include any conversational preamble, headers, or explanations — just the summary itself

Input:
${input}

IMPORTANT: Use the Write tool to write ONLY the pure condensed summary to ${outputPath}. Nothing else.`;

  return runQueryToFile(prompt, outputPath, config.session.summaryModel);
}

// ─── AI 摘要生成 ──────────────────────────────────────────────────────

/**
 * 将对话记录按条目边界分块，每块不超过 maxChars。
 *
 * @param conversation - 完整对话记录。
 * @param maxChars - 每块最大字符数。
 * @returns 分块后的文本数组。
 */
export function splitConversationIntoChunks(
  conversation: ConversationEntry[],
  maxChars: number,
): string[] {
  const chunks: string[] = [];
  let currentChunk = '';

  for (const entry of conversation) {
    const line = `[${entry.role}]: ${entry.content}\n\n`;
    // 若当前块加上这条会超限，且当前块非空，则先切块。
    if (currentChunk.length + line.length > maxChars && currentChunk.length > 0) {
      chunks.push(currentChunk.trimEnd());
      currentChunk = '';
    }
    currentChunk += line;
  }

  if (currentChunk.trim().length > 0) {
    chunks.push(currentChunk.trimEnd());
  }

  return chunks;
}

/**
 * 调用 LLM 生成对话摘要，直接写入指定文件。
 *
 * 当对话总长度超过 summaryChunkMaxChars 时，自动分块：
 * 1. 按条目边界将对话切分为多个块。
 * 2. 每块独立生成中间摘要。
 * 3. 将所有中间摘要合并，生成最终摘要。
 *
 * @param conversation - 对话记录。
 * @param outputPath - 摘要输出文件路径。
 * @returns 摘要文本。
 */
async function generateSummary(conversation: ConversationEntry[], outputPath: string): Promise<string> {
  const log = getLogger();
  const config = getConfig();

  if (conversation.length === 0) {
    return 'Empty session.';
  }

  const chunkMaxChars = config.session.summaryChunkMaxChars;
  const model = config.session.summaryModel;
  const chunks = splitConversationIntoChunks(conversation, chunkMaxChars);

  log.debug(
    { model, conversationLength: conversation.length, chunks: chunks.length },
    'Generating session summary',
  );

  if (chunks.length === 1) {
    // 单块：直接生成摘要。
    return generateSingleSummary(chunks[0], outputPath, model);
  }

  // 多块：map-reduce。
  log.info(
    { chunks: chunks.length, model },
    'Conversation exceeds chunk limit, using map-reduce summary',
  );

  const chunkSummaries: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunkPath = outputPath.replace(/\.txt$/, `.chunk${i}.txt`);
    const chunkSummary = await generateChunkSummary(
      chunks[i], i + 1, chunks.length, chunkPath, model,
    );
    chunkSummaries.push(chunkSummary);
    // 清理临时文件。
    if (existsSync(chunkPath)) unlinkSync(chunkPath);
  }

  // 合并中间摘要为最终摘要。
  const mergedInput = chunkSummaries
    .map((s, i) => `[Part ${i + 1}/${chunks.length}]: ${s}`)
    .join('\n\n');
  return generateMergedSummary(mergedInput, outputPath, model);
}

/** 单块摘要生成（对话完整放入一次 LLM 调用）。 */
async function generateSingleSummary(
  conversationText: string,
  outputPath: string,
  model: string,
): Promise<string> {
  const prompt = `You are a session summary writer. Your ONLY task is to write a concise summary to a file.

Instructions:
1. Read the conversation below
2. Write a 2-3 sentence summary to this EXACT file path: ${outputPath}
3. The summary must be in the SAME LANGUAGE as the conversation (Chinese if the conversation is in Chinese)
4. Write ONLY the pure summary text — no headers, no markdown formatting, no explanations, no conversational preamble
5. Do NOT say anything like "Here is the summary" or "I'd be happy to help" — just write the summary itself
6. Focus on: key topics discussed, decisions made, important outcomes

Conversation:
${conversationText}

IMPORTANT: Use the Write tool to write ONLY the pure summary to ${outputPath}. Nothing else.`;

  return runQueryToFile(prompt, outputPath, model);
}

/** 分块中间摘要生成（map 阶段）。 */
async function generateChunkSummary(
  chunkText: string,
  partIndex: number,
  totalParts: number,
  outputPath: string,
  model: string,
): Promise<string> {
  const prompt = `You are a session summary writer. Your ONLY task is to write a concise partial summary to a file.

This is part ${partIndex} of ${totalParts} of a conversation. Summarize ONLY this portion.

Instructions:
1. Read the conversation portion below
2. Write a 2-3 sentence summary of THIS PORTION to this EXACT file path: ${outputPath}
3. The summary must be in the SAME LANGUAGE as the conversation (Chinese if the conversation is in Chinese)
4. Write ONLY the pure summary text — no headers, no "Part X" labels, no markdown formatting
5. Focus on: key topics discussed, decisions made, important outcomes in this portion

Conversation (part ${partIndex}/${totalParts}):
${chunkText}

IMPORTANT: Use the Write tool to write ONLY the pure partial summary to ${outputPath}. Nothing else.`;

  return runQueryToFile(prompt, outputPath, model);
}

/** 合并多个中间摘要为最终摘要（reduce 阶段）。 */
async function generateMergedSummary(
  partialSummaries: string,
  outputPath: string,
  model: string,
): Promise<string> {
  const prompt = `You are a session summary writer. Your ONLY task is to merge partial summaries into a final cohesive summary.

Instructions:
1. Read the partial summaries below (each covers a chronological portion of the same conversation)
2. Write a single cohesive 2-4 sentence summary to this EXACT file path: ${outputPath}
3. The summary must be in the SAME LANGUAGE as the partial summaries
4. Write ONLY the pure summary text — no headers, no markdown formatting, no explanations
5. Preserve all key topics, decisions, and outcomes from every part — do NOT omit any part
6. Organize chronologically or by importance, keeping it concise

Partial summaries:
${partialSummaries}

IMPORTANT: Use the Write tool to write ONLY the pure merged summary to ${outputPath}. Nothing else.`;

  return runQueryToFile(prompt, outputPath, model);
}

// ─── 工具函数 ────────────────────────────────────────────────────────

/**
 * 格式化 ISO 时间为简短形式。
 *
 * @param isoString - ISO 8601 时间字符串。
 * @returns 格式化的时间字符串。
 */
function formatTime(isoString: string): string {
  const d = new Date(isoString);
  return d.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Shanghai',
  });
}
