#!/usr/bin/env node

import { resolve } from 'path';
import { createInterface } from 'readline';
import { Command } from 'commander';
import { loadConfig } from './config/index.js';
import { createLogger, getLogger } from './logger/index.js';
import {
  loadBindingCache,
  createUser,
  listUsers,
  getUser,
  bindPlatform,
  deleteUser,
  renameUser,
  setPermissionGroup,
} from './user/manager.js';
import { getWorkGroups, updateWorkGroups } from './config/index.js';
import type { WorkGroupConfig } from './config/index.js';
import type { PlatformType } from './user/types.js';
import { exportData, importData, hasExistingData } from './data/migrate.js';

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
    console.log('\nUse this token to bind platform accounts (e.g. /bind <token> or .bind <token>)');
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
  .requiredOption('-p, --platform <platform>', 'Platform name (telegram, cli, qq, wechat, dingtalk)')
  .requiredOption('-u, --platform-user-id <id>', 'Platform user ID')
  .action((opts: { token: string; platform: string; platformUserId: string }) => {
    initEnv(program.opts().dataDir);
    const validPlatforms = ['telegram', 'cli', 'qq', 'wechat', 'dingtalk'];
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

userCmd
  .command('set-group')
  .description('Set user permission group')
  .argument('<userId>', 'User ID')
  .argument('<group>', 'Permission group name')
  .action((userId: string, group: string) => {
    initEnv(program.opts().dataDir);
    const profile = setPermissionGroup(userId, group);
    if (!profile) {
      console.error(`User not found: ${userId}`);
      process.exit(1);
    }
    console.log(`User ${profile.userId} (${profile.name}) permission group set to "${group}".`);
  });

userCmd
  .command('delete')
  .description('Delete a user and all associated data')
  .argument('<userId>', 'User ID')
  .action(async (userId: string) => {
    initEnv(program.opts().dataDir);
    const user = getUser(userId);
    if (!user) {
      console.error(`User not found: ${userId}`);
      process.exit(1);
    }

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((res) => {
      rl.question(
        `Are you sure? This will delete all data for user ${user.name} (${userId}). [y/N] `,
        res,
      );
    });
    rl.close();
    if (answer.toLowerCase() !== 'y') {
      console.log('Cancelled.');
      return;
    }

    deleteUser(userId);
    console.log(`User ${userId} (${user.name}) deleted.`);
  });

userCmd
  .command('rename')
  .description('Rename a user (change display name)')
  .argument('<userId>', 'User ID')
  .argument('<newName>', 'New display name')
  .action((userId: string, newName: string) => {
    initEnv(program.opts().dataDir);
    const profile = renameUser(userId, newName);
    if (!profile) {
      console.error(`User not found: ${userId}`);
      process.exit(1);
    }
    console.log(`User ${profile.userId} renamed to "${profile.name}".`);
  });

// --- workgroup 子命令组 ---

const workgroupCmd = program.command('workgroup').description('Work group management');

workgroupCmd
  .command('create')
  .description('Create a new work group')
  .argument('<name>', 'Work group name')
  .action((name: string) => {
    initEnv(program.opts().dataDir);
    const workGroups = getWorkGroups();
    if (workGroups[name]) {
      console.error(`Work group already exists: ${name}`);
      process.exit(1);
    }
    workGroups[name] = { members: {} };
    updateWorkGroups(workGroups);
    console.log(`Work group "${name}" created.`);
  });

workgroupCmd
  .command('delete')
  .description('Delete a work group')
  .argument('<name>', 'Work group name')
  .action(async (name: string) => {
    initEnv(program.opts().dataDir);
    const workGroups = getWorkGroups();
    if (!workGroups[name]) {
      console.error(`Work group not found: ${name}`);
      process.exit(1);
    }

    const memberCount = Object.keys(workGroups[name].members).length;
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((res) => {
      rl.question(
        `Are you sure? This will delete work group "${name}" (${memberCount} members) and its workspace. [y/N] `,
        res,
      );
    });
    rl.close();
    if (answer.toLowerCase() !== 'y') {
      console.log('Cancelled.');
      return;
    }

    delete workGroups[name];
    updateWorkGroups(workGroups);

    // 删除工作组的数据目录。
    const { rmSync, existsSync } = await import('fs');
    const { getWorkGroupDir } = await import('./user/store.js');
    const groupDir = getWorkGroupDir(name);
    if (existsSync(groupDir)) {
      rmSync(groupDir, { recursive: true, force: true });
    }

    console.log(`Work group "${name}" deleted.`);
  });

workgroupCmd
  .command('list')
  .description('List all work groups')
  .action(() => {
    initEnv(program.opts().dataDir);
    const workGroups = getWorkGroups();
    const names = Object.keys(workGroups);
    if (names.length === 0) {
      console.log('No work groups found.');
      return;
    }
    for (const name of names) {
      const memberCount = Object.keys(workGroups[name].members).length;
      console.log(`${name}  members=${memberCount}`);
    }
  });

workgroupCmd
  .command('info')
  .description('Show details of a work group')
  .argument('<name>', 'Work group name')
  .action((name: string) => {
    initEnv(program.opts().dataDir);
    const workGroups = getWorkGroups();
    if (!workGroups[name]) {
      console.error(`Work group not found: ${name}`);
      process.exit(1);
    }
    const group = workGroups[name];
    console.log(`Work group: ${name}`);
    const entries = Object.entries(group.members);
    if (entries.length === 0) {
      console.log('  No members.');
    } else {
      console.log('  Members:');
      for (const [userId, access] of entries) {
        console.log(`    ${userId}  access=${access}`);
      }
    }
  });

workgroupCmd
  .command('add-member')
  .description('Add a member to a work group')
  .argument('<name>', 'Work group name')
  .argument('<userId>', 'User ID')
  .option('-a, --access <access>', 'Access level (r or rw)', 'rw')
  .action((name: string, userId: string, opts: { access: string }) => {
    initEnv(program.opts().dataDir);
    const workGroups = getWorkGroups();
    if (!workGroups[name]) {
      console.error(`Work group not found: ${name}`);
      process.exit(1);
    }
    if (opts.access !== 'r' && opts.access !== 'rw') {
      console.error(`Invalid access level: ${opts.access}. Must be "r" or "rw".`);
      process.exit(1);
    }
    const user = getUser(userId);
    if (!user) {
      console.error(`User not found: ${userId}`);
      process.exit(1);
    }
    workGroups[name].members[userId] = opts.access as 'r' | 'rw';
    updateWorkGroups(workGroups);
    console.log(`Added ${userId} (${user.name}) to "${name}" with access=${opts.access}.`);
  });

workgroupCmd
  .command('remove-member')
  .description('Remove a member from a work group')
  .argument('<name>', 'Work group name')
  .argument('<userId>', 'User ID')
  .action((name: string, userId: string) => {
    initEnv(program.opts().dataDir);
    const workGroups = getWorkGroups();
    if (!workGroups[name]) {
      console.error(`Work group not found: ${name}`);
      process.exit(1);
    }
    if (!(userId in workGroups[name].members)) {
      console.error(`User ${userId} is not a member of "${name}".`);
      process.exit(1);
    }
    delete workGroups[name].members[userId];
    updateWorkGroups(workGroups);
    console.log(`Removed ${userId} from "${name}".`);
  });

workgroupCmd
  .command('set-access')
  .description('Set access level for a member in a work group')
  .argument('<name>', 'Work group name')
  .argument('<userId>', 'User ID')
  .argument('<access>', 'Access level (r or rw)')
  .action((name: string, userId: string, access: string) => {
    initEnv(program.opts().dataDir);
    const workGroups = getWorkGroups();
    if (!workGroups[name]) {
      console.error(`Work group not found: ${name}`);
      process.exit(1);
    }
    if (!(userId in workGroups[name].members)) {
      console.error(`User ${userId} is not a member of "${name}".`);
      process.exit(1);
    }
    if (access !== 'r' && access !== 'rw') {
      console.error(`Invalid access level: ${access}. Must be "r" or "rw".`);
      process.exit(1);
    }
    workGroups[name].members[userId] = access as 'r' | 'rw';
    updateWorkGroups(workGroups);
    console.log(`Set access for ${userId} in "${name}" to ${access}.`);
  });

workgroupCmd
  .command('members')
  .description('List members of a work group')
  .argument('<name>', 'Work group name')
  .action((name: string) => {
    initEnv(program.opts().dataDir);
    const workGroups = getWorkGroups();
    if (!workGroups[name]) {
      console.error(`Work group not found: ${name}`);
      process.exit(1);
    }
    const entries = Object.entries(workGroups[name].members);
    if (entries.length === 0) {
      console.log('No members.');
      return;
    }
    for (const [userId, access] of entries) {
      console.log(`${userId}  access=${access}`);
    }
  });

// --- data 子命令组 ---

const dataCmd = program.command('data').description('Data migration (export / import)');

dataCmd
  .command('export')
  .description('Export agent data directory to a zip file')
  .requiredOption('-o, --output <path>', 'Output zip file path')
  .action((opts: { output: string }) => {
    const config = loadConfig({ dataDir: program.opts().dataDir });
    const outputPath = resolve(opts.output);
    try {
      const summary = exportData(config.dataDir, outputPath);
      console.log('Export completed:');
      console.log(`  Users:  ${summary.userCount}`);
      console.log(`  Files:  ${summary.fileCount}`);
      console.log(`  Output: ${summary.outputPath}`);
    } catch (err) {
      console.error(`Export failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

dataCmd
  .command('import')
  .description('Import agent data from a zip file')
  .requiredOption('-i, --input <path>', 'Input zip file path')
  .action(async (opts: { input: string }) => {
    const config = loadConfig({ dataDir: program.opts().dataDir });
    const inputPath = resolve(opts.input);

    // 检查目标目录是否已有数据，提示用户确认覆盖。
    if (hasExistingData(config.dataDir)) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise<string>((res) => {
        rl.question(
          `Target directory "${config.dataDir}" already has user data. Overwrite? [y/N] `,
          res,
        );
      });
      rl.close();
      if (answer.toLowerCase() !== 'y') {
        console.log('Import cancelled.');
        return;
      }
    }

    try {
      const summary = importData(inputPath, config.dataDir);
      console.log('Import completed:');
      console.log(`  Users:   ${summary.userCount}`);
      console.log(`  Files:   ${summary.fileCount}`);
      console.log(`  Config:  ${summary.configImported ? 'imported' : 'not found in zip'}`);
    } catch (err) {
      console.error(`Import failed: ${(err as Error).message}`);
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
              await cliAdapter.sendText(msg.platformUserId, `Usage: ${cliAdapter.commandPrefix}bind <your-token>`);
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
          `I don't recognize you yet. Use ${cliAdapter.commandPrefix}bind <your-token> to link your account.`,
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
