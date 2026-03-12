/**
 * AgentElegram 适配器。
 *
 * 将 Better-Claw 作为 AI Agent 接入 agentelegram 聊天平台。
 * 通过 WebSocket 连接 agentelegram 服务端，遵循 agentelegram Agent Protocol。
 *
 * 消息流（EventBus 架构）：
 *   agentelegram 用户发消息 → agentelegram Server → message/message_done 事件 → 本适配器
 *   → InboundMessage → AdapterBridge → bus.emit('msg:in') → BusAgent → agent 处理
 *   → bus.emit('msg:out') → AdapterBridge → sendText() → send_message_delta → 用户
 *   → agent:idle → AdapterBridge → onAgentDone() → finishStreaming() → send_message_done → 用户
 *
 * 管理协议：
 *   agentelegram 前端管理面板 → REST API → Server → mgmt_request → 本适配器
 *   → 查询/修改 Better-Claw 内部状态 → mgmt_response → Server → REST response → 前端
 */
import WebSocket from 'ws';
import { getLogger } from '../../logger/index.js';
import type { MessageAdapter, SendFileOptions } from '../interface.js';
import type { InboundMessage } from '../types.js';
import type { AppConfig } from '../../config/schema.js';
import { handleMgmtRequest, type MgmtRequest } from './mgmt-handler.js';

// ---- AgentElegram Protocol 类型 ----

/** 服务端→客户端事件。 */
interface ServerEvent {
  type: string;
  // auth_ok
  participantId?: string;
  participantName?: string;
  participantType?: string;
  // message
  conversationId?: string;
  message?: {
    id: string;
    conversationId: string;
    senderId: string;
    content: string;
    contentType?: string;
    timestamp: number;
  };
  // message_delta
  delta?: {
    messageId: string;
    senderId: string;
    content: string;
  };
  // delta_ack
  assignedMessageId?: string;
  // history
  messages?: Array<{
    id: string;
    conversationId: string;
    senderId: string;
    content: string;
    contentType?: string;
    timestamp: number;
  }>;
  hasMore?: boolean;
  // conversations
  conversations?: Array<{
    id: string;
    title?: string;
    type: 'direct' | 'group';
    createdBy: string;
    createdAt: number;
    updatedAt: number;
  }>;
  // error
  error?: { code: string; message: string };
  // mgmt_request
  requestId?: string;
  action?: string;
  payload?: Record<string, unknown>;
  // message_done
  messageId?: string;
}

/** 每个会话的活跃流式消息状态。 */
interface StreamingState {
  /** 已分配的消息 ID（从 delta_ack 获取）。 */
  messageId: string | null;
  /** 是否正在等待 delta_ack 响应。 */
  waitingForAck: boolean;
  /** 等待 ack 期间缓冲的 delta 内容。 */
  pendingDeltas: string[];
  /** 累积已发送的内容。 */
  accumulatedContent: string;
}

/** 管理请求的默认用户 ID。
 *  管理协议没有绑定到特定会话，使用第一个已知用户 ID。 */
type MgmtUserResolver = () => string | null;

export class AgentelegramAdapter implements MessageAdapter {
  readonly platform = 'agentelegram' as const;
  readonly commandPrefix: string;

  private ws: WebSocket | null = null;
  private running = false;
  private handler: ((msg: InboundMessage) => Promise<void>) | null = null;

  /** 自身的 participant ID（从 auth_ok 获取）。 */
  private selfParticipantId: string | null = null;

  /** 当前重连延迟（指数退避）。 */
  private currentReconnectDelay: number;
  private static readonly MAX_RECONNECT_DELAY = 5 * 60_000; // 最大 5 分钟

  /** 每个会话的流式消息状态。 */
  private streamingStates = new Map<string, StreamingState>();

  /** 管理协议用户解析器。 */
  private mgmtUserResolver: MgmtUserResolver;

