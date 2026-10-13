import { describe, it, expect } from 'vitest';
import { paintSetup } from './panels-paint-helpers.js';
import { transformNodes, nodeBounds } from '../src/model/geometry.js';
import { translate } from '../src/lib/matrix.js';
import { maskEditGroup, maskEditOwner, maskBounds, maskRootNode } from '../src/features/paint/opacity-mask.js';
import { exportSVG } from '../src/features/io/svg-export.js';
import { drawArtwork } from '../src/render/draw.js';
import { viewHooks } from '../src/render/canvas-view.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';

const solid = (color) => ({ type: 'solid', color });

async function masked() {
  const s = await paintSetup();
  const a = s.add({ fill: solid('#ff0000') }, [0, 0, 100, 100]);
  const m = s.add({ fill: solid('#ffffff') }, [10, 10, 50, 50]);
  s.ed.select([a, m]);
  s.app.commands.run('transparency.makeMask');
  // A moved object carries its (linked) mask along.
  s.doc.transact('Move', () => transformNodes(s.doc, [a], translate(5, 0)));
  return { ...s, a, m };
}

describe('Editing opacity masks in place', () => {
  it('opens the mask art in the document, isolated, and stores it back', async () => {
    const { app, ed, doc, a, panel } = await masked();
    const p = panel('transparency');
    expect(app.commands.isEnabled('transparency.editMask')).toBe(true);
    p.maskBtn.click();
    const g = maskEditGroup(doc);
    expect(g).toBeTruthy();
    expect(g.parent).toBe(doc.get(a).parent);
    expect(maskEditOwner(doc).id).toBe(a);
    expect(ed.isolation).toBe(g.id);
    // The art sits where the mask shows (its transform applied).
    expect(nodeBounds(doc, g)).toEqual({ x: 15, y: 10, w: 50, h: 50 });
    expect(doc.get(a).opacityMask.editing).toBe(g.id);
    p.update();
    expect(p.maskBtn.classList.contains('editing')).toBe(true);
    expect(p.maskBtn.getAttribute('aria-pressed')).toBe('true');
    // New art drawn while editing goes into the mask.
    expect(ed.targetLayer().id).toBe(g.id);
    const extra = createPath(rectangle(70, 70, 10, 10), true, { fill: solid('#808080') });
    doc.transact('Draw', () => doc.insert(extra, ed.targetLayer().id));
    // The art only paints through the mask: the canvas skips it and exports hide it.
    const opts = viewHooks.artOptions.reduce((o, f) => f(ed, o) || o, {});
    expect(opts.skip.has(g.id)).toBe(true);
    // ...and the masked result is not faded like the outside of an isolated group.
    expect(viewHooks.dimIsolation.every((f) => f(ed) !== false)).toBe(false);
    // ...except in the mask, which exports the art as edited so far.
    const svg = exportSVG(doc, { rect: { x: 0, y: 0, w: 200, h: 200 } });
    expect(svg.split('#808080').length - 1).toBe(1);
    expect(svg.indexOf('#808080')).toBeLessThan(svg.indexOf('</mask>'));
    const canvas = document.createElement('canvas');
    expect(() => drawArtwork(canvas.getContext('2d'), doc, { scale: 1, hairline: 1 })).not.toThrow();
    // Esc (Exit Isolation Mode) finishes: the edited art is the mask now.
    app.commands.run('object.exitIsolation');
    expect(maskEditGroup(doc)).toBe(null);
    expect(ed.isolation).toBe(null);
    expect([...ed.selection]).toEqual([a]);
    const om = doc.get(a).opacityMask;
    expect(om.editing).toBeUndefined();
    expect(om.transform).toEqual([1, 0, 0, 1, 0, 0]);
    expect(maskBounds(doc, om)).toEqual({ x: 15, y: 10, w: 65, h: 70 });
    expect(maskRootNode(doc, om).type).toBe('group');
    // Undo steps back into editing, then out of it.
    doc.undo();
    expect(maskEditGroup(doc)).toBeTruthy();
    doc.undo();
    doc.undo();
    expect(maskEditGroup(doc)).toBe(null);
    expect(doc.get(a).opacityMask.editing).toBeUndefined();
  });

  it('goes back to the artwork from the object thumbnail and keeps a single shape as the mask root', async () => {
    const { ed, doc, a, panel } = await masked();
    const p = panel('transparency');
    p.maskBtn.click();
    p.update();
    expect(p.objBtn.disabled).toBe(false);
    p.objBtn.click();
    expect(maskEditGroup(doc)).toBe(null);
    expect(maskRootNode(doc, doc.get(a).opacityMask).type).toBe('path');
    expect(ed.selection.has(a)).toBe(true);
  });
});
