import { existsSync, mkdirSync, copyFileSync } from 'fs';
import { resolve } from 'path';
import { loadConfig, getConfig } from './config/index.js';
import { initClaudeSettings } from './config/claude-settings.js';
import { createLogger, getLogger } from './logger/index.js';
import { loadBindingCache, resolveUser, bindPlatform, createUser, getUser, matchesWhitelist } from './user/manager.js';
import { CLIAdapter } from './adapter/cli/adapter.js';
import { enqueue, interrupt } from './core/queue.js';
import { initScheduler, stopAllJobs } from './cron/scheduler.js';
import { resetAgentSession } from './core/agent.js';
import { agentContext } from './core/agent-context.js';
import { rotateSession, getCurrentSessionInfo, getBgRotation } from './core/session-manager.js';
import { findPendingRestarts, deleteRestartMarker, writeRestartMarker } from './core/restart-marker.js';
import type { InboundMessage } from './adapter/types.js';
import type { MessageAdapter } from './adapter/interface.js';
import type { CronTask } from './cron/types.js';
import { initSkillIndex } from './skills/scanner.js';
import { handleAdminCommand } from './core/admin-commands.js';
import { execSync } from 'child_process';
import { startWebhookServer, stopWebhookServer } from './webhook/server.js';
import type { WebhookHandler, WebhookNotifyRequest } from './webhook/types.js';
import { readProfile } from './user/store.js';
import { resolveTimezone, formatLocalTime, getUtcOffset } from './utils/timezone.js';
import { buildHelpText } from './core/commands.js';

/**
 * 从 process.argv 解析 --data-dir 参数。
 *
 * @returns 用户指定的数据目录路径，未指定时返回 undefined。
 */
function parseDataDir(): string | undefined {
  const idx = process.argv.indexOf('--data-dir');
  if (idx === -1 || idx + 1 >= process.argv.length) {
    return undefined;
  }
  return process.argv[idx + 1];
}

/**
 * 确保数据目录就绪。若目录不存在，自动创建并复制 config.example.yaml 作为初始配置。
 *
 * @param dataDir - 数据目录路径。
 * @returns 如果是新创建的目录返回 true，已存在返回 false。
 */
function ensureDataDir(dataDir: string): boolean {
  const absDir = resolve(process.cwd(), dataDir);
  const configPath = resolve(absDir, 'config.yaml');

  if (existsSync(configPath)) {
    return false;
  }

  // 创建目录。
  mkdirSync(absDir, { recursive: true });

  // 复制 config.example.yaml 作为初始配置。
  const examplePath = resolve(process.cwd(), 'config.example.yaml');
  if (existsSync(examplePath)) {
    copyFileSync(examplePath, configPath);
  }

  return true;
}

/** 所有已启动的适配器。 */
const adapters: MessageAdapter[] = [];

/**
 * 每个用户最后活跃的适配器信息。
 *
 * 当用户通过多个平台（Telegram、CLI、AgentBox 等）连接时，
 * bot 的回复会发送给最后一个给 agent 发消息的平台。
 */
const lastActiveAdapter = new Map<string, { adapter: MessageAdapter; platformUserId: string }>();

/**
 * 为用户消息添加信封（平台来源 + 发送时间）。
 *
 * 格式：`[platform | 2026-03-10 09:43 Asia/Shanghai (UTC+8)]\n原始消息`
 *
 * @param text - 原始消息文本。
 * @param platform - 消息来源平台。
 * @param userId - 用户 ID。
 * @returns 带信封的消息文本。
 */
