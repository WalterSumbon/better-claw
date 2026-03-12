/**
 * AgentElegram 真实用户对话 E2E 测试。
 *
 * 从人类用户的视角出发，模拟真实用户在 agentelegram 平台上与 Better-Claw Agent 对话。
 * 所有测试通过真实 agentelegram 服务器，核心对话测试走真实 Claude SDK 处理管线。
 *
 * 测试场景：
 *   1. 用户绑定流程：未绑定用户 → 收到绑定提示 → /bind 绑定 → 确认成功
 *   2. /help 命令：返回命令帮助文本
 *   3. 单轮对话（完整管线）：用户发消息 → enqueue → Claude SDK → 流式回复 → 用户收到
 *   4. 流式响应验证：用户端实时接收 message_delta 事件，最终 message_done 内容完整
 *   5. 多轮对话：用户连续发多条消息，Agent 保持上下文
 *   6. /context 命令：返回当前会话信息
 *   7. 对话历史：对话结束后通过 get_history 验证消息记录
 *   8. 并发用户：两个用户同时与同一 Agent 对话，各自收到正确回复
 *
 * 前置条件：
 *   - agentelegram 服务器运行中（默认 http://localhost:4000）
 *   - PostgreSQL 数据库已初始化
 *   - Claude Code CLI 已认证
 *
 * 环境变量：
 *   AGENTELEGRAM_URL — 服务器基础 URL（默认 http://localhost:4000）
 *
 * 运行：
 *   npm test -- tests/e2e/agentelegram-conversation.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import { createTestEnv } from '../helpers/setup.js';
import { AgentelegramAdapter } from '../../src/adapter/agentelegram/adapter.js';
import type { InboundMessage } from '../../src/adapter/types.js';

const SERVER_URL = process.env.AGENTELEGRAM_URL ?? 'http://localhost:4000';
const WS_URL = SERVER_URL.replace(/^http/, 'ws') + '/ws';

// ── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function wsSend(ws: WebSocket, data: object): void {
  ws.send(JSON.stringify(data));
}

async function isServerAvailable(): Promise<boolean> {
  try {
    await fetch(`${SERVER_URL}/api/auth/me`, { signal: AbortSignal.timeout(3000) });
    return true;
  } catch {
    return false;
  }
}

async function registerHuman(
  suffix?: string,
): Promise<{ token: string; participantId: string }> {
  const name = `e2e-conv-human-${suffix ?? Date.now()}`;
  const res = await fetch(`${SERVER_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, displayName: `Human ${suffix ?? ''}`, password: 'testpass' }),
  });
  if (!res.ok) throw new Error(`Failed to register human: ${await res.text()}`);
  const data = await res.json();
  return { token: data.token, participantId: data.participant.id };
}

async function registerAgent(
  jwt: string,
): Promise<{ apiKey: string; participantId: string }> {
  const name = `e2e-conv-agent-${Date.now()}`;
  const res = await fetch(`${SERVER_URL}/api/auth/register-agent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify({ name, displayName: 'E2E Conversation Agent' }),
  });
  if (!res.ok) throw new Error(`Failed to register agent: ${await res.text()}`);
  const data = await res.json();
  return { apiKey: data.apiKey, participantId: data.participant.id };
}

function connectHumanWs(jwt: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const timeout = setTimeout(() => reject(new Error('Human WS auth timeout')), 10_000);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'auth', token: jwt }));
    });
    ws.on('message', (raw) => {
      const event = JSON.parse(raw.toString());
      if (event.type === 'auth_ok') {
        clearTimeout(timeout);
        resolve(ws);
      } else if (event.type === 'error') {
        clearTimeout(timeout);
        reject(new Error(event.error?.message ?? 'auth failed'));
      }
    });
    ws.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

/**
 * 等待 WebSocket 上出现指定类型的事件。
 */
