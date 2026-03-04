import { z } from 'zod';
import { resolve } from 'path';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { agentContext } from '../core/agent-context.js';
import { getUserDir } from '../user/store.js';
import { getSkillIndex, getUserSkillIndex, readNodeContent, formatSkillsetResponse } from './scanner.js';

/**
 * 获取当前 agent 上下文对应的 skill 索引。
 *
 * 如果在 agentContext 内调用，返回该用户的合并索引（全局 + per-user）。
 * 否则返回全局索引。
 */
function getContextSkillIndex() {
  const store = agentContext.getStore();
  if (store?.userId) {
    const userDir = resolve(process.cwd(), getUserDir(store.userId));
    return getUserSkillIndex(store.userId, userDir);
  }
  return getSkillIndex();
}

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

There are two types of nodes in the skill tree:

- **skill** (leaf node): A concrete, self-contained piece of expertise. Loading a skill returns the full SKILL.md content, which you can directly use.
- **skillset** (intermediate/category node): A grouping of related skills and nested skillsets. Loading a skillset returns the SKILLSET.md overview plus a listing of its children (with names, types, and descriptions). You then load a specific child to drill deeper.

Skillsets MUST be loaded via this tool to discover and navigate their children. They cannot be used directly — always drill down to a leaf skill.

The path is relative (e.g., "deep-learning", "deep-learning/pytorch").
You can discover available top-level entries from the system prompt, then drill down using this tool.

Call with path="" or path="." to list all top-level entries.`,
  {
    path: z
      .string()
      .describe(
        'Relative path of the skill or skillset to load (e.g., "deep-learning", "deep-learning/pytorch"). Use empty string or "." to list top-level entries.',
      ),
  },
  async (args) => {
    const index = getContextSkillIndex();
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

      const lines: string[] = [
        '**Available Skill Sets:**',
        '',
        '- **(skill)** — leaf node, directly loadable expertise.',
        '- **(skillset)** — category node, load to see children and navigate deeper.',
        '',
      ];
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
