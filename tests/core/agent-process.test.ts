import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createInputChannel, AgentProcess } from '../../src/core/agent-process.js';
import { query } from '@anthropic-ai/claude-agent-sdk';

// ---- createInputChannel 单元测试 ----

describe('createInputChannel', () => {
  it('should resolve immediately when value is pushed before next()', async () => {
    const channel = createInputChannel<string>();
    channel.push('hello');
    const iter = channel.iterable[Symbol.asyncIterator]();
    const result = await iter.next();
    expect(result).toEqual({ value: 'hello', done: false });
  });

  it('should queue multiple values and return them in order', async () => {
    const channel = createInputChannel<number>();
    channel.push(1);
    channel.push(2);
    channel.push(3);

    const iter = channel.iterable[Symbol.asyncIterator]();
    expect((await iter.next()).value).toBe(1);
    expect((await iter.next()).value).toBe(2);
    expect((await iter.next()).value).toBe(3);
  });

  it('should wait for push when next() is called before value is available', async () => {
    const channel = createInputChannel<string>();
    const iter = channel.iterable[Symbol.asyncIterator]();

    // Start waiting for next (will block until push).
    const promise = iter.next();

    // Push after a small delay.
    setTimeout(() => channel.push('delayed'), 10);

    const result = await promise;
    expect(result).toEqual({ value: 'delayed', done: false });
  });

  it('should signal done when end() is called while waiting', async () => {
    const channel = createInputChannel<string>();
    const iter = channel.iterable[Symbol.asyncIterator]();

    const promise = iter.next();
    setTimeout(() => channel.end(), 10);

    const result = await promise;
    expect(result.done).toBe(true);
  });

  it('should signal done for subsequent calls after end()', async () => {
    const channel = createInputChannel<string>();
    channel.end();

    const iter = channel.iterable[Symbol.asyncIterator]();
    const result = await iter.next();
    expect(result.done).toBe(true);
  });

  it('should ignore push after end()', async () => {
    const channel = createInputChannel<string>();
    channel.push('before');
    channel.end();
    channel.push('after'); // Should be ignored.

    const iter = channel.iterable[Symbol.asyncIterator]();
    // First queued value should still be available.
    const r1 = await iter.next();
    expect(r1).toEqual({ value: 'before', done: false });
    // Then done.
    const r2 = await iter.next();
    expect(r2.done).toBe(true);
  });

  it('should handle interleaved push/next correctly', async () => {
    const channel = createInputChannel<string>();
    const iter = channel.iterable[Symbol.asyncIterator]();

    // Push → next (immediate).
    channel.push('a');
    expect((await iter.next()).value).toBe('a');

    // next → push (delayed).
    const p = iter.next();
    channel.push('b');
    expect((await p).value).toBe('b');

    // Push → push → next → next.
    channel.push('c');
    channel.push('d');
    expect((await iter.next()).value).toBe('c');
    expect((await iter.next()).value).toBe('d');
  });

  it('return() should signal done', async () => {
    const channel = createInputChannel<string>();
    const iter = channel.iterable[Symbol.asyncIterator]();

    const result = await iter.return!(undefined as unknown as string);
    expect(result.done).toBe(true);
  });
});

// ---- AgentProcess 单元测试 ----

// Mock SDK query function.
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

