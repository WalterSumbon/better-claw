import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { agentContext } from '../core/agent-context.js';
import {
  createCronTask,
  listCronTasks,
  updateCronTask,
  deleteCronTask,
} from './scheduler.js';

/**
 * 获取当前 agent 上下文中的用户 ID。
 *
 * @returns 用户 ID。
 * @throws 未在 agentContext 内调用时抛出错误。
 */
function getCurrentUserId(): string {
  const store = agentContext.getStore();
  if (!store) {
    throw new Error('cron tool called outside of agent context');
  }
  return store.userId;
}

/** MCP 工具：cron_create。创建定时任务。 */
export const cronCreateTool = tool(
  'cron_create',
  `Create a scheduled (cron) task for the user.

The task will run at the specified schedule and send the prompt to the agent.
The agent's response will be broadcast to all platforms the user has bound.

Cron expression format: "minute hour day-of-month month day-of-week"
Examples:
- "0 9 * * *"     → every day at 9:00 AM
- "30 8 * * 1-5"  → weekdays at 8:30 AM
- "0 */2 * * *"   → every 2 hours
- "0 0 1 * *"     → first day of every month at midnight

When the user says something like "remind me to drink water every morning at 9",
create a cron task with an appropriate schedule and prompt.`,
  {
    schedule: z.string().describe('Cron expression (e.g., "0 9 * * *" for daily at 9 AM).'),
    description: z.string().describe('Human-readable description of what this task does.'),
    prompt: z.string().describe('The prompt to send to the agent when the task triggers.'),
  },
  async (args) => {
    const userId = getCurrentUserId();
    const task = createCronTask(userId, args.schedule, args.description, args.prompt);

    if (!task) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Failed to create cron task. Invalid cron expression: "${args.schedule}"`,
          },
        ],
      };
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: `Cron task created:\n  ID: ${task.id}\n  Schedule: ${task.schedule}\n  Description: ${task.description}`,
        },
      ],
    };
  },
);

/** MCP 工具：cron_list。列出用户的所有定时任务。 */
export const cronListTool = tool(
  'cron_list',
  `List all scheduled (cron) tasks for the user.
Returns task ID, schedule, description, enabled status, and creation time.`,
  {},
  async () => {
    const userId = getCurrentUserId();
    const tasks = listCronTasks(userId);

    if (tasks.length === 0) {
      return {
        content: [
          { type: 'text' as const, text: 'No scheduled tasks found.' },
        ],
      };
    }

    const lines = tasks.map(
      (t) =>
        `- [${t.enabled ? 'ON' : 'OFF'}] ${t.id}: "${t.description}" (${t.schedule})`,
    );

    return {
      content: [
        {
          type: 'text' as const,
          text: `Scheduled tasks:\n${lines.join('\n')}`,
        },
      ],
    };
  },
);

/** MCP 工具：cron_update。更新定时任务。 */
export const cronUpdateTool = tool(
  'cron_update',
  `Update an existing scheduled (cron) task.
You can modify the schedule, description, prompt, or enable/disable the task.
Use cron_list first to find the task ID.`,
  {
    taskId: z.string().describe('The ID of the cron task to update.'),
    schedule: z.string().optional().describe('New cron expression.'),
    description: z.string().optional().describe('New description.'),
    prompt: z.string().optional().describe('New prompt.'),
    enabled: z.boolean().optional().describe('Enable or disable the task.'),
  },
  async (args) => {
    const userId = getCurrentUserId();
    const { taskId, ...updates } = args;

    // 过滤掉 undefined 值。
    const cleanUpdates: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) {
        cleanUpdates[key] = value;
      }
    }

    if (Object.keys(cleanUpdates).length === 0) {
      return {
        content: [
          { type: 'text' as const, text: 'No updates provided.' },
        ],
      };
    }

    const task = updateCronTask(userId, taskId, cleanUpdates as Parameters<typeof updateCronTask>[2]);

    if (!task) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Failed to update task "${taskId}". Task not found or invalid cron expression.`,
          },
        ],
      };
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task updated:\n  ID: ${task.id}\n  Schedule: ${task.schedule}\n  Description: ${task.description}\n  Enabled: ${task.enabled}`,
        },
      ],
    };
  },
);

/** MCP 工具：cron_delete。删除定时任务。 */
export const cronDeleteTool = tool(
  'cron_delete',
  `Delete a scheduled (cron) task.
Use cron_list first to find the task ID.`,
  {
    taskId: z.string().describe('The ID of the cron task to delete.'),
  },
  async (args) => {
    const userId = getCurrentUserId();
    const deleted = deleteCronTask(userId, args.taskId);

    if (!deleted) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Task "${args.taskId}" not found.`,
          },
        ],
      };
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task "${args.taskId}" deleted.`,
        },
      ],
    };
  },
);
