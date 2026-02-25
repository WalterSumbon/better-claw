import { mkdirSync } from 'fs';
import pino from 'pino';
import type { AppConfig } from '../config/schema.js';

let logger: pino.Logger | null = null;

/**
 * 创建应用日志实例。
 *
 * @param config - 日志配置。
 * @returns 配置好的 pino logger。
 */
export function createLogger(config: AppConfig['logging']): pino.Logger {
  mkdirSync(config.directory, { recursive: true });

  logger = pino({
    level: config.level,
    transport: {
      targets: [
        {
          target: 'pino-pretty',
          level: config.level,
          options: { destination: 1 },
        },
        {
          target: 'pino-roll',
          level: config.level,
          options: {
            file: `${config.directory}/app`,
            size: config.maxSize,
            limit: { count: config.maxFiles },
          },
        },
      ],
    },
  });

  return logger;
}

/**
 * 获取已创建的 logger。必须先调用 createLogger()。
 *
 * @returns pino Logger 实例。
 * @throws 未调用 createLogger() 时抛出错误。
 */
export function getLogger(): pino.Logger {
  if (!logger) {
    throw new Error('Logger not initialized. Call createLogger() first.');
  }
  return logger;
}