  /** 重连定时器引用（用于 stop 时清理）。 */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private constructor(
    private readonly serverUrl: string,
    private readonly apiKey: string,
    private readonly reconnectInterval: number,
    commandPrefix: string,
    mgmtUserResolver: MgmtUserResolver,
  ) {
    this.commandPrefix = commandPrefix;
    this.currentReconnectDelay = reconnectInterval;
    this.mgmtUserResolver = mgmtUserResolver;
  }

  /**
   * 工厂方法。
   */
  static async create(
    config: NonNullable<AppConfig['agentelegram']>,
    mgmtUserResolver?: MgmtUserResolver,
  ): Promise<AgentelegramAdapter> {
    return new AgentelegramAdapter(
      config.serverUrl,
      config.apiKey,
      config.reconnectInterval,
      config.commandPrefix,
      mgmtUserResolver ?? (() => null),
    );
  }

  async start(handler: (msg: InboundMessage) => Promise<void>): Promise<void> {
    this.running = true;
    this.handler = handler;
    this.connect();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.streamingStates.clear();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  /**
   * 向指定会话发送文本消息（流式）。
   *
   * 流式协议：
   *   1. 首个 chunk：send_message_delta (无 messageId) → 等 delta_ack → 拿到 assignedMessageId
   *   2. 后续 chunk：send_message_delta (带 messageId)
   *   3. sendText 结束后由外部调用 finishStreaming 完成消息
   *
   * 由于 Better-Claw 多次调用 sendText 构成一条完整消息，
   * 我们对每次 sendText 调用都追加到同一个流式消息中。
   * 消息完成的信号由 handleMessage 的 onComplete 回调触发。
   */
  async sendText(platformUserId: string, text: string): Promise<void> {
    const log = getLogger();
    const conversationId = platformUserId;

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      log.warn({ conversationId }, 'AgentElegram: sendText skipped — WS not open');
      return;
    }

    let state = this.streamingStates.get(conversationId);

    if (!state) {
      // 开始新的流式消息。
      state = {
        messageId: null,
        waitingForAck: false,
        pendingDeltas: [],
        accumulatedContent: '',
      };
      this.streamingStates.set(conversationId, state);
    }

    // 添加分隔符（如果不是首个 chunk）。
    const separator = state.accumulatedContent ? '\n\n' : '';
    const chunk = separator + text;

    if (!state.messageId && !state.waitingForAck) {
      // 首个 delta：发送不带 messageId 的 delta，等待 ack。
      state.waitingForAck = true;
      this.send({
        type: 'send_message_delta',
        conversationId,
        delta: chunk,
      });
      state.accumulatedContent += chunk;

      log.debug(
        { conversationId, chunkLen: chunk.length },
        'AgentElegram: sent first delta, waiting for ack',
      );
    } else if (state.waitingForAck) {
      // 还在等 ack，缓冲 delta。
      state.pendingDeltas.push(chunk);
      state.accumulatedContent += chunk;

      log.debug(
        { conversationId, pendingCount: state.pendingDeltas.length },
        'AgentElegram: buffered delta while waiting for ack',
      );
    } else {
      // 已有 messageId，直接发送。
      this.send({
        type: 'send_message_delta',
        conversationId,
        messageId: state.messageId,
        delta: chunk,
      });
      state.accumulatedContent += chunk;

      log.debug(
        { conversationId, messageId: state.messageId, chunkLen: chunk.length },
        'AgentElegram: sent delta',
      );
    }
  }

  async sendFile(platformUserId: string, filePath: string, options?: SendFileOptions): Promise<void> {
    // MVP：将文件信息作为文本发送。后续可升级为真正的文件传输。
    const typeInfo = options?.type ? ` (${options.type})` : '';
    const captionInfo = options?.caption ? `\n${options.caption}` : '';
    await this.sendText(platformUserId, `📎 File${typeInfo}: ${filePath}${captionInfo}`);
  }

  async showTyping(platformUserId: string): Promise<void> {
    const conversationId = platformUserId;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    this.send({
      type: 'typing',
      conversationId,
      activity: 'thinking',
    });
  }