function wrapMessageEnvelope(text: string, platform: string, userId: string): string {
  const config = getConfig();
  if (!config.messageEnvelope.enabled) {
    return text;
  }
  const profile = readProfile(userId);
  const tz = resolveTimezone(profile?.timezone);
  const localTime = formatLocalTime(new Date(), tz);
  const offset = getUtcOffset(tz);
  return `[${platform} | ${localTime} ${tz} (${offset})]\n${text}`;
}

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
          await adapter.sendText(msg.platformUserId, `Usage: ${adapter.commandPrefix}bind <your-token>`);
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
      case 'restart': {
        const userId = resolveUser(msg.platform, msg.platformUserId);
        if (userId) {
          const restartConfig = getConfig().restart;
          if (!restartConfig.allowUser) {
            await adapter.sendText(msg.platformUserId, 'Restart via command is disabled.');
            return;
          }
          if (restartConfig.userWhitelist.length > 0 && !matchesWhitelist(userId, restartConfig.userWhitelist)) {
            await adapter.sendText(msg.platformUserId, 'You are not authorized to restart.');
            return;
          }
          log.info({ userId, platform: msg.platform }, 'Restart requested via /restart command');
          writeRestartMarker(userId, 'command');
          await adapter.sendText(msg.platformUserId, '🔄 Restarting...');
          // 确认该消息已处理，防止 Telegram 重启后重新投递导致无限重启。
          await msg.ack?.();
          // 延迟退出，确保消息发送完成。外层进程管理器负责重新拉起。
          setTimeout(() => process.kill(process.pid, 'SIGTERM'), 500);
        }
        return;
      }
      case 'admin': {
        const userId = resolveUser(msg.platform, msg.platformUserId);
        if (!userId) {
          await adapter.sendText(
            msg.platformUserId,
            `I don't recognize you yet. Use ${adapter.commandPrefix}bind <your-token> to link your account.`,
          );
          return;
        }
        const profile = getUser(userId);
        if (!profile || (profile.permissionGroup ?? getConfig().permissions.defaultGroup) !== 'admin') {
          await adapter.sendText(msg.platformUserId, 'Permission denied. Admin only.');
          return;
        }
        const result = handleAdminCommand(msg.commandArgs?.trim() ?? '');
        await adapter.sendText(msg.platformUserId, result);
        return;
      }
      case 'context': {
        const userId = resolveUser(msg.platform, msg.platformUserId);
        if (userId) {
          const sessionInfo = getCurrentSessionInfo(userId);
          if (!sessionInfo) {
            await adapter.sendText(msg.platformUserId, 'No active session.');
          } else {
            const config = getConfig();
            const ctx = sessionInfo.contextTokens;
            const win = sessionInfo.contextWindowTokens;
            const pct = win > 0 ? (ctx / win * 100).toFixed(1) : 'N/A';
            const softPct = (config.session.rotationContextRatio * 100).toFixed(0);
            const forcePct = ((config.session.rotationForceRatio ?? 0.7) * 100).toFixed(0);

            // Rotation status
            const bgRot = getBgRotation(userId);
            let rotationStatus: string;
            if (bgRot) {
              rotationStatus = bgRot.state === 'preparing'
                ? '🔄 Preparing (generating summary…)'
                : '✅ Ready (will switch on next message)';
            } else {
              const ratio = win > 0 ? ctx / win : 0;
              if (ratio >= (config.session.rotationForceRatio ?? 0.7)) {
                rotationStatus = '🔴 Force threshold reached';
              } else if (ratio >= config.session.rotationContextRatio) {
                rotationStatus = '🟡 Soft threshold reached';
              } else {
                rotationStatus = '⚪ Idle (no rotation pending)';
              }
            }

            const lines = [
              `📊 Context Usage`,
              `Session: ${sessionInfo.localId}`,
              `Tokens: ${ctx.toLocaleString()} / ${win > 0 ? win.toLocaleString() : '?'}`,
              `Usage: ${pct}%`,
              `Thresholds: soft ${softPct}% → hard ${forcePct}%`,
              `Rotation: ${rotationStatus}`,
              `Messages: ${sessionInfo.messageCount}, Turns: ${sessionInfo.totalTurns}`,
              `Notifications: ${config.session.notifyContextEvents ? 'ON' : 'OFF'}`,
            ];
            await adapter.sendText(msg.platformUserId, lines.join('\n'));
          }
        }
        return;
      }
      case 'new': {
        const userId = resolveUser(msg.platform, msg.platformUserId);
        if (userId) {
          log.info({ userId, platform: msg.platform }, 'New session requested via /new command');
          const currentInfo = getCurrentSessionInfo(userId);
          try {
            const newSession = await rotateSession(userId, 'manual');
            resetAgentSession(userId);
            const oldInfo = currentInfo
              ? ` Old session archived (${currentInfo.messageCount} messages).`
              : '';
            await adapter.sendText(
              msg.platformUserId,
              `🆕 New session started: ${newSession.localId}.${oldInfo}`,
            );
          } catch (err) {
            log.error({ err, userId }, 'Failed to create new session');
            await adapter.sendText(msg.platformUserId, 'Failed to create new session.');
          }
        }
        return;
      }
      case 'help': {
        await adapter.sendText(msg.platformUserId, buildHelpText(adapter.commandPrefix));
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
      `I don't recognize you yet. Use ${adapter.commandPrefix}bind <your-token> to link your account.`,
    );
    return;
  }

  // 更新该用户的"最后活跃适配器"。后续 bot 回复会发送到这个平台。
  lastActiveAdapter.set(userId, { adapter, platformUserId: msg.platformUserId });

  // 入队处理（附加消息信封）。
  // reply / sendFile / showTyping 回调动态查询 lastActiveAdapter，
  // 实现"回复发送给最后一个给 agent 发消息的平台"。
  // 通过 onComplete 回调等待处理完成，让 adapter 知道 agent 何时结束。
  return new Promise<void>((resolve) => {
    enqueue({
      userId,
      text: wrapMessageEnvelope(msg.text, msg.platform, userId),
      reply: (text: string) => {
        const active = lastActiveAdapter.get(userId);
        if (active) return active.adapter.sendText(active.platformUserId, text);
        return adapter.sendText(msg.platformUserId, text);
      },
      sendFile: (filePath, options) => {
        const active = lastActiveAdapter.get(userId);
        if (active) return active.adapter.sendFile(active.platformUserId, filePath, options);
        return adapter.sendFile(msg.platformUserId, filePath, options);
      },
      showTyping: () => {
        const active = lastActiveAdapter.get(userId);
        if (active) active.adapter.showTyping(active.platformUserId).catch(() => {});
        else adapter.showTyping(msg.platformUserId).catch(() => {});
      },
      platform: msg.platform,
      onComplete: resolve,
    });
  });
}

