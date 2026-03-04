import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join, resolve } from 'path';
import { createTestEnv } from '../helpers/setup.js';
import { createUser } from '../../src/user/manager.js';
import { readProfile, writeProfile } from '../../src/user/store.js';
import { setConfig, resetConfig } from '../../src/config/index.js';
import { AppConfigSchema } from '../../src/config/schema.js';
import { createLogger } from '../../src/logger/index.js';
import { loadBindingCache } from '../../src/user/manager.js';
import {
  resolvePathVariable,
  resolveUserPermissions,
  isPathAllowed,
  buildCanUseTool,
  buildSandboxSettings,
} from '../../src/core/permissions.js';

/**
 * 权限系统单元测试。
 *
 * 测试新的 filesystem 模型（allowWrite / denyWrite / denyRead），
 * 继承机制、变量替换（含 ${otherUserDir}）、工作组合并、
 * canUseTool 回调和 sandbox 配置生成。
 */
describe('Permissions', () => {
  let dataDir: string;
  let cleanup: () => Promise<void>;

  beforeEach(() => {
    const env = createTestEnv();
    dataDir = env.dataDir;
    cleanup = env.cleanup;
  });

  afterEach(async () => {
    await cleanup();
  });

  /**
   * 使用自定义权限配置重新设置测试环境。
   */
  function reconfigurePermissions(permissionsOverride: Record<string, unknown>): void {
    resetConfig();
    const config = AppConfigSchema.parse({
      dataDir,
      logging: { directory: join(dataDir, 'logs') },
      permissions: permissionsOverride,
    });
    setConfig(config);
    createLogger(config.logging);
    loadBindingCache();
  }

  // ── resolvePathVariable ──

  describe('resolvePathVariable', () => {
    it('should replace ${userWorkspace} with actual workspace path', () => {
      const user = createUser('var-test');
      const result = resolvePathVariable('${userWorkspace}', user.userId);
      expect(result).toBe(resolve(dataDir, 'users', user.userId, 'workspace'));
    });

    it('should replace ${userDir} with actual user directory', () => {
      const user = createUser('var-test-2');
      const result = resolvePathVariable('${userDir}', user.userId);
      expect(result).toBe(join(dataDir, 'users', user.userId));
    });

    it('should replace ${dataDir} with actual data directory', () => {
      const user = createUser('var-test-3');
      const result = resolvePathVariable('${dataDir}/something', user.userId);
      const expected = resolve(process.cwd(), dataDir) + '/something';
      expect(result).toBe(expected);
    });

    it('should handle multiple variables in one path', () => {
      const user = createUser('var-test-4');
      const result = resolvePathVariable('${dataDir}/extra', user.userId);
      expect(result).toContain(dataDir);
      expect(result).toContain('/extra');
    });
  });

  // ── resolveUserPermissions ──

  describe('resolveUserPermissions', () => {
    it('should return isAdmin=true for admin group users', () => {
      const user = createUser('admin-user');
      const profile = readProfile(user.userId)!;
      profile.permissionGroup = 'admin';
      writeProfile(profile);

      const perms = resolveUserPermissions(user.userId);
      expect(perms.isAdmin).toBe(true);
      expect(perms.filesystem.allowWrite).toEqual([]);
      expect(perms.filesystem.denyWrite).toEqual([]);
      expect(perms.filesystem.denyRead).toEqual([]);
    });

    it('should return default user group filesystem when no permissionGroup set', () => {
      const user = createUser('default-user');
      const perms = resolveUserPermissions(user.userId);

      expect(perms.isAdmin).toBe(false);
      // 默认 user 组应有 allowWrite 条目（memory + workspace）。
      expect(perms.filesystem.allowWrite.length).toBeGreaterThanOrEqual(2);
    });

    it('should flatten inherited filesystem (parent first, child appended)', () => {
      reconfigurePermissions({
        groups: {
          admin: {},
          base: {
            filesystem: {
              allowWrite: ['/base/path'],
            },
          },
          child: {
            inherits: 'base',
            filesystem: {
              allowWrite: ['/child/path'],
            },
          },
        },
        defaultGroup: 'child',
      });

      const user = createUser('inherit-test');
      const perms = resolveUserPermissions(user.userId);

      // 父组在前，子组在后。
      expect(perms.filesystem.allowWrite).toContain('/base/path');
      expect(perms.filesystem.allowWrite).toContain('/child/path');
      const baseIdx = perms.filesystem.allowWrite.indexOf('/base/path');
      const childIdx = perms.filesystem.allowWrite.indexOf('/child/path');
      expect(baseIdx).toBeLessThan(childIdx);
    });

    it('should detect circular inheritance and not loop', () => {
      reconfigurePermissions({
        groups: {
          admin: {},
          groupA: {
            inherits: 'groupB',
            filesystem: { denyRead: ['/a'] },
          },
          groupB: {
            inherits: 'groupA',
            filesystem: { denyRead: ['/b'] },
          },
        },
        defaultGroup: 'groupA',
      });

      const user = createUser('circular-test');
      // 不应死循环，应正常返回。
      const perms = resolveUserPermissions(user.userId);
      expect(perms.isAdmin).toBe(false);
    });

    it('should fall back to empty filesystem for unknown group', () => {
      const user = createUser('unknown-group');
      const profile = readProfile(user.userId)!;
      profile.permissionGroup = 'nonexistent';
      writeProfile(profile);

      const perms = resolveUserPermissions(user.userId);
      expect(perms.isAdmin).toBe(false);
      expect(perms.filesystem.allowWrite).toEqual([]);
      expect(perms.filesystem.denyWrite).toEqual([]);
      expect(perms.filesystem.denyRead).toEqual([]);
    });

    it('should add work group rw workspace to allowWrite', () => {
      const user = createUser('wg-test');
      reconfigurePermissions({
        groups: {
          admin: {},
          user: {
            filesystem: {
              allowWrite: ['${userWorkspace}'],
            },
          },
        },
        workGroups: {
          'team-alpha': {
            members: { [user.userId]: 'rw' },
          },
        },
        defaultGroup: 'user',
      });

      const perms = resolveUserPermissions(user.userId);
      const wgWorkspace = resolve(dataDir, 'workgroups', 'team-alpha', 'workspace');
      expect(perms.filesystem.allowWrite).toContain(wgWorkspace);
    });

    it('should NOT add work group r workspace to allowWrite', () => {
      const user = createUser('wg-readonly');
      reconfigurePermissions({
        groups: {
          admin: {},
          user: {
            filesystem: {
              allowWrite: ['${userWorkspace}'],
            },
          },
        },
        workGroups: {
          'team-beta': {
            members: { [user.userId]: 'r' },
          },
        },
        defaultGroup: 'user',
      });

      const perms = resolveUserPermissions(user.userId);
      const wgWorkspace = resolve(dataDir, 'workgroups', 'team-beta', 'workspace');
      expect(perms.filesystem.allowWrite).not.toContain(wgWorkspace);
    });

    it('should expand ${otherUserDir} to other users directories', () => {
      // 创建多个用户。
      const userA = createUser('user-a');
      const userB = createUser('user-b');
      const userC = createUser('user-c');

      reconfigurePermissions({
        groups: {
          admin: {},
          user: {
            filesystem: {
              denyRead: ['${otherUserDir}'],
              denyWrite: ['${otherUserDir}'],
            },
          },
        },
        defaultGroup: 'user',
      });

      const permsA = resolveUserPermissions(userA.userId);
      const userBDir = resolve(dataDir, 'users', userB.userId);
      const userCDir = resolve(dataDir, 'users', userC.userId);
      const userADir = resolve(dataDir, 'users', userA.userId);

      // userA 的 denyRead 应包含 userB 和 userC 的目录，但不包含自己。
      expect(permsA.filesystem.denyRead).toContain(userBDir);
      expect(permsA.filesystem.denyRead).toContain(userCDir);
      expect(permsA.filesystem.denyRead).not.toContain(userADir);

      // denyWrite 同理。
      expect(permsA.filesystem.denyWrite).toContain(userBDir);
      expect(permsA.filesystem.denyWrite).toContain(userCDir);
      expect(permsA.filesystem.denyWrite).not.toContain(userADir);
    });

    it('should resolve protectedPaths', () => {
      reconfigurePermissions({
        groups: { admin: {}, user: {} },
        defaultGroup: 'user',
        protectedPaths: ['${dataDir}/secrets'],
      });

      const user = createUser('pp-test');
      const perms = resolveUserPermissions(user.userId);
      const secretsDir = resolve(process.cwd(), dataDir, 'secrets');
      expect(perms.protectedPaths).toContain(secretsDir);
    });
  });

  // ── isPathAllowed ──

  describe('isPathAllowed', () => {
    it('should always allow admin', () => {
      const perms = {
        isAdmin: true,
        filesystem: { allowWrite: [], denyWrite: [], denyRead: [] },
        protectedPaths: [],
      };
      expect(isPathAllowed('/etc/passwd', perms, 'read')).toBe(true);
      expect(isPathAllowed('/etc/passwd', perms, 'write')).toBe(true);
    });

    it('should allow all by default when no rules configured', () => {
      const perms = {
        isAdmin: false,
        filesystem: { allowWrite: [], denyWrite: [], denyRead: [] },
        protectedPaths: [],
      };
      expect(isPathAllowed('/any/path', perms, 'read')).toBe(true);
      expect(isPathAllowed('/any/path', perms, 'write')).toBe(true);
    });

    it('should deny write when path not in allowWrite (whitelist mode)', () => {
      const perms = {
        isAdmin: false,
        filesystem: {
          allowWrite: ['/home/user/workspace'],
          denyWrite: [],
          denyRead: [],
        },
        protectedPaths: [],
      };
      // 在白名单内 → 可写。
      expect(isPathAllowed('/home/user/workspace/file.js', perms, 'write')).toBe(true);
      // 不在白名单内 → 不可写。
      expect(isPathAllowed('/etc/hosts', perms, 'write')).toBe(false);
      // 读取不受 allowWrite 影响。
      expect(isPathAllowed('/etc/hosts', perms, 'read')).toBe(true);
    });

    it('should deny write when path in denyWrite (overrides allowWrite)', () => {
      const perms = {
        isAdmin: false,
        filesystem: {
          allowWrite: ['/home/user'],
          denyWrite: ['/home/user/secrets'],
          denyRead: [],
        },
        protectedPaths: [],
      };
      // /home/user 下可写。
      expect(isPathAllowed('/home/user/file.js', perms, 'write')).toBe(true);
      // /home/user/secrets 下不可写（denyWrite 优先级高）。
      expect(isPathAllowed('/home/user/secrets/key.pem', perms, 'write')).toBe(false);
    });

    it('should deny read when path in denyRead', () => {
      const perms = {
        isAdmin: false,
        filesystem: {
          allowWrite: [],
          denyWrite: [],
          denyRead: ['/data/other-user'],
        },
        protectedPaths: [],
      };
      expect(isPathAllowed('/data/other-user/file.txt', perms, 'read')).toBe(false);
      // 写入不受 denyRead 影响（除非有其他限制）。
      expect(isPathAllowed('/data/other-user/file.txt', perms, 'write')).toBe(true);
    });

    it('should deny both read and write for protectedPaths', () => {
      const perms = {
        isAdmin: false,
        filesystem: {
          allowWrite: ['/protected/dir'],  // 即使在 allowWrite 中。
          denyWrite: [],
          denyRead: [],
        },
        protectedPaths: ['/protected/dir'],
      };
      expect(isPathAllowed('/protected/dir/file', perms, 'read')).toBe(false);
      expect(isPathAllowed('/protected/dir/file', perms, 'write')).toBe(false);
    });

    it('should handle real-world default user scenario', () => {
      const user = createUser('scenario-test');
      const workspace = resolve(dataDir, 'users', user.userId, 'workspace');
      const userDir = resolve(process.cwd(), dataDir, 'users', user.userId);

      const perms = resolveUserPermissions(user.userId);

      // 用户 workspace 内 — 可读可写。
      expect(isPathAllowed(join(workspace, 'file.js'), perms, 'read')).toBe(true);
      expect(isPathAllowed(join(workspace, 'file.js'), perms, 'write')).toBe(true);

      // 用户 memory 目录 — 可读可写。
      expect(isPathAllowed(join(userDir, 'memory', 'core.json'), perms, 'write')).toBe(true);

      // 用户目录内 profile.json — 可读（不在 denyRead），不可写（不在 allowWrite）。
      expect(isPathAllowed(join(userDir, 'profile.json'), perms, 'read')).toBe(true);
      expect(isPathAllowed(join(userDir, 'profile.json'), perms, 'write')).toBe(false);

      // 系统路径 — 可读（不在 denyRead），不可写（不在 allowWrite）。
      expect(isPathAllowed('/usr/bin/node', perms, 'read')).toBe(true);
      expect(isPathAllowed('/usr/bin/node', perms, 'write')).toBe(false);
    });
  });

  // ── buildCanUseTool ──

  describe('buildCanUseTool', () => {
    it('should allow all tools for admin users', async () => {
      const user = createUser('admin-tool');
      const profile = readProfile(user.userId)!;
      profile.permissionGroup = 'admin';
      writeProfile(profile);

      const canUseTool = buildCanUseTool(user.userId);
      const result = await canUseTool('Write', { file_path: '/etc/hosts' }, {
        signal: new AbortController().signal,
        toolUseID: 'test-1',
      });
      expect(result.behavior).toBe('allow');
    });

    it('should allow MCP tools regardless of permissions', async () => {
      const user = createUser('mcp-tool');
      const canUseTool = buildCanUseTool(user.userId);
      const result = await canUseTool('mcp__better-claw__memory_write', { key: 'test' }, {
        signal: new AbortController().signal,
        toolUseID: 'test-2',
      });
      expect(result.behavior).toBe('allow');
    });

    it('should allow Bash (sandbox handles it)', async () => {
      const user = createUser('bash-tool');
      const canUseTool = buildCanUseTool(user.userId);
      const result = await canUseTool('Bash', { command: 'rm -rf /' }, {
        signal: new AbortController().signal,
        toolUseID: 'test-3',
      });
      expect(result.behavior).toBe('allow');
    });

    it('should deny Write to system paths for user group', async () => {
      const user = createUser('write-deny');
      const canUseTool = buildCanUseTool(user.userId);
      const result = await canUseTool('Write', { file_path: '/etc/hosts' }, {
        signal: new AbortController().signal,
        toolUseID: 'test-4',
      });
      expect(result.behavior).toBe('deny');
    });

    it('should allow Read from system paths for user group', async () => {
      const user = createUser('read-allow');
      const canUseTool = buildCanUseTool(user.userId);
      const result = await canUseTool('Read', { file_path: '/usr/bin/node' }, {
        signal: new AbortController().signal,
        toolUseID: 'test-5',
      });
      expect(result.behavior).toBe('allow');
    });

    it('should allow Write to user workspace', async () => {
      const user = createUser('write-ws');
      const workspace = resolve(dataDir, 'users', user.userId, 'workspace');
      const canUseTool = buildCanUseTool(user.userId);
      const result = await canUseTool('Write', { file_path: join(workspace, 'app.js') }, {
        signal: new AbortController().signal,
        toolUseID: 'test-6',
      });
      expect(result.behavior).toBe('allow');
    });

    it('should deny Read from other user directories', async () => {
      const userA = createUser('read-other-a');
      const userB = createUser('read-other-b');

      // 重新配置以包含 otherUserDir。
      reconfigurePermissions({
        groups: {
          admin: {},
          user: {
            filesystem: {
              allowWrite: ['${userWorkspace}'],
              denyRead: ['${otherUserDir}'],
            },
          },
        },
        defaultGroup: 'user',
      });

      const otherUserFile = resolve(dataDir, 'users', userB.userId, 'profile.json');
      const canUseTool = buildCanUseTool(userA.userId);
      const result = await canUseTool('Read', { file_path: otherUserFile }, {
        signal: new AbortController().signal,
        toolUseID: 'test-7',
      });
      expect(result.behavior).toBe('deny');
    });

    it('should handle Glob with path parameter', async () => {
      const user = createUser('glob-test');
      const canUseTool = buildCanUseTool(user.userId);
      const result = await canUseTool('Glob', { path: '/etc', pattern: '*.conf' }, {
        signal: new AbortController().signal,
        toolUseID: 'test-8',
      });
      // /etc 可读（不在 denyRead）。
      expect(result.behavior).toBe('allow');
    });

    it('should allow unknown tools', async () => {
      const user = createUser('unknown-tool');
      const canUseTool = buildCanUseTool(user.userId);
      const result = await canUseTool('SomeNewTool', { whatever: true }, {
        signal: new AbortController().signal,
        toolUseID: 'test-9',
      });
      expect(result.behavior).toBe('allow');
    });

    it('should deny Bash with dangerouslyDisableSandbox', async () => {
      const user = createUser('bash-nosandbox');
      const canUseTool = buildCanUseTool(user.userId);
      const result = await canUseTool('Bash', {
        command: 'echo hi',
        dangerouslyDisableSandbox: true,
      }, {
        signal: new AbortController().signal,
        toolUseID: 'test-10',
      });
      expect(result.behavior).toBe('deny');
    });
  });

  // ── buildSandboxSettings ──

  describe('buildSandboxSettings', () => {
    it('should disable sandbox for admin users', () => {
      const user = createUser('admin-sandbox');
      const profile = readProfile(user.userId)!;
      profile.permissionGroup = 'admin';
      writeProfile(profile);

      const settings = buildSandboxSettings(user.userId);
      expect(settings.enabled).toBe(false);
    });

    it('should enable sandbox for non-admin users', () => {
      const user = createUser('user-sandbox');
      const settings = buildSandboxSettings(user.userId);
      expect(settings.enabled).toBe(true);
      expect(settings.autoAllowBashIfSandboxed).toBe(true);
    });

    it('should pass through allowWrite to sandbox', () => {
      const user = createUser('sandbox-allow');
      const settings = buildSandboxSettings(user.userId);

      // 默认 user 组有 allowWrite 条目。
      expect(settings.filesystem?.allowWrite).toBeDefined();
      expect(settings.filesystem!.allowWrite!.length).toBeGreaterThan(0);
    });

    it('should include protectedPaths in sandbox denyRead and denyWrite', () => {
      reconfigurePermissions({
        groups: { admin: {}, user: {} },
        defaultGroup: 'user',
        protectedPaths: ['${dataDir}/secrets'],
      });

      const user = createUser('sandbox-pp');
      const settings = buildSandboxSettings(user.userId);
      const secretsDir = resolve(process.cwd(), dataDir, 'secrets');

      expect(settings.filesystem?.denyRead).toContain(secretsDir);
      expect(settings.filesystem?.denyWrite).toContain(secretsDir);
    });

    it('should include otherUserDir in sandbox denyRead', () => {
      const userA = createUser('sandbox-a');
      const userB = createUser('sandbox-b');

      // 使用默认配置（包含 ${otherUserDir}）。
      const settings = buildSandboxSettings(userA.userId);
      const userBDir = resolve(dataDir, 'users', userB.userId);

      expect(settings.filesystem?.denyRead).toContain(userBDir);
      expect(settings.filesystem?.denyWrite).toContain(userBDir);
    });
  });

  // ── 端到端场景 ──

  describe('end-to-end scenarios', () => {
    it('user A cannot read user B workspace', () => {
      const userA = createUser('user-a');
      const userB = createUser('user-b');

      // 重新配置以触发 ${otherUserDir} 展开。
      reconfigurePermissions({
        groups: {
          admin: {},
          user: {
            filesystem: {
              allowWrite: ['${userDir}/memory', '${userWorkspace}'],
              denyWrite: ['${otherUserDir}'],
              denyRead: ['${otherUserDir}'],
            },
          },
        },
        defaultGroup: 'user',
      });

      const permsA = resolveUserPermissions(userA.userId);
      const userBWorkspace = resolve(dataDir, 'users', userB.userId, 'workspace');

      expect(isPathAllowed(join(userBWorkspace, 'secret.txt'), permsA, 'read')).toBe(false);
      expect(isPathAllowed(join(userBWorkspace, 'secret.txt'), permsA, 'write')).toBe(false);
    });

    it('user can read and write own workspace', () => {
      const user = createUser('own-ws');
      const perms = resolveUserPermissions(user.userId);
      const workspace = resolve(dataDir, 'users', user.userId, 'workspace');

      expect(isPathAllowed(join(workspace, 'app.js'), perms, 'read')).toBe(true);
      expect(isPathAllowed(join(workspace, 'app.js'), perms, 'write')).toBe(true);
    });

    it('admin can read and write any path', () => {
      const user = createUser('admin-e2e');
      const profile = readProfile(user.userId)!;
      profile.permissionGroup = 'admin';
      writeProfile(profile);

      const perms = resolveUserPermissions(user.userId);
      expect(isPathAllowed('/etc/shadow', perms, 'read')).toBe(true);
      expect(isPathAllowed('/etc/shadow', perms, 'write')).toBe(true);
    });

    it('work group rw member can write to shared workspace', () => {
      const user = createUser('wg-rw');
      reconfigurePermissions({
        groups: {
          admin: {},
          user: {
            filesystem: {
              allowWrite: ['${userWorkspace}'],
              denyWrite: ['${otherUserDir}'],
              denyRead: ['${otherUserDir}'],
            },
          },
        },
        workGroups: {
          'shared-team': { members: { [user.userId]: 'rw' } },
        },
        defaultGroup: 'user',
      });

      const perms = resolveUserPermissions(user.userId);
      const wgWorkspace = resolve(dataDir, 'workgroups', 'shared-team', 'workspace');

      expect(isPathAllowed(join(wgWorkspace, 'doc.md'), perms, 'read')).toBe(true);
      expect(isPathAllowed(join(wgWorkspace, 'doc.md'), perms, 'write')).toBe(true);
    });

    it('work group r member can read but not write shared workspace', () => {
      const user = createUser('wg-r');
      reconfigurePermissions({
        groups: {
          admin: {},
          user: {
            filesystem: {
              allowWrite: ['${userWorkspace}'],
              denyWrite: ['${otherUserDir}'],
              denyRead: ['${otherUserDir}'],
            },
          },
        },
        workGroups: {
          'shared-team': { members: { [user.userId]: 'r' } },
        },
        defaultGroup: 'user',
      });

      const perms = resolveUserPermissions(user.userId);
      const wgWorkspace = resolve(dataDir, 'workgroups', 'shared-team', 'workspace');

      expect(isPathAllowed(join(wgWorkspace, 'doc.md'), perms, 'read')).toBe(true);
      // r 成员不可写（workspace 不在 allowWrite 中）。
      expect(isPathAllowed(join(wgWorkspace, 'doc.md'), perms, 'write')).toBe(false);
    });

    it('developer group inherits user rules and extends them', () => {
      const user = createUser('dev-inherit');
      reconfigurePermissions({
        groups: {
          admin: {},
          user: {
            filesystem: {
              allowWrite: ['${userWorkspace}'],
              denyWrite: ['${otherUserDir}'],
              denyRead: ['${otherUserDir}'],
            },
          },
          developer: {
            inherits: 'user',
            filesystem: {
              allowWrite: ['/opt/projects'],
            },
          },
        },
        defaultGroup: 'developer',
      });

      const perms = resolveUserPermissions(user.userId);

      // 继承自 user：系统路径不可写。
      expect(isPathAllowed('/usr/bin/node', perms, 'read')).toBe(true);
      expect(isPathAllowed('/usr/bin/node', perms, 'write')).toBe(false);

      // developer 额外的 allowWrite：/opt/projects 可写。
      expect(isPathAllowed('/opt/projects/repo/file.ts', perms, 'read')).toBe(true);
      expect(isPathAllowed('/opt/projects/repo/file.ts', perms, 'write')).toBe(true);
    });

    it('user cannot read dataDir config when denyRead covers it', () => {
      reconfigurePermissions({
        groups: {
          admin: {},
          user: {
            filesystem: {
              allowWrite: ['${userWorkspace}'],
              denyRead: ['${dataDir}/secrets'],
            },
          },
        },
        defaultGroup: 'user',
      });

      const user = createUser('deny-read-test');
      const perms = resolveUserPermissions(user.userId);
      const secretFile = resolve(process.cwd(), dataDir, 'secrets', 'key.pem');

      expect(isPathAllowed(secretFile, perms, 'read')).toBe(false);
      // 但其他 dataDir 下的文件仍可读。
      const otherFile = resolve(process.cwd(), dataDir, 'config.yaml');
      expect(isPathAllowed(otherFile, perms, 'read')).toBe(true);
    });
  });
});
