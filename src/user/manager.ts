import { generateUserToken, generateId } from '../utils/token.js';
import { readProfile, writeProfile, readAllProfiles, deleteUserDir } from './store.js';
import { getWorkGroups, updateWorkGroups, getConfig } from '../config/index.js';
import type { UserProfile, PlatformType } from './types.js';

/**
 * 检查用户是否匹配白名单中的任意条目。
 * 支持两种格式：
 * - userId 直接匹配
 * - @groupName 匹配用户所属权限组
 *
 * @param userId - 系统用户 ID。
 * @param whitelist - 白名单条目数组。
 * @returns 用户匹配任意条目时返回 true。
 */
export function matchesWhitelist(userId: string, whitelist: string[]): boolean {
  for (const entry of whitelist) {
    if (entry.startsWith('@')) {
      const groupName = entry.slice(1);
      const profile = readProfile(userId);
      const userGroup = profile?.permissionGroup ?? getConfig().permissions.defaultGroup;
      if (userGroup === groupName) {
        return true;
      }
    } else {
      if (entry === userId) {
        return true;
      }
    }
  }
  return false;
}

/** 平台用户 → 系统用户 ID 的内存缓存。 */
const bindingCache = new Map<string, string>();

/**
 * 构造绑定缓存的 key。
 *
 * @param platform - 平台名称。
 * @param platformUserId - 平台用户 ID。
 * @returns 缓存 key。
 */
function bindingKey(platform: string, platformUserId: string): string {
  return `${platform}:${platformUserId}`;
}

/**
 * 从磁盘加载所有绑定关系到内存缓存。应在启动时调用一次。
 */
export function loadBindingCache(): void {
  bindingCache.clear();
  const profiles = readAllProfiles();
  for (const profile of profiles) {
    for (const binding of profile.bindings) {
      bindingCache.set(
        bindingKey(binding.platform, binding.platformUserId),
        profile.userId,
      );
    }
  }
}

/**
 * 创建新用户。
 *
 * @param name - 用户显示名称。
 * @returns 新创建的用户档案。
 */
export function createUser(name: string): UserProfile {
  const profile: UserProfile = {
    userId: `user_${generateId()}`,
    token: generateUserToken(),
    name,
    bindings: [],
    createdAt: new Date().toISOString(),
  };
  writeProfile(profile);
  return profile;
}

/**
 * 通过 secret token 绑定平台账号。
 *
 * @param token - 用户的 secret token。
 * @param platform - 平台名称。
 * @param platformUserId - 平台用户 ID。
 * @returns 绑定成功返回用户档案，token 无效返回 null。
 */
export function bindPlatform(
  token: string,
  platform: PlatformType,
  platformUserId: string,
): UserProfile | null {
  const profiles = readAllProfiles();
  const profile = profiles.find((p) => p.token === token);
  if (!profile) {
    return null;
  }

  // 检查是否已绑定。
  const existing = profile.bindings.find(
    (b) => b.platform === platform && b.platformUserId === platformUserId,
  );
  if (existing) {
    return profile;
  }

  profile.bindings.push({
    platform,
    platformUserId,
    boundAt: new Date().toISOString(),
  });
  writeProfile(profile);
  bindingCache.set(bindingKey(platform, platformUserId), profile.userId);
  return profile;
}

/**
 * 通过平台信息查找对应的系统用户 ID。
 *
 * @param platform - 平台名称。
 * @param platformUserId - 平台用户 ID。
 * @returns 用户 ID，未绑定时返回 null。
 */
export function resolveUser(
  platform: string,
  platformUserId: string,
): string | null {
  return bindingCache.get(bindingKey(platform, platformUserId)) ?? null;
}

/**
 * 通过用户 ID 获取用户档案。
 *
 * @param userId - 用户 ID。
 * @returns 用户档案，不存在时返回 null。
 */
export function getUser(userId: string): UserProfile | null {
  return readProfile(userId);
}

/**
 * 列出所有用户档案。
 *
 * @returns 所有用户档案数组。
 */
export function listUsers(): UserProfile[] {
  return readAllProfiles();
}

/**
 * 删除用户及其所有数据。
 * 包括：profile、数据目录、绑定缓存、所有工作组中的成员记录。
 *
 * @param userId - 用户 ID。
 * @returns 被删除的用户档案，用户不存在时返回 null。
 */
export function deleteUser(userId: string): UserProfile | null {
  const profile = readProfile(userId);
  if (!profile) {
    return null;
  }

  // 从绑定缓存中移除所有绑定。
  for (const binding of profile.bindings) {
    bindingCache.delete(bindingKey(binding.platform, binding.platformUserId));
  }

  // 从所有工作组中移除该用户。
  const workGroups = getWorkGroups();
  let workGroupsChanged = false;
  for (const group of Object.values(workGroups)) {
    if (userId in group.members) {
      delete group.members[userId];
      workGroupsChanged = true;
    }
  }
  if (workGroupsChanged) {
    updateWorkGroups(workGroups);
  }

  // 递归删除用户数据目录。
  deleteUserDir(userId);

  return profile;
}

/**
 * 重命名用户（修改显示名称）。
 *
 * @param userId - 用户 ID。
 * @param newName - 新的显示名称。
 * @returns 更新后的用户档案，用户不存在时返回 null。
 */
export function renameUser(userId: string, newName: string): UserProfile | null {
  const profile = readProfile(userId);
  if (!profile) {
    return null;
  }
  profile.name = newName;
  writeProfile(profile);
  return profile;
}

/**
 * 设置用户的权限组。
 *
 * @param userId - 用户 ID。
 * @param group - 权限组名称。
 * @returns 更新后的用户档案，用户不存在时返回 null。
 */
export function setPermissionGroup(userId: string, group: string): UserProfile | null {
  const profile = readProfile(userId);
  if (!profile) {
    return null;
  }
  profile.permissionGroup = group;
  writeProfile(profile);
  return profile;
}
