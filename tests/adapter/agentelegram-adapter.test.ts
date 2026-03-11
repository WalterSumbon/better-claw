import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { createTestEnv } from '../helpers/setup.js';
import { AgentelegramAdapter } from '../../src/adapter/agentelegram/adapter.js';
import { createUser, bindPlatform } from '../../src/user/manager.js';
import { initSkillIndex } from '../../src/skills/scanner.js';
import type { InboundMessage } from '../../src/adapter/types.js';

// ---- 测试用 WebSocket Server ----

interface MockServer {
  wss: WebSocketServer;
  port: number;
  /** 最后连接的客户端。 */
  lastClient: WebSocket | null;
  /** 收到的所有消息。 */
  receivedMessages: Record<string, unknown>[];
  /** 等待下一个客户端连接。 */
  waitForConnection: () => Promise<WebSocket>;
  /** 等待收到指定类型的消息。 */
  waitForMessage: (type: string, timeout?: number) => Promise<Record<string, unknown>>;
  /** 关闭服务器。 */
  close: () => Promise<void>;
}

function createMockServer(): Promise<MockServer> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0 });
    const receivedMessages: Record<string, unknown>[] = [];
    let lastClient: WebSocket | null = null;
    const connectionWaiters: Array<(ws: WebSocket) => void> = [];
    const messageWaiters: Array<{ type: string; resolve: (msg: Record<string, unknown>) => void }> = [];

    wss.on('connection', (ws) => {
      lastClient = ws;
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        receivedMessages.push(msg);
        // 通知等待者。
        const idx = messageWaiters.findIndex((w) => w.type === msg.type);
        if (idx !== -1) {
          const waiter = messageWaiters.splice(idx, 1)[0];
          waiter.resolve(msg);
        }
      });
      // 通知连接等待者。
      const waiter = connectionWaiters.shift();
      if (waiter) waiter(ws);
    });

    wss.on('listening', () => {
      const addr = wss.address();
      const port = typeof addr === 'object' ? addr!.port : 0;
      resolve({
        wss,
        port,
        get lastClient() { return lastClient; },
        receivedMessages,
        waitForConnection: () => new Promise<WebSocket>((res) => {
          if (lastClient && lastClient.readyState === WebSocket.OPEN) {
            res(lastClient);
          } else {
            connectionWaiters.push(res);
          }
        }),
        waitForMessage: (type: string, timeout = 5000) => new Promise<Record<string, unknown>>((res, rej) => {
          // 先检查已收到的消息。
          const existing = receivedMessages.find((m) => m.type === type);
          if (existing) {
            res(existing);
            return;
          }
          const timer = setTimeout(() => rej(new Error(`Timeout waiting for message type: ${type}`)), timeout);
          messageWaiters.push({
            type,
            resolve: (msg) => {
              clearTimeout(timer);
              res(msg);
            },
          });
        }),
        close: () => new Promise<void>((res) => {
          wss.close(() => res());
        }),
      });
    });
  });
}

