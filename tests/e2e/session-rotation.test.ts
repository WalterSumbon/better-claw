import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { createUser } from '../../src/user/manager.js';
import {
  readActiveSession,
  writeActiveSession,
  createActiveSession,
  appendConversation,
  listArchivedSessions,
  sessionsDir,
  readConversation,
  type ConversationEntry,
} from '../../src/core/session-store.js';
import { rotateSession } from '../../src/core/session-manager.js';
import { createTestEnv } from '../helpers/setup.js';

/**
 * Session 轮转集成测试。
 *
 * 真实调用 LLM API 生成摘要，验证完整轮转流程：
 * - 摘要写入归档 session
 * - Carryover 写入新 session
 * - 累积摘要浓缩
 *
 * 需要已认证的 Claude Code CLI。
 * 在 Claude Code 会话内运行时，createTestEnv() 会自动清除 CLAUDECODE 环境变量。
 */
describe('Session rotation integration', () => {
  let testUserId: string;
  let cleanup: () => Promise<void>;

  beforeEach(() => {
    const env = createTestEnv();
    cleanup = env.cleanup;
    const user = createUser('rotation-test');
    testUserId = user.userId;
  });

  afterEach(async () => {
    await cleanup();
  });

  /**
   * 创建一个带有对话记录的模拟活跃 session。
   * 填充 sdkSessionId 使 rotateSession 认为它是一个真实 session。
   */
  function setupSessionWithConversation(
    entries: ConversationEntry[],
  ): string {
    const session = createActiveSession(testUserId);
    // 标记为有 SDK session（否则 rotateSession 不会生成摘要）。
    session.sdkSessionId = 'sdk_fake_for_test';
    session.messageCount = entries.filter((e) => e.role === 'user').length;
    session.totalTurns = entries.length;
    writeActiveSession(testUserId, session);

    if (entries.length > 0) {
      appendConversation(testUserId, session.localId, entries);
    }
    return session.localId;
  }

  // ── 1. 轮转应生成 AI 摘要并写入归档 session ──

  it('should generate AI summary and write to archived session metadata', async () => {
    const now = new Date().toISOString();
    const oldLocalId = setupSessionWithConversation([
      { timestamp: now, role: 'user', content: '你好，我想聊聊今天的天气。' },
      { timestamp: now, role: 'assistant', content: '你好！今天天气晴朗，气温在20度左右，非常适合外出。' },
      { timestamp: now, role: 'user', content: '那我打算去公园散步。' },
      { timestamp: now, role: 'assistant', content: '好主意！记得带水和防晒霜。' },
    ]);

    const newSession = await rotateSession(testUserId, 'manual');

    // 新 session 应已创建。
    expect(newSession.localId).not.toBe(oldLocalId);

    // 归档 session 应存在且有摘要。
    const archived = listArchivedSessions(testUserId);
    expect(archived.length).toBe(1);
    expect(archived[0].localId).toBe(oldLocalId);
    expect(archived[0].endedAt).toBeTruthy();
    expect(archived[0].summary).toBeTruthy();
    expect(typeof archived[0].summary).toBe('string');
    expect(archived[0].summary!.length).toBeGreaterThan(10);

    // summary.txt 文件应已在 session 目录中生成。
    const summaryFilePath = join(sessionsDir(testUserId), oldLocalId, 'summary.txt');
    expect(existsSync(summaryFilePath)).toBe(true);
    const fileContent = readFileSync(summaryFilePath, 'utf-8').trim();
    expect(fileContent.length).toBeGreaterThan(10);

    // 摘要不应包含对话式废话。
    expect(archived[0].summary!).not.toMatch(/I'd be happy/i);
    expect(archived[0].summary!).not.toMatch(/Here is the summary/i);
    expect(archived[0].summary!).not.toMatch(/^Sure/i);

    // 应包含中文（对话是中文的）。
    expect(archived[0].summary!).toMatch(/[\u4e00-\u9fff]/);
  }, 120_000);

  // ── 2. 轮转应提取 carryover 到新 session ──

  it('should extract carryover from old session into new session', async () => {
    const now = new Date().toISOString();
    setupSessionWithConversation([
      { timestamp: now, role: 'user', content: 'First question' },
      { timestamp: now, role: 'assistant', content: 'First answer' },
      { timestamp: now, role: 'user', content: 'Second question' },
      { timestamp: now, role: 'assistant', content: 'Second answer' },
    ]);

    const newSession = await rotateSession(testUserId, 'manual');

    // 新 session 应有 carryover。
    const activeSession = readActiveSession(testUserId);
    expect(activeSession).not.toBeNull();
    expect(activeSession!.localId).toBe(newSession.localId);
    expect(activeSession!.carryover).toBeDefined();
    expect(activeSession!.carryover!.length).toBeGreaterThan(0);

    // Carryover 应包含 user 和 assistant 消息。
    const userEntries = activeSession!.carryover!.filter((e) => e.role === 'user');
    const assistantEntries = activeSession!.carryover!.filter((e) => e.role === 'assistant');
    expect(userEntries.length).toBeGreaterThan(0);
    expect(assistantEntries.length).toBeGreaterThan(0);
  }, 120_000);

  // ── 3. Carryover 应只保留每轮最后一条 assistant ──

  it('should only keep the last assistant message per turn in carryover', async () => {
    const now = new Date().toISOString();
    setupSessionWithConversation([
      { timestamp: now, role: 'user', content: 'Question' },
      { timestamp: now, role: 'assistant', content: 'Intermediate thinking...' },
      { timestamp: now, role: 'assistant', content: 'More intermediate...' },
      { timestamp: now, role: 'assistant', content: 'Final answer to question' },
    ]);

    await rotateSession(testUserId, 'manual');

    const activeSession = readActiveSession(testUserId);
    expect(activeSession!.carryover).toBeDefined();

    // 应该只有 1 个 user + 1 个 assistant（最后一条）。
    expect(activeSession!.carryover!.length).toBe(2);
    expect(activeSession!.carryover![0].role).toBe('user');
    expect(activeSession!.carryover![0].content).toBe('Question');
    expect(activeSession!.carryover![1].role).toBe('assistant');
    expect(activeSession!.carryover![1].content).toBe('Final answer to question');
  }, 120_000);

  // ── 4. Carryover 应对长消息做 digest ──

  it('should digest long messages in carryover', async () => {
    const now = new Date().toISOString();
    const longUserMsg = 'U'.repeat(1000);
    const longAssistantMsg = 'A'.repeat(2000);

    setupSessionWithConversation([
      { timestamp: now, role: 'user', content: longUserMsg },
      { timestamp: now, role: 'assistant', content: longAssistantMsg },
    ]);

    await rotateSession(testUserId, 'manual');

    const activeSession = readActiveSession(testUserId);
    const carryover = activeSession!.carryover!;

    // User 消息应被截断。
    expect(carryover[0].content.length).toBeLessThan(longUserMsg.length);
    expect(carryover[0].content).toContain('1000 chars total');

    // Assistant 消息应做 head+tail digest。
    expect(carryover[1].content.length).toBeLessThan(longAssistantMsg.length);
    expect(carryover[1].content).toContain('omitted');
    expect(carryover[1].content).toContain('2000 chars total');
  }, 120_000);

  // ── 5. 空对话的轮转应正常完成（不崩溃） ──

  it('should handle rotation of session with no conversation', async () => {
    setupSessionWithConversation([]);

    const newSession = await rotateSession(testUserId, 'manual');
    expect(newSession.localId).toBeTruthy();

    const archived = listArchivedSessions(testUserId);
    expect(archived.length).toBe(1);
    // 空对话的摘要应为 "Empty session."
    expect(archived[0].summary).toBe('Empty session.');

    // Carryover 应为空或不存在。
    const activeSession = readActiveSession(testUserId);
    const hasCarryover = activeSession?.carryover && activeSession.carryover.length > 0;
    expect(hasCarryover).toBeFalsy();
  }, 120_000);

  // ── 6. 摘要 API 失败时应使用 fallback 摘要，不崩溃 ──

  it('should use fallback summary when API returns empty session', async () => {
    // 空对话不会调 API，直接返回 "Empty session."
    setupSessionWithConversation([]);

    const newSession = await rotateSession(testUserId, 'manual');

    const archived = listArchivedSessions(testUserId);
    expect(archived.length).toBe(1);
    expect(archived[0].summary).toBeDefined();
    expect(typeof archived[0].summary).toBe('string');
  }, 120_000);

  // ── 7. 多次轮转应正确累积归档和 carryover ──

  it('should handle consecutive rotations correctly', async () => {
    const now = new Date().toISOString();

    // 第一轮对话。
    setupSessionWithConversation([
      { timestamp: now, role: 'user', content: 'Session 1 question' },
      { timestamp: now, role: 'assistant', content: 'Session 1 answer' },
    ]);
    await rotateSession(testUserId, 'timeout');

    // 第二轮对话（在新 session 中模拟）。
    const session2 = readActiveSession(testUserId)!;
    session2.sdkSessionId = 'sdk_fake_session2';
    session2.messageCount = 1;
    session2.totalTurns = 2;
    writeActiveSession(testUserId, session2);
    appendConversation(testUserId, session2.localId, [
      { timestamp: now, role: 'user', content: 'Session 2 question' },
      { timestamp: now, role: 'assistant', content: 'Session 2 answer' },
    ]);
    await rotateSession(testUserId, 'manual');

    // 应有 2 个归档 session。
    const archived = listArchivedSessions(testUserId);
    expect(archived.length).toBe(2);

    // 每个归档 session 都应有摘要。
    for (const s of archived) {
      expect(s.summary).toBeTruthy();
    }

    // 最新的活跃 session 应有来自 session2 的 carryover。
    const activeSession = readActiveSession(testUserId);
    expect(activeSession!.carryover).toBeDefined();
    expect(activeSession!.carryover!.length).toBeGreaterThan(0);

    // Carryover 应包含 session2 的内容。
    const carryoverText = activeSession!.carryover!.map((e) => e.content).join(' ');
    expect(carryoverText).toContain('Session 2');
  }, 120_000);
});
