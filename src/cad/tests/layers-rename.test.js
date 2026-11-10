// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { Drawing } from '../src/core/drawing.js';
import { LayerManager } from '../src/ui/layers.js';

function manager() {
  const d = new Drawing();
  d.transaction('layers', () => {
    for (const name of ['Walls', 'Doors']) d.setTable('layers', name, { ...d.layers.get('0'), name });
  });
  const lm = new LayerManager({ doc: { drawing: d } });
  document.body.append(lm.el);
  lm.render();
  const nameBtn = (name) => [...lm.tbody.querySelectorAll('.lm-name')].find((b) => b.textContent === name);
  return { d, lm, nameBtn };
}
const key = (el, k) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

afterEach(() => document.body.replaceChildren());

describe('layer manager', () => {
  it('returns focus to the layer when a rename is cancelled with Escape', () => {
    const { d, lm, nameBtn } = manager();
    nameBtn('Walls').focus();
    key(nameBtn('Walls'), 'F2');
    const inp = lm.tbody.querySelector('input[aria-label^="New name"]');
    expect(document.activeElement).toBe(inp);
    inp.value = 'Partitions';
    key(inp, 'Escape');
    expect([...d.layers.keys()]).toContain('Walls');
    expect(document.activeElement).toBe(nameBtn('Walls'));
  });
});
