import { describe, it, expect } from 'vitest';
import { colorSliders } from '../src/features/paint/ui-common.js';

function sliders(mode) {
  const commits = [];
  const s = colorSliders({
    mode,
    onCommit: (hex) => commits.push(hex),
    onStart: () => commits.push('start'),
  });
  document.body.replaceChildren(s.el);
  return { s, commits, fields: [...s.el.querySelectorAll('.cs-field')] };
}

describe('Color slider fields', () => {
  it('leaves the color alone when a field is tabbed through without a change', () => {
    for (const mode of ['cmyk', 'hsb', 'gray']) {
      const { s, commits, fields } = sliders(mode);
      s.setColor('#336699');
      for (const f of fields) {
        f.focus();
        f.blur();
      }
      expect(commits, mode).toEqual([]);
      expect(s.values.length).toBeGreaterThan(0);
    }
  });

  it('still applies a typed value', () => {
    const { s, commits, fields } = sliders('cmyk');
    s.setColor('#336699');
    fields[3].focus();
    fields[3].value = '0';
    fields[3].blur();
    expect(commits).toHaveLength(2);
    expect(s.values[3]).toBe(0);
  });
});
