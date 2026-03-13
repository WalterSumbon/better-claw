import { AsyncLocalStorage } from 'node:async_hooks';
import type { SendFileOptions } from '../adapter/interface.js';

/** Agent 执行期间的用户上下文。 */
export interface AgentContextStore {
  /** 当前用户 ID。 */
  userId: string;
  /** 向用户发送文件的回调（在消息处理期间可用）。 */
  sendFile?: (filePath: string, options?: SendFileOptions) => Promise<void>;
  /** 向用户发送通知文本的回调（返回 Promise 以支持 await）。 */
  notifyUser?: (text: string) => Promise<void>;
}

/**
 * AsyncLocalStorage 实例，用于在 MCP 工具 handler 中获取当前用户 ID。
 * 在调用 query() 前通过 agentContext.run({ userId }, callback) 设置。
 */
export const agentContext = new AsyncLocalStorage<AgentContextStore>();

/**
 * 解析当前用户 ID：优先从 AsyncLocalStorage 读取，fallback 到传入的 userId。
 *
 * 当 SDK 分发 MCP tool call 时，AsyncLocalStorage 上下文可能断裂
 * （SDK 内部事件处理链路不保证 async context 传播），
 * 此时 fallback 到工厂函数传入的 userId。
 *
 * @param fallbackUserId - 工厂函数创建时捕获的用户 ID。
 * @returns 用户 ID。
 */
export function resolveUserId(fallbackUserId: string): string {
  return agentContext.getStore()?.userId ?? fallbackUserId;
}