  /**
   * Agent 处理完成回调。由 AdapterBridge 在 agent:idle 时调用。
   * 发送 send_message_done 完成流式消息。
   */
  onAgentDone(platformUserId: string): void {
    this.finishStreaming(platformUserId);
  }

  /**
   * 完成指定会话的流式消息。
   * 由 onAgentDone() 或错误处理时调用。
   */
  finishStreaming(conversationId: string): void {
    const log = getLogger();
    const state = this.streamingStates.get(conversationId);

    if (!state) return;

    if (state.messageId) {
      this.send({
        type: 'send_message_done',
        conversationId,
        messageId: state.messageId,
      });
      log.info(
        { conversationId, messageId: state.messageId, contentLen: state.accumulatedContent.length },
        'AgentElegram: finished streaming message',
      );
    } else {
      log.warn(
        { conversationId, hasContent: state.accumulatedContent.length > 0 },
        'AgentElegram: finishStreaming called but no messageId — message may not have been acked',
      );
    }

    this.streamingStates.delete(conversationId);
  }

  // ---- Private ----

  private connect(): void {
    if (!this.running) return;

    const log = getLogger();
    log.info({ url: this.serverUrl }, 'AgentElegram: connecting...');

    this.ws = new WebSocket(this.serverUrl);

    this.ws.on('open', () => {
      log.info('AgentElegram: connected, authenticating');
      // 连接成功，重置退避延迟。
      this.currentReconnectDelay = this.reconnectInterval;

      // 发送认证消息（必须是连接后的第一条消息）。
      this.send({
        type: 'auth',
        apiKey: this.apiKey,
      });
    });

    this.ws.on('message', (raw: WebSocket.RawData) => {
      try {
        const event = JSON.parse(raw.toString()) as ServerEvent;
        this.handleServerEvent(event);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log.error({ err: msg }, 'AgentElegram: failed to parse message');
      }
    });

    this.ws.on('close', (code: number, reason: Buffer) => {
      log.info({ code, reason: reason.toString() }, 'AgentElegram: disconnected');
      this.ws = null;
      this.selfParticipantId = null;
      // 清理所有流式状态。
      this.streamingStates.clear();

      if (this.running) {
        const reconnectDelay = this.currentReconnectDelay;
        log.info({ interval: reconnectDelay }, 'AgentElegram: reconnecting...');
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          this.connect();
        }, reconnectDelay);
        // 指数退避：每次翻倍，上限 5 分钟。
        this.currentReconnectDelay = Math.min(
          reconnectDelay * 2,
          AgentelegramAdapter.MAX_RECONNECT_DELAY,
        );
      }
    });

    this.ws.on('error', (err: Error) => {
      log.error({ err: err.message }, 'AgentElegram: WebSocket error');
    });
  }

  /**
   * 处理服务端事件。
   */
  private handleServerEvent(event: ServerEvent): void {
    const log = getLogger();

    switch (event.type) {
      case 'auth_ok':
        this.selfParticipantId = event.participantId ?? null;
        log.info(
          { participantId: this.selfParticipantId, name: event.participantName },
          'AgentElegram: authenticated',
        );
        // 认证成功后获取会话列表。
        this.send({ type: 'list_conversations' });
        break;

      case 'message':
        this.handleIncomingMessage(event);
        break;

      case 'message_done':
        // 其他参与者的流式消息完成。
        // 如果之前没收到完整 message 事件，此处处理完成的消息。
        if (event.message) {
          this.handleIncomingMessage({
            ...event,
            type: 'message',
          });
        }
        break;

      case 'message_delta':
        // 其他参与者的流式 delta，目前忽略中间状态，
        // 等 message_done 拿完整内容。
        break;

      case 'delta_ack':
        this.handleDeltaAck(event);
        break;

      case 'typing':
        // 其他参与者的 typing 指示器，忽略。
        break;

      case 'conversations':
        log.info(
          { count: event.conversations?.length ?? 0 },
          'AgentElegram: received conversations list',
        );
        break;

      case 'conversation_created':
        log.info(
          { conversationId: event.conversationId },
          'AgentElegram: new conversation created',
        );
        break;

      case 'conversation_updated':
      case 'conversation_deleted':
        break;

      case 'history':
        break;

      case 'mgmt_request':
        this.handleMgmtRequestEvent(event);
        break;

      case 'error':
        log.error(
          { code: event.error?.code, message: event.error?.message },
          'AgentElegram: server error',
        );
        break;

      default:
        log.debug({ type: event.type }, 'AgentElegram: unknown event type');
    }
  }

  /**
   * 处理收到的完整消息。
   */
  private handleIncomingMessage(event: ServerEvent): void {
    const log = getLogger();
    const message = event.message;

    if (!message) return;

    // 忽略自己发的消息。
    if (message.senderId === this.selfParticipantId) return;

    const conversationId = message.conversationId;
    const text = message.content;

    log.info(
      { conversationId, senderId: message.senderId, textLen: text.length },
      'AgentElegram: received message',
    );

    // 构造 InboundMessage。使用 conversationId 作为 platformUserId。
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
      platform: 'agentelegram',
      platformUserId: conversationId,
      text,
      raw: event,
      isCommand,
      commandName,
      commandArgs,
    };

    // Fire-and-forget：EventBus 架构下 handler 立即返回（仅 emit msg:in）。
    // Agent 完成由 AdapterBridge 通过 agent:idle → onAgentDone → finishStreaming 通知。
    this.handler?.(inbound).catch((e) => {
      const errMsg = e instanceof Error ? e.message : String(e);
      log.error({ err: errMsg, conversationId }, 'AgentElegram: handler error');
      // handler 自身出错时完成流式消息，避免 orphan stream。
      this.finishStreaming(conversationId);
    });
  }

  /**
   * 处理 delta_ack（服务端分配 messageId）。
   */
  private handleDeltaAck(event: ServerEvent): void {
    const log = getLogger();
    const conversationId = event.conversationId;
    const assignedMessageId = event.assignedMessageId;

    if (!conversationId || !assignedMessageId) return;

    const state = this.streamingStates.get(conversationId);
    if (!state) {
      log.warn({ conversationId, assignedMessageId }, 'AgentElegram: delta_ack for unknown conversation');
      return;
    }

    state.messageId = assignedMessageId;
    state.waitingForAck = false;

    log.debug(
      { conversationId, assignedMessageId, pendingCount: state.pendingDeltas.length },
      'AgentElegram: received delta_ack',
    );

    // 发送缓冲的 deltas。
    for (const delta of state.pendingDeltas) {
      this.send({
        type: 'send_message_delta',
        conversationId,
        messageId: assignedMessageId,
        delta,
      });
    }
    state.pendingDeltas = [];
  }

  /**
   * 处理管理请求事件。
   */
  private handleMgmtRequestEvent(event: ServerEvent): void {
    const log = getLogger();
    const { requestId, action, payload } = event;

    if (!requestId || !action) {
      log.warn({ event }, 'AgentElegram: invalid mgmt_request');
      return;
    }

    // 获取管理操作的用户 ID。
    const userId = this.mgmtUserResolver();
    if (!userId) {
      log.warn({ requestId, action }, 'AgentElegram: no user bound, cannot handle mgmt_request');
      this.send({
        type: 'mgmt_response',
        requestId,
        success: false,
        mgmtError: 'No user bound to this agent',
      });
      return;
    }

    const request: MgmtRequest = {
      type: 'mgmt_request',
      requestId,
      action: action as MgmtRequest['action'],
      payload,
    };

    handleMgmtRequest(request, userId)
      .then((response) => {
        this.send(response);
      })
      .catch((err) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.error({ err: errMsg, requestId, action }, 'AgentElegram: mgmt_request failed');
        this.send({
          type: 'mgmt_response',
          requestId,
          success: false,
          mgmtError: errMsg,
        });
      });
  }

  /** 发送 JSON 数据到 agentelegram。 */
  private send(data: object): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }
}
