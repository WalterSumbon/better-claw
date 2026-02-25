import { tool } from '@anthropic-ai/claude-agent-sdk';
import { agentContext } from './agent-context.js';
import {
  rotateSession,
  getCurrentSessionInfo,
} from './session-manager.js';
import { listArchivedSessions, conversationPath } from './session-store.js';

/**
 * 获取当前 agent 上下文中的用户 ID。
 */
function getCurrentUserId(): string {
  const store = agentContext.getStore();
  if (!store) {
    throw new Error('session tool called outside of agent context');
  }
  return store.userId;
}

/** MCP 工具：session_new。手动创建新会话（轮转当前会话）。 */
export const sessionNewTool = tool(
  'session_new',
  `Start a new conversation session, archiving the current one.

Use this tool when:
- The user wants to start a fresh conversation
- The user says something like "new session", "fresh start", "reset conversation"
- The current session context is no longer relevant

The current session will be archived with an AI-generated summary.
The next message will start in a completely new session.`,
  {},
  async () => {
    const userId = getCurrentUserId();
    const currentInfo = getCurrentSessionInfo(userId);

    if (!currentInfo || !currentInfo.sdkSessionId) {
      return {
        content: [
          { type: 'text' as const, text: 'No active session to rotate. A new session will be created automatically on the next message.' },
        ],
      };
    }

    // 执行轮转（归档旧会话、创建新会话）。
    // 不需要重置 agent 内存状态：sendToAgent 在每次查询开始时
    // 通过 ensureActiveSession 从磁盘同步最新状态。
    const newSession = await rotateSession(userId, 'manual');

    return {
      content: [
        {
          type: 'text' as const,
          text: `Session rotated.\n  Old session: ${currentInfo.localId} (${currentInfo.messageCount} messages, ${currentInfo.totalTurns} turns)\n  New session: ${newSession.localId}\n\nThe next message will start in the new session.`,
        },
      ],
    };
  },
);

/** MCP 工具：session_list。列出用户的所有会话。 */
export const sessionListTool = tool(
  'session_list',
  `List all conversation sessions for the user, including the current active session and archived ones.
Returns session ID, time range, message count, and summary.`,
  {},
  async () => {
    const userId = getCurrentUserId();
    const current = getCurrentSessionInfo(userId);
    const archived = listArchivedSessions(userId);

    const lines: string[] = [];

    if (current) {
      lines.push('Active session:');
      lines.push(`  ID: ${current.localId}`);
      lines.push(`  Started: ${current.createdAt}`);
      lines.push(`  Last active: ${current.updatedAt}`);
      lines.push(`  Messages: ${current.messageCount}, Context: ${current.contextTokens.toLocaleString()} tokens`);
      lines.push(`  Cost: $${current.totalCostUsd.toFixed(4)}`);
      lines.push('');
    }

    if (archived.length > 0) {
      lines.push(`Archived sessions (${archived.length}):`);
      for (const s of archived) {
        lines.push(`  - ${s.localId}`);
        lines.push(`    Time: ${s.createdAt} → ${s.endedAt}`);
        lines.push(`    Messages: ${s.messageCount}, Context: ${(s.contextTokens ?? 0).toLocaleString()} tokens, Cost: $${s.totalCostUsd.toFixed(4)}`);
        if (s.summary) {
          lines.push(`    Summary: ${s.summary}`);
        }
        lines.push(`    Conversation: ${conversationPath(userId, s.localId)}`);
      }
    } else {
      lines.push('No archived sessions.');
    }

    return {
      content: [
        { type: 'text' as const, text: lines.join('\n') },
      ],
    };
  },
);

/** MCP 工具：session_info。获取当前会话详细信息。 */
export const sessionInfoTool = tool(
  'session_info',
  `Get detailed information about the current active session.
Returns session ID, SDK session ID, creation time, message count, turns, and cost.`,
  {},
  async () => {
    const userId = getCurrentUserId();
    const current = getCurrentSessionInfo(userId);

    if (!current) {
      return {
        content: [
          { type: 'text' as const, text: 'No active session.' },
        ],
      };
    }

    const contextRatio = current.contextWindowTokens > 0
      ? ` (${(current.contextTokens / current.contextWindowTokens * 100).toFixed(1)}%)`
      : '';
    const contextWindowInfo = current.contextWindowTokens > 0
      ? `  Context window: ${current.contextWindowTokens.toLocaleString()} tokens`
      : `  Context window: unknown (will be detected on next query)`;

    const info = [
      `Current session info:`,
      `  Local ID: ${current.localId}`,
      `  SDK Session ID: ${current.sdkSessionId ?? 'none'}`,
      `  Created: ${current.createdAt}`,
      `  Last active: ${current.updatedAt}`,
      `  Messages: ${current.messageCount}`,
      `  Total turns: ${current.totalTurns}`,
      `  Context tokens: ${current.contextTokens.toLocaleString()}${contextRatio}`,
      contextWindowInfo,
      `  Total cost: $${current.totalCostUsd.toFixed(4)}`,
      `  Conversation file: ${conversationPath(userId, current.localId)}`,
    ];

    return {
      content: [
        { type: 'text' as const, text: info.join('\n') },
      ],
    };
  },
);