/**
 * 处理 cron 任务触发：通过消息队列串行处理，避免并发冲突。
 * 响应会广播到用户所有已绑定平台。
 *
 * @param userId - 用户 ID。
 * @param task - 触发的定时任务。
 */
function handleCronTrigger(userId: string, task: CronTask): void {
  const log = getLogger();
  log.info({ userId, taskId: task.id, description: task.description }, 'Processing cron trigger');

  const profile = getUser(userId);
  if (!profile) {
    log.warn({ userId }, 'Cron trigger: user not found');
    return;
  }

  // 构造广播回调：将回复文本发送到用户所有已绑定平台。
  const broadcastText = async (text: string) => {
    log.info(
      { userId, textLength: text.length, bindingsCount: profile.bindings.length, adaptersCount: adapters.length },
      'broadcastText called for cron task',
    );
    for (const binding of profile.bindings) {
      const adapter = adapters.find((a) => a.platform === binding.platform);
      if (adapter) {
        log.info(
          { platform: binding.platform, platformUserId: binding.platformUserId },
          'Sending cron reply via adapter',
        );
        await adapter.sendText(binding.platformUserId, text).catch((err) => {
          log.error(
            { err, platform: binding.platform, platformUserId: binding.platformUserId },
            'Failed to broadcast cron reply',
          );
        });
      } else {
        log.warn(
          { platform: binding.platform, availableAdapters: adapters.map((a) => a.platform) },
          'No adapter found for platform in cron broadcast',
        );
      }
    }
  };

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

  // 在 prompt 前注入任务元信息，让 agent 知道是哪个定时任务触发的。
  const cronContext = [
    `[定时任务触发]`,
    `任务ID: ${task.id}`,
    `描述: ${task.description}`,
    `执行时间: ${new Date().toISOString()}`,
    `---`,
    task.prompt,
  ].join('\n');

  // 通过队列串行处理，与用户消息共享同一队列，避免并发 agent 调用。
  enqueue({
    userId,
    text: cronContext,
    reply: broadcastText,
    sendFile: broadcastFile,
    showTyping: () => {}, // cron 任务不需要 typing 状态。
    platform: 'cron',
  });
}

/**
 * 检查并处理重启后的对话恢复。
 *
 * 扫描所有用户的 restart-pending 标记，对有标记的用户自动入队一条
 * 合成消息，让 agent 在已有的 session 上下文中告知用户重启已完成。
 */
