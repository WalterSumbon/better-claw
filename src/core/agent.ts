import {
  query,
  type Query,
  type SDKMessage,
  type SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { getConfig } from '../config/index.js';
import { getLogger } from '../logger/index.js';
import type { SendFileOptions } from '../adapter/interface.js';
import { agentContext } from './agent-context.js';
import { buildSystemPrompt } from './system-prompt.js';
import { createAppMcpServer } from '../mcp/server.js';
import { readSession, writeSession } from './session-store.js';

/** 每个用户的 agent 会话状态。 */
interface AgentSession {
  /** 当前 session ID（用于 resume）。 */
  sessionId: string | null;
  /** 当前活跃的 Query 实例。 */
  activeQuery: Query | null;
}

/** 用户 ID → 会话状态映射。 */
const sessions = new Map<string, AgentSession>();

/** 全局 MCP 服务器实例（惰性初始化）。 */
let mcpServer: ReturnType<typeof createAppMcpServer> | null = null;

/**
 * 获取或创建 MCP 服务器实例。
 *
 * @returns MCP 服务器配置。
 */
function getMcpServer() {
  if (!mcpServer) {
    mcpServer = createAppMcpServer();
  }
  return mcpServer;
}

/**
 * 获取或创建用户的会话状态。
 *
 * @param userId - 用户 ID。
 * @returns 会话状态对象。
 */
function getSession(userId: string): AgentSession {
  let session = sessions.get(userId);
  if (!session) {
    // 尝试从磁盘加载持久化的 session ID。
    const persisted = readSession(userId);
    session = {
      sessionId: persisted?.sessionId ?? null,
      activeQuery: null,
    };
    sessions.set(userId, session);
  }
  return session;
}

/**
 * 判断消息是否为最终结果。
 *
 * @param msg - SDK 消息。
 * @returns 是否为结果消息。
 */
export function isResultMessage(msg: SDKMessage): msg is SDKResultMessage {
  return msg.type === 'result';
}

/**
 * 向 agent 发送消息并流式接收响应。
 *
 * @param userId - 用户 ID。
 * @param message - 用户消息文本。
 * @param onMessage - 每条 SDK 消息的回调。
 * @param sendFile - 可选的文件发送回调，供 MCP 工具使用。
 * @returns 最终结果消息。
 */
export async function sendToAgent(
  userId: string,
  message: string,
  onMessage: (msg: SDKMessage) => void,
  sendFile?: (filePath: string, options?: SendFileOptions) => Promise<void>,
): Promise<SDKResultMessage> {
  const log = getLogger();
  const config = getConfig();
  const session = getSession(userId);

  log.info({ userId, messageLength: message.length }, 'Sending message to agent');

  const systemPrompt = buildSystemPrompt(userId);

  const options: Parameters<typeof query>[0]['options'] = {
    systemPrompt,
    model: config.anthropic.model,
    permissionMode: config.permissionMode as 'default' | 'acceptEdits' | 'bypassPermissions',
    allowDangerouslySkipPermissions: config.permissionMode === 'bypassPermissions',
    mcpServers: {
      'better-claw': getMcpServer(),
      // 动态挂载外部 MCP 扩展。
      ...(config.mcpExtensions.playwright.enabled && {
        'playwright': {
          command: 'npx',
          args: ['@playwright/mcp@latest'],
        },
      }),
      ...(config.mcpExtensions.peekaboo.enabled && {
        'peekaboo': {
          command: 'npx',
          args: ['-y', '@steipete/peekaboo'],
        },
      }),
    },
    allowedTools: [
      'mcp__better-claw__memory_read',
      'mcp__better-claw__memory_write',
      'mcp__better-claw__memory_delete',
      'mcp__better-claw__cron_create',
      'mcp__better-claw__cron_list',
      'mcp__better-claw__cron_update',
      'mcp__better-claw__cron_delete',
      'mcp__better-claw__send_file',
      'mcp__better-claw__restart',
    ],
    includePartialMessages: true,
    maxBudgetUsd: config.anthropic.maxBudgetUsd,
    thinking: { type: 'adaptive' as const },
    cwd: config.agentCwd ?? process.cwd(),
  };

  // 如果有之前的 session，尝试 resume。
  if (session.sessionId) {
    options.resume = session.sessionId;
  }

  // 在 agentContext 中运行，使 MCP 工具能获取 userId 和 sendFile。
  const resultMessage = await agentContext.run({ userId, sendFile }, async () => {
    const q = query({ prompt: message, options });
    session.activeQuery = q;

    let result: SDKResultMessage | null = null;

    try {
      for await (const msg of q) {
        // 捕获 session_id 并持久化到磁盘。
        if ('session_id' in msg && msg.session_id) {
          session.sessionId = msg.session_id;
          writeSession(userId, msg.session_id);
        }

        onMessage(msg);

        if (isResultMessage(msg)) {
          result = msg;
        }
      }
    } finally {
      session.activeQuery = null;
    }

    if (!result) {
      throw new Error('Agent query completed without result message');
    }

    return result;
  });

  log.info(
    {
      userId,
      sessionId: session.sessionId,
      costUsd: resultMessage.total_cost_usd,
      turns: resultMessage.num_turns,
      durationMs: resultMessage.duration_ms,
    },
    'Agent query completed',
  );

  return resultMessage;
}

/**
 * 中断指定用户的 agent 执行。
 *
 * @param userId - 用户 ID。
 */
export async function interruptAgent(userId: string): Promise<void> {
  const session = getSession(userId);
  if (session.activeQuery) {
    const log = getLogger();
    log.info({ userId }, 'Interrupting agent');
    await session.activeQuery.interrupt();
  }
}

/**
 * 检查指定用户是否有活跃的 agent 查询。
 *
 * @param userId - 用户 ID。
 * @returns 是否正在执行。
 */
export function isAgentBusy(userId: string): boolean {
  const session = sessions.get(userId);
  return session?.activeQuery !== null;
}
