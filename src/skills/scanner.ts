import { readdirSync, readFileSync, existsSync, statSync } from 'fs';
import { join, resolve, relative } from 'path';
import { homedir } from 'os';
import { getLogger } from '../logger/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** SKILL.md / SKILLSET.md frontmatter 的解析结果。 */
export interface SkillFrontmatter {
  name: string;
  description: string;
  /** frontmatter 中的其他自定义字段。 */
  [key: string]: string;
}

/** 节点类型。 */
export type SkillNodeType = 'skill' | 'skillset';

/** 扫描索引中的单个节点。 */
export interface SkillNode {
  /** 节点类型：skill（叶子）或 skillset（中间）。 */
  type: SkillNodeType;
  /** 相对于 skills root 的路径（用作 load_skillset 的 key）。 */
  path: string;
  /** 磁盘上的绝对路径。 */
  absolutePath: string;
  /** SKILL.md / SKILLSET.md 对应文件的绝对路径。 */
  markdownPath: string;
  /** 从 frontmatter 中解析出的元信息。 */
  frontmatter: SkillFrontmatter;
  /** 直接子节点路径列表（仅 skillset 有值）。 */
  children: string[];
}

/** 完整的 skill 索引。 */
export interface SkillIndex {
  /** path → SkillNode 的映射。 */
  nodes: Map<string, SkillNode>;
  /** 顶层节点路径列表（在所有 roots 中发现的第一级节点）。 */
  topLevel: string[];
}

// ---------------------------------------------------------------------------
// Frontmatter parser
// ---------------------------------------------------------------------------

/**
 * 从 Markdown 文件内容中解析 YAML frontmatter。
 *
 * 支持格式：
 * ```
 * ---
 * name: my-skill
 * description: A useful skill
 * ---
 * ```
 */
export function parseFrontmatter(content: string): SkillFrontmatter {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    return { name: '', description: '' };
  }

  const result: SkillFrontmatter = { name: '', description: '' };
  for (const line of match[1].split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();
    // 去除可能的引号包裹。
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

/** 模块级缓存。 */
let cachedIndex: SkillIndex | null = null;

/**
 * 展开路径中的 ~ 为 homedir。
 */
function expandHome(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return join(homedir(), p.slice(1));
  }
  return p;
}

/**
 * 递归扫描一个目录，将 SKILL.md / SKILLSET.md 节点加入索引。
 *
 * @param dir - 当前扫描的绝对目录路径。
 * @param rootDir - 所属 skill root 的绝对路径（用于计算相对路径）。
 * @param index - 全局索引（会被 mutate）。
 * @param parentPath - 父节点的 path（空字符串表示顶层）。
 */
function scanDir(
  dir: string,
  rootDir: string,
  index: SkillIndex,
  parentPath: string,
): void {
  const log = getLogger();

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    log.warn({ dir }, 'Failed to read skill directory');
    return;
  }

  for (const entry of entries) {
    // 跳过隐藏目录和常见噪音。
    if (entry.startsWith('.') || entry === 'node_modules') continue;

    const entryPath = join(dir, entry);
    let stat;
    try {
      stat = statSync(entryPath);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    const skillMd = join(entryPath, 'SKILL.md');
    const skillsetMd = join(entryPath, 'SKILLSET.md');
    const hasSkill = existsSync(skillMd);
    const hasSkillset = existsSync(skillsetMd);

    if (!hasSkill && !hasSkillset) {
      // 既无 SKILL.md 也无 SKILLSET.md，跳过。
      continue;
    }

    if (hasSkill && hasSkillset) {
      log.warn(
        { dir: entryPath },
        'Directory has both SKILL.md and SKILLSET.md, treating as skillset',
      );
    }

    const nodePath = parentPath ? `${parentPath}/${entry}` : entry;

    // 优先级：SKILLSET.md > SKILL.md（共存时以 skillset 为准）。
    const isSkillset = hasSkillset;
    const mdPath = isSkillset ? skillsetMd : skillMd;
    const mdContent = readFileSync(mdPath, 'utf-8');
    const frontmatter = parseFrontmatter(mdContent);

    // 如果 frontmatter 中没有 name，用目录名作为 fallback。
    if (!frontmatter.name) {
      frontmatter.name = entry;
    }

    const node: SkillNode = {
      type: isSkillset ? 'skillset' : 'skill',
      path: nodePath,
      absolutePath: entryPath,
      markdownPath: mdPath,
      frontmatter,
      children: [],
    };

    // 检查是否和其他 root 的节点路径冲突。
    if (index.nodes.has(nodePath)) {
      log.debug(
        { nodePath, newRoot: rootDir },
        'Skill node path already indexed from another root, skipping',
      );
      continue;
    }

    index.nodes.set(nodePath, node);

    // 如果是顶层节点，加入 topLevel。
    if (!parentPath) {
      index.topLevel.push(nodePath);
    }

    // 如果有 parent，把自己加入 parent 的 children。
    if (parentPath) {
      const parent = index.nodes.get(parentPath);
      if (parent) {
        parent.children.push(nodePath);
      }
    }

    // 如果是 skillset，递归扫描子目录。
    if (isSkillset) {
      scanDir(entryPath, rootDir, index, nodePath);
    }
  }
}

