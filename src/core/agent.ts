import {
  type SDKMessage,
  type SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { getConfig } from '../config/index.js';
import type { AppConfig } from '../config/schema.js';
import { getLogger } from '../logger/index.js';
import type { SendFileOptions } from '../adapter/interface.js';
import { agentContext, setActiveCallbacks, clearActiveCallbacks } from './agent-context.js';
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
import { AgentProcess, type QueryOptions } from './agent-process.js';

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

/** 每个用户的 agent 状态（内存中）。 */
interface UserAgentState {
  /** 本地会话 ID。 */
  localSessionId: string | null;
  /** 当前 SDK session ID（用于 resume）。 */
  sdkSessionId: string | null;
  /** 持久化 SDK 子进程。 */
  process: AgentProcess;
  /** 是否正在处理消息（用于 busy 检查和 interrupt 判断）。 */
  processing: boolean;
  /** 当前查询是否被用户主动中断（/stop）。 */
  interrupted: boolean;
  /** SDK stderr 最后 2000 字符（用于错误诊断）。 */
  lastStderr: string;
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

/** 用户 ID → agent 状态映射。 */
const states = new Map<string, UserAgentState>();

/**
 * 获取或创建用户的 agent 状态。
 *
 * @param userId - 用户 ID。
 * @returns agent 状态对象。
 */
function getState(userId: string): UserAgentState {
  let state = states.get(userId);
  if (!state) {
    // 尝试从磁盘加载持久化的会话。
    const persisted = readActiveSession(userId);
    state = {
      localSessionId: persisted?.localId ?? null,
      sdkSessionId: persisted?.sdkSessionId ?? null,
      process: new AgentProcess(userId),
      processing: false,
      interrupted: false,
      lastStderr: '',
    };
    states.set(userId, state);
  }
  return state;
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
 * 构建传给 SDK query() 的完整选项。
 *
 * @param userId - 用户 ID。
 * @param config - 应用配置。
 * @param state - 用户 agent 状态。
 * @param resume - 是否设置 resume（传 SDK session ID，或 null 表示不 resume）。
 * @returns QueryOptions 对象。
 */
function buildQueryOptions(
  userId: string,
  config: AppConfig,
  state: UserAgentState,
  resume: string | null,
): QueryOptions {
  const systemPrompt = buildSystemPrompt(userId);
  const sdkEnv = buildSdkEnv(userId, config);
  const permissionMode = config.permissionMode as 'default' | 'acceptEdits' | 'bypassPermissions';

  const options: QueryOptions = {
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
      'better-claw': createAppMcpServer(userId),
      // 外部 MCP servers 注入 BETTER_CLAW_USER_ID 环境变量，实现多用户感知。
      // project/local 级 MCP servers（user 级由 SDK 通过 settingSources: ['user'] 自行加载）。
      ...injectUserEnvToMcpServers(getProjectLocalSettings().mcpServers, userId),
      // per-user MCP servers（<userDir>/mcp-servers.json）。
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
    ...(resume ? { resume } : {}),
  };

  // 捕获 SDK 子进程的 stderr，用于错误诊断。
  options.stderr = (data: string) => {
    state.lastStderr += data;
    // 只保留最后 2000 字符，避免内存膨胀。
    if (state.lastStderr.length > 2000) {
      state.lastStderr = state.lastStderr.slice(-2000);
    }
    const log = getLogger();
    log.debug({ userId, stderr: data.trim() }, 'SDK stderr');
  };

  return options;
}

/**
 * 确保子进程就绪。
 *
 * 处理三种情况：
 * 1. 子进程未启动或已崩溃 → 启动新进程
 * 2. 发生了 session rotation → 关闭旧进程，启动新进程（不 resume）
 * 3. 子进程已就绪但 dirty → SDK 重启（兜底时点）
 * 4. 子进程正在 SDK 重启 → 等待完成（兜底时点，不重复触发）
 *
 * @param state - 用户 agent 状态。
 * @param config - 应用配置。
 * @param rotated - 是否发生了 session rotation。
 */
async function ensureProcessReady(
  state: UserAgentState,
  config: AppConfig,
  rotated: boolean,
): Promise<void> {
  const log = getLogger();
  const proc = state.process;
  const userId = proc['userId']; // Access via closure — AgentProcess stores userId

  // 如果发生了 rotation 或子进程不存活，需要（重新）启动。
  if (rotated || !proc.isAlive) {
    if (proc.isAlive) {
      log.info({ userId }, 'Closing process due to session rotation');
      proc.close();
    }
    // Rotation 后不 resume；崩溃恢复尝试 resume。
    const resume = rotated ? null : state.sdkSessionId;
    const options = buildQueryOptions(userId, config, state, resume);
    proc.start(options);
    return;
  }

  // 兜底时点：检查 dirty / restarting 状态。
  if (proc.sdkRestartState === 'restarting') {
    log.info({ userId }, 'Process SDK restarting, waiting at fallback checkpoint');
    await proc.waitForSdkRestart();
    return;
  }

  if (proc.sdkRestartState === 'dirty') {
    log.info({ userId }, 'Process dirty at fallback checkpoint, SDK restarting');
    const options = buildQueryOptions(userId, config, state, state.sdkSessionId);
    await proc.sdkRestart(options);
    return;
  }
}

/**
 * 向 agent 发送消息并流式接收响应。
 *
 * 使用持久化子进程（streaming input mode）处理消息。
 * 子进程在多次消息间保持活跃，避免每条消息都冷启动。
 *
 * 会话管理逻辑：
 * 1. 发送前检查是否需要轮转（时间间隔 / 轮次阈值）。
 * 2. 如需轮转，归档旧会话并创建新会话，重启子进程。
 * 3. 发送后更新会话元数据和对话记录。
 * 4. 消息处理完毕后，如果子进程 dirty，后台触发重启（主时机）。
 *
 * @param userId - 用户 ID。
 * @param message - 用户消息文本。
 * @param onMessage - 每条 SDK 消息的回调。
 * @param sendFile - 可选的文件发送回调，供 MCP 工具使用。
 * @param notifyUser - 可选的通知回调。
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
  const state = getState(userId);
  state.localSessionId = activeSession.localId;
  state.sdkSessionId = activeSession.sdkSessionId;

  // 如果发生了轮转，清除内存中的 SDK session ID（新会话不 resume）。
  if (rotated) {
    state.sdkSessionId = null;
  }

  // 重置中断标志和 stderr。
  state.interrupted = false;
  state.lastStderr = '';

  log.info({ userId, messageLength: message.length }, 'Sending message to agent');

  // ── 确保子进程就绪 ──
  await ensureProcessReady(state, config, rotated);

  const proc = state.process;

  // 在 agentContext 中运行，使 MCP 工具能获取 userId 和 sendFile。
  // 同时跟踪最新的 input_tokens（反映当前 context 大小）。
  let lastInputTokens = 0;

  /** 采集到的完整交互块。 */
  const collectedBlocks: ConversationBlock[] = [];

  /**
   * 执行一次 turn：推送消息到子进程，流式读取响应直到 result。
   *
   * 子进程保持活跃——只是当前 turn 结束，不关闭子进程。
   *
   * @param prompt - 用户消息文本。
   * @returns 最终结果消息。
   */
  async function executeTurn(prompt: string): Promise<SDKResultMessage> {
    state.processing = true;

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
      // 推送用户消息到子进程。
      proc.pushMessage(prompt);

      // 逐条读取 SDK 响应（手动 .next()，不用 for-await，避免 break 关闭 generator）。
      while (true) {
        const msg = await proc.nextMessage();
        if (!msg) {
          // 子进程退出（crash 或正常结束）。
          break;
        }

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
          state.sdkSessionId = msg.session_id;
          proc.sdkSessionId = msg.session_id;
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
              await proc.interrupt();
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
                localSessionId: state.localSessionId,
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
            log.info({ userId, localSessionId: state.localSessionId }, 'SDK auto-compact in progress');
          }
        }

        onMessage(msg);

        if (isResultMessage(msg)) {
          result = msg;
          break; // Turn 结束，子进程保持活跃。
        }
      }
    } finally {
      state.processing = false;
    }

    // 用户主动中断优先于 mid-query 轮转。
    if (state.interrupted) {
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

  // 将 sendFile/notifyUser 回调注册到 per-user fallback map，
  // 以防 SDK 分发 MCP tool call 时 AsyncLocalStorage 上下文断裂。
  setActiveCallbacks(userId, sendFile, notifyUser);

  let resultMessage: SDKResultMessage;
  try {
  resultMessage = await agentContext.run({ userId, sendFile, notifyUser }, async () => {
    while (true) {
      try {
        try {
          return await executeTurn(currentPrompt);
        } catch (err) {
          if (err instanceof AgentInterruptedError || err instanceof MidQueryRotationNeeded) throw err;
          // 子进程崩溃：清除 session ID 后重启并重试。
          if (!proc.isAlive) {
            const errMsg = err instanceof Error ? err.message : String(err);
            log.warn(
              { userId, sdkSessionId: state.sdkSessionId, error: errMsg, stderr: state.lastStderr.trim() || undefined },
              'Agent process crashed, restarting without resume',
            );
            state.lastStderr = '';

            // 清除内存和持久化的 SDK session ID。
            state.sdkSessionId = null;
            proc.sdkSessionId = null;
            const currentActive = readActiveSession(userId);
            if (currentActive) {
              currentActive.sdkSessionId = null;
              currentActive.updatedAt = new Date().toISOString();
              writeActiveSession(userId, currentActive);
            }

            // 重新启动子进程（不 resume）。
            const retryOptions = buildQueryOptions(userId, config, state, null);
            proc.start(retryOptions);
            return await executeTurn(currentPrompt);
          }
          // 子进程仍然存活但 turn 失败（SDK 错误等），附加 stderr 后抛出。
          if (state.lastStderr.trim()) {
            const errMsg = err instanceof Error ? err.message : String(err);
            log.error({ userId, error: errMsg, stderr: state.lastStderr.trim() }, 'Agent turn failed');
          }
          throw err;
        }
      } catch (err) {
        if (err instanceof MidQueryRotationNeeded) {
          // ── Mid-query 轮转：保存部分对话 → 轮转 → 重启子进程 → 续接 ──
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
          state.localSessionId = newSession.localId;
          state.sdkSessionId = null;
          currentSessionLocalId = newSession.localId;

          // 重置采集状态。
          collectedBlocks.length = 0;
          lastInputTokens = 0;
          state.lastStderr = '';

          // 重启子进程（新 system prompt，不 resume）。
          const newOptions = buildQueryOptions(userId, config, state, null);
          proc.close();
          proc.start(newOptions);

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
  } finally {
    clearActiveCallbacks(userId);
  }

  // ── 0-cost zombie 检测 ──
  // 子进程返回 costUsd=0, turns=0, durationMs=0 的 result 说明它根本没成功处理消息
  // （可能是 resume 了一个不存在的 session ID 导致初始化失败），子进程即将退出。
  // 主动关闭，让下次消息触发全新启动，而不是等到 pushMessage 时才发现 transport 已死。
  if (
    resultMessage.total_cost_usd === 0
    && resultMessage.num_turns === 0
    && resultMessage.duration_ms === 0
    && proc.isAlive
  ) {
    log.warn({ userId }, 'Zero-cost result detected, proactively closing zombie subprocess');
    proc.close();
    // 清除 SDK session ID，下次启动不 resume（避免再次触发同样的问题）。
    state.sdkSessionId = null;
    proc.sdkSessionId = null;
    const currentActive = readActiveSession(userId);
    if (currentActive) {
      currentActive.sdkSessionId = null;
      currentActive.updatedAt = new Date().toISOString();
      writeActiveSession(userId, currentActive);
    }
  }

  // ── 主时机：消息处理完毕后，如果子进程 dirty，后台 SDK 重启（隐藏延迟）──
  if (proc.sdkRestartState === 'dirty') {
    log.info({ userId }, 'Post-message SDK restart triggered (primary checkpoint)');
    const restartOptions = buildQueryOptions(userId, config, state, state.sdkSessionId);
    proc.sdkRestart(restartOptions).catch(err => {
      log.error({ userId, err }, 'Background SDK restart failed');
    });
  }

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
      localSessionId: state.localSessionId,
      sdkSessionId: state.sdkSessionId,
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
 * 只中断当前 turn，子进程保持活跃。
 *
 * @param userId - 用户 ID。
 */
export async function interruptAgent(userId: string): Promise<void> {
  const state = getState(userId);
  if (state.processing && state.process.isAlive) {
    const log = getLogger();
    log.info({ userId }, 'Interrupting agent');
    state.interrupted = true;
    await state.process.interrupt();
  }
}

/**
 * 检查指定用户是否有活跃的 agent 查询。
 *
 * @param userId - 用户 ID。
 * @returns 是否正在执行。
 */
export function isAgentBusy(userId: string): boolean {
  const state = states.get(userId);
  return state?.processing ?? false;
}

/**
 * 手动重置用户的 agent 会话（供 /new 命令和 MCP 工具调用）。
 * 关闭子进程并清除内存中的 session 状态，使下一次查询时创建新会话。
 *
 * @param userId - 用户 ID。
 */
export function resetAgentSession(userId: string): void {
  const state = states.get(userId);
  if (state) {
    state.process.close();
    state.localSessionId = null;
    state.sdkSessionId = null;
  }
}

/**
 * 获取指定用户的 AgentProcess 实例（供 config watch 等外部模块使用）。
 *
 * @param userId - 用户 ID。
 * @returns AgentProcess 实例，如果用户无状态则返回 undefined。
 */
export function getAgentProcess(userId: string): AgentProcess | undefined {
  return states.get(userId)?.process;
}

/**
 * 获取所有活跃用户的 AgentProcess 实例。
 * 用于批量操作，如全局 skill 变更时标记所有进程 dirty。
 *
 * @returns [userId, AgentProcess] 数组。
 */
export function getAllAgentProcesses(): [string, AgentProcess][] {
  return Array.from(states.entries()).map(([userId, state]) => [userId, state.process]);
}
