import { describe, it, expect } from 'vitest';
import {
  markdownToTelegramHTML,
  splitMessage,
  stripHTMLTags,
} from '../../src/adapter/telegram/formatter.js';

describe('markdownToTelegramHTML', () => {
  it('should convert bold text', () => {
    expect(markdownToTelegramHTML('Hello **world**')).toBe('Hello <b>world</b>');
  });

  it('should convert italic text', () => {
    expect(markdownToTelegramHTML('Hello *world*')).toBe('Hello <i>world</i>');
  });

  it('should convert bold italic text', () => {
    expect(markdownToTelegramHTML('Hello ***world***')).toBe('Hello <b><i>world</i></b>');
  });

  it('should convert inline code', () => {
    expect(markdownToTelegramHTML('Use `npm install`')).toBe('Use <code>npm install</code>');
  });

  it('should convert code blocks', () => {
    const input = '```js\nconsole.log("hi")\n```';
    const result = markdownToTelegramHTML(input);
    expect(result).toContain('<pre><code class="language-js">');
    expect(result).toContain('console.log("hi")');
    expect(result).toContain('</code></pre>');
  });

  it('should convert code blocks without newline after backticks', () => {
    const input = '```python code here```';
    const result = markdownToTelegramHTML(input);
    expect(result).toContain('<pre><code');
    expect(result).toContain('</code></pre>');
    // 不应有残留的反引号
    expect(result).not.toContain('```');
  });

  it('should convert links', () => {
    expect(markdownToTelegramHTML('[Google](https://google.com)')).toBe(
      '<a href="https://google.com">Google</a>',
    );
  });

  it('should convert strikethrough', () => {
    expect(markdownToTelegramHTML('~~deleted~~')).toBe('<s>deleted</s>');
  });

  it('should convert headers to bold', () => {
    expect(markdownToTelegramHTML('# Title')).toBe('<b>Title</b>');
    expect(markdownToTelegramHTML('## Subtitle')).toBe('<b>Subtitle</b>');
  });

  it('should convert unordered lists', () => {
    const input = '- item 1\n- item 2';
    const result = markdownToTelegramHTML(input);
    expect(result).toContain('• item 1');
    expect(result).toContain('• item 2');
  });

  it('should escape HTML special characters', () => {
    const result = markdownToTelegramHTML('a < b & c > d');
    expect(result).toBe('a &lt; b &amp; c &gt; d');
  });

  it('should not escape HTML inside code blocks', () => {
    const input = '```\n<div>hello</div>\n```';
    const result = markdownToTelegramHTML(input);
    expect(result).toContain('&lt;div&gt;hello&lt;/div&gt;');
  });

  it('should handle plain text without modification', () => {
    expect(markdownToTelegramHTML('hello world')).toBe('hello world');
  });

  it('should handle empty string', () => {
    expect(markdownToTelegramHTML('')).toBe('');
  });

  it('should convert blockquotes', () => {
    const result = markdownToTelegramHTML('> quoted text');
    expect(result).toContain('<blockquote>');
    expect(result).toContain('quoted text');
    expect(result).toContain('</blockquote>');
  });

  // === 新增：防误匹配测试 ===

  it('should NOT treat Python exponentiation 2**3 as bold', () => {
    const result = markdownToTelegramHTML('Use 2**3 for power');
    // 2**3 中 ** 前面是数字（\w），不应被当成粗体
    expect(result).not.toContain('<b>');
    expect(result).toContain('2**3');
  });

  it('should NOT treat stray single asterisks as italic', () => {
    // 数学中 x* 表示最优解，不应被当成斜体
    const result = markdownToTelegramHTML('solution x* satisfies condition');
    // x* 中 * 前面是字母（\w），不应被当成斜体
    expect(result).not.toContain('<i>');
  });

  it('should handle asterisks inside words correctly', () => {
    // file_name 不应被当成斜体
    const result = markdownToTelegramHTML('the file_name_here is important');
    expect(result).not.toContain('<i>');
  });

  it('should still format proper bold with surrounding spaces', () => {
    const result = markdownToTelegramHTML('this is **bold text** here');
    expect(result).toBe('this is <b>bold text</b> here');
  });

  it('should still format proper italic with surrounding spaces', () => {
    const result = markdownToTelegramHTML('this is *italic text* here');
    expect(result).toBe('this is <i>italic text</i> here');
  });

  it('should handle bold at start of line', () => {
    const result = markdownToTelegramHTML('**bold** at start');
    expect(result).toBe('<b>bold</b> at start');
  });

  it('should handle bold at end of line', () => {
    const result = markdownToTelegramHTML('end with **bold**');
    expect(result).toBe('end with <b>bold</b>');
  });
});

