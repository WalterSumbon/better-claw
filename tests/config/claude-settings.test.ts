import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  loadClaudeSettings,
  resetClaudeSettings,
  initClaudeSettings,
  getClaudeSettings,
  reloadClaudeSettings,
} from '../../src/config/claude-settings.js';
import { createLogger, destroyLogger } from '../../src/logger/index.js';

// Mock homedir 指向临时目录，隔离真实 ~/.claude/settings.json。
let fakeHome: string;
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return {
    ...actual,
    homedir: () => fakeHome,
  };
});

/**
 * Claude Code settings 选择性继承 单元测试。
 *
 * 覆盖：三层合并优先级、mcpServers 覆盖、disallowedTools 去重、
 * 缺失文件处理、无关字段过滤。
 */
describe('claude-settings', () => {
  let tmpDir: string;
  let originalCwd: string;

  /** 写入 JSON settings 文件到指定路径。 */
  function writeSettings(filePath: string, data: Record<string, unknown>): void {
    mkdirSync(join(filePath, '..'), { recursive: true });
    writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  }

  beforeEach(() => {
    // 每个测试使用独立临时目录作为 cwd 和 fake home，完全隔离。
    tmpDir = mkdtempSync(join(tmpdir(), 'claude-settings-test-'));
    fakeHome = join(tmpDir, 'home');
    mkdirSync(fakeHome, { recursive: true });
    originalCwd = process.cwd();
    process.chdir(tmpDir);

    // 初始化日志（initClaudeSettings 依赖它）。
    mkdirSync(join(tmpDir, 'logs'), { recursive: true });
    createLogger({ level: 'info', directory: join(tmpDir, 'logs'), maxSize: '10m', maxFiles: 5, replyLogMaxLength: 200 });

    resetClaudeSettings();
  });

  afterEach(async () => {
    await destroyLogger();
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true, force: true });
    resetClaudeSettings();
  });

  // ── 基本功能 ──

  describe('loadClaudeSettings', () => {
    it('should return empty mcpServers and disallowedTools when no settings files exist', () => {
      const result = loadClaudeSettings();
      expect(result.mcpServers).toEqual({});
      expect(result.disallowedTools).toEqual([]);
    });

    it('should load mcpServers from user settings', () => {
      writeSettings(join(fakeHome, '.claude', 'settings.json'), {
        mcpServers: {
          'test-server': {
            type: 'stdio',
            command: 'node',
            args: ['server.js'],
          },
        },
      });

      const result = loadClaudeSettings();
      expect(result.mcpServers['test-server']).toBeDefined();
      expect(result.mcpServers['test-server'].command).toBe('node');
    });

    it('should load mcpServers from project settings', () => {
      writeSettings(join(tmpDir, '.claude', 'settings.json'), {
        mcpServers: {
          'project-server': {
            type: 'sse',
            url: 'http://localhost:3000',
          },
        },
      });

      const result = loadClaudeSettings();
      expect(result.mcpServers['project-server']).toBeDefined();
      expect(result.mcpServers['project-server'].url).toBe('http://localhost:3000');
    });

    it('should load mcpServers from local settings', () => {
      writeSettings(join(tmpDir, '.claude', 'settings.local.json'), {
        mcpServers: {
          'local-server': {
            type: 'http',
            url: 'http://localhost:4000',
          },
        },
      });

      const result = loadClaudeSettings();
      expect(result.mcpServers['local-server']).toBeDefined();
    });

    it('should load disallowedTools from settings', () => {
      writeSettings(join(tmpDir, '.claude', 'settings.json'), {
        disallowedTools: ['WebFetch(domain:example.com)', 'Bash(rm)'],
      });

      const result = loadClaudeSettings();
      expect(result.disallowedTools).toContain('WebFetch(domain:example.com)');
      expect(result.disallowedTools).toContain('Bash(rm)');
    });
  });

  // ── 三层合并优先级 ──

  describe('merge priority (local > project > user)', () => {
    it('should let local mcpServers override project and user with same name', () => {
      // 注意：此测试仅操作 project/local，不修改真实 ~/.claude/settings.json。
      writeSettings(join(tmpDir, '.claude', 'settings.json'), {
        mcpServers: {
          'shared-server': {
            type: 'stdio',
            command: 'project-cmd',
          },
          'project-only': {
            type: 'stdio',
            command: 'project-only-cmd',
          },
        },
      });

      writeSettings(join(tmpDir, '.claude', 'settings.local.json'), {
        mcpServers: {
          'shared-server': {
            type: 'stdio',
            command: 'local-cmd',
          },
          'local-only': {
            type: 'stdio',
            command: 'local-only-cmd',
          },
        },
      });

      const result = loadClaudeSettings();

      // local 覆盖同名 server。
      expect(result.mcpServers['shared-server'].command).toBe('local-cmd');
      // 各层独有的 server 都保留。
      expect(result.mcpServers['project-only'].command).toBe('project-only-cmd');
      expect(result.mcpServers['local-only'].command).toBe('local-only-cmd');
    });

    it('should deduplicate disallowedTools across layers', () => {
      writeSettings(join(tmpDir, '.claude', 'settings.json'), {
        disallowedTools: ['ToolA', 'ToolB'],
      });

      writeSettings(join(tmpDir, '.claude', 'settings.local.json'), {
        disallowedTools: ['ToolB', 'ToolC'],
      });

      const result = loadClaudeSettings();

      // 应去重合并。
      expect(result.disallowedTools).toHaveLength(3);
      expect(result.disallowedTools).toContain('ToolA');
      expect(result.disallowedTools).toContain('ToolB');
      expect(result.disallowedTools).toContain('ToolC');
    });
  });

  // ── 字段过滤 ──

  describe('field filtering', () => {
    it('should ignore permissions, model, and other irrelevant fields', () => {
      writeSettings(join(tmpDir, '.claude', 'settings.json'), {
        mcpServers: {
          'my-server': { type: 'stdio', command: 'test' },
        },
        disallowedTools: ['SomeTool'],
        // 以下字段应被过滤，不出现在结果中。
        permissions: {
          allow: ['WebFetch(domain:openai.com)'],
          deny: ['Bash(rm -rf)'],
        },
        model: 'claude-sonnet-4-20250514',
        effortLevel: 'high',
        output_style: 'concise',
      });

      const result = loadClaudeSettings();

      // 只有 mcpServers 和 disallowedTools。
      expect(result.mcpServers['my-server']).toBeDefined();
      expect(result.disallowedTools).toContain('SomeTool');
      expect(Object.keys(result)).toEqual(['mcpServers', 'disallowedTools']);
      // 确保没有额外字段。
      expect((result as Record<string, unknown>)['permissions']).toBeUndefined();
      expect((result as Record<string, unknown>)['model']).toBeUndefined();
    });

    it('should filter non-string values from disallowedTools array', () => {
      writeSettings(join(tmpDir, '.claude', 'settings.json'), {
        disallowedTools: ['ValidTool', 42, null, true, 'AnotherTool'],
      });

      const result = loadClaudeSettings();
      expect(result.disallowedTools).toEqual(['ValidTool', 'AnotherTool']);
    });

    it('should ignore mcpServers if it is not a plain object', () => {
      writeSettings(join(tmpDir, '.claude', 'settings.json'), {
        mcpServers: ['not', 'an', 'object'],
      });

      const result = loadClaudeSettings();
      expect(result.mcpServers).toEqual({});
    });
  });

  // ── 缓存行为 ──

  describe('cache behavior', () => {
    it('getClaudeSettings should lazily load when not initialized', () => {
      writeSettings(join(tmpDir, '.claude', 'settings.json'), {
        mcpServers: {
          'lazy-server': { type: 'stdio', command: 'lazy' },
        },
      });

      // 不调用 initClaudeSettings，直接 get。
      const result = getClaudeSettings();
      expect(result.mcpServers['lazy-server']).toBeDefined();
    });

    it('initClaudeSettings should populate cache', () => {
      writeSettings(join(tmpDir, '.claude', 'settings.json'), {
        mcpServers: {
          'init-server': { type: 'stdio', command: 'init' },
        },
      });

      const result = initClaudeSettings();
      expect(result.mcpServers['init-server']).toBeDefined();

      // 后续 get 应返回缓存值。
      const cached = getClaudeSettings();
      expect(cached).toBe(result);
    });

    it('reloadClaudeSettings should refresh cache with new data', () => {
      writeSettings(join(tmpDir, '.claude', 'settings.json'), {
        mcpServers: {
          'v1-server': { type: 'stdio', command: 'v1' },
        },
      });

      initClaudeSettings();
      expect(getClaudeSettings().mcpServers['v1-server']).toBeDefined();

      // 修改 settings 文件。
      writeSettings(join(tmpDir, '.claude', 'settings.json'), {
        mcpServers: {
          'v2-server': { type: 'stdio', command: 'v2' },
        },
      });

      const reloaded = reloadClaudeSettings();
      expect(reloaded.mcpServers['v1-server']).toBeUndefined();
      expect(reloaded.mcpServers['v2-server']).toBeDefined();
    });

    it('resetClaudeSettings should clear cache', () => {
      writeSettings(join(tmpDir, '.claude', 'settings.json'), {
        mcpServers: {
          'cached-server': { type: 'stdio', command: 'cached' },
        },
      });

      initClaudeSettings();
      resetClaudeSettings();

      // 清除文件后，重新 get 应重新加载。
      rmSync(join(tmpDir, '.claude'), { recursive: true, force: true });
      const result = getClaudeSettings();
      expect(result.mcpServers).toEqual({});
    });
  });

  // ── 边界情况 ──

  describe('edge cases', () => {
    it('should handle empty settings files', () => {
      writeSettings(join(tmpDir, '.claude', 'settings.json'), {});

      const result = loadClaudeSettings();
      expect(result.mcpServers).toEqual({});
      expect(result.disallowedTools).toEqual([]);
    });

    it('should handle settings with only mcpServers', () => {
      writeSettings(join(tmpDir, '.claude', 'settings.json'), {
        mcpServers: { 'solo': { command: 'test' } },
      });

      const result = loadClaudeSettings();
      expect(result.mcpServers['solo']).toBeDefined();
      expect(result.disallowedTools).toEqual([]);
    });

    it('should handle settings with only disallowedTools', () => {
      writeSettings(join(tmpDir, '.claude', 'settings.json'), {
        disallowedTools: ['OnlyTool'],
      });

      const result = loadClaudeSettings();
      expect(result.mcpServers).toEqual({});
      expect(result.disallowedTools).toEqual(['OnlyTool']);
    });

    it('should handle all MCP server types', () => {
      writeSettings(join(tmpDir, '.claude', 'settings.json'), {
        mcpServers: {
          'stdio-server': {
            type: 'stdio',
            command: 'node',
            args: ['server.js'],
            env: { NODE_ENV: 'production' },
          },
          'sse-server': {
            type: 'sse',
            url: 'http://localhost:3000/sse',
            headers: { Authorization: 'Bearer token' },
          },
          'http-server': {
            type: 'http',
            url: 'http://localhost:4000/api',
          },
        },
      });

      const result = loadClaudeSettings();
      expect(Object.keys(result.mcpServers)).toHaveLength(3);
      expect(result.mcpServers['stdio-server'].type).toBe('stdio');
      expect(result.mcpServers['stdio-server'].args).toEqual(['server.js']);
      expect(result.mcpServers['sse-server'].type).toBe('sse');
      expect(result.mcpServers['sse-server'].headers?.Authorization).toBe('Bearer token');
      expect(result.mcpServers['http-server'].type).toBe('http');
    });
  });
});
