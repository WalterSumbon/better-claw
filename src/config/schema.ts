import { z } from 'zod';

/** Anthropic API 配置。 */
const AnthropicConfigSchema = z.object({
  /** Anthropic API key（可选，agent-sdk 可复用 CLI 认证）。 */
  apiKey: z.string().optional(),
  /** Anthropic Auth Token（用于代理服务器认证，对应 ANTHROPIC_AUTH_TOKEN）。 */
  authToken: z.string().optional(),
  /** Anthropic Base URL（用于代理服务器，对应 ANTHROPIC_BASE_URL）。 */
  baseUrl: z.string().optional(),
  /** 默认模型 ID。 */
  model: z.string().default('claude-opus-4-6'),
  /** 单次查询最大预算（美元）。 */
  maxBudgetUsd: z.number().optional(),
});

/** Telegram 机器人配置。 */
const TelegramConfigSchema = z.object({
  /** Bot token（从 @BotFather 获取）。 */
  botToken: z.string(),
  /** HTTP 代理地址（如 http://127.0.0.1:7890）。 */
  proxy: z.string().optional(),
  /** 命令前缀（默认 "/"）。 */
  commandPrefix: z.string().default('/'),
});

/** 日志配置。 */
const LoggingConfigSchema = z.object({
  /** 日志级别。 */
  level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  /** 日志文件目录（相对路径基于 dataDir 解析）。 */
  directory: z.string().default('logs'),
  /** 单个日志文件最大体积（pino-roll 格式：数字 + k/m/g，如 10m）。 */
  maxSize: z.string().default('10m'),
  /** 保留的轮转文件数量。 */
  maxFiles: z.number().default(10),
  /** Bot 回复日志的最大显示长度，超过则显示摘要。 */
  replyLogMaxLength: z.number().default(200),
});

/** 消息交互模式。 */
const InteractionModeSchema = z.enum(['queue', 'interrupt']).default('queue');

/** 消息推送粒度配置。 */
const MessagePushConfigSchema = z.object({
  /** 是否推送 assistant 中间文本消息。 */
  pushIntermediateMessages: z.boolean().default(true),
  /**
   * 消息交互模式。
   *
   * - "queue"：排队模式（默认），必须等前一条消息处理完再处理下一条。
   * - "interrupt"：中断模式，新消息到达时立即中断当前 agent 处理，
   *   将所有积压消息合并后一起发给 agent。
   */
  interactionMode: InteractionModeSchema,
});

/** 会话管理配置。 */
const SessionConfigSchema = z.object({
  /** 时间间隔轮转阈值（小时），超过此间隔自动开新会话。 */
  rotationTimeoutHours: z.number().default(4),
  /** Context 占比软轮转阈值（0-1），达到此值时在后台启动 summary 生成和会话浓缩，
   *  但不阻塞当前消息处理。 */
  rotationContextRatio: z.number().min(0).max(1).default(0.5),
  /** Context 占比强制轮转兜底阈值（0-1），超过此值时同步等待后台完成或直接同步轮转，
   *  期间暂停队列消费。必须大于 rotationContextRatio。 */
  rotationForceRatio: z.number().min(0).max(1).default(0.7),
  /** 轮转时是否生成 AI 摘要。 */
  summaryEnabled: z.boolean().default(true),
  /** 摘要生成使用的模型（推荐使用较便宜的模型）。 */
  summaryModel: z.string().default('claude-haiku-4-5-20251001'),
  /** 摘要生成时每个分块的最大字符数。对话总长度超过此值时自动分块，
   *  每块独立生成中间摘要，最后合并为最终摘要。默认 80000（约 20k tokens）。 */
  summaryChunkMaxChars: z.number().min(1000).default(80_000),
  /** system prompt 中展示的最近 session 数量（短期记忆），更早的 session 会被
   *  浓缩到累积摘要中（长期记忆）。 */
  maxRecentSessions: z.number().min(1).default(3),
  /** 轮转时从旧 session 携带到新 session 的最近对话轮次数。
   *  每轮 = 1 条用户消息 + 该轮最后 1 条 agent 回复（中间回复丢弃）。
   *  这些对话会以规则化 digest 方式注入 system prompt，
   *  确保模型知道轮转前刚刚发生了什么。0 表示不携带。 */
  carryoverTurns: z.number().min(0).default(5),
  /** Carryover 中用户消息的最大字符数。超过则截断并注明总长度。 */
  carryoverUserMaxChars: z.number().min(0).default(500),
  /** Carryover 中 agent 回复保留的开头字符数。 */
  carryoverAssistantHeadChars: z.number().min(0).default(200),
  /** Carryover 中 agent 回复保留的结尾字符数。
   *  若回复总长度 ≤ headChars + tailChars，则保留全文不做 digest。 */
  carryoverAssistantTailChars: z.number().min(0).default(200),
});

