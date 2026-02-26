import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { getLogger } from '../logger/index.js';
import { getConfig } from '../config/index.js';
import type { SendFileOptions } from '../adapter/interface.js';
import { sendToAgent, interruptAgent, AgentInterruptedError } from './agent.js';

/** 队列中的消息。 */
export interface QueuedMessage {
  /** 系统内用户 ID。 */
  userId: string;
  /** 消息文本。 */
  text: string;
  /** 向用户发送回复的回调。 */
  reply: (text: string) => Promise<void>;
  /** 向用户发送文件的回调。 */
  sendFile: (filePath: string, options?: SendFileOptions) => Promise<void>;
  /** 显示 typing 状态的回调。 */
  showTyping: () => void;
  /** 消息来源平台。 */
  platform: string;
}

/** 每用户消息队列。 */
const queues = new Map<string, QueuedMessage[]>();

/** 正在处理中的用户集合。 */
const processing = new Set<string>();

/**
 * 从 SDK 消息中提取可发送给用户的文本。
 *
 * 当 pushIntermediate 为 true 时，通过 assistant 消息实时推送文本，
 * 不再重复推送 result 消息（内容相同）。
 * 当 pushIntermediate 为 false 时，仅推送最终的 result 消息。
 *
 * @param msg - SDK 消息。
 * @param pushIntermediate - 是否推送中间消息。
 * @returns 文本内容，无可发送内容时返回 null。
 */
function extractText(msg: SDKMessage, pushIntermediate: boolean): string | null {
  if (msg.type === 'assistant' && pushIntermediate) {
    // 从 BetaMessage 中提取文本块。
    const textBlocks = msg.message.content.filter(
      (block: { type: string }) => block.type === 'text',
    );
    const text = textBlocks
      .map((block: { type: string; text?: string }) => block.text ?? '')
      .join('');
    if (text.trim()) {
      return text;
    }
  }

  // 仅在不推送中间消息时才推送 result，避免重复。
  if (!pushIntermediate && msg.type === 'result' && 'result' in msg && typeof msg.result === 'string') {
    return msg.result;
  }

  return null;
}

/**
 * 将文本截断为摘要格式，用于日志输出。
 *
 * @param text - 原始文本。
 * @param maxLength - 最大显示长度。
 * @returns 原文或摘要字符串。
 */
function digestText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  const headLen = Math.ceil(maxLength / 2);
  const tailLen = Math.floor(maxLength / 2);
  return `${text.slice(0, headLen)}...${text.slice(-tailLen)} (length: ${text.length})`;
}

/** Typing 状态刷新间隔（毫秒）。Telegram 的 typing 状态约 5 秒过期。 */
const TYPING_REFRESH_MS = 4000;

/**
 * 处理单条消息：发送给 agent 并流式推送响应。
 *
 * @param message - 队列中的消息。
 */
async function processMessage(message: QueuedMessage): Promise<void> {
  const log = getLogger();
  const config = getConfig();
  const pushIntermediate = config.messagePush.pushIntermediateMessages;

  message.showTyping();

  // 定期刷新 typing 状态，直到 agent 完成。
  const typingInterval = setInterval(() => {
    message.showTyping();
  }, TYPING_REFRESH_MS);

  log.info(
    { userId: message.userId, platform: message.platform, text: message.text },
    'Processing queued message',
  );

  try {
    const replyLogMax = config.logging.replyLogMaxLength;
    await sendToAgent(
      message.userId,
      message.text,
      (msg: SDKMessage) => {
        const text = extractText(msg, pushIntermediate);
        if (text) {
          log.info(
            { userId: message.userId, reply: digestText(text, replyLogMax) },
            'Bot reply',
          );
          Promise.resolve(message.reply(text)).catch((err) => {
            log.error({ err, userId: message.userId }, 'Failed to send reply');
          });
        }
      },
      message.sendFile,
    );
  } catch (err) {
    if (err instanceof AgentInterruptedError) {
      log.info({ userId: message.userId }, 'Agent interrupted by user');
    } else {
      log.error({ err, userId: message.userId }, 'Agent execution failed');
      await Promise.resolve(message.reply('An error occurred while processing your message. Please try again.')).catch(() => {});
    }
  } finally {
    clearInterval(typingInterval);
  }
}

/**
 * 处理指定用户队列中的下一条消息。
 *
 * @param userId - 用户 ID。
 */
async function processNext(userId: string): Promise<void> {
  const queue = queues.get(userId);
  if (!queue || queue.length === 0) {
    processing.delete(userId);
    return;
  }

  processing.add(userId);
  const message = queue.shift()!;

  try {
    await processMessage(message);
  } finally {
    // 递归处理下一条。
    await processNext(userId);
  }
}

/**
 * 将消息加入用户队列。如果当前没有正在处理的消息，立即开始处理。
 *
 * @param message - 要入队的消息。
 */
export function enqueue(message: QueuedMessage): void {
  const log = getLogger();

  if (!queues.has(message.userId)) {
    queues.set(message.userId, []);
  }
  queues.get(message.userId)!.push(message);

  log.debug(
    {
      userId: message.userId,
      queueLength: queues.get(message.userId)!.length,
    },
    'Message enqueued',
  );

  if (!processing.has(message.userId)) {
    processNext(message.userId).catch((err) => {
      log.error({ err, userId: message.userId }, 'Queue processing error');
      processing.delete(message.userId);
    });
  }
}

/**
 * 中断指定用户当前正在执行的 agent 查询。
 *
 * 仅中断当前任务，不影响队列中排队的后续消息。
 *
 * @param userId - 用户 ID。
 */
export async function interrupt(userId: string): Promise<void> {
  const log = getLogger();
  log.info({ userId }, 'Interrupting current agent execution');

  await interruptAgent(userId);
}
