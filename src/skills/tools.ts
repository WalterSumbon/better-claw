import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { getSkillIndex, readNodeContent, formatSkillsetResponse } from './scanner.js';

/**
 * MCP 工具：load_skillset。
 *
 * 按需加载 skillset（中间节点）或 skill（叶子节点）的内容。
 * - skillset → 返回 SKILLSET.md 内容 + 下一级子节点列表和 frontmatter
 * - skill → 返回 SKILL.md 完整内容
 *
 * 用于树形导航：agent 从 system prompt 中看到顶层列表，
 * 然后逐级调用此工具探索和加载具体 skill。
 */
export const loadSkillsetTool = tool(
  'load_skillset',
  `Load a skill set or skill by path. Use this tool to explore and navigate the skill tree.

- If the target is a **skillset** (intermediate node): returns the SKILLSET.md content plus a list of child nodes (with their names, types, and descriptions).
- If the target is a **skill** (leaf node): returns the full SKILL.md content.

The path is relative (e.g., "deep-learning", "deep-learning/pytorch").
You can discover available top-level skill sets from the system prompt, then drill down using this tool.

Call with path="" or path="." to list all top-level entries.`,
  {
    path: z
      .string()
      .describe(
        'Relative path of the skill or skillset to load (e.g., "deep-learning", "deep-learning/pytorch"). Use empty string or "." to list top-level entries.',
      ),
  },
  async (args) => {
    const index = getSkillIndex();
    const requestedPath = args.path.trim();

    // 特殊情况：空路径或 "." 返回顶层列表。
    if (!requestedPath || requestedPath === '.') {
      if (index.topLevel.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'No skill sets or skills are available. Check the skills.paths configuration.',
            },
          ],
        };
      }

      const lines: string[] = ['**Available Skill Sets:**', ''];
      for (const path of index.topLevel) {
        const node = index.nodes.get(path);
        if (!node) continue;
        lines.push(
          `- **${node.frontmatter.name}** (${node.type}): ${node.frontmatter.description || 'No description'}`,
        );
      }
      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
      };
    }

    // 查找目标节点。
    const node = index.nodes.get(requestedPath);
    if (!node) {
      // 提供有用的错误信息：列出可用的路径前缀。
      const available = [...index.nodes.keys()]
        .filter((p) => p.startsWith(requestedPath.split('/')[0]))
        .slice(0, 10);
      const hint =
        available.length > 0
          ? `\n\nDid you mean one of these?\n${available.map((p) => `- ${p}`).join('\n')}`
          : `\n\nAvailable top-level entries: ${index.topLevel.join(', ')}`;
      return {
        content: [
          {
            type: 'text' as const,
            text: `Skill or skillset not found: "${requestedPath}"${hint}`,
          },
        ],
      };
    }

    // 根据节点类型返回不同内容。
    if (node.type === 'skillset') {
      return {
        content: [
          { type: 'text' as const, text: formatSkillsetResponse(node, index) },
        ],
      };
    }

    // 叶子 skill：返回完整 SKILL.md 内容。
    const skillContent = readNodeContent(node);
    return {
      content: [{ type: 'text' as const, text: skillContent }],
    };
  },
);
