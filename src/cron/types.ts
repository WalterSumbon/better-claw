/** 定时任务定义。 */
export interface CronTask {
  /** 任务唯一 ID。 */
  id: string;
  /** Cron 表达式（如 "0 9 * * *"）。 */
  schedule: string;
  /** 人类可读的任务描述。 */
  description: string;
  /** 触发时提交给 agent 的 prompt。 */
  prompt: string;
  /** 是否启用。 */
  enabled: boolean;
  /** 创建时间（ISO 8601）。 */
  createdAt: string;
}
