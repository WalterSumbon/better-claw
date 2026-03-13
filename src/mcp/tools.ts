import { existsSync } from 'fs';
import { resolve } from 'path';
import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { agentContext, resolveUserId } from '../core/agent-context.js';
import { getLogger } from '../logger/index.js';
import { writeRestartMarker } from '../core/restart-marker.js';
import { getConfig } from '../config/index.js';

/**
 * 创建 send_file 和 restart MCP 工具。
 *
 * 通过工厂函数接收 fallbackUserId，避免依赖 AsyncLocalStorage
 * 在 SDK tool call 链路中可能断裂的问题。
 *
 * 注意：sendFile 和 notifyUser 回调仍需从 AsyncLocalStorage 获取，
 * 因为它们是 per-request 的，无法在工厂创建时捕获。
 *
 * @param fallbackUserId - 工厂创建时捕获的用户 ID（闭包 fallback）。
 */
export function createMcpTools(fallbackUserId: string) {

  /** MCP 工具：restart。重启 Better-Claw 服务。 */
  const restartTool = tool(
    'restart',
    `Restart the Better-Claw service process.

Use this tool when you need to restart the service, for example after modifying code or configuration files.
The process will gracefully shut down and the external process manager will restart it.
A short delay is applied to ensure the current response is delivered before the process exits.

After restart, the agent will automatically resume the conversation and notify the user that the restart is complete.`,
    {},
    async () => {
      const log = getLogger();
      const store = agentContext.getStore();
      const userId = store?.userId ?? fallbackUserId;

      // 检查 agent 是否被允许触发重启。
      if (!getConfig().restart.allowAgent) {
        log.info({ userId }, 'Agent restart blocked by config (restart.allowAgent=false)');
        return {
          content: [
            { type: 'text' as const, text: 'Restart via agent is disabled by configuration.' },
          ],
        };
      }

      // 写入重启标记，以便服务重启后自动恢复对话。
      writeRestartMarker(userId, 'mcp_tool');
      log.info({ userId }, 'Restart marker written');

      log.info({ userId }, 'Restart requested via MCP tool');

      // 向用户推送重启通知（与手动 /restart 命令行为一致，await 确保消息发出）。
      if (store?.notifyUser) {
        await store.notifyUser('🔄 Restarting...');
      }

      // 延迟退出，确保当前响应能送达用户。外层进程管理器负责重新拉起。
      setTimeout(() => process.kill(process.pid, 'SIGTERM'), 500);
      return {
        content: [
          { type: 'text' as const, text: 'Service restart scheduled. The process will exit shortly and be restarted by the process manager. A restart marker has been written — the agent will auto-resume the conversation after restart.' },
        ],
      };
    },
  );

  /** MCP 工具：send_file。向用户发送文件（图片、视频、音频、文档等）。 */
  const sendFileTool = tool(
    'send_file',
    `Send a file to the user as a native media message (photo, video, audio, document, etc.).

Use this tool when you want to send a file (image, video, audio, or document) directly to the user
in their messaging platform (e.g., Telegram). The file will be sent as a native media message,
not as a text message with a file path.

The file must exist on disk. You can create files using other tools first, then send them with this tool.

Parameters:
- file_path: Absolute path to the file on disk.
- type: Optional media type hint. If omitted, the type is inferred from the file extension.
  Supported types: "photo", "document", "voice", "audio", "video", "animation".
- caption: Optional text caption to include with the media message.`,
    {
      file_path: z.string().describe('Absolute path to the file to send.'),
      type: z
        .enum(['photo', 'document', 'voice', 'audio', 'video', 'animation'])
        .optional()
        .describe('Media type hint. Inferred from file extension if omitted.'),
      caption: z.string().optional().describe('Optional caption for the media message.'),
    },
    async (args) => {
      const log = getLogger();
      const store = agentContext.getStore();
      const userId = store?.userId ?? fallbackUserId;

      if (!store?.sendFile) {
        return {
          content: [
            { type: 'text' as const, text: 'Error: File sending is not available in the current context (AsyncLocalStorage context lost).' },
          ],
        };
      }

      const filePath = resolve(args.file_path);
      if (!existsSync(filePath)) {
        return {
          content: [
            { type: 'text' as const, text: `Error: File not found: ${filePath}` },
          ],
        };
      }

      try {
        await store.sendFile(filePath, {
          type: args.type,
          caption: args.caption,
        });
        log.info({ userId, filePath, type: args.type }, 'File sent to user');
        return {
          content: [
            { type: 'text' as const, text: `File sent successfully: ${filePath}` },
          ],
        };
      } catch (err) {
        log.error({ err, userId, filePath }, 'Failed to send file');
        const errorMessage = err instanceof Error ? err.message : String(err);
        return {
          content: [
            { type: 'text' as const, text: `Error sending file: ${errorMessage}` },
          ],
        };
      }
    },
  );

  return { restartTool, sendFileTool };
}
