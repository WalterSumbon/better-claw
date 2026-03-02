import { describe, it, expect } from 'vitest';
import {
  digestUserContent,
  digestAssistantContent,
  extractCarryover,
  type DigestParams,
} from '../../src/core/session-manager.js';
import type { ConversationEntry } from '../../src/core/session-store.js';

/**
 * Session carryover digest 单元测试。
 *
 * 覆盖：用户消息截断、agent 回复 head+tail digest、
 * 轮次分组、每轮只保留最后一条 assistant、可配置参数。
 */

// ── 辅助函数 ──

function makeEntry(role: 'user' | 'assistant', content: string, ts?: string): ConversationEntry {
  return {
    timestamp: ts ?? new Date().toISOString(),
    role,
    content,
  };
}

const defaultDigest: DigestParams = {
  userMaxChars: 500,
  assistantHeadChars: 200,
  assistantTailChars: 200,
};

// ── digestUserContent ──

describe('digestUserContent', () => {
  it('should return content as-is when within threshold', () => {
    const content = 'Short message';
    expect(digestUserContent(content, 500)).toBe(content);
  });

  it('should return content as-is when exactly at threshold', () => {
    const content = 'x'.repeat(500);
    expect(digestUserContent(content, 500)).toBe(content);
  });

  it('should truncate and annotate total length when exceeding threshold', () => {
    const content = 'a'.repeat(600);
    const result = digestUserContent(content, 500);

    expect(result).toContain('a'.repeat(500));
    expect(result).toContain('600 chars total');
    expect(result.length).toBeLessThan(600);
  });

  it('should respect custom maxChars parameter', () => {
    const content = 'b'.repeat(100);

    // threshold 50 → should truncate
    const result = digestUserContent(content, 50);
    expect(result).toContain('b'.repeat(50));
    expect(result).toContain('100 chars total');

    // threshold 200 → should keep as-is
    expect(digestUserContent(content, 200)).toBe(content);
  });
});

// ── digestAssistantContent ──

describe('digestAssistantContent', () => {
  it('should return content as-is when within head + tail', () => {
    const content = 'Short reply';
    expect(digestAssistantContent(content, 200, 200)).toBe(content);
  });

  it('should return content as-is when exactly at head + tail', () => {
    const content = 'x'.repeat(400);
    expect(digestAssistantContent(content, 200, 200)).toBe(content);
  });

  it('should keep head and tail, omit middle when exceeding threshold', () => {
    const head = 'H'.repeat(200);
    const middle = 'M'.repeat(400);
    const tail = 'T'.repeat(200);
    const content = head + middle + tail;

    const result = digestAssistantContent(content, 200, 200);

    expect(result.startsWith(head)).toBe(true);
    expect(result.endsWith(tail)).toBe(true);
    expect(result).toContain('omitted');
    expect(result).toContain(`${content.length} chars total`);
    expect(result).not.toContain('M'.repeat(100));
  });

  it('should respect custom head and tail parameters', () => {
    const content = 'x'.repeat(100);

    // head=10, tail=10, total=100 > 20 → should digest
    const result = digestAssistantContent(content, 10, 10);
    expect(result).toContain('omitted');
    expect(result).toContain('100 chars total');

    // head=50, tail=50, total=100 = 100 → should keep as-is
    expect(digestAssistantContent(content, 50, 50)).toBe(content);
  });
});

// ── extractCarryover - 轮次分组 ──

