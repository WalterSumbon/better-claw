import { join } from 'path';
import { readdirSync, existsSync } from 'fs';
import { getUserDir } from '../user/store.js';
import { readJsonFile, writeJsonFile, ensureDir } from '../utils/file.js';
import { generateId } from '../utils/token.js';

// ─── 类型定义 ────────────────────────────────────────────────────────

/** 会话元数据。 */
export interface SessionMetadata {
  /** 本地会话 ID（如 ses_abc123）。 */
  localId: string;
  /** Claude SDK session ID（用于 resume）。 */
  sdkSessionId: string | null;
  /** 创建时间（ISO 8601）。 */
  createdAt: string;
  /** 最后活跃时间（ISO 8601）。 */
  updatedAt: string;
  /** 结束时间（仅归档会话，ISO 8601）。 */
  endedAt?: string;
  /** 用户消息数量。 */
  messageCount: number;
  /** Agent 累计对话轮次。 */
  totalTurns: number;
  /** 累计花费（美元）。 */
  totalCostUsd: number;
  /** 当前 context token 数（最近一次 query 的 input_tokens，反映 context 大小）。 */
  contextTokens: number;
  /** 模型的最大 context window 大小（从 SDK modelUsage 自动获取）。 */
  contextWindowTokens: number;
  /** 会话摘要（轮转时生成）。 */
  summary?: string;
}

/** 对话内容块（assistant 消息的完整交互记录）。 */
export interface ConversationBlock {
  /** 块类型。 */
  type: 'thinking' | 'text' | 'tool_use' | 'tool_result';
  /** 文本内容（thinking / text / tool_result 类型）。 */
  text?: string;
  /** 工具名称（tool_use 类型）。 */
  toolName?: string;
  /** 工具调用 ID（tool_use / tool_result 类型）。 */
  toolId?: string;
  /** 工具输入参数（tool_use 类型）。 */
  input?: unknown;
}

/** 对话记录条目。 */
export interface ConversationEntry {
  /** 时间戳（ISO 8601）。 */
  timestamp: string;
  /** 角色。 */
  role: 'user' | 'assistant';
  /** 消息内容（精简文本）。 */
  content: string;
  /** 完整交互块序列（按时序：thinking → text → tool_use → tool_result → ...）。仅 assistant 消息。 */
  blocks?: ConversationBlock[];
  /** 附加元数据（仅 assistant 消息）。 */
  metadata?: {
    costUsd?: number;
    turns?: number;
    durationMs?: number;
  };
}

/** 旧版 session.json 格式（兼容迁移用）。 */
interface LegacySessionData {
  sessionId: string;
  updatedAt: string;
}

// ─── 路径工具 ────────────────────────────────────────────────────────

/** 获取用户 session.json 路径（活跃会话指针）。 */
function activeSessionPath(userId: string): string {
  return join(getUserDir(userId), 'session.json');
}

/** 获取用户 sessions 目录路径。 */
export function sessionsDir(userId: string): string {
  return join(getUserDir(userId), 'sessions');
}

/** 获取指定会话的目录路径。 */
function sessionDirPath(userId: string, localId: string): string {
  return join(sessionsDir(userId), localId);
}

/** 获取指定会话的对话记录文件路径。 */
export function conversationPath(userId: string, localId: string): string {
  return join(sessionDirPath(userId, localId), 'conversation.json');
}

/** 获取指定会话的元数据文件路径。 */
function metadataFilePath(userId: string, localId: string): string {
  return join(sessionDirPath(userId, localId), 'metadata.json');
}

// ─── 活跃会话操作 ────────────────────────────────────────────────────

/**
 * 读取用户的活跃会话元数据。
 * 自动处理旧版格式迁移。
 *
 * @param userId - 用户 ID。
 * @returns 活跃会话元数据，不存在时返回 null。
 */
export function readActiveSession(userId: string): SessionMetadata | null {
  const filePath = activeSessionPath(userId);
  const raw = readJsonFile<Record<string, unknown>>(filePath);
  if (!raw) return null;

  // 检测旧版格式并迁移。
  if ('sessionId' in raw && !('localId' in raw)) {
    const legacy = raw as unknown as LegacySessionData;
    const migrated = migrateFromLegacy(legacy);
    // 确保会话目录和对话文件存在。
    ensureDir(sessionDirPath(userId, migrated.localId));
    writeJsonFile(conversationPath(userId, migrated.localId), []);
    writeJsonFile(filePath, migrated);
    return migrated;
  }

  return raw as unknown as SessionMetadata;
}

/**
 * 写入活跃会话元数据。
 *
 * @param userId - 用户 ID。
 * @param metadata - 会话元数据。
 */
export function writeActiveSession(userId: string, metadata: SessionMetadata): void {
  writeJsonFile(activeSessionPath(userId), metadata);
}

/**
 * 清除活跃会话（轮转后调用）。
 *
 * @param userId - 用户 ID。
 */
export function clearActiveSession(userId: string): void {
  const filePath = activeSessionPath(userId);
  if (existsSync(filePath)) {
    writeJsonFile(filePath, null);
  }
}

/**
 * 创建新的活跃会话。
 *
 * @param userId - 用户 ID。
 * @returns 新会话的元数据。
 */
