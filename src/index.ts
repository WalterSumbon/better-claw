import { existsSync, mkdirSync, copyFileSync } from 'fs';
import { resolve } from 'path';
import { execSync } from 'child_process';
import { loadConfig, getConfig } from './config/index.js';
import { initClaudeSettings } from './config/claude-settings.js';
import { createLogger, getLogger } from './logger/index.js';
import {
  loadBindingCache,
  bindPlatform,
  createUser,
  getUser,
  matchesWhitelist,
} from './user/manager.js';
import { CLIAdapter } from './adapter/cli/adapter.js';
import { EventBus } from './core/event-bus.js';
import { BusAgentManager } from './core/bus-agent.js';
import { AdapterBridge } from './adapter/adapter-bridge.js';
import { interruptAgent, resetAgentSession } from './core/agent.js';
import {
  rotateSession,
  getCurrentSessionInfo,
  getBgRotation,
} from './core/session-manager.js';
import {
  findPendingRestarts,
  deleteRestartMarker,
  writeRestartMarker,
} from './core/restart-marker.js';
import { initScheduler, stopAllJobs } from './cron/scheduler.js';
import { initSkillIndex } from './skills/scanner.js';
import { handleAdminCommand } from './core/admin-commands.js';
import { startWebhookServer, stopWebhookServer } from './webhook/server.js';
import type { WebhookHandler, WebhookNotifyRequest } from './webhook/types.js';
import type { CronTask } from './cron/types.js';
import { buildHelpText } from './core/commands.js';

// ---- 工具函数 ----

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

  mkdirSync(absDir, { recursive: true });

  const examplePath = resolve(process.cwd(), 'config.example.yaml');
  if (existsSync(examplePath)) {
    copyFileSync(examplePath, configPath);
  }

  return true;
}

/**
 * 检查 Claude Code CLI 是否已安装且可用。
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

// ---- 全局指令注册 ----

/**
 * 注册全局指令到 BusAgentManager。
 *
 * 这些指令在所有用户的 BusAgent 中生效。
 * /stop 和基础 /new 已由 BusAgent 内建；此处覆盖 /new 以支持 session 轮转，
 * 并增加 /restart、/admin、/context、/help。
 */