/**
 * 扫描所有配置的 skill 路径，构建完整的 skill 索引。
 *
 * @param paths - 配置的 skill 路径列表（支持 ~ 展开）。
 * @returns 构建好的 SkillIndex。
 */
export function buildSkillIndex(paths: string[]): SkillIndex {
  const log = getLogger();
  const index: SkillIndex = {
    nodes: new Map(),
    topLevel: [],
  };

  for (const rawPath of paths) {
    const absPath = resolve(expandHome(rawPath));
    if (!existsSync(absPath)) {
      log.debug({ path: absPath }, 'Skill path does not exist, skipping');
      continue;
    }
    let stat;
    try {
      stat = statSync(absPath);
    } catch {
      log.warn({ path: absPath }, 'Failed to stat skill path');
      continue;
    }
    if (!stat.isDirectory()) {
      log.warn({ path: absPath }, 'Skill path is not a directory, skipping');
      continue;
    }

    log.debug({ path: absPath }, 'Scanning skill path');
    scanDir(absPath, absPath, index, '');
  }

  log.info(
    { totalNodes: index.nodes.size, topLevel: index.topLevel.length },
    'Skill index built',
  );
  return index;
}

/**
 * 初始化 skill 索引（启动时调用一次）。
 *
 * @param paths - 配置的 skill 路径列表。
 */
export function initSkillIndex(paths: string[]): void {
  cachedIndex = buildSkillIndex(paths);
}

/**
 * 获取当前缓存的 skill 索引。
 *
 * @throws 如果尚未初始化则抛出异常。
 */
export function getSkillIndex(): SkillIndex {
  if (!cachedIndex) {
    throw new Error('Skill index not initialized. Call initSkillIndex() first.');
  }
  return cachedIndex;
}

/**
 * 重建 skill 索引（热重载时使用）。
 *
 * @param paths - 新的路径列表。
 */
export function reloadSkillIndex(paths: string[]): void {
  cachedIndex = buildSkillIndex(paths);
}

/**
 * 重置 skill 索引（测试用）。
 */
export function resetSkillIndex(): void {
  cachedIndex = null;
}

// ---------------------------------------------------------------------------
// Content loaders（供 MCP 工具和 system prompt 使用）
// ---------------------------------------------------------------------------

/**
 * 读取一个 skill/skillset 节点的完整 Markdown 内容。
 */
export function readNodeContent(node: SkillNode): string {
  return readFileSync(node.markdownPath, 'utf-8');
}

/**
 * 为 system prompt 生成顶层 skillset 清单文本。
 *
 * 只包含 topLevel 节点的 name + description + type。
 */
export function formatTopLevelListing(index: SkillIndex): string {
  if (index.topLevel.length === 0) return '';

  const lines: string[] = ['## Available Skill Sets', ''];
  lines.push('Use the `load_skillset` tool to explore and load skill sets on demand.');
  lines.push('');

  for (const path of index.topLevel) {
    const node = index.nodes.get(path);
    if (!node) continue;
    const typeLabel = node.type === 'skillset' ? 'skillset' : 'skill';
    lines.push(`- **${node.frontmatter.name}** (${typeLabel}): ${node.frontmatter.description || 'No description'}`);
  }

  return lines.join('\n');
}

/**
 * 为 load_skillset 工具格式化 skillset 节点的输出。
 *
 * 包含：SKILLSET.md 完整内容 + 子节点列表（name, type, description）。
 */
export function formatSkillsetResponse(node: SkillNode, index: SkillIndex): string {
  const content = readNodeContent(node);
  const lines: string[] = [content];

  if (node.children.length > 0) {
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push('**Children:**');
    lines.push('');
    for (const childPath of node.children) {
      const child = index.nodes.get(childPath);
      if (!child) continue;
      lines.push(`- **${child.frontmatter.name}** (${child.type}): ${child.frontmatter.description || 'No description'}`);
    }
  }

  return lines.join('\n');
}
