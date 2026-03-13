/**
 * AgentProcess — SDK 子进程生命周期管理
 *
 * 封装 Claude Agent SDK 的 streaming input mode，实现持久化子进程复用。
 * 每个用户一个 AgentProcess 实例，子进程在多次消息间保持活跃，
 * 避免每条消息都冷启动（节省 ~16-18s）。
 *
 * 核心能力：
 * - 通过 AsyncIterable<SDKUserMessage> 维持子进程常驻
 * - 三态 SDK 重启标志（clean / dirty / restarting）实现按需 SDK 重启
 * - MCP 配置变更通过 setMcpServers() 热更新，无需 SDK 重启
 * - Skill / system prompt 变更标记 dirty，在消息间隙 SDK 重启
 *
 * SDK 重启时机（两级触发）：
 * 1. 主时机：当前消息处理完毕后（隐藏延迟）
 * 2. 兜底时机：新消息到达时（防止主时机因 interrupt 等未执行）
 *
 * @module
 */

import {
  query,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { getLogger } from '../logger/index.js';

// ---- 类型定义 ----

/** 子进程 SDK 重启状态。 */
export type SdkRestartState = 'clean' | 'dirty' | 'restarting';

/** query() 的 options 类型（从 SDK 推导）。 */
export type QueryOptions = NonNullable<Parameters<typeof query>[0]['options']>;

// ---- Input Channel ----

/** 创建一个基于队列的异步可迭代通道，用于向 SDK 子进程推送用户消息。 */
interface InputChannel<T> {
  /** 异步可迭代对象，传给 query() 的 prompt 参数。 */
  iterable: AsyncIterable<T>;
  /** 推送一条消息到通道。 */
  push: (value: T) => void;
  /** 关闭通道（通知消费端迭代结束）。 */
  end: () => void;
}

export function createInputChannel<T>(): InputChannel<T> {
  const queue: T[] = [];
  let waitingResolve: ((result: IteratorResult<T>) => void) | null = null;
  let done = false;

  const iterable: AsyncIterable<T> = {
    [Symbol.asyncIterator]: () => ({
      next(): Promise<IteratorResult<T>> {
        // 队列中有值，立即返回。
        if (queue.length > 0) {
          return Promise.resolve({ value: queue.shift()!, done: false });
        }
        // 通道已关闭。
        if (done) {
          return Promise.resolve({ value: undefined as unknown as T, done: true });
        }
        // 等待下一次 push。
        return new Promise<IteratorResult<T>>((resolve) => {
          waitingResolve = resolve;
        });
      },
      return(): Promise<IteratorResult<T>> {
        done = true;
        return Promise.resolve({ value: undefined as unknown as T, done: true });
      },
    }),
  };

  return {
    iterable,
    push(value: T): void {
      if (done) return;
      if (waitingResolve) {
        const resolve = waitingResolve;
        waitingResolve = null;
        resolve({ value, done: false });
      } else {
        queue.push(value);
      }
    },
    end(): void {
      done = true;
      if (waitingResolve) {
        const resolve = waitingResolve;
        waitingResolve = null;
        resolve({ value: undefined as unknown as T, done: true });
      }
    },
  };
}

// ---- AgentProcess ----

/**
 * 持久化 SDK 子进程。
 *
 * 通过 streaming input mode 保持子进程常驻，支持：
 * - 多轮消息复用（pushMessage → readUntilResult）
 * - MCP 热更新（setMcpServers）
 * - 按需 SDK 重启（markDirty → sdkRestart）
 */
export class AgentProcess {
  private _query: Query | null = null;
  private inputChannel: InputChannel<SDKUserMessage> | null = null;
  private _sdkSessionId: string | null = null;
  private _sdkRestartState: SdkRestartState = 'clean';
  private _sdkRestartPromise: Promise<void> | null = null;
  private _startOptions: QueryOptions | null = null;

  constructor(private userId: string) {}

  // ---- 公开属性 ----

  get sdkSessionId(): string | null {
    return this._sdkSessionId;
  }

  set sdkSessionId(id: string | null) {
    this._sdkSessionId = id;
  }

  get isAlive(): boolean {
    return this._query !== null;
  }

  get sdkRestartState(): SdkRestartState {
    return this._sdkRestartState;
  }

  get queryInstance(): Query | null {
    return this._query;
  }

  // ---- 生命周期 ----

  /**
   * 启动子进程。
   *
   * @param options - 传给 SDK query() 的选项（system prompt、MCP servers 等）。
   */
  start(options: QueryOptions): void {
    const log = getLogger();

    if (this._query) {
      log.warn({ userId: this.userId }, 'AgentProcess.start() called while already alive, closing first');
      this.close();
    }

    this.inputChannel = createInputChannel<SDKUserMessage>();
    this._startOptions = options;
    this._query = query({ prompt: this.inputChannel.iterable, options });
    this._sdkRestartState = 'clean';

    log.info({ userId: this.userId }, 'AgentProcess started (streaming input mode)');
  }

  /**
   * 推送一条用户消息到子进程。
   *
   * @param content - 消息文本内容。
   * @throws 子进程未启动时抛出错误。
   */
  pushMessage(content: string): void {
    if (!this.inputChannel || !this._query) {
      throw new Error('AgentProcess not started — call start() first');
    }

    const userMsg: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: this._sdkSessionId ?? '',
    };

    this.inputChannel.push(userMsg);
  }

  /**
   * 从子进程读取下一条 SDK 消息。
   *
   * 不使用 for-await（会在 break 时关闭 generator），
   * 而是手动调用 .next() 保持 generator 活跃。
   *
   * @returns SDK 消息，或 null（子进程已终止）。
   */
  async nextMessage(): Promise<SDKMessage | null> {
    if (!this._query) return null;

    try {
      const { value, done } = await this._query.next();
      if (done) {
        // 子进程退出（crash 或正常结束）。
        this.handleProcessExit();
        return null;
      }
      return value;
    } catch (err) {
      // 子进程异常退出。
      const log = getLogger();
      log.error({ userId: this.userId, err }, 'AgentProcess.nextMessage() error');
      this.handleProcessExit();
      throw err;
    }
  }

  /**
   * 中断当前正在执行的 turn。
   * 子进程本身保持活跃，只是当前 turn 被打断。
   */
  async interrupt(): Promise<void> {
    if (this._query) {
      await this._query.interrupt();
    }
  }

  /**
   * 关闭子进程，释放所有资源。
   */
  close(): void {
    if (this._query) {
      this.inputChannel?.end();
      this._query.close();
      this._query = null;
      this.inputChannel = null;

      const log = getLogger();
      log.info({ userId: this.userId }, 'AgentProcess closed');
    }
  }

  // ---- MCP 热更新（无需 SDK 重启） ----

  /**
   * 动态更新 MCP servers 配置。
   *
   * 通过 SDK 的 setMcpServers() 实现运行时热更新，
   * 不需要重启子进程。
   *
   * @param servers - 新的 MCP server 配置。
   * @returns 更新结果（added / removed / errors），或 null（子进程未启动）。
   */
  async setMcpServers(servers: Record<string, McpServerConfig>): Promise<{
    added: string[];
    removed: string[];
    errors: Record<string, string>;
  } | null> {
    if (!this._query) return null;

    const log = getLogger();
    log.info(
      { userId: this.userId, serverNames: Object.keys(servers) },
      'Live-updating MCP servers',
    );

    const result = await this._query.setMcpServers(servers);

    log.info(
      { userId: this.userId, added: result.added, removed: result.removed, errors: result.errors },
      'MCP servers updated',
    );

    return result;
  }

  // ---- 三态 SDK 重启管理 ----

  /**
   * 标记需要 SDK 重启（dirty）。
   *
   * 调用后不会立即 SDK 重启，而是在下一个合适的时机（消息处理完毕或新消息到达时）执行。
   *
   * @param reason - 标记 dirty 的原因（用于日志）。
   */
  markDirty(reason: string): void {
    if (this._sdkRestartState === 'clean') {
      this._sdkRestartState = 'dirty';
      const log = getLogger();
      log.info({ userId: this.userId, reason }, 'AgentProcess marked dirty (pending SDK restart)');
    }
  }

  /**
   * 执行 SDK 重启。
   *
   * 关闭当前子进程，用新的 options 启动新子进程。
   * 如果有 SDK session ID，会自动设置 resume 以恢复上下文。
   *
   * @param options - 新的 query options。
   */
  async sdkRestart(options: QueryOptions): Promise<void> {
    const log = getLogger();

    // 如果已经在 SDK 重启中，等待完成即可。
    // 注意：只检查 _sdkRestartPromise，不检查 _sdkRestartState。
    // 因为 doSdkRestart() 内部的 start() 会同步把 state 设为 clean，
    // 但 _sdkRestartPromise 直到 finally 才清除，能正确拦截并发调用。
    if (this._sdkRestartPromise) {
      log.debug({ userId: this.userId }, 'SDK restart already in progress, waiting');
      await this._sdkRestartPromise;
      return;
    }

    this._sdkRestartState = 'restarting';
    log.info({ userId: this.userId }, 'AgentProcess SDK restarting');

    this._sdkRestartPromise = this.doSdkRestart(options);

    try {
      await this._sdkRestartPromise;
    } finally {
      this._sdkRestartPromise = null;
      this._sdkRestartState = 'clean';
    }
  }

  /**
   * 等待正在进行的 SDK 重启完成。
   *
   * 兜底时点调用：如果状态是 restarting，等待即可，不重复触发。
   */
  async waitForSdkRestart(): Promise<void> {
    if (this._sdkRestartPromise) {
      await this._sdkRestartPromise;
    }
  }

  /**
   * 确保子进程就绪。
   *
   * 新消息到达时调用（兜底时点）：
   * - clean + alive → 直接返回
   * - dirty → 执行 SDK 重启
   * - restarting → 等待 SDK 重启完成
   * - not alive → 需要外部启动
   *
   * @param buildOptions - 构建 query options 的工厂函数（仅在需要 SDK 重启时调用）。
   * @returns 是否执行了 SDK 重启。
   */
  async ensureSdkReady(buildOptions: () => QueryOptions): Promise<boolean> {
    if (this._sdkRestartState === 'restarting') {
      await this.waitForSdkRestart();
      return true;
    }

    if (this._sdkRestartState === 'dirty') {
      await this.sdkRestart(buildOptions());
      return true;
    }

    return false;
  }

  // ---- 内部方法 ----

  private async doSdkRestart(options: QueryOptions): Promise<void> {
    this.close();
    // start() 内部会重置 _sdkRestartState 为 clean。
    // 但我们在外层 finally 中也会设置，所以这里让 start() 先设置。
    this.start(options);
  }

  private handleProcessExit(): void {
    const log = getLogger();
    log.warn({ userId: this.userId }, 'AgentProcess subprocess exited');
    this._query = null;
    this.inputChannel = null;
  }
}