describe('extractCarryover - turn grouping', () => {
  it('should group user + assistant into turns', () => {
    const conversation: ConversationEntry[] = [
      makeEntry('user', 'Q1'),
      makeEntry('assistant', 'A1'),
      makeEntry('user', 'Q2'),
      makeEntry('assistant', 'A2'),
    ];

    const result = extractCarryover(conversation, 5, defaultDigest);
    expect(result).toHaveLength(4);
    expect(result[0]).toMatchObject({ role: 'user', content: 'Q1' });
    expect(result[1]).toMatchObject({ role: 'assistant', content: 'A1' });
    expect(result[2]).toMatchObject({ role: 'user', content: 'Q2' });
    expect(result[3]).toMatchObject({ role: 'assistant', content: 'A2' });
  });

  it('should only keep the LAST assistant message per turn', () => {
    const conversation: ConversationEntry[] = [
      makeEntry('user', 'Q1'),
      makeEntry('assistant', 'Intermediate reply 1'),
      makeEntry('assistant', 'Intermediate reply 2'),
      makeEntry('assistant', 'Final reply'),
    ];

    const result = extractCarryover(conversation, 5, defaultDigest);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ role: 'user', content: 'Q1' });
    expect(result[1]).toMatchObject({ role: 'assistant', content: 'Final reply' });
  });

  it('should handle multiple turns with multiple assistant messages each', () => {
    const conversation: ConversationEntry[] = [
      makeEntry('user', 'Q1'),
      makeEntry('assistant', 'A1-intermediate'),
      makeEntry('assistant', 'A1-final'),
      makeEntry('user', 'Q2'),
      makeEntry('assistant', 'A2-intermediate-1'),
      makeEntry('assistant', 'A2-intermediate-2'),
      makeEntry('assistant', 'A2-final'),
    ];

    const result = extractCarryover(conversation, 5, defaultDigest);
    expect(result).toHaveLength(4);
    expect(result[0]).toMatchObject({ role: 'user', content: 'Q1' });
    expect(result[1]).toMatchObject({ role: 'assistant', content: 'A1-final' });
    expect(result[2]).toMatchObject({ role: 'user', content: 'Q2' });
    expect(result[3]).toMatchObject({ role: 'assistant', content: 'A2-final' });
  });

  it('should handle turn with user message but no assistant reply', () => {
    const conversation: ConversationEntry[] = [
      makeEntry('user', 'Q1'),
      makeEntry('assistant', 'A1'),
      makeEntry('user', 'Q2'),
      // no assistant reply for Q2
    ];

    const result = extractCarryover(conversation, 5, defaultDigest);
    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({ role: 'user', content: 'Q1' });
    expect(result[1]).toMatchObject({ role: 'assistant', content: 'A1' });
    expect(result[2]).toMatchObject({ role: 'user', content: 'Q2' });
  });
});

// ── extractCarryover - maxTurns 限制 ──

describe('extractCarryover - maxTurns', () => {
  const conversation: ConversationEntry[] = [
    makeEntry('user', 'Q1'),
    makeEntry('assistant', 'A1'),
    makeEntry('user', 'Q2'),
    makeEntry('assistant', 'A2'),
    makeEntry('user', 'Q3'),
    makeEntry('assistant', 'A3'),
    makeEntry('user', 'Q4'),
    makeEntry('assistant', 'A4'),
  ];

  it('should take only last N turns', () => {
    const result = extractCarryover(conversation, 2, defaultDigest);
    expect(result).toHaveLength(4);
    expect(result[0]).toMatchObject({ role: 'user', content: 'Q3' });
    expect(result[1]).toMatchObject({ role: 'assistant', content: 'A3' });
    expect(result[2]).toMatchObject({ role: 'user', content: 'Q4' });
    expect(result[3]).toMatchObject({ role: 'assistant', content: 'A4' });
  });

  it('should take 1 turn', () => {
    const result = extractCarryover(conversation, 1, defaultDigest);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ role: 'user', content: 'Q4' });
    expect(result[1]).toMatchObject({ role: 'assistant', content: 'A4' });
  });

  it('should return all turns when maxTurns exceeds conversation length', () => {
    const result = extractCarryover(conversation, 100, defaultDigest);
    expect(result).toHaveLength(8);
  });

  it('should return empty array when maxTurns is 0', () => {
    expect(extractCarryover(conversation, 0, defaultDigest)).toEqual([]);
  });

  it('should return empty array for empty conversation', () => {
    expect(extractCarryover([], 5, defaultDigest)).toEqual([]);
  });
});

