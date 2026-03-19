import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { createMemoryTools } from '../memory/tools.js';
import { createCronTools } from '../cron/tools.js';
import { createMcpTools } from './tools.js';
import { createUserProfileTool } from './user-profile-tools.js';
import { createSessionTools } from '../core/session-tools.js';
import { createSkillTools } from '../skills/tools.js';

/**
 * 创建包含所有自定义工具的 MCP 服务器。
 *
 * 通过 userId 参数，将用户 ID 以闭包形式烘进每个工具的 handler，
 * 解决 AsyncLocalStorage 在 SDK tool call 链路中可能断裂导致
 * `agentContext.getStore()` 返回 null 的问题。
 *
 * 每个用户的 AgentProcess 拥有独立的 MCP server 实例，
 * 因此不存在并发用户间的 userId 冲突。
 *
 * @param userId - 当前用户 ID。
 * @returns MCP 服务器配置实例。
 */
export function createAppMcpServer(userId: string) {
  const { memoryReadTool, memoryWriteTool, memoryDeleteTool } = createMemoryTools(userId);
  const { cronCreateTool, cronListTool, cronUpdateTool, cronDeleteTool } = createCronTools(userId);
  const { sendFileTool, restartTool } = createMcpTools(userId);
  const { userProfileTool } = createUserProfileTool(userId);
  const { sessionNewTool, sessionListTool, sessionInfoTool } = createSessionTools(userId);
  const { loadSkillsetTool } = createSkillTools(userId);

  return createSdkMcpServer({
    name: 'better-claw',
    version: '1.0.0',
    tools: [
      memoryReadTool,
      memoryWriteTool,
      memoryDeleteTool,
      cronCreateTool,
      cronListTool,
      cronUpdateTool,
      cronDeleteTool,
      sendFileTool,
      restartTool,
      userProfileTool,
      sessionNewTool,
      sessionListTool,
      sessionInfoTool,
      loadSkillsetTool,
    ],
  });
}
