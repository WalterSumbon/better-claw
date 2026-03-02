import { describe, it, expect } from 'vitest';
import { mergeMessages, type QueuedMessage } from '../../src/core/queue.js';

/**
 * mergeMessages 单元测试。
 *
 * 覆盖场景：
 * - 单条消息（identity）
 * - 多条纯文本消息合并
 * - 包含图片附件引用的消息合并
 * - 包含文件附件引用的消息合并
 * - 包含语音附件引用的消息合并
 * - 混合消息（文本 + 多张图片 + 多个文件）合并
 * - 回调函数使用最后一条消息的
 */

/** 创建测试用的 QueuedMessage。 */
function makeMessage(text: string, overrides?: Partial<QueuedMessage>): QueuedMessage {
  return {
    userId: 'user_test',
    text,
    reply: async () => {},
    sendFile: async () => {},
    showTyping: () => {},
    platform: 'test',
    ...overrides,
  };
}

describe('mergeMessages', () => {
  it('should return the same message when only one message', () => {
    const msg = makeMessage('hello');
    const result = mergeMessages([msg]);
    expect(result).toBe(msg);
  });

  it('should merge multiple text messages with newline', () => {
    const msgs = [
      makeMessage('帮我看下这个函数'),
      makeMessage('就是那个 handleMessage'),
      makeMessage('在 index.ts 里'),
    ];
    const result = mergeMessages(msgs);
    expect(result.text).toBe('帮我看下这个函数\n就是那个 handleMessage\n在 index.ts 里');
  });

  it('should merge messages with image attachments', () => {
    const msgs = [
      makeMessage('[用户发送了图片: /tmp/photo1.jpg]\n看看这张图'),
      makeMessage('[用户发送了图片: /tmp/photo2.jpg]\n还有这张'),
    ];
    const result = mergeMessages(msgs);
    expect(result.text).toContain('/tmp/photo1.jpg');
    expect(result.text).toContain('/tmp/photo2.jpg');
    expect(result.text).toContain('看看这张图');
    expect(result.text).toContain('还有这张');
  });

  it('should merge messages with multiple images', () => {
    const msgs = [
      makeMessage('[用户发送了图片: /tmp/img1.jpg]'),
      makeMessage('[用户发送了图片: /tmp/img2.png]'),
      makeMessage('[用户发送了图片: /tmp/img3.webp]'),
    ];
    const result = mergeMessages(msgs);
    const lines = result.text.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('img1.jpg');
    expect(lines[1]).toContain('img2.png');
    expect(lines[2]).toContain('img3.webp');
  });

  it('should merge messages with file attachments', () => {
    const msgs = [
      makeMessage('[用户发送了文件: /tmp/report.pdf (report.pdf)]'),
      makeMessage('[用户发送了文件: /tmp/data.csv (data.csv)]'),
    ];
    const result = mergeMessages(msgs);
    expect(result.text).toContain('report.pdf');
    expect(result.text).toContain('data.csv');
  });

  it('should merge messages with multiple files', () => {
    const msgs = [
      makeMessage('[用户发送了文件: /tmp/a.txt (a.txt)]'),
      makeMessage('[用户发送了文件: /tmp/b.json (b.json)]'),
      makeMessage('[用户发送了文件: /tmp/c.py (c.py)]'),
      makeMessage('[用户发送了文件: /tmp/d.ts (d.ts)]'),
    ];
    const result = mergeMessages(msgs);
    expect(result.text).toContain('a.txt');
    expect(result.text).toContain('b.json');
    expect(result.text).toContain('c.py');
    expect(result.text).toContain('d.ts');
  });

  it('should merge messages with voice attachments', () => {
    const msgs = [
      makeMessage('[语音消息已转录]\n你好，帮我查一下'),
      makeMessage('[语音消息已转录]\n就是昨天那个问题'),
    ];
    const result = mergeMessages(msgs);
    expect(result.text).toContain('你好，帮我查一下');
    expect(result.text).toContain('就是昨天那个问题');
  });

  it('should merge mixed messages (text + images + files)', () => {
    const msgs = [
      makeMessage('请帮我分析这些文件'),
      makeMessage('[用户发送了图片: /tmp/screenshot.png]\n界面截图'),
      makeMessage('[用户发送了文件: /tmp/log.txt (log.txt)]\n这是日志'),
      makeMessage('[用户发送了图片: /tmp/error.jpg]\n报错截图'),
      makeMessage('重点看第三行的报错'),
    ];
    const result = mergeMessages(msgs);
    expect(result.text).toContain('请帮我分析这些文件');
    expect(result.text).toContain('screenshot.png');
    expect(result.text).toContain('界面截图');
    expect(result.text).toContain('log.txt');
    expect(result.text).toContain('这是日志');
    expect(result.text).toContain('error.jpg');
    expect(result.text).toContain('报错截图');
    expect(result.text).toContain('重点看第三行的报错');
  });

  it('should use the last message callbacks', () => {
    const reply1 = async () => {};
    const reply2 = async () => {};
    const reply3 = async () => {};

    const sendFile1 = async () => {};
    const sendFile3 = async () => {};

    const showTyping1 = () => {};
    const showTyping3 = () => {};

    const msgs = [
      makeMessage('msg1', { reply: reply1, sendFile: sendFile1, showTyping: showTyping1 }),
      makeMessage('msg2', { reply: reply2 }),
      makeMessage('msg3', { reply: reply3, sendFile: sendFile3, showTyping: showTyping3 }),
    ];

    const result = mergeMessages(msgs);
    expect(result.reply).toBe(reply3);
    expect(result.sendFile).toBe(sendFile3);
    expect(result.showTyping).toBe(showTyping3);
  });

  it('should use the last message platform and userId', () => {
    const msgs = [
      makeMessage('msg1', { platform: 'telegram', userId: 'user_a' }),
      makeMessage('msg2', { platform: 'telegram', userId: 'user_a' }),
    ];
    const result = mergeMessages(msgs);
    expect(result.platform).toBe('telegram');
    expect(result.userId).toBe('user_a');
  });

  it('should handle empty text messages in the mix', () => {
    const msgs = [
      makeMessage('hello'),
      makeMessage(''),
      makeMessage('world'),
    ];
    const result = mergeMessages(msgs);
    expect(result.text).toBe('hello\n\nworld');
  });

  it('should handle two messages', () => {
    const msgs = [
      makeMessage('first'),
      makeMessage('second'),
    ];
    const result = mergeMessages(msgs);
    expect(result.text).toBe('first\nsecond');
  });

  it('should preserve multiline text within individual messages', () => {
    const msgs = [
      makeMessage('line1\nline2'),
      makeMessage('line3\nline4'),
    ];
    const result = mergeMessages(msgs);
    expect(result.text).toBe('line1\nline2\nline3\nline4');
  });
});
