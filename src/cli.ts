#!/usr/bin/env node

import { Command } from 'commander';
import { loadConfig } from './config/index.js';
import { createLogger, getLogger } from './logger/index.js';
import {
  loadBindingCache,
  createUser,
  listUsers,
  getUser,
  bindPlatform,
} from './user/manager.js';
import type { PlatformType } from './user/types.js';

/**
 * 初始化运行环境（配置 + 日志 + 绑定缓存）。
 *
 * @param dataDir - CLI 指定的数据目录，优先于 yaml 配置。
 */
function initEnv(dataDir?: string): void {
  const config = loadConfig({ dataDir });
  createLogger(config.logging);
  loadBindingCache();
}

const program = new Command();

program
  .name('better-claw')
  .description('Better-Claw CLI management tool')
  .version('0.1.0')
  .option('-d, --data-dir <path>', 'Data directory path (agent instance root)');

// --- user 子命令组 ---

const userCmd = program.command('user').description('User management');

userCmd
  .command('create')
  .description('Create a new user')
  .requiredOption('-n, --name <name>', 'Display name for the user')
  .action((opts: { name: string }) => {
    initEnv(program.opts().dataDir);
    const profile = createUser(opts.name);
    console.log('User created:');
    console.log(`  ID:    ${profile.userId}`);
    console.log(`  Name:  ${profile.name}`);
    console.log(`  Token: ${profile.token}`);
    console.log('\nUse this token to bind platform accounts via /bind <token>');
  });

userCmd
  .command('list')
  .description('List all users')
  .action(() => {
    initEnv(program.opts().dataDir);
    const users = listUsers();
    if (users.length === 0) {
      console.log('No users found.');
      return;
    }
    for (const user of users) {
      const platforms = user.bindings.map((b) => `${b.platform}:${b.platformUserId}`).join(', ');
      console.log(`${user.userId}  ${user.name}  token=${user.token}  bindings=[${platforms}]`);
    }
  });

userCmd
  .command('info')
  .description('Show details of a user')
  .argument('<userId>', 'User ID')
  .action((userId: string) => {
    initEnv(program.opts().dataDir);
    const user = getUser(userId);
    if (!user) {
      console.error(`User not found: ${userId}`);
      process.exit(1);
    }
    console.log(JSON.stringify(user, null, 2));
  });

userCmd
  .command('bind')
  .description('Bind a platform account to a user')
  .requiredOption('-t, --token <token>', 'User secret token')
  .requiredOption('-p, --platform <platform>', 'Platform name (telegram, cli, qq, wechat)')
  .requiredOption('-u, --platform-user-id <id>', 'Platform user ID')
  .action((opts: { token: string; platform: string; platformUserId: string }) => {
    initEnv(program.opts().dataDir);
    const validPlatforms = ['telegram', 'cli', 'qq', 'wechat'];
    if (!validPlatforms.includes(opts.platform)) {
      console.error(`Invalid platform: ${opts.platform}. Must be one of: ${validPlatforms.join(', ')}`);
      process.exit(1);
    }
    const profile = bindPlatform(opts.token, opts.platform as PlatformType, opts.platformUserId);
    if (profile) {
      console.log(`Bound ${opts.platform}:${opts.platformUserId} to user ${profile.userId} (${profile.name})`);
    } else {
      console.error('Invalid token.');
      process.exit(1);
    }
  });

// --- chat 子命令 ---

program
  .command('chat')
  .description('Start interactive CLI chat session')
  .action(async () => {
    // 复用 index.ts 的启动流程。
    const config = loadConfig({ dataDir: program.opts().dataDir });
    createLogger(config.logging);
    const log = getLogger();
    log.info('Better-Claw CLI chat starting...');

    loadBindingCache();

    // 确保有默认用户。
    const users = listUsers();
    if (users.length === 0) {
      const defaultUser = createUser('default');
      log.info(
        { userId: defaultUser.userId, token: defaultUser.token },
        'Created default user',
      );
      bindPlatform(defaultUser.token, 'cli', 'cli_user');
    }

    const { CLIAdapter } = await import('./adapter/cli/adapter.js');
    const { enqueue, interrupt } = await import('./core/queue.js');
    const { resolveUser } = await import('./user/manager.js');

    const cliAdapter = new CLIAdapter();

    await cliAdapter.start(async (msg) => {
      // 命令处理。
      if (msg.isCommand) {
        switch (msg.commandName) {
          case 'bind': {
            const token = msg.commandArgs?.trim();
            if (!token) {
              await cliAdapter.sendText(msg.platformUserId, 'Usage: /bind <your-token>');
              return;
            }
            const profile = bindPlatform(token, msg.platform as PlatformType, msg.platformUserId);
            if (profile) {
              await cliAdapter.sendText(
                msg.platformUserId,
                `Bound successfully! Welcome, ${profile.name}.`,
              );
            } else {
              await cliAdapter.sendText(msg.platformUserId, 'Invalid token.');
            }
            return;
          }
          case 'stop': {
            const userId = resolveUser(msg.platform, msg.platformUserId);
            if (userId) {
              await interrupt(userId);
              await cliAdapter.sendText(msg.platformUserId, 'Interrupted.');
            }
            return;
          }
          default:
            break;
        }
      }

      const userId = resolveUser(msg.platform, msg.platformUserId);
      if (!userId) {
        await cliAdapter.sendText(
          msg.platformUserId,
          "I don't recognize you yet. Use /bind <your-token> to link your account.",
        );
        return;
      }

      enqueue({
        userId,
        text: msg.text,
        reply: (text: string) => cliAdapter.sendText(msg.platformUserId, text),
        sendFile: (filePath, options) => cliAdapter.sendFile(msg.platformUserId, filePath, options),
        showTyping: () => {
          cliAdapter.showTyping(msg.platformUserId).catch(() => {});
        },
        platform: msg.platform,
      });
    });

    process.on('SIGINT', async () => {
      log.info('Shutting down...');
      await cliAdapter.stop();
      process.exit(0);
    });
    process.on('SIGTERM', async () => {
      log.info('Shutting down...');
      await cliAdapter.stop();
      process.exit(0);
    });
  });

program.parse();
