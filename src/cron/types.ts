/** 默认时区：Asia/Shanghai（东八区）。 */
export const DEFAULT_TIMEZONE = 'Asia/Shanghai';

/** 定时任务定义。 */
export interface CronTask {
  /** 任务唯一 ID。 */
  id: string;
  /** Cron 表达式（如 "0 9 * * *"）。 */
  schedule: string;
  /** IANA 时区（如 "Asia/Shanghai"）。未设置时使用 DEFAULT_TIMEZONE。 */
  timezone?: string;
  /** 人类可读的任务描述。 */
  description: string;
  /** 触发时提交给 agent 的 prompt。 */
  prompt: string;
  /** 是否启用。 */
  enabled: boolean;
  /** 一次性任务标记。为 true 时执行一次后自动禁用。 */
  once?: boolean;
  /** 创建时间（ISO 8601）。 */
  createdAt: string;
}