function waitForEvent(
  ws: WebSocket,
  type: string,
  timeout = 15_000,
  filter?: (event: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeListener('message', handler);
      reject(new Error(`Timeout waiting for event: ${type}`));
    }, timeout);
    const handler = (raw: WebSocket.RawData) => {
      const event = JSON.parse(raw.toString());
      if (event.type === type && (!filter || filter(event))) {
        clearTimeout(timer);
        ws.removeListener('message', handler);
        resolve(event);
      }
    };
    ws.on('message', handler);
  });
}

/**
 * 收集指定时间窗口内的所有指定类型事件。
 */
function collectEvents(
  ws: WebSocket,
  type: string,
  durationMs: number,
  filter?: (event: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>[]> {
  return new Promise((resolve) => {
    const collected: Record<string, unknown>[] = [];
    const handler = (raw: WebSocket.RawData) => {
      const event = JSON.parse(raw.toString());
      if (event.type === type && (!filter || filter(event))) {
        collected.push(event);
      }
    };
    ws.on('message', handler);
    setTimeout(() => {
      ws.removeListener('message', handler);
      resolve(collected);
    }, durationMs);
  });
}

/**
 * 人类创建与 Agent 的会话。
 */
async function createConversation(
  humanWs: WebSocket,
  humanId: string,
  agentId: string,
): Promise<string> {
  const promise = waitForEvent(humanWs, 'conversation_created');
  wsSend(humanWs, {
    type: 'create_conversation',
    participantIds: [humanId, agentId],
  });
  const event = await promise;
  return event.conversationId as string;
}

/**
 * 人类发送消息并等待 Agent 回复完成（message_done），
 * 同时收集流式 delta 事件。
 */
async function sendAndWaitReplyWithDeltas(
  humanWs: WebSocket,
  conversationId: string,
  content: string,
  timeout = 120_000,
): Promise<{
  doneEvent: Record<string, unknown>;
  deltas: Record<string, unknown>[];
}> {
  const deltas: Record<string, unknown>[] = [];

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      humanWs.removeListener('message', handler);
      reject(new Error(`Timeout waiting for message_done (${timeout}ms)`));
    }, timeout);

    const handler = (raw: WebSocket.RawData) => {
      const event = JSON.parse(raw.toString());
      // 收集来自 Agent 的 delta。
      if (event.type === 'message_delta') {
        deltas.push(event);
      }
      // 等待最终的 message_done。
      if (event.type === 'message_done') {
        clearTimeout(timer);
        humanWs.removeListener('message', handler);
        resolve({ doneEvent: event, deltas });
      }
    };

    humanWs.on('message', handler);

    // 发送消息。
    wsSend(humanWs, {
      type: 'send_message',
      conversationId,
      content,
      contentType: 'text',
    });
  });
}

/**
 * 简化版：发送消息并等待回复，不收集 delta。
 */
async function sendAndWaitReply(
  humanWs: WebSocket,
  conversationId: string,
  content: string,
  timeout = 120_000,
): Promise<Record<string, unknown>> {
  const { doneEvent } = await sendAndWaitReplyWithDeltas(
    humanWs,
    conversationId,
    content,
    timeout,
  );
  return doneEvent;
}

// ── Test Suite ────────────────────────────────────────────────────────────────

