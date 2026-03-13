/**
 * AdapterBridge — 将旧 MessageAdapter 接入 EventBus 的桥接层
 *
 * 职责：
 * - 将 adapter 的入站消息转为 bus.emit('msg:in')
 * - 监听 bus 的 msg:out 事件，路由到 adapter 的 sendText/sendFile
 * - 监听 agent:busy/idle，驱动 typing 指示器
 * - 处理用户解析（resolveUser）和 /bind 命令（平台层关注点）
 * - 管理 streaming 去重（避免 streaming final + complete 发两次）
 *
 * @module
 */

import type { EventBus, MsgOutPayload, AgentStatePayload, FileAttachment } from '../core/event-bus.js';
import type { MessageAdapter } from './interface.js';
import type { InboundMessage } from './types.js';
import { resolveUser, bindPlatform, bindPlatformByUserId, getUser } from '../user/manager.js';
import { getLogger } from '../logger/index.js';

/** 这些 source 的消息需要广播到用户所有已绑定平台（而不仅仅是发送来源平台）。 */
const BROADCAST_SOURCES = new Set(['cron', 'system', 'webhook']);

export class AdapterBridge {
  private bus: EventBus;
  private adapter: MessageAdapter;

  /** userId → platformUserId 缓存（来自最近一次入站消息）。 */
  private userPlatformMap = new Map<string, string>();

  /** 跟踪哪些 userId 有活跃的 streaming，用于去重 final complete message。 */
  private streamedUsers = new Set<string>();

  /** typing 刷新定时器（每 4 秒刷新一次 typing 状态）。 */
  private typingIntervals = new Map<string, ReturnType<typeof setInterval>>();

  /**
   * Per-userId 发送队列：保证同一用户的出站消息按 emit 顺序串行投递。
   * EventBus.emit() 对 async listener 是 fire-and-forget，多次连续 emit msg:out
   * 会导致 handleMsgOut() 并发执行，异步 I/O（如 Telegram API）竞态造成乱序。
   * 通过 Promise chain 实现零额外分配的轻量串行化。
   */
  private sendQueues = new Map<string, Promise<void>>();

  private unsubscribers: Array<() => void> = [];

  constructor(adapter: MessageAdapter, bus: EventBus) {
    this.adapter = adapter;
    this.bus = bus;
  }

  /** 适配器平台标识。 */
  get platform(): string {
    return this.adapter.platform;
  }

  /**
   * 启动桥接：订阅 EventBus 事件，启动底层 adapter。
   */
  async start(): Promise<void> {
    // 订阅出站消息和状态事件。
    this.unsubscribers.push(
      this.bus.on('msg:out', (payload) => this.enqueueMsgOut(payload)),
      this.bus.on('agent:busy', (payload) => this.handleBusy(payload)),
      this.bus.on('agent:idle', (payload) => this.handleIdle(payload)),
    );

    // 启动底层 adapter，注入入站处理器。
    await this.adapter.start((msg) => this.handleInbound(msg));
  }

  /**
   * 停止桥接：取消所有订阅，停止底层 adapter。
   */
  async stop(): Promise<void> {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];

    // 清理 typing 定时器。
    for (const interval of this.typingIntervals.values()) {
      clearInterval(interval);
    }
    this.typingIntervals.clear();

