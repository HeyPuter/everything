// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { Drawing } from '../src/core/drawing.js';
import { defaultLayer } from '../src/core/schema.js';
import { App } from '../src/app.js';

const base = { color: 256, linetype: 'ByLayer', lineweight: -1 };

/** Wire a drawing's changes to App.onChange with the rest of the app stubbed out. */
function wire() {
  const d = new Drawing();
  let a, b;
  d.transaction('setup', () => {
    d.setTable('layers', 'A', defaultLayer('A'));
    a = d.add({ ...base, type: 'line', layer: 'A', x1: 0, y1: 0, x2: 1, y2: 0 }).id;
    b = d.add({ ...base, type: 'line', layer: '0', x1: 0, y1: 1, x2: 1, y2: 1 }).id;
  });
  const doc = { drawing: d, selection: new Set([a, b]), index: { applyChange() {} } };
  const fake = {
    doc,
    renderer: { applyChange() {}, setSelection() {} },
    editor: { refreshGrips() {}, drawOverlay() {} },
    scheduleRefresh() {},
    scheduleAutosave() {},
  };
  d.on((change) => App.prototype.onChange.call(fake, doc, change));
  return { d, doc, a, b };
}

describe('selection after edits', () => {
  for (const [what, patch] of [['locked', { locked: true }], ['frozen', { frozen: true }], ['turned off', { on: false }]]) {
    it(`drops objects whose layer is ${what}`, () => {
      const { d, doc, a, b } = wire();
      d.transaction('layer', () => d.setTable('layers', 'A', { ...d.layers.get('A'), ...patch }));
      expect([...doc.selection]).toEqual([b]);
      expect(doc.selection.has(a)).toBe(false);
    });
  }
  it('drops objects moved to a locked layer and deleted objects', () => {
    const { d, doc, a, b } = wire();
    d.transaction('lock', () => d.setTable('layers', 'A', { ...d.layers.get('A'), locked: true }));
    doc.selection = new Set([b]);
    d.transaction('move', () => d.update(b, { layer: 'A' }));
    expect(doc.selection.size).toBe(0);
    doc.selection = new Set([a]);
    d.transaction('erase', () => d.remove(a));
    expect(doc.selection.size).toBe(0);
  });
  it('keeps editable objects selected', () => {
    const { d, doc, a, b } = wire();
    d.transaction('color', () => d.update(a, { color: 1 }));
    d.transaction('layer', () => d.setTable('layers', 'A', { ...d.layers.get('A'), color: 3 }));
    expect([...doc.selection]).toEqual([a, b]);
  });
});