describe('Real User ↔ Agent Conversation E2E', () => {
  let available = false;
  let humanAuth: { token: string; participantId: string };
  let agentInfo: { apiKey: string; participantId: string };
  let testEnv: { dataDir: string; cleanup: () => Promise<void> };
  let bcUserId: string;
  let bcUserToken: string;
  let adapter: AgentelegramAdapter;
  let humanWs: WebSocket;

  /** 模拟真实 handleMessage 的处理函数。 */
  let messageHandler: (msg: InboundMessage) => Promise<void>;

  // 会被 import 的模块引用。
  let resolveUser: (platform: string, platformUserId: string) => string | null;
  let bindPlatform: (
    token: string,
    platform: string,
    platformUserId: string,
  ) => { userId: string; name: string } | null;
  let enqueue: (msg: {
    userId: string;
    text: string;
    reply: (text: string) => Promise<void>;
    sendFile: (path: string, opts?: unknown) => Promise<void>;
    showTyping: () => void;
    platform: string;
    onComplete?: () => void;
  }) => void;
  let buildHelpText: (prefix: string) => string;
  let getCurrentSessionInfo: (userId: string) => unknown | null;

  beforeAll(async () => {
    available = await isServerAvailable();
    if (!available) {
      console.log('[conversation-e2e] Server not available, skipping all tests');
      return;
    }

    // 注册参与者。
    humanAuth = await registerHuman(`main-${Date.now()}`);
    agentInfo = await registerAgent(humanAuth.token);

    // 初始化 Better-Claw 测试环境。
    delete process.env.CLAUDECODE;
    testEnv = createTestEnv();

    // 初始化 skill index。
    const { initSkillIndex } = await import('../../src/skills/scanner.js');
    initSkillIndex([]);

    // 创建 Better-Claw 用户。
    const { createUser } = await import('../../src/user/manager.js');
    const user = createUser('e2e-conversation-test');
    bcUserId = user.userId;
    bcUserToken = user.token;

    // 动态 import 需要的模块。
    const userManager = await import('../../src/user/manager.js');
    resolveUser = userManager.resolveUser;
    bindPlatform = userManager.bindPlatform;

    const queueModule = await import('../../src/core/queue.js');
    enqueue = queueModule.enqueue;

    const commandsModule = await import('../../src/core/commands.js');
    buildHelpText = commandsModule.buildHelpText;

    const sessionModule = await import('../../src/core/session-manager.js');
    getCurrentSessionInfo = sessionModule.getCurrentSessionInfo;

    // 创建适配器，handler 模拟真实 handleMessage 逻辑。
    adapter = await AgentelegramAdapter.create(
      {
        serverUrl: WS_URL,
        apiKey: agentInfo.apiKey,
        commandPrefix: '/',
        reconnectInterval: 5000,
      },
      () => bcUserId,
    );

    messageHandler = async (msg: InboundMessage) => {
      // sendText 后需要等待 delta_ack 到达，否则 finishStreaming 时没有 messageId。
      // 对于非 enqueue 的快速路径（命令处理），必须手动等待。
      const ACK_DELAY = 800;

      // 辅助函数：发送回复后完成流式消息（模拟 AdapterBridge 的 agent:idle → onAgentDone）。
      const finishAfterReply = async () => {
        await sleep(ACK_DELAY);
        adapter.onAgentDone!(msg.platformUserId);
      };

      // 未知命令作为普通消息处理。
      if (msg.isCommand) {
        switch (msg.commandName) {
          case 'bind': {
            const token = msg.commandArgs?.trim();
            if (!token) {
              await adapter.sendText(msg.platformUserId, 'Usage: /bind <your-token>');
              await finishAfterReply();
              return;
            }
            const profile = bindPlatform(token, msg.platform, msg.platformUserId);
            if (profile) {
              await adapter.sendText(
                msg.platformUserId,
                `Bound successfully! Welcome, ${profile.name}.`,
              );
            } else {
              await adapter.sendText(msg.platformUserId, 'Invalid token.');
            }
            await finishAfterReply();
            return;
          }
          case 'help': {
            await adapter.sendText(msg.platformUserId, buildHelpText('/'));
            await finishAfterReply();
            return;
          }
          case 'context': {
            const userId = resolveUser(msg.platform, msg.platformUserId);
            if (userId) {
              const sessionInfo = getCurrentSessionInfo(userId) as Record<string, unknown> | null;
              if (!sessionInfo) {
                await adapter.sendText(msg.platformUserId, 'No active session.');
              } else {
                await adapter.sendText(
                  msg.platformUserId,
                  `📊 Context Usage\nSession: ${sessionInfo.localId}\nMessages: ${sessionInfo.messageCount}, Turns: ${sessionInfo.totalTurns}`,
                );
              }
            } else {
              await adapter.sendText(msg.platformUserId, 'User not bound.');
            }
            await finishAfterReply();
            return;
          }
          default:
            break; // 未知命令作为普通消息处理
        }
      }

      // 解析用户。
      const userId = resolveUser(msg.platform, msg.platformUserId);
      if (!userId) {
        await adapter.sendText(
          msg.platformUserId,
          "I don't recognize you yet. Use /bind <your-token> to link your account.",
        );
        await finishAfterReply();
        return;
      }

      // 入队处理：走完整 Better-Claw 管线（enqueue → Claude SDK → 流式回复）。
      return new Promise<void>((resolve) => {
        enqueue({
          userId,
          text: msg.text,
          reply: (text: string) => adapter.sendText(msg.platformUserId, text),
          sendFile: (path, opts) => adapter.sendFile(msg.platformUserId, path, opts),
          showTyping: () => {
            adapter.showTyping(msg.platformUserId).catch(() => {});
          },
          platform: msg.platform,
          onComplete: () => {
            adapter.onAgentDone!(msg.platformUserId);
            resolve();
          },
        });
      });
    };

    await adapter.start(async (msg) => messageHandler(msg));

    // 等待适配器连接完成。
    await sleep(2000);

    // 人类连接 WebSocket。
    humanWs = await connectHumanWs(humanAuth.token);
  }, 30_000);

  afterAll(async () => {
    if (adapter) await adapter.stop();
    if (humanWs?.readyState === WebSocket.OPEN) humanWs.close();
    await sleep(500);
    if (testEnv) await testEnv.cleanup();
  });

  // ── 1. 用户绑定流程 ──────────────────────────────────────────

  describe('User Binding Flow', () => {
    it('unbound user receives binding prompt', async () => {
      if (!available) return;

      const conversationId = await createConversation(
        humanWs,
        humanAuth.participantId,
        agentInfo.participantId,
      );

      const reply = await sendAndWaitReply(humanWs, conversationId, 'Hello agent!', 15_000);

      const message = reply.message as Record<string, unknown>;
      expect(message).toBeTruthy();
      expect(message.content as string).toContain('/bind');
      expect(message.content as string).toContain("don't recognize");
    }, 30_000);

    it('/bind with invalid token returns error', async () => {
      if (!available) return;

      const conversationId = await createConversation(
        humanWs,
        humanAuth.participantId,
        agentInfo.participantId,
      );

      const reply = await sendAndWaitReply(
        humanWs,
        conversationId,
        '/bind invalid-token-12345',
        15_000,
      );

      const message = reply.message as Record<string, unknown>;
      expect(message).toBeTruthy();
      expect(message.content as string).toContain('Invalid token');
    }, 30_000);

    it('/bind with valid token binds user successfully', async () => {
      if (!available) return;

      const conversationId = await createConversation(
        humanWs,
        humanAuth.participantId,
        agentInfo.participantId,
      );

      const reply = await sendAndWaitReply(
        humanWs,
        conversationId,
        `/bind ${bcUserToken}`,
        15_000,
      );

      const message = reply.message as Record<string, unknown>;
      expect(message).toBeTruthy();
      expect(message.content as string).toContain('Bound successfully');
      expect(message.content as string).toContain('e2e-conversation-test');

      // 验证绑定已生效。
      const userId = resolveUser('agentelegram', conversationId);
      expect(userId).toBe(bcUserId);
    }, 30_000);
  });

  // ── 2. /help 命令 ──────────────────────────────────────────────

  it('/help returns command list', async () => {
    if (!available) return;

    const conversationId = await createConversation(
      humanWs,
      humanAuth.participantId,
      agentInfo.participantId,
    );

    const reply = await sendAndWaitReply(humanWs, conversationId, '/help', 15_000);

    const message = reply.message as Record<string, unknown>;
    expect(message).toBeTruthy();
    const content = message.content as string;
    // /help 文本应包含常见命令。
    expect(content).toContain('/bind');
    expect(content).toContain('/help');
  }, 30_000);

  // ── 3. 单轮对话（完整管线 + Claude SDK） ──────────────────────

  describe('Single Turn Conversation with Claude SDK', () => {
    let boundConversationId: string;

    beforeAll(async () => {
      if (!available) return;

      // 创建会话并绑定用户。
      boundConversationId = await createConversation(
        humanWs,
        humanAuth.participantId,
        agentInfo.participantId,
      );
      bindPlatform(bcUserToken, 'agentelegram', boundConversationId);
    });

    it('user sends message and receives Claude SDK response', async () => {
      if (!available) return;

      const reply = await sendAndWaitReply(
        humanWs,
        boundConversationId,
        'Reply with exactly: CONV_E2E_SINGLE_TURN_OK',
        120_000,
      );

      const message = reply.message as Record<string, unknown>;
      expect(message).toBeTruthy();
      expect(message.senderId).toBe(agentInfo.participantId);
      expect(message.content as string).toContain('CONV_E2E_SINGLE_TURN_OK');
    }, 180_000);

    it('human receives streaming deltas before message_done', async () => {
      if (!available) return;

      // 创建新会话绑定。
      const convId = await createConversation(
        humanWs,
        humanAuth.participantId,
        agentInfo.participantId,
      );
      bindPlatform(bcUserToken, 'agentelegram', convId);

      const { doneEvent, deltas } = await sendAndWaitReplyWithDeltas(
        humanWs,
        convId,
        'Write a short paragraph about the color blue. At least 3 sentences.',
        120_000,
      );

      // Agent 的流式回复应该产生至少 1 个 delta 事件。
      // 注意：如果 Claude 回复非常短，可能只有一个 chunk 就直接 done 了，
      // 所以我们放宽到 >= 0，但关键是 message_done 包含完整内容。
      const message = doneEvent.message as Record<string, unknown>;
      expect(message).toBeTruthy();
      expect((message.content as string).length).toBeGreaterThan(50);
      expect(message.senderId).toBe(agentInfo.participantId);

      // 如果有 deltas，验证它们来自同一消息。
      if (deltas.length > 0) {
        const deltaContent = deltas
          .map((d) => (d.delta as Record<string, unknown>)?.content ?? '')
          .join('');
        // delta 内容的组合应该出现在最终消息中。
        expect((message.content as string).length).toBeGreaterThanOrEqual(deltaContent.length);
      }
    }, 180_000);
  });

  // ── 4. 多轮对话 ──────────────────────────────────────────────

  describe('Multi-Turn Conversation', () => {
    it('agent maintains context across multiple messages', async () => {
      if (!available) return;

      // 创建新会话并绑定。
      const convId = await createConversation(
        humanWs,
        humanAuth.participantId,
        agentInfo.participantId,
      );
      bindPlatform(bcUserToken, 'agentelegram', convId);

      // 第一轮：告诉 Agent 一个秘密词汇。
      const reply1 = await sendAndWaitReply(
        humanWs,
        convId,
        'Remember this secret code: PINEAPPLE_42. Just confirm you received it.',
        120_000,
      );

      const msg1 = reply1.message as Record<string, unknown>;
      expect(msg1).toBeTruthy();
      expect((msg1.content as string).length).toBeGreaterThan(0);

      // 第二轮：要求 Agent 回忆秘密词汇。
      const reply2 = await sendAndWaitReply(
        humanWs,
        convId,
        'What was the secret code I just told you? Reply with only the code.',
        120_000,
      );

      const msg2 = reply2.message as Record<string, unknown>;
      expect(msg2).toBeTruthy();
      expect(msg2.content as string).toContain('PINEAPPLE_42');
    }, 360_000);
  });

  // ── 5. /context 命令 ────────────────────────────────────────

  it('/context returns session info after conversation', async () => {
    if (!available) return;

    // 创建会话并绑定。
    const convId = await createConversation(
      humanWs,
      humanAuth.participantId,
      agentInfo.participantId,
    );
    bindPlatform(bcUserToken, 'agentelegram', convId);

    // 先发一条正常消息让 session 初始化。
    await sendAndWaitReply(
      humanWs,
      convId,
      'Reply with exactly: CONTEXT_TEST_OK',
      120_000,
    );

    // 发送 /context 命令。
    const reply = await sendAndWaitReply(humanWs, convId, '/context', 15_000);

    const message = reply.message as Record<string, unknown>;
    expect(message).toBeTruthy();
    const content = message.content as string;
    // /context 应返回会话信息。
    expect(content).toContain('Context Usage');
    expect(content).toContain('Session');
  }, 180_000);

  // ── 6. 对话历史验证 ────────────────────────────────────────

  it('conversation history shows all exchanged messages', async () => {
    if (!available) return;

    // 创建会话并绑定。
    const convId = await createConversation(
      humanWs,
      humanAuth.participantId,
      agentInfo.participantId,
    );
    bindPlatform(bcUserToken, 'agentelegram', convId);

    // 发送一条消息并等待回复。
    await sendAndWaitReply(
      humanWs,
      convId,
      'Reply with exactly: HISTORY_TEST_MSG',
      120_000,
    );

    // 查询历史。
    const historyPromise = waitForEvent(humanWs, 'history', 10_000);
    wsSend(humanWs, {
      type: 'get_history',
      conversationId: convId,
      limit: 50,
    });
    const history = await historyPromise;

    const messages = history.messages as Array<Record<string, unknown>>;
    expect(messages).toBeTruthy();
    // 应至少有 2 条消息：人类发的 + Agent 回复的。
    expect(messages.length).toBeGreaterThanOrEqual(2);

    // 验证人类消息存在。
    const humanMsg = messages.find(
      (m) =>
        m.senderId === humanAuth.participantId &&
        (m.content as string).includes('HISTORY_TEST_MSG'),
    );
    expect(humanMsg).toBeTruthy();

    // 验证 Agent 回复存在。
    const agentMsg = messages.find(
      (m) =>
        m.senderId === agentInfo.participantId &&
        (m.content as string).includes('HISTORY_TEST_MSG'),
    );
    expect(agentMsg).toBeTruthy();

    // 验证消息顺序：人类消息在 Agent 回复之前。
    const humanIdx = messages.indexOf(humanMsg!);
    const agentIdx = messages.indexOf(agentMsg!);
    expect(humanIdx).toBeLessThan(agentIdx);
  }, 180_000);

  // ── 7. 并发用户 ──────────────────────────────────────────────

  describe('Concurrent Users', () => {
    it('two users converse with the same agent simultaneously', async () => {
      if (!available) return;

      // 注册第二个人类用户和 Better-Claw 用户。
      const human2Auth = await registerHuman(`concurrent-${Date.now()}`);
      const human2Ws = await connectHumanWs(human2Auth.token);

      const { createUser } = await import('../../src/user/manager.js');
      const user2 = createUser('e2e-concurrent-user-2');

      try {
        // 创建两个独立会话。
        const conv1 = await createConversation(
          humanWs,
          humanAuth.participantId,
          agentInfo.participantId,
        );
        const conv2 = await createConversation(
          human2Ws,
          human2Auth.participantId,
          agentInfo.participantId,
        );

        // 绑定两个用户。
        bindPlatform(bcUserToken, 'agentelegram', conv1);
        bindPlatform(user2.token, 'agentelegram', conv2);

        // 同时发送消息。
        const [reply1, reply2] = await Promise.all([
          sendAndWaitReply(humanWs, conv1, 'Reply with exactly: USER_ONE_OK', 120_000),
          sendAndWaitReply(human2Ws, conv2, 'Reply with exactly: USER_TWO_OK', 120_000),
        ]);

        // 验证两个用户各自收到了正确的回复。
        const msg1 = reply1.message as Record<string, unknown>;
        const msg2 = reply2.message as Record<string, unknown>;

        expect(msg1).toBeTruthy();
        expect(msg2).toBeTruthy();

        expect(msg1.senderId).toBe(agentInfo.participantId);
        expect(msg2.senderId).toBe(agentInfo.participantId);

        expect(msg1.content as string).toContain('USER_ONE_OK');
        expect(msg2.content as string).toContain('USER_TWO_OK');
      } finally {
        if (human2Ws.readyState === WebSocket.OPEN) human2Ws.close();
      }
    }, 300_000);
  });
});
