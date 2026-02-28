import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join, resolve } from 'path';
import { homedir } from 'os';
import { createTestEnv } from '../helpers/setup.js';
import { createUser } from '../../src/user/manager.js';
import { readProfile, writeProfile } from '../../src/user/store.js';
import { setConfig, resetConfig, getConfigFilePath, loadConfig } from '../../src/config/index.js';
import { AppConfigSchema } from '../../src/config/schema.js';
import { createLogger } from '../../src/logger/index.js';
import { loadBindingCache } from '../../src/user/manager.js';
import {
  resolvePathVariable,
  resolveUserPermissions,
  isPathAllowed,
} from '../../src/core/permissions.js';
import { globToRegex, buildSdkEnv } from '../../src/core/agent.js';

/**
 * 安全加固相关单元测试。
 *
 * 覆盖 protectedPaths、环境变量过滤（envFilter/envExtra）、
 * 路径变量 ${home}/${configFile} 解析、globToRegex 通配符匹配。
 */
describe('Security', () => {
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
   * @param overrides - 配置覆盖。
   */
  function reconfigure(overrides: Record<string, unknown>): void {
    resetConfig();
    const config = AppConfigSchema.parse({
      dataDir,
      logging: { directory: join(dataDir, 'logs') },
      ...overrides,
    });
    setConfig(config);
    createLogger(config.logging);
    loadBindingCache();
  }

  // ── globToRegex ──

  describe('globToRegex', () => {
    it('should match exact string without wildcard', () => {
      const re = globToRegex('HOME');
      expect(re.test('HOME')).toBe(true);
      expect(re.test('HOMEDIR')).toBe(false);
      expect(re.test('MY_HOME')).toBe(false);
    });

    it('should match prefix with trailing *', () => {
      const re = globToRegex('ANTHROPIC_*');
      expect(re.test('ANTHROPIC_API_KEY')).toBe(true);
      expect(re.test('ANTHROPIC_AUTH_TOKEN')).toBe(true);
      expect(re.test('ANTHROPIC_')).toBe(true);
      expect(re.test('MY_ANTHROPIC_KEY')).toBe(false);
    });

    it('should match suffix with leading *', () => {
      const re = globToRegex('*_SECRET');
      expect(re.test('DB_SECRET')).toBe(true);
      expect(re.test('_SECRET')).toBe(true);
      expect(re.test('SECRET')).toBe(false);
      expect(re.test('DB_SECRET_KEY')).toBe(false);
    });

    it('should match middle wildcard', () => {
      const re = globToRegex('MY_*_KEY');
      expect(re.test('MY_API_KEY')).toBe(true);
      expect(re.test('MY_SECRET_KEY')).toBe(true);
      expect(re.test('MY__KEY')).toBe(true);
      expect(re.test('MY_KEY')).toBe(false);
    });

    it('should match everything with single *', () => {
      const re = globToRegex('*');
      expect(re.test('ANYTHING')).toBe(true);
      expect(re.test('')).toBe(true);
    });

    it('should escape regex special characters', () => {
      const re = globToRegex('MY.VAR');
      expect(re.test('MY.VAR')).toBe(true);
      expect(re.test('MY_VAR')).toBe(false);
    });
  });

  // ── resolvePathVariable: ${home} 和 ${configFile} ──

  describe('resolvePathVariable - ${home} and ${configFile}', () => {
    it('should replace ${home} with system home directory', () => {
      const user = createUser('home-var');
      const result = resolvePathVariable('${home}/.claude', user.userId);
      expect(result).toBe(join(homedir(), '.claude'));
    });

    it('should return null when ${configFile} is used and configFilePath is null', () => {
      // createTestEnv 使用 setConfig 而非 loadConfig，所以 configFilePath 为 null。
      const user = createUser('cf-null');
      const result = resolvePathVariable('${configFile}', user.userId);
      expect(result).toBeNull();
    });

    it('should resolve ${configFile} when config is loaded from file', () => {
      resetConfig();
      const configPath = join(dataDir, 'config.yaml');
      loadConfig({ configPath, dataDir });
      createLogger({ level: 'info', directory: join(dataDir, 'logs'), maxSize: '10m', maxFiles: 10, replyLogMaxLength: 200 });
      loadBindingCache();

      const user = createUser('cf-loaded');
      const result = resolvePathVariable('${configFile}', user.userId);
      expect(result).toBe(resolve(configPath));
    });

    it('should combine ${home} with other text', () => {
      const user = createUser('home-combo');
      const result = resolvePathVariable('${home}/some/nested/path', user.userId);
      expect(result).toBe(join(homedir(), 'some/nested/path'));
    });
  });

  // ── protectedPaths ──

  describe('protectedPaths', () => {
    it('should deny access to ~/.claude for non-admin users by default', () => {
      const user = createUser('pp-default');
      const perms = resolveUserPermissions(user.userId);
      const claudeDir = resolve(homedir(), '.claude');

      expect(isPathAllowed(join(claudeDir, 'config.json'), perms, 'read')).toBe(false);
      expect(isPathAllowed(join(claudeDir, 'config.json'), perms, 'write')).toBe(false);
    });

    it('should not restrict admin users', () => {
      const user = createUser('pp-admin');
      const profile = readProfile(user.userId)!;
      profile.permissionGroup = 'admin';
      writeProfile(profile);

      const perms = resolveUserPermissions(user.userId);
      const claudeDir = resolve(homedir(), '.claude');

      expect(isPathAllowed(join(claudeDir, 'config.json'), perms, 'read')).toBe(true);
    });

    it('should use custom protectedPaths from config', () => {
      reconfigure({
        permissions: {
          groups: { admin: {}, user: { rules: [] } },
          defaultGroup: 'user',
          protectedPaths: ['/etc/secrets', '${home}/.ssh'],
        },
      });

      const user = createUser('pp-custom');
      const perms = resolveUserPermissions(user.userId);

      expect(isPathAllowed('/etc/secrets/key.pem', perms, 'read')).toBe(false);
      expect(isPathAllowed(join(homedir(), '.ssh', 'id_rsa'), perms, 'read')).toBe(false);
      // ~/.claude 不在自定义列表中，不被保护。
      expect(isPathAllowed(join(homedir(), '.claude', 'config.json'), perms, 'read')).toBe(true);
    });

    it('should allow disabling protectedPaths with empty array', () => {
      reconfigure({
        permissions: {
          groups: { admin: {}, user: { rules: [] } },
          defaultGroup: 'user',
          protectedPaths: [],
        },
      });

      const user = createUser('pp-empty');
      const perms = resolveUserPermissions(user.userId);

      // 没有 protectedPaths 时，~/.claude 不被自动保护。
      expect(isPathAllowed(join(homedir(), '.claude', 'config.json'), perms, 'read')).toBe(true);
    });

    it('should skip ${configFile} rule when config is not loaded from file', () => {
      // createTestEnv 使用 setConfig，configFilePath 为 null。
      const user = createUser('pp-no-cf');
      const perms = resolveUserPermissions(user.userId);

      // 规则中不应包含 configFile 相关的 deny（因为路径为 null 被跳过了）。
      const configRules = perms.rules.filter(
        (r) => r.action === 'deny' && r.path.includes('config.yaml'),
      );
      expect(configRules.length).toBe(0);
    });

    it('should deny access to configFile when loaded from file', () => {
      resetConfig();
      const configPath = join(dataDir, 'config.yaml');
      const config = loadConfig({ configPath, dataDir });
      createLogger(config.logging);
      loadBindingCache();

      const user = createUser('pp-cf-deny');
      const perms = resolveUserPermissions(user.userId);

      expect(isPathAllowed(configPath, perms, 'read')).toBe(false);
      expect(isPathAllowed(configPath, perms, 'write')).toBe(false);
    });
  });

  // ── buildSdkEnv ──

  describe('buildSdkEnv', () => {
    it('should pass all env vars for admin users', () => {
      const user = createUser('env-admin');
      const profile = readProfile(user.userId)!;
      profile.permissionGroup = 'admin';
      writeProfile(profile);

      const config = AppConfigSchema.parse({
        dataDir,
        logging: { directory: join(dataDir, 'logs') },
      });
      setConfig(config);

      const env = buildSdkEnv(user.userId, config);
      // admin 继承所有 process.env。
      expect(env.PATH).toBe(process.env.PATH);
      expect(env.HOME).toBe(process.env.HOME);
    });

    it('should inherit all env vars when envFilter is empty (default)', () => {
      const user = createUser('env-no-filter');
      const config = AppConfigSchema.parse({
        dataDir,
        logging: { directory: join(dataDir, 'logs') },
      });
      setConfig(config);

      const env = buildSdkEnv(user.userId, config);
      // 默认 envFilter 为空，所有变量都应继承。
      expect(env.PATH).toBe(process.env.PATH);
      expect(env.HOME).toBe(process.env.HOME);
    });

    it('should filter env vars matching envFilter patterns', () => {
      const user = createUser('env-filter');

      // 临时注入测试用环境变量。
      const origSecret = process.env.MY_SECRET_KEY;
      const origApiKey = process.env.ANTHROPIC_API_KEY;
      process.env.MY_SECRET_KEY = 'should-be-filtered';
      process.env.ANTHROPIC_API_KEY = 'should-be-filtered-too';

      try {
        reconfigure({
          permissions: {
            groups: { admin: {}, user: { rules: [] } },
            defaultGroup: 'user',
            envFilter: ['MY_SECRET_*', 'ANTHROPIC_*'],
          },
        });
        const config = AppConfigSchema.parse({
          dataDir,
          logging: { directory: join(dataDir, 'logs') },
          permissions: {
            groups: { admin: {}, user: { rules: [] } },
            defaultGroup: 'user',
            envFilter: ['MY_SECRET_*', 'ANTHROPIC_*'],
          },
        });
        setConfig(config);

        const env = buildSdkEnv(user.userId, config);

        // 匹配 envFilter 的变量应被过滤。
        expect(env.MY_SECRET_KEY).toBeUndefined();
        // 但 PATH 等不匹配的应保留。
        expect(env.PATH).toBe(process.env.PATH);
      } finally {
        // 恢复环境变量。
        if (origSecret === undefined) {
          delete process.env.MY_SECRET_KEY;
        } else {
          process.env.MY_SECRET_KEY = origSecret;
        }
        if (origApiKey === undefined) {
          delete process.env.ANTHROPIC_API_KEY;
        } else {
          process.env.ANTHROPIC_API_KEY = origApiKey;
        }
      }
    });

    it('should inject envExtra after filtering', () => {
      const user = createUser('env-extra');
      reconfigure({
        permissions: {
          groups: { admin: {}, user: { rules: [] } },
          defaultGroup: 'user',
          envExtra: { CUSTOM_VAR: 'hello', ANOTHER: 'world' },
        },
      });
      const config = AppConfigSchema.parse({
        dataDir,
        logging: { directory: join(dataDir, 'logs') },
        permissions: {
          groups: { admin: {}, user: { rules: [] } },
          defaultGroup: 'user',
          envExtra: { CUSTOM_VAR: 'hello', ANOTHER: 'world' },
        },
      });
      setConfig(config);

      const env = buildSdkEnv(user.userId, config);
      expect(env.CUSTOM_VAR).toBe('hello');
      expect(env.ANOTHER).toBe('world');
    });

    it('should always inject Anthropic vars from config regardless of filter', () => {
      const user = createUser('env-anthropic');
      reconfigure({
        anthropic: { apiKey: 'sk-test-key', baseUrl: 'https://proxy.example.com' },
        permissions: {
          groups: { admin: {}, user: { rules: [] } },
          defaultGroup: 'user',
          envFilter: ['ANTHROPIC_*'],
        },
      });
      const config = AppConfigSchema.parse({
        dataDir,
        logging: { directory: join(dataDir, 'logs') },
        anthropic: { apiKey: 'sk-test-key', baseUrl: 'https://proxy.example.com' },
        permissions: {
          groups: { admin: {}, user: { rules: [] } },
          defaultGroup: 'user',
          envFilter: ['ANTHROPIC_*'],
        },
      });
      setConfig(config);

      const env = buildSdkEnv(user.userId, config);
      // envFilter 过滤了 process.env 中的 ANTHROPIC_*，但 config 中的值仍然注入。
      expect(env.ANTHROPIC_API_KEY).toBe('sk-test-key');
      expect(env.ANTHROPIC_BASE_URL).toBe('https://proxy.example.com');
    });

    it('should let envExtra override filtered variables', () => {
      const user = createUser('env-override');
      const origKey = process.env.FILTERED_VAR;
      process.env.FILTERED_VAR = 'from-process';

      try {
        const config = AppConfigSchema.parse({
          dataDir,
          logging: { directory: join(dataDir, 'logs') },
          permissions: {
            groups: { admin: {}, user: { rules: [] } },
            defaultGroup: 'user',
            envFilter: ['FILTERED_*'],
            envExtra: { FILTERED_VAR: 'from-extra' },
          },
        });
        setConfig(config);

        const env = buildSdkEnv(user.userId, config);
        // envFilter 过滤掉 FILTERED_VAR，但 envExtra 又加回来。
        expect(env.FILTERED_VAR).toBe('from-extra');
      } finally {
        if (origKey === undefined) {
          delete process.env.FILTERED_VAR;
        } else {
          process.env.FILTERED_VAR = origKey;
        }
      }
    });
  });
});
