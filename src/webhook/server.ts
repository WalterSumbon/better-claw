import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { getLogger } from '../logger/index.js';
import type { WebhookHandler, WebhookNotifyRequest, WebhookNotifyResponse } from './types.js';

/** Webhook 服务器实例。 */
let server: ReturnType<typeof createServer> | null = null;

/**
 * 解析 JSON 请求体。
 *
 * @param req - HTTP 请求对象。
 * @returns 解析后的 JSON 对象。
 */
async function parseBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks).toString('utf-8');
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * 发送 JSON 响应。
 *
 * @param res - HTTP 响应对象。
 * @param statusCode - HTTP 状态码。
 * @param data - 响应数据。
 */
function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

/**
 * 启动 Webhook HTTP 服务器。
 *
 * @param port - 监听端口。
 * @param apiKey - API 密钥（用于验证请求）。
 * @param handler - Webhook 处理器。
 */
export function startWebhookServer(
  port: number,
  apiKey: string | undefined,
  handler: WebhookHandler,
): void {
  const log = getLogger();

  server = createServer(async (req, res) => {
    // CORS 预检请求。
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
      });
      res.end();
      return;
    }

    // 只处理 POST /api/webhook/notify。
    if (req.method !== 'POST' || req.url !== '/api/webhook/notify') {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }

    // 验证 API Key（如果配置了）。
    if (apiKey) {
      const providedKey = req.headers['x-api-key'];
      if (providedKey !== apiKey) {
        log.warn({ providedKey: providedKey ? '[REDACTED]' : undefined }, 'Webhook: unauthorized request');
        sendJson(res, 401, { error: 'Unauthorized' });
        return;
      }
    }

    try {
      const body = await parseBody(req) as WebhookNotifyRequest;

      // 参数校验。
      if (!body.userId) {
        sendJson(res, 400, { error: 'userId is required' });
        return;
      }

      if (!body.message && !body.prompt) {
        sendJson(res, 400, { error: 'message or prompt is required' });
        return;
      }

      log.info(
        {
          userId: body.userId,
          platform: body.platform,
          hasMessage: !!body.message,
          hasPrompt: !!body.prompt,
        },
        'Webhook: notify request received',
      );

      await handler.notify(body);

      const response: WebhookNotifyResponse = { success: true };
      sendJson(res, 200, response);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      log.error({ err }, 'Webhook: notify request failed');
      sendJson(res, 500, { error: errorMessage });
    }
  });

  server.listen(port, () => {
    log.info({ port }, 'Webhook server started');
  });
}

/**
 * 停止 Webhook 服务器。
 */
export async function stopWebhookServer(): Promise<void> {
  if (server) {
    return new Promise((resolve) => {
      server!.close(() => {
        server = null;
        resolve();
      });
    });
  }
}
