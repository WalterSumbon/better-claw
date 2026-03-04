import { writeFileSync } from 'fs';
import { basename, extname, join, resolve } from 'path';
import { DWClient, TOPIC_ROBOT, EventAck } from 'dingtalk-stream-sdk-nodejs';
import type { DWClientDownStream } from 'dingtalk-stream-sdk-nodejs';
import type { MessageAdapter, SendFileOptions } from '../interface.js';
import type { InboundMessage, Attachment } from '../types.js';
import { getLogger } from '../../logger/index.js';
import { getConfig } from '../../config/index.js';
import { ensureDir } from '../../utils/file.js';
import { transcribeAudio } from '../../utils/transcribe.js';

/** Access token 缓存有效期（毫秒），钉钉 token 有效期 7200 秒，提前 5 分钟刷新。 */
const TOKEN_TTL_MS = (7200 - 300) * 1000;

// ---------------------------------------------------------------------------
// 钉钉机器人消息类型定义（SDK 仅提供 text 类型，此处补充完整）
// ---------------------------------------------------------------------------

/** 钉钉机器人消息基础字段。 */
interface DingtalkRobotMessageBase {
  conversationId: string;
  chatbotCorpId: string;
  chatbotUserId: string;
  msgId: string;
  senderNick: string;
  isAdmin: boolean;
  senderStaffId: string;
  sessionWebhookExpiredTime: number;
  createAt: number;
  senderCorpId: string;
  conversationType: string;
  senderId: string;
  sessionWebhook: string;
  robotCode: string;
  msgtype: string;
}

/** 钉钉文本消息。 */
interface DingtalkTextMessage extends DingtalkRobotMessageBase {
  msgtype: 'text';
  text: { content: string };
}

/** 钉钉图片消息。 */
interface DingtalkPictureMessage extends DingtalkRobotMessageBase {
  msgtype: 'picture';
  content: { downloadCode: string; pictureDownloadCode?: string };
}

/** 钉钉语音消息。 */
interface DingtalkAudioMessage extends DingtalkRobotMessageBase {
  msgtype: 'audio';
  content: { downloadCode: string; recognition?: string };
}

/** 钉钉视频消息。 */
interface DingtalkVideoMessage extends DingtalkRobotMessageBase {
  msgtype: 'video';
  content: { downloadCode: string; duration?: string; videoType?: string };
}

/** 钉钉文件消息。 */
interface DingtalkFileMessage extends DingtalkRobotMessageBase {
  msgtype: 'file';
  content: { downloadCode: string; fileName?: string; fileId?: string; spaceId?: string };
}

/** 钉钉富文本消息元素。 */
interface DingtalkRichTextElement {
  text?: string;
  type?: string;
  downloadCode?: string;
  pictureDownloadCode?: string;
}

/** 钉钉富文本消息。 */
interface DingtalkRichTextMessage extends DingtalkRobotMessageBase {
  msgtype: 'richText';
  content: { richText: DingtalkRichTextElement[] };
}

/** 钉钉不支持的消息类型。 */
interface DingtalkUnknownMessage extends DingtalkRobotMessageBase {
  msgtype: 'unknownMsgType';
  content: { unknownMsgType?: string };
}

/** 所有钉钉机器人消息类型的联合。 */
type DingtalkRobotMessage =
  | DingtalkTextMessage
  | DingtalkPictureMessage
  | DingtalkAudioMessage
  | DingtalkVideoMessage
  | DingtalkFileMessage
  | DingtalkRichTextMessage
  | DingtalkUnknownMessage;

/** sessionWebhook 缓存条目。 */
interface WebhookCacheEntry {
  url: string;
  expiredTime: number;
}

/** 钉钉适配器构造参数。 */
interface DingtalkAdapterOptions {
  clientId: string;
  clientSecret: string;
  robotCode?: string;
  /** 新版 OpenAPI 基础地址，如 https://api.dingtalk.com。 */
  apiBase?: string;
  /** 旧版 OAPI 基础地址，如 https://oapi.dingtalk.com。 */
  oapiBase?: string;
  /** 命令前缀（默认 "."，因为钉钉会拦截 "/" 开头的消息）。 */
  commandPrefix?: string;
}