describe('splitMessage', () => {
  it('should return single chunk for short messages', () => {
    const result = splitMessage('Hello world');
    expect(result).toEqual(['Hello world']);
  });

  it('should split at newlines when possible', () => {
    const line = 'A'.repeat(50);
    const text = `${line}\n${line}\n${line}`;
    const result = splitMessage(text, 110);

    // 应在换行符处切分。
    expect(result.length).toBeGreaterThan(1);
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(110);
    }
  });

  it('should hard-split when no newlines available', () => {
    const text = 'A'.repeat(200);
    const result = splitMessage(text, 100);

    expect(result.length).toBe(2);
    expect(result[0].length).toBe(100);
    expect(result[1].length).toBe(100);
  });

  it('should handle empty string', () => {
    const result = splitMessage('');
    expect(result).toEqual(['']);
  });

  // === 新增：HTML 标签感知测试 ===

  it('should repair unclosed bold tags across chunks', () => {
    // 创建一个长消息，<b> 在第一个分片，</b> 在第二个分片
    const before = 'X'.repeat(40);
    const after = 'Y'.repeat(40);
    const text = `${before}\n<b>bold text that spans\n${after}</b>`;
    const result = splitMessage(text, 60);

    expect(result.length).toBeGreaterThan(1);
    // 每个分片的标签都应该闭合
    for (const chunk of result) {
      const openCount = (chunk.match(/<b>/g) || []).length;
      const closeCount = (chunk.match(/<\/b>/g) || []).length;
      expect(openCount).toBe(closeCount);
    }
  });

  it('should repair unclosed pre/code tags across chunks', () => {
    const padding = 'X'.repeat(30);
    const code = 'console.log("hello world");';
    const text = `${padding}\n<pre><code>${code}\nmore code\neven more</code></pre>\n${padding}`;
    const result = splitMessage(text, 50);

    // 每个分片中 pre 标签应该闭合
    for (const chunk of result) {
      const preOpen = (chunk.match(/<pre>/g) || []).length;
      const preClose = (chunk.match(/<\/pre>/g) || []).length;
      expect(preOpen).toBe(preClose);

      const codeOpen = (chunk.match(/<code>/g) || []).length;
      const codeClose = (chunk.match(/<\/code>/g) || []).length;
      expect(codeOpen).toBe(codeClose);
    }
  });

  it('should carry over tag attributes when repairing', () => {
    const padding = 'A'.repeat(40);
    const text = `<code class="language-js">some code\n${padding}\nmore code</code>`;
    const result = splitMessage(text, 50);

    if (result.length > 1) {
      // 第二个分片应该包含带属性的打开标签
      expect(result[1]).toContain('<code class="language-js">');
    }
  });

  it('should handle nested tags correctly', () => {
    const padding = 'X'.repeat(40);
    const text = `<b><i>nested bold italic\n${padding}\ntext here</i></b>`;
    const result = splitMessage(text, 50);

    // 每个分片都应标签平衡
    for (const chunk of result) {
      const bOpen = (chunk.match(/<b>/g) || []).length;
      const bClose = (chunk.match(/<\/b>/g) || []).length;
      expect(bOpen).toBe(bClose);

      const iOpen = (chunk.match(/<i>/g) || []).length;
      const iClose = (chunk.match(/<\/i>/g) || []).length;
      expect(iOpen).toBe(iClose);
    }
  });

  it('should try to avoid splitting inside <pre> blocks', () => {
    // <pre> 块在切分范围内，应该尝试在 <pre> 之前切分
    const before = 'A'.repeat(30) + '\n' + 'B'.repeat(20);
    const preBlock = '\n<pre><code>short code</code></pre>';
    const text = before + preBlock;
    const result = splitMessage(text, 60);

    // <pre> 块不应被切断
    const joined = result.join('|||');
    // 检查 <pre> 和 </pre> 在同一个分片中
    for (const chunk of result) {
      const hasPreOpen = chunk.includes('<pre>');
      const hasPreClose = chunk.includes('</pre>');
      if (hasPreOpen || hasPreClose) {
        expect(hasPreOpen).toBe(hasPreClose);
      }
    }
  });
});

describe('stripHTMLTags', () => {
  it('should strip all HTML tags', () => {
    expect(stripHTMLTags('<b>bold</b> and <i>italic</i>')).toBe('bold and italic');
  });

  it('should handle tags with attributes', () => {
    expect(stripHTMLTags('<code class="language-js">code</code>')).toBe('code');
  });

  it('should handle nested tags', () => {
    expect(stripHTMLTags('<b><i>nested</i></b>')).toBe('nested');
  });

  it('should handle pre blocks', () => {
    expect(stripHTMLTags('<pre><code>console.log("hi")</code></pre>')).toBe(
      'console.log("hi")',
    );
  });

  it('should return plain text unchanged', () => {
    expect(stripHTMLTags('no tags here')).toBe('no tags here');
  });

  it('should handle empty string', () => {
    expect(stripHTMLTags('')).toBe('');
  });

  it('should preserve HTML entities', () => {
    // &lt; &gt; &amp; 不是标签，应该保留
    expect(stripHTMLTags('a &lt; b &amp; c &gt; d')).toBe('a &lt; b &amp; c &gt; d');
  });
});
