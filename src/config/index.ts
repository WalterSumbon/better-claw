import { readFileSync, writeFileSync } from 'fs';
import { isAbsolute, resolve } from 'path';
import { parse as parseYaml, parseDocument } from 'yaml';
import { AppConfigSchema, type AppConfig } from './schema.js';

/** 工作组配置类型。 */
export interface WorkGroupConfig {
  members: Record<string, 'r' | 'rw'>;
}

let cachedConfig: AppConfig | null = null;
let configFilePath: string | null = null;

/** loadConfig 选项。 */
export interface LoadConfigOptions {
  /** 配置文件路径，默认为 <dataDir>/config.yaml。 */
  configPath?: string;
  /** CLI 指定的数据目录，优先于 yaml 中的 dataDir 字段。 */
  dataDir?: string;
}

/**
 * 加载并校验配置文件。
 *
 * @param options - 加载选项。
 * @returns 类型安全的配置对象。
 * @throws 配置文件不存在或校验失败时抛出错误。
 */
export function loadConfig(options?: LoadConfigOptions): AppConfig {
  if (cachedConfig) {
    return cachedConfig;
  }

  const cliDataDir = options?.dataDir;

  // 确定配置文件路径：显式指定 > <dataDir>/config.yaml > data/config.yaml。
  const filePath = options?.configPath
    ?? resolve(process.cwd(), cliDataDir ?? 'data', 'config.yaml');

  configFilePath = filePath;
  const raw = readFileSync(filePath, 'utf-8');
  const parsed = parseYaml(raw) ?? {};
  cachedConfig = AppConfigSchema.parse(parsed);

  // CLI --data-dir 强制覆盖 yaml 中的 dataDir。
  if (cliDataDir) {
    cachedConfig.dataDir = cliDataDir;
  }

  // 将相对路径的 logging.directory 基于 dataDir 解析为绝对路径。
  if (!isAbsolute(cachedConfig.logging.directory)) {
    cachedConfig.logging.directory = resolve(
      process.cwd(),
      cachedConfig.dataDir,
      cachedConfig.logging.directory,
    );
  }

  return cachedConfig;
}

/**
 * 获取已加载的配置。必须先调用 loadConfig()。
 *
 * @returns 配置对象。
 * @throws 未调用 loadConfig() 时抛出错误。
 */
export function getConfig(): AppConfig {
  if (!cachedConfig) {
    throw new Error('Config not loaded. Call loadConfig() first.');
  }
  return cachedConfig;
}

/** 可热重载的配置字段列表。 */
const HOT_RELOADABLE_KEYS = [
  'anthropic',
  'permissions',
  'session',
  'restart',
  'messagePush',
  'speechToText',
  'permissionMode',
] as const;

/** 不可热重载的配置字段列表（需要重启）。 */
const NON_RELOADABLE_KEYS = ['telegram', 'dingtalk', 'logging', 'dataDir'] as const;

/** reloadConfig 返回的结果摘要。 */
export interface ReloadConfigResult {
  /** 已更新的字段列表。 */
  reloaded: string[];
  /** 需要重启才能生效的字段列表（仅当这些字段发生了变化时包含）。 */
  requireRestart: string[];
}

/**
 * 热重载配置文件。重新读取 config.yaml 并更新内存缓存中可热重载的字段。
 * 适配器连接（telegram/dingtalk）和日志配置不会被更新，需要重启。
 *
 * @returns 重载结果摘要。
 * @throws 配置文件未加载或校验失败时抛出错误。
 */
export function reloadConfig(): ReloadConfigResult {
  if (!configFilePath || !cachedConfig) {
    throw new Error('Config not loaded. Call loadConfig() first.');
  }

  const raw = readFileSync(configFilePath, 'utf-8');
  const parsed = parseYaml(raw) ?? {};
  const newConfig = AppConfigSchema.parse(parsed);

  const reloaded: string[] = [];
  const requireRestart: string[] = [];

  // 更新可热重载的字段。
  for (const key of HOT_RELOADABLE_KEYS) {
    const oldVal = JSON.stringify(cachedConfig[key]);
    const newVal = JSON.stringify(newConfig[key]);
    if (oldVal !== newVal) {
      (cachedConfig as Record<string, unknown>)[key] = newConfig[key];
      reloaded.push(key);
    }
  }

  // 检测不可热重载的字段是否有变化。
  for (const key of NON_RELOADABLE_KEYS) {
    const oldVal = JSON.stringify(cachedConfig[key]);
    const newVal = JSON.stringify(newConfig[key]);
    if (oldVal !== newVal) {
      requireRestart.push(key);
    }
  }

  return { reloaded, requireRestart };
}

/**
 * 清除缓存的配置（仅用于测试）。
 */
export function resetConfig(): void {
  cachedConfig = null;
  configFilePath = null;
}

/**
 * 直接设置配置对象（仅用于测试，跳过文件加载）。
 *
 * @param config - 完整的配置对象。
 */
export function setConfig(config: AppConfig): void {
  cachedConfig = config;
}

/**
 * 读取并返回当前 workGroups 配置。
 *
 * @returns 工作组配置映射，未定义时返回空对象。
 */
export function getWorkGroups(): Record<string, WorkGroupConfig> {
  const config = getConfig();
  return (config.permissions.workGroups ?? {}) as Record<string, WorkGroupConfig>;
}

/**
 * 更新 workGroups 配置并持久化到 config.yaml。
 * 使用 parseDocument 保留原文件的注释和格式。
 *
 * @param workGroups - 新的工作组配置映射。
 * @throws 配置文件路径未知时抛出错误。
 */
export function updateWorkGroups(workGroups: Record<string, WorkGroupConfig>): void {
  if (!configFilePath) {
    throw new Error('Config file path unknown. Call loadConfig() first.');
  }

  // 更新内存缓存。
  const config = getConfig();
  config.permissions.workGroups = Object.keys(workGroups).length > 0 ? workGroups : undefined;

  // 使用 parseDocument 解析原文件以保留注释。
  const raw = readFileSync(configFilePath, 'utf-8');
  const doc = parseDocument(raw);

  // 设置 permissions.workGroups 节点。
  if (Object.keys(workGroups).length > 0) {
    doc.setIn(['permissions', 'workGroups'], workGroups);
  } else {
    doc.deleteIn(['permissions', 'workGroups']);
  }

  writeFileSync(configFilePath, doc.toString(), 'utf-8');
}