/**
 * 钉钉适配器：通过 Stream 模式接收消息，通过 OpenAPI 发送消息。
 *
 * 支持标准钉钉和蚂蚁钉等企业定制版（通过 apiBase / oapiBase 配置）。
 */
export class DingtalkAdapter implements MessageAdapter {
  readonly platform = 'dingtalk' as const;
  private client: DWClient;
  private clientId: string;
  private clientSecret: string;
  private robotCode: string;
  private apiBase: string;
  private oapiBase: string;
  readonly commandPrefix: string;

  /** access token 缓存。 */
  private accessToken = '';
  private tokenExpiresAt = 0;

  /** senderStaffId -> sessionWebhook 缓存，用于快速回复。 */
  private webhookCache = new Map<string, WebhookCacheEntry>();

  private constructor(client: DWClient, options: DingtalkAdapterOptions) {
    this.client = client;
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.robotCode = options.robotCode ?? options.clientId;
    this.apiBase = (options.apiBase ?? 'https://api.dingtalk.com').replace(/\/+$/, '');
    this.oapiBase = (options.oapiBase ?? 'https://oapi.dingtalk.com').replace(/\/+$/, '');
    this.commandPrefix = options.commandPrefix ?? '.';
  }

  /**
   * 创建 DingtalkAdapter 实例。
   *
   * @param options - 钉钉应用配置。
   */
  static async create(options: DingtalkAdapterOptions): Promise<DingtalkAdapter> {
    const client = new DWClient({
      clientId: options.clientId,
      clientSecret: options.clientSecret,
    });
    client.debug = false;
    return new DingtalkAdapter(client, options);
  }

