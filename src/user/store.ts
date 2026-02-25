import { join } from 'path';
import { readdirSync, existsSync } from 'fs';
import { getConfig } from '../config/index.js';
import { readJsonFile, writeJsonFile, ensureDir } from '../utils/file.js';
import type { UserProfile } from './types.js';

/**
 * 获取用户数据根目录。
 *
 * @returns 用户数据目录路径。
 */
function getUsersDir(): string {
  return join(getConfig().dataDir, 'users');
}

/**
 * 获取指定用户的数据目录。
 *
 * @param userId - 用户 ID。
 * @returns 用户数据目录路径。
 */
export function getUserDir(userId: string): string {
  return join(getUsersDir(), userId);
}

/**
 * 读取用户 profile。
 *
 * @param userId - 用户 ID。
 * @returns 用户档案，不存在时返回 null。
 */
export function readProfile(userId: string): UserProfile | null {
  return readJsonFile<UserProfile>(join(getUserDir(userId), 'profile.json'));
}

/**
 * 写入用户 profile。
 *
 * @param profile - 用户档案对象。
 */
export function writeProfile(profile: UserProfile): void {
  const dir = getUserDir(profile.userId);
  ensureDir(dir);
  ensureDir(join(dir, 'memory', 'extended'));
  writeJsonFile(join(dir, 'profile.json'), profile);
}

/**
 * 列出所有用户 ID。
 *
 * @returns 用户 ID 数组。
 */
export function listUserIds(): string[] {
  const usersDir = getUsersDir();
  if (!existsSync(usersDir)) {
    return [];
  }
  return readdirSync(usersDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

/**
 * 读取所有用户 profile。
 *
 * @returns 所有用户档案数组。
 */
export function readAllProfiles(): UserProfile[] {
  const ids = listUserIds();
  const profiles: UserProfile[] = [];
  for (const id of ids) {
    const profile = readProfile(id);
    if (profile) {
      profiles.push(profile);
    }
  }
  return profiles;
}
