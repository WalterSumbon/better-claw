import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { InboundMessage } from '../../src/adapter/types.js';

// ---------------------------------------------------------------------------
// vi.hoisted：在 mock 工厂中安全引用
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  registerCallbackListener: vi.fn(),
  registerAllEventListener: vi.fn(),
  send: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  getConfig: vi.fn(() => ({ subscriptions: [] })),
  transcribeAudio: vi.fn(),
  fetch: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock 依赖
// ---------------------------------------------------------------------------

vi.mock('fs', () => ({ writeFileSync: vi.fn() }));

vi.mock('../../src/config/index.js', () => ({
  getConfig: vi.fn(() => ({ dataDir: '/tmp/test-data' })),
}));

vi.mock('../../src/utils/file.js', () => ({ ensureDir: vi.fn() }));

vi.mock('../../src/utils/transcribe.js', () => ({
  transcribeAudio: (...args: unknown[]) => mocks.transcribeAudio(...args),
}));

vi.mock('../../src/logger/index.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('dingtalk-stream-sdk-nodejs', () => {
  class MockDWClient {
    debug = false;
    registerCallbackListener = mocks.registerCallbackListener;
    registerAllEventListener = mocks.registerAllEventListener;
    send = mocks.send;
    _connect = mocks.connect;
    disconnect = mocks.disconnect;
    getConfig = mocks.getConfig;
  }
  return {
    DWClient: MockDWClient,
    TOPIC_ROBOT: '/v1.0/im/bot/messages/get',
    EventAck: { SUCCESS: 'SUCCESS' },
  };
});

vi.stubGlobal('fetch', mocks.fetch);

// ---------------------------------------------------------------------------
// Helper: 构造钉钉消息
// ---------------------------------------------------------------------------

function baseMsg(overrides: Record<string, unknown> = {}) {
  return {
    conversationId: 'conv-123',
    chatbotCorpId: 'corp-123',
    chatbotUserId: 'bot-123',
    msgId: 'msg-001',
    senderNick: '测试用户',
    isAdmin: false,
    senderStaffId: 'staff-001',
    sessionWebhookExpiredTime: Date.now() + 3600_000,
    createAt: Date.now(),
    senderCorpId: 'corp-123',
    conversationType: '1',
    senderId: 'sender-001',
    sessionWebhook: 'https://oapi.dingtalk.com/robot/sendBySession?session=abc',
    robotCode: 'robot-001',
    ...overrides,
  };
}

function downstream(data: Record<string, unknown>) {
  return {
    headers: { messageId: 'header-msg-001' },
    data: JSON.stringify(data),
  };
}

/** 标准 fetch mock：token + download API + 文件下载均成功。 */
function setupFetchMock() {
  mocks.fetch.mockImplementation(async (url: string | URL | Request) => {
    const urlStr = String(url);

    if (urlStr.includes('/gettoken')) {
      return { ok: true, json: async () => ({ errcode: 0, access_token: 'test-token' }) };
    }
    if (urlStr.includes('/gateway/connections/open')) {
      return { ok: true, json: async () => ({ endpoint: 'wss://test.dingtalk.com', ticket: 'tk' }) };
    }
    if (urlStr.includes('/robot/messageFiles/download')) {
      return { ok: true, json: async () => ({ downloadUrl: 'https://cdn.dingtalk.com/test-file' }) };
    }
    if (urlStr.includes('cdn.dingtalk.com')) {
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(100) };
    }
    return { ok: false, status: 404, text: async () => 'not found' };
  });
}

/** download API 返回失败的 fetch mock。 */
function setupDownloadFailFetchMock() {
  mocks.fetch.mockImplementation(async (url: string | URL | Request) => {
    const urlStr = String(url);
    if (urlStr.includes('/gettoken')) {
      return { ok: true, json: async () => ({ errcode: 0, access_token: 'tk' }) };
    }
    if (urlStr.includes('/gateway/connections/open')) {
      return { ok: true, json: async () => ({ endpoint: 'wss://test.dingtalk.com', ticket: 'tk' }) };
    }
    if (urlStr.includes('/robot/messageFiles/download')) {
      return { ok: false, status: 500, text: async () => 'server error' };
    }
    return { ok: false, status: 404, text: async () => 'not found' };
  });
}

