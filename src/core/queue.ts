import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { getLogger } from '../logger/index.js';
import { getConfig } from '../config/index.js';
import type { SendFileOptions } from '../adapter/interface.js';
import { sendToAgent, interruptAgent, AgentInterruptedError, RateLimitError } from './agent.js';

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

/** 每用户的队列暂停截止时间（Unix 毫秒时间戳）。 */
const pausedUntil = new Map<string, number>();

/** 每用户的恢复定时器，用于清理。 */
const resumeTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Rate limit 时无 resetsAt 信息的默认等待时间（毫秒）。 */
const DEFAULT_RATE_LIMIT_WAIT_MS = 5 * 60 * 1000;

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

/**
 * 格式化 rate limit 恢复时间为用户友好的字符串。
 *
 * @param resetsAt - Unix 毫秒时间戳。
 * @returns 格式化的时间字符串（如 "14:30"）。
 */
function formatResetTime(resetsAt: number): string {
  const date = new Date(resetsAt);
  return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

/**
 * 暂停用户队列并设置自动恢复定时器。
 *
 * @param userId - 用户 ID。
 * @param resumeAt - 恢复时间（Unix 毫秒时间戳）。
 * @param replyFn - 向用户发送通知的回调。
 */
function pauseAndScheduleResume(
  userId: string,
  resumeAt: number,
  replyFn: (text: string) => Promise<void>,
): void {
  const log = getLogger();

  pausedUntil.set(userId, resumeAt);

  // 清理已有的恢复定时器。
  const existingTimer = resumeTimers.get(userId);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  const delayMs = Math.max(resumeAt - Date.now(), 1000);
  log.info({ userId, resumeAt, delayMs }, 'Queue paused due to rate limit');

  const timer = setTimeout(() => {
    resumeTimers.delete(userId);
    pausedUntil.delete(userId);
    log.info({ userId }, 'Rate limit wait expired, resuming queue');

    Promise.resolve(replyFn('Rate limit has been lifted. Resuming your message...')).catch(() => {});

    // 恢复队列处理。
    processNext(userId).catch((err) => {
      log.error({ err, userId }, 'Queue processing error after rate limit resume');
      processing.delete(userId);
    });
  }, delayMs);

  resumeTimers.set(userId, timer);
}

/** Typing 状态刷新间隔（毫秒）。Telegram 的 typing 状态约 5 秒过期。 */
const TYPING_REFRESH_MS = 4000;

/**
 * 处理单条消息：发送给 agent 并流式推送响应。
 *
 * @param message - 队列中的消息。
 * @returns 是否因 rate limit 而暂停（true 表示消息已放回队列，调用方不应继续处理）。
 */
async function processMessage(message: QueuedMessage): Promise<boolean> {
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
    return false;
  } catch (err) {
    if (err instanceof AgentInterruptedError) {
      log.info({ userId: message.userId }, 'Agent interrupted by user');
      return false;
    }
    if (err instanceof RateLimitError) {
      log.warn(
        { userId: message.userId, resetsAt: err.resetsAt },
        'Rate limit hit, pausing queue',
      );

      // 将消息放回队列头部。
      const queue = queues.get(message.userId);
      if (queue) {
        queue.unshift(message);
      } else {
        queues.set(message.userId, [message]);
      }

      // 计算恢复时间并通知用户。
      const resumeAt = err.resetsAt ?? (Date.now() + DEFAULT_RATE_LIMIT_WAIT_MS);
      if (err.resetsAt) {
        const resetTimeStr = formatResetTime(err.resetsAt);
        await Promise.resolve(
          message.reply(`Rate limit reached. Expected to recover at ${resetTimeStr}. Your message has been saved and will be processed automatically.`),
        ).catch(() => {});
      } else {
        const waitMinutes = Math.ceil(DEFAULT_RATE_LIMIT_WAIT_MS / 60000);
        await Promise.resolve(
          message.reply(`Rate limit reached. Will retry automatically in ${waitMinutes} minutes. Your message has been saved.`),
        ).catch(() => {});
      }

      pauseAndScheduleResume(message.userId, resumeAt, message.reply);
      return true;
    }
    log.error({ err, userId: message.userId }, 'Agent execution failed');
    await Promise.resolve(message.reply('An error occurred while processing your message. Please try again.')).catch(() => {});
    return false;
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

  // 如果队列因 rate limit 暂停，跳过处理（定时器到期后会自动恢复）。
  const pauseDeadline = pausedUntil.get(userId);
  if (pauseDeadline && Date.now() < pauseDeadline) {
    processing.delete(userId);
    return;
  }
  pausedUntil.delete(userId);

  processing.add(userId);
  const message = queue.shift()!;

  try {
    const rateLimited = await processMessage(message);
    if (rateLimited) {
      // 消息已放回队列，队列已暂停，不继续处理。
      processing.delete(userId);
      return;
    }
  } finally {
    // 递归处理下一条（仅在非 rate limit 暂停时）。
    if (!pausedUntil.has(userId)) {
      await processNext(userId);
    }
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
