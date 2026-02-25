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
  type SessionMetadata,
  type ConversationEntry,
} from './session-store.js';

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

  // 清除活跃会话并创建新的。
  clearActiveSession(userId);
  const newSession = createActiveSession(userId);

  log.info(
    { userId, newLocalId: newSession.localId },
    'New session created',
  );

  return newSession;
}

// ─── 会话生命周期 ────────────────────────────────────────────────────

/**
 * 确保用户有一个活跃会话。如果需要轮转则先轮转。
 *
 * @param userId - 用户 ID。
 * @returns 活跃会话元数据和可选的轮转原因。
 */
export async function ensureActiveSession(
  userId: string,
): Promise<{ session: SessionMetadata; rotated: boolean; reason?: RotationReason }> {
  // 检查是否需要轮转。
  const rotationReason = checkRotationNeeded(userId);

  if (rotationReason) {
    const session = await rotateSession(userId, rotationReason);
    return { session, rotated: true, reason: rotationReason };
  }

  // 读取或创建活跃会话。
  let session = readActiveSession(userId);
  if (!session) {
    session = createActiveSession(userId);
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
): void {
  const now = new Date().toISOString();

  // 追加对话记录到本次查询所属的会话。
  const entries: ConversationEntry[] = [
    {
      timestamp: now,
      role: 'user',
      content: userMessage,
    },
    {
      timestamp: now,
      role: 'assistant',
      content: assistantResponse,
      metadata: {
        costUsd: resultMeta.costUsd,
        turns: resultMeta.turns,
        durationMs: resultMeta.durationMs,
      },
    },
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
  const archived = listArchivedSessions(userId);
  const current = readActiveSession(userId);

  if (archived.length === 0 && !current) {
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
  }

  // 最近的归档会话（最多显示 5 个）。
  if (archived.length > 0) {
    lines.push(`### Previous Sessions (${archived.length} total)`);
    const recentSessions = archived.slice(0, 5);
    for (const s of recentSessions) {
      const timeRange = `${formatTime(s.createdAt)} → ${formatTime(s.endedAt!)}`;
      lines.push(`- **${s.localId}** (${timeRange}, ${s.messageCount} msgs)`);
      if (s.summary) {
        lines.push(`  Summary: ${s.summary}`);
      }
      lines.push(`  Conversation: ${conversationPath(userId, s.localId)}`);
    }
    if (archived.length > 5) {
      lines.push(`- ... and ${archived.length - 5} older sessions`);
    }
  }

  return lines.join('\n');
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
