/**
 * AgentElegram 管理协议处理器。
 *
 * 处理从 agentelegram 服务端转发的 mgmt_request 事件，
 * 查询/修改 Better-Claw 内部状态（skills、memory、cron、mcp），
 * 返回 mgmt_response。
 */
import { getLogger } from '../../logger/index.js';
import { readCoreMemory, writeCoreMemory, listExtendedMemoryEntries, readExtendedMemory, writeExtendedMemory, deleteExtendedMemory } from '../../memory/manager.js';
import { listCronTasks, createCronTask, updateCronTask, deleteCronTask } from '../../cron/scheduler.js';
import { getUserSkillIndex } from '../../skills/scanner.js';
import { getClaudeSettings } from '../../config/claude-settings.js';
import { readUserMcpServers, getUserDir } from '../../user/store.js';
import type { SkillIndex, SkillNode } from '../../skills/scanner.js';

// ---- 管理协议类型 ----

/** 管理动作类型（与 agentelegram shared 定义对齐）。 */
export type MgmtAction =
  | 'query_state'
  | 'query_skills'
  | 'update_skill'
  | 'query_memory'
  | 'read_memory'
  | 'write_memory'
  | 'delete_memory'
  | 'query_cron'
  | 'create_cron'
  | 'update_cron'
  | 'delete_cron'
  | 'query_mcp'
  | 'update_mcp';

export interface MgmtRequest {
  type: 'mgmt_request';
  requestId: string;
  action: MgmtAction;
  payload?: Record<string, unknown>;
}

export interface MgmtResponse {
  type: 'mgmt_response';
  requestId: string;
  success: boolean;
  data?: unknown;
  mgmtError?: string;
}

// ---- SkillInfo（兼容 agentelegram 前端） ----

interface SkillInfo {
  name: string;
  description?: string;
  enabled: boolean;
  type: 'skill' | 'skillset';
  children?: SkillInfo[];
}

/**
 * 将 SkillIndex 中的节点转换为 agentelegram 前端期望的 SkillInfo 数组。
 */
function buildSkillTree(index: SkillIndex): SkillInfo[] {
  function nodeToInfo(node: SkillNode): SkillInfo {
    const info: SkillInfo = {
      name: node.frontmatter.name || node.path,
      description: node.frontmatter.description || undefined,
      enabled: true, // Better-Claw 当前无 skill enable/disable 状态
      type: node.type,
    };
    if (node.type === 'skillset' && node.children.length > 0) {
      info.children = node.children
        .map((childPath) => index.nodes.get(childPath))
        .filter((n): n is SkillNode => !!n)
        .map(nodeToInfo);
    }
    return info;
  }

  return index.topLevel
    .map((path) => index.nodes.get(path))
    .filter((n): n is SkillNode => !!n)
    .map(nodeToInfo);
}

/**
 * 构建 MCP 服务器信息列表。
 * 合并 Claude Code settings 中的全局 MCP 和用户 per-user MCP 配置。
 */
function buildMcpList(userId: string) {
  const globalSettings = getClaudeSettings();
  const userMcp = readUserMcpServers(userId);

  // 合并：用户配置覆盖全局同名服务器。
  const merged: Record<string, Record<string, unknown>> = {};
  for (const [name, config] of Object.entries(globalSettings.mcpServers)) {
    merged[name] = config as Record<string, unknown>;
  }
  for (const [name, config] of Object.entries(userMcp)) {
    merged[name] = config;
  }

  return Object.entries(merged).map(([name, config]) => ({
    name,
    enabled: true, // Better-Claw 当前无 MCP enable/disable 状态
    type: (config.type as string) ?? 'stdio',
  }));
}

/**
 * 处理单个管理请求。
 *
 * @param request - 管理请求。
 * @param userId - 当前绑定的 Better-Claw 用户 ID（用于读写 memory/cron 等）。
 * @returns 管理响应。
 */