export function createActiveSession(userId: string): SessionMetadata {
  const localId = `ses_${generateId()}`;
  const now = new Date().toISOString();

  const metadata: SessionMetadata = {
    localId,
    sdkSessionId: null,
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
    totalTurns: 0,
    totalCostUsd: 0,
    contextTokens: 0,
    contextWindowTokens: 0,
  };

  // 确保会话目录存在。
  ensureDir(sessionDirPath(userId, localId));

  // 初始化空的对话记录文件。
  writeJsonFile(conversationPath(userId, localId), []);

  // 写入活跃会话指针。
  writeActiveSession(userId, metadata);

  return metadata;
}

// ─── 对话记录操作 ────────────────────────────────────────────────────

/**
 * 读取指定会话的完整对话记录。
 *
 * @param userId - 用户 ID。
 * @param localId - 本地会话 ID。
 * @returns 对话记录数组。
 */
export function readConversation(userId: string, localId: string): ConversationEntry[] {
  return readJsonFile<ConversationEntry[]>(conversationPath(userId, localId)) ?? [];
}

/**
 * 追加对话记录到指定会话。
 *
 * @param userId - 用户 ID。
 * @param localId - 本地会话 ID。
 * @param entries - 要追加的记录条目。
 */
export function appendConversation(userId: string, localId: string, entries: ConversationEntry[]): void {
  const existing = readConversation(userId, localId);
  existing.push(...entries);
  writeJsonFile(conversationPath(userId, localId), existing);
}

// ─── 归档操作 ────────────────────────────────────────────────────────

/**
 * 归档会话（写入 metadata.json 到 sessions/{localId}/）。
 *
 * @param userId - 用户 ID。
 * @param metadata - 包含 endedAt 和可选 summary 的完整元数据。
 */
export function archiveSession(userId: string, metadata: SessionMetadata): void {
  ensureDir(sessionDirPath(userId, metadata.localId));
  writeJsonFile(metadataFilePath(userId, metadata.localId), metadata);
}

/**
 * 列出用户的所有已归档会话（按创建时间倒序）。
 *
 * @param userId - 用户 ID。
 * @returns 已归档会话元数据数组。
 */
export function listArchivedSessions(userId: string): SessionMetadata[] {
  const dir = sessionsDir(userId);
  if (!existsSync(dir)) return [];

  const entries = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory());

  const sessions: SessionMetadata[] = [];

  for (const entry of entries) {
    const mdPath = metadataFilePath(userId, entry.name);
    const md = readJsonFile<SessionMetadata>(mdPath);
    if (md && md.endedAt) {
      sessions.push(md);
    }
  }

  // 按创建时间倒序。
  sessions.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  return sessions;
}

// ─── 累积摘要（长期记忆）────────────────────────────────────────────

/** 获取用户累积摘要文件路径。 */
function cumulativeSummaryPath(userId: string): string {
  return join(getUserDir(userId), 'cumulative-summary.json');
}

/** 累积摘要数据结构。 */
export interface CumulativeSummary {
  /** 摘要文本。 */
  text: string;
  /** 已被浓缩的 session 数量。 */
  sessionCount: number;
  /** 最后更新时间（ISO 8601）。 */
  updatedAt: string;
}

/**
 * 读取用户的累积摘要。
 *
 * @param userId - 用户 ID。
 * @returns 累积摘要数据，不存在时返回 null。
 */
export function readCumulativeSummary(userId: string): CumulativeSummary | null {
  return readJsonFile<CumulativeSummary>(cumulativeSummaryPath(userId));
}

/**
 * 写入用户的累积摘要。
 *
 * @param userId - 用户 ID。
 * @param summary - 累积摘要数据。
 */
export function writeCumulativeSummary(userId: string, summary: CumulativeSummary): void {
  writeJsonFile(cumulativeSummaryPath(userId), summary);
}

// ─── 迁移工具 ────────────────────────────────────────────────────────

/**
 * 将旧版 session 数据迁移到新格式。
 *
 * @param legacy - 旧版数据。
 * @returns 新格式的会话元数据。
 */
function migrateFromLegacy(legacy: LegacySessionData): SessionMetadata {
  return {
    localId: `ses_${generateId()}`,
    sdkSessionId: legacy.sessionId,
    createdAt: legacy.updatedAt, // 旧格式没有 createdAt，用 updatedAt 近似。
    updatedAt: legacy.updatedAt,
    messageCount: 0,
    totalTurns: 0,
    totalCostUsd: 0,
    contextTokens: 0,
    contextWindowTokens: 0,
  };
}

// ─── 向后兼容接口 ────────────────────────────────────────────────────

/**
 * 向后兼容：读取 session。
 *
 * @param userId - 用户 ID。
 * @returns 简单的 session 数据，不存在时返回 null。
 * @deprecated 使用 readActiveSession 代替。
 */
export function readSession(userId: string): { sessionId: string; updatedAt: string } | null {
  const active = readActiveSession(userId);
  if (!active?.sdkSessionId) return null;
  return { sessionId: active.sdkSessionId, updatedAt: active.updatedAt };
}

/**
 * 向后兼容：写入 session。
 *
 * @param userId - 用户 ID。
 * @param sessionId - SDK session ID。
 * @deprecated 使用 writeActiveSession 代替。
 */
export function writeSession(userId: string, sessionId: string): void {
  const active = readActiveSession(userId);
  if (active) {
    active.sdkSessionId = sessionId;
    active.updatedAt = new Date().toISOString();
    writeActiveSession(userId, active);
  }
}
