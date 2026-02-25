import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  loadBindingCache,
  createUser,
  listUsers,
  getUser,
  bindPlatform,
  resolveUser,
} from '../../src/user/manager.js';
import { createTestEnv } from '../helpers/setup.js';

/**
 * 用户管理器单元测试。
 *
 * 测试用户创建、绑定、查找等核心功能。
 * 使用临时目录隔离测试数据，不污染 data/users/。
 */
describe('User Manager', () => {
  let cleanup: () => void;

  beforeEach(() => {
    const env = createTestEnv();
    cleanup = env.cleanup;
  });

  afterEach(() => {
    cleanup();
  });

  it('should create a user with unique ID and token', () => {
    const user = createUser('test-user');
    expect(user.userId).toMatch(/^user_/);
    expect(user.token).toBeTruthy();
    expect(user.name).toBe('test-user');
    expect(user.bindings).toEqual([]);
  });

  it('should retrieve a created user by ID', () => {
    const created = createUser('get-test');
    const retrieved = getUser(created.userId);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.userId).toBe(created.userId);
    expect(retrieved!.name).toBe('get-test');
  });

  it('should list all users including newly created ones', () => {
    const before = listUsers().length;
    createUser('list-test-1');
    createUser('list-test-2');
    const after = listUsers().length;
    expect(after).toBe(before + 2);
  });

  it('should bind platform and resolve user', () => {
    const user = createUser('bind-test');
    const result = bindPlatform(user.token, 'telegram', 'tg_12345');
    expect(result).not.toBeNull();
    expect(result!.userId).toBe(user.userId);

    // 绑定后应能解析。
    const resolved = resolveUser('telegram', 'tg_12345');
    expect(resolved).toBe(user.userId);
  });

  it('should return null for invalid token binding', () => {
    const result = bindPlatform('invalid_token_xyz', 'cli', 'some_user');
    expect(result).toBeNull();
  });

  it('should return null for unbound platform user', () => {
    const resolved = resolveUser('telegram', 'unknown_user_999');
    expect(resolved).toBeNull();
  });

  it('should handle duplicate binding gracefully', () => {
    const user = createUser('dup-bind-test');
    bindPlatform(user.token, 'cli', 'dup_cli_user');
    const secondBind = bindPlatform(user.token, 'cli', 'dup_cli_user');

    // 重复绑定应返回同一用户，不报错。
    expect(secondBind).not.toBeNull();
    expect(secondBind!.userId).toBe(user.userId);

    // 绑定列表中不应有重复条目。
    const profile = getUser(user.userId);
    const cliBindings = profile!.bindings.filter(
      (b) => b.platform === 'cli' && b.platformUserId === 'dup_cli_user',
    );
    expect(cliBindings.length).toBe(1);
  });

  it('should support multiple platforms for the same user', () => {
    const user = createUser('multi-platform-test');
    bindPlatform(user.token, 'cli', 'mp_cli');
    bindPlatform(user.token, 'telegram', 'mp_tg');

    expect(resolveUser('cli', 'mp_cli')).toBe(user.userId);
    expect(resolveUser('telegram', 'mp_tg')).toBe(user.userId);

    const profile = getUser(user.userId);
    expect(profile!.bindings.length).toBe(2);
  });
});
