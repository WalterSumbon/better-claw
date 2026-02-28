import { resolve } from 'path';
import type { CanUseTool, SandboxSettings } from '@anthropic-ai/claude-agent-sdk';
import { getConfig } from '../config/index.js';
import { getUserDir, getUserWorkspacePath, getWorkGroupWorkspacePath } from '../user/store.js';
import { readProfile } from '../user/store.js';
import type { ResolvedPermissions, ResolvedRule } from './permissions-types.js';

/**
 * 对单个路径字符串执行变量替换。
 *
 * 支持的变量：
 * - ${userWorkspace}: 用户 workspace 目录
 * - ${userDir}: 用户数据目录
 * - ${dataDir}: 全局数据目录（绝对路径）
 *
 * @param pathStr - 包含变量占位符的路径。
 * @param userId - 当前用户 ID。
 * @returns 替换后的路径字符串。
 */
export function resolvePathVariable(pathStr: string, userId: string): string {
  const config = getConfig();
  const dataDir = resolve(process.cwd(), config.dataDir);

  let result = pathStr;
  result = result.replace(/\$\{userWorkspace\}/g, getUserWorkspacePath(userId));
  result = result.replace(/\$\{userDir\}/g, getUserDir(userId));
  result = result.replace(/\$\{dataDir\}/g, dataDir);
  return result;
}

/**
 * 展开继承链，将权限组的规则列表扁平化。
 *
 * 遍历顺序：先递归展开父组规则，再追加当前组规则。
 * 检测循环继承并在发现时中止。
 *
 * @param groupName - 权限组名称。
 * @param groups - 所有权限组配置。
 * @param visited - 已访问的组名集合（用于循环检测）。
 * @returns 扁平化的原始规则列表（路径尚未替换变量）。
 */
function flattenGroupRules(
  groupName: string,
  groups: Record<string, { inherits?: string; rules?: Array<{ action: string; access: string; path: string }> }>,
  visited: Set<string> = new Set(),
): Array<{ action: string; access: string; path: string }> {
  if (visited.has(groupName)) {
    return [];
  }
  visited.add(groupName);

  // admin 组是根，无规则，代表完全可读可写。
  if (groupName === 'admin') {
    return [];
  }

  const groupConfig = groups[groupName];
  if (!groupConfig) {
    return [];
  }

  // 默认继承 admin。
  const parentName = groupConfig.inherits ?? 'admin';
  const parentRules = flattenGroupRules(parentName, groups, visited);
  const ownRules = groupConfig.rules ?? [];

  return [...parentRules, ...ownRules];
}

/**
 * 解析用户的最终权限（继承展开 + 变量替换 + 工作组合并）。
 *
 * 流程：
 * 1. 读取用户 permissionGroup（从 profile 或 defaultGroup）。
 * 2. 展开继承链，得到扁平化规则列表。
 * 3. 对每条规则做变量替换。
 * 4. 查找用户所属的工作组，追加对应的 allow 规则。
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
    return { isAdmin: true, rules: [] };
  }

  // 展开继承链。
  const rawRules = flattenGroupRules(
    groupName,
    permConfig.groups as Record<string, { inherits?: string; rules?: Array<{ action: string; access: string; path: string }> }>,
  );

  // 变量替换。
  const rules: ResolvedRule[] = rawRules.map((r) => ({
    action: r.action as 'allow' | 'deny',
    access: r.access as 'read' | 'write' | 'readwrite',
    path: resolvePathVariable(r.path, userId),
  }));

  // 合并工作组共享 workspace。
  const workGroups = permConfig.workGroups;
  if (workGroups) {
    for (const [wgName, wgConfig] of Object.entries(workGroups)) {
      const members = (wgConfig as { members: Record<string, 'r' | 'rw'> }).members;
      const accessLevel = members[userId];
      if (!accessLevel) {
        continue;
      }
      const wgWorkspace = getWorkGroupWorkspacePath(wgName);
      if (accessLevel === 'rw') {
        rules.push({ action: 'allow', access: 'readwrite', path: wgWorkspace });
      } else {
        rules.push({ action: 'allow', access: 'read', path: wgWorkspace });
      }
    }
  }

  return { isAdmin: false, rules };
}

/**
 * 检查指定路径在给定权限下是否被允许。
 *
 * 评估逻辑：
 * 1. admin → 直接放行。
 * 2. 基础状态为 allow（因为继承自 admin = 完全可读可写）。
 * 3. 规则从上到下依次匹配，每条匹配的规则覆盖前一个结果。
 * 4. 返回最终结果。
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

  // 基础状态：allow（继承自 admin）。
  let result = true;

  for (const rule of permissions.rules) {
    // 检查 access 是否匹配当前 mode。
    if (rule.access !== 'readwrite' && rule.access !== mode) {
      continue;
    }

    // 检查路径是否匹配。
    if (rule.path === '*' || pathContains(rule.path, absPath)) {
      result = rule.action === 'allow';
    }
  }

  return result;
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
    if (permissions.isAdmin) {
      return { behavior: 'allow' as const };
    }

    if (toolName.startsWith('mcp__') || toolName === 'Bash') {
      return { behavior: 'allow' as const };
    }

    const mode = getToolAccessMode(toolName);
    if (!mode) {
      return { behavior: 'allow' as const };
    }

    const path = extractPathFromInput(toolName, input);
    if (!path) {
      if (!isPathAllowed(cwd, permissions, mode, cwd)) {
        return {
          behavior: 'deny' as const,
          message: `Permission denied: no ${mode} access to working directory.`,
        };
      }
      return { behavior: 'allow' as const };
    }

    if (!isPathAllowed(path, permissions, mode, cwd)) {
      return {
        behavior: 'deny' as const,
        message: `Permission denied: no ${mode} access to ${path}.`,
      };
    }

    return { behavior: 'allow' as const };
  };
}

/**
 * 构建 sandbox 设置，对 Bash 命令执行进程级沙箱。
 *
 * 从规则链中提取 deny 规则转换为 sandbox filesystem 配置。
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

  // 从规则链中提取用于 sandbox 的 deny/allow 列表。
  // sandbox filesystem 只支持 allowWrite / denyWrite / denyRead。
  const denyRead: string[] = [];
  const denyWrite: string[] = [];
  const allowWrite: string[] = [];

  for (const rule of permissions.rules) {
    if (rule.path === '*') {
      continue;
    }
    if (rule.action === 'deny') {
      if (rule.access === 'read' || rule.access === 'readwrite') {
        denyRead.push(rule.path);
      }
      if (rule.access === 'write' || rule.access === 'readwrite') {
        denyWrite.push(rule.path);
      }
    } else if (rule.action === 'allow') {
      if (rule.access === 'write' || rule.access === 'readwrite') {
        allowWrite.push(rule.path);
      }
    }
  }

  return {
    enabled: true,
    autoAllowBashIfSandboxed: true,
    filesystem: {
      allowWrite: allowWrite.length > 0 ? allowWrite : undefined,
      denyWrite: denyWrite.length > 0 ? denyWrite : undefined,
      denyRead: denyRead.length > 0 ? denyRead : undefined,
    },
  };
}
