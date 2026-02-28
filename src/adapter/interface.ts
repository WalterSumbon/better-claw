import type { InboundMessage } from './types.js';

/** 发送文件选项。 */
export interface SendFileOptions {
  /** 文件类型提示。未指定时根据扩展名自动判断。 */
  type?: 'photo' | 'document' | 'voice' | 'audio' | 'video' | 'animation';
  /** 媒体说明文字。 */
  caption?: string;
}

/** 消息平台适配器接口。所有平台适配器必须实现此接口。 */
export interface MessageAdapter {
  /** 平台标识符。 */
  readonly platform: string;
  /** 命令前缀（如 "/" 或 "."）。 */
  readonly commandPrefix: string;

  /**
   * 启动适配器（开始监听消息）。
   *
   * @param handler - 收到消息时的回调。
   */
  start(handler: (msg: InboundMessage) => Promise<void>): Promise<void>;

  /** 停止适配器。 */
  stop(): Promise<void>;

  /**
   * 向指定平台用户发送文本消息。
   *
   * @param platformUserId - 平台用户 ID。
   * @param text - 要发送的文本。
   */
  sendText(platformUserId: string, text: string): Promise<void>;

  /**
   * 向指定平台用户发送文件（图片、视频、音频、文档等）。
   *
   * @param platformUserId - 平台用户 ID。
   * @param filePath - 本地文件绝对路径。
   * @param options - 发送选项（类型提示、说明文字等）。
   */
  sendFile(platformUserId: string, filePath: string, options?: SendFileOptions): Promise<void>;

  /**
   * 向指定平台用户显示 typing 状态。
   *
   * @param platformUserId - 平台用户 ID。
   */
  showTyping(platformUserId: string): Promise<void>;
}
