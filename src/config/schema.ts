import { z } from 'zod';

/** Anthropic API 配置。 */
const AnthropicConfigSchema = z.object({
  /** Anthropic API key（可选，agent-sdk 可复用 CLI 认证）。 */
  apiKey: z.string().optional(),
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

/** 上下文管理配置。 */
const ContextConfigSchema = z.object({
  /** 触发应用层压缩的 token 阈值。 */
  compressionThresholdTokens: z.number().default(80000),
  /** 是否启用 Claude API Compaction beta。 */
  enableCompaction: z.boolean().default(true),
});

/** 日志配置。 */
const LoggingConfigSchema = z.object({
  /** 日志级别。 */
  level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  /** 日志文件目录（相对于项目根目录）。 */
  directory: z.string().default('data/logs'),
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
  /** 是否推送工具调用状态。 */
  pushToolCalls: z.boolean().default(false),
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
  /** 上下文管理配置。 */
  context: ContextConfigSchema.default(() => ({
    compressionThresholdTokens: 80000,
    enableCompaction: true,
  })),
  /** 日志配置。 */
  logging: LoggingConfigSchema.default(() => ({
    level: 'info' as const,
    directory: 'data/logs',
    maxSize: '10m',
    maxFiles: 10,
    replyLogMaxLength: 200,
  })),
  /** 消息推送粒度配置。 */
  messagePush: MessagePushConfigSchema.default(() => ({
    pushIntermediateMessages: true,
    pushToolCalls: false,
  })),
  /** 数据目录路径。 */
  dataDir: z.string().default('data'),
  /** Agent 权限模式。 */
  permissionMode: z
    .enum(['default', 'acceptEdits', 'bypassPermissions'])
    .default('bypassPermissions'),
  /** Agent 文件操作的工作目录（可选）。 */
  agentCwd: z.string().optional(),
  /** 语音转文字配置（可选，不配置则语音消息仅保存文件）。 */
  speechToText: SpeechToTextConfigSchema.optional(),
  /** 外部 MCP 扩展（浏览器控制、屏幕控制等）。 */
  mcpExtensions: z.object({
    /** Playwright MCP：浏览器自动化控制。 */
    playwright: z.object({
      enabled: z.boolean().default(false),
    }).default({ enabled: false }),
    /** Peekaboo MCP：macOS 屏幕截图与 GUI 自动化。 */
    peekaboo: z.object({
      enabled: z.boolean().default(false),
    }).default({ enabled: false }),
  }).default({
    playwright: { enabled: false },
    peekaboo: { enabled: false },
  }),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;
