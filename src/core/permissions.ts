import { resolve, join } from 'path';
import { homedir } from 'os';
import type { CanUseTool, SandboxSettings } from '@anthropic-ai/claude-agent-sdk';
import { getConfig, getConfigFilePath } from '../config/index.js';
import { getUserDir, getUserWorkspacePath, getWorkGroupWorkspacePath, listUserIds } from '../user/store.js';
import { readProfile } from '../user/store.js';
import type { ResolvedPermissions, FilesystemConfig, PermissionGroupConfig } from './permissions-types.js';

/** ${configFile} 占位符，当 configFilePath 为 null 时跳过该条目。 */
const CONFIG_FILE_VAR = '${configFile}';

/** ${otherUserDir} 占位符，展开为所有其他用户的目录。 */
const OTHER_USER_DIR_VAR = '${otherUserDir}';

/**
 * 对单个路径字符串执行变量替换。
 *
 * 支持的变量：
 * - ${userWorkspace}: 用户 workspace 目录
 * - ${userDir}: 用户数据目录
 * - ${dataDir}: 全局数据目录（绝对路径）
 * - ${home}: 当前系统用户主目录
 * - ${configFile}: 配置文件路径（可能为 null，此时返回 null）
 *
 * 注意：${otherUserDir} 不在此函数中处理，由 resolvePaths() 负责展开。
 *
 * @param pathStr - 包含变量占位符的路径。
 * @param userId - 当前用户 ID。
 * @returns 替换后的路径字符串，包含 ${configFile} 且无法解析时返回 null。
 */
export function resolvePathVariable(pathStr: string, userId: string): string | null {
  const config = getConfig();
  const dataDir = resolve(process.cwd(), config.dataDir);

  // ${configFile} 需要特殊处理：路径不存在时整条规则应被跳过。
  if (pathStr.includes(CONFIG_FILE_VAR)) {
    const configFile = getConfigFilePath();
    if (!configFile) {
      return null;
    }
    pathStr = pathStr.replace(/\$\{configFile\}/g, resolve(configFile));
  }

  let result = pathStr;
  result = result.replace(/\$\{home\}/g, homedir());
  result = result.replace(/\$\{userWorkspace\}/g, resolve(process.cwd(), getUserWorkspacePath(userId)));
  result = result.replace(/\$\{userDir\}/g, resolve(process.cwd(), getUserDir(userId)));
  result = result.replace(/\$\{dataDir\}/g, dataDir);
  return result;
}

/**
 * 获取除当前用户以外的所有用户目录绝对路径。
 *
 * @param userId - 当前用户 ID。
 * @returns 其他用户目录的绝对路径数组。
 */
function getOtherUserDirs(userId: string): string[] {
  const config = getConfig();
  const dataDir = resolve(process.cwd(), config.dataDir);
  const allUserIds = listUserIds();
  return allUserIds
    .filter((id) => id !== userId)
    .map((id) => resolve(dataDir, 'users', id));
}

/**
 * 对路径数组执行变量替换，支持 ${otherUserDir} 展开。
 *
 * ${otherUserDir} 会展开为除当前用户以外的所有用户目录路径。
 * 如果条目为 "${otherUserDir}/workspace"，则每个其他用户都会生成一条
 * "/path/to/data/users/user_xxx/workspace"。
 *
 * @param paths - 原始路径数组（可能包含变量）。
 * @param userId - 当前用户 ID。
 * @returns 解析后的绝对路径数组。
 */
function resolvePaths(paths: string[], userId: string): string[] {
  const result: string[] = [];
  for (const p of paths) {
    if (p.includes(OTHER_USER_DIR_VAR)) {
      // 展开 ${otherUserDir} 为所有其他用户目录。
      const otherDirs = getOtherUserDirs(userId);
      for (const dir of otherDirs) {
        const expanded = p.replace(/\$\{otherUserDir\}/g, dir);
        // expanded 已经是绝对路径了（otherUserDir 替换后），
        // 但仍需处理其他可能的变量。
        const resolved = resolvePathVariable(expanded, userId);
        if (resolved !== null) {
          result.push(resolved);
        }
      }
    } else {
      const resolved = resolvePathVariable(p, userId);
      if (resolved !== null) {
        result.push(resolved);
      }
    }
  }
  return result;
}

/**
 * 展开继承链，合并权限组的 filesystem 配置。
 *
 * 遍历顺序：先递归展开父组，再合并当前组。
 * 子组的数组条目追加在父组之后。
 * 检测循环继承并在发现时中止。
 *
 * @param groupName - 权限组名称。
 * @param groups - 所有权限组配置。
 * @param visited - 已访问的组名集合（用于循环检测）。
 * @returns 合并后的 filesystem 配置（路径尚未替换变量）。
 */
