/**
 * ConfigWatcher — 配置文件变更监控
 *
 * 监控 skill 目录和 per-user MCP 配置文件的变更，
 * 在变更发生时标记对应的 AgentProcess 为 dirty，
 * 触发在下一个合适时机（消息处理完毕或新消息到达时）SDK 重启子进程。
 *
 * 监控范围：
 * - Skill 目录（~/.claude/skills, ./skills 等）→ 重建 skill 索引 + 标记所有进程 dirty
 * - Per-user mcp-servers.json → 标记对应用户进程 dirty
 * - Claude settings 文件（.claude/settings*.json）→ 标记所有进程 dirty
 *
 * 使用 node:fs.watch（macOS 下基于 FSEvents，高效可靠）。
 *
 * @module
 */

import { watch, existsSync, type FSWatcher } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { homedir } from 'node:os';
import { getLogger } from '../logger/index.js';
import { getConfig } from '../config/index.js';
import { getAgentProcess, getAllAgentProcesses } from './agent.js';
import { reloadSkillIndex } from '../skills/scanner.js';
import { reloadClaudeSettings } from '../config/claude-settings.js';

// ---- 内部状态 ----

const watchers: FSWatcher[] = [];
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

// ---- 辅助函数 ----

/**
 * 防抖：同一个 key 的多次触发在 delayMs 内只执行最后一次。
 */
function debounce(key: string, fn: () => void, delayMs = 500): void {
  const existing = debounceTimers.get(key);
  if (existing) clearTimeout(existing);
  debounceTimers.set(key, setTimeout(() => {
    debounceTimers.delete(key);
    fn();
  }, delayMs));
}

/**
 * 标记所有用户的进程为 dirty。
 */
function markAllProcessesDirty(reason: string): void {
  const log = getLogger();
  for (const [userId, proc] of getAllAgentProcesses()) {
    if (proc.isAlive) {
      proc.markDirty(reason);
      log.info({ userId, reason }, 'Process marked dirty by config watcher');
    }
  }
}

/**
 * 解析 skill 路径（展开 ~）。
 * 不展开 ${userDir} 等模板变量（那些是 per-user 的，每个用户解析不同）。
 */
function resolveWatchPath(p: string): string | null {
  if (p.includes('${')) return null; // 模板路径，跳过
  return p.replace(/^~(?=\/|$)/, homedir());
}

/**
 * 安全创建 watcher。如果路径不存在或 watch 失败，静默忽略。
 */
function safeWatch(
  path: string,
  options: { recursive?: boolean },
  callback: (eventType: string, filename: string | null) => void,
): FSWatcher | null {
  if (!existsSync(path)) return null;

  try {
    const watcher = watch(path, options, callback);
    watcher.on('error', (err) => {
      const log = getLogger();
      log.warn({ path, err: err.message }, 'File watcher error, continuing');
    });
    return watcher;
  } catch (err) {
    const log = getLogger();
    log.debug({ path, err }, 'Failed to create file watcher, skipping');
    return null;
  }
}

// ---- 公开 API ----

/**
 * 启动配置文件监控。
 *
 * 在 app 启动时调用一次。监控以下路径：
 * - Skill 目录（全局路径，非模板路径）
 * - 用户数据目录（per-user mcp-servers.json）
 * - Claude settings 目录（.claude/settings*.json）
 */
export function startConfigWatcher(): void {
  const log = getLogger();
  const config = getConfig();

  // ── 1. 监控 Skill 目录 ──
  // 全局 skill 路径（排除 ${userDir} 模板路径）。
  for (const rawPath of config.skills.paths) {
    const resolved = resolveWatchPath(rawPath);
    if (!resolved) continue;

    const watcher = safeWatch(resolved, { recursive: true }, (_eventType, filename) => {
      // 只关注 .md 文件变更（SKILL.md / SKILLSET.md / 内容文件）。
      if (filename && !filename.endsWith('.md')) return;

      debounce(`skill:${resolved}`, () => {
        log.info({ path: resolved, filename }, 'Skill directory changed, rebuilding index');
        reloadSkillIndex(config.skills.paths);
        markAllProcessesDirty('skill directory changed');
      });
    });

    if (watcher) {
      watchers.push(watcher);
      log.info({ path: resolved }, 'Watching skill directory');
    }
  }

  // ── 2. 监控 Per-user MCP 配置 ──
  // 监控 <dataDir>/users/ 目录（递归），过滤 mcp-servers.json 变更。
  const usersDir = join(config.dataDir, 'users');
  if (existsSync(usersDir)) {
    const watcher = safeWatch(usersDir, { recursive: true }, (_eventType, filename) => {
      if (!filename) return;
      // filename 是相对于 usersDir 的路径，格式如 "userId/mcp-servers.json"
      if (!filename.endsWith('mcp-servers.json')) return;

      // 从路径中提取 userId。
      const parts = filename.split('/');
      if (parts.length < 2) return;
      const userId = parts[0];

      debounce(`mcp:${userId}`, () => {
        log.info({ userId, filename }, 'Per-user MCP config changed');
        const proc = getAgentProcess(userId);
        if (proc?.isAlive) {
          proc.markDirty('per-user MCP config changed');
          log.info({ userId }, 'Process marked dirty for MCP config change');
        }
      });
    });

    if (watcher) {
      watchers.push(watcher);
      log.info({ path: usersDir }, 'Watching users directory for MCP config changes');
    }
  }

  // ── 3. 监控 Claude settings 文件 ──
  // 监控 .claude/ 目录下的 settings 文件。
  const claudeDir = join(process.cwd(), '.claude');
  if (existsSync(claudeDir)) {
    const watcher = safeWatch(claudeDir, { recursive: false }, (_eventType, filename) => {
      if (!filename) return;
      if (!filename.startsWith('settings') || !filename.endsWith('.json')) return;

      debounce('claude-settings', () => {
        log.info({ filename }, 'Claude settings changed, reloading');
        reloadClaudeSettings();
        markAllProcessesDirty('Claude settings changed');
      });
    });

    if (watcher) {
      watchers.push(watcher);
      log.info({ path: claudeDir }, 'Watching Claude settings directory');
    }
  }

  // 也监控 ~/.claude/ 目录（用户级 settings）。
  const homeClaudeDir = join(homedir(), '.claude');
  if (existsSync(homeClaudeDir) && homeClaudeDir !== claudeDir) {
    const watcher = safeWatch(homeClaudeDir, { recursive: false }, (_eventType, filename) => {
      if (!filename) return;
      if (!filename.startsWith('settings') || !filename.endsWith('.json')) return;

      debounce('home-claude-settings', () => {
        log.info({ filename }, 'Home Claude settings changed, reloading');
        reloadClaudeSettings();
        markAllProcessesDirty('Home Claude settings changed');
      });
    });

    if (watcher) {
      watchers.push(watcher);
      log.info({ path: homeClaudeDir }, 'Watching home Claude settings directory');
    }
  }

  log.info({ watcherCount: watchers.length }, 'Config watcher started');
}

/**
 * 停止所有文件监控，清理资源。
 */
export function stopConfigWatcher(): void {
  for (const watcher of watchers) {
    watcher.close();
  }
  watchers.length = 0;

  for (const timer of debounceTimers.values()) {
    clearTimeout(timer);
  }
  debounceTimers.clear();

  const log = getLogger();
  log.info('Config watcher stopped');
}
