/**
 * BusAgent — EventBus 驱动的 Agent 模块
 *
 * 每个用户一个 BusAgent 实例，内部维护双队列（指令队列 + 普通消息队列），
 * 通过 EventBus 接收入站消息、发送出站回复和状态事件。
 *
 * 普通消息队列支持三种可配置策略：
 * - sequential（默认）：排队依次执行
 * - merge：当前 query 执行中累积的消息在执行完后合并为一条
 * - interrupt：新消息打断当前 query，合并后重新执行
 *
 * @module
 */

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { EventBus, MsgInPayload } from './event-bus.js';
import type { SendFileOptions } from '../adapter/interface.js';
import {
  sendToAgent,
  interruptAgent,
  AgentInterruptedError,
  RateLimitError,
  resetAgentSession,
} from './agent.js';
import { getLogger } from '../logger/index.js';
import { getConfig } from '../config/index.js';
import { readProfile } from '../user/store.js';
import { resolveTimezone, formatLocalTime, getUtcOffset } from '../utils/timezone.js';

// ---- 类型定义 ----

/** 普通消息队列策略。 */
export type QueueStrategy = 'sequential' | 'merge' | 'interrupt';

/**
 * 指令处理器。
 *
 * @param userId - 用户 ID。
 * @param args - 指令参数文本。
 * @param reply - 发送回复的回调（同步调用，内部 emit msg:out）。
 * @param payload - 原始入站消息 payload（可获取 source 等上下文信息）。
 */
export type CommandHandler = (
  userId: string,
  args: string,
  reply: (text: string) => void,
  payload: MsgInPayload,
) => Promise<void>;

/** BusAgent 构造选项。 */
export interface BusAgentOptions {
  /** 指令前缀，默认 "/"。 */
  commandPrefix?: string;
  /** 普通消息队列策略，默认 "sequential"。 */
  queueStrategy?: QueueStrategy;
}

// ---- 内部类型 ----

interface QueuedCommand {
  payload: MsgInPayload;
  name: string;
  args: string;
}

/** Rate limit 时无 resetsAt 信息的默认等待时间（毫秒）。 */
const DEFAULT_RATE_LIMIT_WAIT_MS = 5 * 60 * 1000;

// ---- BusAgent（每用户实例） ----

export class BusAgent {
  private bus: EventBus;
  private userId: string;
  private commandPrefix: string;
  private queueStrategy: QueueStrategy;
  private commandHandlers = new Map<string, CommandHandler>();

  // ---- 双队列 ----
  private messageQueue: MsgInPayload[] = [];
  private commandQueue: QueuedCommand[] = [];
  private processingMessage = false;
  private processingCommand = false;

  /** 当前正在执行的原始 payload（用于 rate limit 重入队，避免双重 envelope）。 */
  private currentPayloads: MsgInPayload[] = [];

  // ---- Rate limit ----
  private pausedUntil: number | null = null;
  private resumeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(userId: string, bus: EventBus, options: BusAgentOptions = {}) {
    this.userId = userId;
    this.bus = bus;
    this.commandPrefix = options.commandPrefix ?? '/';
    this.queueStrategy = options.queueStrategy ?? 'sequential';

    // 注册内建指令。
    this.registerCommand('stop', async (uid, _args, reply, _payload) => {
      await interruptAgent(uid);
      reply('⏹️ Stopped.');
    });

    this.registerCommand('new', async (uid, _args, reply, _payload) => {
      await interruptAgent(uid);
      resetAgentSession(uid);
      reply('🔄 New session created.');
    });
  }

  /**
   * 注册指令处理器。
   *
   * @param name - 指令名（不含前缀）。
   * @param handler - 处理器函数。
   */
  registerCommand(name: string, handler: CommandHandler): void {
    this.commandHandlers.set(name.toLowerCase(), handler);
  }

  /**
   * 处理入站消息。由 BusAgentManager 在收到 msg:in 时调用。
   * 根据内容判断是指令还是普通消息，分发到对应队列。
   */
  handleMessage(payload: MsgInPayload): void {
    const text = payload.text?.trim() ?? '';
    const cmd = this.parseCommand(text);

    if (cmd && this.commandHandlers.has(cmd.name)) {
      // 指令 → 指令队列。
      this.commandQueue.push({ payload, ...cmd });
      this.drainCommandQueue();
    } else {
      // 普通消息 → 普通消息队列。
      this.messageQueue.push(payload);

      if (this.queueStrategy === 'interrupt' && this.processingMessage) {
        // Interrupt 模式：新消息到来时打断当前 query。
        interruptAgent(this.userId).catch(() => {});
      }

      this.drainMessageQueue();
    }
  }

  // ---- 指令解析 ----

