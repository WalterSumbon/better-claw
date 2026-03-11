import {
  query,
  type Query,
  type SDKMessage,
  type SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { getConfig } from '../config/index.js';
import type { AppConfig } from '../config/schema.js';
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
  startBackgroundPrep,
  performInstantSwitch,
  getBgRotation,
  rotateSession,
} from './session-manager.js';
import { getUserWorkspacePath, readUserMcpServers } from '../user/store.js';
import { buildCanUseTool, buildSandboxSettings, resolveUserPermissions } from './permissions.js';
import { getProjectLocalSettings } from '../config/claude-settings.js';

/**
 * 为外部 MCP servers 注入用户 ID 环境变量。
 * 这样每个 MCP server 进程可以通过 BETTER_CLAW_USER_ID 识别当前用户。
 */
function injectUserEnvToMcpServers<T extends Record<string, { env?: Record<string, string> }>>(
  mcpServers: T,
  userId: string,
): T {
  const result = {} as Record<string, unknown>;
  for (const [name, server] of Object.entries(mcpServers)) {
    result[name] = {
      ...server,
      env: {
        ...server.env,
        BETTER_CLAW_USER_ID: userId,
      },
    };
  }
  return result as T;
}

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

/** Agent loop 中途达到 force context ratio 阈值时抛出，触发 mid-query 轮转。 */
class MidQueryRotationNeeded extends Error {
  constructor() {
    super('Mid-query rotation needed');
    this.name = 'MidQueryRotationNeeded';
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

/**
 * 创建新的 MCP 服务器实例。
 *
 * 每次 query() 调用都需要新实例，因为 SDK 会对 transport 调用 connect()，
 * 而同一个 Protocol transport 不能被多次 connect。
 * createAppMcpServer() 本身很轻量（仅构造对象 + 注册工具），无性能问题。
 */

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
 * 将通配符模式转换为正则表达式。
 *
 * 仅支持 * 通配符，匹配任意字符序列。
 *
 * @param pattern - 通配符模式（如 "SECRET_*"）。
 * @returns 编译后的正则表达式。
 */
export function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

/**
 * 构建传递给 SDK subprocess 的环境变量。
 *
 * admin 用户继承完整 process.env；非 admin 用户继承 process.env 后，
 * 按 config.permissions.envFilter 过滤匹配的变量，
 * 再按 config.permissions.envExtra 追加额外变量，
 * 最后从配置注入 SDK 必需的 Anthropic 变量。
 *
 * @param userId - 用户 ID。
 * @param config - 应用配置。
 * @returns 环境变量对象。
 */
export function buildSdkEnv(userId: string, config: AppConfig): Record<string, string | undefined> {
  const permissions = resolveUserPermissions(userId);
  if (permissions.isAdmin) {
    const env: Record<string, string | undefined> = { ...process.env };
    // 注入全局 sdkEnv 配置。
    for (const [key, value] of Object.entries(config.sdkEnv)) {
      env[key] = value;
    }
    if (config.anthropic.apiKey) {
      env.ANTHROPIC_API_KEY = config.anthropic.apiKey;
    }
    if (config.anthropic.authToken) {
      env.ANTHROPIC_AUTH_TOKEN = config.anthropic.authToken;
    }
    if (config.anthropic.baseUrl) {
      env.ANTHROPIC_BASE_URL = config.anthropic.baseUrl;
    }
    return env;
  }

  // 继承所有环境变量，按 envFilter 过滤。
  const filterPatterns = config.permissions.envFilter.map(globToRegex);
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!filterPatterns.some((re) => re.test(key))) {
      env[key] = value;
    }
  }

  // 追加 envExtra。
  for (const [key, value] of Object.entries(config.permissions.envExtra)) {
    env[key] = value;
  }

  // 注入全局 sdkEnv 配置。
  for (const [key, value] of Object.entries(config.sdkEnv)) {
    env[key] = value;
  }

