/**
 * Telegram 消息格式化工具。
 *
 * 将 Claude agent 输出的标准 Markdown 转换为 Telegram 支持的 HTML 子集。
 *
 * Telegram 支持的 HTML 标签：
 * <b>, <i>, <u>, <s>, <code>, <pre>, <a>, <blockquote>, <tg-spoiler>
 *
 * @see https://core.telegram.org/bots/api#html-style
 */

/**
 * Telegram 单条消息最大字符数。
 */
const TELEGRAM_MAX_LENGTH = 4096;

/**
 * 转义 HTML 特殊字符。
 *
 * @param text - 原始文本。
 * @returns HTML 安全文本。
 */
function escapeHTML(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * 从 HTML 文本中剥离所有标签，保留纯文本内容。
 * 用于 HTML 解析失败时的 fallback，避免用户看到原始标签。
 *
 * @param html - 包含 HTML 标签的文本。
 * @returns 纯文本。
 */
export function stripHTMLTags(html: string): string {
  return html.replace(/<[^>]+>/g, '');
}

/**
 * 将标准 Markdown 文本转换为 Telegram 支持的 HTML 格式。
 *
 * 处理顺序：
 * 1. 提取代码块（避免内部内容被转换）
 * 2. 提取行内代码
 * 3. 转换其余 Markdown 格式为 HTML
 * 4. 还原代码块和行内代码
 *
 * @param text - Agent 输出的标准 Markdown 文本。
 * @returns Telegram HTML 格式的文本。
 */
export function markdownToTelegramHTML(text: string): string {
  // 用占位符保护代码块和行内代码，避免内部内容被格式化处理。
  const codeBlocks: string[] = [];
  const inlineCodes: string[] = [];

  // 1. 提取围栏代码块 ```lang\ncode\n``` （支持 ``` 后有无换行两种情况）
  let result = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_match, lang, code) => {
    const escaped = escapeHTML(code.replace(/\n$/, '')); // 去掉末尾多余换行
    const langAttr = lang ? ` class="language-${escapeHTML(lang)}"` : '';
    const placeholder = `\x00CODEBLOCK${codeBlocks.length}\x00`;
    codeBlocks.push(`<pre><code${langAttr}>${escaped}</code></pre>`);
    return placeholder;
  });

  // 2. 提取行内代码 `code`
  result = result.replace(/`([^`\n]+)`/g, (_match, code) => {
    const placeholder = `\x00INLINE${inlineCodes.length}\x00`;
    inlineCodes.push(`<code>${escapeHTML(code)}</code>`);
    return placeholder;
  });

  // 3. 对剩余内容做 HTML 转义（在格式化转换之前）
  result = escapeHTML(result);

  // 4. 转换 Markdown 格式为 HTML

  // 标题 → 粗体（Telegram 不支持标题标签）
  result = result.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');

  // 粗斜体 ***text*** 或 ___text___
  // 要求开头 *** 前为行首或非单词字符，结尾 *** 后为行尾或非单词字符
  result = result.replace(/(?<!\w)\*\*\*(.+?)\*\*\*(?!\w)/g, '<b><i>$1</i></b>');
  result = result.replace(/(?<!\w)___(.+?)___(?!\w)/g, '<b><i>$1</i></b>');

  // 粗体 **text** 或 __text__
  // 要求 ** 前后不能紧邻单词字符（避免匹配 2**3 等表达式）
  result = result.replace(/(?<!\w)\*\*(.+?)\*\*(?!\w)/g, '<b>$1</b>');
  result = result.replace(/(?<!\w)__(.+?)__(?!\w)/g, '<b>$1</b>');

  // 斜体 *text* 或 _text_
  // 要求 * 前后不能紧邻单词字符（避免匹配 x*y 等表达式）
  result = result.replace(/(?<!\w)\*(.+?)\*(?!\w)/g, '<i>$1</i>');
  result = result.replace(/(?<!\w)_(.+?)_(?!\w)/g, '<i>$1</i>');

  // 删除线 ~~text~~
  result = result.replace(/~~(.+?)~~/g, '<s>$1</s>');

  // 链接 [text](url)
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // 引用块 > text（连续多行合并为一个 blockquote）
  result = result.replace(/(?:^&gt; .+$\n?)+/gm, (match) => {
    const content = match
      .split('\n')
      .map((line) => line.replace(/^&gt; /, ''))
      .filter((line) => line !== '')
      .join('\n');
    return `<blockquote>${content}</blockquote>`;
  });

  // 无序列表 - item 或 * item → 用 bullet 字符
  result = result.replace(/^[\-\*]\s+(.+)$/gm, '  \u2022 $1');

  // 有序列表 1. item → 保留数字
  result = result.replace(/^(\d+)\.\s+(.+)$/gm, '  $1. $2');

  // 水平线 --- 或 *** 或 ___
  result = result.replace(/^[\-\*_]{3,}$/gm, '\u2500'.repeat(20));

  // 5. 还原行内代码占位符
  for (let i = 0; i < inlineCodes.length; i++) {
    result = result.replace(`\x00INLINE${i}\x00`, inlineCodes[i]);
  }

  // 6. 还原代码块占位符
  for (let i = 0; i < codeBlocks.length; i++) {
    result = result.replace(`\x00CODEBLOCK${i}\x00`, codeBlocks[i]);
  }

  return result.trim();
}

/**
 * 将长文本按 Telegram 消息长度限制切分，保证 HTML 标签完整。
 *
 * 切分逻辑：
 * 1. 优先在换行符处切分
 * 2. 切分后检查每个分片的 HTML 标签是否闭合
 * 3. 如有未闭合标签，在分片末尾补上闭合标签，下一个分片开头补上打开标签
 * 4. 绝不在 <pre> 块内部切分（如果 <pre> 块本身超长则作为独立分片）
 *
 * @param text - 要切分的文本。
 * @param maxLength - 单条消息最大长度。
 * @returns 切分后的文本数组。
 */
export function splitMessage(text: string, maxLength = TELEGRAM_MAX_LENGTH): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // 检查是否在 <pre> 块中——不要在 <pre>...</pre> 中间切分。
    let splitIdx = findSafeSplitPoint(remaining, maxLength);

    const chunk = remaining.slice(0, splitIdx);
    chunks.push(chunk);
    remaining = remaining.slice(splitIdx).replace(/^\n/, '');
  }

  // 修复每个分片的 HTML 标签平衡。
  return repairChunks(chunks);
}

/**
 * 在 maxLength 范围内找到安全的切分点。
 * 避免在 <pre>...</pre> 块中间切分。
 */
function findSafeSplitPoint(text: string, maxLength: number): number {
  // 找到 maxLength 范围内最后一个换行符。
  let splitIdx = text.lastIndexOf('\n', maxLength);
  if (splitIdx <= 0) {
    splitIdx = maxLength;
  }

  // 检查切分点是否在 <pre> 块内部。
  const before = text.slice(0, splitIdx);
  const lastPreOpen = before.lastIndexOf('<pre>');
  const lastPreClose = before.lastIndexOf('</pre>');

  if (lastPreOpen > lastPreClose) {
    // 切分点在 <pre> 块内部。
    // 尝试在 <pre> 标签之前切分。
    const safeIdx = before.lastIndexOf('\n', lastPreOpen);
    if (safeIdx > 0) {
      return safeIdx;
    }
    // 如果 <pre> 之前没有换行符，找到 </pre> 结束位置，把整个 <pre> 块放入当前分片。
    const preEndIdx = text.indexOf('</pre>', splitIdx);
    if (preEndIdx !== -1) {
      const afterPreEnd = preEndIdx + '</pre>'.length;
      // 如果整个 <pre> 块不会太长（2 倍 maxLength 以内），就包含它。
      if (afterPreEnd <= maxLength * 2) {
        return afterPreEnd;
      }
    }
    // 极端情况：<pre> 块本身超长，只能硬切。
  }

  return splitIdx;
}

/**
 * Telegram 使用的 HTML 标签集合（仅需跟踪可嵌套的格式标签）。
 */
const TRACKED_TAGS = ['b', 'i', 'u', 's', 'pre', 'code', 'blockquote'] as const;

/**
 * 修复分片的 HTML 标签平衡。
 *
 * 对每个分片：
 * - 扫描其中的打开/关闭标签
 * - 在末尾补上未闭合的关闭标签
 * - 在下一个分片开头补上对应的打开标签
 */
function repairChunks(chunks: string[]): string[] {
  const result: string[] = [];
  let carryOverTags: string[] = []; // 从上一个分片继承的未闭合打开标签

  for (let i = 0; i < chunks.length; i++) {
    let chunk = chunks[i];

    // 在分片开头补上从上一个分片继承的打开标签。
    if (carryOverTags.length > 0) {
      chunk = carryOverTags.join('') + chunk;
      carryOverTags = [];
    }

    // 扫描当前分片中的标签，找出未闭合的。
    const unclosed = findUnclosedTags(chunk);

    if (unclosed.length > 0 && i < chunks.length - 1) {
      // 在分片末尾补上闭合标签（逆序关闭）。
      const closingTags = unclosed
        .slice()
        .reverse()
        .map((tag) => `</${tag}>`);
      chunk = chunk + closingTags.join('');

      // 为下一个分片准备打开标签。
      carryOverTags = unclosed.map((tag) => {
        // 需要保留原始标签的属性（如 <code class="language-js">）。
        // 从当前分片中找到最后一个该标签的完整打开标签。
        const regex = new RegExp(`<${tag}(\\s[^>]*)?>`, 'g');
        let lastMatch = `<${tag}>`;
        let m;
        while ((m = regex.exec(chunk)) !== null) {
          lastMatch = m[0];
        }
        return lastMatch;
      });
    }

    result.push(chunk);
  }

  return result;
}

/**
 * 扫描 HTML 文本，返回未闭合的标签名列表（按打开顺序）。
 */
function findUnclosedTags(html: string): string[] {
  const tagStack: string[] = [];
  const tagRegex = /<\/?([a-z]+)(\s[^>]*)?>/gi;
  let match;

  while ((match = tagRegex.exec(html)) !== null) {
    const fullMatch = match[0];
    const tagName = match[1].toLowerCase();

    // 只跟踪我们关心的标签。
    if (!TRACKED_TAGS.includes(tagName as (typeof TRACKED_TAGS)[number])) {
      continue;
    }

    if (fullMatch.startsWith('</')) {
      // 关闭标签：从栈中移除最近的匹配打开标签。
      const idx = tagStack.lastIndexOf(tagName);
      if (idx !== -1) {
        tagStack.splice(idx, 1);
      }
    } else {
      // 打开标签。
      tagStack.push(tagName);
    }
  }

  return tagStack;
}