  /**
   * 获取 access token，自动缓存和刷新。
   *
   * @returns 有效的 access token。
   */
  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt) {
      return this.accessToken;
    }

    const log = getLogger();
    const url = `${this.oapiBase}/gettoken?appkey=${encodeURIComponent(this.clientId)}&appsecret=${encodeURIComponent(this.clientSecret)}`;
    const res = await fetch(url);
    const data = await res.json() as { errcode: number; errmsg: string; access_token?: string };

    if (data.errcode !== 0 || !data.access_token) {
      log.error({ errcode: data.errcode, errmsg: data.errmsg }, 'Failed to get DingTalk access token');
      throw new Error(`DingTalk gettoken failed: ${data.errmsg}`);
    }

    this.accessToken = data.access_token;
    this.tokenExpiresAt = Date.now() + TOKEN_TTL_MS;
    log.debug('DingTalk access token refreshed');
    return this.accessToken;
  }

  /**
   * 获取 Stream WebSocket 连接端点。
   *
   * 绕过 SDK 内置的 getEndpoint()，使用可配置的 apiBase 地址，
   * 以支持蚂蚁钉等企业定制版钉钉。
   *
   * @returns WebSocket URL（含 ticket）。
   */
  private async getStreamEndpoint(): Promise<string> {
    const log = getLogger();
    const token = await this.getAccessToken();

    const gatewayUrl = `${this.apiBase}/v1.0/gateway/connections/open`;
    const res = await fetch(gatewayUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'access-token': token,
      },
      body: JSON.stringify({
        clientId: this.clientId,
        clientSecret: this.clientSecret,
        subscriptions: this.client.getConfig().subscriptions,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      log.error({ status: res.status, body: errText }, 'Failed to get DingTalk Stream endpoint');
      throw new Error(`DingTalk gateway failed: ${res.status}`);
    }

    const data = await res.json() as { endpoint?: string; ticket?: string };
    if (!data.endpoint || !data.ticket) {
      throw new Error('DingTalk gateway: missing endpoint or ticket');
    }

    return `${data.endpoint}?ticket=${data.ticket}`;
  }

  /**
   * 缓存用户的 sessionWebhook。
   *
   * @param staffId - 用户 staffId。
   * @param webhook - sessionWebhook URL。
   * @param expiredTime - 过期时间戳（毫秒）。
   */
  private cacheWebhook(staffId: string, webhook: string, expiredTime: number): void {
    this.webhookCache.set(staffId, { url: webhook, expiredTime });
  }

  /**
   * 获取用户缓存的 sessionWebhook（如果未过期）。
   *
   * @param staffId - 用户 staffId。
   * @returns sessionWebhook URL 或 undefined。
   */
  private getCachedWebhook(staffId: string): string | undefined {
    const entry = this.webhookCache.get(staffId);
    if (entry && Date.now() < entry.expiredTime) {
      return entry.url;
    }
    this.webhookCache.delete(staffId);
    return undefined;
  }

  /**
   * 通过 downloadCode 获取临时下载 URL。
   *
   * @param downloadCode - 钉钉消息中的 downloadCode。
   * @returns 临时下载 URL。
   */
  private async getDownloadUrl(downloadCode: string): Promise<string> {
    const log = getLogger();
    const token = await this.getAccessToken();

    const res = await fetch(`${this.apiBase}/v1.0/robot/messageFiles/download`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-acs-dingtalk-access-token': token,
      },
      body: JSON.stringify({
        downloadCode,
        robotCode: this.robotCode,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      log.error({ status: res.status, body: errText }, 'DingTalk download URL request failed');
      throw new Error(`DingTalk download failed: ${res.status}`);
    }

    const data = await res.json() as { downloadUrl?: string };
    if (!data.downloadUrl) {
      throw new Error('DingTalk download: no downloadUrl in response');
    }

    return data.downloadUrl;
  }

  /**
   * 下载远程文件到本地 uploads 目录。
   *
   * @param url - 文件下载 URL。
   * @param userId - 用户 ID（用于目录隔离）。
   * @param msgId - 消息 ID（用于文件名去重）。
   * @param ext - 文件扩展名（含 "."）。
   * @returns 本地文件绝对路径。
   */
  private async downloadToLocal(url: string, userId: string, msgId: string, ext: string): Promise<string> {
    const config = getConfig();
    const uploadDir = join(config.dataDir, 'uploads', userId);
    ensureDir(uploadDir);

    const fileName = `${Date.now()}_${msgId}${ext}`;
    const filePath = join(uploadDir, fileName);

    const res = await fetch(url);
    if (!res.ok) throw new Error(`File download failed: ${res.status}`);

    const buffer = Buffer.from(await res.arrayBuffer());
    writeFileSync(filePath, buffer);

    return resolve(filePath);
  }

  /**
   * 通过 downloadCode 下载钉钉媒体文件到本地。
   *
   * @param downloadCode - 消息中的 downloadCode。
   * @param userId - 用户 staffId。
   * @param msgId - 消息 ID。
   * @param ext - 文件扩展名。
   * @returns 本地文件绝对路径。
   */
  private async downloadMediaFile(downloadCode: string, userId: string, msgId: string, ext: string): Promise<string> {
    const url = await this.getDownloadUrl(downloadCode);
    return this.downloadToLocal(url, userId, msgId, ext);
  }

  /**
   * 处理图片消息。
   */
  private async handlePictureMessage(
    robotMsg: DingtalkPictureMessage,
    staffId: string,
  ): Promise<Partial<Pick<InboundMessage, 'text' | 'attachments'>>> {
    const log = getLogger();

    try {
      const localPath = await this.downloadMediaFile(
        robotMsg.content.downloadCode,
        staffId,
        robotMsg.msgId,
        '.jpg',
      );

      const attachment: Attachment = {
        type: 'photo',
        localPath,
        mimeType: 'image/jpeg',
      };

      return {
        text: `[用户发送了图片: ${localPath}]`,
        attachments: [attachment],
      };
    } catch (err) {
      log.error({ err, staffId }, 'Failed to download DingTalk picture');
      return { text: '[用户发送了图片，但下载失败]' };
    }
  }

  /**
   * 处理语音消息。
   *
   * 优先使用钉钉内置 ASR（recognition 字段），不可用时回退到 Whisper。
   */
  private async handleAudioMessage(
    robotMsg: DingtalkAudioMessage,
    staffId: string,
  ): Promise<Partial<Pick<InboundMessage, 'text' | 'attachments'>>> {
    const log = getLogger();

    let localPath: string | undefined;
    try {
      localPath = await this.downloadMediaFile(
        robotMsg.content.downloadCode,
        staffId,
        robotMsg.msgId,
        '.ogg',
      );
    } catch (err) {
      log.error({ err, staffId }, 'Failed to download DingTalk audio');
    }

    const attachment: Attachment | undefined = localPath
      ? { type: 'voice', localPath, mimeType: 'audio/ogg' }
      : undefined;

    // 优先使用钉钉内置语音识别。
    const recognition = robotMsg.content.recognition?.trim();
    if (recognition) {
      log.info({ staffId, textLength: recognition.length }, 'DingTalk built-in ASR available');
      return {
        text: `[用户发送了语音消息，转录文本: ${recognition}]`,
        attachments: attachment ? [attachment] : undefined,
      };
    }

    // 钉钉 ASR 不可用，尝试 Whisper 转录。
    if (localPath) {
      const sttResult = await transcribeAudio(localPath);
      if (sttResult.text) {
        return {
          text: `[用户发送了语音消息，转录文本: ${sttResult.text}]`,
          attachments: [attachment!],
        };
      }

      const reason = sttResult.unavailableReason ? `（原因: ${sttResult.unavailableReason}）` : '';
      return {
        text: `[用户发送了语音消息: ${localPath}]（自动语音转文字不可用${reason}，请使用可用的语音转录工具或 skill 来处理该音频文件）`,
        attachments: [attachment!],
      };
    }

    return { text: '[用户发送了语音消息，但下载失败且无内置转录]' };
  }

  /**
   * 处理视频消息。
   */
  private async handleVideoMessage(
    robotMsg: DingtalkVideoMessage,
    staffId: string,
  ): Promise<Partial<Pick<InboundMessage, 'text' | 'attachments'>>> {
    const log = getLogger();
    const videoExt = `.${robotMsg.content.videoType ?? 'mp4'}`;

    try {
      const localPath = await this.downloadMediaFile(
        robotMsg.content.downloadCode,
        staffId,
        robotMsg.msgId,
        videoExt,
      );

      const attachment: Attachment = {
        type: 'video',
        localPath,
        mimeType: `video/${robotMsg.content.videoType ?? 'mp4'}`,
      };

      const durationInfo = robotMsg.content.duration ? `，时长 ${robotMsg.content.duration} 秒` : '';
      return {
        text: `[用户发送了视频: ${localPath}${durationInfo}]`,
        attachments: [attachment],
      };
    } catch (err) {
      log.error({ err, staffId }, 'Failed to download DingTalk video');
      return { text: '[用户发送了视频，但下载失败]' };
    }
  }

  /**
   * 处理文件消息。
   */
  private async handleFileMessage(
    robotMsg: DingtalkFileMessage,
    staffId: string,
  ): Promise<Partial<Pick<InboundMessage, 'text' | 'attachments'>>> {
    const log = getLogger();
    const originalName = robotMsg.content.fileName ?? 'unknown';
    const dotIdx = originalName.lastIndexOf('.');
    const ext = dotIdx !== -1 ? originalName.slice(dotIdx) : '';

    try {
      const localPath = await this.downloadMediaFile(
        robotMsg.content.downloadCode,
        staffId,
        robotMsg.msgId,
        ext,
      );

      const attachment: Attachment = {
        type: 'document',
        localPath,
        fileName: originalName,
      };

      return {
        text: `[用户发送了文件: ${localPath}] (文件名: ${originalName})`,
        attachments: [attachment],
      };
    } catch (err) {
      log.error({ err, staffId }, 'Failed to download DingTalk file');
      return { text: `[用户发送了文件 "${originalName}"，但下载失败]` };
    }
  }

  /**
   * 处理富文本消息（图文混排）。
   */
  private async handleRichTextMessage(
    robotMsg: DingtalkRichTextMessage,
    staffId: string,
  ): Promise<Partial<Pick<InboundMessage, 'text' | 'attachments'>>> {
    const log = getLogger();
    const elements = robotMsg.content.richText ?? [];
    const textParts: string[] = [];
    const attachments: Attachment[] = [];

    for (const elem of elements) {
      if (elem.text) {
        textParts.push(elem.text);
      } else if (elem.type === 'picture' && elem.downloadCode) {
        try {
          const localPath = await this.downloadMediaFile(
            elem.downloadCode,
            staffId,
            robotMsg.msgId,
            '.jpg',
          );
          attachments.push({ type: 'photo', localPath, mimeType: 'image/jpeg' });
          textParts.push(`[图片: ${localPath}]`);
        } catch (err) {
          log.error({ err, staffId }, 'Failed to download DingTalk richText image');
          textParts.push('[图片下载失败]');
        }
      }
    }

    return {
      text: textParts.join('\n') || '[用户发送了富文本消息]',
      attachments: attachments.length > 0 ? attachments : undefined,
    };
  }

  /**
   * 启动钉钉适配器，开始监听消息。
   *
   * @param handler - 收到消息时的回调。
   */
  async start(handler: (msg: InboundMessage) => Promise<void>): Promise<void> {
    const log = getLogger();

    this.client.registerCallbackListener(TOPIC_ROBOT, async (res: DWClientDownStream) => {
      const robotMsg = JSON.parse(res.data) as DingtalkRobotMessage;

      // 仅处理单聊消息（conversationType == "1"）。
      if (robotMsg.conversationType !== '1') {
        log.debug({ conversationType: robotMsg.conversationType }, 'DingTalk: ignoring non-single-chat message');
        // 仍需 ack 以防止重试。
        this.client.send(res.headers.messageId, { status: EventAck.SUCCESS });
        return;
      }

      const staffId = robotMsg.senderStaffId;

      log.info({ staffId, msgtype: robotMsg.msgtype }, 'DingTalk message received');

      // 缓存 sessionWebhook。
      if (robotMsg.sessionWebhook && robotMsg.sessionWebhookExpiredTime) {
        this.cacheWebhook(staffId, robotMsg.sessionWebhook, robotMsg.sessionWebhookExpiredTime);
      }

      // ack 回调，防止钉钉 60 秒后重试（尽早 ack，媒体下载可能耗时）。
      this.client.send(res.headers.messageId, { status: EventAck.SUCCESS });

      // 根据消息类型解析内容。
      let text = '';
      let attachments: Attachment[] | undefined;

      switch (robotMsg.msgtype) {
        case 'text': {
          text = robotMsg.text.content?.trim() ?? '';
          break;
        }
        case 'picture': {
          const result = await this.handlePictureMessage(robotMsg, staffId);
          text = result.text ?? '';
          attachments = result.attachments;
          break;
        }
        case 'audio': {
          const result = await this.handleAudioMessage(robotMsg, staffId);
          text = result.text ?? '';
          attachments = result.attachments;
          break;
        }
        case 'video': {
          const result = await this.handleVideoMessage(robotMsg, staffId);
          text = result.text ?? '';
          attachments = result.attachments;
          break;
        }
        case 'file': {
          const result = await this.handleFileMessage(robotMsg, staffId);
          text = result.text ?? '';
          attachments = result.attachments;
          break;
        }
        case 'richText': {
          const result = await this.handleRichTextMessage(robotMsg, staffId);
          text = result.text ?? '';
          attachments = result.attachments;
          break;
        }
        default: {
          log.debug({ msgtype: robotMsg.msgtype, staffId }, 'DingTalk: unsupported message type');
          text = `[用户发送了不支持的消息类型: ${robotMsg.msgtype}]`;
          break;
        }
      }

      // 解析命令（仅对纯文本消息）。
      const prefix = this.commandPrefix;
      const isCommand = !attachments && text.startsWith(prefix);
      let commandName: string | undefined;
      let commandArgs: string | undefined;

      if (isCommand) {
        const prefixLen = prefix.length;
        const spaceIdx = text.indexOf(' ');
        commandName = spaceIdx === -1 ? text.slice(prefixLen) : text.slice(prefixLen, spaceIdx);
        commandArgs = spaceIdx === -1 ? '' : text.slice(spaceIdx + 1).trim();
      }

      const inboundMsg: InboundMessage = {
        platform: 'dingtalk',
        platformUserId: staffId,
        text,
        raw: robotMsg,
        isCommand,
        commandName,
        commandArgs,
        attachments,
      };

      try {
        await handler(inboundMsg);
      } catch (err) {
        log.error({ err, staffId }, 'Error handling DingTalk message');
      }
    });

    this.client.registerAllEventListener(() => {
      return { status: EventAck.SUCCESS };
    });

    // 统一使用自定义连接逻辑：通过 fetch 获取 token 和 WebSocket endpoint，
    // 绕过 SDK 内置的 axios 请求（在代理环境下 axios 可能发送 plain HTTP 到 HTTPS 端口）。
    const wsUrl = await this.getStreamEndpoint();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 访问 SDK 私有属性以注入自定义 WebSocket URL。
    const clientAny = this.client as any;
    clientAny['dw_url'] = wsUrl;
    clientAny['config'] = {
      ...(this.client.getConfig()),
      access_token: this.accessToken,
    };
    await this.client._connect();
    log.info({ apiBase: this.apiBase, oapiBase: this.oapiBase }, 'DingTalk Stream client connected');
  }

  /** 停止钉钉适配器。 */
  async stop(): Promise<void> {
    this.client.disconnect();
  }

  /**
   * 通过 sessionWebhook 回复消息。
   *
   * @param webhook - sessionWebhook URL。
   * @param body - 请求体。
   * @returns 是否成功。
   */
  private async replyViaWebhook(webhook: string, body: Record<string, unknown>): Promise<boolean> {
    const log = getLogger();
    try {
      const token = await this.getAccessToken();
      const res = await fetch(webhook, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-acs-dingtalk-access-token': token,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errText = await res.text();
        log.warn({ status: res.status, body: errText }, 'DingTalk sessionWebhook reply failed');
        return false;
      }
      return true;
    } catch (err) {
      log.warn({ err }, 'DingTalk sessionWebhook reply error');
      return false;
    }
  }

  /**
   * 通过 OpenAPI 主动发送单聊消息。
   *
   * @param staffId - 用户 staffId。
   * @param msgKey - 消息类型 key。
   * @param msgParam - 消息参数 JSON 字符串。
   */
  private async sendViaOpenAPI(staffId: string, msgKey: string, msgParam: string): Promise<void> {
    const log = getLogger();
    const token = await this.getAccessToken();

    const res = await fetch(`${this.apiBase}/v1.0/robot/oToMessages/batchSend`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-acs-dingtalk-access-token': token,
      },
      body: JSON.stringify({
        robotCode: this.robotCode,
        userIds: [staffId],
        msgKey,
        msgParam,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      log.error({ status: res.status, body: errText, staffId, msgKey }, 'DingTalk OpenAPI send failed');
      throw new Error(`DingTalk send failed: ${res.status}`);
    }
  }

  /**
   * 向钉钉用户发送文本消息。
   *
   * 优先使用缓存的 sessionWebhook 回复（更快），回退到 OpenAPI 主动发消息。
   *
   * @param platformUserId - 用户 staffId。
   * @param text - 要发送的文本。
   */
  async sendText(platformUserId: string, text: string): Promise<void> {
    // 尝试通过 sessionWebhook 发送 Markdown 消息。
    const webhook = this.getCachedWebhook(platformUserId);
    if (webhook) {
      const body = {
        msgtype: 'markdown',
        markdown: {
          title: text.slice(0, 20),
          text,
        },
      };
      const ok = await this.replyViaWebhook(webhook, body);
      if (ok) return;
    }

    // 回退到 OpenAPI 主动发送。
    await this.sendViaOpenAPI(
      platformUserId,
      'sampleMarkdown',
      JSON.stringify({ title: text.slice(0, 20), text }),
    );
  }

  /**
   * 上传媒体文件到钉钉获取 mediaId。
   *
   * @param filePath - 本地文件路径。
   * @param fileType - 文件类型（image/voice/video/file）。
   * @returns mediaId。
   */
  private async uploadMedia(filePath: string, fileType: string): Promise<string> {
    const log = getLogger();
    const token = await this.getAccessToken();
    const fileName = basename(filePath);

    const formData = new FormData();
    const { readFile } = await import('fs/promises');
    const fileBytes = await readFile(filePath);
    const arrayBuffer = fileBytes.buffer.slice(fileBytes.byteOffset, fileBytes.byteOffset + fileBytes.byteLength);
    const blob = new Blob([arrayBuffer]);
    formData.append('media', blob, fileName);
    formData.append('type', fileType);

    const res = await fetch(
      `${this.apiBase}/v1.0/robot/messageFiles/upload?robotCode=${encodeURIComponent(this.robotCode)}`,
      {
        method: 'POST',
        headers: {
          'x-acs-dingtalk-access-token': token,
        },
        body: formData,
      },
    );

    if (!res.ok) {
      const errText = await res.text();
      log.error({ status: res.status, body: errText, filePath }, 'DingTalk media upload failed');
      throw new Error(`DingTalk upload failed: ${res.status}`);
    }

    const data = await res.json() as { mediaId?: string };
    if (!data.mediaId) {
      throw new Error('DingTalk upload: no mediaId in response');
    }

    log.debug({ mediaId: data.mediaId, fileName }, 'DingTalk media uploaded');
    return data.mediaId;
  }

  /**
   * 根据文件扩展名推断钉钉媒体类型。
   *
   * @param filePath - 文件路径。
   * @returns 媒体类型和对应的 msgKey。
   */
  private inferMediaType(filePath: string): { mediaType: string; msgKey: string } {
    const ext = extname(filePath).toLowerCase();
    const imageExts = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);
    const videoExts = new Set(['.mp4', '.mov', '.avi', '.mkv']);
    const audioExts = new Set(['.mp3', '.m4a', '.aac', '.wav', '.ogg', '.oga']);

    if (imageExts.has(ext)) return { mediaType: 'image', msgKey: 'sampleImageMsg' };
    if (videoExts.has(ext)) return { mediaType: 'video', msgKey: 'sampleVideo' };
    if (audioExts.has(ext)) return { mediaType: 'voice', msgKey: 'sampleAudio' };
    return { mediaType: 'file', msgKey: 'sampleFile' };
  }

  /**
   * 向钉钉用户发送文件。
   *
   * 先上传文件获取 mediaId，再通过 OpenAPI 发送。
   *
   * @param platformUserId - 用户 staffId。
   * @param filePath - 本地文件绝对路径。
   * @param options - 发送选项。
   */
  async sendFile(platformUserId: string, filePath: string, options?: SendFileOptions): Promise<void> {
    const log = getLogger();
    const fileName = basename(filePath);

    // 根据 options.type 或文件扩展名推断类型。
    let mediaType: string;
    let msgKey: string;

    if (options?.type === 'photo') {
      mediaType = 'image';
      msgKey = 'sampleImageMsg';
    } else if (options?.type === 'video') {
      mediaType = 'video';
      msgKey = 'sampleVideo';
    } else if (options?.type === 'voice' || options?.type === 'audio') {
      mediaType = 'voice';
      msgKey = 'sampleAudio';
    } else {
      const inferred = this.inferMediaType(filePath);
      mediaType = inferred.mediaType;
      msgKey = inferred.msgKey;
    }

    try {
      const mediaId = await this.uploadMedia(filePath, mediaType);

      let msgParam: string;
      if (msgKey === 'sampleImageMsg') {
        // 钉钉图片消息通过 mediaId 发送时，使用 sampleFile 更可靠。
        msgParam = JSON.stringify({ mediaId, fileName, fileType: mediaType });
        msgKey = 'sampleFile';
      } else {
        msgParam = JSON.stringify({ mediaId, fileName, fileType: mediaType });
      }

      await this.sendViaOpenAPI(platformUserId, msgKey, msgParam);
      log.info({ staffId: platformUserId, fileName, msgKey }, 'DingTalk file sent');
    } catch (err) {
      log.error({ err, filePath, platformUserId }, 'Failed to send file via DingTalk');
      // 文件发送失败时，发送文本通知。
      await this.sendText(platformUserId, `[文件发送失败: ${fileName}]`);
    }
  }

  /**
   * 向钉钉用户显示 typing 状态。
   *
   * 钉钉不支持 typing 状态 API，空实现。
   */
  async showTyping(_platformUserId: string): Promise<void> {
    // 钉钉无 typing 状态 API。
  }
}
