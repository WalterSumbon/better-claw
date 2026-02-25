import { generateUserToken, generateId } from '../utils/token.js';
import { readProfile, writeProfile, readAllProfiles } from './store.js';
import type { UserProfile, PlatformType } from './types.js';

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
