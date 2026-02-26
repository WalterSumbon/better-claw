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
import type { ConversationBlock } from './session-store.js';
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
  /** 当前查询是否被用户主动中断（/stop）。 */
  interrupted: boolean;
}

/** 用户通过 /stop 主动中断时抛出的错误。 */
export class AgentInterruptedError extends Error {
  constructor() {
    super('Agent interrupted by user');
    this.name = 'AgentInterruptedError';
  }
}

/** API 限额触发时抛出的错误，携带限额重置时间。 */
export class RateLimitError extends Error {
  /** 限额重置时间（Unix 毫秒时间戳），无法获取时为 null。 */
  resetsAt: number | null;

  constructor(resetsAt: number | null) {
    super('Rate limit exceeded');
    this.name = 'RateLimitError';
    this.resetsAt = resetsAt;
  }
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
      interrupted: false,
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

  // 重置中断标志。
  session.interrupted = false;

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

  /** 采集到的完整交互块。 */
  const collectedBlocks: ConversationBlock[] = [];

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

    // Rate limit 检测状态。
    let hitRateLimit = false;
    let lastResetsAt: number | null = null;

    try {
      for await (const msg of q) {
        // 捕获 rate_limit_event，记录最新的重置时间。
        if ((msg as { type: string }).type === 'rate_limit_event') {
          const rateLimitMsg = msg as { rate_limit_info?: { resetsAt?: number; status?: string } };
          if (rateLimitMsg.rate_limit_info?.resetsAt) {
            lastResetsAt = rateLimitMsg.rate_limit_info.resetsAt;
          }
          log.info(
            { userId, rateLimitInfo: rateLimitMsg.rate_limit_info },
            'Rate limit event received',
          );
        }

        // 检测 assistant 消息的 rate_limit 错误标记。
        if (msg.type === 'assistant' && (msg as { error?: string }).error === 'rate_limit') {
          hitRateLimit = true;
          log.warn({ userId, resetsAt: lastResetsAt }, 'Rate limit error detected in assistant message');
        }

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

        // 从 assistant 消息中提取 input_tokens 和内容块。
        if (msg.type === 'assistant') {
          const assistantMsg = msg as { message?: { usage?: { input_tokens?: number }; content?: Array<{ type: string; text?: string; thinking?: string; name?: string; id?: string; input?: unknown }> } };
          const usage = assistantMsg.message?.usage;
          if (usage?.input_tokens) {
            lastInputTokens = usage.input_tokens;
          }

          // 采集 assistant 内容块（thinking / text / tool_use）。
          const contentBlocks = assistantMsg.message?.content;
          if (contentBlocks) {
            for (const block of contentBlocks) {
              if (block.type === 'thinking' && block.thinking) {
                collectedBlocks.push({ type: 'thinking', text: block.thinking });
              } else if (block.type === 'text' && block.text) {
                collectedBlocks.push({ type: 'text', text: block.text });
              } else if (block.type === 'tool_use') {
                collectedBlocks.push({
                  type: 'tool_use',
                  toolName: block.name,
                  toolId: block.id,
                  input: block.input,
                });
              }
            }
          }
        }

        // 从 user 消息中提取 tool_result（带 parent_tool_use_id 的是工具返回）。
        if (msg.type === 'user') {
          const userMsg = msg as { parent_tool_use_id?: string | null; message?: { content?: unknown } };
          if (userMsg.parent_tool_use_id) {
            // 提取 tool_result 内容文本。
            let resultText = '';
            const content = userMsg.message?.content;
            if (Array.isArray(content)) {
              for (const block of content as Array<{ type: string; content?: unknown; text?: string }>) {
                if (block.type === 'tool_result') {
                  // tool_result 的 content 可能是 string 或 content block 数组。
                  const inner = block.content;
                  if (typeof inner === 'string') {
                    resultText += inner;
                  } else if (Array.isArray(inner)) {
                    for (const ib of inner as Array<{ type: string; text?: string }>) {
                      if (ib.type === 'text' && ib.text) {
                        resultText += ib.text;
                      }
                    }
                  }
                }
              }
            }
            collectedBlocks.push({
              type: 'tool_result',
              toolId: userMsg.parent_tool_use_id,
              text: resultText || '[no output]',
            });
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
      if (session.interrupted) {
        throw new AgentInterruptedError();
      }
      throw new Error('Agent query completed without result message');
    }

    // 如果检测到 rate limit 错误，抛出 RateLimitError 供上层处理。
    if (hitRateLimit) {
      throw new RateLimitError(lastResetsAt);
    }

    return result;
  }

  const resultMessage = await agentContext.run({ userId, sendFile }, async () => {
    try {
      return await executeQuery(options);
    } catch (err) {
      // 用户主动中断，不重试。
      if (err instanceof AgentInterruptedError) {
        throw err;
      }
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
  }, collectedBlocks);

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
    session.interrupted = true;
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
