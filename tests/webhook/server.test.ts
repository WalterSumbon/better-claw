import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { startWebhookServer, stopWebhookServer } from '../../src/webhook/server.js';
import type { WebhookHandler, WebhookNotifyRequest } from '../../src/webhook/types.js';
import { createTestEnv } from '../helpers/setup.js';

/**
 * 等待指定毫秒数。
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 发送 HTTP POST 请求到 webhook 服务器。
 */
async function postWebhook(
  port: number,
  body: Record<string, unknown>,
  apiKey?: string,
): Promise<{ status: number; data: unknown }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) {
    headers['X-API-Key'] = apiKey;
  }

  const response = await fetch(`http://localhost:${port}/api/webhook/notify`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  const data = await response.json();
  return { status: response.status, data };
}

/**
 * Webhook 服务器单元测试。
 *
 * 测试 HTTP 服务器的请求处理、参数校验和 API Key 验证。
 */
describe('Webhook Server', () => {
  let cleanup: () => Promise<void>;

  beforeAll(() => {
    const env = createTestEnv();
    cleanup = env.cleanup;
  });

  afterAll(async () => {
    await cleanup();
  });

  describe('without API Key validation', () => {
    const port = 13571;
    let receivedRequests: WebhookNotifyRequest[];

    const mockHandler: WebhookHandler = {
      async notify(req: WebhookNotifyRequest) {
        receivedRequests.push(req);
      },
    };

    beforeEach(async () => {
      receivedRequests = [];
      startWebhookServer(port, undefined, mockHandler);
      await sleep(100); // 等待服务器启动
    });

    afterEach(async () => {
      await stopWebhookServer();
      await sleep(50); // 等待端口释放
    });

    it('should accept valid request with message', async () => {
      const { status, data } = await postWebhook(port, {
        userId: 'user_123',
        message: 'Hello!',
      });

      expect(status).toBe(200);
      expect(data).toEqual({ success: true });
      expect(receivedRequests).toHaveLength(1);
      expect(receivedRequests[0]).toMatchObject({
        userId: 'user_123',
        message: 'Hello!',
      });
    });

    it('should accept valid request with prompt', async () => {
      const { status, data } = await postWebhook(port, {
        userId: 'user_123',
        prompt: 'Analyze this',
        data: { key: 'value' },
      });

      expect(status).toBe(200);
      expect(data).toEqual({ success: true });
      expect(receivedRequests).toHaveLength(1);
      expect(receivedRequests[0]).toMatchObject({
        userId: 'user_123',
        prompt: 'Analyze this',
        data: { key: 'value' },
      });
    });

    it('should accept request with both message and prompt', async () => {
      const { status, data } = await postWebhook(port, {
        userId: 'user_123',
        message: 'Hello!',
        prompt: 'Also analyze',
      });

      expect(status).toBe(200);
      expect(data).toEqual({ success: true });
    });

    it('should accept request with platform specified', async () => {
      const { status, data } = await postWebhook(port, {
        userId: 'user_123',
        message: 'Hello!',
        platform: 'telegram',
      });

      expect(status).toBe(200);
      expect(data).toEqual({ success: true });
      expect(receivedRequests[0].platform).toBe('telegram');
    });

    it('should reject request without userId', async () => {
      const { status, data } = await postWebhook(port, {
        message: 'Hello!',
      });

      expect(status).toBe(400);
      expect(data).toEqual({ error: 'userId is required' });
      expect(receivedRequests).toHaveLength(0);
    });

    it('should reject request without message or prompt', async () => {
      const { status, data } = await postWebhook(port, {
        userId: 'user_123',
      });

      expect(status).toBe(400);
      expect(data).toEqual({ error: 'message or prompt is required' });
      expect(receivedRequests).toHaveLength(0);
    });

    it('should reject request with only data (no message/prompt)', async () => {
      const { status, data } = await postWebhook(port, {
        userId: 'user_123',
        data: { key: 'value' },
      });

      expect(status).toBe(400);
      expect(data).toEqual({ error: 'message or prompt is required' });
    });
  });

  describe('with API Key validation', () => {
    const port = 13572;
    const apiKey = 'test-secret-key';
    let receivedRequests: WebhookNotifyRequest[];

    const mockHandler: WebhookHandler = {
      async notify(req: WebhookNotifyRequest) {
        receivedRequests.push(req);
      },
    };

    beforeEach(async () => {
      receivedRequests = [];
      startWebhookServer(port, apiKey, mockHandler);
      await sleep(100);
    });

    afterEach(async () => {
      await stopWebhookServer();
      await sleep(50);
    });

    it('should accept request with valid API Key', async () => {
      const { status, data } = await postWebhook(
        port,
        { userId: 'user_123', message: 'Hello!' },
        apiKey,
      );

      expect(status).toBe(200);
      expect(data).toEqual({ success: true });
      expect(receivedRequests).toHaveLength(1);
    });

    it('should reject request without API Key', async () => {
      const { status, data } = await postWebhook(port, {
        userId: 'user_123',
        message: 'Hello!',
      });

      expect(status).toBe(401);
      expect(data).toEqual({ error: 'Unauthorized' });
      expect(receivedRequests).toHaveLength(0);
    });

    it('should reject request with wrong API Key', async () => {
      const { status, data } = await postWebhook(
        port,
        { userId: 'user_123', message: 'Hello!' },
        'wrong-key',
      );

      expect(status).toBe(401);
      expect(data).toEqual({ error: 'Unauthorized' });
      expect(receivedRequests).toHaveLength(0);
    });
  });

  describe('error handling', () => {
    const port = 13573;

    afterEach(async () => {
      await stopWebhookServer();
      await sleep(50);
    });

    it('should return 404 for non-existent endpoint', async () => {
      const mockHandler: WebhookHandler = {
        async notify() {},
      };
      startWebhookServer(port, undefined, mockHandler);
      await sleep(100);

      const response = await fetch(`http://localhost:${port}/api/other`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data).toEqual({ error: 'Not found' });
    });

    it('should return 404 for GET request', async () => {
      const mockHandler: WebhookHandler = {
        async notify() {},
      };
      startWebhookServer(port, undefined, mockHandler);
      await sleep(100);

      const response = await fetch(`http://localhost:${port}/api/webhook/notify`, {
        method: 'GET',
      });

      expect(response.status).toBe(404);
    });

    it('should return 500 when handler throws error', async () => {
      const errorHandler: WebhookHandler = {
        async notify() {
          throw new Error('Handler failed');
        },
      };

      startWebhookServer(port, undefined, errorHandler);
      await sleep(100);

      const { status, data } = await postWebhook(port, {
        userId: 'user_123',
        message: 'Hello!',
      });

      expect(status).toBe(500);
      expect(data).toEqual({ error: 'Handler failed' });
    });
  });

  describe('server lifecycle', () => {
    const port = 13574;

    it('should stop gracefully', async () => {
      const mockHandler: WebhookHandler = {
        async notify() {},
      };
      startWebhookServer(port, undefined, mockHandler);
      await sleep(100);

      // 确认服务器运行中
      const { status: status1 } = await postWebhook(port, {
        userId: 'user_123',
        message: 'Hello!',
      });
      expect(status1).toBe(200);

      // 停止服务器
      await stopWebhookServer();
      await sleep(100);

      // 确认服务器已停止
      try {
        await postWebhook(port, { userId: 'user_123', message: 'Hello!' });
        // 如果没有抛出错误，测试失败
        expect.fail('Expected connection refused error');
      } catch (err) {
        // 预期会抛出连接错误
        expect((err as Error).message).toMatch(/ECONNREFUSED|fetch failed/);
      }
    });

    it('should handle multiple stop calls gracefully', async () => {
      const mockHandler: WebhookHandler = {
        async notify() {},
      };
      startWebhookServer(port, undefined, mockHandler);
      await sleep(100);

      await stopWebhookServer();
      // 第二次调用应该不会报错
      await stopWebhookServer();
    });
  });
});
