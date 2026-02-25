import { join } from 'path';
import { readdirSync, existsSync, unlinkSync } from 'fs';
import { getUserDir } from '../user/store.js';
import { readJsonFile, writeJsonFile, ensureDir } from '../utils/file.js';
import type { CoreMemory, ExtendedMemoryEntry } from './types.js';

/**
 * 获取用户核心记忆文件路径。
 *
 * @param userId - 用户 ID。
 * @returns 文件路径。
 */
function coreMemoryPath(userId: string): string {
  return join(getUserDir(userId), 'memory', 'core.json');
}

/**
 * 获取用户扩展记忆目录路径。
 *
 * @param userId - 用户 ID。
 * @returns 目录路径。
 */
function extendedMemoryDir(userId: string): string {
  return join(getUserDir(userId), 'memory', 'extended');
}

/**
 * 获取扩展记忆条目文件路径。
 *
 * @param userId - 用户 ID。
 * @param key - 条目 key。
 * @returns 文件路径。
 */
function extendedEntryPath(userId: string, key: string): string {
  // 对 key 做安全处理，防止路径穿越。
  const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(extendedMemoryDir(userId), `${safeKey}.json`);
}

// --- 核心记忆操作 ---

/**
 * 读取用户核心记忆。
 *
 * @param userId - 用户 ID。
 * @returns 核心记忆对象。
 */
export function readCoreMemory(userId: string): CoreMemory {
  const data = readJsonFile<CoreMemory>(coreMemoryPath(userId));
  return data ?? { preferences: {}, identity: {} };
}

/**
 * 写入用户核心记忆。
 *
 * @param userId - 用户 ID。
 * @param memory - 核心记忆对象。
 */
export function writeCoreMemory(userId: string, memory: CoreMemory): void {
  writeJsonFile(coreMemoryPath(userId), memory);
}

/**
 * 更新核心记忆的指定键值。
 *
 * @param userId - 用户 ID。
 * @param key - 顶层键（如 "preferences"、"identity"）。
 * @param field - 字段名。
 * @param value - 字段值。
 */
export function updateCoreMemory(
  userId: string,
  key: string,
  field: string,
  value: string,
): void {
  const memory = readCoreMemory(userId);
  if (typeof memory[key] !== 'object' || memory[key] === null) {
    (memory as Record<string, unknown>)[key] = {};
  }
  (memory[key] as Record<string, string>)[field] = value;
  writeCoreMemory(userId, memory);
}

// --- 扩展记忆操作 ---

/**
 * 列出用户所有扩展记忆的 key。
 *
 * @param userId - 用户 ID。
 * @returns key 数组。
 */
export function listExtendedMemoryKeys(userId: string): string[] {
  const dir = extendedMemoryDir(userId);
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace('.json', ''));
}

/**
 * 读取指定扩展记忆条目。
 *
 * @param userId - 用户 ID。
 * @param key - 条目 key。
 * @returns 记忆条目，不存在时返回 null。
 */
export function readExtendedMemory(
  userId: string,
  key: string,
): ExtendedMemoryEntry | null {
  return readJsonFile<ExtendedMemoryEntry>(extendedEntryPath(userId, key));
}

/**
 * 写入扩展记忆条目。已存在则更新。
 *
 * @param userId - 用户 ID。
 * @param key - 条目 key。
 * @param content - 记忆内容。
 */
export function writeExtendedMemory(
  userId: string,
  key: string,
  content: string,
): void {
  const dir = extendedMemoryDir(userId);
  ensureDir(dir);

  const existing = readExtendedMemory(userId, key);
  const now = new Date().toISOString();
  const entry: ExtendedMemoryEntry = {
    key,
    content,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  writeJsonFile(extendedEntryPath(userId, key), entry);
}

/**
 * 删除扩展记忆条目。
 *
 * @param userId - 用户 ID。
 * @param key - 条目 key。
 * @returns 是否删除成功。
 */
export function deleteExtendedMemory(userId: string, key: string): boolean {
  const path = extendedEntryPath(userId, key);
  if (!existsSync(path)) {
    return false;
  }
  unlinkSync(path);
  return true;
}
