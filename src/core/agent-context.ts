import { AsyncLocalStorage } from 'node:async_hooks';
import type { SendFileOptions } from '../adapter/interface.js';

/** Agent 执行期间的用户上下文。 */
export interface AgentContextStore {
  /** 当前用户 ID。 */
  userId: string;
  /** 向用户发送文件的回调（在消息处理期间可用）。 */
  sendFile?: (filePath: string, options?: SendFileOptions) => Promise<void>;
}

/**
 * AsyncLocalStorage 实例，用于在 MCP 工具 handler 中获取当前用户 ID。
 * 在调用 query() 前通过 agentContext.run({ userId }, callback) 设置。
 */
export const agentContext = new AsyncLocalStorage<AgentContextStore>();
