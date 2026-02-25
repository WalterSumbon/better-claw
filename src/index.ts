import { loadConfig } from './config/index.js';
import { createLogger, getLogger } from './logger/index.js';
import { loadBindingCache, resolveUser, bindPlatform, createUser, getUser } from './user/manager.js';
import { CLIAdapter } from './adapter/cli/adapter.js';
import { enqueue, interrupt } from './core/queue.js';
import { initScheduler, stopAllJobs } from './cron/scheduler.js';
import { sendToAgent } from './core/agent.js';
import { agentContext } from './core/agent-context.js';
import type { InboundMessage } from './adapter/types.js';
import type { MessageAdapter } from './adapter/interface.js';
import type { CronTask } from './cron/types.js';

/** 所有已启动的适配器。 */
const adapters: MessageAdapter[] = [];

/**
 * 处理入站消息的统一路由。
 *
 * @param msg - 入站消息。
 * @param adapter - 消息来源的适配器。
 */
async function handleMessage(
  msg: InboundMessage,
  adapter: MessageAdapter,
): Promise<void> {
  const log = getLogger();

  // 处理命令。
  if (msg.isCommand) {
    switch (msg.commandName) {
      case 'bind': {
        const token = msg.commandArgs?.trim();
        if (!token) {
          await adapter.sendText(msg.platformUserId, 'Usage: /bind <your-token>');
          return;
        }
        const profile = bindPlatform(token, msg.platform, msg.platformUserId);
        if (profile) {
          log.info(
            { userId: profile.userId, platform: msg.platform },
            'Platform bound',
          );
          await adapter.sendText(
            msg.platformUserId,
            `Bound successfully! Welcome, ${profile.name}.`,
          );
        } else {
          await adapter.sendText(msg.platformUserId, 'Invalid token.');
        }
        return;
      }
      case 'stop': {
        const userId = resolveUser(msg.platform, msg.platformUserId);
        if (userId) {
          await interrupt(userId);
          await adapter.sendText(msg.platformUserId, 'Interrupted.');
        }
        return;
      }
      default:
        // 未知命令作为普通消息处理。
        break;
    }
  }

  // 解析用户。
  const userId = resolveUser(msg.platform, msg.platformUserId);
  if (!userId) {
    await adapter.sendText(
      msg.platformUserId,
      "I don't recognize you yet. Use /bind <your-token> to link your account.",
    );
    return;
  }

  // 入队处理。
  enqueue({
    userId,
    text: msg.text,
    reply: (text: string) => adapter.sendText(msg.platformUserId, text),
    sendFile: (filePath, options) => adapter.sendFile(msg.platformUserId, filePath, options),
    showTyping: () => {
      adapter.showTyping(msg.platformUserId).catch(() => {});
    },
    platform: msg.platform,
  });
}

/**
 * 处理 cron 任务触发：发送 prompt 给 agent，将响应广播到用户所有已绑定平台。
 *
 * @param userId - 用户 ID。
 * @param task - 触发的定时任务。
 */
async function handleCronTrigger(userId: string, task: CronTask): Promise<void> {
  const log = getLogger();
  log.info({ userId, taskId: task.id, description: task.description }, 'Processing cron trigger');

  const profile = getUser(userId);
  if (!profile) {
    log.warn({ userId }, 'Cron trigger: user not found');
    return;
  }

  // 构造广播文件发送回调。
  const broadcastFile = async (filePath: string, options?: Parameters<MessageAdapter['sendFile']>[2]) => {
    for (const binding of profile.bindings) {
      const adapter = adapters.find((a) => a.platform === binding.platform);
      if (adapter) {
        await adapter.sendFile(binding.platformUserId, filePath, options).catch((err) => {
          log.error(
            { err, platform: binding.platform, platformUserId: binding.platformUserId },
            'Failed to broadcast cron file',
          );
        });
      }
    }
  };

  // 收集 agent 的最终回复文本。
  let replyText = '';

  try {
    const result = await sendToAgent(
      userId,
      task.prompt,
      (msg) => {
        if (msg.type === 'result' && 'result' in msg && typeof msg.result === 'string') {
          replyText = msg.result;
        }
      },
      broadcastFile,
    );

    // 如果 onMessage 没有捕获到 result 文本，从 result message 取。
    if (!replyText && result.subtype === 'success' && typeof result.result === 'string') {
      replyText = result.result;
    }
  } catch (err) {
    log.error({ err, userId, taskId: task.id }, 'Cron agent execution failed');
    replyText = `[Scheduled task "${task.description}" failed]`;
  }

  if (!replyText) {
    return;
  }

  // 广播到用户所有已绑定平台。
  for (const binding of profile.bindings) {
    const adapter = adapters.find((a) => a.platform === binding.platform);
    if (adapter) {
      adapter.sendText(binding.platformUserId, replyText).catch((err) => {
        log.error(
          { err, platform: binding.platform, platformUserId: binding.platformUserId },
          'Failed to broadcast cron reply',
        );
      });
    }
  }
}

/**
 * 启动应用。
 */
async function main(): Promise<void> {
  // 1. 加载配置。
  const config = loadConfig();

  // 2. 初始化日志。
  createLogger(config.logging);
  const log = getLogger();
  log.info('Better-Claw starting...');

  // 3. 加载用户绑定缓存。
  loadBindingCache();
  log.info('User binding cache loaded');

  // 4. 如果没有任何用户，创建一个默认用户（MVP 便利）。
  const { listUsers } = await import('./user/manager.js');
  const users = listUsers();
  if (users.length === 0) {
    const defaultUser = createUser('default');
    log.info(
      { userId: defaultUser.userId, token: defaultUser.token },
      'Created default user. Use this token to bind your platform account.',
    );
    // CLI 用户自动绑定。
    bindPlatform(defaultUser.token, 'cli', 'cli_user');
    log.info('Default user auto-bound to CLI');
  }

  // 5. 启动 CLI 适配器。
  const cliAdapter = new CLIAdapter();
  adapters.push(cliAdapter);
  await cliAdapter.start((msg) => handleMessage(msg, cliAdapter));

  // 6. 启动 Telegram 适配器（如果配置了 botToken）。
  if (config.telegram?.botToken) {
    const { TelegramAdapter } = await import('./adapter/telegram/adapter.js');
    const tgAdapter = await TelegramAdapter.create(config.telegram.botToken, config.telegram.proxy);
    adapters.push(tgAdapter);
    await tgAdapter.start((msg) => handleMessage(msg, tgAdapter));
    log.info('Telegram adapter started');
  }

  // 7. 初始化定时任务调度器。
  initScheduler((userId: string, task: CronTask) => {
    handleCronTrigger(userId, task).catch((err) => {
      log.error({ err, userId, taskId: task.id }, 'Cron trigger handler error');
    });
  });
  log.info('Cron scheduler initialized');

  // 8. 优雅关闭。
  const shutdown = async () => {
    log.info('Shutting down...');
    stopAllJobs();
    for (const adapter of adapters) {
      await adapter.stop();
    }
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
