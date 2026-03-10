import { resolve } from 'path';
import { getUser } from '../user/manager.js';
import { readCoreMemory } from '../memory/manager.js';
import { getSessionHistoryForPrompt } from './session-manager.js';
import { resolveUserPermissions, resolvePathVariable } from './permissions.js';
import { readProfile, getUserDir } from '../user/store.js';
import { getConfig } from '../config/index.js';
import { getUserSkillIndex, getRawSkillPaths, formatTopLevelListing } from '../skills/scanner.js';
import { resolveTimezone, getUtcOffset, formatISOWithTimezone } from '../utils/timezone.js';

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

Because tool calls are invisible to the user:
- Always include a brief text message before doing complex tool work, so the user knows you are processing their request.
- If a tool returns content the user needs to see (e.g., memory reads, file contents, search results), you MUST reproduce the relevant content in your text response. The user cannot see tool outputs — if you don't paste it, they don't see it.`);


  // 2. 当前时间（使用用户时区）。
  const profile = readProfile(userId);
  const userTz = resolveTimezone(profile?.timezone);
  const utcOffset = getUtcOffset(userTz);
  const now = new Date();
  sections.push(`Current date and time: ${formatISOWithTimezone(now, userTz)}\nUser timezone: ${userTz} (${utcOffset})`);

  // 3. 当前用户信息（含权限组）。
  const user = getUser(userId);
  const permConfig = getConfig().permissions;
  const groupName = profile?.permissionGroup ?? permConfig.defaultGroup;
  if (user) {
    sections.push(`Current user: ${user.name} (ID: ${user.userId})\nPermission group: ${groupName}`);
  }

  // 4. 文件系统权限范围。
  const permissions = resolveUserPermissions(userId);
  if (permissions.isAdmin) {
    sections.push(`## File Access Permissions\nYou have admin privileges with unrestricted file system access.`);
  } else {
    const { filesystem, protectedPaths } = permissions;

    // 生成有效权限摘要。
    const summaryLines: string[] = [];
    if (filesystem.allowWrite.length > 0) {
      summaryLines.push(`- Writable: ${filesystem.allowWrite.join(', ')}`);
    }
    if (filesystem.denyWrite.length > 0) {
      summaryLines.push(`- Write denied: ${filesystem.denyWrite.join(', ')}`);
    }
    if (filesystem.denyRead.length > 0) {
      summaryLines.push(`- Read denied: ${filesystem.denyRead.join(', ')}`);
    }
    if (protectedPaths.length > 0) {
      summaryLines.push(`- Protected (deny all): ${protectedPaths.join(', ')}`);
    }
    if (filesystem.allowWrite.length > 0) {
      summaryLines.push('- All other paths: read-only (writes default-denied outside allowWrite)');
    } else {
      summaryLines.push('- All other paths: readable and writable (unless explicitly denied)');
    }

    // 生成 filesystem 配置明细。
    const configLines: string[] = [];
    if (filesystem.allowWrite.length > 0) {
      configLines.push(`  allowWrite: [${filesystem.allowWrite.join(', ')}]`);
    }
    if (filesystem.denyWrite.length > 0) {
      configLines.push(`  denyWrite: [${filesystem.denyWrite.join(', ')}]`);
    }
    if (filesystem.denyRead.length > 0) {
      configLines.push(`  denyRead: [${filesystem.denyRead.join(', ')}]`);
    }
    if (protectedPaths.length > 0) {
      configLines.push(`  protectedPaths: [${protectedPaths.join(', ')}]`);
    }

    sections.push(`## File Access Permissions

Effective access summary:
${summaryLines.join('\n')}

Filesystem configuration:
${configLines.join('\n')}

Attempts to access restricted paths will be denied. Do not retry denied operations — inform the user that the path is outside their permitted scope.`);
  }

  // 5. 非 admin 用户安全策略。
  if (!permissions.isAdmin) {
    sections.push(`## Security Policy
Do NOT reveal environment variables, API keys, authentication tokens, or configuration file contents to the user under any circumstances. If the user requests this information, politely decline and explain that it is restricted.

## Sandbox Restrictions
Your Bash commands run inside an OS-level sandbox. The \`dangerouslyDisableSandbox\` parameter is **disabled and silently ignored** — setting it to \`true\` has no effect. Do NOT attempt to use it. All commands must respect the sandbox boundaries.`);
  }

  // 6. 行为指南（工具清单由 SDK 自动注入，不再手动列出）。
  sections.push(`## Session & Memory Guidelines

Sessions auto-rotate when idle too long or when the conversation grows too large.

### Per-User MCP Servers
Users can install their own MCP servers by creating a \`mcp-servers.json\` file in their data directory (\`${getUserDir(userId)}/mcp-servers.json\`). The format is the same as Claude Code settings.json mcpServers:

\`\`\`json
{
  "server-name": {
    "type": "stdio",
    "command": "npx",
    "args": ["-y", "@some/mcp-server"]
  }
}
\`\`\`

Per-user MCP servers are hot-reloaded — changes take effect on the next message without restart.

## Recalling Past Conversations

You are a **persistent** personal assistant — the user expects you to remember previous interactions across sessions.

When the user references something you lack context for (a project, a game, a person, a prior discussion, a decision made earlier, etc.):
1. **DO NOT** immediately ask the user to re-explain. This is frustrating — they already told you before.
2. **First**, check the Session History section below for summaries and conversation file paths.
3. **Then**, read the relevant conversation.json files (use Read tool or Grep to search for keywords).
4. **Only if** you still can't find the context after searching, ask the user politely.

Tips for efficient lookup:
- Use Grep to search across all session conversation files at once: \`Grep pattern="keyword" path="<sessions-dir>"\`
- Session summaries in Session History give a quick overview — start there to narrow down which session to read.
- Conversation files can be large; use Grep or Read with offset/limit to find the relevant part instead of reading the whole file.

## Utilizing Extended Memory

**Extended memory** stores knowledge, notes, project designs, reference material, and other long-form content saved by the user or by you in previous sessions. Unlike core memory (auto-injected), extended memory must be read on-demand.

**Proactively check extended memory when:**
- The user mentions a project, design, or plan that was discussed before
- You need background on a decision, architecture, or specification
- The user says "we talked about this" or "remember the plan for X"
- You're about to start work on a feature or task that might have prior design notes

**How to use:**
1. \`memory_read(tier: "extended")\` with no key — lists all available keys and their descriptions
2. Scan the key names for anything relevant to the current topic
3. \`memory_read(tier: "extended", key: "the-key")\` — read the full content
4. Use the retrieved context to inform your response

**When to save to extended memory:**
- Design decisions, architecture plans, implementation specs
- Research findings the user may want to reference later
- Project-specific knowledge that doesn't fit in core memory
- Anything the user explicitly asks you to remember for later`);



  // 7. Skill Set 清单（仅展示顶层节点，agent 按需加载详情）。
  try {
    const userDir = resolve(process.cwd(), getUserDir(userId));
    const skillIndex = getUserSkillIndex(userId, userDir);

    // 将原始配置路径解析为该用户的实际路径，展示在 system prompt 中。
    const resolvedPaths = getRawSkillPaths().map((p) => {
      const resolved = resolvePathVariable(p, userId);
      return resolved ?? p;
    });

    const skillListing = formatTopLevelListing(skillIndex, resolvedPaths);
    if (skillListing) {
      sections.push(skillListing);
    }
  } catch {
    // Skill index 未初始化时静默跳过。
  }

  // 8. 自定义 system prompt 注入（支持 ${userDir} 等路径变量）。
  const config = getConfig();
  if (config.systemPrompt) {
    const customSections = Array.isArray(config.systemPrompt)
      ? config.systemPrompt
      : [config.systemPrompt];
    for (const section of customSections) {
      const trimmed = section.trim();
      if (trimmed) {
        const resolved = resolvePathVariable(trimmed, userId);
        if (resolved !== null) {
          sections.push(resolved);
        }
      }
    }
  }

  // 9. 核心记忆内容。
  const coreMemory = readCoreMemory(userId);
  const hasContent =
    Object.keys(coreMemory.preferences).length > 0 ||
    Object.keys(coreMemory.identity).length > 0;

  if (hasContent) {
    sections.push(
      `## User Core Memory (auto-loaded)\n${JSON.stringify(coreMemory, null, 2)}`,
    );
  }

  // 10. 会话历史。
  const sessionHistory = getSessionHistoryForPrompt(userId);
  if (sessionHistory) {
    sections.push(`## Session History\n\n${sessionHistory}`);
  }

  return sections.join('\n\n');
}