/** 重启权限配置。 */
const RestartConfigSchema = z.object({
  /** 是否允许 agent（通过 MCP 工具）触发重启。 */
  allowAgent: z.boolean().default(true),
  /** 是否允许用户（通过 /restart 命令）触发重启。 */
  allowUser: z.boolean().default(true),
  /** 允许触发重启的用户 ID 白名单。为空数组时表示不限制（所有用户均可）。
   *  仅在 allowUser 为 true 时生效。 */
  userWhitelist: z.array(z.string()).default([]),
});

/** 钉钉机器人配置。 */
const DingtalkConfigSchema = z.object({
  /** 应用的 AppKey（ClientID），从钉钉开放平台获取。 */
  clientId: z.string(),
  /** 应用的 AppSecret（ClientSecret），从钉钉开放平台获取。 */
  clientSecret: z.string(),
  /** 应用的 robotCode，用于主动发消息 API。不填时默认使用 clientId。 */
  robotCode: z.string().optional(),
  /** 新版 OpenAPI 基础地址。标准钉钉为 https://api.dingtalk.com，蚂蚁钉等定制版需替换。 */
  apiBase: z.string().default('https://api.dingtalk.com'),
  /** 旧版 OAPI 基础地址（用于获取 access token）。标准钉钉为 https://oapi.dingtalk.com。 */
  oapiBase: z.string().default('https://oapi.dingtalk.com'),
  /** 命令前缀（默认 "."，因为钉钉会拦截 "/" 开头的消息）。 */
  commandPrefix: z.string().default('.'),
});

/**
 * 文件系统访问规则 schema。直接映射 SDK sandbox filesystem 设置。
 *
 * SDK sandbox 支持三个文件系统数组：
 *   - allowWrite（写入白名单）：指定后写入默认拒绝，仅列出的路径可写。
 *   - denyWrite（写入黑名单）：进一步限制写入，优先级高于 allowWrite。
 *   - denyRead（读取黑名单）：拒绝读取，无对应的 allowRead 机制。
 *
 * 支持的路径变量：
 *   ${userDir} / ${userWorkspace} / ${dataDir} / ${home} / ${configFile} / ${otherUserDir}
 */
const FilesystemConfigSchema = z.object({
  /** 写入白名单。指定后进入白名单模式：仅列出的路径可写。 */
  allowWrite: z.array(z.string()).optional(),
  /** 写入黑名单。优先级高于 allowWrite。 */
  denyWrite: z.array(z.string()).optional(),
  /** 读取黑名单。SDK 无 allowRead 机制，被 deny 的父路径下子路径无法豁免。 */
  denyRead: z.array(z.string()).optional(),
});

/** 权限组配置 schema。 */
const PermissionGroupConfigSchema = z.object({
  /** 继承的父权限组名称（默认 "admin"，即无任何限制）。 */
  inherits: z.string().optional(),
  /** 文件系统访问规则，直接映射 SDK sandbox filesystem 设置。 */
  filesystem: FilesystemConfigSchema.optional(),
});

/** 工作组配置 schema。 */
const WorkGroupConfigSchema = z.object({
  /** 成员映射：userId → 权限级别（'r' 只读 / 'rw' 读写）。 */
  members: z.record(z.string(), z.enum(['r', 'rw'])),
});

