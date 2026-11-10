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

describe('Markdown links', () => {
  // The sanitizer adds target and rel to web links: compare without them.
  const bare = (html) => html.replace(/ target="_blank" rel="noopener noreferrer"/g, '');
  const read = (md) => bare(markdownToHtml(md));
  const roundTrip = (html) => bare(markdownToHtml(htmlToMarkdown(html)));

  it('leaves underscores and asterisks in addresses alone', () => {
    expect(read('[init](https://github.com/x/y/blob/main/__init__.py)')).toBe('<p><a href="https://github.com/x/y/blob/main/__init__.py">init</a></p>');
    expect(read('[a](https://x.com/_a) and [b](https://x.com/_b)')).toBe('<p><a href="https://x.com/_a">a</a> and <a href="https://x.com/_b">b</a></p>');
    expect(read('[**bold**](https://x.com/a*b*c)')).toBe('<p><a href="https://x.com/a*b*c"><b>bold</b></a></p>');
  });

  it('keeps addresses with parentheses or spaces whole', () => {
    for (const html of ['<p><a href="https://en.wikipedia.org/wiki/Mercury_(planet)">Mercury</a> next</p>', '<p><a href="https://x.com/a b">spaced</a></p>', '<p>see <a href="https://x.com/f(1)(2)">f</a>.</p>']) expect(roundTrip(html)).toBe(html);
    expect(read('[m](https://en.wikipedia.org/wiki/Mercury_(planet))')).toBe('<p><a href="https://en.wikipedia.org/wiki/Mercury_(planet)">m</a></p>');
  });
});

describe('Markdown text that looks like markup', () => {
  it('reads back as the text it was', () => {
    for (const original of ['<p>2026. A great year</p>', '<p>- not a bullet</p>', '<p>+ plus</p>', '<p>1) first</p>', '<p>&gt; not a quote</p>', '<p># not a heading</p>', '<p>---</p>', '<p>~~not struck~~</p>', '<p>line one<br>- line two</p>', '<p>-5 degrees</p>', '<p>v1.2 and 3.14</p>']) {
      expect(markdownToHtml(htmlToMarkdown(original))).toBe(original);
    }
    // Text that needs no escaping gets none.
    expect(htmlToMarkdown('<p>v1.2 costs 3.50 - really</p>')).toBe('v1.2 costs 3.50 - really');
  });
});

describe('Markdown round trips', () => {
  it('keeps italic inside bold, a list\'s first number and code holding a fence', () => {
    expect(markdownToHtml('**bold with *italic* inside** and **more**')).toBe('<p><b>bold with <i>italic</i> inside</b> and <b>more</b></p>');
    for (const original of ['<ol start="3"><li>three</li><li>four</li></ol>', '<ol><li>one</li><li>two</li></ol>', '<pre>before\n```\ninside\n```\nafter</pre>', '<pre>plain code</pre>']) {
      expect(markdownToHtml(htmlToMarkdown(original))).toBe(original);
    }
  });
});
