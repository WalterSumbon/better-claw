import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventBus } from '../../src/core/event-bus.js';
import { BusAgent, BusAgentManager } from '../../src/core/bus-agent.js';
import type { MsgInPayload, MsgOutPayload, AgentStatePayload } from '../../src/core/event-bus.js';
import type { QueueStrategy, CommandHandler } from '../../src/core/bus-agent.js';

// ---- Mocks ----

// Mock logger
vi.mock('../../src/logger/index.js', () => ({
  getLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  }),
}));

// Mock config
vi.mock('../../src/config/index.js', () => ({
  getConfig: () => ({
    messageEnvelope: { enabled: false },
  }),
}));

// Mock user store
vi.mock('../../src/user/store.js', () => ({
  readProfile: () => null,
}));

// Mock timezone utils
vi.mock('../../src/utils/timezone.js', () => ({
  resolveTimezone: () => 'Asia/Shanghai',
  formatLocalTime: () => '2026-03-12 16:00:00',
  getUtcOffset: () => 'UTC+8',
}));

// Mock agent module
const sendToAgentMock = vi.fn();
const interruptAgentMock = vi.fn().mockResolvedValue(undefined);
const resetAgentSessionMock = vi.fn();

vi.mock('../../src/core/agent.js', () => {
  class AgentInterruptedError extends Error {
    constructor() {
      super('Agent interrupted by user');
      this.name = 'AgentInterruptedError';
    }
  }

  class RateLimitError extends Error {
    resetsAt: number | null;
    constructor(resetsAt: number | null) {
      super('Rate limit exceeded');
      this.name = 'RateLimitError';
      this.resetsAt = resetsAt;
    }
  }

  return {
    sendToAgent: (...args: unknown[]) => sendToAgentMock(...args),
    interruptAgent: (...args: unknown[]) => interruptAgentMock(...args),
    resetAgentSession: (...args: unknown[]) => resetAgentSessionMock(...args),
    AgentInterruptedError,
    RateLimitError,
  };
});

// ---- Helpers ----

/** 创建一个简单的 msg:in payload。 */
function makeMsg(text: string, source = 'telegram', userId = 'user1'): MsgInPayload {
  return { userId, source, text };
}

/** 模拟 sendToAgent 的默认行为：返回成功结果，触发 assistant + message_stop。 */
function mockSendToAgentSuccess(responseText = 'Hello!') {
  sendToAgentMock.mockImplementation(
    async (
      _userId: string,
      _message: string,
      onMessage: (msg: unknown) => void,
    ) => {
      // 模拟 assistant 消息。
      onMessage({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: responseText }],
        },
      });
      // 模拟 message_stop（assistant 消息结束信号）。
      onMessage({
        type: 'stream_event',
        event: { type: 'message_stop' },
      });
      return { type: 'result', subtype: 'success', result: responseText };
    },
  );
}

/** 模拟 sendToAgent 延迟执行（用于测试并发和中断）。 */
function mockSendToAgentSlow(responseText = 'Done', delayMs = 50) {
  sendToAgentMock.mockImplementation(
    async (
      _userId: string,
      _message: string,
      onMessage: (msg: unknown) => void,
    ) => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      onMessage({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: responseText }],
        },
      });
      onMessage({
        type: 'stream_event',
        event: { type: 'message_stop' },
      });
      return { type: 'result', subtype: 'success', result: responseText };
    },
  );
}

/** 收集 bus 上的 msg:out 事件。 */
function collectMsgOut(bus: EventBus): MsgOutPayload[] {
  const events: MsgOutPayload[] = [];
  bus.on('msg:out', (payload) => events.push(payload));
  return events;
}

/** 收集 bus 上的 agent 状态事件。 */
function collectStateEvents(bus: EventBus): Array<{ event: string; payload: AgentStatePayload }> {
  const events: Array<{ event: string; payload: AgentStatePayload }> = [];
  bus.on('agent:busy', (payload) => events.push({ event: 'agent:busy', payload }));
  bus.on('agent:idle', (payload) => events.push({ event: 'agent:idle', payload }));
  return events;
}

