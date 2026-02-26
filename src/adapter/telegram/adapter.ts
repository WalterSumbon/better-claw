import { writeFileSync } from 'fs';
import { join, resolve, extname } from 'path';
import https from 'node:https';
import type { Agent as HttpsAgent } from 'node:https';
import { Bot, InputFile, type Context } from 'grammy';
import type { MessageAdapter, SendFileOptions } from '../interface.js';
import type { InboundMessage, Attachment } from '../types.js';
import { splitMessage, markdownToTelegramHTML } from './formatter.js';
import { getLogger } from '../../logger/index.js';
import { getConfig } from '../../config/index.js';
import { ensureDir } from '../../utils/file.js';
import { transcribeAudio } from '../../utils/transcribe.js';

/** Telegram 适配器：通过 grammy 与 Telegram Bot API 交互。 */
export class TelegramAdapter implements MessageAdapter {
  readonly platform = 'telegram' as const;
  private bot: Bot;
  private botToken: string;
  private fetchAgent: unknown | undefined;
  private running = false;

  /**
   * @param bot - grammy Bot 实例。
   * @param botToken - Telegram Bot token，用于构造文件下载 URL。
   * @param fetchAgent - 可选的 HTTP 代理 agent，用于文件下载。
   */
  private constructor(bot: Bot, botToken: string, fetchAgent?: unknown) {
    this.bot = bot;
    this.botToken = botToken;
    this.fetchAgent = fetchAgent;
  }

  /**
   * 创建 TelegramAdapter 实例。
   *
   * @param botToken - Telegram Bot token。
   * @param proxy - 可选的 HTTP 代理地址，未指定时从环境变量读取。
   */
  static async create(botToken: string, proxy?: string): Promise<TelegramAdapter> {
    const proxyUrl = proxy || process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
    let bot: Bot;
    let fetchAgent: unknown | undefined;
    if (proxyUrl) {
      const { HttpsProxyAgent } = await import('https-proxy-agent');
      fetchAgent = new HttpsProxyAgent(proxyUrl);
      bot = new Bot(botToken, {
        client: {
          baseFetchConfig: { agent: fetchAgent, compress: true } as Record<string, unknown>,
        },
      });
    } else {
      bot = new Bot(botToken);
    }
    return new TelegramAdapter(bot, botToken, fetchAgent);
  }

