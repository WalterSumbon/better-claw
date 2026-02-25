import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import {
  memoryReadTool,
  memoryWriteTool,
  memoryDeleteTool,
} from '../memory/tools.js';
import {
  cronCreateTool,
  cronListTool,
  cronUpdateTool,
  cronDeleteTool,
} from '../cron/tools.js';
import { sendFileTool } from './tools.js';

/**
 * 创建包含所有自定义工具的 MCP 服务器。
 *
 * @returns MCP 服务器配置实例。
 */
export function createAppMcpServer() {
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
    ],
  });
}