export async function handleMgmtRequest(
  request: MgmtRequest,
  userId: string,
): Promise<MgmtResponse> {
  const log = getLogger();
  const { requestId, action, payload } = request;

  log.debug({ requestId, action, payload }, 'AgentElegram: handling mgmt_request');

  try {
    switch (action) {
      case 'query_state': {
        const skills = buildSkillTree(getUserSkillIndex(userId, getUserDir(userId)));
        const coreMemory = readCoreMemory(userId);
        const extendedKeys = listExtendedMemoryEntries(userId);
        const crons = listCronTasks(userId);
        const mcp = buildMcpList(userId);

        return {
          type: 'mgmt_response',
          requestId,
          success: true,
          data: {
            online: true,
            skills,
            memory: {
              core: coreMemory,
              extended: extendedKeys.map((e) => ({
                key: e.key,
                description: e.summary,
              })),
            },
            cron: crons.map((t) => ({
              id: t.id,
              schedule: t.schedule,
              description: t.description,
              enabled: t.enabled,
              lastRun: undefined,
              nextRun: undefined,
            })),
            mcp,
          },
        };
      }

      case 'query_skills': {
        const index = getUserSkillIndex(userId, getUserDir(userId));
        const skills = buildSkillTree(index);
        return { type: 'mgmt_response', requestId, success: true, data: skills };
      }

      case 'update_skill': {
        // Better-Claw 当前不支持动态 enable/disable skill，
        // 返回成功但记录警告。
        log.warn({ payload }, 'AgentElegram: update_skill not fully supported, skill state is not persisted');
        return {
          type: 'mgmt_response',
          requestId,
          success: true,
          data: { acknowledged: true, note: 'Skill enable/disable not yet supported in Better-Claw' },
        };
      }

      case 'query_memory': {
        const core = readCoreMemory(userId);
        const extended = listExtendedMemoryEntries(userId);
        return {
          type: 'mgmt_response',
          requestId,
          success: true,
          data: {
            core,
            extended: extended.map((e) => ({
              key: e.key,
              description: e.summary,
            })),
          },
        };
      }

      case 'read_memory': {
        const tier = payload?.tier as string;
        const key = payload?.key as string;

        if (!tier || !key) {
          return { type: 'mgmt_response', requestId, success: false, mgmtError: 'tier and key required' };
        }

        if (tier === 'core') {
          const core = readCoreMemory(userId);
          const value = (core as Record<string, unknown>)[key];
          return { type: 'mgmt_response', requestId, success: true, data: value ?? null };
        }

        if (tier === 'extended') {
          const entry = readExtendedMemory(userId, key);
          return {
            type: 'mgmt_response',
            requestId,
            success: true,
            data: entry ? { content: entry.content, summary: entry.summary, createdAt: entry.createdAt, updatedAt: entry.updatedAt } : null,
          };
        }

        return { type: 'mgmt_response', requestId, success: false, mgmtError: `unknown tier: ${tier}` };
      }

      case 'write_memory': {
        const tier = payload?.tier as string;
        const key = payload?.key as string;
        const value = payload?.value;
        const description = payload?.description as string | undefined;

        if (!tier || !key) {
          return { type: 'mgmt_response', requestId, success: false, mgmtError: 'tier and key required' };
        }

        if (tier === 'core') {
          const core = readCoreMemory(userId);
          (core as Record<string, unknown>)[key] = value;
          writeCoreMemory(userId, core);
          return { type: 'mgmt_response', requestId, success: true, data: null };
        }

        if (tier === 'extended') {
          const content = typeof value === 'string' ? value : JSON.stringify(value);
          writeExtendedMemory(userId, key, content, description);
          return { type: 'mgmt_response', requestId, success: true, data: null };
        }

        return { type: 'mgmt_response', requestId, success: false, mgmtError: `unknown tier: ${tier}` };
      }

      case 'delete_memory': {
        const tier = payload?.tier as string;
        const key = payload?.key as string;

        if (!tier || !key) {
          return { type: 'mgmt_response', requestId, success: false, mgmtError: 'tier and key required' };
        }

        if (tier === 'core') {
          const core = readCoreMemory(userId);
          delete (core as Record<string, unknown>)[key];
          writeCoreMemory(userId, core);
          return { type: 'mgmt_response', requestId, success: true, data: null };
        }

        if (tier === 'extended') {
          const deleted = deleteExtendedMemory(userId, key);
          return { type: 'mgmt_response', requestId, success: deleted, mgmtError: deleted ? undefined : 'key not found' };
        }

        return { type: 'mgmt_response', requestId, success: false, mgmtError: `unknown tier: ${tier}` };
      }

      case 'query_cron': {
        const tasks = listCronTasks(userId);
        return {
          type: 'mgmt_response',
          requestId,
          success: true,
          data: tasks.map((t) => ({
            id: t.id,
            schedule: t.schedule,
            description: t.description,
            enabled: t.enabled,
            lastRun: undefined,
            nextRun: undefined,
          })),
        };
      }

      case 'create_cron': {
        const schedule = payload?.schedule as string;
        const description = payload?.description as string;
        const prompt = payload?.prompt as string ?? description;
        const enabled = payload?.enabled as boolean ?? true;

        if (!schedule || !description) {
          return { type: 'mgmt_response', requestId, success: false, mgmtError: 'schedule and description required' };
        }

        const task = createCronTask(userId, schedule, description, prompt, false);
        if (!task) {
          return { type: 'mgmt_response', requestId, success: false, mgmtError: 'invalid cron expression' };
        }

        // 如果创建时 enabled 为 false，则更新为 disabled。
        if (!enabled) {
          updateCronTask(userId, task.id, { enabled: false });
        }

        return {
          type: 'mgmt_response',
          requestId,
          success: true,
          data: { id: task.id, schedule: task.schedule, description: task.description, enabled },
        };
      }

      case 'update_cron': {
        const taskId = payload?.id as string;
        if (!taskId) {
          return { type: 'mgmt_response', requestId, success: false, mgmtError: 'id required' };
        }

        const updates: Record<string, unknown> = {};
        if (payload?.schedule !== undefined) updates.schedule = payload.schedule;
        if (payload?.description !== undefined) updates.description = payload.description;
        if (payload?.enabled !== undefined) updates.enabled = payload.enabled;

        const updated = updateCronTask(userId, taskId, updates);
        if (!updated) {
          return { type: 'mgmt_response', requestId, success: false, mgmtError: 'task not found or invalid schedule' };
        }

        return {
          type: 'mgmt_response',
          requestId,
          success: true,
          data: { id: updated.id, schedule: updated.schedule, description: updated.description, enabled: updated.enabled },
        };
      }

      case 'delete_cron': {
        const taskId = payload?.id as string;
        if (!taskId) {
          return { type: 'mgmt_response', requestId, success: false, mgmtError: 'id required' };
        }

        const deleted = deleteCronTask(userId, taskId);
        return { type: 'mgmt_response', requestId, success: deleted, mgmtError: deleted ? undefined : 'task not found' };
      }

      case 'query_mcp': {
        const mcp = buildMcpList(userId);
        return { type: 'mgmt_response', requestId, success: true, data: mcp };
      }

      case 'update_mcp': {
        // Better-Claw 当前不支持动态 enable/disable MCP 服务器。
        log.warn({ payload }, 'AgentElegram: update_mcp not fully supported');
        return {
          type: 'mgmt_response',
          requestId,
          success: true,
          data: { acknowledged: true, note: 'MCP enable/disable not yet supported in Better-Claw' },
        };
      }

      default:
        return { type: 'mgmt_response', requestId, success: false, mgmtError: `unknown action: ${action}` };
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.error({ err: errMsg, requestId, action }, 'AgentElegram: mgmt_request handler error');
    return { type: 'mgmt_response', requestId, success: false, mgmtError: errMsg };
  }
}