    await this.adapter.stop();
  }

  // ---- 入站处理 ----

  private async handleInbound(msg: InboundMessage): Promise<void> {
    const log = getLogger();

    // 1. ACK（如有）。用于需要显式确认的平台（如钉钉）。
    //    Telegram 不需要（grammy 内部自动管理 offset），但其他 adapter 可能提供。
    if (msg.ack) {
      msg.ack().catch((err) => {
        const ackLog = getLogger();
        ackLog.warn({ err, platform: msg.platform }, 'ACK failed (non-blocking)');
      });
    }

    // 2. /bind 命令在用户解析之前处理（因为未绑定用户也能执行）。
    if (msg.isCommand && msg.commandName === 'bind') {
      await this.handleBind(msg);
      return;
    }

    // 3. 用户解析。
    let userId = resolveUser(msg.platform, msg.platformUserId);

    // 3a. 自动绑定：平台已验证用户身份（如 agentelegram token-login），直接绑定。
    if (!userId && msg.externalUserId) {
      const log = getLogger();
      const profile = bindPlatformByUserId(
        msg.externalUserId,
        msg.platform,
        msg.platformUserId,
      );
      if (profile) {
        userId = profile.userId;
        log.info(
          { userId, platform: msg.platform, platformUserId: msg.platformUserId },
          'AdapterBridge: auto-bound via externalUserId',
        );
      }
    }

    if (!userId) {
      await this.adapter.sendText(
        msg.platformUserId,
        `I don't recognize you yet. Use ${this.adapter.commandPrefix}bind <your-token> to link your account.`,
      );
      return;
    }

    // 4. 缓存 userId → platformUserId 映射。
    this.userPlatformMap.set(userId, msg.platformUserId);

    // 5. 转换附件格式。
    let files: FileAttachment[] | undefined;
    if (msg.attachments && msg.attachments.length > 0) {
      files = msg.attachments.map((a) => ({
        type: a.type as FileAttachment['type'],
        path: a.localPath,
        filename: a.fileName,
        mimeType: a.mimeType,
      }));
    }

    // 6. 发射 msg:in。
    this.bus.emit('msg:in', {
      userId,
      source: this.adapter.platform,
      text: msg.text,
      files,
      replyTo: msg.replyTo,
    });

    log.debug(
      { userId, platform: this.adapter.platform, textLength: msg.text.length },
      'AdapterBridge: emitted msg:in',
    );
  }

  private async handleBind(msg: InboundMessage): Promise<void> {
    const token = msg.commandArgs?.trim();
    if (!token) {
      await this.adapter.sendText(
        msg.platformUserId,
        `Usage: ${this.adapter.commandPrefix}bind <your-token>`,
      );
      return;
    }

    const profile = bindPlatform(token, msg.platform, msg.platformUserId);
    if (profile) {
      const log = getLogger();
      log.info(
        { userId: profile.userId, platform: msg.platform },
        'Platform bound via AdapterBridge',
      );
      await this.adapter.sendText(
        msg.platformUserId,
        `Bound successfully! Welcome, ${profile.name}.`,
      );
    } else {
      await this.adapter.sendText(msg.platformUserId, 'Invalid token.');
    }
  }

  // ---- 出站处理 ----

  /**
   * 将 msg:out 加入 per-userId 队列，保证串行投递。
   * 被 EventBus fire-and-forget 调用，内部错误已在 handleMsgOut 中 catch。
   */
  private enqueueMsgOut(payload: MsgOutPayload): void {
    const prev = this.sendQueues.get(payload.userId) ?? Promise.resolve();
    const next = prev.then(() => this.handleMsgOut(payload));
    this.sendQueues.set(payload.userId, next);
  }

  private async handleMsgOut(payload: MsgOutPayload): Promise<void> {
    // 判断这条消息是否应该由我们投递。
    const isTargeted = payload.target === this.adapter.platform;
    const isBroadcast = BROADCAST_SOURCES.has(payload.target);
    if (!isTargeted && !isBroadcast) return;

    // 查找 platformUserId。
    const platformUserId = this.resolvePlatformUserId(payload.userId);
    if (!platformUserId) return;

    // Streaming 处理逻辑：
    // BusAgent 会先发 streaming chunks，然后发 streaming final（无文本），最后发 complete。
    //
    // 流式适配器（supportsStreaming = true，如 AgentElegram）：
    //   转发 streaming 文本，跳过最终 complete（dedup）。
    //
    // 非流式适配器（Telegram、DingTalk 等）：
    //   忽略所有 streaming 事件，只发送最终 complete 消息。
    if (payload.streaming) {
      if (this.adapter.supportsStreaming) {
        this.streamedUsers.add(payload.userId);
        // 转发 streaming 文本（final 标记不携带文本，仅用于 dedup）。
        if (payload.text) {
          await this.adapter.sendText(platformUserId, payload.text).catch((err) => {
            const log = getLogger();
            log.error({ err, platform: this.adapter.platform }, 'Failed to send streaming text');
          });
        }
        // Mid-turn final：关闭当前流式消息，下一个 streaming text 会开启新气泡。
        if (payload.final && this.adapter.onAgentDone) {
          this.adapter.onAgentDone(platformUserId);
        }
      }
      // 非流式适配器：直接忽略 streaming 事件，等 complete 消息。
      return;
    }

    // 非 streaming 消息（complete）。
    if (this.streamedUsers.has(payload.userId)) {
      // 流式适配器已通过 streaming 发送过了，跳过 complete 避免重复。
      this.streamedUsers.delete(payload.userId);
      return;
    }

    // 发送文本。
    if (payload.text) {
      await this.adapter.sendText(platformUserId, payload.text).catch((err) => {
        const log = getLogger();
        log.error({ err, platform: this.adapter.platform }, 'Failed to send text');
      });
    }

    // 发送文件。
    if (payload.files) {
      for (const file of payload.files) {
        if (file.path) {
          const sendType = file.type === 'image' ? 'photo' : file.type;
          await this.adapter.sendFile(platformUserId, file.path, { type: sendType as 'photo' | 'document' | 'voice' | 'video' | 'audio' | 'animation' }).catch((err) => {
            const log = getLogger();
            log.error({ err, platform: this.adapter.platform }, 'Failed to send file');
          });
        }
      }
    }
  }

  // ---- 状态事件 ----

  private async handleBusy(payload: AgentStatePayload): Promise<void> {
    // 只处理与我们相关的事件。
    const shouldHandle =
      payload.target === this.adapter.platform ||
      (payload.target && BROADCAST_SOURCES.has(payload.target));
    if (!shouldHandle) return;

    const platformUserId = this.resolvePlatformUserId(payload.userId);
    if (!platformUserId) return;

    // 立即显示 typing。
    await this.adapter.showTyping(platformUserId).catch(() => {});

    // 每 4 秒刷新 typing（部分平台的 typing 状态会过期）。
    const key = `${payload.userId}:${this.adapter.platform}`;
    if (!this.typingIntervals.has(key)) {
      const interval = setInterval(() => {
        this.adapter.showTyping(platformUserId).catch(() => {});
      }, 4000);
      this.typingIntervals.set(key, interval);
    }
  }

  private handleIdle(payload: AgentStatePayload): void {
    const key = `${payload.userId}:${this.adapter.platform}`;
    const interval = this.typingIntervals.get(key);
    if (interval) {
      clearInterval(interval);
      this.typingIntervals.delete(key);
    }

    // 通知适配器 agent 处理完成（用于流式协议的完成信号）。
    // 仅当消息来源是本平台时才触发（广播源不需要，因为没有对应的活跃请求/流式状态）。
    if (this.adapter.onAgentDone && payload.target === this.adapter.platform) {
      const platformUserId = this.resolvePlatformUserId(payload.userId);
      if (platformUserId) {
        this.adapter.onAgentDone(platformUserId);
      }
    }
  }

  // ---- 辅助方法 ----

  /**
   * 解析 userId 对应的 platformUserId。
   * 先查缓存（最近入站消息），再查用户绑定。
   */
  private resolvePlatformUserId(userId: string): string | null {
    // 缓存优先。
    const cached = this.userPlatformMap.get(userId);
    if (cached) return cached;

    // 查用户绑定。
    const profile = getUser(userId);
    if (!profile) return null;
    const binding = profile.bindings.find((b) => b.platform === this.adapter.platform);
    if (binding) {
      // 填充缓存。
      this.userPlatformMap.set(userId, binding.platformUserId);
      return binding.platformUserId;
    }
    return null;
  }
}
