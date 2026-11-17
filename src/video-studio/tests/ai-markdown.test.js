import { describe, it, expect } from 'vitest';
import { renderMarkdown, inline, safeHref } from '../src/ui/ai-markdown.js';

const html = (text) => {
  const host = document.createElement('div');
  host.append(...inline(text));
  return host.innerHTML;
};

describe('assistant replies: inline Markdown', () => {
  it('renders code, emphasis and links', () => {
    expect(html('Use `trim` on **this** and *that*')).toBe('Use <code class="md-inline">trim</code> on <strong>this</strong> and <em>that</em>');
    expect(html('a ``b ` c`` d')).toBe('a <code class="md-inline">b ` c</code> d');
    const host = document.createElement('div');
    host.append(...inline('[docs](https://example.com/a)'));
    expect(host.querySelector('a').getAttribute('href')).toBe('https://example.com/a');
    expect(host.textContent).toBe('docs');
  });

  it('code opens with a whole run of backticks, so an unclosed run stays text', () => {
    expect(html('``a` b')).toBe('``a` b');
    expect(html('`a`` b')).toBe('`a`` b');
  });

  it('draws a long run of backticks without stalling', () => {
    const text = `Clip named ${'`'.repeat(3000)} ${'a'.repeat(2500)}`;
    const start = performance.now();
    const host = document.createElement('div');
    host.append(...inline(text));
    expect(performance.now() - start).toBeLessThan(500);
    expect(host.textContent).toBe(text);
  });

  it('never nests links, and shows a linked picture as its name', () => {
    const host = document.createElement('div');
    host.append(...inline('[https://good.example](https://other.example)'));
    expect(host.querySelectorAll('a')).toHaveLength(1);
    expect(host.querySelector('a a')).toBeNull();
    expect(host.querySelector('a').getAttribute('href')).toBe('https://other.example/');
    expect(host.textContent).toBe('https://good.example');

    host.replaceChildren(...inline('[![logo](https://x.example/y.png)](https://e.example)'));
    expect(host.querySelectorAll('a')).toHaveLength(1);
    expect(host.querySelector('a').getAttribute('href')).toBe('https://e.example/');
    expect(host.textContent).toBe('[logo]');
    expect(host.querySelector('img')).toBeNull();
  });

  it('only links to web and mail addresses', () => {
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref('data:text/html,x')).toBeNull();
    expect(safeHref('https://example.com')).toBe('https://example.com/');
    const host = document.createElement('div');
    host.append(...inline('[x](javascript:alert(1))'));
    expect(host.querySelector('a')).toBeNull();
  });
});

describe('assistant replies: blocks', () => {
  it('keeps raw HTML as text', () => {
    const out = renderMarkdown('<img src=x onerror=alert(1)>\n\n# Title\n\n- one\n- two');
    const host = document.createElement('div');
    host.append(out);
    expect(host.querySelector('img')).toBeNull();
    expect(host.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(host.querySelectorAll('li')).toHaveLength(2);
  });
});
