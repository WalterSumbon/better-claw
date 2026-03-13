import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { resolveUserId } from '../core/agent-context.js';
import {
  readCoreMemory,
  writeCoreMemory,
  listExtendedMemoryEntries,
  readExtendedMemory,
  writeExtendedMemory,
  deleteExtendedMemory,
} from './manager.js';

/**
 * 创建所有 memory MCP 工具。
 *
 * 通过工厂函数接收 fallbackUserId，避免依赖 AsyncLocalStorage
 * 在 SDK tool call 链路中可能断裂的问题。
 *
 * @param fallbackUserId - 工厂创建时捕获的用户 ID（闭包 fallback）。
 */
export function createMemoryTools(fallbackUserId: string) {
  /** 解析当前用户 ID（AsyncLocalStorage 优先，fallback 到闭包）。 */
  function getCurrentUserId(): string {
    return resolveUserId(fallbackUserId);
  }

  /** MCP 工具：memory_read。从用户记忆中读取信息。 */
  const memoryReadTool = tool(
    'memory_read',
    `Read from the user's memory store.

Available tiers:
- "core": Read the user's core memory (preferences, identity, frequently-referenced context).
  Core memory is always available in the system prompt, but you can read it explicitly for inspection.
- "extended": Read from extended memory. Pass a specific key to read that entry,
  or omit key to list all available keys.

Choose the appropriate tier based on what information you need.`,
    {
      tier: z.enum(['core', 'extended']).describe('Memory tier to read from.'),
      key: z
        .string()
        .optional()
        .describe(
          'Key to read from extended memory. Omit to list all available keys. Ignored for core tier.',
        ),
    },
    async (args) => {
      const userId = getCurrentUserId();

      if (args.tier === 'core') {
        const memory = readCoreMemory(userId);
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify(memory, null, 2) },
          ],
        };
      }

      // extended tier
      if (!args.key) {
        const entries = listExtendedMemoryEntries(userId);
        if (entries.length === 0) {
          return {
            content: [
              { type: 'text' as const, text: 'No extended memory entries found.' },
            ],
          };
        }
        const listing = entries
          .map((e) => e.summary ? `- ${e.key}: ${e.summary}` : `- ${e.key}`)
          .join('\n');
        return {
          content: [
            {
              type: 'text' as const,
              text: `Available extended memory entries:\n${listing}`,
            },
          ],
        };
      }

      const entry = readExtendedMemory(userId, args.key);
      if (!entry) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Extended memory entry "${args.key}" not found.`,
            },
          ],
        };
      }
      return {
        content: [{ type: 'text' as const, text: entry.content }],
      };
    },
  );

  /** MCP 工具：memory_write。写入用户记忆。 */
  const memoryWriteTool = tool(
    'memory_write',
    `Write to the user's memory store.

Decide which tier to write to:
- "core": For user preferences, identity info, and frequently-referenced context.
  Core memory is auto-injected into every conversation's system prompt. Keep it concise and structured.
  Use category + key to organize (e.g., category="preferences", key="language", content="Chinese").
- "extended": For knowledge, notes, reference material, and long-form content.
  Extended memory is read on-demand via memory_read.

Guidelines for choosing the tier:
- If the user says something like "remember that I prefer X" or "my name is X" → use "core"
- If the user asks to save notes, project details, or reference material → use "extended"
- When in doubt, prefer "extended" to keep the system prompt concise.`,
    {
      tier: z.enum(['core', 'extended']).describe('Memory tier to write to.'),
      category: z
        .string()
        .optional()
        .describe(
          'Category for core memory (e.g., "preferences", "identity"). Required for core tier.',
        ),
      key: z.string().describe('Memory key / identifier for this entry.'),
      content: z.string().describe('The content to store.'),
      summary: z
        .string()
        .optional()
        .describe(
          'A brief one-line summary of this entry (for extended tier only). ' +
          'Shown when listing entries so the model can quickly decide which to read. ' +
          'Always provide a concise summary when writing extended memory.',
        ),
    },
    async (args) => {
      const userId = getCurrentUserId();

      if (args.tier === 'core') {
        const category = args.category ?? 'preferences';
        const memory = readCoreMemory(userId);
        if (typeof memory[category] !== 'object' || memory[category] === null) {
          (memory as Record<string, unknown>)[category] = {};
        }
        (memory[category] as Record<string, string>)[args.key] = args.content;
        writeCoreMemory(userId, memory);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Core memory updated: ${category}.${args.key} = "${args.content}"`,
            },
          ],
        };
      }

      // extended tier
      writeExtendedMemory(userId, args.key, args.content, args.summary);
      return {
        content: [
          {
            type: 'text' as const,
            text: `Extended memory saved with key "${args.key}".`,
          },
        ],
      };
    },
  );

  /** MCP 工具：memory_delete。删除用户记忆条目。 */
  const memoryDeleteTool = tool(
    'memory_delete',
    `Delete an entry from the user's memory store.

- "core": Remove a specific key from a category in core memory.
- "extended": Remove an entire extended memory entry by key.`,
    {
      tier: z.enum(['core', 'extended']).describe('Memory tier to delete from.'),
      category: z
        .string()
        .optional()
        .describe('Category for core memory deletion. Required for core tier.'),
      key: z.string().describe('Key to delete.'),
    },
    async (args) => {
      const userId = getCurrentUserId();

      if (args.tier === 'core') {
        const category = args.category ?? 'preferences';
        const memory = readCoreMemory(userId);
        const cat = memory[category];
        if (typeof cat === 'object' && cat !== null) {
          delete (cat as Record<string, unknown>)[args.key];
          writeCoreMemory(userId, memory);
          return {
            content: [
              {
                type: 'text' as const,
                text: `Core memory deleted: ${category}.${args.key}`,
              },
            ],
          };
        }
        return {
          content: [
            {
              type: 'text' as const,
              text: `Core memory category "${category}" not found.`,
            },
          ],
        };
      }

      // extended tier
      const deleted = deleteExtendedMemory(userId, args.key);
      if (deleted) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Extended memory entry "${args.key}" deleted.`,
            },
          ],
        };
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: `Extended memory entry "${args.key}" not found.`,
          },
        ],
      };
    },
  );

  return { memoryReadTool, memoryWriteTool, memoryDeleteTool };
}
