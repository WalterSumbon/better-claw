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
        summary = await generateSummary(conversation);
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

  // 将超出短期窗口的旧 session 浓缩到累积摘要。
  try {
    await consolidateOldSessions(userId);
  } catch (err) {
    log.error({ err, userId }, 'Failed to consolidate old sessions into cumulative summary');
  }

  // 清除活跃会话并创建新的。
  clearActiveSession(userId);
  const newSession = createActiveSession(userId);

  log.info(
    { userId, newLocalId: newSession.localId },
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
        summary = await generateSummary(conversation);
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

  // 提取 carryover：触发点之后的中间对话（仅用户文本 + agent 最终回复）。
  const allConversations = readConversation(userId, currentSession.localId);
  // 每个 messageCount 对应 conversation.json 中的 2 个条目（user + assistant）。
  const carryoverStartIdx = bg.triggerMessageCount * 2;
  const intermediateEntries = allConversations.slice(carryoverStartIdx);
  const carryover: CarryoverEntry[] = intermediateEntries
    .filter((e) => e.role === 'user' || e.role === 'assistant')
    .map((e) => ({ timestamp: e.timestamp, role: e.role, content: e.content }));

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
    // 清除 carryover（仅在新 session 的首次查询后存在，避免后续查询重复注入）。
    if (session.carryover) {
      delete session.carryover;
    }
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

    // 渲染 carryover（上一个 session 轮转时的中间对话，仅在首次查询中存在）。
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

  // 调用 AI 浓缩。
  const condensedText = await condenseCumulativeSummary(inputParts.join('\n\n'));

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
 * 调用 Claude API 将多个 session 摘要浓缩为一段累积摘要。
 *
 * @param input - 包含已有累积摘要和新增摘要的文本。
 * @returns 浓缩后的累积摘要文本。
 */
async function condenseCumulativeSummary(input: string): Promise<string> {
  const config = getConfig();

  const baseUrl = config.anthropic.baseUrl || 'https://api.anthropic.com';
  const headers: Record<string, string> = {
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
  };

  if (config.anthropic.authToken) {
    headers['Authorization'] = `Bearer ${config.anthropic.authToken}`;
  }
  if (config.anthropic.apiKey) {
    headers['x-api-key'] = config.anthropic.apiKey;
  }

  const body = {
    model: config.session.summaryModel,
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: `You are maintaining a long-term memory summary for a personal AI assistant. Below is the existing cumulative summary and/or new session summaries that need to be incorporated.

Please produce a single, cohesive summary that:
1. Preserves all important facts, decisions, preferences, and outcomes
2. Removes redundant information
3. Stays concise (aim for 3-8 sentences)
4. Writes in the same language the user used (Chinese if the summaries are in Chinese)
5. Organizes by topic/theme rather than chronologically when possible

${input}`,
      },
    ],
  };

  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Cumulative summary API call failed (${response.status}): ${errorText}`);
  }

  const data = (await response.json()) as {
    content?: Array<{ type: string; text?: string }>;
  };

  const text = data.content?.find((b) => b.type === 'text')?.text;
  if (!text) {
    throw new Error('Cumulative summary API returned no text content');
  }

  return text;
}

// ─── AI 摘要生成 ──────────────────────────────────────────────────────

/**
 * 调用 Claude API 生成对话摘要。
 *
 * @param conversation - 对话记录。
 * @returns 摘要文本。
 */
async function generateSummary(conversation: ConversationEntry[]): Promise<string> {
  const log = getLogger();
  const config = getConfig();

  if (conversation.length === 0) {
    return 'Empty session.';
  }

  // 截取对话内容（避免过长）。
  const maxChars = 8000;
  let conversationText = '';
  for (const entry of conversation) {
    const line = `[${entry.role}]: ${entry.content}\n\n`;
    if (conversationText.length + line.length > maxChars) {
      conversationText += '... (conversation truncated)\n';
      break;
    }
    conversationText += line;
  }

  // 确定认证方式和 API 地址。
  const baseUrl = config.anthropic.baseUrl || 'https://api.anthropic.com';
  const headers: Record<string, string> = {
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
  };

  if (config.anthropic.authToken) {
    headers['Authorization'] = `Bearer ${config.anthropic.authToken}`;
  }
  if (config.anthropic.apiKey) {
    headers['x-api-key'] = config.anthropic.apiKey;
  }

  const body = {
    model: config.session.summaryModel,
    max_tokens: 512,
    messages: [
      {
        role: 'user',
        content: `Please summarize the following conversation between a user and an AI assistant in 2-3 concise sentences. Focus on the key topics discussed, decisions made, and any important outcomes. Write the summary in the same language the user used.\n\n${conversationText}`,
      },
    ],
  };

  log.debug({ model: config.session.summaryModel, conversationLength: conversation.length }, 'Generating session summary');

  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Summary API call failed (${response.status}): ${errorText}`);
  }

  const data = (await response.json()) as {
    content?: Array<{ type: string; text?: string }>;
  };

  const summaryText = data.content?.find((b) => b.type === 'text')?.text;
  if (!summaryText) {
    throw new Error('Summary API returned no text content');
  }

  return summaryText;
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
