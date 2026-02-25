import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createUser } from '../../src/user/manager.js';
import {
  initScheduler,
  createCronTask,
  listCronTasks,
  updateCronTask,
  deleteCronTask,
  stopAllJobs,
} from '../../src/cron/scheduler.js';
import { createTestEnv } from '../helpers/setup.js';

/**
 * 定时任务调度器单元测试。
 *
 * 测试 CRUD 操作和调度逻辑。
 * 使用临时目录隔离测试数据。
 */
describe('Cron Scheduler', () => {
  let testUserId: string;
  let cleanup: () => void;

  beforeEach(() => {
    stopAllJobs();
    const env = createTestEnv();
    cleanup = env.cleanup;

    const user = createUser('cron-test');
    testUserId = user.userId;

    // 初始化调度器（空的 handler）。
    initScheduler(() => {});
  });

  afterEach(() => {
    stopAllJobs();
    cleanup();
  });

  it('should create a cron task with valid expression', () => {
    const task = createCronTask(testUserId, '0 9 * * *', 'Daily reminder', 'Remind me to exercise');
    expect(task).not.toBeNull();
    expect(task!.id).toMatch(/^cron_/);
    expect(task!.schedule).toBe('0 9 * * *');
    expect(task!.description).toBe('Daily reminder');
    expect(task!.prompt).toBe('Remind me to exercise');
    expect(task!.enabled).toBe(true);
  });

  it('should reject invalid cron expression', () => {
    const task = createCronTask(testUserId, 'not a cron', 'Bad task', 'prompt');
    expect(task).toBeNull();
  });

  it('should list created tasks', () => {
    createCronTask(testUserId, '0 9 * * *', 'Task 1', 'prompt 1');
    createCronTask(testUserId, '0 18 * * *', 'Task 2', 'prompt 2');

    const tasks = listCronTasks(testUserId);
    expect(tasks.length).toBe(2);
    expect(tasks[0].description).toBe('Task 1');
    expect(tasks[1].description).toBe('Task 2');
  });

  it('should update a task', () => {
    const task = createCronTask(testUserId, '0 9 * * *', 'Original', 'original prompt')!;
    const updated = updateCronTask(testUserId, task.id, {
      description: 'Updated',
      enabled: false,
    });

    expect(updated).not.toBeNull();
    expect(updated!.description).toBe('Updated');
    expect(updated!.enabled).toBe(false);
    expect(updated!.schedule).toBe('0 9 * * *');
  });

  it('should reject update with invalid cron expression', () => {
    const task = createCronTask(testUserId, '0 9 * * *', 'Task', 'prompt')!;
    const updated = updateCronTask(testUserId, task.id, { schedule: 'invalid' });
    expect(updated).toBeNull();
  });

  it('should return null when updating non-existent task', () => {
    const updated = updateCronTask(testUserId, 'cron_nonexistent', { description: 'nope' });
    expect(updated).toBeNull();
  });

  it('should delete a task', () => {
    const task = createCronTask(testUserId, '0 9 * * *', 'To delete', 'prompt')!;
    const deleted = deleteCronTask(testUserId, task.id);
    expect(deleted).toBe(true);

    const tasks = listCronTasks(testUserId);
    expect(tasks.find((t) => t.id === task.id)).toBeUndefined();
  });

  it('should return false when deleting non-existent task', () => {
    const deleted = deleteCronTask(testUserId, 'cron_nonexistent');
    expect(deleted).toBe(false);
  });

  it('should return empty list for user with no tasks', () => {
    const tasks = listCronTasks(testUserId);
    expect(tasks).toEqual([]);
  });
});
