import { existsSync } from 'fs';
import { resolve } from 'path';
import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { agentContext } from '../core/agent-context.js';
import { getLogger } from '../logger/index.js';

/** MCP 工具：send_file。向用户发送文件（图片、视频、音频、文档等）。 */
export const sendFileTool = tool(
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
    if (!store) {
      throw new Error('send_file tool called outside of agent context');
    }

    if (!store.sendFile) {
      return {
        content: [
          { type: 'text' as const, text: 'Error: File sending is not available in the current context.' },
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
      log.info({ userId: store.userId, filePath, type: args.type }, 'File sent to user');
      return {
        content: [
          { type: 'text' as const, text: `File sent successfully: ${filePath}` },
        ],
      };
    } catch (err) {
      log.error({ err, userId: store.userId, filePath }, 'Failed to send file');
      const errorMessage = err instanceof Error ? err.message : String(err);
      return {
        content: [
          { type: 'text' as const, text: `Error sending file: ${errorMessage}` },
        ],
      };
    }
  },
);