// ---------------------------------------------------------------------------
// Helper: 创建 adapter 并获取消息回调
// ---------------------------------------------------------------------------

async function createAdapterAndGetCallback() {
  const { DingtalkAdapter } = await import('../../src/adapter/dingtalk/adapter.js');

  const adapter = await DingtalkAdapter.create({
    clientId: 'test-client',
    clientSecret: 'test-secret',
  });

  const handler = vi.fn();
  await adapter.start(handler);

  // registerCallbackListener 第二个参数就是消息回调。
  const callback = mocks.registerCallbackListener.mock.calls[0][1] as (
    res: { headers: { messageId: string }; data: string },
  ) => Promise<void>;

  return { adapter, handler, callback };
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

describe('DingTalk adapter media message handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupFetchMock();
    mocks.transcribeAudio.mockResolvedValue({ text: null });
  });

  // ---- 文本消息（baseline）----

  describe('text messages', () => {
    it('should handle text messages', async () => {
      const { callback, handler } = await createAdapterAndGetCallback();

      await callback(downstream({
        ...baseMsg(),
        msgtype: 'text',
        text: { content: '你好世界' },
      }));

      expect(handler).toHaveBeenCalledOnce();
      const msg: InboundMessage = handler.mock.calls[0][0];
      expect(msg.text).toBe('你好世界');
      expect(msg.attachments).toBeUndefined();
      expect(msg.isCommand).toBe(false);
    });

    it('should parse commands from text', async () => {
      const { callback, handler } = await createAdapterAndGetCallback();

      await callback(downstream({
        ...baseMsg(),
        msgtype: 'text',
        text: { content: '.help me' },
      }));

      const msg: InboundMessage = handler.mock.calls[0][0];
      expect(msg.isCommand).toBe(true);
      expect(msg.commandName).toBe('help');
      expect(msg.commandArgs).toBe('me');
    });
  });

  // ---- 图片消息 ----

  describe('picture messages', () => {
    it('should download picture and create photo attachment', async () => {
      const { callback, handler } = await createAdapterAndGetCallback();

      await callback(downstream({
        ...baseMsg(),
        msgtype: 'picture',
        content: { downloadCode: 'pic-code-123', pictureDownloadCode: 'ppic-code' },
      }));

      expect(handler).toHaveBeenCalledOnce();
      const msg: InboundMessage = handler.mock.calls[0][0];
      expect(msg.text).toContain('用户发送了图片');
      expect(msg.attachments).toHaveLength(1);
      expect(msg.attachments![0].type).toBe('photo');
      expect(msg.attachments![0].localPath).toContain('.jpg');
      expect(msg.attachments![0].mimeType).toBe('image/jpeg');
      expect(msg.isCommand).toBe(false);
    });

    it('should handle download failure gracefully', async () => {
      setupDownloadFailFetchMock();
      const { callback, handler } = await createAdapterAndGetCallback();

      await callback(downstream({
        ...baseMsg(),
        msgtype: 'picture',
        content: { downloadCode: 'bad-code' },
      }));

      const msg: InboundMessage = handler.mock.calls[0][0];
      expect(msg.text).toContain('下载失败');
      expect(msg.attachments).toBeUndefined();
    });
  });

  // ---- 语音消息 ----

  describe('audio messages', () => {
    it('should use DingTalk built-in recognition when available', async () => {
      const { callback, handler } = await createAdapterAndGetCallback();

      await callback(downstream({
        ...baseMsg(),
        msgtype: 'audio',
        content: { downloadCode: 'audio-code', recognition: '钉钉语音识别文本' },
      }));

      const msg: InboundMessage = handler.mock.calls[0][0];
      expect(msg.text).toContain('转录文本: 钉钉语音识别文本');
      expect(msg.attachments).toHaveLength(1);
      expect(msg.attachments![0].type).toBe('voice');
      expect(msg.attachments![0].mimeType).toBe('audio/ogg');
      expect(mocks.transcribeAudio).not.toHaveBeenCalled();
    });

    it('should fallback to whisper when recognition is empty', async () => {
      mocks.transcribeAudio.mockResolvedValue({ text: 'whisper 转录结果' });
      const { callback, handler } = await createAdapterAndGetCallback();

      await callback(downstream({
        ...baseMsg(),
        msgtype: 'audio',
        content: { downloadCode: 'audio-code' },
      }));

      const msg: InboundMessage = handler.mock.calls[0][0];
      expect(msg.text).toContain('转录文本: whisper 转录结果');
      expect(mocks.transcribeAudio).toHaveBeenCalledOnce();
    });

    it('should show unavailable reason when whisper also fails', async () => {
      mocks.transcribeAudio.mockResolvedValue({ text: null, unavailableReason: 'whisper 未安装' });
      const { callback, handler } = await createAdapterAndGetCallback();

      await callback(downstream({
        ...baseMsg(),
        msgtype: 'audio',
        content: { downloadCode: 'audio-code' },
      }));

      const msg: InboundMessage = handler.mock.calls[0][0];
      expect(msg.text).toContain('语音转文字不可用');
      expect(msg.text).toContain('whisper 未安装');
      expect(msg.attachments).toHaveLength(1);
    });

    it('should handle download failure with no recognition', async () => {
      setupDownloadFailFetchMock();
      const { callback, handler } = await createAdapterAndGetCallback();

      await callback(downstream({
        ...baseMsg(),
        msgtype: 'audio',
        content: { downloadCode: 'bad-code' },
      }));

      const msg: InboundMessage = handler.mock.calls[0][0];
      expect(msg.text).toContain('下载失败');
      expect(msg.text).toContain('无内置转录');
    });

    it('should still use recognition even when download fails', async () => {
      setupDownloadFailFetchMock();
      const { callback, handler } = await createAdapterAndGetCallback();

      await callback(downstream({
        ...baseMsg(),
        msgtype: 'audio',
        content: { downloadCode: 'bad-code', recognition: '即使下载失败也能用' },
      }));

      const msg: InboundMessage = handler.mock.calls[0][0];
      expect(msg.text).toContain('转录文本: 即使下载失败也能用');
      expect(msg.attachments).toBeUndefined();
    });
  });

  // ---- 视频消息 ----

  describe('video messages', () => {
    it('should download video and include duration info', async () => {
      const { callback, handler } = await createAdapterAndGetCallback();

      await callback(downstream({
        ...baseMsg(),
        msgtype: 'video',
        content: { downloadCode: 'video-code', duration: '15', videoType: 'mp4' },
      }));

      const msg: InboundMessage = handler.mock.calls[0][0];
      expect(msg.text).toContain('用户发送了视频');
      expect(msg.text).toContain('时长 15 秒');
      expect(msg.attachments).toHaveLength(1);
      expect(msg.attachments![0].type).toBe('video');
      expect(msg.attachments![0].localPath).toContain('.mp4');
      expect(msg.attachments![0].mimeType).toBe('video/mp4');
    });

    it('should default to mp4 when videoType is missing', async () => {
      const { callback, handler } = await createAdapterAndGetCallback();

      await callback(downstream({
        ...baseMsg(),
        msgtype: 'video',
        content: { downloadCode: 'video-code' },
      }));

      const msg: InboundMessage = handler.mock.calls[0][0];
      expect(msg.attachments![0].localPath).toContain('.mp4');
      expect(msg.attachments![0].mimeType).toBe('video/mp4');
    });
  });

  // ---- 文件消息 ----

  describe('file messages', () => {
    it('should download file and preserve original filename', async () => {
      const { callback, handler } = await createAdapterAndGetCallback();

      await callback(downstream({
        ...baseMsg(),
        msgtype: 'file',
        content: { downloadCode: 'file-code', fileName: 'report.pdf', fileId: 'f-001', spaceId: 's-001' },
      }));

      const msg: InboundMessage = handler.mock.calls[0][0];
      expect(msg.text).toContain('用户发送了文件');
      expect(msg.text).toContain('report.pdf');
      expect(msg.attachments).toHaveLength(1);
      expect(msg.attachments![0].type).toBe('document');
      expect(msg.attachments![0].fileName).toBe('report.pdf');
      expect(msg.attachments![0].localPath).toContain('.pdf');
    });

    it('should handle missing fileName', async () => {
      const { callback, handler } = await createAdapterAndGetCallback();

      await callback(downstream({
        ...baseMsg(),
        msgtype: 'file',
        content: { downloadCode: 'file-code' },
      }));

      const msg: InboundMessage = handler.mock.calls[0][0];
      expect(msg.attachments![0].fileName).toBe('unknown');
    });
  });

  // ---- 富文本消息 ----

  describe('richText messages', () => {
    it('should extract text and download inline images', async () => {
      const { callback, handler } = await createAdapterAndGetCallback();

      await callback(downstream({
        ...baseMsg(),
        msgtype: 'richText',
        content: {
          richText: [
            { text: '这是一段文字' },
            { type: 'picture', downloadCode: 'rt-pic-code', pictureDownloadCode: 'pp-code' },
            { text: '图片后面的文字' },
          ],
        },
      }));

      const msg: InboundMessage = handler.mock.calls[0][0];
      expect(msg.text).toContain('这是一段文字');
      expect(msg.text).toContain('图片后面的文字');
      expect(msg.text).toContain('[图片:');
      expect(msg.attachments).toHaveLength(1);
      expect(msg.attachments![0].type).toBe('photo');
    });

    it('should handle richText with only text elements', async () => {
      const { callback, handler } = await createAdapterAndGetCallback();

      await callback(downstream({
        ...baseMsg(),
        msgtype: 'richText',
        content: {
          richText: [
            { text: '只有文字' },
            { text: '没有图片' },
          ],
        },
      }));

      const msg: InboundMessage = handler.mock.calls[0][0];
      expect(msg.text).toContain('只有文字');
      expect(msg.attachments).toBeUndefined();
    });

    it('should handle inline image download failure', async () => {
      setupDownloadFailFetchMock();
      const { callback, handler } = await createAdapterAndGetCallback();

      await callback(downstream({
        ...baseMsg(),
        msgtype: 'richText',
        content: {
          richText: [
            { text: '前面的文字' },
            { type: 'picture', downloadCode: 'bad-code' },
          ],
        },
      }));

      const msg: InboundMessage = handler.mock.calls[0][0];
      expect(msg.text).toContain('前面的文字');
      expect(msg.text).toContain('图片下载失败');
    });
  });

  // ---- 不支持的消息类型 ----

  describe('unsupported message types', () => {
    it('should handle unknownMsgType gracefully', async () => {
      const { callback, handler } = await createAdapterAndGetCallback();

      await callback(downstream({
        ...baseMsg(),
        msgtype: 'unknownMsgType',
        content: { unknownMsgType: '不支持的消息' },
      }));

      const msg: InboundMessage = handler.mock.calls[0][0];
      expect(msg.text).toContain('不支持的消息类型');
    });
  });

  // ---- ACK 行为 ----

  describe('ack behavior', () => {
    it('should ack message immediately', async () => {
      const { callback } = await createAdapterAndGetCallback();

      await callback(downstream({
        ...baseMsg(),
        msgtype: 'picture',
        content: { downloadCode: 'pic-code' },
      }));

      expect(mocks.send).toHaveBeenCalledWith('header-msg-001', { status: 'SUCCESS' });
    });

    it('should ack non-single-chat messages without processing', async () => {
      const { callback, handler } = await createAdapterAndGetCallback();

      await callback(downstream({
        ...baseMsg({ conversationType: '2' }),
        msgtype: 'text',
        text: { content: '群聊消息' },
      }));

      expect(mocks.send).toHaveBeenCalledWith('header-msg-001', { status: 'SUCCESS' });
      expect(handler).not.toHaveBeenCalled();
    });
  });

  // ---- 命令解析 ----

  describe('command parsing', () => {
    it('should not parse commands for media messages', async () => {
      const { callback, handler } = await createAdapterAndGetCallback();

      await callback(downstream({
        ...baseMsg(),
        msgtype: 'picture',
        content: { downloadCode: 'pic-code' },
      }));

      const msg: InboundMessage = handler.mock.calls[0][0];
      expect(msg.isCommand).toBe(false);
    });
  });
});
