import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { agentContext } from '../core/agent-context.js';
import { readProfile, writeProfile } from '../user/store.js';
import { isValidTimezone, getUtcOffset, getSystemTimezone } from '../utils/timezone.js';

/** MCP 工具：user_profile。查看和更新用户 profile 设置（如时区）。 */
export const userProfileTool = tool(
  'user_profile',
  `View or update the current user's profile settings.

Currently supports:
- **timezone**: The user's IANA timezone (e.g., "Asia/Shanghai", "America/New_York", "Europe/London").
  When set, all time-related displays (system prompt, message timestamps, cron tasks) will use the user's timezone.
  When not set, the host machine's system timezone is used as fallback.

Actions:
- **get**: View the current profile settings (timezone, etc.)
- **set**: Update a profile field. Currently only "timezone" is supported.

Examples:
- Get current settings: action="get"
- Set timezone: action="set", field="timezone", value="Asia/Shanghai"
- Clear timezone (revert to system default): action="set", field="timezone", value=""`,
  {
    action: z.enum(['get', 'set']).describe('Action to perform: "get" to view, "set" to update.'),
    field: z
      .enum(['timezone'])
      .optional()
      .describe('Field to update (required for "set" action). Currently only "timezone" is supported.'),
    value: z
      .string()
      .optional()
      .describe('New value for the field (required for "set" action). Empty string to clear.'),
  },
  async (args) => {
    const store = agentContext.getStore();
    if (!store) {
      throw new Error('user_profile tool called outside of agent context');
    }
    const userId = store.userId;
    const profile = readProfile(userId);
    if (!profile) {
      return {
        content: [{ type: 'text' as const, text: 'Error: User profile not found.' }],
      };
    }

    if (args.action === 'get') {
      const systemTz = getSystemTimezone();
      const effectiveTz = profile.timezone || systemTz;
      const offset = getUtcOffset(effectiveTz);
      const lines = [
        `User Profile for ${profile.name} (${profile.userId}):`,
        `  Timezone: ${profile.timezone || '(not set, using system default)'}`,
        `  Effective timezone: ${effectiveTz} (${offset})`,
        `  System timezone: ${systemTz}`,
      ];
      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
      };
    }

    // action === 'set'
    if (!args.field) {
      return {
        content: [{ type: 'text' as const, text: 'Error: "field" parameter is required for "set" action.' }],
      };
    }

    if (args.field === 'timezone') {
      const newValue = args.value?.trim() ?? '';

      if (newValue === '') {
        // 清除时区设置，回退到系统默认。
        profile.timezone = undefined;
        writeProfile(profile);
        const systemTz = getSystemTimezone();
        return {
          content: [{
            type: 'text' as const,
            text: `Timezone cleared. Now using system default: ${systemTz} (${getUtcOffset(systemTz)}).`,
          }],
        };
      }

      if (!isValidTimezone(newValue)) {
        return {
          content: [{
            type: 'text' as const,
            text: `Error: Invalid timezone "${newValue}". Please use an IANA timezone string (e.g., "Asia/Shanghai", "America/New_York", "Europe/London").`,
          }],
        };
      }

      profile.timezone = newValue;
      writeProfile(profile);
      return {
        content: [{
          type: 'text' as const,
          text: `Timezone updated to: ${newValue} (${getUtcOffset(newValue)}).`,
        }],
      };
    }

    return {
      content: [{ type: 'text' as const, text: `Error: Unknown field "${args.field}".` }],
    };
  },
);