/** 简单延迟。 */
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('AgentelegramAdapter', () => {
  let testEnv: ReturnType<typeof createTestEnv>;
  let server: MockServer;
  let adapter: AgentelegramAdapter;
  let userId: string;

  beforeEach(async () => {
    testEnv = createTestEnv();

    // 创建测试用户并绑定。
    const user = createUser('test-user');
    userId = user.userId;

    // 初始化 skill 索引（管理协议需要）。
    initSkillIndex([]);

    server = await createMockServer();
  });

  afterEach(async () => {
    if (adapter) {
      await adapter.stop();
    }
    await server.close();
    // 等待 WS close 事件处理完毕，避免 pino "worker is ending" 错误。
    await delay(50);
    await testEnv.cleanup();
  });

  /** 创建适配器并启动，模拟 auth_ok 流程。 */
  async function setupAdapter(handler?: (msg: InboundMessage) => Promise<void>): Promise<void> {
    adapter = await AgentelegramAdapter.create(
      {
        serverUrl: `ws://localhost:${server.port}/ws`,
        apiKey: 'ag-test-key-12345678901234567890',
        commandPrefix: '/',
        reconnectInterval: 500,
      },
      () => userId,
    );

    const defaultHandler = handler ?? (async () => {});
    await adapter.start(defaultHandler);

    // 等待连接。
    const client = await server.waitForConnection();

    // 应收到 auth 消息。
    const authMsg = await server.waitForMessage('auth');
    expect(authMsg.type).toBe('auth');
    expect(authMsg.apiKey).toBe('ag-test-key-12345678901234567890');

    // 回复 auth_ok。
    client.send(JSON.stringify({
      type: 'auth_ok',
      participantId: 'agent-participant-id',
      participantName: 'test-agent',
      participantType: 'agent',
    }));

    // 等待 list_conversations 请求。
    await server.waitForMessage('list_conversations');
  }

  // ---- 认证测试 ----

  it('should connect and authenticate with apiKey', async () => {
    await setupAdapter();
    // 验证认证消息正确发送。
    const authMsg = server.receivedMessages.find((m) => m.type === 'auth');
    expect(authMsg).toBeDefined();
    expect(authMsg!.apiKey).toBe('ag-test-key-12345678901234567890');
  });

  it('should request conversations list after auth', async () => {
    await setupAdapter();
    const listMsg = server.receivedMessages.find((m) => m.type === 'list_conversations');
    expect(listMsg).toBeDefined();
  });

  // ---- 消息接收测试 ----

  it('should receive message and invoke handler', async () => {
    const received: InboundMessage[] = [];
    await setupAdapter(async (msg) => {
      received.push(msg);
    });

    // 模拟 agentelegram 发送消息。
    server.lastClient!.send(JSON.stringify({
      type: 'message',
      conversationId: 'conv-123',
      message: {
        id: 'msg-001',
        conversationId: 'conv-123',
        senderId: 'user-456',
        content: 'Hello agent!',
        contentType: 'text',
        timestamp: Date.now(),
      },
    }));

    await delay(100);

    expect(received.length).toBe(1);
    expect(received[0].platform).toBe('agentelegram');
    expect(received[0].platformUserId).toBe('conv-123');
    expect(received[0].text).toBe('Hello agent!');
    expect(received[0].isCommand).toBe(false);
  });

  it('should ignore messages from self', async () => {
    const received: InboundMessage[] = [];
    await setupAdapter(async (msg) => {
      received.push(msg);
    });

    // 发送自己的消息（senderId === selfParticipantId）。
    server.lastClient!.send(JSON.stringify({
      type: 'message',
      conversationId: 'conv-123',
      message: {
        id: 'msg-002',
        conversationId: 'conv-123',
        senderId: 'agent-participant-id', // 自己的 ID
        content: 'My own message',
        contentType: 'text',
        timestamp: Date.now(),
      },
    }));

    await delay(100);

    expect(received.length).toBe(0);
  });

  it('should parse commands correctly', async () => {
    const received: InboundMessage[] = [];
    await setupAdapter(async (msg) => {
      received.push(msg);
    });

    server.lastClient!.send(JSON.stringify({
      type: 'message',
      conversationId: 'conv-123',
      message: {
        id: 'msg-003',
        conversationId: 'conv-123',
        senderId: 'user-456',
        content: '/bind my-token-123',
        contentType: 'text',
        timestamp: Date.now(),
      },
    }));

    await delay(100);

    expect(received.length).toBe(1);
    expect(received[0].isCommand).toBe(true);
    expect(received[0].commandName).toBe('bind');
    expect(received[0].commandArgs).toBe('my-token-123');
  });

  // ---- 消息发送测试（流式） ----

  it('should send streaming message with delta + done protocol', async () => {
    await setupAdapter();

    const conversationId = 'conv-123';

    // 清除之前的消息。
    server.receivedMessages.length = 0;

    // 发送第一个 chunk。
    await adapter.sendText(conversationId, 'Hello');

    // 应收到 send_message_delta。
    const firstDelta = await server.waitForMessage('send_message_delta');
    expect(firstDelta.conversationId).toBe(conversationId);
    expect(firstDelta.delta).toBe('Hello');
    expect(firstDelta.messageId).toBeUndefined();

    // 模拟服务端回复 delta_ack。
    server.lastClient!.send(JSON.stringify({
      type: 'delta_ack',
      assignedMessageId: 'msg-stream-001',
      conversationId,
    }));

    await delay(50);

    // 发送第二个 chunk。
    server.receivedMessages.length = 0;
    await adapter.sendText(conversationId, 'World');

    await delay(50);

    // 应收到带 messageId 的 delta。
    const secondDelta = server.receivedMessages.find(
      (m) => m.type === 'send_message_delta' && m.messageId === 'msg-stream-001',
    );
    expect(secondDelta).toBeDefined();
    expect(secondDelta!.delta).toBe('\n\nWorld');

    // 完成流式消息。
    server.receivedMessages.length = 0;
    adapter.finishStreaming(conversationId);

    await delay(50);

    const doneMsg = server.receivedMessages.find((m) => m.type === 'send_message_done');
    expect(doneMsg).toBeDefined();
    expect(doneMsg!.messageId).toBe('msg-stream-001');
    expect(doneMsg!.conversationId).toBe(conversationId);
  });

  it('should buffer deltas while waiting for ack', async () => {
    await setupAdapter();

    const conversationId = 'conv-buffer-test';

    // 清除 setup 阶段的消息。
    server.receivedMessages.length = 0;

    // 快速发送多个 chunk，不等 ack。
    await adapter.sendText(conversationId, 'chunk1');
    await adapter.sendText(conversationId, 'chunk2');
    await adapter.sendText(conversationId, 'chunk3');

    // 等待 WS 消息到达。
    await delay(100);

    // 应只发了一个 send_message_delta（第一个 chunk）。
    const deltas = server.receivedMessages.filter((m) => m.type === 'send_message_delta');
    expect(deltas.length).toBe(1);
    expect(deltas[0].delta).toBe('chunk1');

    // 模拟 ack。
    server.lastClient!.send(JSON.stringify({
      type: 'delta_ack',
      assignedMessageId: 'msg-buffer-001',
      conversationId,
    }));

    await delay(100);

    // 缓冲的 chunk2 和 chunk3 应该被发出。
    const allDeltas = server.receivedMessages.filter((m) => m.type === 'send_message_delta');
    // 应有 3 个 delta：第一个 + 2 个缓冲的。
    expect(allDeltas.length).toBe(3);
  });

  // ---- Typing 测试 ----

  it('should send typing indicator', async () => {
    await setupAdapter();

    server.receivedMessages.length = 0;
    await adapter.showTyping('conv-typing');

    await delay(50);

    const typingMsg = server.receivedMessages.find((m) => m.type === 'typing');
    expect(typingMsg).toBeDefined();
    expect(typingMsg!.conversationId).toBe('conv-typing');
    expect(typingMsg!.activity).toBe('thinking');
  });

  // ---- 文件发送测试 ----

  it('should send file as text message (MVP)', async () => {
    await setupAdapter();

    server.receivedMessages.length = 0;
    await adapter.sendFile('conv-file', '/path/to/image.png', { type: 'photo', caption: 'My photo' });

    await delay(50);

    const delta = server.receivedMessages.find((m) => m.type === 'send_message_delta');
    expect(delta).toBeDefined();
    expect((delta!.delta as string)).toContain('/path/to/image.png');
    expect((delta!.delta as string)).toContain('photo');
    expect((delta!.delta as string)).toContain('My photo');
  });

  // ---- 断线重连测试 ----

  it('should reconnect after disconnection', async () => {
    await setupAdapter();

    // 关闭客户端连接。
    server.lastClient!.close();

    // 等待重连（reconnectInterval = 500ms）。
    const newClient = await server.waitForConnection();
    expect(newClient).toBeDefined();

    // 应再次发送 auth。
    const authMsg = await server.waitForMessage('auth');
    expect(authMsg.apiKey).toBe('ag-test-key-12345678901234567890');
  });

  // ---- 管理协议测试 ----

  it('should handle query_skills mgmt request', async () => {
    await setupAdapter();

    // 发送管理请求。
    server.receivedMessages.length = 0;
    server.lastClient!.send(JSON.stringify({
      type: 'mgmt_request',
      requestId: 'req-001',
      action: 'query_skills',
    }));

    // 等待响应。
    const response = await server.waitForMessage('mgmt_response');
    expect(response.requestId).toBe('req-001');
    expect(response.success).toBe(true);
    expect(Array.isArray(response.data)).toBe(true);
  });

  it('should handle query_memory mgmt request', async () => {
    await setupAdapter();

    server.receivedMessages.length = 0;
    server.lastClient!.send(JSON.stringify({
      type: 'mgmt_request',
      requestId: 'req-002',
      action: 'query_memory',
    }));

    const response = await server.waitForMessage('mgmt_response');
    expect(response.requestId).toBe('req-002');
    expect(response.success).toBe(true);
    const data = response.data as Record<string, unknown>;
    expect(data.core).toBeDefined();
    expect(data.extended).toBeDefined();
  });

  it('should handle query_cron mgmt request', async () => {
    await setupAdapter();

    server.receivedMessages.length = 0;
    server.lastClient!.send(JSON.stringify({
      type: 'mgmt_request',
      requestId: 'req-003',
      action: 'query_cron',
    }));

    const response = await server.waitForMessage('mgmt_response');
    expect(response.requestId).toBe('req-003');
    expect(response.success).toBe(true);
    expect(Array.isArray(response.data)).toBe(true);
  });

  it('should handle query_mcp mgmt request', async () => {
    await setupAdapter();

    server.receivedMessages.length = 0;
    server.lastClient!.send(JSON.stringify({
      type: 'mgmt_request',
      requestId: 'req-004',
      action: 'query_mcp',
    }));

    const response = await server.waitForMessage('mgmt_response');
    expect(response.requestId).toBe('req-004');
    expect(response.success).toBe(true);
    expect(Array.isArray(response.data)).toBe(true);
  });

  it('should handle query_state mgmt request', async () => {
    await setupAdapter();

    server.receivedMessages.length = 0;
    server.lastClient!.send(JSON.stringify({
      type: 'mgmt_request',
      requestId: 'req-005',
      action: 'query_state',
    }));

    const response = await server.waitForMessage('mgmt_response');
    expect(response.requestId).toBe('req-005');
    expect(response.success).toBe(true);
    const data = response.data as Record<string, unknown>;
    expect(data.online).toBe(true);
    expect(data.skills).toBeDefined();
    expect(data.memory).toBeDefined();
    expect(data.cron).toBeDefined();
    expect(data.mcp).toBeDefined();
  });

  it('should handle read_memory mgmt request for core memory', async () => {
    await setupAdapter();

    server.receivedMessages.length = 0;
    server.lastClient!.send(JSON.stringify({
      type: 'mgmt_request',
      requestId: 'req-006',
      action: 'read_memory',
      payload: { tier: 'core', key: 'preferences' },
    }));

    const response = await server.waitForMessage('mgmt_response');
    expect(response.requestId).toBe('req-006');
    expect(response.success).toBe(true);
  });

  it('should handle unknown mgmt action gracefully', async () => {
    await setupAdapter();

    server.receivedMessages.length = 0;
    server.lastClient!.send(JSON.stringify({
      type: 'mgmt_request',
      requestId: 'req-007',
      action: 'unknown_action',
    }));

    const response = await server.waitForMessage('mgmt_response');
    expect(response.requestId).toBe('req-007');
    expect(response.success).toBe(false);
    expect(response.mgmtError).toContain('unknown action');
  });

  // ---- message_done 处理测试 ----

  it('should handle message_done event for streaming messages from others', async () => {
    const received: InboundMessage[] = [];
    await setupAdapter(async (msg) => {
      received.push(msg);
    });

    // 模拟 message_done（其他参与者的流式消息完成）。
    server.lastClient!.send(JSON.stringify({
      type: 'message_done',
      conversationId: 'conv-123',
      messageId: 'msg-stream-done',
      message: {
        id: 'msg-stream-done',
        conversationId: 'conv-123',
        senderId: 'user-789',
        content: 'Complete streamed message',
        contentType: 'text',
        timestamp: Date.now(),
      },
    }));

    await delay(100);

    expect(received.length).toBe(1);
    expect(received[0].text).toBe('Complete streamed message');
  });

  // ---- 清理测试 ----

  it('should clean up streaming state on stop', async () => {
    await setupAdapter();

    // 开始一个流式消息。
    await adapter.sendText('conv-cleanup', 'partial message');

    // 停止适配器。
    await adapter.stop();

    // 不应该抛错。
    expect(true).toBe(true);
  });
});
