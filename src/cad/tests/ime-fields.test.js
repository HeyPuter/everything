// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { Drawing } from '../src/core/drawing.js';
import { LayerManager } from '../src/ui/layers.js';
import { PropertiesPalette } from '../src/ui/properties.js';
import { commandPalette } from '../src/ui/dialogs.js';
import { buildRegistry } from '../src/editor/commands/index.js';

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
  Element.prototype.scrollIntoView ??= () => {};
  globalThis.requestAnimationFrame ??= (cb) => setTimeout(cb, 0);
});
afterEach(() => document.body.replaceChildren());

const key = (el, k, extra = {}) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra }));

/** Enter confirms the input method's candidate; it must not also finish the field. */
describe('fields leave Enter to an input method that is composing', () => {
  it('layer rename', () => {
    const d = new Drawing();
    d.transaction('l', () => d.setTable('layers', 'Walls', { ...d.layers.get('0'), name: 'Walls' }));
    const renamed = [];
    const lm = new LayerManager({ doc: { drawing: d }, renameLayer: (from, to) => (renamed.push([from, to]), null) });
    document.body.append(lm.el);
    lm.render();
    const btn = [...lm.tbody.querySelectorAll('.lm-name')].find((b) => b.textContent === 'Walls');
    key(btn, 'F2');
    const inp = lm.tbody.querySelector('input[aria-label^="New name"]');
    inp.value = 'かべ';
    key(inp, 'Enter', { isComposing: true });
    key(inp, 'Escape', { keyCode: 229 });
    expect(renamed).toEqual([]);
    expect(inp.isConnected).toBe(true);
    inp.value = '壁';
    key(inp, 'Enter');
    expect(renamed).toEqual([['Walls', '壁']]);
  });

  it('Properties text field', () => {
    const d = new Drawing();
    let id;
    d.transaction('add', () => (id = d.add({ type: 'text', x: 0, y: 0, h: 2.5, rot: 0, value: 'A', style: 'Standard', layer: '0', color: 256, linetype: 'ByLayer', lineweight: -1 }).id));
    const p = new PropertiesPalette({ doc: { drawing: d, selection: new Set([id]) }, camera: {}, run() {} });
    document.body.append(p.el);
    p.render();
    const inp = [...p.el.querySelectorAll('input[type=text]')].find((i) => i.value === 'A');
    inp.focus();
    inp.value = 'にほん';
    key(inp, 'Enter', { isComposing: true });
    expect(d.get(id).value).toBe('A');
    inp.value = '日本';
    key(inp, 'Enter');
    expect(d.get(id).value).toBe('日本');
  });

  it('command search', async () => {
    const ran = [];
    const app = { commands: buildRegistry(), run: (name) => ran.push(name) };
    const done = commandPalette(app);
    const input = document.querySelector('dialog[open] input');
    input.value = 'line';
    input.dispatchEvent(new Event('input'));
    key(input, 'Enter', { isComposing: true });
    expect(document.querySelector('dialog[open]')).not.toBe(null);
    key(input, 'Enter');
    await done;
    expect(ran).toEqual(['LINE']);
  });
});
