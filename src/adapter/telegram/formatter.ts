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

  // 1. 提取围栏代码块 ```lang\ncode\n```
  let result = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, lang, code) => {
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
  result = result.replace(/\*\*\*(.+?)\*\*\*/g, '<b><i>$1</i></b>');
  result = result.replace(/___(.+?)___/g, '<b><i>$1</i></b>');

  // 粗体 **text** 或 __text__
  result = result.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  result = result.replace(/__(.+?)__/g, '<b>$1</b>');

  // 斜体 *text* 或 _text_（注意不匹配文件名中的下划线）
  result = result.replace(/\*(.+?)\*/g, '<i>$1</i>');
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
 * 将长文本按 Telegram 消息长度限制切分。
 *
 * 优先在换行符处切分，避免截断一行中间。
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

    // 在 maxLength 范围内寻找最后一个换行符。
    let splitIdx = remaining.lastIndexOf('\n', maxLength);
    if (splitIdx <= 0) {
      // 找不到换行符，直接截断。
      splitIdx = maxLength;
    }

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).replace(/^\n/, '');
  }

  return chunks;
}
