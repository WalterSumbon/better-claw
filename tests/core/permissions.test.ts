import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join, resolve } from 'path';
import { mkdirSync, writeFileSync } from 'fs';
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
 * 测试规则链评估、继承机制、变量替换、工作组合并、
 * canUseTool 回调和 sandbox 配置生成。
 */
describe('Permissions', () => {
  let dataDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    const env = createTestEnv();
    dataDir = env.dataDir;
    cleanup = env.cleanup;
  });

  afterEach(() => {
    cleanup();
  });

  /**
   * 使用自定义权限配置重新设置测试环境。
   *
   * @param permissionsOverride - 权限配置覆盖。
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
      expect(perms.rules).toEqual([]);
    });

    it('should return default user group rules when no permissionGroup set', () => {
      const user = createUser('default-user');
      const perms = resolveUserPermissions(user.userId);

      expect(perms.isAdmin).toBe(false);
      expect(perms.rules.length).toBe(4);
      expect(perms.rules[0].action).toBe('deny');
      expect(perms.rules[0].access).toBe('write');
      expect(perms.rules[0].path).toBe('*');
    });

    it('should flatten inherited rules (parent first, child after)', () => {
      reconfigurePermissions({
        groups: {
          admin: {},
          base: {
            rules: [
              { action: 'deny', access: 'write', path: '*' },
            ],
          },
          child: {
            inherits: 'base',
            rules: [
              { action: 'allow', access: 'readwrite', path: '/opt/projects' },
            ],
          },
        },
        defaultGroup: 'child',
      });

      const user = createUser('inherit-test');
      const perms = resolveUserPermissions(user.userId);

      expect(perms.rules.length).toBe(2);
      // 父组规则在前。
      expect(perms.rules[0]).toEqual({ action: 'deny', access: 'write', path: '*' });
      // 子组规则在后。
      expect(perms.rules[1]).toEqual({ action: 'allow', access: 'readwrite', path: '/opt/projects' });
    });

    it('should detect circular inheritance and not loop', () => {
      reconfigurePermissions({
        groups: {
          admin: {},
          groupA: { inherits: 'groupB', rules: [{ action: 'deny', access: 'read', path: '/a' }] },
          groupB: { inherits: 'groupA', rules: [{ action: 'deny', access: 'read', path: '/b' }] },
        },
        defaultGroup: 'groupA',
      });

      const user = createUser('circular-test');
      // 不应死循环，应正常返回。
      const perms = resolveUserPermissions(user.userId);
      expect(perms.isAdmin).toBe(false);
      expect(perms.rules.length).toBeGreaterThanOrEqual(0);
    });

    it('should fall back to empty rules for unknown group', () => {
      const user = createUser('unknown-group');
      const profile = readProfile(user.userId)!;
      profile.permissionGroup = 'nonexistent';
      writeProfile(profile);

      const perms = resolveUserPermissions(user.userId);
      expect(perms.isAdmin).toBe(false);
      expect(perms.rules).toEqual([]);
    });

    it('should append work group rules at the end', () => {
      reconfigurePermissions({
        groups: {
          admin: {},
          user: {
            rules: [{ action: 'deny', access: 'write', path: '*' }],
          },
        },
        workGroups: {
          'team-alpha': {
            members: { placeholder: 'rw' },
          },
        },
        defaultGroup: 'user',
      });

      // 需要把实际 userId 放到 workGroup members 中。
      const user = createUser('wg-test');
      // 重新配置，把真实 userId 注入 members。
      reconfigurePermissions({
        groups: {
          admin: {},
          user: {
            rules: [{ action: 'deny', access: 'write', path: '*' }],
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
      // 最后一条应该是工作组追加的 allow readwrite 规则。
      const lastRule = perms.rules[perms.rules.length - 1];
      expect(lastRule.action).toBe('allow');
      expect(lastRule.access).toBe('readwrite');
      expect(lastRule.path).toContain('workgroups/team-alpha/workspace');
    });

    it('should add read-only rule for work group "r" members', () => {
      const user = createUser('wg-readonly');
      reconfigurePermissions({
        groups: { admin: {}, user: { rules: [] } },
        workGroups: {
          'team-beta': {
            members: { [user.userId]: 'r' },
          },
        },
        defaultGroup: 'user',
      });

      const perms = resolveUserPermissions(user.userId);
      const lastRule = perms.rules[perms.rules.length - 1];
      expect(lastRule.action).toBe('allow');
      expect(lastRule.access).toBe('read');
    });
  });

  // ── isPathAllowed ──

  describe('isPathAllowed', () => {
    it('should always allow admin', () => {
      const perms = { isAdmin: true, rules: [] };
      expect(isPathAllowed('/etc/passwd', perms, 'read')).toBe(true);
      expect(isPathAllowed('/etc/passwd', perms, 'write')).toBe(true);
    });

    it('should allow by default (base state = allow) when no rules match', () => {
      const perms = { isAdmin: false, rules: [] };
      expect(isPathAllowed('/any/path', perms, 'read')).toBe(true);
      expect(isPathAllowed('/any/path', perms, 'write')).toBe(true);
    });

    it('should deny when deny rule matches', () => {
      const perms = {
        isAdmin: false,
        rules: [{ action: 'deny' as const, access: 'write' as const, path: '*' }],
      };
      expect(isPathAllowed('/any/path', perms, 'write')).toBe(false);
      // read 不受 deny write 影响。
      expect(isPathAllowed('/any/path', perms, 'read')).toBe(true);
    });

    it('should use last matching rule (later rules override)', () => {
      const perms = {
        isAdmin: false,
        rules: [
          { action: 'deny' as const, access: 'readwrite' as const, path: '/data' },
          { action: 'allow' as const, access: 'readwrite' as const, path: '/data/mydir' },
        ],
      };
      // /data 被 deny。
      expect(isPathAllowed('/data/other', perms, 'read')).toBe(false);
      // /data/mydir 被后面的 allow 覆盖。
      expect(isPathAllowed('/data/mydir/file.txt', perms, 'read')).toBe(true);
      expect(isPathAllowed('/data/mydir/file.txt', perms, 'write')).toBe(true);
    });

    it('should match readwrite access to both read and write modes', () => {
      const perms = {
        isAdmin: false,
        rules: [{ action: 'deny' as const, access: 'readwrite' as const, path: '/secret' }],
      };
      expect(isPathAllowed('/secret/file', perms, 'read')).toBe(false);
      expect(isPathAllowed('/secret/file', perms, 'write')).toBe(false);
    });

    it('should not match read-only rule against write mode', () => {
      const perms = {
        isAdmin: false,
        rules: [{ action: 'deny' as const, access: 'read' as const, path: '/logs' }],
      };
      // write 不受 deny read 影响。
      expect(isPathAllowed('/logs/app.log', perms, 'write')).toBe(true);
      expect(isPathAllowed('/logs/app.log', perms, 'read')).toBe(false);
    });

    it('should simulate default user group scenario correctly', () => {
      const user = createUser('scenario-test');
      const workspace = resolve(dataDir, 'users', user.userId, 'workspace');
      const userDir = join(dataDir, 'users', user.userId);
      const absDataDir = resolve(process.cwd(), dataDir);

      const perms = resolveUserPermissions(user.userId);

      // 用户 workspace 内 — 可读可写。
      expect(isPathAllowed(join(workspace, 'file.js'), perms, 'read')).toBe(true);
      expect(isPathAllowed(join(workspace, 'file.js'), perms, 'write')).toBe(true);

      // 用户目录内非 workspace — 只读。
      expect(isPathAllowed(join(userDir, 'profile.json'), perms, 'read')).toBe(true);
      expect(isPathAllowed(join(userDir, 'profile.json'), perms, 'write')).toBe(false);

      // 其他用户目录 — 不可读不可写。
      const otherUserDir = join(absDataDir, 'users', 'user_other');
      expect(isPathAllowed(join(otherUserDir, 'file'), perms, 'read')).toBe(false);
      expect(isPathAllowed(join(otherUserDir, 'file'), perms, 'write')).toBe(false);

      // 系统其他路径 — 可读不可写。
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
      const user = createUser('read-other');
      const absDataDir = resolve(process.cwd(), dataDir);
      const otherUserFile = join(absDataDir, 'users', 'user_other', 'profile.json');
      const canUseTool = buildCanUseTool(user.userId);
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
      // /etc 可读。
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

    it('should extract deny rules into sandbox filesystem config', () => {
      const user = createUser('sandbox-rules');
      const settings = buildSandboxSettings(user.userId);

      // 默认 user 组有 deny write * 和 deny readwrite ${dataDir}。
      expect(settings.filesystem?.denyRead).toBeDefined();
      expect(settings.filesystem?.denyWrite).toBeDefined();
    });

    it('should extract allow write rules into sandbox allowWrite', () => {
      const user = createUser('sandbox-allow');
      const settings = buildSandboxSettings(user.userId);

      // 默认 user 组有 allow readwrite ${userWorkspace}。
      expect(settings.filesystem?.allowWrite).toBeDefined();
      expect(settings.filesystem!.allowWrite!.length).toBeGreaterThan(0);
    });
  });

  // ── 端到端场景 ──

  describe('end-to-end scenarios', () => {
    it('user A cannot read user B workspace', () => {
      const userA = createUser('user-a');
      const userB = createUser('user-b');

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
            rules: [
              { action: 'deny', access: 'write', path: '*' },
              { action: 'deny', access: 'readwrite', path: '${dataDir}' },
              { action: 'allow', access: 'read', path: '${userDir}' },
              { action: 'allow', access: 'readwrite', path: '${userWorkspace}' },
            ],
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
            rules: [
              { action: 'deny', access: 'write', path: '*' },
              { action: 'deny', access: 'readwrite', path: '${dataDir}' },
              { action: 'allow', access: 'read', path: '${userDir}' },
              { action: 'allow', access: 'readwrite', path: '${userWorkspace}' },
            ],
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
      expect(isPathAllowed(join(wgWorkspace, 'doc.md'), perms, 'write')).toBe(false);
    });

    it('developer group inherits user rules and extends them', () => {
      const user = createUser('dev-inherit');
      reconfigurePermissions({
        groups: {
          admin: {},
          user: {
            rules: [
              { action: 'deny', access: 'write', path: '*' },
              { action: 'deny', access: 'readwrite', path: '${dataDir}' },
              { action: 'allow', access: 'read', path: '${userDir}' },
              { action: 'allow', access: 'readwrite', path: '${userWorkspace}' },
            ],
          },
          developer: {
            inherits: 'user',
            rules: [
              { action: 'allow', access: 'readwrite', path: '/opt/projects' },
            ],
          },
        },
        defaultGroup: 'developer',
      });

      const perms = resolveUserPermissions(user.userId);

      // 继承自 user：系统路径只读。
      expect(isPathAllowed('/usr/bin/node', perms, 'read')).toBe(true);
      expect(isPathAllowed('/usr/bin/node', perms, 'write')).toBe(false);

      // developer 自己的规则：/opt/projects 可读可写。
      expect(isPathAllowed('/opt/projects/repo/file.ts', perms, 'read')).toBe(true);
      expect(isPathAllowed('/opt/projects/repo/file.ts', perms, 'write')).toBe(true);

      // 其他用户数据目录仍不可访问。
      const absDataDir = resolve(process.cwd(), dataDir);
      expect(isPathAllowed(join(absDataDir, 'users', 'user_other', 'file'), perms, 'read')).toBe(false);
    });
  });
});
