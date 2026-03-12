/**
 * EventBus 全管线端到端测试。
 *
 * 测试完整的消息流：
 *   MockAdapter → AdapterBridge → EventBus → BusAgentManager → Claude SDK → EventBus → AdapterBridge → MockAdapter
 *
 * 使用真实的 EventBus、BusAgentManager、AdapterBridge 和 Claude SDK，
 * 只有最外层的平台适配器使用 mock（模拟终端用户的消息收发）。
 *
 * 前置条件：
 *   - Claude Code CLI 已认证
 *
 * 运行：
 *   npm test -- tests/e2e/eventbus-pipeline.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestEnv } from '../helpers/setup.js';
import { EventBus } from '../../src/core/event-bus.js';
import { BusAgentManager } from '../../src/core/bus-agent.js';
import { AdapterBridge } from '../../src/adapter/adapter-bridge.js';
import type { MessageAdapter, SendFileOptions } from '../../src/adapter/interface.js';
import type { InboundMessage } from '../../src/adapter/types.js';
import type { MsgOutPayload, AgentStatePayload } from '../../src/core/event-bus.js';

// ── Mock Adapter ──────────────────────────────────────────────────────────────

interface MockMessage {
  platformUserId: string;
  text: string;
}

interface MockFile {
  platformUserId: string;
  filePath: string;
  options?: SendFileOptions;
}

/**
 * 轻量 mock adapter：模拟一个平台（如 telegram/cli）的收发行为。
 *
 * - simulateMessage() 模拟用户发消息
 * - sentMessages / sentFiles 收集 agent 的回复
 * - onAgentDoneCalls 收集完成信号
 */
class MockAdapter implements MessageAdapter {
  readonly platform: string;
  readonly commandPrefix = '/';

  private handler: ((msg: InboundMessage) => Promise<void>) | null = null;

  sentMessages: MockMessage[] = [];
  sentFiles: MockFile[] = [];
  typingCalls: string[] = [];
  onAgentDoneCalls: string[] = [];

  constructor(platform: string) {
    this.platform = platform;
  }

  async start(handler: (msg: InboundMessage) => Promise<void>): Promise<void> {
    this.handler = handler;
  }

  async stop(): Promise<void> {
    this.handler = null;
  }

  async sendText(platformUserId: string, text: string): Promise<void> {
    this.sentMessages.push({ platformUserId, text });
  }

  async sendFile(platformUserId: string, filePath: string, options?: SendFileOptions): Promise<void> {
    this.sentFiles.push({ platformUserId, filePath, options });
  }

  async showTyping(platformUserId: string): Promise<void> {
    this.typingCalls.push(platformUserId);
  }

  onAgentDone(platformUserId: string): void {
    this.onAgentDoneCalls.push(platformUserId);
  }

  /** 模拟平台用户发送消息。 */
  async simulateMessage(platformUserId: string, text: string): Promise<void> {
    if (!this.handler) throw new Error('Adapter not started');
    const isCommand = text.startsWith('/');
    let commandName: string | undefined;
    let commandArgs: string | undefined;
    if (isCommand) {
      const spaceIdx = text.indexOf(' ');
      commandName = spaceIdx === -1 ? text.slice(1) : text.slice(1, spaceIdx);
      commandArgs = spaceIdx === -1 ? '' : text.slice(spaceIdx + 1).trim();
    }
    await this.handler({
      platform: this.platform,
      platformUserId,
      text,
      raw: {},
      isCommand,
      commandName,
      commandArgs,
    });
  }

  /** 清除所有收集的记录。 */
  reset(): void {
    this.sentMessages = [];
    this.sentFiles = [];
    this.typingCalls = [];
    this.onAgentDoneCalls = [];
  }

