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

  it('keeps the numbering of a list split by sub-bullets or blank lines', () => {
    expect(html('1. Sketch\n   - a rectangle\n   - two circles\n2. Extrude')).toBe('<ol><li>Sketch<ul><li>a rectangle</li><li>two circles</li></ul></li><li>Extrude</li></ol>');
    expect(html('- **Plate**\n  - 100 mm')).toBe('<ul><li><strong>Plate</strong><ul><li>100 mm</li></ul></li></ul>');
    expect(html('1. Sketch\n\n2. Extrude')).toBe('<ol><li>Sketch</li></ol><ol start="2"><li>Extrude</li></ol>');
  });

  it('renders tables, with their columns\' alignment, and leaves lone pipes as text', () => {
    expect(html('Key sizes:\n\n| Feature | Size |\n|---|---:|\n| Plate | **100** × 60 mm |\n| Holes | 4 × Ø5.5 mm |\n\nDone.')).toBe(
      '<p>Key sizes:</p><div class="as-table"><table><thead><tr><th>Feature</th><th style="text-align: right;">Size</th></tr></thead>'
      + '<tbody><tr><td>Plate</td><td style="text-align: right;"><strong>100</strong> × 60 mm</td></tr><tr><td>Holes</td><td style="text-align: right;">4 × Ø5.5 mm</td></tr></tbody></table></div><p>Done.</p>');
    // A row with fewer cells is padded; an escaped pipe stays in its cell.
    expect(html('a | b\n--|--\nx \\| y')).toBe('<div class="as-table"><table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>x | y</td><td></td></tr></tbody></table></div>');
    // Not a table: no rule under the first row, or a different number of columns.
    expect(html('Use A | B here.')).toBe('<p>Use A | B here.</p>');
    expect(html('| a | b |\n|---|\n| 1 | 2 |')).toBe('<p>| a | b |<br>|---|<br>| 1 | 2 |</p>');
    // A long run of spaces after a dash is no slower to reject than any other line.
    const t0 = performance.now();
    html(`a | b\n-${' '.repeat(50000)}x`);
    expect(performance.now() - t0).toBeLessThan(500);
  });
});
