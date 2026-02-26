import type { PlatformType } from '../user/types.js';

/** 附件信息（图片、语音、文件等）。 */
export interface Attachment {
  /** 附件类型。 */
  type: 'photo' | 'voice' | 'document' | 'video' | 'video_note' | 'audio' | 'sticker' | 'animation' | 'location' | 'contact';
  /** 本地文件路径。 */
  localPath: string;
  /** 原始文件名（如有）。 */
  fileName?: string;
  /** MIME 类型（如有）。 */
  mimeType?: string;
}

/** 入站消息：从平台接收到的用户消息。 */
export interface InboundMessage {
  /** 平台名称。 */
  platform: PlatformType;
  /** 平台上的用户 ID。 */
  platformUserId: string;
  /** 提取后的文本内容。 */
  text: string;
  /** 原始平台消息对象。 */
  raw: unknown;
  /** 是否为命令（如 /bind, /stop）。 */
  isCommand: boolean;
  /** 命令名称（isCommand 为 true 时有值）。 */
  commandName?: string;
  /** 命令参数（isCommand 为 true 时有值）。 */
  commandArgs?: string;
  /** 附件列表（图片、语音、文件等）。 */
  attachments?: Attachment[];
  /** 确认消息已处理（ack）。用于 Telegram long polling 场景，确保 update 不会被重新投递。 */
  ack?: () => Promise<void>;
}
