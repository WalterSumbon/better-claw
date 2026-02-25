import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { resetConfig, setConfig } from '../../src/config/index.js';
import { AppConfigSchema } from '../../src/config/schema.js';
import { createLogger } from '../../src/logger/index.js';
import { loadBindingCache } from '../../src/user/manager.js';

/**
 * 创建隔离的测试环境，使用临时目录作为 dataDir。
 *
 * @returns 包含临时目录路径和清理函数的对象。
 */
export function createTestEnv(): { dataDir: string; cleanup: () => void } {
  const dataDir = mkdtempSync(join(tmpdir(), 'better-claw-test-'));

  // 创建必要的子目录。
  mkdirSync(join(dataDir, 'users'), { recursive: true });
  mkdirSync(join(dataDir, 'logs'), { recursive: true });

  // 写入最小配置文件。
  writeFileSync(join(dataDir, 'config.yaml'), '# test config\n', 'utf-8');

  // 重置并设置使用临时目录的配置。
  resetConfig();
  const config = AppConfigSchema.parse({
    dataDir,
    logging: { directory: join(dataDir, 'logs') },
  });
  setConfig(config);

  // 初始化日志和绑定缓存。
  createLogger(config.logging);
  loadBindingCache();

  return {
    dataDir,
    cleanup: () => {
      rmSync(dataDir, { recursive: true, force: true });
      resetConfig();
    },
  };
}