function registerGlobalCommands(manager: BusAgentManager): void {
  // /new — 覆盖 BusAgent 内建的简单版，增加 session 轮转。
  manager.registerCommand('new', async (userId, _args, reply, payload) => {
    const log = getLogger();
    log.info({ userId, platform: payload.source }, 'New session requested via /new command');
    await interruptAgent(userId);
    const currentInfo = getCurrentSessionInfo(userId);
    try {
      const newSession = await rotateSession(userId, 'manual');
      resetAgentSession(userId);
      const oldInfo = currentInfo
        ? ` Old session archived (${currentInfo.messageCount} messages).`
        : '';
      reply(`🆕 New session started: ${newSession.localId}.${oldInfo}`);
    } catch (err) {
      log.error({ err, userId }, 'Failed to create new session');
      reply('Failed to create new session.');
    }
  });

  // /restart — 重启服务。
  manager.registerCommand('restart', async (userId, _args, reply, payload) => {
    const config = getConfig();
    if (!config.restart.allowUser) {
      reply('Restart via command is disabled.');
      return;
    }
    if (
      config.restart.userWhitelist.length > 0 &&
      !matchesWhitelist(userId, config.restart.userWhitelist)
    ) {
      reply('You are not authorized to restart.');
      return;
    }
    const log = getLogger();
    log.info({ userId, platform: payload.source }, 'Restart requested via /restart command');
    writeRestartMarker(userId, 'command');
    reply('🔄 Restarting...');
    // 延迟退出，确保消息发送完成。外层进程管理器负责重新拉起。
    setTimeout(() => process.kill(process.pid, 'SIGTERM'), 500);
  });

  // /admin — 管理员命令。
  manager.registerCommand('admin', async (userId, args, reply, _payload) => {
    const profile = getUser(userId);
    if (
      !profile ||
      (profile.permissionGroup ?? getConfig().permissions.defaultGroup) !== 'admin'
    ) {
      reply('Permission denied. Admin only.');
      return;
    }
    const result = handleAdminCommand(args);
    reply(result);
  });

  // /context — 显示当前上下文使用情况。
  manager.registerCommand('context', async (userId, _args, reply, _payload) => {
    const sessionInfo = getCurrentSessionInfo(userId);
    if (!sessionInfo) {
      reply('No active session.');
      return;
    }
    const config = getConfig();
    const ctx = sessionInfo.contextTokens;
    const win = sessionInfo.contextWindowTokens;
    const pct = win > 0 ? ((ctx / win) * 100).toFixed(1) : 'N/A';
    const softPct = (config.session.rotationContextRatio * 100).toFixed(0);
    const forcePct = ((config.session.rotationForceRatio ?? 0.7) * 100).toFixed(0);

    const bgRot = getBgRotation(userId);
    let rotationStatus: string;
    if (bgRot) {
      rotationStatus =
        bgRot.state === 'preparing'
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
    reply(lines.join('\n'));
  });

  // /help — 显示可用命令。
  manager.registerCommand('help', async (_userId, _args, reply, _payload) => {
    reply(buildHelpText('/'));
  });
}

// ---- 重启恢复 ----

/**
 * 检查并处理重启后的对话恢复。
 *
 * 扫描所有用户的 restart-pending 标记，通过 EventBus 发射 msg:in
 * 让 agent 在已有的 session 上下文中告知用户重启已完成。
 * source 为 'system'，AdapterBridge 会广播到用户所有已绑定平台。
 */
function handlePostRestart(bus: EventBus): void {
  const log = getLogger();
  const pending = findPendingRestarts();

  if (pending.length === 0) return;

  log.info({ count: pending.length }, 'Found pending restart markers, resuming conversations');

  for (const { userId, marker } of pending) {
    const profile = getUser(userId);
    if (!profile) {
      log.warn({ userId }, 'Post-restart: user not found, deleting marker');
      deleteRestartMarker(userId);
      continue;
    }

    const prompt =
      marker.source === 'mcp_tool'
        ? '服务已重启完成。请基于之前的对话上下文，简要告知用户重启结果（例如代码修改已生效），并继续完成之前未完成的对话。请用简洁的语言回复。'
        : '服务已通过 /restart 命令重启完成。请简要告知用户重启成功。';

    bus.emit('msg:in', { userId, source: 'system', text: prompt });

    deleteRestartMarker(userId);
    log.info({ userId, source: marker.source }, 'Post-restart conversation resumed');
  }
}

// ---- 启动入口 ----

async function main(): Promise<void> {
  // 0. 检查 Claude Code CLI 依赖。
  checkClaudeCodeInstalled();

  // 0.1. 解析 --data-dir 参数。
  const dataDir = parseDataDir();
  const effectiveDataDir = dataDir ?? 'data';

  // 0.2. 确保数据目录就绪。
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

  // 5. 如果没有任何用户，创建默认用户（MVP 便利）。
  const { listUsers } = await import('./user/manager.js');
  const users = listUsers();
  if (users.length === 0) {
    const defaultUser = createUser('default');
    log.info(
      { userId: defaultUser.userId, token: defaultUser.token },
      'Created default user. Use this token to bind your platform account.',
    );
    bindPlatform(defaultUser.token, 'cli', 'cli_user');
    log.info('Default user auto-bound to CLI');
  }

  // ============================================================
  // EventBus 架构核心
  // ============================================================

  // 6. 创建 EventBus 和 BusAgentManager。
  const bus = new EventBus();
  const manager = new BusAgentManager();

  // 7. 注册全局指令（/new、/restart、/admin、/context、/help）。
  registerGlobalCommands(manager);

  // 8. 启动 BusAgentManager（开始监听 msg:in）。
  manager.start(bus);
  log.info('EventBus + BusAgentManager started');

  // 9. 启动适配器（通过 AdapterBridge 接入 EventBus）。
  const bridges: AdapterBridge[] = [];

  // 9.1. CLI 适配器（始终启动）。
  const cliAdapter = new CLIAdapter();
  const cliBridge = new AdapterBridge(cliAdapter, bus);
  bridges.push(cliBridge);
  await cliBridge.start();

  // 9.2. Telegram 适配器。
  if (config.telegram?.botToken) {
    const { TelegramAdapter } = await import('./adapter/telegram/adapter.js');
    const tgAdapter = await TelegramAdapter.create(
      config.telegram.botToken,
      config.telegram.proxy,
      config.telegram.commandPrefix,
    );
    const tgBridge = new AdapterBridge(tgAdapter, bus);
    bridges.push(tgBridge);
    await tgBridge.start();
    log.info('Telegram adapter started');
  }

  // 9.3. 钉钉适配器。
  if (config.dingtalk?.clientId) {
    const { DingtalkAdapter } = await import('./adapter/dingtalk/adapter.js');
    const dtAdapter = await DingtalkAdapter.create(config.dingtalk);
    const dtBridge = new AdapterBridge(dtAdapter, bus);
    bridges.push(dtBridge);
    await dtBridge.start();
    log.info('DingTalk adapter started');
  }

  // 9.4. AgentElegram 适配器。
  if (config.agentelegram) {
    const { AgentelegramAdapter } = await import('./adapter/agentelegram/adapter.js');
    const mgmtUserResolver = () => {
      const allUsers = listUsers();
      return allUsers.length > 0 ? allUsers[0].userId : null;
    };
    const atAdapter = await AgentelegramAdapter.create(config.agentelegram, mgmtUserResolver);
    const atBridge = new AdapterBridge(atAdapter, bus);
    bridges.push(atBridge);
    await atBridge.start();
    log.info('AgentElegram adapter started');
  }

  // 10. 初始化定时任务调度器。
  //     cron 触发通过 bus.emit('msg:in') 入队，source='cron' 触发广播。
  initScheduler((userId: string, task: CronTask) => {
    log.info({ userId, taskId: task.id, description: task.description }, 'Processing cron trigger');

    const cronContext = [
      `[定时任务触发]`,
      `任务ID: ${task.id}`,
      `描述: ${task.description}`,
      `执行时间: ${new Date().toISOString()}`,
      `---`,
      task.prompt,
    ].join('\n');

    bus.emit('msg:in', { userId, source: 'cron', text: cronContext });
  });

  // 11. 启动 Webhook 服务器。
  //     webhook 有 prompt 时走 agent（通过 bus），只有 message 时直接投递。
  if (config.webhook) {
    const webhookHandler: WebhookHandler = {
      async notify(req: WebhookNotifyRequest) {
        const profile = getUser(req.userId);
        if (!profile) {
          throw new Error('User not found');
        }

        if (req.prompt) {
          // 有 prompt，走 agent 处理。
          const contextPrefix = req.data
            ? `[Webhook 数据]\n${JSON.stringify(req.data, null, 2)}\n---\n`
            : '';

          // 指定平台则定向投递（source = platform name），否则广播（source = 'webhook'）。
          const source = req.platform || 'webhook';
          bus.emit('msg:in', {
            userId: req.userId,
            source,
            text: contextPrefix + req.prompt,
          });
        } else if (req.message) {
          // 只有 message，直接投递（不经过 agent）。
          const targetPlatform =
            req.platform || profile.bindings[profile.bindings.length - 1]?.platform;
          if (!targetPlatform) {
            throw new Error('User has no platform bindings');
          }
          bus.emit('msg:out', {
            userId: req.userId,
            target: targetPlatform,
            text: req.message,
          });
        }
      },
    };

    startWebhookServer(config.webhook.port, config.webhook.apiKey, webhookHandler);
  }

  // 12. 重启后自动恢复对话（source='system' 广播到所有平台）。
  handlePostRestart(bus);

  // 13. 优雅关闭。
  const shutdown = async () => {
    log.info('Shutting down...');
    manager.stop();
    stopAllJobs();
    await stopWebhookServer();
    for (const bridge of bridges) {
      await bridge.stop();
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
