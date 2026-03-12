/**
 * AgentElegram 适配器端到端测试。
 *
 * 前置条件：
 *   - agentelegram 服务器正在运行（默认 http://localhost:4000）
 *   - PostgreSQL 数据库已初始化
 *   - Claude Code CLI 已认证（用于 Full Pipeline 测试）
 *
 * 如果 agentelegram 服务器不可用，所有测试将自动跳过。
 *
 * 环境变量：
 *   AGENTELEGRAM_URL — 服务器基础 URL（默认 http://localhost:4000）
 *
 * 运行：
 *   npm test -- tests/e2e/agentelegram.test.ts
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

/**
 * 检查 agentelegram 服务器是否可用。
 */
async function isServerAvailable(): Promise<boolean> {
  try {
    await fetch(`${SERVER_URL}/api/auth/me`, { signal: AbortSignal.timeout(3000) });
    return true; // 服务器响应（即使是 401）
  } catch {
    return false;
  }
}

/**
 * 注册一个人类用户并获取 JWT。
 */
async function registerHuman(): Promise<{ token: string; participantId: string }> {
  const name = `e2e-human-${Date.now()}`;
  const res = await fetch(`${SERVER_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, displayName: 'E2E Human', password: 'testpass' }),
  });
  if (!res.ok) throw new Error(`Failed to register human: ${await res.text()}`);
  const data = await res.json();
  return { token: data.token, participantId: data.participant.id };
}

/**
 * 注册一个 Agent 并获取 API Key（需要人类 JWT 认证）。
 */
async function registerAgent(jwt: string): Promise<{ apiKey: string; participantId: string }> {
  const name = `e2e-agent-${Date.now()}`;
  const res = await fetch(`${SERVER_URL}/api/auth/register-agent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify({ name, displayName: 'E2E BC Agent' }),
  });
  if (!res.ok) throw new Error(`Failed to register agent: ${await res.text()}`);
  const data = await res.json();
  return { apiKey: data.apiKey, participantId: data.participant.id };
}

/**
 * 以人类身份连接 WebSocket 并完成认证。
 */
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
 * 人类创建与 Agent 的会话，返回 conversationId。
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
 * 人类发送消息并等待 Agent 回复完成（message_done）。
 */
async function sendAndWaitReply(
  humanWs: WebSocket,
  conversationId: string,
  content: string,
  timeout = 15_000,
): Promise<Record<string, unknown>> {
  const donePromise = waitForEvent(humanWs, 'message_done', timeout);
  wsSend(humanWs, {
    type: 'send_message',
    conversationId,
    content,
    contentType: 'text',
  });
  return donePromise;
}

// ── Test Suite ────────────────────────────────────────────────────────────────