function handlePostRestart(): void {
  const log = getLogger();
  const pending = findPendingRestarts();

  if (pending.length === 0) {
    return;
  }

  log.info({ count: pending.length }, 'Found pending restart markers, resuming conversations');

  for (const { userId, marker } of pending) {
    const profile = getUser(userId);
    if (!profile) {
      log.warn({ userId }, 'Post-restart: user not found, deleting marker');
      deleteRestartMarker(userId);
      continue;
    }

    // 构造广播回调（与 cron 触发相同逻辑）。
    const broadcastText = async (text: string) => {
      for (const binding of profile.bindings) {
        const adapter = adapters.find((a) => a.platform === binding.platform);
        if (adapter) {
          await adapter.sendText(binding.platformUserId, text).catch((err) => {
            log.error(
              { err, platform: binding.platform, platformUserId: binding.platformUserId },
              'Failed to broadcast post-restart reply',
            );
          });
        }
      }
    };

    const broadcastFile = async (filePath: string, options?: Parameters<MessageAdapter['sendFile']>[2]) => {
      for (const binding of profile.bindings) {
        const adapter = adapters.find((a) => a.platform === binding.platform);
        if (adapter) {
          await adapter.sendFile(binding.platformUserId, filePath, options).catch((err) => {
            log.error(
              { err, platform: binding.platform, platformUserId: binding.platformUserId },
              'Failed to broadcast post-restart file',
            );
          });
        }
      }
    };

    // 根据触发来源生成不同的合成 prompt。
    const prompt = marker.source === 'mcp_tool'
      ? '服务已重启完成。请基于之前的对话上下文，简要告知用户重启结果（例如代码修改已生效），并继续完成之前未完成的对话。请用简洁的语言回复。'
      : '服务已通过 /restart 命令重启完成。请简要告知用户重启成功。';

    enqueue({
      userId,
      text: prompt,
      reply: broadcastText,
      sendFile: broadcastFile,
      showTyping: () => {},
      platform: 'system',
    });

    // 删除标记，避免重复触发。
    deleteRestartMarker(userId);
    log.info({ userId, source: marker.source }, 'Post-restart conversation resumed');
  }
}

/**
 * 启动应用。
 */
/**
 * 检查 Claude Code CLI 是否已安装且可用。
 *
 * Better-Claw 基于 Claude Agent SDK，依赖 Claude Code CLI。
 * 若未安装，提前给出明确的错误提示并退出。
 */
function checkClaudeCodeInstalled(): void {
  try {
    const version = execSync('claude --version 2>&1', { encoding: 'utf-8' }).trim();
    if (!version.includes('Claude Code')) {
      console.error('[Better-Claw] Error: "claude" command found but does not appear to be Claude Code.');
      console.error(`  Detected version string: ${version}`);
      console.error('  Install Claude Code: curl -fsSL https://claude.ai/install.sh | bash');
      console.error('  Setup guide: https://code.claude.com/docs/en/setup');
      process.exit(1);
    }
  } catch {
    console.error('[Better-Claw] Error: Claude Code CLI ("claude") is not installed or not in PATH.');
    console.error('  Better-Claw requires Claude Code to run.');
    console.error('  Install: curl -fsSL https://claude.ai/install.sh | bash');
    console.error('  Setup guide: https://code.claude.com/docs/en/setup');
    process.exit(1);
  }
}

