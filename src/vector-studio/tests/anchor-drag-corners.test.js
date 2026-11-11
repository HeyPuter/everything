import { describe, it, expect } from 'vitest';
import { bootApp } from './helpers.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';

function ev(app, x, y, extra = {}) {
  const s = app.editor.view.toScreen(x, y);
  return { x, y, sx: s.x, sy: s.y, shift: false, alt: false, mod: false, button: 0, pointerType: 'mouse', pressure: 0.5, native: {}, ...extra };
}

describe('dragging anchors with Direct Selection', () => {
  it('keeps the live corners of the moved anchors', () => {
    const app = bootApp();
    const ed = app.newDocument();
    ed.view.set({ zoom: 1, panX: 0, panY: 0, rotation: 0, width: 1000, height: 800 });
    const doc = ed.doc;
    const round = { r: 10, type: 'round' };
    const p = createPath(rectangle(0, 0, 100, 100).map((a, i) => (i === 2 ? { ...a, corner: round } : a)), true);
    doc.transact('Rect', () => doc.insert(p, ed.targetLayer().id));
    // The rounded corner cuts the outline off the anchor: select the path so its anchors show.
    ed.select([p.id]);
    app.setTool('direct-selection');
    const t = app.tool;
    t.onPointerDown(ev(app, 100, 100));
    t.onPointerMove(ev(app, 120, 110));
    t.onPointerMove(ev(app, 150, 120));
    t.onPointerUp(ev(app, 150, 120));
    expect(doc.get(p.id).anchors[2]).toMatchObject({ x: 150, y: 120, corner: round });
    expect(doc.get(p.id).anchors[1].corner).toBeUndefined();
  });
});
