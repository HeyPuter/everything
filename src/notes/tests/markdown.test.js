import { describe, it, expect } from 'vitest';
import { htmlToMarkdown, markdownToHtml } from '../src/lib/markdown.js';

describe('htmlToMarkdown', () => {
  it('converts headings, inline styles and links', () => {
    expect(htmlToMarkdown('<h2>Plan</h2><p>Go <b>now</b> and <i>fast</i>, see <a href="https://x.y">this</a></p>')).toBe('## Plan\n\nGo **now** and *fast*, see [this](https://x.y)');
  });

  it('writes To Do tags as task items', () => {
    const html = '<p><span class="nt-tag" data-tag="todo" data-done="false"></span>Call</p><p><span class="nt-tag" data-tag="todo" data-done="true"></span>Pay</p>';
    expect(htmlToMarkdown(html)).toBe('- [ ] Call\n\n- [x] Pay');
  });

  it('converts nested lists and tables', () => {
    const md = htmlToMarkdown('<ul><li>A<ul><li>A1</li></ul></li><li>B</li></ul><table><tr><th>K</th><th>V</th></tr><tr><td>a</td><td>1</td></tr></table>');
    expect(md).toBe('- A\n  - A1\n- B\n\n| K | V |\n| --- | --- |\n| a | 1 |');
  });

  it('keeps list levels made with Tab (a list nested directly in a list)', () => {
    expect(htmlToMarkdown('<ul><li>one</li><ul><li>two</li><ol><li>deep</li></ol></ul><li>three</li></ul>')).toBe('- one\n  - two\n    1. deep\n- three');
  });

  it('exports the blocks inside <div> containers', () => {
    expect(htmlToMarkdown('<p>Intro</p><div><ol><li>first</li><li>second</li></ol><div>After</div></div>')).toBe('Intro\n\n1. first\n2. second\n\nAfter');
    expect(htmlToMarkdown('<div><h2>T</h2>Some <b>bold</b> text<ul><li>x</li></ul></div>')).toBe('## T\n\nSome **bold** text\n\n- x');
  });

  it('escapes Markdown characters in text', () => {
    expect(htmlToMarkdown('<p>2*3 = 6_x</p>')).toBe('2\\*3 = 6\\_x');
  });
});

describe('markdownToHtml', () => {
  it('converts the common subset', () => {
    const html = markdownToHtml('# Title\n\nSome **bold** and `code`.\n\n- one\n- two\n  - deep\n\n1. first\n\n> quoted\n\n```\nx < y\n```');
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<b>bold</b>');
    expect(html).toContain('<code>code</code>');
    expect(html).toMatch(/<ul><li>one<\/li><li>two<ul><li>deep<\/li><\/ul><\/li><\/ul>/);
    expect(html).toContain('<ol><li>first</li></ol>');
    expect(html).toContain('<blockquote><p>quoted</p></blockquote>');
    expect(html).toContain('<pre>x &lt; y</pre>');
  });

  it('turns task items into To Do tags', () => {
    const html = markdownToHtml('- [ ] open\n- [x] done');
    expect(html).toContain('data-tag="todo" data-done="false"');
    expect(html).toContain('data-done="true"');
  });

  it('reads tables', () => {
    expect(markdownToHtml('| a | b |\n| --- | --- |\n| 1 | 2 |')).toBe('<table><tbody><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></tbody></table>');
  });

  it('never lets markup through', () => {
    const html = markdownToHtml('<script>alert(1)</script> [x](javascript:alert(1))');
    expect(html).not.toMatch(/<script|javascript:/);
  });

  it('round-trips a page through Markdown', () => {
    const original = '<h2>Notes</h2><p>Plain <b>bold</b></p><ul><li>a</li><li>b</li></ul>';
    expect(markdownToHtml(htmlToMarkdown(original))).toBe(original);
  });

  it('keeps escaped Markdown characters literal', () => {
    for (const original of ['<p>*not italic*</p>', '<p>snake_case_name</p>', '<p>see [1](x)</p>', '<p>use `npm` here</p>', '<p>a \\ b</p>']) {
      expect(markdownToHtml(htmlToMarkdown(original))).toBe(original);
    }
    expect(markdownToHtml('`a\\*b` and \\*c\\*')).toBe('<p><code>a\\*b</code> and *c*</p>');
  });
});
