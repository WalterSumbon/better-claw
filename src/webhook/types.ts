/** Webhook 通知请求参数。 */
export interface WebhookNotifyRequest {
  /** 用户 ID（必填）。 */
  userId: string;

  /** 目标平台（可选，默认最后活跃的平台）。 */
  platform?: string;

  /** 直接发送的消息内容（与 prompt 二选一）。 */
  message?: string;

  /** Agent prompt（可选，如果提供则走 agent 处理）。 */
  prompt?: string;

  /** 附加数据，会注入到 prompt 或作为消息的上下文。 */
  data?: Record<string, unknown>;
}

/** Webhook 通知响应。 */
export interface WebhookNotifyResponse {
  success: boolean;
  error?: string;
}

/** Webhook 处理器接口。 */
export interface WebhookHandler {
  /**
   * 处理通知请求。
   *
   * @param req - 通知请求参数。
   */
  notify(req: WebhookNotifyRequest): Promise<void>;
}
