import { join } from 'path';
import { homedir } from 'os';
import { readJsonFile } from '../utils/file.js';
import { getLogger } from '../logger/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Claude Code settings.json 中与 MCP server 相关的配置。 */
interface ClaudeSettingsMcpServer {
  type?: 'stdio' | 'sse' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

/**
 * Claude Code settings.json 的（部分）结构。
 *
 * 仅声明 Better-Claw 需要继承的字段；其余字段会被忽略。
 */
interface ClaudeSettingsFile {
  mcpServers?: Record<string, ClaudeSettingsMcpServer>;
  disallowedTools?: string[];
  // 以下字段存在但会被过滤，不声明到接口中：
  // model, effortLevel, permissions, output_style, ...
}

/** Better-Claw 从 Claude Code settings 中提取的有效配置。 */
export interface ResolvedClaudeSettings {
  /** 外部 MCP server 配置（已合并三层 settings）。 */
  mcpServers: Record<string, ClaudeSettingsMcpServer>;
  /** 禁用的工具名列表（已去重合并三层 settings）。 */
  disallowedTools: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Settings file paths
// ─────────────────────────────────────────────────────────────────────────────

/** user settings 路径：~/.claude/settings.json */
function getUserSettingsPath(): string {
  return join(homedir(), '.claude', 'settings.json');
}

/** project settings 路径：<cwd>/.claude/settings.json */
function getProjectSettingsPath(): string {
  return join(process.cwd(), '.claude', 'settings.json');
}

/** local settings 路径：<cwd>/.claude/settings.local.json */
function getLocalSettingsPath(): string {
  return join(process.cwd(), '.claude', 'settings.local.json');
}

// ─────────────────────────────────────────────────────────────────────────────
// Core logic
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 从单个 settings 文件中提取需要继承的字段。
 *
 * @param filePath - settings 文件路径。
 * @returns 提取后的有效字段，文件不存在或无有效内容时返回 null。
 */
function extractFromFile(filePath: string): { mcpServers?: Record<string, ClaudeSettingsMcpServer>; disallowedTools?: string[] } | null {
  const raw = readJsonFile<Record<string, unknown>>(filePath);
  if (!raw) return null;

  const result: { mcpServers?: Record<string, ClaudeSettingsMcpServer>; disallowedTools?: string[] } = {};

  // 提取 mcpServers。
  if (raw.mcpServers && typeof raw.mcpServers === 'object' && !Array.isArray(raw.mcpServers)) {
    result.mcpServers = raw.mcpServers as Record<string, ClaudeSettingsMcpServer>;
  }

  // 提取 disallowedTools。
  if (Array.isArray(raw.disallowedTools)) {
    result.disallowedTools = raw.disallowedTools.filter((t): t is string => typeof t === 'string');
  }

  return result;
}

/**
 * 读取三层 Claude Code settings 文件并合并为最终有效配置。
 *
 * 合并优先级：local > project > user（后者覆盖前者）。
 * - mcpServers：同名 server 被高优先级层覆盖。
 * - disallowedTools：所有层的条目去重合并。
 *
 * @returns 合并后的有效配置。
 */
export function loadClaudeSettings(
  excludeLayers?: string[],
): ResolvedClaudeSettings {
  const allLayers = [
    { name: 'user', path: getUserSettingsPath() },
    { name: 'project', path: getProjectSettingsPath() },
    { name: 'local', path: getLocalSettingsPath() },
  ];

  const layers = excludeLayers
    ? allLayers.filter((l) => !excludeLayers.includes(l.name))
    : allLayers;

  const mergedMcpServers: Record<string, ClaudeSettingsMcpServer> = {};
  const mergedDisallowedTools = new Set<string>();

  for (const layer of layers) {
    const extracted = extractFromFile(layer.path);
    if (!extracted) continue;

    // mcpServers：Object.assign 语义，同名 server 被高优先级层覆盖。
    if (extracted.mcpServers) {
      Object.assign(mergedMcpServers, extracted.mcpServers);
    }

    // disallowedTools：累积合并。
    if (extracted.disallowedTools) {
      for (const tool of extracted.disallowedTools) {
        mergedDisallowedTools.add(tool);
      }
    }
  }

  return {
    mcpServers: mergedMcpServers,
    disallowedTools: [...mergedDisallowedTools],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Cache & accessors
// ─────────────────────────────────────────────────────────────────────────────

let cached: ResolvedClaudeSettings | null = null;
let cachedProjectLocal: ResolvedClaudeSettings | null = null;

/**
 * 初始化 Claude settings 缓存。在应用启动时调用。
 *
 * @returns 加载后的有效配置。
 */
export function initClaudeSettings(): ResolvedClaudeSettings {
  cached = loadClaudeSettings();
  cachedProjectLocal = loadClaudeSettings(['user']);

  const log = getLogger();
  const serverCount = Object.keys(cached.mcpServers).length;
  const toolCount = cached.disallowedTools.length;
  if (serverCount > 0 || toolCount > 0) {
    log.info(
      { mcpServers: Object.keys(cached.mcpServers), disallowedTools: cached.disallowedTools },
      `Claude settings loaded: ${serverCount} MCP server(s), ${toolCount} disallowed tool(s)`,
    );
  }

  return cached;
}

/**
 * 获取已缓存的 Claude settings（全部三层合并）。
 *
 * @returns 有效的 Claude settings。
 */
export function getClaudeSettings(): ResolvedClaudeSettings {
  if (!cached) {
    cached = loadClaudeSettings();
  }
  return cached;
}

/**
 * 获取仅 project + local 层的 Claude settings（排除 user 层）。
 *
 * 当 SDK settingSources 包含 'user' 时，使用此函数获取需要显式传入的配置，
 * 避免与 SDK 自动加载的 user settings 重复。
 */
export function getProjectLocalSettings(): ResolvedClaudeSettings {
  if (!cachedProjectLocal) {
    cachedProjectLocal = loadClaudeSettings(['user']);
  }
  return cachedProjectLocal;
}

/**
 * 重新加载 Claude settings 缓存。用于热重载场景。
 *
 * @returns 重新加载后的有效配置。
 */
export function reloadClaudeSettings(): ResolvedClaudeSettings {
  cached = loadClaudeSettings();
  cachedProjectLocal = loadClaudeSettings(['user']);
  return cached;
}

/**
 * 清除缓存（仅用于测试）。
 */
export function resetClaudeSettings(): void {
  cached = null;
  cachedProjectLocal = null;
}