  // SDK 必需的 Anthropic 变量。
  if (config.anthropic.apiKey) {
    env.ANTHROPIC_API_KEY = config.anthropic.apiKey;
  }
  if (config.anthropic.authToken) {
    env.ANTHROPIC_AUTH_TOKEN = config.anthropic.authToken;
  }
  if (config.anthropic.baseUrl) {
    env.ANTHROPIC_BASE_URL = config.anthropic.baseUrl;
  }

  return env;
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
  notifyUser?: (text: string) => Promise<void>,
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
    // 向用户推送自动轮转通知（如果配置启用）。
    if (config.session.notifyContextEvents && notifyUser) {
      const reasonLabel = reason === 'timeout' ? '闲置超时' : 'context 容量达到阈值';
      notifyUser(`🔄 Session 已自动轮转（${reasonLabel}）→ ${activeSession.localId}`);
    }
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

  // 构建传递给 SDK subprocess 的环境变量（非 admin 用户仅保留白名单）。
  const sdkEnv = buildSdkEnv(userId, config);

  const permissionMode = config.permissionMode as 'default' | 'acceptEdits' | 'bypassPermissions';

  const options: Parameters<typeof query>[0]['options'] = {
    systemPrompt,
    model: config.anthropic.model,
    permissionMode,
    ...(permissionMode === 'bypassPermissions'
      ? { allowDangerouslySkipPermissions: true }
      : {}),
    canUseTool: buildCanUseTool(userId),
    sandbox: buildSandboxSettings(userId),
    env: sdkEnv,
    mcpServers: {
      'better-claw': createAppMcpServer(),
      // 外部 MCP servers 注入 BETTER_CLAW_USER_ID 环境变量，实现多用户感知。
      // project/local 级 MCP servers（user 级由 SDK 通过 settingSources: ['user'] 自行加载）。
      ...injectUserEnvToMcpServers(getProjectLocalSettings().mcpServers, userId),
      // per-user MCP servers（<userDir>/mcp-servers.json）。
      // 每次读文件不缓存，天然支持热加载。后加载的优先级更高，可覆盖同名 server。
      ...injectUserEnvToMcpServers(readUserMcpServers(userId), userId),
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
      ...(config.restart.allowAgent ? ['mcp__better-claw__restart'] : []),
      'mcp__better-claw__session_new',
      'mcp__better-claw__session_list',
      'mcp__better-claw__session_info',
      'mcp__better-claw__load_skillset',
    ],
    includePartialMessages: true,
    maxBudgetUsd: config.anthropic.maxBudgetUsd,
    thinking: { type: 'adaptive' as const },
    cwd: getUserWorkspacePath(userId),
    // 加载 user 级 settings（~/.claude/settings.json），启用 ~/.claude/skills/ 原生 skill 发现。
    // 不加载 local 级 settings，避免其中 WebFetch(domain:...) 权限规则被 SDK 转化为沙箱限制。
    // project/local 级 MCP servers 和 disallowedTools 由 Better-Claw 通过对应 SDK option 注入。
    settingSources: ['user' as const],
    disallowedTools: [
      // 在 bypassPermissions 模式下，plan mode 的审批流程无法正常工作（用户看不到 plan）。
      'EnterPlanMode',
      'ExitPlanMode',
      // AskUserQuestion 在 bypassPermissions 模式下会被自动批准，用户根本看不到问题。
      'AskUserQuestion',
      ...getProjectLocalSettings().disallowedTools,
    ],
  };

