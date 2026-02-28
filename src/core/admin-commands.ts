import { rmSync, existsSync } from 'fs';
import {
  createUser,
  listUsers,
  getUser,
  deleteUser,
  renameUser,
  setPermissionGroup,
  bindPlatform,
} from '../user/manager.js';
import { getWorkGroups, updateWorkGroups, reloadConfig } from '../config/index.js';
import { getWorkGroupDir } from '../user/store.js';
import type { PlatformType } from '../user/types.js';

/** 支持的平台名称列表。 */
const VALID_PLATFORMS = ['telegram', 'cli', 'qq', 'wechat', 'dingtalk'];

/**
 * 从 token 数组中提取 -flag value 形式的选项值。
 * 匹配到的 flag 及其 value 会从 tokens 中原地移除。
 *
 * @param tokens - 待解析的 token 数组（会被修改）。
 * @param flags - 要提取的 flag 列表，如 ['-n', '-t']。
 * @returns flag 到 value 的映射。
 */
function parseFlags(
  tokens: string[],
  flags: string[],
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const flag of flags) {
    const idx = tokens.indexOf(flag);
    if (idx !== -1 && idx + 1 < tokens.length) {
      result[flag] = tokens[idx + 1];
      tokens.splice(idx, 2);
    }
  }
  return result;
}

/**
 * 处理 /admin user 子命令。
 *
 * @param sub - 子命令名称。
 * @param tokens - 剩余参数 token 数组。
 * @returns 执行结果文本。
 */
function handleUserCommand(sub: string, tokens: string[]): string {
  switch (sub) {
    case 'create': {
      const flags = parseFlags(tokens, ['-n']);
      const name = flags['-n'];
      if (!name) {
        return 'Usage: user create -n <name>';
      }
      const profile = createUser(name);
      return [
        'User created:',
        `  ID:    ${profile.userId}`,
        `  Name:  ${profile.name}`,
        `  Token: ${profile.token}`,
      ].join('\n');
    }

    case 'list': {
      const users = listUsers();
      if (users.length === 0) {
        return 'No users found.';
      }
      return users
        .map((u) => {
          const platforms = u.bindings
            .map((b) => `${b.platform}:${b.platformUserId}`)
            .join(', ');
          return `${u.userId}  ${u.name}  token=${u.token}  bindings=[${platforms}]`;
        })
        .join('\n');
    }

    case 'info': {
      const userId = tokens[0];
      if (!userId) {
        return 'Usage: user info <userId>';
      }
      const user = getUser(userId);
      if (!user) {
        return `User not found: ${userId}`;
      }
      return JSON.stringify(user, null, 2);
    }

    case 'rename': {
      const userId = tokens[0];
      const newName = tokens[1];
      if (!userId || !newName) {
        return 'Usage: user rename <userId> <newName>';
      }
      const profile = renameUser(userId, newName);
      if (!profile) {
        return `User not found: ${userId}`;
      }
      return `User ${profile.userId} renamed to "${profile.name}".`;
    }

    case 'set-group': {
      const userId = tokens[0];
      const group = tokens[1];
      if (!userId || !group) {
        return 'Usage: user set-group <userId> <group>';
      }
      const profile = setPermissionGroup(userId, group);
      if (!profile) {
        return `User not found: ${userId}`;
      }
      return `User ${profile.userId} (${profile.name}) permission group set to "${group}".`;
    }

    case 'delete': {
      const userId = tokens[0];
      if (!userId) {
        return 'Usage: user delete <userId>';
      }
      const user = getUser(userId);
      if (!user) {
        return `User not found: ${userId}`;
      }
      deleteUser(userId);
      return `User ${userId} (${user.name}) deleted.`;
    }

    case 'bind': {
      const flags = parseFlags(tokens, ['-t', '-p', '-u']);
      const token = flags['-t'];
      const platform = flags['-p'];
      const platformUserId = flags['-u'];
      if (!token || !platform || !platformUserId) {
        return 'Usage: user bind -t <token> -p <platform> -u <platformUserId>';
      }
      if (!VALID_PLATFORMS.includes(platform)) {
        return `Invalid platform: ${platform}. Must be one of: ${VALID_PLATFORMS.join(', ')}`;
      }
      const profile = bindPlatform(
        token,
        platform as PlatformType,
        platformUserId,
      );
      if (!profile) {
        return 'Invalid token.';
      }
      return `Bound ${platform}:${platformUserId} to user ${profile.userId} (${profile.name}).`;
    }

    default:
      return `Unknown user subcommand: ${sub}\nAvailable: create, list, info, rename, set-group, delete, bind`;
  }
}