function flattenGroupFilesystem(
  groupName: string,
  groups: Record<string, PermissionGroupConfig>,
  visited: Set<string> = new Set(),
): FilesystemConfig {
  if (visited.has(groupName)) {
    return {};
  }
  visited.add(groupName);

  // admin 组是根，无规则，代表完全可读可写。
  if (groupName === 'admin') {
    return {};
  }

  const groupConfig = groups[groupName];
  if (!groupConfig) {
    return {};
  }

  // 默认继承 admin。
  const parentName = groupConfig.inherits ?? 'admin';
  const parentFs = flattenGroupFilesystem(parentName, groups, visited);
  const ownFs = groupConfig.filesystem ?? {};

  return {
    allowWrite: [...(parentFs.allowWrite ?? []), ...(ownFs.allowWrite ?? [])],
    denyWrite: [...(parentFs.denyWrite ?? []), ...(ownFs.denyWrite ?? [])],
    denyRead: [...(parentFs.denyRead ?? []), ...(ownFs.denyRead ?? [])],
  };
}

/**
 * 解析用户的最终权限（继承展开 + 变量替换 + 工作组合并）。
 *
 * 流程：
 * 1. 读取用户 permissionGroup（从 profile 或 defaultGroup）。
 * 2. 展开继承链，合并 filesystem 配置。
 * 3. 对每个路径数组做变量替换（含 ${otherUserDir} 展开）。
 * 4. 查找用户所属的工作组，追加对应的 allowWrite 条目。
 * 5. 追加 protectedPaths。
 *
 * @param userId - 用户 ID。
 * @returns 解析后的权限对象。
 */
export function resolveUserPermissions(userId: string): ResolvedPermissions {
  const config = getConfig();
  const permConfig = config.permissions;

  // 确定用户所属的权限组。
  const profile = readProfile(userId);
  const groupName = profile?.permissionGroup ?? permConfig.defaultGroup;

  // admin 组直接返回，无需规则。
  if (groupName === 'admin') {
    return {
      isAdmin: true,
      filesystem: { allowWrite: [], denyWrite: [], denyRead: [] },
      protectedPaths: [],
    };
  }

  // 展开继承链。
  const rawFs = flattenGroupFilesystem(
    groupName,
    permConfig.groups as unknown as Record<string, PermissionGroupConfig>,
  );

  // 变量替换。
  const filesystem = {
    allowWrite: resolvePaths(rawFs.allowWrite ?? [], userId),
    denyWrite: resolvePaths(rawFs.denyWrite ?? [], userId),
    denyRead: resolvePaths(rawFs.denyRead ?? [], userId),
  };

  // 合并工作组共享 workspace。
  const workGroups = permConfig.workGroups;
  if (workGroups) {
    for (const [wgName, wgConfig] of Object.entries(workGroups)) {
      const members = (wgConfig as { members: Record<string, 'r' | 'rw'> }).members;
      const accessLevel = members[userId];
      if (!accessLevel) {
        continue;
      }
      const wgWorkspace = resolve(process.cwd(), getWorkGroupWorkspacePath(wgName));
      if (accessLevel === 'rw') {
        filesystem.allowWrite.push(wgWorkspace);
      }
      // r 成员的 workspace 不在 denyRead 中（默认可读），无需额外操作。
    }
  }

  // 解析 protectedPaths。
  const protectedPaths = resolvePaths(permConfig.protectedPaths ?? [], userId);

  return { isAdmin: false, filesystem, protectedPaths };
}

/**
 * 判断 parentDir 是否包含 childPath（基于路径前缀匹配）。
 *
 * @param parentDir - 父目录路径。
 * @param childPath - 子路径。
 * @returns childPath 是否在 parentDir 下（含自身）。
 */
function pathContains(parentDir: string, childPath: string): boolean {
  const normalizedParent = parentDir.endsWith('/') ? parentDir : parentDir + '/';
  return childPath === parentDir || childPath.startsWith(normalizedParent);
}

/**
 * 检查指定路径在给定权限下是否被允许。
 *
 * 评估逻辑（直接映射 SDK sandbox filesystem 语义）：
 *
 * 写入检查：
 *   1. 如果路径命中 protectedPaths → deny。
 *   2. 如果路径命中 denyWrite → deny（优先级最高）。
 *   3. 如果 allowWrite 非空且路径不在 allowWrite 下 → deny。
 *   4. 否则 → allow。
 *
 * 读取检查：
 *   1. 如果路径命中 protectedPaths → deny。
 *   2. 如果路径命中 denyRead → deny。
 *   3. 否则 → allow。
 *
 * @param inputPath - 待检查的路径（绝对或相对）。
 * @param permissions - 已解析的权限对象。
 * @param mode - 访问模式（'read' 或 'write'）。
 * @param cwd - 当前工作目录（用于解析相对路径）。
 * @returns 是否允许访问。
 */
export function isPathAllowed(
  inputPath: string,
  permissions: ResolvedPermissions,
  mode: 'read' | 'write',
  cwd?: string,
): boolean {
  if (permissions.isAdmin) {
    return true;
  }

  const absPath = resolve(cwd ?? process.cwd(), inputPath);
  const { filesystem, protectedPaths } = permissions;

  // protectedPaths 始终拒绝读和写。
  for (const pp of protectedPaths) {
    if (pathContains(pp, absPath)) {
      return false;
    }
  }

  if (mode === 'write') {
    // denyWrite 优先级最高。
    for (const dw of filesystem.denyWrite) {
      if (pathContains(dw, absPath)) {
        return false;
      }
    }
    // allowWrite 白名单模式：如果非空，路径必须在白名单中。
    if (filesystem.allowWrite.length > 0) {
      const allowed = filesystem.allowWrite.some((aw) => pathContains(aw, absPath));
      if (!allowed) {
        return false;
      }
    }
    return true;
  }

  // mode === 'read'
  for (const dr of filesystem.denyRead) {
    if (pathContains(dr, absPath)) {
      return false;
    }
  }
  return true;
}