describe('AgentElegram E2E', () => {
  let available = false;
  let humanAuth: { token: string; participantId: string };
  let agentInfo: { apiKey: string; participantId: string };
  let testEnv: { dataDir: string; cleanup: () => Promise<void> };
  let bcUserId: string;
  let bcUserToken: string;
  let adapter: AgentelegramAdapter;
  let humanWs: WebSocket;

  /** 可变的消息处理函数，每个测试可以覆盖。 */
  let messageHandler: (msg: InboundMessage) => Promise<void>;

  beforeAll(async () => {
    available = await isServerAvailable();
    if (!available) {
      console.log('[agentelegram-e2e] Server not available, skipping all tests');
      return;
    }

    // 在 agentelegram 注册人类用户和 Agent。
    humanAuth = await registerHuman();
    agentInfo = await registerAgent(humanAuth.token);

    // 初始化 Better-Claw 测试环境。
    delete process.env.CLAUDECODE;
    testEnv = createTestEnv();

    // 初始化 skill index（管理协议需要）。
    const { initSkillIndex } = await import('../../src/skills/scanner.js');
    initSkillIndex([]);

    // 创建 Better-Claw 用户。
    const { createUser } = await import('../../src/user/manager.js');
    const user = createUser('e2e-agentelegram');
    bcUserId = user.userId;
    bcUserToken = user.token;

    // 创建并启动适配器（使用真实 agentelegram 服务器）。
    adapter = await AgentelegramAdapter.create(
      {
        serverUrl: WS_URL,
        apiKey: agentInfo.apiKey,
        commandPrefix: '/',
        reconnectInterval: 5000,
      },
      () => bcUserId, // mgmtUserResolver: 管理协议使用测试用户
    );

    messageHandler = async () => {}; // 默认空处理
    await adapter.start(async (msg) => messageHandler(msg));

    // 等待适配器连接并完成认证。
    await sleep(2000);

    // 人类连接 WebSocket。
    humanWs = await connectHumanWs(humanAuth.token);
  }, 30_000);

  afterAll(async () => {
    // 先停止适配器（关闭 WS 连接）。
    if (adapter) await adapter.stop();
    if (humanWs?.readyState === WebSocket.OPEN) humanWs.close();
    // 等待 WS close 事件处理完毕后再销毁 logger，避免 pino "worker is ending" 错误。
    await sleep(500);
    if (testEnv) await testEnv.cleanup();
  });

  // ── 1. Message Round-Trip ─────────────────────────────────────

  it('receives human message and streams echo reply back through real server', async () => {
    if (!available) return;

    // 设置回声处理器。
    messageHandler = async (msg) => {
      await adapter.sendText(msg.platformUserId, `Echo: ${msg.text}`);
      // 等待 delta_ack 到达。
      await sleep(500);
      // 模拟 AdapterBridge 的 agent:idle → onAgentDone 调用。
      adapter.onAgentDone!(msg.platformUserId);
    };

    // 创建会话。
    const conversationId = await createConversation(
      humanWs,
      humanAuth.participantId,
      agentInfo.participantId,
    );
    expect(conversationId).toBeTruthy();

    // 人类发送消息，等待 Agent 回复完成。
    const doneEvent = await sendAndWaitReply(humanWs, conversationId, 'Hello from E2E test');

    // 验证回复内容。
    const message = doneEvent.message as Record<string, unknown>;
    expect(message).toBeTruthy();
    expect(message.content).toContain('Echo: Hello from E2E test');
    expect(message.senderId).toBe(agentInfo.participantId);
  }, 30_000);

  // ── 2. Command Parsing ────────────────────────────────────────

  it('parses commands correctly through real server', async () => {
    if (!available) return;

    let receivedMsg: InboundMessage | null = null;
    messageHandler = async (msg) => {
      receivedMsg = msg;
      await adapter.sendText(msg.platformUserId, 'Command received');
      await sleep(500);
      adapter.onAgentDone!(msg.platformUserId);
    };

    const conversationId = await createConversation(
      humanWs,
      humanAuth.participantId,
      agentInfo.participantId,
    );

    await sendAndWaitReply(humanWs, conversationId, '/test arg1 arg2');

    expect(receivedMsg).toBeTruthy();
    expect(receivedMsg!.isCommand).toBe(true);
    expect(receivedMsg!.commandName).toBe('test');
    expect(receivedMsg!.commandArgs).toBe('arg1 arg2');
    expect(receivedMsg!.platform).toBe('agentelegram');
    expect(receivedMsg!.platformUserId).toBe(conversationId);
  }, 30_000);

  // ── 3. Multi-Chunk Streaming ──────────────────────────────────

  it('streams multiple chunks and assembles them correctly', async () => {
    if (!available) return;

    // 处理器发送多个 chunk，模拟真实 Agent 的流式输出。
    messageHandler = async (msg) => {
      await adapter.sendText(msg.platformUserId, 'Part 1: Hello');
      await sleep(100);
      await adapter.sendText(msg.platformUserId, 'Part 2: World');
      await sleep(100);
      await adapter.sendText(msg.platformUserId, 'Part 3: Done');
      // 等待所有 ack 传播。
      await sleep(1000);
      adapter.onAgentDone!(msg.platformUserId);
    };

    const conversationId = await createConversation(
      humanWs,
      humanAuth.participantId,
      agentInfo.participantId,
    );

    const doneEvent = await sendAndWaitReply(
      humanWs,
      conversationId,
      'Trigger multi-chunk',
    );

    const message = doneEvent.message as Record<string, unknown>;
    expect(message).toBeTruthy();
    const content = message.content as string;
    expect(content).toContain('Part 1: Hello');
    expect(content).toContain('Part 2: World');
    expect(content).toContain('Part 3: Done');
  }, 30_000);

  // ── 4. Self-Message Filtering ─────────────────────────────────

  it('ignores self-sent messages (no infinite loop)', async () => {
    if (!available) return;

    const receivedMessages: InboundMessage[] = [];
    messageHandler = async (msg) => {
      receivedMessages.push(msg);
      await adapter.sendText(msg.platformUserId, `Reply to: ${msg.text}`);
      await sleep(500);
      adapter.onAgentDone!(msg.platformUserId);
    };

    const conversationId = await createConversation(
      humanWs,
      humanAuth.participantId,
      agentInfo.participantId,
    );

    await sendAndWaitReply(humanWs, conversationId, 'Self-filter test');

    // 等待额外时间，确认适配器不会循环处理自己的回复。
    await sleep(1000);

    // 只应收到一条消息（人类发的），不应收到自己的回复。
    expect(receivedMessages.length).toBe(1);
    expect(receivedMessages[0].text).toBe('Self-filter test');
  }, 30_000);

  // ── 5. Typing Indicator ───────────────────────────────────────

  it('sends typing indicator through real server', async () => {
    if (!available) return;

    // 收集 typing 事件。
    const typingEvents: Record<string, unknown>[] = [];
    const typingListener = (raw: WebSocket.RawData) => {
      const event = JSON.parse(raw.toString());
      if (event.type === 'typing') typingEvents.push(event);
    };
    humanWs.on('message', typingListener);

    messageHandler = async (msg) => {
      await adapter.showTyping(msg.platformUserId);
      await sleep(300);
      await adapter.sendText(msg.platformUserId, 'Done typing');
      await sleep(500);
      adapter.onAgentDone!(msg.platformUserId);
    };

    const conversationId = await createConversation(
      humanWs,
      humanAuth.participantId,
      agentInfo.participantId,
    );

    await sendAndWaitReply(humanWs, conversationId, 'Typing test');
    humanWs.removeListener('message', typingListener);

    // 应至少收到一个 typing 事件。
    expect(typingEvents.length).toBeGreaterThanOrEqual(1);
    expect(typingEvents[0].activity).toBe('thinking');
  }, 30_000);

  // ── 6. Management Protocol ────────────────────────────────────

  describe('Management Protocol via REST API', () => {
    it('queries skills through real server → adapter → mgmt handler', async () => {
      if (!available) return;

      const res = await fetch(`${SERVER_URL}/api/agents/${agentInfo.participantId}/skills`, {
        headers: { Authorization: `Bearer ${humanAuth.token}` },
      });

      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(Array.isArray(data.data)).toBe(true);
    }, 15_000);

    it('queries memory through real server', async () => {
      if (!available) return;

      const res = await fetch(`${SERVER_URL}/api/agents/${agentInfo.participantId}/memory`, {
        headers: { Authorization: `Bearer ${humanAuth.token}` },
      });

      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.data).toHaveProperty('core');
      expect(data.data).toHaveProperty('extended');
    }, 15_000);

    it('queries cron through real server', async () => {
      if (!available) return;

      const res = await fetch(`${SERVER_URL}/api/agents/${agentInfo.participantId}/cron`, {
        headers: { Authorization: `Bearer ${humanAuth.token}` },
      });

      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(Array.isArray(data.data)).toBe(true);
    }, 15_000);

    it('queries MCP servers through real server', async () => {
      if (!available) return;

      const res = await fetch(`${SERVER_URL}/api/agents/${agentInfo.participantId}/mcp`, {
        headers: { Authorization: `Bearer ${humanAuth.token}` },
      });

      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(Array.isArray(data.data)).toBe(true);
    }, 15_000);

    it('memory write → read → delete round-trip via REST', async () => {
      if (!available) return;

      // Write.
      const writeRes = await fetch(
        `${SERVER_URL}/api/agents/${agentInfo.participantId}/memory/core/e2e_test_key`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${humanAuth.token}`,
          },
          body: JSON.stringify({ value: 'e2e_test_value' }),
        },
      );
      expect(writeRes.ok).toBe(true);

      // Read.
      const readRes = await fetch(
        `${SERVER_URL}/api/agents/${agentInfo.participantId}/memory/core/e2e_test_key`,
        {
          headers: { Authorization: `Bearer ${humanAuth.token}` },
        },
      );
      expect(readRes.ok).toBe(true);
      const readData = await readRes.json();
      expect(readData.data).toBe('e2e_test_value');

      // Delete.
      const delRes = await fetch(
        `${SERVER_URL}/api/agents/${agentInfo.participantId}/memory/core/e2e_test_key`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${humanAuth.token}` },
        },
      );
      expect(delRes.ok).toBe(true);

      // Verify deleted.
      const verifyRes = await fetch(
        `${SERVER_URL}/api/agents/${agentInfo.participantId}/memory/core/e2e_test_key`,
        {
          headers: { Authorization: `Bearer ${humanAuth.token}` },
        },
      );
      expect(verifyRes.ok).toBe(true);
      const verifyData = await verifyRes.json();
      expect(verifyData.data).toBeNull();
    }, 20_000);

    it('cron create → update → delete round-trip via REST', async () => {
      if (!available) return;

      // Create.
      const createRes = await fetch(
        `${SERVER_URL}/api/agents/${agentInfo.participantId}/cron`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${humanAuth.token}`,
          },
          body: JSON.stringify({
            schedule: '0 9 * * *',
            description: 'E2E test cron task',
          }),
        },
      );
      expect(createRes.ok).toBe(true);
      const created = await createRes.json();
      const cronId = created.data.id;
      expect(cronId).toBeTruthy();
      expect(created.data.schedule).toBe('0 9 * * *');

      // Update.
      const updateRes = await fetch(
        `${SERVER_URL}/api/agents/${agentInfo.participantId}/cron/${cronId}`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${humanAuth.token}`,
          },
          body: JSON.stringify({ description: 'Updated E2E cron' }),
        },
      );
      expect(updateRes.ok).toBe(true);
      const updated = await updateRes.json();
      expect(updated.data.description).toBe('Updated E2E cron');

      // Delete.
      const delRes = await fetch(
        `${SERVER_URL}/api/agents/${agentInfo.participantId}/cron/${cronId}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${humanAuth.token}` },
        },
      );
      expect(delRes.ok).toBe(true);
    }, 20_000);

    it('full agent state query (GET /api/agents/:id) includes all sections', async () => {
      if (!available) return;

      const res = await fetch(`${SERVER_URL}/api/agents/${agentInfo.participantId}`, {
        headers: { Authorization: `Bearer ${humanAuth.token}` },
      });

      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.agent).toBeTruthy();
      expect(data.agent.online).toBe(true);
      expect(data.state).toBeTruthy();
      expect(data.state.online).toBe(true);
      expect(data.state).toHaveProperty('skills');
      expect(data.state).toHaveProperty('memory');
      expect(data.state).toHaveProperty('cron');
      expect(data.state).toHaveProperty('mcp');
    }, 15_000);
  });

  // ── 7. Full Pipeline with Claude SDK ──────────────────────────

  it('processes message through full Better-Claw pipeline with real Claude SDK', async () => {
    if (!available) return;

    const { enqueue } = await import('../../src/core/queue.js');
    const { bindPlatform, resolveUser } = await import('../../src/user/manager.js');

    // 创建会话。
    const conversationId = await createConversation(
      humanWs,
      humanAuth.participantId,
      agentInfo.participantId,
    );

    // 绑定 Better-Claw 用户到 agentelegram 平台（以 conversationId 作为 platformUserId）。
    const profile = bindPlatform(bcUserToken, 'agentelegram', conversationId);
    expect(profile).toBeTruthy();
    const userId = resolveUser('agentelegram', conversationId);
    expect(userId).toBe(bcUserId);

    // 设置完整管线的 handler：解析用户 → enqueue → Claude SDK 处理 → 流式回复。
    messageHandler = async (msg) => {
      const resolvedUserId = resolveUser(msg.platform, msg.platformUserId);
      if (!resolvedUserId) {
        await adapter.sendText(msg.platformUserId, 'User not found');
        await sleep(500);
        adapter.onAgentDone!(msg.platformUserId);
        return;
      }

      return new Promise<void>((resolve) => {
        enqueue({
          userId: resolvedUserId,
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

    // 人类发送消息（要求 Agent 回复固定文本，方便断言）。
    const doneEvent = await sendAndWaitReply(
      humanWs,
      conversationId,
      'Reply with exactly: E2E_AGENTELEGRAM_OK',
      120_000, // Claude SDK 处理需要较长时间
    );

    const message = doneEvent.message as Record<string, unknown>;
    expect(message).toBeTruthy();
    expect(message.senderId).toBe(agentInfo.participantId);
    expect(message.content as string).toContain('E2E_AGENTELEGRAM_OK');
  }, 180_000);
});
