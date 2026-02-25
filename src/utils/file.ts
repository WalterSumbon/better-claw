import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

/**
 * 读取 JSON 文件并解析为指定类型。
 *
 * @param filePath - 文件路径。
 * @returns 解析后的对象，文件不存在时返回 null。
 */
export function readJsonFile<T>(filePath: string): T | null {
  if (!existsSync(filePath)) {
    return null;
  }
  const raw = readFileSync(filePath, 'utf-8');
  return JSON.parse(raw) as T;
}

/**
 * 将对象写入 JSON 文件，自动创建目录。
 *
 * @param filePath - 文件路径。
 * @param data - 要写入的对象。
 */
export function writeJsonFile<T>(filePath: string, data: T): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * 确保目录存在，不存在则递归创建。
 *
 * @param dirPath - 目录路径。
 */
export function ensureDir(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true });
}
