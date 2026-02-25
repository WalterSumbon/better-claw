import cron from 'node-cron';
import { getLogger } from '../logger/index.js';
import { readCronTasks, writeCronTasks } from './store.js';
import { generateId } from '../utils/token.js';
import { listUserIds } from '../user/store.js';
import type { CronTask } from './types.js';

/** 回调类型：cron 任务触发时调用。 */
export type CronTriggerHandler = (userId: string, task: CronTask) => void;

/** 活跃的 node-cron 任务实例映射：taskId → ScheduledTask。 */
const activeJobs = new Map<string, cron.ScheduledTask>();

/** 触发回调，由 initScheduler 设置。 */
let triggerHandler: CronTriggerHandler | null = null;

/**
 * 初始化定时任务调度器。
 *
 * 从所有用户的 crons.json 加载已启用的任务并注册到 node-cron。
 *
 * @param handler - 任务触发时的回调。
 */
export function initScheduler(handler: CronTriggerHandler): void {
  const log = getLogger();
  triggerHandler = handler;

  const userIds = listUserIds();
  let totalScheduled = 0;

  for (const userId of userIds) {
    const tasks = readCronTasks(userId);
    for (const task of tasks) {
      if (task.enabled) {
        scheduleJob(userId, task);
        totalScheduled++;
      }
    }
  }

  log.info({ totalScheduled }, 'Cron scheduler initialized');
}

/**
 * 注册单个 cron 任务到 node-cron。
 *
 * @param userId - 用户 ID。
 * @param task - 定时任务。
 */
function scheduleJob(userId: string, task: CronTask): void {
  const log = getLogger();

  // 如果已注册，先停止。
  const existing = activeJobs.get(task.id);
  if (existing) {
    existing.stop();
    activeJobs.delete(task.id);
  }

  if (!cron.validate(task.schedule)) {
    log.warn({ taskId: task.id, schedule: task.schedule }, 'Invalid cron expression, skipping');
    return;
  }

  const job = cron.schedule(task.schedule, () => {
    log.info({ userId, taskId: task.id, description: task.description }, 'Cron task triggered');
    if (triggerHandler) {
      triggerHandler(userId, task);
    }
  });

  activeJobs.set(task.id, job);
  log.debug({ taskId: task.id, schedule: task.schedule }, 'Cron job scheduled');
}

/**
 * 取消一个 cron 任务的调度。
 *
 * @param taskId - 任务 ID。
 */
function unscheduleJob(taskId: string): void {
  const existing = activeJobs.get(taskId);
  if (existing) {
    existing.stop();
    activeJobs.delete(taskId);
  }
}

/**
 * 创建定时任务。
 *
 * @param userId - 用户 ID。
 * @param schedule - Cron 表达式。
 * @param description - 人类可读描述。
 * @param prompt - 触发时的 agent prompt。
 * @returns 创建的任务，cron 表达式无效时返回 null。
 */
export function createCronTask(
  userId: string,
  schedule: string,
  description: string,
  prompt: string,
): CronTask | null {
  if (!cron.validate(schedule)) {
    return null;
  }

  const task: CronTask = {
    id: `cron_${generateId()}`,
    schedule,
    description,
    prompt,
    enabled: true,
    createdAt: new Date().toISOString(),
  };

  const tasks = readCronTasks(userId);
  tasks.push(task);
  writeCronTasks(userId, tasks);

  // 立即调度。
  scheduleJob(userId, task);

  return task;
}

/**
 * 列出用户的所有定时任务。
 *
 * @param userId - 用户 ID。
 * @returns 定时任务数组。
 */
export function listCronTasks(userId: string): CronTask[] {
  return readCronTasks(userId);
}

/**
 * 更新定时任务。
 *
 * @param userId - 用户 ID。
 * @param taskId - 任务 ID。
 * @param updates - 要更新的字段。
 * @returns 更新后的任务，不存在时返回 null。
 */
export function updateCronTask(
  userId: string,
  taskId: string,
  updates: Partial<Pick<CronTask, 'schedule' | 'description' | 'prompt' | 'enabled'>>,
): CronTask | null {
  const tasks = readCronTasks(userId);
  const idx = tasks.findIndex((t) => t.id === taskId);
  if (idx === -1) {
    return null;
  }

  const task = tasks[idx];

  // 如果更新了 schedule，验证新表达式。
  if (updates.schedule !== undefined && !cron.validate(updates.schedule)) {
    return null;
  }

  Object.assign(task, updates);
  writeCronTasks(userId, tasks);

  // 重新调度或取消。
  if (task.enabled) {
    scheduleJob(userId, task);
  } else {
    unscheduleJob(task.id);
  }

  return task;
}

/**
 * 删除定时任务。
 *
 * @param userId - 用户 ID。
 * @param taskId - 任务 ID。
 * @returns 是否删除成功。
 */
export function deleteCronTask(userId: string, taskId: string): boolean {
  const tasks = readCronTasks(userId);
  const idx = tasks.findIndex((t) => t.id === taskId);
  if (idx === -1) {
    return false;
  }

  tasks.splice(idx, 1);
  writeCronTasks(userId, tasks);
  unscheduleJob(taskId);

  return true;
}

/**
 * 停止所有活跃的 cron 任务。用于优雅关闭。
 */
export function stopAllJobs(): void {
  for (const [, job] of activeJobs) {
    job.stop();
  }
  activeJobs.clear();
}