  /** 等待直到收到包含指定文本的回复消息。 */
  waitForReply(
    contains: string,
    timeout = 120_000,
  ): Promise<MockMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        clearInterval(pollInterval);
        reject(new Error(`Timeout waiting for reply containing "${contains}" (${timeout}ms). Got: ${this.sentMessages.map((m) => m.text.slice(0, 100)).join(' | ')}`));
      }, timeout);

      const pollInterval = setInterval(() => {
        const found = this.sentMessages.find((m) => m.text.includes(contains));
        if (found) {
          clearTimeout(timer);
          clearInterval(pollInterval);
          resolve(found);
        }
      }, 100);
    });
  }

  /** 等待直到收到至少 N 条消息。 */
  waitForMessages(
    count: number,
    timeout = 120_000,
  ): Promise<MockMessage[]> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        clearInterval(pollInterval);
        reject(new Error(`Timeout waiting for ${count} messages (got ${this.sentMessages.length})`));
      }, timeout);

      const pollInterval = setInterval(() => {
        if (this.sentMessages.length >= count) {
          clearTimeout(timer);
          clearInterval(pollInterval);
          resolve(this.sentMessages.slice());
        }
      }, 100);
    });
  }

  /** 等待 onAgentDone 被调用。 */
  waitForAgentDone(
    platformUserId: string,
    timeout = 120_000,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        clearInterval(pollInterval);
        reject(new Error(`Timeout waiting for onAgentDone("${platformUserId}") (${timeout}ms)`));
      }, timeout);

      const pollInterval = setInterval(() => {
        if (this.onAgentDoneCalls.includes(platformUserId)) {
          clearTimeout(timer);
          clearInterval(pollInterval);
          resolve();
        }
      }, 100);
    });
  }
}

// ── Test Suite ────────────────────────────────────────────────────────────────