  // 捕获 SDK 子进程的 stderr，用于错误诊断。
  let lastStderr = '';
  options.stderr = (data: string) => {
    lastStderr += data;
    // 只保留最后 2000 字符，避免内存膨胀。
    if (lastStderr.length > 2000) {
      lastStderr = lastStderr.slice(-2000);
    }
    log.debug({ userId, stderr: data.trim() }, 'SDK stderr');
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
  async function executeQuery(prompt: string, queryOptions: typeof options): Promise<SDKResultMessage> {
    const q = query({ prompt, options: queryOptions });
    session.activeQuery = q;

    let result: SDKResultMessage | null = null;
    let midQueryRotationTriggered = false;
    let softRotationStarted = false;

    // Rate limit 检测状态。
    let hitRateLimit = false;
    let lastResetsAt: number | null = null;

    // 从持久化 session 读取 contextWindowTokens（用于中间 ratio 检查）。
    const persistedSession = readActiveSession(userId);
    const ctxWindow = persistedSession?.contextWindowTokens ?? 0;

    try {
      for await (const msg of q) {
        // 记录每条 SDK 消息的类型和关键信息，便于调试。
        {
          const m = msg as Record<string, unknown>;
          const msgType = String(m.type);
          const subtype = m.subtype ? String(m.subtype) : undefined;
          const extra: Record<string, unknown> = { userId, msgType };
          if (subtype) extra.subtype = subtype;
          if (msgType === 'assistant') {
            const content = (m.message as Record<string, unknown>)?.content;
            if (Array.isArray(content)) {
              extra.blocks = content.map((b: Record<string, unknown>) => b.type);
            }
          }
          if (msgType === 'result') {
            extra.resultSubtype = subtype;
            if (m.error) extra.error = m.error;
            if (m.result) extra.result = typeof m.result === 'string' ? m.result.slice(0, 200) : m.result;
          }
          if (msgType === 'system') {
            extra.status = m.status;
          }
          log.debug(extra, 'SDK msg');
        }

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
          const assistantMsg = msg as { message?: { usage?: { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number }; content?: Array<{ type: string; text?: string; thinking?: string; name?: string; id?: string; input?: unknown }> } };
          const usage = assistantMsg.message?.usage;
          if (usage) {
            // 完整 context 大小 = input_tokens + cache_creation + cache_read。
            // 在 prompt caching 生效时，input_tokens 仅含未命中缓存的部分，
            // 需要加上缓存相关 token 才能反映真实 context 占用。
            const totalInputTokens =
              (usage.input_tokens ?? 0) +
              (usage.cache_creation_input_tokens ?? 0) +
              (usage.cache_read_input_tokens ?? 0);
            if (totalInputTokens > 0) {
              lastInputTokens = totalInputTokens;
            }
          }

          // ── Mid-query context ratio 检查 ──
          // 每条 assistant 消息（包括只有 tool_use 的）都会更新 lastInputTokens，
          // 在此检查 ratio 以便在 agent loop 中间触发轮转。
          if (lastInputTokens > 0 && ctxWindow > 0) {
            const contextRatio = lastInputTokens / ctxWindow;
            const softRatio = config.session.rotationContextRatio;
            const forceRatio = config.session.rotationForceRatio ?? 0.7;

            if (contextRatio >= forceRatio) {
              log.info(
                { userId, contextRatio: contextRatio.toFixed(3), forceRatio },
                'Mid-query force rotation triggered',
              );
              midQueryRotationTriggered = true;
              // 通知用户 hard 阈值触发（通知在轮转完成后由外层发送）。
              await q.interrupt();
              break;
            } else if (contextRatio >= softRatio && !softRotationStarted && !getBgRotation(userId)) {
              // Soft 阈值：启动后台准备。先更新持久化 session 的 contextTokens 以反映真实值。
              const currentMeta = readActiveSession(userId);
              if (currentMeta) {
                currentMeta.contextTokens = lastInputTokens;
                writeActiveSession(userId, currentMeta);
                startBackgroundPrep(userId, currentMeta);
                softRotationStarted = true;
                log.info(
                  { userId, contextRatio: contextRatio.toFixed(3), softRatio },
                  'Mid-query soft rotation prep started',
                );
                // 向用户推送 soft 阈值通知。
                if (config.session.notifyContextEvents && notifyUser) {
                  notifyUser(`⚠️ Context 已达 ${(contextRatio * 100).toFixed(1)}%（soft 阈值 ${(softRatio * 100).toFixed(0)}%），后台开始准备轮转摘要`);
                }
              }
            }
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
            // 向用户推送 auto-compact 通知。
            if (config.session.notifyContextEvents && notifyUser) {
              const preTokens = sysMsg.compact_metadata?.pre_tokens;
              const trigger = sysMsg.compact_metadata?.trigger ?? 'unknown';
              notifyUser(`🗜️ SDK auto-compact 触发（trigger: ${trigger}${preTokens ? `, pre: ${preTokens.toLocaleString()} tokens` : ''}）`);
            }
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

    // 用户主动中断优先于 mid-query 轮转。
    if (session.interrupted) {
      throw new AgentInterruptedError();
    }

    if (midQueryRotationTriggered) {
      throw new MidQueryRotationNeeded();
    }

    if (!result) {
      throw new Error('Agent query completed without result message');
    }

    // 如果检测到 rate limit 错误，抛出 RateLimitError 供上层处理。
    if (hitRateLimit) {
      throw new RateLimitError(lastResetsAt);
    }

    return result;
  }

  let currentPrompt = message;
  let currentSessionLocalId = activeSession.localId;

  const resultMessage = await agentContext.run({ userId, sendFile, notifyUser }, async () => {
    while (true) {
      try {
        try {
          return await executeQuery(currentPrompt, options);
        } catch (err) {
          if (err instanceof AgentInterruptedError || err instanceof MidQueryRotationNeeded) throw err;
          // 如果使用了 resume 且进程崩溃，清除 session ID 后重试（不 resume）。
          if (options.resume) {
            const errMsg = err instanceof Error ? err.message : String(err);
            log.warn(
              { userId, sdkSessionId: options.resume, error: errMsg, stderr: lastStderr.trim() || undefined },
              'Agent query failed with resume, retrying without resume',
            );
            lastStderr = '';

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
            return await executeQuery(currentPrompt, retryOptions);
          }
          // 非 resume 场景，附加 stderr 后抛出。
          if (lastStderr.trim()) {
            const errMsg = err instanceof Error ? err.message : String(err);
            log.error({ userId, error: errMsg, stderr: lastStderr.trim() }, 'Agent query failed');
          }
          throw err;
        }
      } catch (err) {
        if (err instanceof MidQueryRotationNeeded) {
          // ── Mid-query 轮转：保存部分对话 → 轮转 → 续接 ──
          const partialResponse = collectedBlocks
            .filter(b => b.type === 'text')
            .map(b => b.text)
            .join('\n') || '[Task interrupted for session rotation]';

          const currentActive = readActiveSession(userId);
          updateSessionAfterQuery(userId, currentSessionLocalId, currentPrompt, partialResponse, {
            contextTokens: lastInputTokens,
            contextWindowTokens: currentActive?.contextWindowTokens ?? 0,
          }, [...collectedBlocks]);

          // 执行轮转（优先使用后台准备的摘要，否则同步轮转）。
          const bg = getBgRotation(userId);
          let newSession;
          if (bg) {
            if (bg.state === 'preparing') await bg.promise;
            newSession = performInstantSwitch(userId, bg);
          } else {
            newSession = await rotateSession(userId, 'max_context');
          }

          // 更新内存状态。
          session.localSessionId = newSession.localId;
          session.sdkSessionId = null;
          currentSessionLocalId = newSession.localId;

          // 重置采集状态。
          collectedBlocks.length = 0;
          lastInputTokens = 0;
          lastStderr = '';

          // 更新 query 选项：新 system prompt、不 resume。
          options.systemPrompt = buildSystemPrompt(userId);
          delete options.resume;

          // 续接提示。
          currentPrompt = '上一个会话因 context 容量到达上限被自动轮转。请根据 system prompt 中 "Carried Over from Previous Session" 部分的上下文，继续完成之前未完成的任务。不要解释发生了什么，直接继续工作。';

          log.info(
            { userId, newLocalId: newSession.localId },
            'Mid-query rotation completed, continuing with new session',
          );
          // 向用户推送 mid-query 强制轮转通知。
          if (config.session.notifyContextEvents && notifyUser) {
            notifyUser(`🔄 Context 达到 hard 阈值，已自动轮转 → ${newSession.localId}，任务继续执行中...`);
          }
          continue;
        }
        throw err;
      }
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

  updateSessionAfterQuery(userId, currentSessionLocalId, currentPrompt, assistantResponse, {
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
