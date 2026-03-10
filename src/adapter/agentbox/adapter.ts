/**
 * AgentBox 适配器。
 *
 * 将 Better-Claw 作为 AI Agent 接入 AgentBox 聊天平台。
 * 通过 WebSocket 连接 AgentBox 服务端的 /agent 端点，遵循 Agent Protocol。
 *
 * 消息流：
 *   AgentBox 用户发消息 → AgentBox Server → AgentRequest → 本适配器
 *   → InboundMessage → handleMessage → enqueue → agent 处理
 *   → sendText() → AgentResponse (text_delta + done) → AgentBox Server → 用户
 */
import WebSocket from 'ws';
import { getLogger } from '../../logger/index.js';
import type { MessageAdapter, SendFileOptions } from '../interface.js';
import type { InboundMessage } from '../types.js';
import type { AppConfig } from '../../config/schema.js';

// ---- Agent Protocol 类型（与 @agentbox/shared 对应） ----

interface AgentBoxMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
}

interface AgentRequest {
  requestId: string;
  conversationId: string;
  messages: AgentBoxMessage[];
}

interface AgentResponse {
  type: 'text' | 'text_delta' | 'done' | 'error';
  requestId: string;
  content?: string;
  error?: { code: string; message: string };
}

/** 每个活跃请求的状态。 */
interface ActiveRequest {
  requestId: string;
  conversationId: string;
  accumulatedContent: string;
  doneTimer: ReturnType<typeof setTimeout> | null;
  /** done timer 是否已激活。仅在首次 sendText/showTyping 时才启动，
   *  避免消息在队列排队期间就被提前 finish。 */
  timerActivated: boolean;
}

export class AgentBoxAdapter implements MessageAdapter {
  readonly platform = 'agentbox' as const;
  readonly commandPrefix: string;

  private ws: WebSocket | null = null;
  private running = false;
  private handler: ((msg: InboundMessage) => Promise<void>) | null = null;

  /** 活跃请求：conversationId → ActiveRequest */
  private activeRequests = new Map<string, ActiveRequest>();

  private constructor(
    private readonly serverUrl: string,
    private readonly agentId: string,
    private readonly agentName: string,
    private readonly reconnectInterval: number,
    private readonly doneTimeout: number,
    commandPrefix: string,
  ) {
    this.commandPrefix = commandPrefix;
  }

  /**
   * 工厂方法。
   */
  static async create(config: NonNullable<AppConfig['agentbox']>): Promise<AgentBoxAdapter> {
    return new AgentBoxAdapter(
      config.serverUrl,
      config.agentId,
      config.agentName,
      config.reconnectInterval,
      config.doneTimeout,
      config.commandPrefix,
    );
  }

  async start(handler: (msg: InboundMessage) => Promise<void>): Promise<void> {
    this.running = true;
    this.handler = handler;
    this.connect();
  }