  private parseCommand(text: string): { name: string; args: string } | null {
    if (!text.startsWith(this.commandPrefix)) return null;
    const withoutPrefix = text.slice(this.commandPrefix.length);
    const spaceIdx = withoutPrefix.indexOf(' ');
    if (spaceIdx === -1) {
      return { name: withoutPrefix.toLowerCase(), args: '' };
    }
    return {
      name: withoutPrefix.slice(0, spaceIdx).toLowerCase(),
      args: withoutPrefix.slice(spaceIdx + 1).trim(),
    };
  }

  // ---- 指令队列处理 ----

  private async drainCommandQueue(): Promise<void> {
    if (this.processingCommand) return;
    this.processingCommand = true;

    const log = getLogger();

    while (this.commandQueue.length > 0) {
      const cmd = this.commandQueue.shift()!;
      const handler = this.commandHandlers.get(cmd.name);
      if (!handler) continue;

      const target = cmd.payload.source;
      try {
        await handler(this.userId, cmd.args, (text: string) => {
          this.bus.emit('msg:out', {
            userId: this.userId,
            target,
            text,
          });
        }, cmd.payload);
      } catch (err) {
        log.error({ err, userId: this.userId, command: cmd.name }, 'Command handler error');
        this.bus.emit('msg:out', {
          userId: this.userId,
          target,
          text: `❌ Command error: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    this.processingCommand = false;
  }

  // ---- 普通消息队列处理 ----

  private async drainMessageQueue(): Promise<void> {
    if (this.processingMessage) return;

    // Rate limit 暂停中。
    if (this.pausedUntil && Date.now() < this.pausedUntil) return;

    this.processingMessage = true;

    const log = getLogger();

    while (this.messageQueue.length > 0) {
      // 每轮迭代检查 rate limit。
      if (this.pausedUntil && Date.now() < this.pausedUntil) break;

      // 根据策略决定如何取出消息。
      let text: string;
      let source: string;
      let files = undefined as MsgInPayload['files'];

      if (
        (this.queueStrategy === 'merge' || this.queueStrategy === 'interrupt') &&
        this.messageQueue.length > 1
      ) {
        // merge / interrupt：合并所有积压消息。
        const payloads = this.messageQueue.splice(0);
        this.currentPayloads = payloads;
        text = payloads.map((p) => this.buildEnvelope(p)).join('\n');
        source = payloads[payloads.length - 1].source;
        files = payloads.flatMap((p) => p.files ?? []);
        if (files.length === 0) files = undefined;
      } else {
        // sequential 或只有 1 条消息。
        const payload = this.messageQueue.shift()!;
        this.currentPayloads = [payload];
        text = this.buildEnvelope(payload);
        source = payload.source;
        files = payload.files;
      }

      this.bus.emit('agent:busy', { userId: this.userId, target: source });

      try {
        await this.executeQuery(text, source, files);
      } catch (err) {
        if (err instanceof AgentInterruptedError) {
          log.info({ userId: this.userId }, 'Agent interrupted by user');
        } else if (err instanceof RateLimitError) {
          this.handleRateLimit(err);
          break;
        } else {
          log.error({ err, userId: this.userId }, 'Query execution error');
          this.bus.emit('msg:out', {
            userId: this.userId,
            target: source,
            text: `❌ Error: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }

      this.bus.emit('agent:idle', { userId: this.userId, target: source });
    }

    this.processingMessage = false;
  }

  // ---- Query 执行 ----

  private async executeQuery(
    envelopedText: string,
    target: string,
    _files?: MsgInPayload['files'],
  ): Promise<void> {
    let lastText = '';

    const onMessage = (msg: SDKMessage) => {
      const text = this.extractStreamText(msg);
      if (text && text !== lastText) {
        lastText = text;
        this.bus.emit('msg:out', {
          userId: this.userId,
          target,
          text,
          streaming: true,
        });
      }
    };

    const sendFile = async (filePath: string, _options?: SendFileOptions) => {
      this.bus.emit('msg:out', {
        userId: this.userId,
        target,
        files: [{ type: 'document' as const, path: filePath }],
      });
    };

    const notifyUser = async (text: string) => {
      this.bus.emit('msg:out', {
        userId: this.userId,
        target,
        text,
      });
    };

    const result = await sendToAgent(
      this.userId,
      envelopedText,
      onMessage,
      sendFile,
      notifyUser,
    );

    // 流式结束标记（仅用于 dedup，不携带文本——文本已在最后一次 streaming 事件中发出）。
    if (lastText) {
      this.bus.emit('msg:out', {
        userId: this.userId,
        target,
        streaming: true,
        final: true,
      });
    }

    // 完整消息（非 streaming）。
    const fullText =
      result.subtype === 'success' && typeof result.result === 'string'
        ? result.result
        : lastText || '[No response]';

    this.bus.emit('msg:out', {
      userId: this.userId,
      target,
      text: fullText,
    });
  }

  // ---- 辅助方法 ----

  /**
   * 从 SDK 流式消息中提取文本。
   * 返回当前 assistant 消息中的完整文本（累积式，非增量）。
   */
  private extractStreamText(msg: SDKMessage): string | null {
    if (msg.type !== 'assistant') return null;

    const assistantMsg = msg as {
      message?: { content?: Array<{ type: string; text?: string }> };
    };
    const content = assistantMsg.message?.content;
    if (!Array.isArray(content)) return null;

    const text = content
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('');

    return text.trim() ? text : null;
  }

  /**
   * 为消息添加信封（平台来源、时间戳、时区）。
   *
   * 格式：[telegram | 2026-03-12 15:06:32 Asia/Shanghai (UTC+8)]
   */
  private buildEnvelope(payload: MsgInPayload): string {
    const config = getConfig();
    if (!config.messageEnvelope?.enabled) {
      return payload.text ?? '';
    }

    const profile = readProfile(payload.userId);
    const tz = resolveTimezone(profile?.timezone);
    const now = new Date();
    const localTime = formatLocalTime(now, tz);
    const offset = getUtcOffset(tz);

    return `[${payload.source} | ${localTime} ${tz} (${offset})]\n${payload.text ?? ''}`;
  }

  /**
   * 处理 rate limit：暂停队列、通知用户、定时恢复。
   * 使用 this.currentPayloads（原始 payload）重入队，避免双重 envelope 包装。
   */
  private handleRateLimit(err: RateLimitError): void {
    const log = getLogger();
    const resumeAt = err.resetsAt ?? Date.now() + DEFAULT_RATE_LIMIT_WAIT_MS;

    this.pausedUntil = resumeAt;

    // 将原始 payload 放回队列头部，恢复后由 drainMessageQueue 重新 buildEnvelope。
    this.messageQueue.unshift(...this.currentPayloads);

    const source = this.currentPayloads[this.currentPayloads.length - 1]?.source ?? 'unknown';

    // 通知用户。
    const resetTime = new Date(resumeAt).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
    });
    this.bus.emit('msg:out', {
      userId: this.userId,
      target: source,
      text: `⏳ Rate limited. Will auto-resume at ${resetTime}.`,
    });

    // 定时恢复。
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    const delayMs = Math.max(resumeAt - Date.now(), 1000);
    this.resumeTimer = setTimeout(() => {
      this.pausedUntil = null;
      this.resumeTimer = null;
      log.info({ userId: this.userId }, 'Rate limit expired, resuming queue');
      this.drainMessageQueue();
    }, delayMs);

    log.info({ userId: this.userId, resumeAt, delayMs }, 'Queue paused due to rate limit');
  }

