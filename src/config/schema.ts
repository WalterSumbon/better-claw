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

/** 消息推送粒度配置。 */
const MessagePushConfigSchema = z.object({
  /** 是否推送 assistant 中间文本消息。 */
  pushIntermediateMessages: z.boolean().default(true),
});

/** 会话管理配置。 */
const SessionConfigSchema = z.object({
  /** 时间间隔轮转阈值（小时），超过此间隔自动开新会话。 */
  rotationTimeoutHours: z.number().default(4),
  /** Context 占比软轮转阈值（0-1），达到此值时在后台启动 summary 生成和会话浓缩，
   *  但不阻塞当前消息处理。 */
  rotationContextRatio: z.number().min(0).max(1).default(0.8),
  /** Context 占比强制轮转兜底阈值（0-1），超过此值时同步等待后台完成或直接同步轮转，
   *  期间暂停队列消费。必须大于 rotationContextRatio。 */
  rotationForceRatio: z.number().min(0).max(1).default(0.9),
  /** 轮转时是否生成 AI 摘要。 */
  summaryEnabled: z.boolean().default(true),
  /** 摘要生成使用的模型（推荐使用较便宜的模型）。 */
  summaryModel: z.string().default('claude-haiku-4-20250414'),
  /** system prompt 中展示的最近 session 数量（短期记忆），更早的 session 会被
   *  浓缩到累积摘要中（长期记忆）。 */
  maxRecentSessions: z.number().min(1).default(3),
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

/** 应用全局配置 schema。 */
export const AppConfigSchema = z.object({
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
  })),
  /** 数据目录路径。 */
  dataDir: z.string().default('data'),
  /** Agent 权限模式。 */
  permissionMode: z
    .enum(['default', 'acceptEdits', 'bypassPermissions'])
    .default('bypassPermissions'),
  /** 会话管理配置。 */
  session: SessionConfigSchema.default(() => ({
    rotationTimeoutHours: 4,
    rotationContextRatio: 0.8,
    rotationForceRatio: 0.9,
    summaryEnabled: true,
    summaryModel: 'claude-haiku-4-20250414',
    maxRecentSessions: 3,
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
});

export type AppConfig = z.infer<typeof AppConfigSchema>;
