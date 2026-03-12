/**
 * EventBus — 核心事件分发器
 *
 * 纯同步 fire-and-forget 分发，零业务逻辑。
 * listener 异常不会阻塞其他 listener（try-catch 吞掉并 log）。
 *
 * API:
 *   on(event, fn)   → unsubscribe
 *   once(event, fn) → unsubscribe
 *   onAny(fn)       → unsubscribe
 *   emit(event, payload)
 */

import { getLogger } from '../logger/index.js';

// ---- Payload 类型定义 ----

export interface FileAttachment {
  type: 'image' | 'audio' | 'document' | 'video';
  path?: string;
  url?: string;
  mimeType?: string;
  filename?: string;
}

export interface MsgInPayload {
  userId: string;
  source: string;
  text?: string;
  files?: FileAttachment[];
}

export interface MsgOutPayload {
  userId: string;
  target: string;
  text?: string;
  files?: FileAttachment[];
  streaming?: boolean;
  final?: boolean;
}

export interface AgentStatePayload {
  userId: string;
  target?: string;
}

export interface EventMap {
  'msg:in': MsgInPayload;
  'msg:out': MsgOutPayload;
  'agent:busy': AgentStatePayload;
  'agent:idle': AgentStatePayload;
}

// ---- 内部类型 ----

type EventName = keyof EventMap;
type Listener<K extends EventName> = (payload: EventMap[K]) => void;
type AnyListener = (event: string, payload: unknown) => void;

// ---- EventBus 实现 ----

export class EventBus {
  private listeners = new Map<EventName, Set<Listener<any>>>();
  private anyListeners = new Set<AnyListener>();

  /**
   * 注册事件监听器。
   * @returns unsubscribe 函数
   */
  on<K extends EventName>(event: K, fn: Listener<K>): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(fn);
    return () => {
      this.listeners.get(event)?.delete(fn);
    };
  }

  /**
   * 注册一次性事件监听器，触发一次后自动取消。
   * @returns unsubscribe 函数（也可手动提前取消）
   */
  once<K extends EventName>(event: K, fn: Listener<K>): () => void {
    const wrapper: Listener<K> = (payload) => {
      unsub();
      fn(payload);
    };
    const unsub = this.on(event, wrapper);
    return unsub;
  }

  /**
   * 监听所有事件（用于 log listener 等）。
   * @returns unsubscribe 函数
   */
  onAny(fn: AnyListener): () => void {
    this.anyListeners.add(fn);
    return () => {
      this.anyListeners.delete(fn);
    };
  }

  /**
   * 触发事件。同步分发给所有 listener，fire-and-forget。
   * listener 抛异常会被 catch 并 log，不影响其他 listener。
   */
  emit<K extends EventName>(event: K, payload: EventMap[K]): void {
    // 先通知 any listeners
    for (const fn of this.anyListeners) {
      try {
        fn(event, payload);
      } catch (err) {
        this.logListenerError('onAny', event, err);
      }
    }

    // 再通知具体 listeners
    const set = this.listeners.get(event);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(payload);
      } catch (err) {
        this.logListenerError('on', event, err);
      }
    }
  }

  private logListenerError(listenerType: string, event: string, err: unknown): void {
    try {
      const log = getLogger();
      log.error({ err, event, listenerType }, '[EventBus] listener threw an error');
    } catch {
      // logger 还没初始化时 fallback 到 console
      console.error(`[EventBus] ${listenerType} listener for "${event}" threw:`, err);
    }
  }
}