  /** 外部中断当前 query（用于 BusAgentManager 等）。 */
  abortCurrentQuery(): void {
    interruptAgent(this.userId).catch(() => {});
  }

  /** 清理资源：取消定时器、清空队列。 */
  dispose(): void {
    if (this.resumeTimer) {
      clearTimeout(this.resumeTimer);
      this.resumeTimer = null;
    }
    this.pausedUntil = null;
    this.messageQueue.length = 0;
    this.commandQueue.length = 0;
    this.currentPayloads = [];
  }
}

// ---- BusAgentManager（全局管理器） ----

/**
 * 管理所有用户的 BusAgent 实例。
 * 监听 EventBus 的 msg:in 事件，按 userId 路由到对应 BusAgent。
 */
export class BusAgentManager {
  private agents = new Map<string, BusAgent>();
  private bus: EventBus | null = null;
  private unsubscribe: (() => void) | null = null;
  private globalCommandHandlers = new Map<string, CommandHandler>();
  private options: BusAgentOptions;

  constructor(options: BusAgentOptions = {}) {
    this.options = options;
  }

  /**
   * 注册全局指令处理器（所有用户共享）。
   * 已创建的 BusAgent 实例也会同步注册。
   */
  registerCommand(name: string, handler: CommandHandler): void {
    this.globalCommandHandlers.set(name.toLowerCase(), handler);
    for (const agent of this.agents.values()) {
      agent.registerCommand(name, handler);
    }
  }

  /**
   * 启动管理器，开始监听 msg:in 事件。
   */
  start(bus: EventBus): void {
    this.bus = bus;
    this.unsubscribe = bus.on('msg:in', (payload) => this.handleMsgIn(payload));
  }

  /**
   * 停止管理器，取消所有监听，清理所有 agent 资源。
   */
  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    for (const agent of this.agents.values()) {
      agent.dispose();
    }
    this.agents.clear();
  }

  private handleMsgIn(payload: MsgInPayload): void {
    const agent = this.getOrCreateAgent(payload.userId);
    agent.handleMessage(payload);
  }

  private getOrCreateAgent(userId: string): BusAgent {
    let agent = this.agents.get(userId);
    if (!agent) {
      if (!this.bus) {
        throw new Error('BusAgentManager not started — call start(bus) first');
      }
      agent = new BusAgent(userId, this.bus, this.options);
      // 注册全局指令处理器。
      for (const [name, handler] of this.globalCommandHandlers) {
        agent.registerCommand(name, handler);
      }
      this.agents.set(userId, agent);
    }
    return agent;
  }
}
