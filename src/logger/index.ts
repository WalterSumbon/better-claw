import { mkdirSync } from 'fs';
import pino from 'pino';
import pinoPretty from 'pino-pretty';
import type { AppConfig } from '../config/schema.js';

let logger: pino.Logger | null = null;

/**
 * 创建应用日志实例。
 *
 * 控制台输出使用同步 pino-pretty（避免 worker 线程启动延迟），
 * 文件日志使用 pino-roll worker 线程异步写入。
 *
 * @param config - 日志配置。
 * @returns 配置好的 pino logger。
 */
export function createLogger(config: AppConfig['logging']): pino.Logger {
  mkdirSync(config.directory, { recursive: true });

  // 同步 pretty 输出到 stdout，避免 worker 线程启动延迟。
  const prettyStream = pinoPretty({ destination: 1 });

  // 文件日志仍使用 pino-roll worker 线程。
  const fileTransport = pino.transport({
    target: 'pino-roll',
    level: config.level,
    options: {
      file: `${config.directory}/app`,
      size: config.maxSize,
      limit: { count: config.maxFiles },
    },
  });

  const multistream = pino.multistream([
    { level: config.level as pino.Level, stream: prettyStream },
    { level: config.level as pino.Level, stream: fileTransport },
  ]);

  logger = pino({ level: config.level }, multistream);

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
