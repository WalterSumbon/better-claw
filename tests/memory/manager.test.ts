import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createUser } from '../../src/user/manager.js';
import {
  writeExtendedMemory,
  readExtendedMemory,
  listExtendedMemoryEntries,
  listExtendedMemoryKeys,
  deleteExtendedMemory,
} from '../../src/memory/manager.js';
import { createTestEnv } from '../helpers/setup.js';

/**
 * Extended Memory summary 字段单元测试。
 *
 * 覆盖：summary 写入/读取、列表展示、更新保留/覆盖逻辑。
 */
describe('Extended Memory - summary field', () => {
  let testUserId: string;
  let cleanup: () => Promise<void>;

  beforeEach(() => {
    const env = createTestEnv();
    cleanup = env.cleanup;
    const user = createUser('memory-test');
    testUserId = user.userId;
  });

  afterEach(async () => {
    await cleanup();
  });

  // ── 写入与读取 ──

  it('should save summary when provided', () => {
    writeExtendedMemory(testUserId, 'project-plan', 'Full content here', 'One-line summary of project plan');

    const entry = readExtendedMemory(testUserId, 'project-plan');
    expect(entry).not.toBeNull();
    expect(entry!.key).toBe('project-plan');
    expect(entry!.content).toBe('Full content here');
    expect(entry!.summary).toBe('One-line summary of project plan');
  });

  it('should save entry without summary when not provided', () => {
    writeExtendedMemory(testUserId, 'no-summary-key', 'Some content');

    const entry = readExtendedMemory(testUserId, 'no-summary-key');
    expect(entry).not.toBeNull();
    expect(entry!.summary).toBeUndefined();
  });

  // ── 更新时的 summary 保留/覆盖 ──

  it('should preserve existing summary when updating content without providing summary', () => {
    writeExtendedMemory(testUserId, 'keep-summary', 'v1 content', 'Original summary');
    writeExtendedMemory(testUserId, 'keep-summary', 'v2 content');

    const entry = readExtendedMemory(testUserId, 'keep-summary');
    expect(entry!.content).toBe('v2 content');
    expect(entry!.summary).toBe('Original summary');
  });

  it('should overwrite summary when providing a new one', () => {
    writeExtendedMemory(testUserId, 'overwrite-summary', 'v1 content', 'Old summary');
    writeExtendedMemory(testUserId, 'overwrite-summary', 'v2 content', 'New summary');

    const entry = readExtendedMemory(testUserId, 'overwrite-summary');
    expect(entry!.content).toBe('v2 content');
    expect(entry!.summary).toBe('New summary');
  });

  it('should keep summary undefined when updating entry that never had summary', () => {
    writeExtendedMemory(testUserId, 'never-had-summary', 'v1');
    writeExtendedMemory(testUserId, 'never-had-summary', 'v2');

    const entry = readExtendedMemory(testUserId, 'never-had-summary');
    expect(entry!.summary).toBeUndefined();
  });

  // ── listExtendedMemoryEntries ──

  it('should list entries with key and summary', () => {
    writeExtendedMemory(testUserId, 'alpha', 'content a', 'Summary A');
    writeExtendedMemory(testUserId, 'beta', 'content b', 'Summary B');
    writeExtendedMemory(testUserId, 'gamma', 'content c');

    const entries = listExtendedMemoryEntries(testUserId);
    expect(entries.length).toBe(3);

    const alpha = entries.find((e) => e.key === 'alpha');
    expect(alpha).toBeDefined();
    expect(alpha!.summary).toBe('Summary A');

    const beta = entries.find((e) => e.key === 'beta');
    expect(beta!.summary).toBe('Summary B');

    const gamma = entries.find((e) => e.key === 'gamma');
    expect(gamma!.summary).toBeUndefined();
  });

  it('should return empty array when no extended memories exist', () => {
    const entries = listExtendedMemoryEntries(testUserId);
    expect(entries).toEqual([]);
  });

  // ── listExtendedMemoryKeys 向后兼容 ──

  it('should still work with listExtendedMemoryKeys (backward compat)', () => {
    writeExtendedMemory(testUserId, 'compat-key', 'content', 'summary');

    const keys = listExtendedMemoryKeys(testUserId);
    expect(keys).toContain('compat-key');
  });

  // ── 删除后列表更新 ──

  it('should not include deleted entries in list', () => {
    writeExtendedMemory(testUserId, 'to-delete', 'content', 'will be deleted');
    writeExtendedMemory(testUserId, 'to-keep', 'content', 'will remain');

    deleteExtendedMemory(testUserId, 'to-delete');

    const entries = listExtendedMemoryEntries(testUserId);
    expect(entries.length).toBe(1);
    expect(entries[0].key).toBe('to-keep');
  });
});