/** 权限系统配置 schema。 */
const PermissionsConfigSchema = z.object({
  /** 权限组定义（键为组名，值为组配置）。 */
  groups: z.record(z.string(), PermissionGroupConfigSchema).default(() => ({
    admin: {},
    user: {
      filesystem: {
        allowWrite: ['${userDir}/memory', '${userWorkspace}'],
        denyRead: ['${otherUserDir}'],
      },
    },
  })),
  /** 工作组定义（可选）。 */
  workGroups: z.record(z.string(), WorkGroupConfigSchema).optional(),
  /** 用户默认权限组（未在 profile 中指定时使用）。 */
  defaultGroup: z.string().default('user'),
  /** 非 admin 用户传递给 SDK subprocess 时需过滤掉的环境变量名模式列表。
   *  支持 * 通配符（如 "SECRET_*" 匹配所有以 SECRET_ 开头的变量）。
   *  默认继承所有环境变量，仅移除匹配的条目。
   *  SDK 必需的 Anthropic 变量始终从 anthropic 配置注入，不受此过滤影响。 */
  envFilter: z.array(z.string()).default(() => []),
  /** 非 admin 用户额外注入的环境变量（键值对）。
   *  会在过滤之后追加，可用于覆盖或补充变量。 */
  envExtra: z.record(z.string(), z.string()).default(() => ({})),
  /** 非 admin 用户自动追加的 deny readwrite 路径列表。
   *  支持变量：${configFile}（配置文件路径）、${home}（用户主目录）及其他标准变量。
   *  这些规则追加在规则链最末尾，不可被权限组或工作组规则覆盖。 */
  protectedPaths: z.array(z.string()).default(() => []),
});

/** Skill 系统配置。 */
const SkillsConfigSchema = z.object({
  /** Skill / Skillset 搜索路径列表。
   *  支持 ~ 展开为用户主目录。
   *  支持 ${userDir} 变量，表示当前用户的数据目录（多用户模式下各用户独立）。
   *  从前到后扫描，同名节点以先发现的为准。 */
  paths: z.array(z.string()).default(() => [
    '~/.claude/skills',
    './skills',
    '${userDir}/skills',
  ]),
});

/** 语音转文字配置。 */
const SpeechToTextConfigSchema = z.object({
  /** whisper 可执行文件路径。 */
  whisperPath: z.string().default('whisper'),
  /** whisper 模型名称（如 tiny, base, small, medium, large）。 */
  model: z.string().default('base'),
  /** 识别语言（如 zh, en, ja），留空则自动检测。 */
  language: z.string().optional(),
});

/** 消息信封配置。 */
const MessageEnvelopeConfigSchema = z.object({
  /** 是否在用户消息前附加平台和时间信息。默认开启。 */
  enabled: z.boolean().default(true),
});

/** AgentBox 适配器配置。 */
const AgentBoxConfigSchema = z.object({
  /** AgentBox 服务器 WebSocket 地址（如 ws://localhost:3001）。 */
  serverUrl: z.string().default('ws://localhost:3001'),
  /** 注册为 agent 时使用的 ID。 */
  agentId: z.string().default('better-claw'),
  /** 注册为 agent 时的显示名称。 */
  agentName: z.string().default('Better-Claw'),
  /** 命令前缀（默认 "/"）。 */
  commandPrefix: z.string().default('/'),
  /** 断线重连间隔（毫秒）。 */
  reconnectInterval: z.number().default(5000),
  /** 发送 done 信号前的空闲等待时间（毫秒）。
   *  在此期间如果有 showTyping 或 sendText 调用，计时器会重置。 */
  doneTimeout: z.number().default(10_000),
});

/** Webhook 配置。 */
const WebhookConfigSchema = z.object({
  /** 监听端口。 */
  port: z.number().default(3000),
  /** API 密钥（用于验证请求，留空则不验证）。 */
  apiKey: z.string().optional(),
});

/** 传递给 SDK subprocess 的额外环境变量（全局，对所有用户生效）。 */
const SdkEnvConfigSchema = z.record(z.string(), z.string()).default(() => ({}));

