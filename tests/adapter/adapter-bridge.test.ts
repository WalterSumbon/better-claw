import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventBus } from '../../src/core/event-bus.js';
import { AdapterBridge } from '../../src/adapter/adapter-bridge.js';
import type { MessageAdapter, SendFileOptions } from '../../src/adapter/interface.js';
import type { InboundMessage } from '../../src/adapter/types.js';
import type { MsgOutPayload, AgentStatePayload } from '../../src/core/event-bus.js';

// ---- Mocks ----

vi.mock('../../src/logger/index.js', () => ({
  getLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  }),
}));

const resolveUserMock = vi.fn();
const bindPlatformMock = vi.fn();
const getUserMock = vi.fn();

vi.mock('../../src/user/manager.js', () => ({
  resolveUser: (...args: unknown[]) => resolveUserMock(...args),
  bindPlatform: (...args: unknown[]) => bindPlatformMock(...args),
  getUser: (...args: unknown[]) => getUserMock(...args),
}));

// ---- Helpers ----

/** 创建一个 mock MessageAdapter。 */
function createMockAdapter(platform = 'telegram'): MessageAdapter & {
  startHandler: ((msg: InboundMessage) => Promise<void>) | null;
  sendTextCalls: Array<{ platformUserId: string; text: string }>;
  sendFileCalls: Array<{ platformUserId: string; filePath: string; options?: SendFileOptions }>;
  showTypingCalls: string[];
  onAgentDoneCalls: string[];
} {
  let startHandler: ((msg: InboundMessage) => Promise<void>) | null = null;
  const sendTextCalls: Array<{ platformUserId: string; text: string }> = [];
  const sendFileCalls: Array<{ platformUserId: string; filePath: string; options?: SendFileOptions }> = [];
  const showTypingCalls: string[] = [];
  const onAgentDoneCalls: string[] = [];

  return {
    platform,
    commandPrefix: '/',
    startHandler,
    sendTextCalls,
    sendFileCalls,
    showTypingCalls,
    onAgentDoneCalls,
    async start(handler) {
      startHandler = handler;
      // 保存引用以便测试中触发。
      (this as any).startHandler = handler;
    },
    async stop() {},
    async sendText(platformUserId, text) {
      sendTextCalls.push({ platformUserId, text });
    },
    async sendFile(platformUserId, filePath, options) {
      sendFileCalls.push({ platformUserId, filePath, options });
    },
    async showTyping(platformUserId) {
      showTypingCalls.push(platformUserId);
    },
    onAgentDone(platformUserId) {
      onAgentDoneCalls.push(platformUserId);
    },
  };
}

/** 创建一个标准入站消息。 */
function makeInbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    platform: 'telegram',
    platformUserId: 'tg_123',
    text: 'hello',
    raw: {},
    isCommand: false,
    ...overrides,
  };
}

