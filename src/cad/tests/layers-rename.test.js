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

  it('shows a new layer and its name field even while a search hides it', () => {
    const { d, lm } = manager();
    lm.search.value = 'door';
    lm.search.dispatchEvent(new Event('input'));
    expect(lm.tbody.children.length).toBe(1);
    lm.newLayer();
    expect(d.layers.has('Layer1')).toBe(true);
    expect(lm.search.value).toBe('');
    expect(document.activeElement.getAttribute('aria-label')).toBe('New name for layer Layer1');
  });

  it('keeps a search that matches the new layer', () => {
    const { lm } = manager();
    lm.search.value = 'lay';
    lm.search.dispatchEvent(new Event('input'));
    lm.newLayer();
    expect(lm.search.value).toBe('lay');
    expect(document.activeElement.getAttribute('aria-label')).toBe('New name for layer Layer1');
  });
});
