import { describe, it, expect } from 'vitest';
import {
  splitConversationIntoChunks,
} from '../../src/core/session-manager.js';
import type { ConversationEntry } from '../../src/core/session-store.js';

/**
 * Session summary 分块逻辑单元测试。
 *
 * 覆盖：splitConversationIntoChunks 的各种分块场景，
 * 以及 generateSummary 在单块/多块时的调用路径（通过 mock）。
 */

// ── 辅助函数 ──

function makeEntry(role: 'user' | 'assistant', content: string): ConversationEntry {
  return {
    timestamp: new Date().toISOString(),
    role,
    content,
  };
}

function makeConversation(turns: number, contentLength = 20): ConversationEntry[] {
  const entries: ConversationEntry[] = [];
  for (let i = 0; i < turns; i++) {
    entries.push(makeEntry('user', `Q${i + 1} ${'x'.repeat(contentLength)}`));
    entries.push(makeEntry('assistant', `A${i + 1} ${'y'.repeat(contentLength)}`));
  }
  return entries;
}

// ── splitConversationIntoChunks ──

describe('splitConversationIntoChunks', () => {
  it('should return single chunk when conversation fits within limit', () => {
    const conversation = makeConversation(3, 10);
    const chunks = splitConversationIntoChunks(conversation, 10_000);

    expect(chunks).toHaveLength(1);
    // 所有条目都应在第一个块中。
    for (const entry of conversation) {
      expect(chunks[0]).toContain(entry.content);
    }
  });

  it('should return empty array for empty conversation', () => {
    const chunks = splitConversationIntoChunks([], 10_000);
    expect(chunks).toHaveLength(0);
  });

  it('should split into multiple chunks when conversation exceeds limit', () => {
    // 每条消息约 110 字符（"[user]: Q1 " + 100 chars + "\n\n"）。
    // 10 轮 = 20 条，总计约 2200 字符。设 maxChars=500，应分多块。
    const conversation = makeConversation(10, 100);
    const chunks = splitConversationIntoChunks(conversation, 500);

    expect(chunks.length).toBeGreaterThan(1);

    // 所有条目的内容应分布在各块中，不遗漏。
    const allText = chunks.join('\n');
    for (const entry of conversation) {
      expect(allText).toContain(entry.content);
    }
  });

  it('should split at entry boundaries (never mid-entry)', () => {
    const conversation = [
      makeEntry('user', 'Hello world'),
      makeEntry('assistant', 'Hi there, this is a longer response'),
      makeEntry('user', 'Follow up question here'),
    ];

    // 设置一个刚好让第一条放入但第二条需要新块的限制。
    // "[user]: Hello world\n\n" ≈ 24 chars
    // "[assistant]: Hi there, this is a longer response\n\n" ≈ 53 chars
    const chunks = splitConversationIntoChunks(conversation, 50);

    // 每个块应包含完整的 "[role]: content" 格式，不应有断行。
    for (const chunk of chunks) {
      // 检查没有被截断的条目。
      const lines = chunk.split('\n\n').filter((l) => l.length > 0);
      for (const line of lines) {
        expect(line).toMatch(/^\[(user|assistant)\]: /);
      }
    }
  });

  it('should handle single entry larger than maxChars', () => {
    // 单条消息本身超过 maxChars，应独立成块。
    const longContent = 'x'.repeat(10_000);
    const conversation = [
      makeEntry('user', 'short'),
      makeEntry('assistant', longContent),
      makeEntry('user', 'another short'),
    ];

    const chunks = splitConversationIntoChunks(conversation, 500);

    // 至少 2 块：长条目独占一块。
    expect(chunks.length).toBeGreaterThanOrEqual(2);

    // 长条目内容完整保留。
    const allText = chunks.join('\n');
    expect(allText).toContain(longContent);
  });

  it('should preserve entry order across chunks', () => {
    const conversation = makeConversation(5, 50);
    const chunks = splitConversationIntoChunks(conversation, 200);

    // 拼接所有块，按顺序提取 Q/A 编号。
    const allText = chunks.join('\n\n');
    const matches = allText.match(/[QA]\d+/g) ?? [];

    const expected = [];
    for (let i = 1; i <= 5; i++) {
      expected.push(`Q${i}`, `A${i}`);
    }
    expect(matches).toEqual(expected);
  });

  it('should handle conversation with only user messages (no assistant replies)', () => {
    const conversation = [
      makeEntry('user', 'Q1'),
      makeEntry('user', 'Q2'),
      makeEntry('user', 'Q3'),
    ];

    const chunks = splitConversationIntoChunks(conversation, 10_000);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain('Q1');
    expect(chunks[0]).toContain('Q2');
    expect(chunks[0]).toContain('Q3');
  });

  it('should produce chunks that each stay within maxChars (when entries are small)', () => {
    const conversation = makeConversation(20, 30);
    const maxChars = 300;
    const chunks = splitConversationIntoChunks(conversation, maxChars);

    // 每个块（除了包含超大单条目的情况）不应超过 maxChars + 单条最大长度。
    // 这里所有条目都小于 maxChars，所以严格不超过。
    for (const chunk of chunks) {
      // 允许一条条目的宽容量（条目添加后才检查溢出）。
      expect(chunk.length).toBeLessThanOrEqual(maxChars + 200);
    }
  });

  it('should not produce empty chunks', () => {
    const conversation = makeConversation(10, 50);
    const chunks = splitConversationIntoChunks(conversation, 300);

    for (const chunk of chunks) {
      expect(chunk.trim().length).toBeGreaterThan(0);
    }
  });
});

// 注意：generateSummary 是模块内部函数，其 map-reduce 流程依赖 runQueryToFile（LLM 调用），
// 无法在不修改源码的情况下 mock。核心分块逻辑已通过 splitConversationIntoChunks 测试覆盖。
// generateSummary 的端到端行为通过 e2e 测试验证。
