import { readFileSync } from 'fs';
import { isAbsolute, resolve } from 'path';
import { parse as parseYaml } from 'yaml';
import { AppConfigSchema, type AppConfig } from './schema.js';

let cachedConfig: AppConfig | null = null;

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

/**
 * 清除缓存的配置（仅用于测试）。
 */
export function resetConfig(): void {
  cachedConfig = null;
}

/**
 * 直接设置配置对象（仅用于测试，跳过文件加载）。
 *
 * @param config - 完整的配置对象。
 */
export function setConfig(config: AppConfig): void {
  cachedConfig = config;
}
