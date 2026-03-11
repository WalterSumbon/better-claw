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
import { listUsers, bindPlatform, resolveUser } from '../../user/manager.js';

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
  /** User info from AgentBox — includes loginToken for auto-binding. */
  user?: {
    id: string;
    username: string;
    displayName: string;
    loginToken?: string;
  };
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

  /** 当前重连延迟（指数退避）。 */
  private currentReconnectDelay: number;
  private static readonly MAX_RECONNECT_DELAY = 5 * 60_000; // 最大 5 分钟

  /** 活跃请求：conversationId → ActiveRequest */
  private activeRequests = new Map<string, ActiveRequest>();

  private constructor(
    private readonly serverUrl: string,
    private readonly agentKey: string | undefined,
    private readonly agentId: string,
    private readonly agentName: string,
    private readonly reconnectInterval: number,
    private readonly doneTimeout: number,
    commandPrefix: string,
  ) {
    this.commandPrefix = commandPrefix;
    this.currentReconnectDelay = reconnectInterval;
  }

  /**
   * 工厂方法。
   */
  static async create(config: NonNullable<AppConfig['agentbox']>): Promise<AgentBoxAdapter> {
    return new AgentBoxAdapter(
      config.serverUrl,
      config.agentKey,
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
    const log = getLogger();
    const state = this.activeRequests.get(platformUserId);
    if (!state || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      log.warn(
        { platformUserId, hasState: !!state, wsOpen: this.ws?.readyState === WebSocket.OPEN },
        'AgentBox: sendText skipped — no active request or WS closed',
      );
      return;
    }

    log.debug(
      { platformUserId, requestId: state.requestId, textLen: text.length, accumulatedLen: state.accumulatedContent.length },
      'AgentBox: sendText → routing to requestId',
    );

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
    const keyParam = this.agentKey ? `?key=${encodeURIComponent(this.agentKey)}` : '';
    const wsUrl = `${this.serverUrl}/agent${keyParam}`;
    log.info({ url: this.serverUrl + '/agent' }, 'AgentBox: connecting...');

    this.ws = new WebSocket(wsUrl);

    this.ws.on('open', () => {
      log.info('AgentBox: connected, registering agent');
      // 连接成功，重置退避延迟。
      this.currentReconnectDelay = this.reconnectInterval;
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
          // Auto-provision all Better-Claw users on AgentBox after registration.
          this.provisionAllUsers().catch((e) => {
            const errMsg = e instanceof Error ? e.message : String(e);
            log.warn({ err: errMsg }, 'AgentBox: auto-provision failed (non-fatal)');
          });
          return;
        }

        // AgentRequest：有 requestId + conversationId + messages。
        if (data.requestId && data.conversationId && data.messages) {
          this.handleAgentRequest(data as AgentRequest).catch((e) => {
            const errMsg = e instanceof Error ? e.message : String(e);
            log.error({ err: errMsg }, 'AgentBox: unhandled error in handleAgentRequest');
          });
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log.error({ err: msg }, 'AgentBox: failed to parse message');
      }
    });

    this.ws.on('close', (code: number, reason: Buffer) => {
      log.info({ code, reason: reason.toString() }, 'AgentBox: disconnected');
      this.ws = null;
      if (this.running) {
        const delay = this.currentReconnectDelay;
        log.info({ interval: delay }, 'AgentBox: reconnecting...');
        setTimeout(() => this.connect(), delay);
        // 指数退避：每次翻倍，上限 5 分钟。
        this.currentReconnectDelay = Math.min(
          delay * 2,
          AgentBoxAdapter.MAX_RECONNECT_DELAY,
        );
      }
    });

    this.ws.on('error', (err: Error) => {
      log.error({ err: err.message }, 'AgentBox: WebSocket error');
    });
  }

  /**
   * 处理从 AgentBox 收到的 AgentRequest。
   * 提取最新用户消息，转为 InboundMessage，交给 handler 处理。
   * 若请求中包含 user.loginToken，则自动绑定用户（免 /bind 手动操作）。
   */
  private async handleAgentRequest(request: AgentRequest): Promise<void> {
    const log = getLogger();
    const { requestId, conversationId, messages } = request;

    log.info(
      { requestId, conversationId, messageCount: messages.length },
      'AgentBox: received request',
    );

    // Auto-bind: if the request includes a loginToken and the conversationId
    // is not yet bound, automatically bind it to the matching Better-Claw user.
    if (request.user?.loginToken && !resolveUser('agentbox', conversationId)) {
      const profile = bindPlatform(request.user.loginToken, 'agentbox', conversationId);
      if (profile) {
        log.info(
          { userId: profile.userId, conversationId },
          'AgentBox: auto-bound user via loginToken',
        );
      }
    }

    // 提取最新的用户消息。
    const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
    if (!lastUserMsg) {
      log.warn({ requestId }, 'AgentBox: no user message in request');
      this.send({ type: 'error', requestId, error: { code: 'NO_USER_MESSAGE', message: 'No user message found' } });
      this.send({ type: 'done', requestId });
      return;
    }

    // 如果该 conversation 已有活跃请求，先完成旧请求，防止 timer 泄漏和状态冲突。
    const existing = this.activeRequests.get(conversationId);
    if (existing) {
      log.warn(
        { oldRequestId: existing.requestId, newRequestId: requestId, conversationId, oldAccumulatedLen: existing.accumulatedContent.length },
        'AgentBox: overriding existing active request — finishing old one first (accumulated content will be lost!)',
      );
      this.finishRequest(conversationId);
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
      // Handler 完成后立即 finish，不再等 doneTimeout。
      // 仅当此请求仍是当前活跃请求时才 finish，避免误杀后续新请求。
      const current = this.activeRequests.get(conversationId);
      if (current?.requestId === requestId) {
        this.finishRequest(conversationId);
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      log.error({ err: errMsg, requestId, conversationId }, 'AgentBox: handler error');
      const current = this.activeRequests.get(conversationId);
      if (current?.requestId === requestId) {
        this.send({
          type: 'error',
          requestId,
          error: { code: 'HANDLER_ERROR', message: errMsg },
        });
        this.finishRequest(conversationId);
      }
    }
  }

  /**
   * 自动将所有 Better-Claw 用户预注册到 AgentBox 服务端。
   * 通过 REST API POST /api/auth/provision 调用，使用 agentKey 认证。
   * 这样用户可以直接用 Better-Claw token 登录 AgentBox 页面，无需手动 /bind。
   */
  private async provisionAllUsers(): Promise<void> {
    const log = getLogger();

    if (!this.agentKey) {
      log.warn('AgentBox: cannot provision users without agentKey');
      return;
    }

    // 将 ws:// 替换为 http:// 以调用 REST API
    const httpBase = this.serverUrl
      .replace(/^ws:\/\//, 'http://')
      .replace(/^wss:\/\//, 'https://');

    const users = listUsers();
    let provisioned = 0;

    for (const user of users) {
      try {
        const res = await fetch(`${httpBase}/api/auth/provision`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.agentKey}`,
          },
          body: JSON.stringify({
            username: user.name.toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 32) || user.userId,
            displayName: user.name,
            loginToken: user.token,
          }),
        });

        if (res.ok) {
          provisioned++;
        } else {
          const errBody = await res.json().catch(() => ({}));
          log.warn(
            { user: user.name, status: res.status, error: (errBody as any).error },
            'AgentBox: provision user failed',
          );
        }
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        log.warn({ user: user.name, err: errMsg }, 'AgentBox: provision fetch error');
      }
    }

    if (provisioned > 0) {
      log.info({ total: users.length, provisioned }, 'AgentBox: users provisioned');
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
