import { join } from 'path';
import { getUserDir } from '../user/store.js';
import { readJsonFile, writeJsonFile } from '../utils/file.js';
import type { CronTask } from './types.js';

/**
 * 获取用户 crons.json 文件路径。
 *
 * @param userId - 用户 ID。
 * @returns 文件路径。
 */
function cronsPath(userId: string): string {
  return join(getUserDir(userId), 'crons.json');
}

/**
 * 读取用户的所有定时任务。
 *
 * @param userId - 用户 ID。
 * @returns 定时任务数组。
 */
export function readCronTasks(userId: string): CronTask[] {
  return readJsonFile<CronTask[]>(cronsPath(userId)) ?? [];
}

/**
 * 写入用户的所有定时任务。
 *
 * @param userId - 用户 ID。
 * @param tasks - 定时任务数组。
 */
export function writeCronTasks(userId: string, tasks: CronTask[]): void {
  writeJsonFile(cronsPath(userId), tasks);
}