/**
 * 从工具输入参数中提取文件路径。
 *
 * @param toolName - 工具名称。
 * @param input - 工具输入参数。
 * @returns 提取到的路径，无法提取时返回 null。
 */
function extractPathFromInput(toolName: string, input: Record<string, unknown>): string | null {
  if (typeof input.file_path === 'string') {
    return input.file_path;
  }
  if (typeof input.path === 'string') {
    return input.path;
  }
  if (typeof input.notebook_path === 'string') {
    return input.notebook_path;
  }
  return null;
}

/**
 * 判断工具的访问模式。
 *
 * @param toolName - 工具名称。
 * @returns 'read' | 'write' | null（null 表示无需路径检查）。
 */
function getToolAccessMode(toolName: string): 'read' | 'write' | null {
  switch (toolName) {
    case 'Read':
    case 'Glob':
    case 'Grep':
      return 'read';
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return 'write';
    default:
      return null;
  }
}

/**
 * 构建 canUseTool 回调，用于对 SDK 内置工具做路径级权限检查。
 *
 * 检查策略：
 * - Read / Glob / Grep: 检查路径的 read 权限。
 * - Write / Edit / NotebookEdit: 检查路径的 write 权限。
 * - Bash: 由 sandbox 保护，直接 allow。
 * - MCP 工具 (mcp__*): 已有 agentContext 隔离，直接 allow。
 * - 其他工具: 直接 allow。
 *
 * @param userId - 用户 ID。
 * @returns CanUseTool 回调函数。
 */
export function buildCanUseTool(userId: string): CanUseTool {
  const permissions = resolveUserPermissions(userId);
  const cwd = getUserWorkspacePath(userId);

  return async (toolName, input) => {
    const allow = () =>
      input != null && typeof input === 'object' && !Array.isArray(input)
        ? { behavior: 'allow' as const, updatedInput: input }
        : { behavior: 'allow' as const };

    if (permissions.isAdmin) {
      return allow();
    }

    if (toolName.startsWith('mcp__')) {
      return allow();
    }

    // Bash: 由 sandbox 保护，但必须阻止 dangerouslyDisableSandbox 绕过沙箱。
    if (toolName === 'Bash') {
      if (
        input != null &&
        typeof input === 'object' &&
        'dangerouslyDisableSandbox' in input &&
        (input as Record<string, unknown>).dangerouslyDisableSandbox
      ) {
        return {
          behavior: 'deny' as const,
          message: 'Permission denied: non-admin users cannot disable the Bash sandbox.',
        };
      }
      return allow();
    }

    const mode = getToolAccessMode(toolName);
    if (!mode) {
      return allow();
    }

    const path = extractPathFromInput(toolName, input);
    if (!path) {
      if (!isPathAllowed(cwd, permissions, mode, cwd)) {
        return {
          behavior: 'deny' as const,
          message: `Permission denied: no ${mode} access to working directory.`,
        };
      }
      return allow();
    }

    if (!isPathAllowed(path, permissions, mode, cwd)) {
      return {
        behavior: 'deny' as const,
        message: `Permission denied: no ${mode} access to ${path}.`,
      };
    }

    return allow();
  };
}

/**
 * 构建 sandbox 设置，对 Bash 命令执行进程级沙箱。
 *
 * 直接将 ResolvedPermissions.filesystem 透传给 SDK sandbox。
 * protectedPaths 同时追加到 denyRead 和 denyWrite。
 * admin 用户不启用 sandbox。
 *
 * @param userId - 用户 ID。
 * @returns SandboxSettings 对象。
 */
export function buildSandboxSettings(userId: string): SandboxSettings {
  const permissions = resolveUserPermissions(userId);

  if (permissions.isAdmin) {
    return { enabled: false };
  }

  const { filesystem, protectedPaths } = permissions;

  // protectedPaths 追加到 denyRead 和 denyWrite，确保 sandbox 层也能拦截。
  const denyRead = [...filesystem.denyRead, ...protectedPaths];
  const denyWrite = [...filesystem.denyWrite, ...protectedPaths];

  return {
    enabled: true,
    autoAllowBashIfSandboxed: true,
    // 从根源禁止 dangerouslyDisableSandbox 参数绕过沙箱。
    allowUnsandboxedCommands: false,
    filesystem: {
      allowWrite: filesystem.allowWrite.length > 0 ? filesystem.allowWrite : undefined,
      denyWrite: denyWrite.length > 0 ? denyWrite : undefined,
      denyRead: denyRead.length > 0 ? denyRead : undefined,
    },
  };
}