// ── extractCarryover - digest integration ──

describe('extractCarryover - digest with config params', () => {
  it('should digest long user messages according to userMaxChars', () => {
    const longUserMsg = 'U'.repeat(1000);
    const conversation: ConversationEntry[] = [
      makeEntry('user', longUserMsg),
      makeEntry('assistant', 'Short reply'),
    ];

    const result = extractCarryover(conversation, 5, {
      userMaxChars: 100,
      assistantHeadChars: 200,
      assistantTailChars: 200,
    });

    expect(result[0].role).toBe('user');
    expect(result[0].content).toContain('U'.repeat(100));
    expect(result[0].content).toContain('1000 chars total');
    expect(result[0].content.length).toBeLessThan(1000);
  });

  it('should digest long assistant messages according to head+tail chars', () => {
    const longAssistantMsg = 'A'.repeat(2000);
    const conversation: ConversationEntry[] = [
      makeEntry('user', 'Short question'),
      makeEntry('assistant', longAssistantMsg),
    ];

    const result = extractCarryover(conversation, 5, {
      userMaxChars: 500,
      assistantHeadChars: 50,
      assistantTailChars: 50,
    });

    expect(result[1].role).toBe('assistant');
    expect(result[1].content).toContain('A'.repeat(50));
    expect(result[1].content).toContain('omitted');
    expect(result[1].content).toContain('2000 chars total');
    expect(result[1].content.length).toBeLessThan(2000);
  });

  it('should not digest short messages', () => {
    const conversation: ConversationEntry[] = [
      makeEntry('user', 'Hi'),
      makeEntry('assistant', 'Hello'),
    ];

    const result = extractCarryover(conversation, 5, defaultDigest);
    expect(result[0].content).toBe('Hi');
    expect(result[1].content).toBe('Hello');
  });
});

// ── extractCarryover - combined: multi-assistant + digest + maxTurns ──

describe('extractCarryover - combined scenarios', () => {
  it('should only digest the last assistant message per turn (not intermediate ones)', () => {
    const longFinal = 'F'.repeat(1000);
    const conversation: ConversationEntry[] = [
      makeEntry('user', 'Q1'),
      makeEntry('assistant', 'Intermediate (this should be discarded)'),
      makeEntry('assistant', longFinal),
    ];

    const result = extractCarryover(conversation, 5, {
      userMaxChars: 500,
      assistantHeadChars: 50,
      assistantTailChars: 50,
    });

    expect(result).toHaveLength(2);
    // Should be the digested version of longFinal, not the intermediate.
    expect(result[1].content).toContain('omitted');
    expect(result[1].content).toContain('1000 chars total');
    expect(result[1].content).not.toContain('Intermediate');
  });

  it('should apply maxTurns after grouping, not before', () => {
    // 3 turns, but with multiple assistant msgs per turn
    const conversation: ConversationEntry[] = [
      makeEntry('user', 'Q1'),
      makeEntry('assistant', 'A1-mid'),
      makeEntry('assistant', 'A1-final'),
      makeEntry('user', 'Q2'),
      makeEntry('assistant', 'A2-mid'),
      makeEntry('assistant', 'A2-final'),
      makeEntry('user', 'Q3'),
      makeEntry('assistant', 'A3-final'),
    ];

    // Request last 2 turns → should get Q2+A2-final, Q3+A3-final
    const result = extractCarryover(conversation, 2, defaultDigest);
    expect(result).toHaveLength(4);
    expect(result[0]).toMatchObject({ role: 'user', content: 'Q2' });
    expect(result[1]).toMatchObject({ role: 'assistant', content: 'A2-final' });
    expect(result[2]).toMatchObject({ role: 'user', content: 'Q3' });
    expect(result[3]).toMatchObject({ role: 'assistant', content: 'A3-final' });
  });
});