/** 等待微任务完成。 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// ---- Tests ----

describe('AdapterBridge', () => {
  let bus: EventBus;
  let adapter: ReturnType<typeof createMockAdapter>;
  let bridge: AdapterBridge;

  beforeEach(async () => {
    vi.clearAllMocks();
    bus = new EventBus();
    adapter = createMockAdapter('telegram');
    bridge = new AdapterBridge(adapter, bus);
    await bridge.start();
  });

  // ---- 基本属性 ----

  describe('properties', () => {
    it('should expose platform from underlying adapter', () => {
      expect(bridge.platform).toBe('telegram');
    });
  });

  // ---- 入站消息 → msg:in ----

  describe('inbound → msg:in', () => {
    it('should emit msg:in for resolved user', async () => {
      resolveUserMock.mockReturnValue('user1');
      const events: any[] = [];
      bus.on('msg:in', (p) => events.push(p));

      await adapter.startHandler!(makeInbound({ text: 'hello' }));
      await flush();

      expect(events.length).toBe(1);
      expect(events[0]).toEqual({
        userId: 'user1',
        source: 'telegram',
        text: 'hello',
        files: undefined,
      });
    });

    it('should call ack before processing', async () => {
      resolveUserMock.mockReturnValue('user1');
      const ack = vi.fn().mockResolvedValue(undefined);

      await adapter.startHandler!(makeInbound({ ack }));
      await flush();

      expect(ack).toHaveBeenCalledOnce();
    });

    it('should send unrecognized message for unresolved user', async () => {
      resolveUserMock.mockReturnValue(null);

      await adapter.startHandler!(makeInbound());
      await flush();

      expect(adapter.sendTextCalls.length).toBe(1);
      expect(adapter.sendTextCalls[0].text).toContain('bind');
    });

    it('should convert attachments to FileAttachment format', async () => {
      resolveUserMock.mockReturnValue('user1');
      const events: any[] = [];
      bus.on('msg:in', (p) => events.push(p));

      await adapter.startHandler!(makeInbound({
        attachments: [{
          type: 'photo',
          localPath: '/tmp/photo.jpg',
          fileName: 'photo.jpg',
          mimeType: 'image/jpeg',
        }],
      }));
      await flush();

      expect(events[0].files).toEqual([{
        type: 'photo',
        path: '/tmp/photo.jpg',
        filename: 'photo.jpg',
        mimeType: 'image/jpeg',
      }]);
    });
  });

  // ---- /bind 命令 ----

  describe('/bind command', () => {
    it('should handle /bind with valid token', async () => {
      bindPlatformMock.mockReturnValue({ userId: 'user1', name: 'Alice' });

      await adapter.startHandler!(makeInbound({
        isCommand: true,
        commandName: 'bind',
        commandArgs: 'my-token',
        text: '/bind my-token',
      }));
      await flush();

      expect(bindPlatformMock).toHaveBeenCalledWith('my-token', 'telegram', 'tg_123');
      expect(adapter.sendTextCalls.length).toBe(1);
      expect(adapter.sendTextCalls[0].text).toContain('Alice');
    });

    it('should reject /bind with invalid token', async () => {
      bindPlatformMock.mockReturnValue(null);

      await adapter.startHandler!(makeInbound({
        isCommand: true,
        commandName: 'bind',
        commandArgs: 'bad-token',
        text: '/bind bad-token',
      }));
      await flush();

      expect(adapter.sendTextCalls[0].text).toBe('Invalid token.');
    });

    it('should show usage for /bind without args', async () => {
      await adapter.startHandler!(makeInbound({
        isCommand: true,
        commandName: 'bind',
        commandArgs: '',
        text: '/bind',
      }));
      await flush();

      expect(adapter.sendTextCalls[0].text).toContain('Usage');
    });

    it('should not emit msg:in for /bind', async () => {
      bindPlatformMock.mockReturnValue({ userId: 'user1', name: 'Alice' });
      const events: any[] = [];
      bus.on('msg:in', (p) => events.push(p));

      await adapter.startHandler!(makeInbound({
        isCommand: true,
        commandName: 'bind',
        commandArgs: 'token',
        text: '/bind token',
      }));
      await flush();

      expect(events.length).toBe(0);
    });
  });

  // ---- 出站消息 msg:out → adapter ----

  describe('msg:out → adapter delivery', () => {
    it('should deliver text to correct platform user', async () => {
      // 先通过入站消息建立 userId → platformUserId 映射。
      resolveUserMock.mockReturnValue('user1');
      await adapter.startHandler!(makeInbound());
      await flush();

      bus.emit('msg:out', {
        userId: 'user1',
        target: 'telegram',
        text: 'Hello from agent!',
      });
      await flush();

      expect(adapter.sendTextCalls.some((c) => c.text === 'Hello from agent!')).toBe(true);
    });

    it('should ignore msg:out for different platform', async () => {
      resolveUserMock.mockReturnValue('user1');
      await adapter.startHandler!(makeInbound());
      await flush();

      adapter.sendTextCalls.length = 0;
      bus.emit('msg:out', {
        userId: 'user1',
        target: 'cli',
        text: 'Not for telegram',
      });
      await flush();

      expect(adapter.sendTextCalls.length).toBe(0);
    });

    it('should deliver broadcast messages (source=cron)', async () => {
      resolveUserMock.mockReturnValue('user1');
      await adapter.startHandler!(makeInbound());
      await flush();

      adapter.sendTextCalls.length = 0;
      bus.emit('msg:out', {
        userId: 'user1',
        target: 'cron',
        text: 'Cron result',
      });
      await flush();

      expect(adapter.sendTextCalls.some((c) => c.text === 'Cron result')).toBe(true);
    });

    it('should deliver broadcast messages (source=system)', async () => {
      resolveUserMock.mockReturnValue('user1');
      await adapter.startHandler!(makeInbound());
      await flush();

      adapter.sendTextCalls.length = 0;
      bus.emit('msg:out', {
        userId: 'user1',
        target: 'system',
        text: 'System message',
      });
      await flush();

      expect(adapter.sendTextCalls.some((c) => c.text === 'System message')).toBe(true);
    });

    it('should send files via adapter', async () => {
      resolveUserMock.mockReturnValue('user1');
      await adapter.startHandler!(makeInbound());
      await flush();

      bus.emit('msg:out', {
        userId: 'user1',
        target: 'telegram',
        files: [{ type: 'image', path: '/tmp/photo.jpg' }],
      });
      await flush();

      expect(adapter.sendFileCalls.length).toBe(1);
      expect(adapter.sendFileCalls[0].filePath).toBe('/tmp/photo.jpg');
    });

    it('should map image type to photo for sendFile', async () => {
      resolveUserMock.mockReturnValue('user1');
      await adapter.startHandler!(makeInbound());
      await flush();

      bus.emit('msg:out', {
        userId: 'user1',
        target: 'telegram',
        files: [{ type: 'image', path: '/tmp/photo.jpg' }],
      });
      await flush();

      expect(adapter.sendFileCalls[0].options?.type).toBe('photo');
    });
  });

  // ---- Streaming 去重 ----

  describe('streaming deduplication', () => {
    // ---- 非流式适配器（如 Telegram）：忽略 streaming 事件，只发 complete ----

    it('should ignore streaming messages for non-streaming adapter', async () => {
      resolveUserMock.mockReturnValue('user1');
      await adapter.startHandler!(makeInbound());
      await flush();

      adapter.sendTextCalls.length = 0;

      // 发送 streaming chunk（非流式适配器应忽略）。
      bus.emit('msg:out', {
        userId: 'user1',
        target: 'telegram',
        text: 'partial...',
        streaming: true,
      });
      await flush();

      expect(adapter.sendTextCalls.length).toBe(0);
    });

    it('should deliver complete message even after streaming events for non-streaming adapter', async () => {
      resolveUserMock.mockReturnValue('user1');
      await adapter.startHandler!(makeInbound());
      await flush();

      adapter.sendTextCalls.length = 0;

      // streaming final（非流式适配器应忽略）。
      bus.emit('msg:out', {
        userId: 'user1',
        target: 'telegram',
        streaming: true,
        final: true,
      });
      await flush();

      // complete message（非流式适配器应正常发送）。
      bus.emit('msg:out', {
        userId: 'user1',
        target: 'telegram',
        text: 'full response',
      });
      await flush();

      expect(adapter.sendTextCalls.length).toBe(1);
      expect(adapter.sendTextCalls[0].text).toBe('full response');
    });

    it('should deliver complete message without prior streaming', async () => {
      resolveUserMock.mockReturnValue('user1');
      await adapter.startHandler!(makeInbound());
      await flush();

      adapter.sendTextCalls.length = 0;

      // 直接发 complete（无 streaming）。
      bus.emit('msg:out', {
        userId: 'user1',
        target: 'telegram',
        text: 'direct response',
      });
      await flush();

      expect(adapter.sendTextCalls.some((c) => c.text === 'direct response')).toBe(true);
    });

    // ---- 流式适配器（如 AgentElegram）：转发 streaming 事件，dedup complete ----

    it('should forward streaming messages for streaming adapter', async () => {
      // 创建流式适配器。
      const streamAdapter = createMockAdapter('agentelegram');
      (streamAdapter as any).supportsStreaming = true;
      const streamBridge = new AdapterBridge(streamAdapter, bus);
      await streamBridge.start();

      resolveUserMock.mockReturnValue('user1');
      await streamAdapter.startHandler!(makeInbound({ platform: 'agentelegram', platformUserId: 'at_123' }));
      await flush();

      streamAdapter.sendTextCalls.length = 0;

      bus.emit('msg:out', {
        userId: 'user1',
        target: 'agentelegram',
        text: 'partial...',
        streaming: true,
      });
      await flush();

      expect(streamAdapter.sendTextCalls.some((c) => c.text === 'partial...')).toBe(true);

      await streamBridge.stop();
    });

    it('should skip complete message after streaming for streaming adapter', async () => {
      const streamAdapter = createMockAdapter('agentelegram');
      (streamAdapter as any).supportsStreaming = true;
      const streamBridge = new AdapterBridge(streamAdapter, bus);
      await streamBridge.start();

      resolveUserMock.mockReturnValue('user1');
      await streamAdapter.startHandler!(makeInbound({ platform: 'agentelegram', platformUserId: 'at_123' }));
      await flush();

      streamAdapter.sendTextCalls.length = 0;

      // streaming chunk。
      bus.emit('msg:out', {
        userId: 'user1',
        target: 'agentelegram',
        text: 'full response',
        streaming: true,
      });
      await flush();

      // streaming final（dedup 标记，无文本）。
      bus.emit('msg:out', {
        userId: 'user1',
        target: 'agentelegram',
        streaming: true,
        final: true,
      });
      await flush();

      const countAfterStreaming = streamAdapter.sendTextCalls.length;

      // complete message（应被 dedup 跳过）。
      bus.emit('msg:out', {
        userId: 'user1',
        target: 'agentelegram',
        text: 'full response',
      });
      await flush();

      expect(streamAdapter.sendTextCalls.length).toBe(countAfterStreaming);

      await streamBridge.stop();
    });
  });

  // ---- Typing 指示器 ----

  describe('typing indicators', () => {
    it('should show typing on agent:busy', async () => {
      resolveUserMock.mockReturnValue('user1');
      await adapter.startHandler!(makeInbound());
      await flush();

      adapter.showTypingCalls.length = 0;

      bus.emit('agent:busy', { userId: 'user1', target: 'telegram' });
      await flush();

      expect(adapter.showTypingCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('should show typing on broadcast busy (cron)', async () => {
      resolveUserMock.mockReturnValue('user1');
      await adapter.startHandler!(makeInbound());
      await flush();

      adapter.showTypingCalls.length = 0;

      bus.emit('agent:busy', { userId: 'user1', target: 'cron' });
      await flush();

      expect(adapter.showTypingCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('should not show typing for other platform', async () => {
      resolveUserMock.mockReturnValue('user1');
      await adapter.startHandler!(makeInbound());
      await flush();

      adapter.showTypingCalls.length = 0;

      bus.emit('agent:busy', { userId: 'user1', target: 'cli' });
      await flush();

      expect(adapter.showTypingCalls.length).toBe(0);
    });

    it('should clear typing interval on agent:idle', async () => {
      resolveUserMock.mockReturnValue('user1');
      await adapter.startHandler!(makeInbound());
      await flush();

      bus.emit('agent:busy', { userId: 'user1', target: 'telegram' });
      await flush();

      bus.emit('agent:idle', { userId: 'user1', target: 'telegram' });
      await flush();

      // 不应 crash，且 interval 应被清理。
      // 等待看是否有额外的 typing 调用。
      adapter.showTypingCalls.length = 0;
      await new Promise((resolve) => setTimeout(resolve, 50));
      // 如果 interval 没被清理，4 秒后会有新的 typing 调用，但 50ms 内不应有。
      // 这里只验证不 crash。
    });
  });

  // ---- 用户解析 via bindings ----

  describe('user resolution via bindings', () => {
    it('should resolve platformUserId from user bindings for outbound', async () => {
      // 不通过入站建立缓存，直接测试 binding 解析。
      getUserMock.mockReturnValue({
        userId: 'user2',
        bindings: [{ platform: 'telegram', platformUserId: 'tg_456' }],
      });

      bus.emit('msg:out', {
        userId: 'user2',
        target: 'telegram',
        text: 'Hello via binding',
      });
      await flush();

      expect(adapter.sendTextCalls.some((c) =>
        c.text === 'Hello via binding' && c.platformUserId === 'tg_456',
      )).toBe(true);
    });

    it('should silently skip if user has no binding for this platform', async () => {
      getUserMock.mockReturnValue({
        userId: 'user2',
        bindings: [{ platform: 'cli', platformUserId: 'cli_user' }],
      });

      bus.emit('msg:out', {
        userId: 'user2',
        target: 'telegram',
        text: 'No binding for telegram',
      });
      await flush();

      expect(adapter.sendTextCalls.length).toBe(0);
    });
  });

  // ---- 生命周期 ----

  describe('lifecycle', () => {
    it('should stop listening after stop()', async () => {
      resolveUserMock.mockReturnValue('user1');
      await adapter.startHandler!(makeInbound());
      await flush();

      await bridge.stop();

      adapter.sendTextCalls.length = 0;
      bus.emit('msg:out', {
        userId: 'user1',
        target: 'telegram',
        text: 'After stop',
      });
      await flush();

      expect(adapter.sendTextCalls.length).toBe(0);
    });
  });

  // ---- onAgentDone 生命周期 ----

  describe('onAgentDone lifecycle', () => {
    it('should call onAgentDone on agent:idle for matching platform', async () => {
      resolveUserMock.mockReturnValue('user1');
      await adapter.startHandler!(makeInbound());
      await flush();

      bus.emit('agent:idle', { userId: 'user1', target: 'telegram' });
      await flush();

      expect(adapter.onAgentDoneCalls).toEqual(['tg_123']);
    });

    it('should not call onAgentDone for different platform', async () => {
      resolveUserMock.mockReturnValue('user1');
      await adapter.startHandler!(makeInbound());
      await flush();

      bus.emit('agent:idle', { userId: 'user1', target: 'cli' });
      await flush();

      expect(adapter.onAgentDoneCalls.length).toBe(0);
    });

    it('should not call onAgentDone for broadcast sources', async () => {
      resolveUserMock.mockReturnValue('user1');
      await adapter.startHandler!(makeInbound());
      await flush();

      bus.emit('agent:idle', { userId: 'user1', target: 'cron' });
      await flush();

      expect(adapter.onAgentDoneCalls.length).toBe(0);
    });

    it('should call onAgentDone with correct platformUserId from bindings', async () => {
      // 不通过入站建立缓存，直接测试 binding 解析。
      getUserMock.mockReturnValue({
        userId: 'user2',
        bindings: [{ platform: 'telegram', platformUserId: 'tg_999' }],
      });

      bus.emit('agent:idle', { userId: 'user2', target: 'telegram' });
      await flush();

      expect(adapter.onAgentDoneCalls).toEqual(['tg_999']);
    });

    it('should work with adapter that does not implement onAgentDone', async () => {
      // 创建没有 onAgentDone 的适配器。
      const plainAdapter: MessageAdapter = {
        platform: 'plain',
        commandPrefix: '/',
        async start() {},
        async stop() {},
        async sendText() {},
        async sendFile() {},
        async showTyping() {},
      };
      const plainBridge = new AdapterBridge(plainAdapter, bus);
      await plainBridge.start();

      getUserMock.mockReturnValue({
        userId: 'user1',
        bindings: [{ platform: 'plain', platformUserId: 'plain_user' }],
      });

      // 不应抛错。
      bus.emit('agent:idle', { userId: 'user1', target: 'plain' });
      await flush();

      await plainBridge.stop();
    });
  });

  // ---- 多 bridge 隔离 ----

  describe('multi-bridge isolation', () => {
    it('should only deliver to the targeted bridge', async () => {
      const cliAdapter = createMockAdapter('cli');
      const cliBridge = new AdapterBridge(cliAdapter, bus);
      await cliBridge.start();

      resolveUserMock.mockReturnValue('user1');
      await adapter.startHandler!(makeInbound());
      await flush();

      // 缓存 cli 的 platformUserId。
      getUserMock.mockReturnValue({
        userId: 'user1',
        bindings: [
          { platform: 'telegram', platformUserId: 'tg_123' },
          { platform: 'cli', platformUserId: 'cli_user' },
        ],
      });

      adapter.sendTextCalls.length = 0;

      bus.emit('msg:out', {
        userId: 'user1',
        target: 'cli',
        text: 'For CLI only',
      });
      await flush();

      // Telegram bridge 不应收到。
      expect(adapter.sendTextCalls.length).toBe(0);
      // CLI bridge 应该收到。
      expect(cliAdapter.sendTextCalls.some((c) => c.text === 'For CLI only')).toBe(true);

      await cliBridge.stop();
    });

    it('should broadcast to all bridges for cron source', async () => {
      const cliAdapter = createMockAdapter('cli');
      const cliBridge = new AdapterBridge(cliAdapter, bus);
      await cliBridge.start();

      resolveUserMock.mockReturnValue('user1');
      await adapter.startHandler!(makeInbound());
      await flush();

      getUserMock.mockReturnValue({
        userId: 'user1',
        bindings: [
          { platform: 'telegram', platformUserId: 'tg_123' },
          { platform: 'cli', platformUserId: 'cli_user' },
        ],
      });

      adapter.sendTextCalls.length = 0;

      bus.emit('msg:out', {
        userId: 'user1',
        target: 'cron',
        text: 'Cron broadcast',
      });
      await flush();

      // 两个 bridge 都应收到。
      expect(adapter.sendTextCalls.some((c) => c.text === 'Cron broadcast')).toBe(true);
      expect(cliAdapter.sendTextCalls.some((c) => c.text === 'Cron broadcast')).toBe(true);

      await cliBridge.stop();
    });
  });
});
