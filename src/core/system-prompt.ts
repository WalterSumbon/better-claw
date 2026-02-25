import { getUser } from '../user/manager.js';
import { readCoreMemory } from '../memory/manager.js';
import { getSessionHistoryForPrompt } from './session-manager.js';

/**
 * 为指定用户构建完整的 system prompt。
 *
 * @param userId - 用户 ID。
 * @returns 拼装好的 system prompt 字符串。
 */
export function buildSystemPrompt(userId: string): string {
  const sections: string[] = [];

  // 1. Agent 身份与行为准则。
  sections.push(`You are Better-Claw, a personal AI assistant.
You are helpful, proactive, and remember user preferences.
You have access to custom tools for managing memory and scheduled tasks.
Always respond in the language the user prefers (check core memory for preferences).
Be concise and direct unless the user asks for detailed explanations.`);

  // 2. 当前时间。
  sections.push(`Current date and time: ${new Date().toISOString()}`);

  // 3. 当前用户信息。
  const user = getUser(userId);
  if (user) {
    sections.push(`Current user: ${user.name} (ID: ${user.userId})`);
  }

  // 4. 自定义工具说明。
  sections.push(`## Available Custom Tools

### Memory Tools
- mcp__better-claw__memory_read: Read from memory (core or extended tier).
- mcp__better-claw__memory_write: Write to memory. Choose "core" for preferences/identity (auto-injected), "extended" for knowledge/notes.
- mcp__better-claw__memory_delete: Delete a memory entry.

### Scheduled Task Tools
- mcp__better-claw__cron_create: Create a scheduled task.
- mcp__better-claw__cron_list: List scheduled tasks.
- mcp__better-claw__cron_update: Update a scheduled task.
- mcp__better-claw__cron_delete: Delete a scheduled task.

### Session Management Tools
- mcp__better-claw__session_new: Start a new session (archives the current one with a summary).
- mcp__better-claw__session_list: List all sessions (active and archived).
- mcp__better-claw__session_info: Get current session details.

Sessions auto-rotate when idle too long or when the conversation grows too large.
You can read archived conversation files (JSON) to recall details from previous sessions.`);

  // 5. 核心记忆内容。
  const coreMemory = readCoreMemory(userId);
  const hasContent =
    Object.keys(coreMemory.preferences).length > 0 ||
    Object.keys(coreMemory.identity).length > 0;

  if (hasContent) {
    sections.push(
      `## User Core Memory (auto-loaded)\n${JSON.stringify(coreMemory, null, 2)}`,
    );
  }

  // 6. 会话历史。
  const sessionHistory = getSessionHistoryForPrompt(userId);
  if (sessionHistory) {
    sections.push(`## Session History\n\n${sessionHistory}`);
  }

  return sections.join('\n\n');
}