// Mock logger.
vi.mock('../../src/logger/index.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const mockedQuery = vi.mocked(query);

/** 创建一个 mock Query 对象（模拟 SDK 返回的 AsyncGenerator）。 */
function createMockQuery(messages: Array<Record<string, unknown>> = []) {
  let idx = 0;
  return {
    next: vi.fn().mockImplementation(() => {
      if (idx < messages.length) {
        return Promise.resolve({ value: messages[idx++], done: false });
      }
      return Promise.resolve({ value: undefined, done: true });
    }),
    return: vi.fn().mockResolvedValue({ value: undefined, done: true }),
    throw: vi.fn(),
    close: vi.fn(),
    interrupt: vi.fn().mockResolvedValue(undefined),
    setMcpServers: vi.fn().mockResolvedValue({ added: [], removed: [], errors: {} }),
    [Symbol.asyncIterator]: function () { return this; },
  };
}

describe('AgentProcess', () => {
  let proc: AgentProcess;

  beforeEach(() => {
    proc = new AgentProcess('test-user');
    vi.clearAllMocks();
  });

  afterEach(() => {
    proc.close();
  });

  describe('lifecycle', () => {
    it('should start with isAlive=false', () => {
      expect(proc.isAlive).toBe(false);
      expect(proc.sdkRestartState).toBe('clean');
      expect(proc.sdkSessionId).toBeNull();
    });

    it('should be alive after start()', () => {
      mockedQuery.mockReturnValue(createMockQuery() as any);
      proc.start({ systemPrompt: 'test' } as any);
      expect(proc.isAlive).toBe(true);
      expect(proc.sdkRestartState).toBe('clean');
    });

    it('should not be alive after close()', () => {
      mockedQuery.mockReturnValue(createMockQuery() as any);
      proc.start({ systemPrompt: 'test' } as any);
      expect(proc.isAlive).toBe(true);

      proc.close();
      expect(proc.isAlive).toBe(false);
    });

    it('should throw when pushMessage() called before start()', () => {
      expect(() => proc.pushMessage('hello')).toThrow('AgentProcess not started');
    });

    it('should auto-close old process when start() called while alive', () => {
      const mock1 = createMockQuery();
      mockedQuery.mockReturnValue(mock1 as any);
      proc.start({} as any);

      const mock2 = createMockQuery();
      mockedQuery.mockReturnValue(mock2 as any);
      proc.start({} as any); // Should close mock1 first.

      expect(mock1.close).toHaveBeenCalled();
      expect(proc.isAlive).toBe(true);
    });
  });

  describe('three-state SDK restart flag', () => {
    it('should transition clean → dirty → restarting → clean', async () => {
      mockedQuery.mockReturnValue(createMockQuery() as any);
      proc.start({ systemPrompt: 'v1' } as any);
      expect(proc.sdkRestartState).toBe('clean');

      proc.markDirty('test');
      expect(proc.sdkRestartState).toBe('dirty');

      mockedQuery.mockReturnValue(createMockQuery() as any);
      await proc.sdkRestart({ systemPrompt: 'v2' } as any);
      expect(proc.sdkRestartState).toBe('clean');
      expect(proc.isAlive).toBe(true);
    });

    it('markDirty should be idempotent when already dirty', () => {
      mockedQuery.mockReturnValue(createMockQuery() as any);
      proc.start({} as any);
      proc.markDirty('reason1');
      proc.markDirty('reason2');
      expect(proc.sdkRestartState).toBe('dirty');
    });

    it('waitForSdkRestart should resolve immediately if not restarting', async () => {
      await proc.waitForSdkRestart(); // Should not hang.
    });

    it('ensureSdkReady should SDK restart when dirty', async () => {
      mockedQuery.mockReturnValue(createMockQuery() as any);
      proc.start({} as any);
      proc.markDirty('test');

      mockedQuery.mockReturnValue(createMockQuery() as any);
      const restarted = await proc.ensureSdkReady(() => ({ systemPrompt: 'new' } as any));
      expect(restarted).toBe(true);
      expect(proc.sdkRestartState).toBe('clean');
    });

    it('ensureSdkReady should return false when clean', async () => {
      mockedQuery.mockReturnValue(createMockQuery() as any);
      proc.start({} as any);
      const restarted = await proc.ensureSdkReady(() => ({} as any));
      expect(restarted).toBe(false);
    });

    it('sdkRestart should not duplicate when called concurrently', async () => {
      let startCount = 0;
      mockedQuery.mockImplementation(() => {
        startCount++;
        return createMockQuery() as any;
      });

      proc.start({} as any);
      const initialCount = startCount;

      proc.markDirty('test');
      const p1 = proc.sdkRestart({} as any);
      const p2 = proc.sdkRestart({} as any);
      await Promise.all([p1, p2]);

      // 第二次 sdkRestart 应该只等待第一次完成，不创建新进程。
      expect(startCount).toBe(initialCount + 1);
      expect(proc.sdkRestartState).toBe('clean');
    });
  });

  describe('sdkSessionId', () => {
    it('should get/set sdkSessionId', () => {
      expect(proc.sdkSessionId).toBeNull();
      proc.sdkSessionId = 'test-session-123';
      expect(proc.sdkSessionId).toBe('test-session-123');
    });
  });

  describe('nextMessage', () => {
    it('should return null when process not started', async () => {
      const result = await proc.nextMessage();
      expect(result).toBeNull();
    });

    it('should return messages from the query generator', async () => {
      const messages = [
        { type: 'system', subtype: 'init', session_id: 'sid-1' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } },
        { type: 'result', subtype: 'success', result: 'hello' },
      ];
      mockedQuery.mockReturnValue(createMockQuery(messages) as any);
      proc.start({} as any);

      const msg1 = await proc.nextMessage();
      expect(msg1).toEqual(messages[0]);

      const msg2 = await proc.nextMessage();
      expect(msg2).toEqual(messages[1]);

      const msg3 = await proc.nextMessage();
      expect(msg3).toEqual(messages[2]);
    });

    it('should return null when generator is done (process exit)', async () => {
      mockedQuery.mockReturnValue(createMockQuery([]) as any);
      proc.start({} as any);

      const result = await proc.nextMessage();
      expect(result).toBeNull();
      expect(proc.isAlive).toBe(false); // Process exited.
    });

    it('should handle generator errors by throwing and marking process dead', async () => {
      const mockQ = createMockQuery();
      mockQ.next.mockRejectedValueOnce(new Error('subprocess crashed'));
      mockedQuery.mockReturnValue(mockQ as any);
      proc.start({} as any);

      await expect(proc.nextMessage()).rejects.toThrow('subprocess crashed');
      expect(proc.isAlive).toBe(false);
    });
  });

  describe('pushMessage', () => {
    it('should push a properly formatted SDKUserMessage', () => {
      mockedQuery.mockReturnValue(createMockQuery() as any);
      proc.start({} as any);
      proc.sdkSessionId = 'test-sid';

      // pushMessage pushes to the input channel. We can't directly inspect it,
      // but we verify it doesn't throw and the process is still alive.
      expect(() => proc.pushMessage('hello world')).not.toThrow();
      expect(proc.isAlive).toBe(true);
    });
  });

  describe('interrupt', () => {
    it('should call interrupt on the query instance', async () => {
      const mockQ = createMockQuery();
      mockedQuery.mockReturnValue(mockQ as any);
      proc.start({} as any);

      await proc.interrupt();
      expect(mockQ.interrupt).toHaveBeenCalled();
    });

    it('should be a no-op when not started', async () => {
      await proc.interrupt(); // Should not throw.
    });
  });

  describe('setMcpServers', () => {
    it('should call setMcpServers on the query instance', async () => {
      const mockQ = createMockQuery();
      mockQ.setMcpServers.mockResolvedValue({ added: ['test'], removed: [], errors: {} });
      mockedQuery.mockReturnValue(mockQ as any);
      proc.start({} as any);

      const result = await proc.setMcpServers({ test: { command: 'echo' } } as any);
      expect(mockQ.setMcpServers).toHaveBeenCalledWith({ test: { command: 'echo' } });
      expect(result).toEqual({ added: ['test'], removed: [], errors: {} });
    });

    it('should return null when not started', async () => {
      const result = await proc.setMcpServers({});
      expect(result).toBeNull();
    });
  });
});
