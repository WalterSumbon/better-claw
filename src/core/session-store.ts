import { join } from 'path';
import { getUserDir } from '../user/store.js';
import { readJsonFile, writeJsonFile } from '../utils/file.js';

/** 持久化的 session 数据。 */
interface SessionData {
  /** Agent SDK session ID，用于 resume 对话。 */
  sessionId: string;
  /** 最后更新时间（ISO 8601）。 */
  updatedAt: string;
}

/**
 * 获取用户 session.json 文件路径。
 *
 * @param userId - 用户 ID。
 * @returns 文件路径。
 */
function sessionPath(userId: string): string {
  return join(getUserDir(userId), 'session.json');
}

/**
 * 读取用户的持久化 session。
 *
 * @param userId - 用户 ID。
 * @returns session 数据，不存在时返回 null。
 */
export function readSession(userId: string): SessionData | null {
  return readJsonFile<SessionData>(sessionPath(userId));
}

/**
 * 持久化用户的 session ID。
 *
 * @param userId - 用户 ID。
 * @param sessionId - Agent SDK session ID。
 */
export function writeSession(userId: string, sessionId: string): void {
  const data: SessionData = {
    sessionId,
    updatedAt: new Date().toISOString(),
  };
  writeJsonFile(sessionPath(userId), data);
}