  async stop(): Promise<void> {
    this.running = false;

    // 清理所有活跃请求的 done timer。
    for (const req of this.activeRequests.values()) {
      if (req.doneTimer) clearTimeout(req.doneTimer);
    }
    this.activeRequests.clear();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  async sendText(platformUserId: string, text: string): Promise<void> {
    const state = this.activeRequests.get(platformUserId);
    if (!state || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    // 激活并重置 done timer。
    state.timerActivated = true;
    this.resetDoneTimer(state);

    // 发送 text_delta：内容追加到 AgentBox 前端的流式显示。
    const separator = state.accumulatedContent ? '\n\n' : '';
    const chunk = separator + text;

    this.send({
      type: 'text_delta',
      requestId: state.requestId,
      content: chunk,
    });

    state.accumulatedContent += chunk;
  }

  async sendFile(platformUserId: string, filePath: string, options?: SendFileOptions): Promise<void> {
    // MVP：将文件信息作为文本发送。后续可升级为真正的文件传输。
    const typeInfo = options?.type ? ` (${options.type})` : '';
    const captionInfo = options?.caption ? `\n${options.caption}` : '';
    await this.sendText(platformUserId, `📎 File${typeInfo}: ${filePath}${captionInfo}`);
  }

  async showTyping(platformUserId: string): Promise<void> {
    // showTyping 作为心跳，激活并重置 done timer。
    // 首次调用表示 agent 已开始处理此请求。
    const state = this.activeRequests.get(platformUserId);
    if (state) {
      state.timerActivated = true;
      this.resetDoneTimer(state);
    }
  }

  // ---- Private ----

  private connect(): void {
    if (!this.running) return;

    const log = getLogger();
    const wsUrl = `${this.serverUrl}/agent`;
    log.info({ url: wsUrl }, 'AgentBox: connecting...');

    this.ws = new WebSocket(wsUrl);

    this.ws.on('open', () => {
      log.info('AgentBox: connected, registering agent');
      this.send({
        type: 'register',
        descriptor: {
          id: this.agentId,
          name: this.agentName,
          description: 'Better-Claw AI Assistant powered by Claude',
          capabilities: ['text', 'streaming'],
          transport: 'websocket',
        },
      });
    });

    this.ws.on('message', (raw: WebSocket.RawData) => {
      try {
        const data = JSON.parse(raw.toString());

        if (data.type === 'registered') {
          log.info({ agentId: data.agentId }, 'AgentBox: registered successfully');
          return;
        }

        // AgentRequest：有 requestId + conversationId + messages。
        if (data.requestId && data.conversationId && data.messages) {
          this.handleAgentRequest(data as AgentRequest);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log.error({ err: msg }, 'AgentBox: failed to parse message');
      }
    });

    this.ws.on('close', () => {
      log.info('AgentBox: disconnected');
      this.ws = null;
      if (this.running) {
        log.info({ interval: this.reconnectInterval }, 'AgentBox: reconnecting...');
        setTimeout(() => this.connect(), this.reconnectInterval);
      }
    });

    this.ws.on('error', (err: Error) => {
      log.error({ err: err.message }, 'AgentBox: WebSocket error');
    });
  }

  /**
   * 处理从 AgentBox 收到的 AgentRequest。
   * 提取最新用户消息，转为 InboundMessage，交给 handler 处理。
   */
  private async handleAgentRequest(request: AgentRequest): Promise<void> {
    const log = getLogger();
    const { requestId, conversationId, messages } = request;

    log.info(
      { requestId, conversationId, messageCount: messages.length },
      'AgentBox: received request',
    );

    // 提取最新的用户消息。
    const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
    if (!lastUserMsg) {
      log.warn({ requestId }, 'AgentBox: no user message in request');
      this.send({ type: 'error', requestId, error: { code: 'NO_USER_MESSAGE', message: 'No user message found' } });
      this.send({ type: 'done', requestId });
      return;
    }

    // 注册活跃请求。使用 conversationId 作为 platformUserId。
    // 注意：此时不启动 done timer。消息可能在队列中排队等待，
    // 直到第一次 showTyping/sendText 调用才表示 agent 真正开始处理。
    const state: ActiveRequest = {
      requestId,
      conversationId,
      accumulatedContent: '',
      doneTimer: null,
      timerActivated: false,
    };
    this.activeRequests.set(conversationId, state);

    // 构造 InboundMessage。
    const text = lastUserMsg.content;
    const isCommand = text.startsWith(this.commandPrefix);
    let commandName: string | undefined;
    let commandArgs: string | undefined;

    if (isCommand) {
      const prefixLen = this.commandPrefix.length;
      const spaceIdx = text.indexOf(' ');
      commandName = spaceIdx === -1 ? text.slice(prefixLen) : text.slice(prefixLen, spaceIdx);
      commandArgs = spaceIdx === -1 ? '' : text.slice(spaceIdx + 1).trim();
    }

    const inbound: InboundMessage = {
      platform: 'agentbox',
      platformUserId: conversationId,
      text,
      raw: request,
      isCommand,
      commandName,
      commandArgs,
    };

    try {
      await this.handler?.(inbound);
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      log.error({ err: errMsg, requestId, conversationId }, 'AgentBox: handler error');
      this.send({
        type: 'error',
        requestId,
        error: { code: 'HANDLER_ERROR', message: errMsg },
      });
      this.finishRequest(conversationId);
    }
  }

  /**
   * 重置 done timer。每次 sendText / showTyping 调用时重置。
   * 当空闲超过 doneTimeout 后，发送 done 信号完成请求。
   */
  private resetDoneTimer(state: ActiveRequest): void {
    if (state.doneTimer) clearTimeout(state.doneTimer);
    state.doneTimer = setTimeout(() => {
      this.finishRequest(state.conversationId);
    }, this.doneTimeout);
  }

  /** 发送 done 信号，完成一个请求。 */
  private finishRequest(conversationId: string): void {
    const state = this.activeRequests.get(conversationId);
    if (!state) return;

    const log = getLogger();
    log.info(
      { requestId: state.requestId, conversationId, contentLength: state.accumulatedContent.length },
      'AgentBox: finishing request',
    );

    if (state.doneTimer) clearTimeout(state.doneTimer);

    this.send({
      type: 'done',
      requestId: state.requestId,
    });

    this.activeRequests.delete(conversationId);
  }

  /** 发送 JSON 数据到 AgentBox。 */
  private send(data: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }
}
