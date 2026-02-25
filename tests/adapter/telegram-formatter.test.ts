import { describe, it, expect } from 'vitest';
import { markdownToTelegramHTML, splitMessage } from '../../src/adapter/telegram/formatter.js';

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
});