async function main(): Promise<void> {
  // 0. 检查 Claude Code CLI 依赖。
  checkClaudeCodeInstalled();

  // 0.1. 解析 --data-dir 参数。
  const dataDir = parseDataDir();
  const effectiveDataDir = dataDir ?? 'data';

  // 0.2 确保数据目录就绪。
  const isNew = ensureDataDir(effectiveDataDir);
  if (isNew) {
    const absDir = resolve(process.cwd(), effectiveDataDir);
    console.log(`[Better-Claw] Initialized new data directory: ${absDir}`);
    console.log(`[Better-Claw] Please edit ${absDir}/config.yaml and restart.`);
    process.exit(0);
  }

  // 1. 加载配置。
  const config = loadConfig({ dataDir });

  // 2. 初始化日志。
  createLogger(config.logging);
  const log = getLogger();
  log.info('Better-Claw starting...');

  // 3. 加载 Claude Code settings（选择性继承 mcpServers / disallowedTools）。
  initClaudeSettings();

  // 3.5. 构建 skill/skillset 索引。
  initSkillIndex(config.skills.paths);

  // 4. 加载用户绑定缓存。
  loadBindingCache();
  log.info('User binding cache loaded');

  // 5. 如果没有任何用户，创建一个默认用户（MVP 便利）。
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

  // 6. 启动 CLI 适配器。
  const cliAdapter = new CLIAdapter();
  adapters.push(cliAdapter);
  await cliAdapter.start((msg) => handleMessage(msg, cliAdapter));

  // 7. 启动 Telegram 适配器（如果配置了 botToken）。
  if (config.telegram?.botToken) {
    const { TelegramAdapter } = await import('./adapter/telegram/adapter.js');
    const tgAdapter = await TelegramAdapter.create(config.telegram.botToken, config.telegram.proxy, config.telegram.commandPrefix);
    adapters.push(tgAdapter);
    await tgAdapter.start((msg) => handleMessage(msg, tgAdapter));
    log.info('Telegram adapter started');
  }

  // 8. 启动钉钉适配器（如果配置了 clientId）。
  if (config.dingtalk?.clientId) {
    const { DingtalkAdapter } = await import('./adapter/dingtalk/adapter.js');
    const dtAdapter = await DingtalkAdapter.create(config.dingtalk);
    adapters.push(dtAdapter);
    await dtAdapter.start((msg) => handleMessage(msg, dtAdapter));
    log.info('DingTalk adapter started');
  }

  // 8.5. 启动 AgentBox 适配器（如果配置了 serverUrl）。
  if (config.agentbox) {
    const { AgentBoxAdapter } = await import('./adapter/agentbox/adapter.js');
    const abAdapter = await AgentBoxAdapter.create(config.agentbox);
    adapters.push(abAdapter);
    await abAdapter.start((msg) => handleMessage(msg, abAdapter));
    log.info('AgentBox adapter started');
  }

  // 8.6. 启动 AgentElegram 适配器（如果配置了 apiKey）。
  if (config.agentelegram) {
    const { AgentelegramAdapter } = await import('./adapter/agentelegram/adapter.js');
    // 管理协议需要一个用户 ID 来读写 memory/cron 等。
    // 使用第一个用户作为默认管理用户。
    const mgmtUserResolver = () => {
      const allUsers = listUsers();
      return allUsers.length > 0 ? allUsers[0].userId : null;
    };
    const atAdapter = await AgentelegramAdapter.create(config.agentelegram, mgmtUserResolver);
    adapters.push(atAdapter);
    await atAdapter.start((msg) => handleMessage(msg, atAdapter));
    log.info('AgentElegram adapter started');
  }

  // 9. 初始化定时任务调度器。
  initScheduler((userId: string, task: CronTask) => {
    handleCronTrigger(userId, task);
  });

  // 10. 启动 Webhook 服务器（如果配置了）。
  if (config.webhook) {
    const webhookHandler: WebhookHandler = {
      async notify(req: WebhookNotifyRequest) {
        const profile = getUser(req.userId);
        if (!profile) {
          throw new Error('User not found');
        }

        // 确定目标平台：指定的 > 最后绑定的。
        const targetPlatform = req.platform || profile.bindings[profile.bindings.length - 1]?.platform;
        if (!targetPlatform) {
          throw new Error('User has no platform bindings');
        }

        const binding = profile.bindings.find((b) => b.platform === targetPlatform);
        if (!binding) {
          throw new Error(`User not bound to platform: ${targetPlatform}`);
        }

        const adapter = adapters.find((a) => a.platform === targetPlatform);
        if (!adapter) {
          throw new Error(`Platform adapter not available: ${targetPlatform}`);
        }

        if (req.prompt) {
          // 有 prompt，走 agent 处理。
          const contextPrefix = req.data
            ? `[Webhook 数据]\n${JSON.stringify(req.data, null, 2)}\n---\n`
            : '';
          enqueue({
            userId: req.userId,
            text: contextPrefix + req.prompt,
            reply: (text: string) => adapter.sendText(binding.platformUserId, text),
            sendFile: (filePath, options) => adapter.sendFile(binding.platformUserId, filePath, options),
            showTyping: () => {
              adapter.showTyping(binding.platformUserId).catch(() => {});
            },
            platform: 'webhook',
          });
        } else if (req.message) {
          // 只有 message，直接发送（不经过 agent）。
          await adapter.sendText(binding.platformUserId, req.message);
        }
      },
    };

    startWebhookServer(config.webhook.port, config.webhook.apiKey, webhookHandler);
  }

  // 11. 重启后自动恢复对话。
  handlePostRestart();

  // 12. 优雅关闭。
  const shutdown = async () => {
    log.info('Shutting down...');
    stopAllJobs();
    await stopWebhookServer();
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
