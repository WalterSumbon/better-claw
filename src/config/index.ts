import { readFileSync } from 'fs';
import { resolve } from 'path';
import { parse as parseYaml } from 'yaml';
import { AppConfigSchema, type AppConfig } from './schema.js';

let cachedConfig: AppConfig | null = null;

/**
 * 加载并校验配置文件。
 *
 * @param configPath - 配置文件路径，默认为 data/config.yaml。
 * @returns 类型安全的配置对象。
 * @throws 配置文件不存在或校验失败时抛出错误。
 */
export function loadConfig(configPath?: string): AppConfig {
  if (cachedConfig) {
    return cachedConfig;
  }

  const filePath = configPath ?? resolve(process.cwd(), 'data', 'config.yaml');
  const raw = readFileSync(filePath, 'utf-8');
  const parsed = parseYaml(raw) ?? {};
  cachedConfig = AppConfigSchema.parse(parsed);
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