  /**
   * 通过 Telegram Bot API 下载文件到本地。
   *
   * @param fileId - Telegram 文件 ID。
   * @param userId - 用户目录标识。
   * @param fileUniqueId - 文件唯一 ID，用于文件名。
   * @param ext - 文件扩展名。
   * @returns 本地文件绝对路径。
   */
  private async downloadFile(
    fileId: string,
    userId: string,
    fileUniqueId: string,
    ext: string,
  ): Promise<string> {
    const file = await this.bot.api.getFile(fileId);
    if (!file.file_path) {
      throw new Error(`Telegram getFile returned no file_path for ${fileId}`);
    }

    const url = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;

    const buffer = await new Promise<Buffer>((resolvePromise, reject) => {
      const options: https.RequestOptions = {};
      if (this.fetchAgent) {
        options.agent = this.fetchAgent as HttpsAgent;
      }
      https.get(url, options, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`Failed to download file: ${res.statusCode} ${res.statusMessage}`));
          res.resume();
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolvePromise(Buffer.concat(chunks)));
        res.on('error', reject);
      }).on('error', reject);
    });
    const config = getConfig();
    const uploadDir = join(config.dataDir, 'uploads', userId);
    ensureDir(uploadDir);

    const fileName = `${Date.now()}_${fileUniqueId}${ext}`;
    const filePath = join(uploadDir, fileName);
    writeFileSync(filePath, buffer);

    return resolve(filePath);
  }

  /**
   * 启动 Telegram 适配器，开始监听消息。
   *
   * @param handler - 收到消息时的回调。
   */
  async start(handler: (msg: InboundMessage) => Promise<void>): Promise<void> {
    const log = getLogger();
    this.running = true;

    // 处理文本消息。
    this.bot.on('message:text', async (ctx: Context) => {
      const text = ctx.message?.text;
      const chatId = ctx.chat?.id;
      if (!text || chatId === undefined) return;

      log.info({ chatId, text: text.slice(0, 100) }, 'Telegram message received');

      const platformUserId = String(chatId);
      const isCommand = text.startsWith('/');
      let commandName: string | undefined;
      let commandArgs: string | undefined;

      if (isCommand) {
        // 解析命令，去掉 @botname 后缀。
        const spaceIdx = text.indexOf(' ');
        const rawCommand = spaceIdx === -1 ? text.slice(1) : text.slice(1, spaceIdx);
        commandName = rawCommand.split('@')[0];
        commandArgs = spaceIdx === -1 ? '' : text.slice(spaceIdx + 1).trim();
      }

      const msg: InboundMessage = {
        platform: 'telegram',
        platformUserId,
        text,
        raw: ctx.message,
        isCommand,
        commandName,
        commandArgs,
      };

      try {
        await handler(msg);
      } catch (err) {
        log.error({ err, chatId }, 'Error handling Telegram message');
      }
    });

    // 处理图片消息。
    this.bot.on('message:photo', async (ctx: Context) => {
      const chatId = ctx.chat?.id;
      const photos = ctx.message?.photo;
      if (!photos || photos.length === 0 || chatId === undefined) return;

      const platformUserId = String(chatId);
      const caption = ctx.message?.caption ?? '';
      log.info({ chatId, caption: caption.slice(0, 100) }, 'Telegram photo received');

      // 取最大尺寸的图片。
      const largest = photos[photos.length - 1];

      let localPath: string;
      try {
        localPath = await this.downloadFile(
          largest.file_id,
          platformUserId,
          largest.file_unique_id,
          '.jpg',
        );
      } catch (err) {
        log.error({ err, chatId }, 'Failed to download photo');
        return;
      }

      const attachment: Attachment = {
        type: 'photo',
        localPath,
        mimeType: 'image/jpeg',
      };

      const textParts = [`[用户发送了图片: ${localPath}]`];
      if (caption) {
        textParts.push(caption);
      }

      const msg: InboundMessage = {
        platform: 'telegram',
        platformUserId,
        text: textParts.join('\n'),
        raw: ctx.message,
        isCommand: false,
        attachments: [attachment],
      };

      try {
        await handler(msg);
      } catch (err) {
        log.error({ err, chatId }, 'Error handling Telegram photo message');
      }
    });

    // 处理语音消息。
    this.bot.on('message:voice', async (ctx: Context) => {
      const chatId = ctx.chat?.id;
      const voice = ctx.message?.voice;
      if (!voice || chatId === undefined) return;

      const platformUserId = String(chatId);
      log.info({ chatId, duration: voice.duration }, 'Telegram voice received');

      let localPath: string;
      try {
        localPath = await this.downloadFile(
          voice.file_id,
          platformUserId,
          voice.file_unique_id,
          '.oga',
        );
      } catch (err) {
        log.error({ err, chatId }, 'Failed to download voice');
        return;
      }

      const attachment: Attachment = {
        type: 'voice',
        localPath,
        mimeType: voice.mime_type ?? 'audio/ogg',
      };

      // 尝试语音转文字。
      const sttResult = await transcribeAudio(localPath);

      const textParts: string[] = [];
      if (sttResult.text) {
        textParts.push(`[用户发送了语音消息，转录文本: ${sttResult.text}]`);
      } else {
        const reason = sttResult.unavailableReason ? `（原因: ${sttResult.unavailableReason}）` : '';
        textParts.push(`[用户发送了语音消息: ${localPath}]（自动语音转文字不可用${reason}，请使用可用的语音转录工具或 skill 来处理该音频文件）`);
      }

      const msg: InboundMessage = {
        platform: 'telegram',
        platformUserId,
        text: textParts.join('\n'),
        raw: ctx.message,
        isCommand: false,
        attachments: [attachment],
      };

      try {
        await handler(msg);
      } catch (err) {
        log.error({ err, chatId }, 'Error handling Telegram voice message');
      }
    });

    // 处理文件消息。
    this.bot.on('message:document', async (ctx: Context) => {
      const chatId = ctx.chat?.id;
      const doc = ctx.message?.document;
      if (!doc || chatId === undefined) return;

      const platformUserId = String(chatId);
      const caption = ctx.message?.caption ?? '';
      const fileName = doc.file_name ?? 'unknown';
      log.info({ chatId, fileName, mimeType: doc.mime_type }, 'Telegram document received');

      // 从文件名提取扩展名，无扩展名时留空。
      const dotIdx = fileName.lastIndexOf('.');
      const ext = dotIdx !== -1 ? fileName.slice(dotIdx) : '';

      let localPath: string;
      try {
        localPath = await this.downloadFile(
          doc.file_id,
          platformUserId,
          doc.file_unique_id,
          ext,
        );
      } catch (err) {
        log.error({ err, chatId }, 'Failed to download document');
        return;
      }

      const attachment: Attachment = {
        type: 'document',
        localPath,
        fileName,
        mimeType: doc.mime_type,
      };

      const textParts = [`[用户发送了文件: ${localPath}] (文件名: ${fileName})`];
      if (caption) {
        textParts.push(caption);
      }

      const msg: InboundMessage = {
        platform: 'telegram',
        platformUserId,
        text: textParts.join('\n'),
        raw: ctx.message,
        isCommand: false,
        attachments: [attachment],
      };

      try {
        await handler(msg);
      } catch (err) {
        log.error({ err, chatId }, 'Error handling Telegram document message');
      }
    });

    // 处理视频消息。
    this.bot.on('message:video', async (ctx: Context) => {
      const chatId = ctx.chat?.id;
      const video = ctx.message?.video;
      if (!video || chatId === undefined) return;

      const platformUserId = String(chatId);
      const caption = ctx.message?.caption ?? '';
      const fileName = video.file_name ?? 'video';
      log.info({ chatId, fileName, mimeType: video.mime_type, duration: video.duration }, 'Telegram video received');

      const dotIdx = fileName.lastIndexOf('.');
      const ext = dotIdx !== -1 ? fileName.slice(dotIdx) : '.mp4';

      let localPath: string;
      try {
        localPath = await this.downloadFile(
          video.file_id,
          platformUserId,
          video.file_unique_id,
          ext,
        );
      } catch (err) {
        log.error({ err, chatId }, 'Failed to download video');
        return;
      }

      const attachment: Attachment = {
        type: 'video',
        localPath,
        fileName,
        mimeType: video.mime_type ?? 'video/mp4',
      };

      const textParts = [`[用户发送了视频: ${localPath}] (文件名: ${fileName}, 时长: ${video.duration}秒)`];
      if (caption) {
        textParts.push(caption);
      }

      const msg: InboundMessage = {
        platform: 'telegram',
        platformUserId,
        text: textParts.join('\n'),
        raw: ctx.message,
        isCommand: false,
        attachments: [attachment],
      };

      try {
        await handler(msg);
      } catch (err) {
        log.error({ err, chatId }, 'Error handling Telegram video message');
      }
    });

    // 处理圆形视频消息。
    this.bot.on('message:video_note', async (ctx: Context) => {
      const chatId = ctx.chat?.id;
      const videoNote = ctx.message?.video_note;
      if (!videoNote || chatId === undefined) return;

      const platformUserId = String(chatId);
      log.info({ chatId, duration: videoNote.duration }, 'Telegram video_note received');

      let localPath: string;
      try {
        localPath = await this.downloadFile(
          videoNote.file_id,
          platformUserId,
          videoNote.file_unique_id,
          '.mp4',
        );
      } catch (err) {
        log.error({ err, chatId }, 'Failed to download video_note');
        return;
      }

      const attachment: Attachment = {
        type: 'video_note',
        localPath,
        mimeType: 'video/mp4',
      };

      const msg: InboundMessage = {
        platform: 'telegram',
        platformUserId,
        text: `[用户发送了圆形视频: ${localPath}] (时长: ${videoNote.duration}秒)`,
        raw: ctx.message,
        isCommand: false,
        attachments: [attachment],
      };

      try {
        await handler(msg);
      } catch (err) {
        log.error({ err, chatId }, 'Error handling Telegram video_note message');
      }
    });

    // 处理音频消息。
    this.bot.on('message:audio', async (ctx: Context) => {
      const chatId = ctx.chat?.id;
      const audio = ctx.message?.audio;
      if (!audio || chatId === undefined) return;

      const platformUserId = String(chatId);
      const caption = ctx.message?.caption ?? '';
      const fileName = audio.file_name ?? 'audio';
      log.info({ chatId, fileName, mimeType: audio.mime_type, duration: audio.duration }, 'Telegram audio received');

      const dotIdx = fileName.lastIndexOf('.');
      const ext = dotIdx !== -1 ? fileName.slice(dotIdx) : '.mp3';

      let localPath: string;
      try {
        localPath = await this.downloadFile(
          audio.file_id,
          platformUserId,
          audio.file_unique_id,
          ext,
        );
      } catch (err) {
        log.error({ err, chatId }, 'Failed to download audio');
        return;
      }

      const attachment: Attachment = {
        type: 'audio',
        localPath,
        fileName,
        mimeType: audio.mime_type ?? 'audio/mpeg',
      };

      // 尝试语音转文字。
      const sttResult = await transcribeAudio(localPath);

      const textParts: string[] = [];
      if (sttResult.text) {
        textParts.push(`[用户发送了音频: ${localPath}] (文件名: ${fileName}, 时长: ${audio.duration}秒, 转录文本: ${sttResult.text})`);
      } else {
        const reason = sttResult.unavailableReason ? `（原因: ${sttResult.unavailableReason}）` : '';
        textParts.push(`[用户发送了音频: ${localPath}] (文件名: ${fileName}, 时长: ${audio.duration}秒)（自动转录不可用${reason}）`);
      }
      if (caption) {
        textParts.push(caption);
      }

      const msg: InboundMessage = {
        platform: 'telegram',
        platformUserId,
        text: textParts.join('\n'),
        raw: ctx.message,
        isCommand: false,
        attachments: [attachment],
      };

      try {
        await handler(msg);
      } catch (err) {
        log.error({ err, chatId }, 'Error handling Telegram audio message');
      }
    });

    // 处理贴纸消息。
    this.bot.on('message:sticker', async (ctx: Context) => {
      const chatId = ctx.chat?.id;
      const sticker = ctx.message?.sticker;
      if (!sticker || chatId === undefined) return;

      const platformUserId = String(chatId);
      log.info({ chatId, emoji: sticker.emoji, setName: sticker.set_name }, 'Telegram sticker received');

      const isAnimated = sticker.is_animated ?? false;
      const isVideo = sticker.is_video ?? false;
      let ext = '.webp';
      let mimeType = 'image/webp';
      if (isAnimated) {
        ext = '.tgs';
        mimeType = 'application/x-tgsticker';
      } else if (isVideo) {
        ext = '.webm';
        mimeType = 'video/webm';
      }

      let localPath: string;
      try {
        localPath = await this.downloadFile(
          sticker.file_id,
          platformUserId,
          sticker.file_unique_id,
          ext,
        );
      } catch (err) {
        log.error({ err, chatId }, 'Failed to download sticker');
        return;
      }

      const attachment: Attachment = {
        type: 'sticker',
        localPath,
        mimeType,
      };

      const emojiInfo = sticker.emoji ? `, 表情: ${sticker.emoji}` : '';
      const setInfo = sticker.set_name ? `, 贴纸包: ${sticker.set_name}` : '';

      const msg: InboundMessage = {
        platform: 'telegram',
        platformUserId,
        text: `[用户发送了贴纸: ${localPath}${emojiInfo}${setInfo}]`,
        raw: ctx.message,
        isCommand: false,
        attachments: [attachment],
      };

      try {
        await handler(msg);
      } catch (err) {
        log.error({ err, chatId }, 'Error handling Telegram sticker message');
      }
    });

    // 处理动画（GIF）消息。
    this.bot.on('message:animation', async (ctx: Context) => {
      const chatId = ctx.chat?.id;
      const animation = ctx.message?.animation;
      if (!animation || chatId === undefined) return;

      const platformUserId = String(chatId);
      const caption = ctx.message?.caption ?? '';
      const fileName = animation.file_name ?? 'animation';
      log.info({ chatId, fileName, mimeType: animation.mime_type }, 'Telegram animation received');

      const dotIdx = fileName.lastIndexOf('.');
      const ext = dotIdx !== -1 ? fileName.slice(dotIdx) : '.mp4';

      let localPath: string;
      try {
        localPath = await this.downloadFile(
          animation.file_id,
          platformUserId,
          animation.file_unique_id,
          ext,
        );
      } catch (err) {
        log.error({ err, chatId }, 'Failed to download animation');
        return;
      }

      const attachment: Attachment = {
        type: 'animation',
        localPath,
        fileName,
        mimeType: animation.mime_type ?? 'video/mp4',
      };

      const textParts = [`[用户发送了动画/GIF: ${localPath}] (文件名: ${fileName}, 时长: ${animation.duration}秒)`];
      if (caption) {
        textParts.push(caption);
      }

      const msg: InboundMessage = {
        platform: 'telegram',
        platformUserId,
        text: textParts.join('\n'),
        raw: ctx.message,
        isCommand: false,
        attachments: [attachment],
      };

      try {
        await handler(msg);
      } catch (err) {
        log.error({ err, chatId }, 'Error handling Telegram animation message');
      }
    });

    // 处理位置消息。
    this.bot.on('message:location', async (ctx: Context) => {
      const chatId = ctx.chat?.id;
      const location = ctx.message?.location;
      if (!location || chatId === undefined) return;

      const platformUserId = String(chatId);
      log.info({ chatId, latitude: location.latitude, longitude: location.longitude }, 'Telegram location received');

      const attachment: Attachment = {
        type: 'location',
        localPath: '',
      };

      const msg: InboundMessage = {
        platform: 'telegram',
        platformUserId,
        text: `[用户发送了位置: 纬度 ${location.latitude}, 经度 ${location.longitude}]`,
        raw: ctx.message,
        isCommand: false,
        attachments: [attachment],
      };

      try {
        await handler(msg);
      } catch (err) {
        log.error({ err, chatId }, 'Error handling Telegram location message');
      }
    });

    // 处理联系人消息。
    this.bot.on('message:contact', async (ctx: Context) => {
      const chatId = ctx.chat?.id;
      const contact = ctx.message?.contact;
      if (!contact || chatId === undefined) return;

      const platformUserId = String(chatId);
      log.info({ chatId, firstName: contact.first_name }, 'Telegram contact received');

      const attachment: Attachment = {
        type: 'contact',
        localPath: '',
      };

      const nameParts = [contact.first_name];
      if (contact.last_name) {
        nameParts.push(contact.last_name);
      }
      const name = nameParts.join(' ');
      const phoneInfo = contact.phone_number ? `, 电话: ${contact.phone_number}` : '';

      const msg: InboundMessage = {
        platform: 'telegram',
        platformUserId,
        text: `[用户发送了联系人: ${name}${phoneInfo}]`,
        raw: ctx.message,
        isCommand: false,
        attachments: [attachment],
      };

      try {
        await handler(msg);
      } catch (err) {
        log.error({ err, chatId }, 'Error handling Telegram contact message');
      }
    });

    // 错误处理。
    this.bot.catch((err) => {
      log.error({ err: err.error }, 'grammy error');
    });

    // 注册 Bot 命令菜单，让用户在输入框输入 / 时看到可用命令。
    await this.bot.api.setMyCommands([
      { command: 'new', description: '开始新会话（归档当前会话）' },
      { command: 'stop', description: '中断当前 AI 响应' },
      { command: 'restart', description: '重启服务' },
      { command: 'bind', description: '绑定账号（/bind <token>）' },
    ]);

    // 清除可能存在的 webhook，确保 long polling 正常工作。
    await this.bot.api.deleteWebhook({ drop_pending_updates: false });

    // 启动 long polling，不丢弃离线期间的 pending updates。
    this.bot.start({
      drop_pending_updates: false,
      onStart: () => {
        log.info('Telegram bot started (long polling, pending updates will be processed)');
      },
    }).catch((err) => {
      log.error({ err }, 'Telegram bot polling failed');
    });
  }

  /** 停止 Telegram 适配器。 */
  async stop(): Promise<void> {
    this.running = false;
    await this.bot.stop();
  }

  /**
   * 向 Telegram 用户发送文本消息。
   *
   * 长文本自动切分为多条消息。
   *
   * @param platformUserId - Telegram chat ID。
   * @param text - 要发送的文本。
   */
  async sendText(platformUserId: string, text: string): Promise<void> {
    const chatId = Number(platformUserId);
    const htmlText = markdownToTelegramHTML(text);
    const chunks = splitMessage(htmlText);

    for (const chunk of chunks) {
      try {
        await this.bot.api.sendMessage(chatId, chunk, { parse_mode: 'HTML' });
      } catch {
        // HTML 解析失败时回退到纯文本。
        await this.bot.api.sendMessage(chatId, chunk);
      }
    }
  }

  /**
   * 根据文件扩展名推断发送类型。
   *
   * @param filePath - 文件路径。
   * @returns 推断的发送类型。
   */
  private inferFileType(filePath: string): NonNullable<SendFileOptions['type']> {
    const ext = extname(filePath).toLowerCase();
    const photoExts = new Set(['.jpg', '.jpeg', '.png', '.webp']);
    const videoExts = new Set(['.mp4', '.mov', '.avi', '.mkv']);
    const audioExts = new Set(['.mp3', '.m4a', '.aac', '.flac', '.wav']);
    const voiceExts = new Set(['.ogg', '.oga']);
    const animationExts = new Set(['.gif']);

    if (photoExts.has(ext)) return 'photo';
    if (videoExts.has(ext)) return 'video';
    if (audioExts.has(ext)) return 'audio';
    if (voiceExts.has(ext)) return 'voice';
    if (animationExts.has(ext)) return 'animation';
    return 'document';
  }

  /**
   * 向 Telegram 用户发送文件（图片、视频、音频、文档等）。
   *
   * 根据 options.type 或文件扩展名自动选择对应的 Telegram API。
   *
   * @param platformUserId - Telegram chat ID。
   * @param filePath - 本地文件绝对路径。
   * @param options - 发送选项。
   */
  async sendFile(platformUserId: string, filePath: string, options?: SendFileOptions): Promise<void> {
    const chatId = Number(platformUserId);
    const fileType = options?.type ?? this.inferFileType(filePath);
    const caption = options?.caption ? markdownToTelegramHTML(options.caption) : undefined;
    const mediaOptions = caption ? { caption, parse_mode: 'HTML' as const } : {};
    const inputFile = new InputFile(filePath);

    switch (fileType) {
      case 'photo':
        await this.bot.api.sendPhoto(chatId, inputFile, mediaOptions);
        break;
      case 'video':
        await this.bot.api.sendVideo(chatId, inputFile, mediaOptions);
        break;
      case 'audio':
        await this.bot.api.sendAudio(chatId, inputFile, mediaOptions);
        break;
      case 'voice':
        await this.bot.api.sendVoice(chatId, inputFile, mediaOptions);
        break;
      case 'animation':
        await this.bot.api.sendAnimation(chatId, inputFile, mediaOptions);
        break;
      case 'document':
      default:
        await this.bot.api.sendDocument(chatId, inputFile, mediaOptions);
        break;
    }
  }

  /**
   * 向 Telegram 用户显示 typing 状态。
   *
   * @param platformUserId - Telegram chat ID。
   */
  async showTyping(platformUserId: string): Promise<void> {
    const chatId = Number(platformUserId);
    await this.bot.api.sendChatAction(chatId, 'typing');
  }
}
