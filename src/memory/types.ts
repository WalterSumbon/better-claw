/**
 * 核心记忆：每次对话自动注入 system prompt。
 * 存储用户偏好、身份信息等高频引用内容。
 */
export interface CoreMemory {
  /** 用户偏好（如语言、风格等）。 */
  preferences: Record<string, string>;
  /** 用户主动分享的身份信息（如姓名、地点等）。 */
  identity: Record<string, string>;
  /** 其他由 agent 判定需要持久化的键值对。 */
  [key: string]: unknown;
}

/**
 * 扩展记忆条目：agent 按需读取的知识/笔记。
 */
export interface ExtendedMemoryEntry {
  /** 条目标识符。 */
  key: string;
  /** 记忆内容。 */
  content: string;
  /** 创建时间（ISO 8601）。 */
  createdAt: string;
  /** 最后更新时间（ISO 8601）。 */
  updatedAt: string;
}
