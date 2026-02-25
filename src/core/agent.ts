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
import { readActiveSession, writeActiveSession } from './session-store.js';
import {
  ensureActiveSession,
  updateSessionAfterQuery,
} from './session-manager.js';
import { getUserWorkspacePath } from '../user/store.js';

/** 每个用户的 agent 会话状态（内存中）。 */
interface AgentSession {
  /** 本地会话 ID。 */
  localSessionId: string | null;
  /** 当前 SDK session ID（用于 resume）。 */
  sdkSessionId: string | null;
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
 * 获取或创建用户的内存会话状态。
 *
 * @param userId - 用户 ID。
 * @returns 会话状态对象。
 */
function getSession(userId: string): AgentSession {
  let session = sessions.get(userId);
  if (!session) {
    // 尝试从磁盘加载持久化的会话。
    const persisted = readActiveSession(userId);
    session = {
      localSessionId: persisted?.localId ?? null,
      sdkSessionId: persisted?.sdkSessionId ?? null,
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
 * 会话管理逻辑：
 * 1. 发送前检查是否需要轮转（时间间隔 / 轮次阈值）。
 * 2. 如需轮转，归档旧会话并创建新会话。
 * 3. 发送后更新会话元数据和对话记录。
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

  // ── 会话管理：确保有活跃会话，必要时自动轮转 ──
  const { session: activeSession, rotated, reason } = await ensureActiveSession(userId);

  if (rotated) {
    log.info(
      { userId, reason, newLocalId: activeSession.localId },
      'Session auto-rotated before query',
    );
  }

  // 同步内存状态。
  const session = getSession(userId);
  session.localSessionId = activeSession.localId;
  session.sdkSessionId = activeSession.sdkSessionId;

  // 如果发生了轮转，清除内存中的 SDK session ID（新会话不 resume）。
  if (rotated) {
    session.sdkSessionId = null;
  }

  log.info({ userId, messageLength: message.length }, 'Sending message to agent');

  const systemPrompt = buildSystemPrompt(userId);

  // 构建传递给 SDK subprocess 的环境变量。
  const sdkEnv: Record<string, string | undefined> = { ...process.env };
  if (config.anthropic.apiKey) {
    sdkEnv.ANTHROPIC_API_KEY = config.anthropic.apiKey;
  } else if (!sdkEnv.ANTHROPIC_API_KEY) {
    delete sdkEnv.ANTHROPIC_API_KEY;
  }
  if (config.anthropic.authToken) {
    sdkEnv.ANTHROPIC_AUTH_TOKEN = config.anthropic.authToken;
  }
  if (config.anthropic.baseUrl) {
    sdkEnv.ANTHROPIC_BASE_URL = config.anthropic.baseUrl;
  }

  const options: Parameters<typeof query>[0]['options'] = {
    systemPrompt,
    model: config.anthropic.model,
    permissionMode: config.permissionMode as 'default' | 'acceptEdits' | 'bypassPermissions',
    allowDangerouslySkipPermissions: config.permissionMode === 'bypassPermissions',
    env: sdkEnv,
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
      'mcp__better-claw__session_new',
      'mcp__better-claw__session_list',
      'mcp__better-claw__session_info',
    ],
    includePartialMessages: true,
    maxBudgetUsd: config.anthropic.maxBudgetUsd,
    thinking: { type: 'adaptive' as const },
    cwd: getUserWorkspacePath(userId),
  };

  // 如果有 SDK session ID，尝试 resume。
  if (session.sdkSessionId) {
    options.resume = session.sdkSessionId;
  }

  // 在 agentContext 中运行，使 MCP 工具能获取 userId 和 sendFile。
  // 同时跟踪最新的 input_tokens（反映当前 context 大小）。
  let lastInputTokens = 0;

  /**
   * 执行一次 agent 查询，流式处理所有 SDK 消息。
   *
   * @param queryOptions - 传给 SDK query() 的选项。
   * @returns 最终结果消息。
   */
  async function executeQuery(queryOptions: typeof options): Promise<SDKResultMessage> {
    const q = query({ prompt: message, options: queryOptions });
    session.activeQuery = q;

    let result: SDKResultMessage | null = null;

    try {
      for await (const msg of q) {
        // 捕获 session_id 并更新到活跃会话。
        if ('session_id' in msg && msg.session_id) {
          session.sdkSessionId = msg.session_id;
          // 更新持久化的活跃会话中的 SDK session ID。
          const currentActive = readActiveSession(userId);
          if (currentActive) {
            currentActive.sdkSessionId = msg.session_id;
            currentActive.updatedAt = new Date().toISOString();
            writeActiveSession(userId, currentActive);
          }
        }

        // 从 assistant 消息中提取 input_tokens（= 当前 context 大小）。
        if (msg.type === 'assistant') {
          const usage = (msg as { message?: { usage?: { input_tokens?: number } } }).message?.usage;
          if (usage?.input_tokens) {
            lastInputTokens = usage.input_tokens;
          }
        }

        // 监听 SDK auto-compact 事件。
        if (msg.type === 'system') {
          const sysMsg = msg as { subtype?: string; status?: string; compact_metadata?: { trigger?: string; pre_tokens?: number } };
          if (sysMsg.subtype === 'compact_boundary') {
            log.info(
              {
                userId,
                trigger: sysMsg.compact_metadata?.trigger,
                preTokens: sysMsg.compact_metadata?.pre_tokens,
                localSessionId: session.localSessionId,
              },
              'SDK compact boundary detected',
            );
          }
          if (sysMsg.subtype === 'status' && sysMsg.status === 'compacting') {
            log.info({ userId, localSessionId: session.localSessionId }, 'SDK auto-compact in progress');
          }
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
  }

  const resultMessage = await agentContext.run({ userId, sendFile }, async () => {
    try {
      return await executeQuery(options);
    } catch (err) {
      // 如果使用了 resume 且进程崩溃，清除 session ID 后重试（不 resume）。
      if (options.resume) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.warn(
          { userId, sdkSessionId: options.resume, error: errMsg },
          'Agent query failed with resume, retrying without resume',
        );

        // 清除内存和持久化的 SDK session ID。
        session.sdkSessionId = null;
        const currentActive = readActiveSession(userId);
        if (currentActive) {
          currentActive.sdkSessionId = null;
          currentActive.updatedAt = new Date().toISOString();
          writeActiveSession(userId, currentActive);
        }

        const retryOptions = { ...options };
        delete retryOptions.resume;
        return await executeQuery(retryOptions);
      }
      throw err;
    }
  });

  // ── 会话管理：更新对话记录和元数据 ──
  // 使用查询开始时捕获的 localSessionId，确保即使 session_new 工具
  // 在查询期间触发了轮转，对话记录仍然写入正确的会话。
  const assistantResponse =
    resultMessage.subtype === 'success' && typeof resultMessage.result === 'string'
      ? resultMessage.result
      : '[No text response]';

  // 从 modelUsage 中提取当前模型的 context window 大小。
  let contextWindowTokens = 0;
  const modelUsage = (resultMessage as { modelUsage?: Record<string, { contextWindow?: number }> }).modelUsage;
  if (modelUsage) {
    // modelUsage 是 Record<modelName, ModelUsage>，取第一个有 contextWindow 的值。
    for (const usage of Object.values(modelUsage)) {
      if (usage.contextWindow && usage.contextWindow > contextWindowTokens) {
        contextWindowTokens = usage.contextWindow;
      }
    }
  }

  updateSessionAfterQuery(userId, activeSession.localId, message, assistantResponse, {
    costUsd: resultMessage.total_cost_usd,
    turns: resultMessage.num_turns,
    durationMs: resultMessage.duration_ms,
    contextTokens: lastInputTokens,
    contextWindowTokens,
  });

  log.info(
    {
      userId,
      localSessionId: session.localSessionId,
      sdkSessionId: session.sdkSessionId,
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

/**
 * 手动重置用户的 agent 会话（供 /new 命令和 MCP 工具调用）。
 * 清除内存中的 session 状态，使下一次查询时创建新会话。
 *
 * @param userId - 用户 ID。
 */
export function resetAgentSession(userId: string): void {
  const session = sessions.get(userId);
  if (session) {
    session.localSessionId = null;
    session.sdkSessionId = null;
  }
}
