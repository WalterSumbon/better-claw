import { describe, it, expect, afterEach } from 'vitest';
import { query, type SDKMessage, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { createTestEnv } from '../helpers/setup.js';

/**
 * Claude Agent SDK 端到端测试。
 *
 * 注意：这些测试需要已认证的 Claude Code CLI，
 * 且不能在 Claude Code 会话内运行（需 unset CLAUDECODE）。
 * 每个测试有较长的超时时间，因为 SDK 需要启动 CLI 进程。
 */
describe('SDK basic e2e', () => {
  it('should complete a simple query and return a result message', async () => {
    const messages: SDKMessage[] = [];

    const q = query({
      prompt: 'Reply with exactly: HELLO_BETTER_CLAW',
      options: {
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        maxTurns: 1,
      },
    });

    for await (const msg of q) {
      messages.push(msg);
    }

    // 应至少收到一条消息。
    expect(messages.length).toBeGreaterThan(0);

    // 最后一条应为 result 类型。
    const last = messages[messages.length - 1];
    expect(last.type).toBe('result');

    const result = last as SDKResultMessage;
    expect(result.subtype).toBe('success');

    // 成功的结果应包含我们要求的文本。
    if (result.subtype === 'success') {
      expect(result.result).toContain('HELLO_BETTER_CLAW');
    }
  }, 120_000);
});

describe('SDK with MCP server e2e', () => {
  let cleanup: () => void;

  afterEach(() => {
    cleanup?.();
  });

  it('should load custom MCP server and complete query', async () => {
    const { createAppMcpServer } = await import('../../src/mcp/server.js');
    const { createUser, bindPlatform } = await import('../../src/user/manager.js');

    // 使用临时目录隔离测试数据。
    const env = createTestEnv();
    cleanup = env.cleanup;

    // 创建测试用户。
    const testUser = createUser('e2e-test');
    bindPlatform(testUser.token, 'cli', 'e2e_cli_user');

    const mcpServer = createAppMcpServer();
    const messages: SDKMessage[] = [];

    const q = query({
      prompt: 'Use the memory_write tool to write a test entry: category "preferences", key "test_key", content "test_value". Then confirm what you wrote.',
      options: {
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        mcpServers: {
          'better-claw': mcpServer,
        },
        maxTurns: 5,
      },
    });

    for await (const msg of q) {
      messages.push(msg);
    }

    const last = messages[messages.length - 1];
    expect(last.type).toBe('result');

    const result = last as SDKResultMessage;
    expect(result.subtype).toBe('success');
  }, 180_000);
});

describe('Full app startup e2e', () => {
  let cleanup: () => void;

  afterEach(() => {
    cleanup?.();
  });

  it('should start the app, process a message, and get a response', async () => {
    const { resolveUser, createUser, bindPlatform } = await import('../../src/user/manager.js');
    const { enqueue } = await import('../../src/core/queue.js');

    // 使用临时目录隔离测试数据。
    const env = createTestEnv();
    cleanup = env.cleanup;

    // 创建测试用户并绑定。
    const testUser = createUser('app-e2e-test');
    bindPlatform(testUser.token, 'cli', 'app_e2e_user');
    const userId = resolveUser('cli', 'app_e2e_user');
    expect(userId).toBeTruthy();

    // 通过队列发送消息并等待回复。
    const replies: string[] = [];
    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timeout: no reply within 120s')), 120_000);
      enqueue({
        userId: userId!,
        text: 'Reply with exactly: E2E_TEST_OK',
        reply: (text: string) => {
          replies.push(text);
          // 收到包含目标文本的回复后完成。
          if (text.includes('E2E_TEST_OK')) {
            clearTimeout(timer);
            resolve();
          }
        },
        showTyping: () => {},
        platform: 'cli',
      });
    });

    await done;
    expect(replies.some((r) => r.includes('E2E_TEST_OK'))).toBe(true);
  }, 180_000);
});
