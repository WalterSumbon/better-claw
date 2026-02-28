import { basename, extname } from 'path';
import { DWClient, TOPIC_ROBOT, EventAck } from 'dingtalk-stream-sdk-nodejs';
import type { DWClientDownStream, RobotMessage } from 'dingtalk-stream-sdk-nodejs';
import type { MessageAdapter, SendFileOptions } from '../interface.js';
import type { InboundMessage } from '../types.js';
import { getLogger } from '../../logger/index.js';

/** Access token 缓存有效期（毫秒），钉钉 token 有效期 7200 秒，提前 5 分钟刷新。 */
const TOKEN_TTL_MS = (7200 - 300) * 1000;

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
  private commandPrefix: string;

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
   * 启动钉钉适配器，开始监听消息。
   *
   * @param handler - 收到消息时的回调。
   */
  async start(handler: (msg: InboundMessage) => Promise<void>): Promise<void> {
    const log = getLogger();

    this.client.registerCallbackListener(TOPIC_ROBOT, async (res: DWClientDownStream) => {
      const robotMsg = JSON.parse(res.data) as RobotMessage;

      // 仅处理单聊消息（conversationType == "1"）。
      if (robotMsg.conversationType !== '1') {
        log.debug({ conversationType: robotMsg.conversationType }, 'DingTalk: ignoring non-single-chat message');
        // 仍需 ack 以防止重试。
        this.client.send(res.headers.messageId, { status: EventAck.SUCCESS });
        return;
      }

      const staffId = robotMsg.senderStaffId;
      const text = robotMsg.text?.content?.trim() ?? '';

      log.info({ staffId, text: text.slice(0, 100) }, 'DingTalk message received');

      // 缓存 sessionWebhook。
      if (robotMsg.sessionWebhook && robotMsg.sessionWebhookExpiredTime) {
        this.cacheWebhook(staffId, robotMsg.sessionWebhook, robotMsg.sessionWebhookExpiredTime);
      }

      // 解析命令。
      const prefix = this.commandPrefix;
      const isCommand = text.startsWith(prefix);
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
      };

      // ack 回调，防止钉钉 60 秒后重试。
      this.client.send(res.headers.messageId, { status: EventAck.SUCCESS });

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
