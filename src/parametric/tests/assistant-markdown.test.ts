// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../src/assistant/markdown';

const html = (src: string) => { const d = document.createElement('div'); d.append(renderMarkdown(src)); return d.innerHTML; };

describe('assistant markdown', () => {
  it('keeps underscores inside names and expressions', () => {
    expect(html('Set hole_dia and plate_w to 5.')).toBe('<p>Set hole_dia and plate_w to 5.</p>');
    expect(html('Use `=Width/2` for _half_ the width.')).toBe('<p>Use <code>=Width/2</code> for <em>half</em> the width.</p>');
  });

  it('never builds markup from the text', () => {
    expect(html('<img src=x onerror=alert(1)> **<b>x</b>**')).toBe('<p>&lt;img src=x onerror=alert(1)&gt; <strong>&lt;b&gt;x&lt;/b&gt;</strong></p>');
  });
});
