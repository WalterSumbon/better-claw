import { AsyncLocalStorage } from 'node:async_hooks';
import type { SendFileOptions } from '../adapter/interface.js';

/** sendFile 回调类型。 */
export type SendFileCallback = (filePath: string, options?: SendFileOptions) => Promise<void>;

/** notifyUser 回调类型。 */
export type NotifyUserCallback = (text: string) => Promise<void>;

/** Agent 执行期间的用户上下文。 */
export interface AgentContextStore {
  /** 当前用户 ID。 */
  userId: string;
  /** 向用户发送文件的回调（在消息处理期间可用）。 */
  sendFile?: SendFileCallback;
  /** 向用户发送通知文本的回调（返回 Promise 以支持 await）。 */
  notifyUser?: NotifyUserCallback;
}

/**
 * AsyncLocalStorage 实例，用于在 MCP 工具 handler 中获取当前用户 ID。
 * 在调用 query() 前通过 agentContext.run({ userId }, callback) 设置。
 */
export const agentContext = new AsyncLocalStorage<AgentContextStore>();

/**
 * Per-user 回调 fallback map。
 *
 * SDK 分发 MCP tool call 时 AsyncLocalStorage 上下文可能断裂，
 * 导致 store?.sendFile / store?.notifyUser 为 undefined。
 * 这些 map 在 agentContext.run() 前设置、结束后清理，
 * 作为 AsyncLocalStorage 的 fallback 保证回调始终可达。
 */
const activeSendFile = new Map<string, SendFileCallback>();
const activeNotifyUser = new Map<string, NotifyUserCallback>();

/**
 * 注册当前用户的 sendFile / notifyUser 回调到 fallback map。
 * 在 agentContext.run() 之前调用。
 */
export function setActiveCallbacks(
  userId: string,
  sendFile?: SendFileCallback,
  notifyUser?: NotifyUserCallback,
): void {
  if (sendFile) activeSendFile.set(userId, sendFile);
  if (notifyUser) activeNotifyUser.set(userId, notifyUser);
}

/**
 * 清理当前用户的 fallback 回调。
 * 在 agentContext.run() 结束后调用。
 */
export function clearActiveCallbacks(userId: string): void {
  activeSendFile.delete(userId);
  activeNotifyUser.delete(userId);
}

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

/**
 * 解析 sendFile 回调：优先从 AsyncLocalStorage 读取，fallback 到 per-user map。
 *
 * @param fallbackUserId - 工厂函数创建时捕获的用户 ID。
 * @returns sendFile 回调，若无可用回调返回 undefined。
 */
export function resolveSendFile(fallbackUserId: string): SendFileCallback | undefined {
  return agentContext.getStore()?.sendFile ?? activeSendFile.get(fallbackUserId);
}

/**
 * 解析 notifyUser 回调：优先从 AsyncLocalStorage 读取，fallback 到 per-user map。
 *
 * @param fallbackUserId - 工厂函数创建时捕获的用户 ID。
 * @returns notifyUser 回调，若无可用回调返回 undefined。
 */
export function resolveNotifyUser(fallbackUserId: string): NotifyUserCallback | undefined {
  return agentContext.getStore()?.notifyUser ?? activeNotifyUser.get(fallbackUserId);
}