/**
 * 处理 /admin workgroup 子命令。
 *
 * @param sub - 子命令名称。
 * @param tokens - 剩余参数 token 数组。
 * @returns 执行结果文本。
 */
function handleWorkgroupCommand(sub: string, tokens: string[]): string {
  switch (sub) {
    case 'create': {
      const name = tokens[0];
      if (!name) {
        return 'Usage: workgroup create <name>';
      }
      const workGroups = getWorkGroups();
      if (workGroups[name]) {
        return `Work group already exists: ${name}`;
      }
      workGroups[name] = { members: {} };
      updateWorkGroups(workGroups);
      return `Work group "${name}" created.`;
    }

    case 'delete': {
      const name = tokens[0];
      if (!name) {
        return 'Usage: workgroup delete <name>';
      }
      const workGroups = getWorkGroups();
      if (!workGroups[name]) {
        return `Work group not found: ${name}`;
      }
      delete workGroups[name];
      updateWorkGroups(workGroups);

      // 删除工作组的数据目录。
      const groupDir = getWorkGroupDir(name);
      if (existsSync(groupDir)) {
        rmSync(groupDir, { recursive: true, force: true });
      }

      return `Work group "${name}" deleted.`;
    }

    case 'list': {
      const workGroups = getWorkGroups();
      const names = Object.keys(workGroups);
      if (names.length === 0) {
        return 'No work groups found.';
      }
      return names
        .map((n) => {
          const memberCount = Object.keys(workGroups[n].members).length;
          return `${n}  members=${memberCount}`;
        })
        .join('\n');
    }

    case 'info': {
      const name = tokens[0];
      if (!name) {
        return 'Usage: workgroup info <name>';
      }
      const workGroups = getWorkGroups();
      if (!workGroups[name]) {
        return `Work group not found: ${name}`;
      }
      const group = workGroups[name];
      const entries = Object.entries(group.members);
      const lines = [`Work group: ${name}`];
      if (entries.length === 0) {
        lines.push('  No members.');
      } else {
        lines.push('  Members:');
        for (const [userId, access] of entries) {
          lines.push(`    ${userId}  access=${access}`);
        }
      }
      return lines.join('\n');
    }

    case 'add-member': {
      const name = tokens[0];
      const userId = tokens[1];
      if (!name || !userId) {
        return 'Usage: workgroup add-member <name> <userId> [-a r|rw]';
      }
      // 从剩余 tokens 中提取 -a 标志。
      const remaining = tokens.slice(2);
      const flags = parseFlags(remaining, ['-a']);
      const access = flags['-a'] ?? 'rw';
      if (access !== 'r' && access !== 'rw') {
        return `Invalid access level: ${access}. Must be "r" or "rw".`;
      }
      const workGroups = getWorkGroups();
      if (!workGroups[name]) {
        return `Work group not found: ${name}`;
      }
      const user = getUser(userId);
      if (!user) {
        return `User not found: ${userId}`;
      }
      workGroups[name].members[userId] = access as 'r' | 'rw';
      updateWorkGroups(workGroups);
      return `Added ${userId} (${user.name}) to "${name}" with access=${access}.`;
    }

    case 'remove-member': {
      const name = tokens[0];
      const userId = tokens[1];
      if (!name || !userId) {
        return 'Usage: workgroup remove-member <name> <userId>';
      }
      const workGroups = getWorkGroups();
      if (!workGroups[name]) {
        return `Work group not found: ${name}`;
      }
      if (!(userId in workGroups[name].members)) {
        return `User ${userId} is not a member of "${name}".`;
      }
      delete workGroups[name].members[userId];
      updateWorkGroups(workGroups);
      return `Removed ${userId} from "${name}".`;
    }

    case 'set-access': {
      const name = tokens[0];
      const userId = tokens[1];
      const access = tokens[2];
      if (!name || !userId || !access) {
        return 'Usage: workgroup set-access <name> <userId> <access>';
      }
      if (access !== 'r' && access !== 'rw') {
        return `Invalid access level: ${access}. Must be "r" or "rw".`;
      }
      const workGroups = getWorkGroups();
      if (!workGroups[name]) {
        return `Work group not found: ${name}`;
      }
      if (!(userId in workGroups[name].members)) {
        return `User ${userId} is not a member of "${name}".`;
      }
      workGroups[name].members[userId] = access as 'r' | 'rw';
      updateWorkGroups(workGroups);
      return `Set access for ${userId} in "${name}" to ${access}.`;
    }

    case 'members': {
      const name = tokens[0];
      if (!name) {
        return 'Usage: workgroup members <name>';
      }
      const workGroups = getWorkGroups();
      if (!workGroups[name]) {
        return `Work group not found: ${name}`;
      }
      const entries = Object.entries(workGroups[name].members);
      if (entries.length === 0) {
        return 'No members.';
      }
      return entries
        .map(([userId, access]) => `${userId}  access=${access}`)
        .join('\n');
    }

    default:
      return `Unknown workgroup subcommand: ${sub}\nAvailable: create, delete, list, info, add-member, remove-member, set-access, members`;
  }
}