/** 等待所有微任务完成。 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// ---- 测试 ----

describe('BusAgent', () => {
  let bus: EventBus;
  let agent: BusAgent;

  beforeEach(() => {
    vi.clearAllMocks();
    bus = new EventBus();
    agent = new BusAgent('user1', bus, { commandPrefix: '/' });
  });

  afterEach(async () => {
    // 等待前一个测试中任何 orphaned 的异步操作（如 slow query mock）结算，
    // 防止它们在下一个测试中消费 sendToAgentMock 的 mockOnce 设置。
    agent.dispose();
    await new Promise((resolve) => setTimeout(resolve, 150));
  });

  // ---- 基本消息处理 ----

  describe('message processing', () => {
    it('should call sendToAgent with message text', async () => {
      mockSendToAgentSuccess();
      const msgOut = collectMsgOut(bus);

      agent.handleMessage(makeMsg('hello'));
      await flush();

      expect(sendToAgentMock).toHaveBeenCalledOnce();
      expect(sendToAgentMock.mock.calls[0][0]).toBe('user1');
      expect(sendToAgentMock.mock.calls[0][1]).toBe('hello'); // envelope disabled
    });

    it('should emit streaming chunk + streaming final (with text), no post-query complete', async () => {
      mockSendToAgentSuccess('Hi there');
      const msgOut = collectMsgOut(bus);

      agent.handleMessage(makeMsg('hello'));
      await flush();

      // streaming chunk 带累积文本。
      const chunks = msgOut.filter((m) => m.streaming && !m.final);
      expect(chunks.length).toBeGreaterThanOrEqual(1);
      expect(chunks[0].text).toBe('Hi there');

      // streaming final 带完整文本。
      const finals = msgOut.filter((m) => m.streaming && m.final);
      expect(finals.length).toBe(1);
      expect(finals[0].text).toBe('Hi there');

      // 有流式输出时不发 complete。
      const complete = msgOut.filter((m) => !m.streaming);
      expect(complete.length).toBe(0);
    });

    it('should emit agent:busy and agent:idle events', async () => {
      mockSendToAgentSuccess();
      const states = collectStateEvents(bus);

      agent.handleMessage(makeMsg('hello'));
      await flush();

      expect(states.length).toBe(2);
      expect(states[0].event).toBe('agent:busy');
      expect(states[0].payload.userId).toBe('user1');
      expect(states[1].event).toBe('agent:idle');
      expect(states[1].payload.userId).toBe('user1');
    });
  });

  // ---- 指令处理 ----

  describe('command handling', () => {
    it('should route /stop to command queue and call interruptAgent', async () => {
      const msgOut = collectMsgOut(bus);

      agent.handleMessage(makeMsg('/stop'));
      await flush();

      expect(interruptAgentMock).toHaveBeenCalledWith('user1');
      expect(sendToAgentMock).not.toHaveBeenCalled(); // 不走普通队列
      expect(msgOut.some((m) => m.text?.includes('Stopped'))).toBe(true);
    });

    it('should route /new to command queue and reset session', async () => {
      const msgOut = collectMsgOut(bus);

      agent.handleMessage(makeMsg('/new'));
      await flush();

      expect(interruptAgentMock).toHaveBeenCalledWith('user1');
      expect(resetAgentSessionMock).toHaveBeenCalledWith('user1');
      expect(msgOut.some((m) => m.text?.includes('New session'))).toBe(true);
    });

    it('should treat unregistered commands as regular messages', async () => {
      mockSendToAgentSuccess();

      agent.handleMessage(makeMsg('/unknown hello'));
      await flush();

      expect(sendToAgentMock).toHaveBeenCalledOnce(); // 走普通队列
      expect(interruptAgentMock).not.toHaveBeenCalled();
    });

    it('should support custom command registration', async () => {
      const customHandler = vi.fn(async (_uid, _args, reply) => {
        reply('Custom!');
      }) as unknown as CommandHandler;

      agent.registerCommand('custom', customHandler);
      const msgOut = collectMsgOut(bus);

      agent.handleMessage(makeMsg('/custom arg1 arg2'));
      await flush();

      expect(customHandler).toHaveBeenCalledOnce();
      expect(customHandler).toHaveBeenCalledWith('user1', 'arg1 arg2', expect.any(Function), expect.objectContaining({ userId: 'user1', text: '/custom arg1 arg2' }));
      expect(msgOut.some((m) => m.text === 'Custom!')).toBe(true);
    });

    it('should parse command name and args correctly', async () => {
      const handler = vi.fn(async () => {}) as unknown as CommandHandler;
      agent.registerCommand('test', handler);

      agent.handleMessage(makeMsg('/test'));
      await flush();
      expect(handler).toHaveBeenCalledWith('user1', '', expect.any(Function), expect.objectContaining({ userId: 'user1', text: '/test' }));

      handler.mockClear();
      agent.handleMessage(makeMsg('/test   some args  '));
      await flush();
      expect(handler).toHaveBeenCalledWith('user1', 'some args', expect.any(Function), expect.objectContaining({ userId: 'user1', text: '/test   some args  ' }));
    });
  });

  // ---- Sequential 策略 ----

  describe('sequential strategy', () => {
    it('should process messages one by one in order', async () => {
      const callOrder: string[] = [];
      sendToAgentMock.mockImplementation(
        async (_userId: string, message: string, onMessage: (msg: unknown) => void) => {
          callOrder.push(message);
          onMessage({
            type: 'assistant',
            message: { content: [{ type: 'text', text: `reply to: ${message}` }] },
          });
          return { type: 'result', subtype: 'success', result: `reply to: ${message}` };
        },
      );

      agent.handleMessage(makeMsg('first'));
      agent.handleMessage(makeMsg('second'));
      agent.handleMessage(makeMsg('third'));

      // 等待所有处理完成。
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(callOrder).toEqual(['first', 'second', 'third']);
    });
  });

  // ---- Merge 策略 ----

  describe('merge strategy', () => {
    it('should merge accumulated messages after current query finishes', async () => {
      const mergeAgent = new BusAgent('user1', bus, { queueStrategy: 'merge' });
      const callOrder: string[] = [];

      sendToAgentMock.mockImplementation(
        async (_userId: string, message: string, onMessage: (msg: unknown) => void) => {
          callOrder.push(message);
          // 第一次调用延迟，让其他消息有时间入队。
          if (callOrder.length === 1) {
            await new Promise((resolve) => setTimeout(resolve, 30));
          }
          onMessage({
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'ok' }] },
          });
          return { type: 'result', subtype: 'success', result: 'ok' };
        },
      );

      mergeAgent.handleMessage(makeMsg('first'));
      // 在第一条执行过程中入队两条。
      await new Promise((resolve) => setTimeout(resolve, 10));
      mergeAgent.handleMessage(makeMsg('second'));
      mergeAgent.handleMessage(makeMsg('third'));

      await new Promise((resolve) => setTimeout(resolve, 100));

      // 第一条单独执行，后两条合并执行。
      expect(callOrder.length).toBe(2);
      expect(callOrder[0]).toBe('first');
      expect(callOrder[1]).toContain('second');
      expect(callOrder[1]).toContain('third');
    });
  });

  // ---- Interrupt 策略 ----

  describe('interrupt strategy', () => {
    it('should call interruptAgent when new message arrives during processing', async () => {
      const interruptAgent = new BusAgent('user1', bus, { queueStrategy: 'interrupt' });

      mockSendToAgentSlow('result', 50);

      interruptAgent.handleMessage(makeMsg('first'));
      await new Promise((resolve) => setTimeout(resolve, 10));

      // 在第一条执行期间发送新消息。
      interruptAgent.handleMessage(makeMsg('second'));

      expect(interruptAgentMock).toHaveBeenCalled();
    });
  });

  // ---- 指令不阻塞普通队列 ----

  describe('dual queue independence', () => {
    it('should process commands independently from message queue', async () => {
      const events: string[] = [];

      // 模拟慢 query。
      sendToAgentMock.mockImplementation(
        async (_userId: string, message: string, onMessage: (msg: unknown) => void) => {
          events.push(`query:start:${message}`);
          await new Promise((resolve) => setTimeout(resolve, 50));
          onMessage({
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'ok' }] },
          });
          events.push(`query:end:${message}`);
          return { type: 'result', subtype: 'success', result: 'ok' };
        },
      );

      // 发送普通消息（开始执行 slow query）。
      agent.handleMessage(makeMsg('slow task'));
      await new Promise((resolve) => setTimeout(resolve, 10));

      // 在 query 执行过程中发送 /stop 指令。
      agent.handleMessage(makeMsg('/stop'));
      await new Promise((resolve) => setTimeout(resolve, 10));

      // /stop 应该已经执行了（不等待普通队列）。
      expect(interruptAgentMock).toHaveBeenCalled();
    });
  });

  // ---- Rate limit 处理 ----

  describe('rate limit handling', () => {
    it('should pause queue and notify user on rate limit', async () => {
      // 第一次调用抛 RateLimitError。
      const { RateLimitError } = await import('../../src/core/agent.js');
      sendToAgentMock.mockRejectedValueOnce(new RateLimitError(Date.now() + 5000));
      const msgOut = collectMsgOut(bus);

      agent.handleMessage(makeMsg('hello'));
      await flush();

      // 应该有 rate limit 通知。
      expect(msgOut.some((m) => m.text?.includes('Rate limited'))).toBe(true);
    });

    it('should re-queue original payloads without double envelope', async () => {
      const { RateLimitError } = await import('../../src/core/agent.js');
      const callTexts: string[] = [];

      // 第一次调用抛 RateLimitError。
      // 注意：handleRateLimit 最小延迟 1000ms（Math.max(delayMs, 1000)）。
      sendToAgentMock.mockImplementationOnce(async () => {
        throw new RateLimitError(Date.now() + 100);
      });
      // 第二次调用（恢复后）正常返回，记录传入的文本。
      sendToAgentMock.mockImplementation(
        async (_userId: string, message: string, onMessage: (msg: unknown) => void) => {
          callTexts.push(message);
          onMessage({
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'ok' }] },
          });
          return { type: 'result', subtype: 'success', result: 'ok' };
        },
      );

      agent.handleMessage(makeMsg('test message'));

      // 等待 rate limit 恢复（最小 1000ms + 余量）。
      await new Promise((resolve) => setTimeout(resolve, 1300));

      // 恢复后传给 sendToAgent 的文本应该和原始文本一致（不会被多包一层）。
      expect(callTexts.length).toBe(1);
      expect(callTexts[0]).toBe('test message');
    });

    it('should resume queue after rate limit timer fires', async () => {
      const { RateLimitError } = await import('../../src/core/agent.js');

      // 第一次调用抛 RateLimitError。
      // handleRateLimit 最小延迟 1000ms。
      sendToAgentMock.mockImplementationOnce(async () => {
        throw new RateLimitError(Date.now() + 100);
      });
      // 恢复后正常返回。
      sendToAgentMock.mockImplementation(
        async (_userId: string, _message: string, onMessage: (msg: unknown) => void) => {
          onMessage({
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'resumed!' }] },
          });
          onMessage({
            type: 'stream_event',
            event: { type: 'message_stop' },
          });
          return { type: 'result', subtype: 'success', result: 'resumed!' };
        },
      );

      const msgOut = collectMsgOut(bus);
      agent.handleMessage(makeMsg('hello'));

      // 等待 rate limit 恢复（最小 1000ms + 余量）。
      await new Promise((resolve) => setTimeout(resolve, 1300));

      // 应该有恢复后的 streaming final（带完整文本）。
      expect(msgOut.some((m) => m.text === 'resumed!' && m.streaming && m.final)).toBe(true);
    });
  });

  // ---- dispose ----

  describe('dispose', () => {
    it('should clear timers and queues on dispose', async () => {
      const { RateLimitError } = await import('../../src/core/agent.js');
      sendToAgentMock.mockRejectedValueOnce(new RateLimitError(Date.now() + 60_000));
      mockSendToAgentSuccess();

      agent.handleMessage(makeMsg('hello'));
      await flush();

      // agent 现在有 resumeTimer 和 pausedUntil。
      // dispose 应该清理它们。
      agent.dispose();

      // 发新消息不应该被 rate limit 阻止（但也不会处理，因为队列已清空）。
      // 验证 dispose 后不会 crash。
      expect(() => agent.dispose()).not.toThrow(); // 重复 dispose 安全
    });
  });

  // ---- 错误处理 ----

  describe('error handling', () => {
    it('should emit error message on query failure', async () => {
      sendToAgentMock.mockRejectedValue(new Error('SDK crashed'));
      const msgOut = collectMsgOut(bus);

      agent.handleMessage(makeMsg('hello'));
      await flush();

      expect(msgOut.some((m) => m.text?.includes('SDK crashed'))).toBe(true);
    });

    it('should handle command handler errors gracefully', async () => {
      agent.registerCommand('broken', async () => {
        throw new Error('handler broke');
      });
      const msgOut = collectMsgOut(bus);

      agent.handleMessage(makeMsg('/broken'));
      await flush();

      expect(msgOut.some((m) => m.text?.includes('handler broke'))).toBe(true);
    });
  });

  // ---- msg:out target ----

  describe('msg:out target routing', () => {
    it('should set target from msg:in source', async () => {
      mockSendToAgentSuccess();
      const msgOut = collectMsgOut(bus);

      agent.handleMessage(makeMsg('hello', 'cli'));
      await flush();

      // 所有 msg:out 的 target 应该是 'cli'。
      for (const m of msgOut) {
        expect(m.target).toBe('cli');
      }
    });
  });
});

// ---- BusAgentManager ----

describe('BusAgentManager', () => {
  let bus: EventBus;

  beforeEach(async () => {
    // 等待前一个测试的异步操作彻底结束。
    await new Promise((resolve) => setTimeout(resolve, 150));
    vi.clearAllMocks();
    bus = new EventBus();
  });

  it('should create BusAgent on first msg:in for a user', async () => {
    mockSendToAgentSuccess();

    const manager = new BusAgentManager();
    manager.start(bus);

    bus.emit('msg:in', makeMsg('hello'));
    await flush();

    expect(sendToAgentMock).toHaveBeenCalledOnce();
  });

  it('should route messages to correct user agent', async () => {
    mockSendToAgentSuccess();

    const manager = new BusAgentManager();
    manager.start(bus);

    bus.emit('msg:in', makeMsg('hello', 'telegram', 'user1'));
    bus.emit('msg:in', makeMsg('world', 'cli', 'user2'));
    await new Promise((resolve) => setTimeout(resolve, 50));

    // 验证两个用户各自调用了一次 sendToAgent。
    const user1Calls = sendToAgentMock.mock.calls.filter((c: unknown[]) => c[0] === 'user1');
    const user2Calls = sendToAgentMock.mock.calls.filter((c: unknown[]) => c[0] === 'user2');
    expect(user1Calls.length).toBe(1);
    expect(user2Calls.length).toBe(1);
  });

  it('should support global command registration', async () => {
    const handler = vi.fn(async (_uid: string, _args: string, reply: (text: string) => void) => {
      reply('Global!');
    }) as unknown as CommandHandler;

    const manager = new BusAgentManager();
    manager.registerCommand('global', handler);
    manager.start(bus);

    const msgOut = collectMsgOut(bus);
    bus.emit('msg:in', makeMsg('/global'));
    await flush();

    expect(handler).toHaveBeenCalledOnce();
    expect(msgOut.some((m) => m.text === 'Global!')).toBe(true);
  });

  it('should stop listening and dispose agents after stop()', async () => {
    mockSendToAgentSuccess();

    const manager = new BusAgentManager();
    manager.start(bus);

    // 先创建一个 agent。
    bus.emit('msg:in', makeMsg('hello'));
    await flush();

    manager.stop();

    // stop 后不再处理消息。
    sendToAgentMock.mockClear();
    bus.emit('msg:in', makeMsg('world'));
    await flush();

    expect(sendToAgentMock).not.toHaveBeenCalled();
  });

  it('should register global commands to pre-existing agents', async () => {
    const manager = new BusAgentManager();
    manager.start(bus);

    // 先创建 agent。
    mockSendToAgentSuccess();
    bus.emit('msg:in', makeMsg('hello'));
    await flush();

    // 之后注册全局指令。
    const handler = vi.fn(async (_uid: string, _args: string, reply: (text: string) => void) => {
      reply('Late!');
    }) as unknown as CommandHandler;
    manager.registerCommand('late', handler);

    const msgOut = collectMsgOut(bus);
    bus.emit('msg:in', makeMsg('/late'));
    await flush();

    expect(handler).toHaveBeenCalledOnce();
    expect(msgOut.some((m) => m.text === 'Late!')).toBe(true);
  });
});
