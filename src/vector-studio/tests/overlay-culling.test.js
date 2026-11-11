import { describe, it, expect } from 'vitest';
import { bootApp } from './helpers.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';

const red = { type: 'solid', color: '#ff0000' };
const blue = { type: 'solid', color: '#0000ff' };

describe('selection overlay culling', () => {
  it('draws anchors only for selected objects on screen', () => {
    const app = bootApp();
    app.newDocument();
    const ed = app.editor;
    ed.view.set({ zoom: 1, panX: 0, panY: 0, rotation: 0, width: 1000, height: 800 });
    const on = createPath(rectangle(100, 100, 50, 50), true, { fill: red });
    const off = createPath(rectangle(5000, 5000, 50, 50), true, { fill: red });
    // Off screen, but its out handle reaches back into view.
    const reach = createPath([
      { x: -400, y: 300, ix: -400, iy: 300, ox: 200, oy: 300 },
      { x: -500, y: 400, ix: -500, iy: 400, ox: -500, oy: 400 },
    ], false, { fill: null, stroke: blue });
    ed.doc.transact('t', () => [on, off, reach].forEach((n) => ed.doc.insert(n, ed.targetLayer().id)));
    const view = app.views.get(ed);
    const count = (toolId) => {
      app.setTool(toolId);
      ed.select([on.id, off.id, reach.id]);
      let squares = 0;
      let handles = 0;
      view.octx.fill = (p) => {
        squares += (p?.ops || []).filter((o) => o[0] === 'R').length;
      };
      view.octx.arc = () => handles++;
      view.invalidateOverlay();
      view.renderNow();
      return { squares, handles };
    };
    expect(count('selection').squares).toBe(4);
    // Direct selection: the rectangle's anchors, plus the path whose handle shows on screen.
    expect(count('direct-selection')).toEqual({ squares: 6, handles: 1 });
  });
});