/** /admin 帮助文本。 */
const HELP_TEXT = [
  'Usage: /admin <domain> <subcommand> [args]',
  '',
  'User commands:',
  '  user create -n <name>',
  '  user list',
  '  user info <userId>',
  '  user rename <userId> <newName>',
  '  user set-group <userId> <group>',
  '  user delete <userId>',
  '  user bind -t <token> -p <platform> -u <id>',
  '',
  'Workgroup commands:',
  '  workgroup create <name>',
  '  workgroup delete <name>',
  '  workgroup list',
  '  workgroup info <name>',
  '  workgroup add-member <name> <userId> [-a r|rw]',
  '  workgroup remove-member <name> <userId>',
  '  workgroup set-access <name> <userId> <access>',
  '  workgroup members <name>',
  '',
  'System commands:',
  '  reload-config    Hot-reload config.yaml (adapters and logging require restart)',
].join('\n');

/**
 * 处理 /admin 命令。
 *
 * @param args - 命令参数字符串（不含 "/admin" 前缀）。
 * @returns 执行结果文本，由调用方发送给用户。
 */
export function handleAdminCommand(args: string): string {
  const tokens = args.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return HELP_TEXT;
  }

  const domain = tokens[0];
  const sub = tokens[1] ?? '';
  const rest = tokens.slice(2);

  switch (domain) {
    case 'user':
      if (!sub) {
        return 'Usage: /admin user <subcommand>\nAvailable: create, list, info, rename, set-group, delete, bind';
      }
      return handleUserCommand(sub, rest);

    case 'workgroup':
      if (!sub) {
        return 'Usage: /admin workgroup <subcommand>\nAvailable: create, delete, list, info, add-member, remove-member, set-access, members';
      }
      return handleWorkgroupCommand(sub, rest);

    case 'reload-config': {
      try {
        const result = reloadConfig();
        const lines: string[] = [];
        if (result.reloaded.length > 0) {
          lines.push(`Reloaded: ${result.reloaded.join(', ')}`);
        } else {
          lines.push('No config changes detected.');
        }
        if (result.requireRestart.length > 0) {
          lines.push(`Require restart to take effect: ${result.requireRestart.join(', ')}`);
        }
        return lines.join('\n');
      } catch (err) {
        return `Failed to reload config: ${(err as Error).message}`;
      }
    }

    case 'help':
      return HELP_TEXT;

    default:
      return `Unknown domain: ${domain}\nAvailable: user, workgroup, reload-config\nUse "/admin help" for full usage.`;
  }
}
