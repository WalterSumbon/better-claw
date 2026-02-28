import { getUser } from '../user/manager.js';
import { readCoreMemory } from '../memory/manager.js';
import { getSessionHistoryForPrompt } from './session-manager.js';
import { resolveUserPermissions } from './permissions.js';

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
Be concise and direct unless the user asks for detailed explanations.

IMPORTANT: When you receive a message, always send a brief acknowledgment first before doing any complex processing (tool calls, long thinking, etc.). For example, send a short message like "let me check..." or "thinking..." or a contextually appropriate brief response. This helps the user know their message was received and reduces waiting anxiety. Keep this initial response natural and conversational, not robotic.

## How Your Messages Reach the User

You are running as a Claude Agent SDK subprocess. Your outputs are processed before reaching the user:
- **Text responses**: Every text block you produce in an assistant turn is sent to the user in real-time as a chat message. Write as if you are talking directly to the user.
- **Tool calls**: Tool invocations and their results are NOT shown to the user. The user only sees your text responses before and after tool use.
- **Thinking blocks**: Your internal reasoning (extended thinking) is NOT visible to the user.
- **Files**: Use the mcp__better-claw__send_file tool to send files (images, documents, audio, etc.) as native media messages to the user.

Because tool calls are invisible to the user, always include a brief text message before doing complex tool work, so the user knows you are processing their request.`);


  // 2. 当前时间。
  sections.push(`Current date and time: ${new Date().toISOString()}`);

  // 3. 当前用户信息。
  const user = getUser(userId);
  if (user) {
    sections.push(`Current user: ${user.name} (ID: ${user.userId})`);
  }

  // 4. 文件系统权限范围。
  const permissions = resolveUserPermissions(userId);
  if (permissions.isAdmin) {
    sections.push(`## File Access Permissions\nYou have admin privileges with unrestricted file system access.`);
  } else {
    const ruleLines = permissions.rules.map(
      (r) => `- ${r.action} ${r.access} ${r.path}`,
    );
    sections.push(`## File Access Permissions
Your file access starts as fully permitted (inherited from admin), then the following rules are applied in order (last matching rule wins):
${ruleLines.join('\n')}

Attempts to access restricted paths will be denied. Do not retry denied operations — inform the user that the path is outside their permitted scope.`);
  }

  // 5. 自定义工具说明。
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

  // 6. 核心记忆内容。
  const coreMemory = readCoreMemory(userId);
  const hasContent =
    Object.keys(coreMemory.preferences).length > 0 ||
    Object.keys(coreMemory.identity).length > 0;

  if (hasContent) {
    sections.push(
      `## User Core Memory (auto-loaded)\n${JSON.stringify(coreMemory, null, 2)}`,
    );
  }

  // 7. 会话历史。
  const sessionHistory = getSessionHistoryForPrompt(userId);
  if (sessionHistory) {
    sections.push(`## Session History\n\n${sessionHistory}`);
  }

  return sections.join('\n\n');
}
