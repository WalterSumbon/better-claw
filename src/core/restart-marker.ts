import { join } from 'path';
import { existsSync, unlinkSync } from 'fs';
import { getUserDir, listUserIds } from '../user/store.js';
import { readJsonFile, writeJsonFile } from '../utils/file.js';

/** 重启标记文件内容。 */
export interface RestartMarker {
  /** 触发重启的时间（ISO 8601）。 */
  timestamp: string;
  /** 触发来源："mcp_tool" 表示 agent 调用 restart 工具，"command" 表示用户 /restart 命令。 */
  source: 'mcp_tool' | 'command';
}

/** 重启标记文件名。 */
const MARKER_FILENAME = 'restart-pending.json';

/**
 * 获取用户的重启标记文件路径。
 *
 * @param userId - 用户 ID。
 * @returns 文件路径。
 */
function markerPath(userId: string): string {
  return join(getUserDir(userId), MARKER_FILENAME);
}

/**
 * 写入重启标记。
 *
 * @param userId - 用户 ID。
 * @param source - 触发来源。
 */
export function writeRestartMarker(userId: string, source: RestartMarker['source']): void {
  const marker: RestartMarker = {
    timestamp: new Date().toISOString(),
    source,
  };
  writeJsonFile(markerPath(userId), marker);
}

/**
 * 读取重启标记。
 *
 * @param userId - 用户 ID。
 * @returns 标记内容，不存在时返回 null。
 */
export function readRestartMarker(userId: string): RestartMarker | null {
  return readJsonFile<RestartMarker>(markerPath(userId));
}

/**
 * 删除重启标记。
 *
 * @param userId - 用户 ID。
 */
export function deleteRestartMarker(userId: string): void {
  const path = markerPath(userId);
  if (existsSync(path)) {
    unlinkSync(path);
  }
}

/**
 * 扫描所有用户，返回有重启标记的 userId 列表。
 *
 * @returns 包含 { userId, marker } 的数组。
 */
export function findPendingRestarts(): Array<{ userId: string; marker: RestartMarker }> {
  const results: Array<{ userId: string; marker: RestartMarker }> = [];
  for (const userId of listUserIds()) {
    const marker = readRestartMarker(userId);
    if (marker) {
      results.push({ userId, marker });
    }
  }
  return results;
}