describe('EventBus Pipeline E2E', () => {
  let testEnv: { dataDir: string; cleanup: () => Promise<void> };
  let bus: EventBus;
  let manager: BusAgentManager;
  let adapter: MockAdapter;
  let bridge: AdapterBridge;
  let userId: string;

  beforeAll(async () => {
    delete process.env.CLAUDECODE;
    testEnv = createTestEnv();

    // 初始化 skill index（BusAgentManager 可能需要）。
    const { initSkillIndex } = await import('../../src/skills/scanner.js');
    initSkillIndex([]);

    // 创建用户并绑定到 mock 平台。
    const { createUser, bindPlatform } = await import('../../src/user/manager.js');
    const user = createUser('e2e-eventbus-pipeline');
    userId = user.userId;
    bindPlatform(user.token, 'mock', 'mock_user_1');

    // 构建 EventBus 管线。
    bus = new EventBus();
    manager = new BusAgentManager();
    manager.start(bus);

    adapter = new MockAdapter('mock');
    bridge = new AdapterBridge(adapter, bus);
    await bridge.start();
  }, 30_000);

  afterAll(async () => {
    manager.stop();
    await bridge.stop();
    // 等待定时器清理。
    await new Promise((r) => setTimeout(r, 500));
    if (testEnv) await testEnv.cleanup();
  });

  beforeEach(() => {
    adapter.reset();
  });

  // ── 1. 完整消息管线 ──────────────────────────────────────────

  it('full pipeline: message flows through EventBus → Agent → SDK → back to adapter', async () => {
    // 用户通过 mock adapter 发送消息。
    await adapter.simulateMessage('mock_user_1', 'Reply with exactly: EVENTBUS_E2E_OK');

    // 等待 agent 回复。
    const reply = await adapter.waitForReply('EVENTBUS_E2E_OK');

    expect(reply.platformUserId).toBe('mock_user_1');
    expect(reply.text).toContain('EVENTBUS_E2E_OK');
  }, 120_000);

  // ── 2. Agent 生命周期事件 ──────────────────────────────────────

  it('emits agent:busy and agent:idle during processing', async () => {
    const busyEvents: AgentStatePayload[] = [];
    const idleEvents: AgentStatePayload[] = [];

    const unsubBusy = bus.on('agent:busy', (p) => {
      if (p.userId === userId) busyEvents.push(p);
    });
    const unsubIdle = bus.on('agent:idle', (p) => {
      if (p.userId === userId) idleEvents.push(p);
    });

    await adapter.simulateMessage('mock_user_1', 'Reply with exactly: LIFECYCLE_TEST_OK');
    await adapter.waitForReply('LIFECYCLE_TEST_OK');

    unsubBusy();
    unsubIdle();

    // 应该至少有一对 busy/idle 事件。
    expect(busyEvents.length).toBeGreaterThanOrEqual(1);
    expect(idleEvents.length).toBeGreaterThanOrEqual(1);

    // busy 的 target 应该是消息来源平台。
    expect(busyEvents[0].target).toBe('mock');
    expect(idleEvents[0].target).toBe('mock');
  }, 120_000);

  // ── 3. Typing 指示器 ──────────────────────────────────────────

  it('shows typing indicator while agent is processing', async () => {
    adapter.reset();
    await adapter.simulateMessage('mock_user_1', 'Reply with exactly: TYPING_TEST_OK');
    await adapter.waitForReply('TYPING_TEST_OK');

    // 处理过程中应该至少触发一次 typing。
    expect(adapter.typingCalls.length).toBeGreaterThanOrEqual(1);
    expect(adapter.typingCalls[0]).toBe('mock_user_1');
  }, 120_000);

  // ── 4. onAgentDone 回调 ────────────────────────────────────────

  it('calls onAgentDone after agent finishes processing', async () => {
    adapter.reset();
    await adapter.simulateMessage('mock_user_1', 'Reply with exactly: DONE_CALLBACK_OK');
    await adapter.waitForAgentDone('mock_user_1');

    expect(adapter.onAgentDoneCalls).toContain('mock_user_1');
  }, 120_000);

  // ── 5. 内建命令：/stop ──────────────────────────────────────────

  it('/stop command sends acknowledgment through pipeline', async () => {
    adapter.reset();
    await adapter.simulateMessage('mock_user_1', '/stop');

    // /stop 应回复确认消息。
    const reply = await adapter.waitForReply('Stopped', 10_000);
    expect(reply.text).toContain('Stopped');
  }, 30_000);

  // ── 6. 内建命令：/new ──────────────────────────────────────────

  it('/new command resets session through pipeline', async () => {
    adapter.reset();
    await adapter.simulateMessage('mock_user_1', '/new');

    const reply = await adapter.waitForReply('New session', 10_000);
    expect(reply.text).toContain('New session');
  }, 30_000);

  // ── 7. 未绑定用户 ──────────────────────────────────────────────

  it('unbound user receives binding prompt', async () => {
    adapter.reset();
    await adapter.simulateMessage('unknown_user', 'hello');

    const reply = await adapter.waitForReply('bind', 5_000);
    expect(reply.platformUserId).toBe('unknown_user');
    expect(reply.text).toContain('bind');
  }, 10_000);

  // ── 8. /bind 命令 ──────────────────────────────────────────────

  it('/bind with invalid token returns error', async () => {
    adapter.reset();
    await adapter.simulateMessage('new_user', '/bind invalid-token-xxx');

    const reply = await adapter.waitForReply('Invalid token', 5_000);
    expect(reply.platformUserId).toBe('new_user');
  }, 10_000);

  // ── 9. 多 adapter 隔离 ────────────────────────────────────────

  it('message targets correct adapter, other adapter does not receive', async () => {
    // 创建第二个 adapter 和 bridge。
    const adapter2 = new MockAdapter('mock2');
    const bridge2 = new AdapterBridge(adapter2, bus);
    await bridge2.start();

    try {
      adapter.reset();
      adapter2.reset();

      // 用户通过 adapter1 发消息。
      await adapter.simulateMessage('mock_user_1', 'Reply with exactly: MULTI_ADAPTER_OK');
      await adapter.waitForReply('MULTI_ADAPTER_OK');

      // adapter2 不应收到消息（没有绑定用户）。
      // 等待短暂时间确认。
      await new Promise((r) => setTimeout(r, 1000));
      const adapter2HasReply = adapter2.sentMessages.some((m) => m.text.includes('MULTI_ADAPTER_OK'));
      expect(adapter2HasReply).toBe(false);
    } finally {
      await bridge2.stop();
    }
  }, 120_000);

  // ── 10. 广播消息（cron source） ────────────────────────────────

  it('broadcast messages (cron source) are delivered to all bound adapters', async () => {
    // 创建第二个 adapter 并绑定同一用户。
    const adapter2 = new MockAdapter('mock2');
    const bridge2 = new AdapterBridge(adapter2, bus);
    await bridge2.start();

    // 绑定用户到第二个平台。
    const { bindPlatform } = await import('../../src/user/manager.js');
    const { listUsers } = await import('../../src/user/manager.js');
    const users = listUsers();
    const testUser = users.find((u) => u.userId === userId)!;
    bindPlatform(testUser.token, 'mock2', 'mock2_user_1');

    try {
      adapter.reset();
      adapter2.reset();

      // 模拟 cron 触发（直接 emit msg:in，source 为 cron）。
      bus.emit('msg:in', {
        userId,
        source: 'cron',
        text: 'Reply with exactly: BROADCAST_CRON_OK',
      });

      // 两个 adapter 都应收到回复。
      const reply1 = await adapter.waitForReply('BROADCAST_CRON_OK');
      const reply2 = await adapter2.waitForReply('BROADCAST_CRON_OK');

      expect(reply1.text).toContain('BROADCAST_CRON_OK');
      expect(reply2.text).toContain('BROADCAST_CRON_OK');
    } finally {
      await bridge2.stop();
    }
  }, 120_000);

  // ── 11. EventBus 事件传播验证 ──────────────────────────────────

  it('msg:in and msg:out events are emitted on the bus', async () => {
    const msgInEvents: any[] = [];
    const msgOutEvents: any[] = [];

    const unsubIn = bus.on('msg:in', (p) => {
      if (p.userId === userId) msgInEvents.push(p);
    });
    const unsubOut = bus.on('msg:out', (p) => {
      if (p.userId === userId) msgOutEvents.push(p);
    });

    adapter.reset();
    await adapter.simulateMessage('mock_user_1', 'Reply with exactly: EVENT_TRACE_OK');
    await adapter.waitForReply('EVENT_TRACE_OK');

    unsubIn();
    unsubOut();

    // 应至少有一条 msg:in（用户消息）。
    expect(msgInEvents.length).toBeGreaterThanOrEqual(1);
    expect(msgInEvents[0].source).toBe('mock');
    expect(msgInEvents[0].text).toBe('Reply with exactly: EVENT_TRACE_OK');

    // 应至少有一条 msg:out（agent 回复）。
    expect(msgOutEvents.length).toBeGreaterThanOrEqual(1);
    // msg:out 的 target 应该是消息来源平台。
    const replyEvent = msgOutEvents.find((e) => e.text?.includes('EVENT_TRACE_OK'));
    expect(replyEvent).toBeTruthy();
    expect(replyEvent.target).toBe('mock');
  }, 120_000);

  // ── 12. 多轮对话上下文保持 ─────────────────────────────────────

  it('agent maintains context across multiple messages through EventBus', async () => {
    adapter.reset();

    // 第一轮：告诉 agent 一个关键词。
    await adapter.simulateMessage('mock_user_1', 'Remember the word PAPAYA_99. Just confirm you got it.');
    await adapter.waitForAgentDone('mock_user_1');

    adapter.reset();

    // 第二轮：要求 agent 回忆。
    await adapter.simulateMessage('mock_user_1', 'What was the word I just told you? Reply with only the word.');
    const reply = await adapter.waitForReply('PAPAYA_99');

    expect(reply.text).toContain('PAPAYA_99');
  }, 240_000);
});