/** 应用全局配置 schema。 */
export const AppConfigSchema = z.object({
  /** 自定义 system prompt 注入内容。
   *  字符串或字符串数组，每个条目作为独立段落注入 system prompt 末尾（在 session history 之前）。
   *  用于添加全局行为指令、角色补充说明、业务规则等。 */
  systemPrompt: z.union([
    z.string(),
    z.array(z.string()),
  ]).optional(),
  /** Anthropic API 配置。 */
  anthropic: AnthropicConfigSchema.default(() => ({
    model: 'claude-opus-4-6',
  })),
  /** Telegram 配置（可选，不配置则不启动 Telegram 适配器）。 */
  telegram: TelegramConfigSchema.optional(),
  /** 日志配置。 */
  logging: LoggingConfigSchema.default(() => ({
    level: 'info' as const,
    directory: 'logs',
    maxSize: '10m',
    maxFiles: 10,
    replyLogMaxLength: 200,
  })),
  /** 消息推送粒度配置。 */
  messagePush: MessagePushConfigSchema.default(() => ({
    pushIntermediateMessages: true,
    interactionMode: 'queue' as const,
  })),
  /** 数据目录路径。 */
  dataDir: z.string().default('data'),
  /** Agent 权限模式。 */
  permissionMode: z
    .enum(['default', 'acceptEdits', 'bypassPermissions'])
    .default('default'),
  /** 文件系统权限隔离配置。 */
  permissions: PermissionsConfigSchema.default(() => ({
    groups: {
      admin: {},
      user: {
        filesystem: {
          allowWrite: ['${userDir}/memory', '${userWorkspace}'],
          denyRead: ['${otherUserDir}'],
        },
      },
    },
    defaultGroup: 'user',
    envFilter: [] as string[],
    envExtra: {} as Record<string, string>,
    protectedPaths: [] as string[],
  })),
  /** 会话管理配置。 */
  session: SessionConfigSchema.default(() => ({
    rotationTimeoutHours: 4,
    rotationContextRatio: 0.5,
    rotationForceRatio: 0.7,
    summaryEnabled: true,
    summaryModel: 'claude-haiku-4-5-20251001',
    summaryChunkMaxChars: 80_000,
    maxRecentSessions: 3,
    carryoverTurns: 5,
    carryoverUserMaxChars: 500,
    carryoverAssistantHeadChars: 200,
    carryoverAssistantTailChars: 200,
  })),
  /** 重启权限配置。 */
  restart: RestartConfigSchema.default(() => ({
    allowAgent: true,
    allowUser: true,
    userWhitelist: [] as string[],
  })),
  /** 语音转文字配置（可选，不配置则语音消息仅保存文件，由 agent 自行决定如何处理）。 */
  speechToText: SpeechToTextConfigSchema.optional(),
  /** 钉钉配置（可选，不配置则不启动钉钉适配器）。 */
  dingtalk: DingtalkConfigSchema.optional(),
  /** Skill 系统配置。 */
  skills: SkillsConfigSchema.default(() => ({
    paths: ['~/.claude/skills', './skills', '${userDir}/skills'],
  })),
  /** 消息信封配置（在用户消息前附加平台和时间戳信息）。 */
  messageEnvelope: MessageEnvelopeConfigSchema.default(() => ({
    enabled: true,
  })),
  /** Webhook 配置（可选，不配置则不启动 Webhook 服务器）。 */
  webhook: WebhookConfigSchema.optional(),
  /** AgentBox 配置（可选，不配置则不启动 AgentBox 适配器）。 */
  agentbox: AgentBoxConfigSchema.optional(),
  /** 传递给 SDK subprocess 的额外环境变量（键值对）。
   *  对所有用户（包括 admin）全局生效，在 process.env 之后追加。
   *  适合设置 SDK 行为参数，如 CLAUDE_AUTOCOMPACT_PCT_OVERRIDE。 */
  sdkEnv: SdkEnvConfigSchema,
});

export type AppConfig = z.infer<typeof AppConfigSchema>;
