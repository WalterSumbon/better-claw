import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'path';
import { createTestEnv } from '../helpers/setup.js';
import { resetConfig, setConfig } from '../../src/config/index.js';
import { AppConfigSchema } from '../../src/config/schema.js';

/**
 * 中断模式（interactionMode: "interrupt"）集成测试。
 *
 * 通过 mock agent 模块来测试队列行为，不实际调用 SDK。
 * 覆盖场景：
 * - 中断模式下新消息入队时是否触发 interruptAgent
 * - 排队模式下不触发 interrupt
 * - 中断后 processNext 是否合并积压消息
 * - 多消息合并包含图片和文件
 */

// Mock agent module: intercept sendToAgent and interruptAgent.
const sendToAgentMock = vi.fn<(...args: unknown[]) => Promise<{ type: string; subtype: string; result: string }>>()
  .mockResolvedValue({ type: 'result', subtype: 'success', result: 'ok' });
const interruptAgentMock = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

vi.mock('../../src/core/agent.js', () => ({
  sendToAgent: (...args: unknown[]) => sendToAgentMock(...args),
  interruptAgent: (...args: unknown[]) => interruptAgentMock(...args),
  AgentInterruptedError: class AgentInterruptedError extends Error {
    constructor() {
      super('Agent interrupted by user');
      this.name = 'AgentInterruptedError';
    }
  },
  RateLimitError: class RateLimitError extends Error {
    resetsAt: number | null;
    constructor(resetsAt: number | null) {
      super('Rate limit exceeded');
      this.name = 'RateLimitError';
      this.resetsAt = resetsAt;
    }
  },
}));

describe('Queue interrupt mode', () => {
  let dataDir: string;
  let cleanup: () => Promise<void>;

  beforeEach(() => {
    const env = createTestEnv();
    dataDir = env.dataDir;
    cleanup = env.cleanup;
    sendToAgentMock.mockClear();
    interruptAgentMock.mockClear();
  });

  afterEach(async () => {
    await cleanup();
  });

  /** 用指定的 interactionMode 重新配置。 */
  function reconfigure(mode: 'queue' | 'interrupt'): void {
    resetConfig();
    const config = AppConfigSchema.parse({
      dataDir,
      logging: { directory: join(dataDir, 'logs') },
      messagePush: {
        pushIntermediateMessages: true,
        interactionMode: mode,
      },
    });
    setConfig(config);
  }

  function makeMessage(text: string, userId = 'user_test') {
    return {
      userId,
      text,
      reply: vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined),
      sendFile: vi.fn<(path: string) => Promise<void>>().mockResolvedValue(undefined),
      showTyping: vi.fn(),
      platform: 'test',
    };
  }

  it('should call interruptAgent when new message arrives in interrupt mode', async () => {
    reconfigure('interrupt');

    // Simulate a long-running sendToAgent that can be interrupted
    let resolveAgent!: () => void;
    const agentPromise = new Promise<void>((resolve) => {
      resolveAgent = resolve;
    });

    sendToAgentMock.mockImplementationOnce(async () => {
      await agentPromise;
      return { type: 'result', subtype: 'success', result: 'first done' };
    });

    const { enqueue } = await import('../../src/core/queue.js');

    // Enqueue first message — starts processing
    const msg1 = makeMessage('first message');
    enqueue(msg1);

    // Wait a tick for processNext to pick up msg1
    await new Promise((r) => setTimeout(r, 10));

    // Enqueue second message while first is being processed
    const msg2 = makeMessage('second message');
    enqueue(msg2);

    // interruptAgent should have been called
    expect(interruptAgentMock).toHaveBeenCalledWith('user_test');

    // Let the first agent complete
    resolveAgent();
    await new Promise((r) => setTimeout(r, 50));
  });

  it('should NOT call interruptAgent in queue mode', async () => {
    reconfigure('queue');

    let resolveAgent!: () => void;
    const agentPromise = new Promise<void>((resolve) => {
      resolveAgent = resolve;
    });

    sendToAgentMock.mockImplementationOnce(async () => {
      await agentPromise;
      return { type: 'result', subtype: 'success', result: 'done' };
    });

    const { enqueue } = await import('../../src/core/queue.js');

    const msg1 = makeMessage('first');
    enqueue(msg1);

    await new Promise((r) => setTimeout(r, 10));

    const msg2 = makeMessage('second');
    enqueue(msg2);

    // In queue mode, interruptAgent should NOT be called
    expect(interruptAgentMock).not.toHaveBeenCalled();

    resolveAgent();
    await new Promise((r) => setTimeout(r, 50));
  });

  it('should merge multiple queued messages after interrupt', async () => {
    reconfigure('interrupt');

    const { AgentInterruptedError } = await import('../../src/core/agent.js');

    // First call: will be interrupted
    sendToAgentMock.mockImplementationOnce(async () => {
      // Simulate slow processing
      await new Promise((r) => setTimeout(r, 100));
      throw new (AgentInterruptedError as unknown as new () => Error)();
    });

    // Second call: receives the merged message
    sendToAgentMock.mockImplementationOnce(async () => {
      return { type: 'result', subtype: 'success', result: 'merged response' };
    });

    const { enqueue } = await import('../../src/core/queue.js');

    // Send first message
    enqueue(makeMessage('帮我看下这个函数'));

    // Wait a tick, then queue more messages
    await new Promise((r) => setTimeout(r, 10));
    enqueue(makeMessage('就是那个 handleMessage'));
    enqueue(makeMessage('在 index.ts 里'));

    // Wait for everything to complete
    await new Promise((r) => setTimeout(r, 300));

    // The second sendToAgent call should receive the merged text
    expect(sendToAgentMock).toHaveBeenCalledTimes(2);
    const secondCallArgs = sendToAgentMock.mock.calls[1];
    const mergedText = secondCallArgs[1] as string;
    expect(mergedText).toContain('就是那个 handleMessage');
    expect(mergedText).toContain('在 index.ts 里');
  });

  it('should merge messages with images and files after interrupt', async () => {
    reconfigure('interrupt');

    const { AgentInterruptedError } = await import('../../src/core/agent.js');

    sendToAgentMock.mockImplementationOnce(async () => {
      await new Promise((r) => setTimeout(r, 100));
      throw new (AgentInterruptedError as unknown as new () => Error)();
    });

    sendToAgentMock.mockImplementationOnce(async () => {
      return { type: 'result', subtype: 'success', result: 'done' };
    });

    const { enqueue } = await import('../../src/core/queue.js');

    enqueue(makeMessage('请分析以下内容'));
    await new Promise((r) => setTimeout(r, 10));

    enqueue(makeMessage('[用户发送了图片: /tmp/screenshot.png]\n界面截图'));
    enqueue(makeMessage('[用户发送了文件: /tmp/error.log (error.log)]\n错误日志'));
    enqueue(makeMessage('[用户发送了图片: /tmp/debug.jpg]\n调试截图'));

    await new Promise((r) => setTimeout(r, 300));

    expect(sendToAgentMock).toHaveBeenCalledTimes(2);
    const mergedText = sendToAgentMock.mock.calls[1][1] as string;
    expect(mergedText).toContain('screenshot.png');
    expect(mergedText).toContain('error.log');
    expect(mergedText).toContain('debug.jpg');
    expect(mergedText).toContain('界面截图');
    expect(mergedText).toContain('错误日志');
    expect(mergedText).toContain('调试截图');
  });
});
