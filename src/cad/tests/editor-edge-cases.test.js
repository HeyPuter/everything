// @vitest-environment jsdom
/**
 * Edge cases of commands, prompts and grips (degenerate picks, extreme
 * counts, state after cancel), driven headlessly like tests/commands.test.js.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Editor } from '../src/editor/editor.js';
import { Camera } from '../src/render/camera.js';
import { Drawing } from '../src/core/drawing.js';
import { SpatialIndex } from '../src/core/spatial.js';
import { buildRegistry } from '../src/editor/commands/index.js';

globalThis.requestAnimationFrame ??= (cb) => setTimeout(cb, 0);
globalThis.cancelAnimationFrame ??= (id) => clearTimeout(id);

const flush = () => new Promise((r) => setTimeout(r, 0));

function setup() {
  const drawing = new Drawing();
  const index = new SpatialIndex(drawing);
  drawing.on((c) => index.applyChange(c));
  const logs = [];
  const stub = () => {};
  const renderer = {
    setSelection: stub,
    setPreview: stub,
    setDragMatrix: stub,
    setHidden: stub,
    setHover: stub,
    invalidate: stub,
    rebuildAll: stub,
  };
  const camera = new Camera();
  camera.setSize(1000, 800);
  camera.state = { cx: 0, cy: 0, scale: 4 };
  const ui = {
    prompt: stub,
    log: (t, k) => logs.push([k, t]),
    coords: stub,
    input: () => '',
    setInput: stub,
    contextMenu: stub,
    toast: stub,
  };
  const app = {
    clipboard: null,
    undo: () => drawing.undo(),
    redo: () => drawing.redo(),
    pushView: stub,
    zoomPrevious: stub,
  };
  const ed = new Editor({
    el: document.createElement('canvas'),
    renderer,
    camera,
    overlay: { draw: stub },
    ui,
    commands: buildRegistry(),
    app,
  });
  ed.attach({ drawing, index, selection: new Set(), viewStack: [] });
  // The text editor answers once, then an empty entry ends the command.
  const texts = ['Note'];
  ed.editText = async () => texts.shift() ?? null;
  const type = async (...inputs) => {
    for (const s of inputs) {
      ed.submit(s);
      await flush();
    }
  };
  const pick = async (x, y) => {
    const r = ed.request;
    if (!r) throw new Error('No request to answer');
    if (r.kind === 'select') {
      const hit = ed._pick(x, y);
      if (!hit) throw new Error(`Nothing at ${x},${y}`);
      ed.addToSelection([hit.id]);
      return;
    }
    if (r.kind === 'entity') {
      const hit = ed._pick(x, y);
      if (!hit) throw new Error(`Nothing at ${x},${y}`);
      ed._resolve({ id: hit.id, ent: drawing.get(hit.id), x, y });
    } else ed._resolve({ x, y });
    await flush();
  };
  const all = (type) => [...drawing.entities.values()].filter((e) => !type || e.type === type);
  return { ed, drawing, logs, type, pick, all };
}

let t;
beforeEach(() => {
  t = setup();
});

/** Mouse events on the canvas, at a world position. */
const mouse = (type, x, y, init = {}) => {
  const s = t.ed.camera.toScreen(x, y);
  const e = new MouseEvent(type, { clientX: s.x, clientY: s.y, button: 0, bubbles: true, ...init });
  t.ed.el.dispatchEvent(e);
};
const click = async (x, y, init) => {
  mouse('pointermove', x, y, init);
  mouse('pointerdown', x, y, init);
  mouse('pointerup', x, y, init);
  await flush();
};

const base = { layer: '0', color: 256, linetype: 'ByLayer', lineweight: -1, ltscale: 1 };
const add = (e) => t.drawing.transaction('Add', () => t.drawing.add({ ...base, ...e }));

describe('ALIGN', () => {
  it('asks again for a second point on the first instead of scaling by zero or infinity', async () => {
    add({ type: 'line', x1: 0, y1: 0, x2: 10, y2: 0 });
    add({ type: 'circle', cx: 5, cy: 0, r: 2 });
    t.ed.setSelection([1, 2]);
    await t.type('ALIGN', '0,0', '5,5', '0,0');
    expect(t.logs.at(-1)).toEqual(['error', 'The second source point must differ from the first.']);
    await t.type('10,0', '5,5');
    expect(t.logs.at(-1)).toEqual([
      'error',
      'The second destination point must differ from the first.',
    ]);
    await t.type('5,25', 'Y');
    expect(t.ed.busy).toBe(false);
    const l = t.drawing.get(1);
    expect([l.x1, l.y1, l.x2, l.y2].map((v) => Math.round(v * 1e6) / 1e6)).toEqual([5, 5, 5, 25]);
    const c = t.drawing.get(2);
    expect(c.r).toBeCloseTo(4);
    expect(c.cx).toBeCloseTo(5);
    expect(c.cy).toBeCloseTo(15);
  });
});

describe('array sizes', () => {
  const TOO_MANY = ['error', 'That array would create too many objects (limit 200,000).'];
  const lines = (n) => {
    for (let i = 0; i < n; i++) add({ type: 'line', x1: i, y1: 0, x2: i, y2: 10 });
    t.ed.setSelection(t.all().map((e) => e.id));
  };

  it('refuses a COPY Array that would create too many objects and asks again', async () => {
    lines(30);
    await t.type('COPY', '0,0', 'A', '10000');
    expect(t.logs.at(-1)).toEqual(TOO_MANY);
    expect(t.ed.busy).toBe(true);
    await t.type('A', '3', '0,20', '');
    expect(t.ed.busy).toBe(false);
    expect(t.all()).toHaveLength(90);
  });

  it('refuses a polar array that would create too many objects', async () => {
    lines(30);
    await t.type('ARRAYPOLAR', '0,-50', '10000');
    expect(t.logs.at(-1)).toEqual(TOO_MANY);
    expect(t.ed.busy).toBe(false);
    expect(t.all()).toHaveLength(30);
  });
});

describe('TRIM with chosen cutting edges', () => {
  it('leaves an object that does not cross them instead of erasing it', async () => {
    add({ type: 'line', x1: 0, y1: 0, x2: 10, y2: 0 });
    add({ type: 'line', x1: 50, y1: -5, x2: 50, y2: 5 });
    add({ type: 'line', x1: 5, y1: -5, x2: 5, y2: 5 });
    await t.type('TRIM', 'E');
    await t.pick(50, 0);
    await t.type('');
    const steps = t.drawing.undoStack.length;
    // Line 3 crosses line 1 but is not a cutting edge; the edge is far away.
    await t.pick(2, 0);
    expect(t.logs.at(-1)).toEqual(['error', 'That object does not cross a cutting edge.']);
    expect(t.drawing.get(1)).toMatchObject({ x1: 0, x2: 10 });
    expect(t.drawing.undoStack.length).toBe(steps);
    expect(t.ed.busy).toBe(true);
    await t.type('U');
    expect(t.logs.at(-1)).toEqual(['muted', 'Nothing to undo in this command.']);
    await t.type('');
    expect(t.all('line')).toHaveLength(3);
  });

  it('still erases an object nothing crosses when every object is a cutting edge', async () => {
    add({ type: 'line', x1: 0, y1: 0, x2: 10, y2: 0 });
    await t.type('TRIM');
    await t.pick(2, 0);
    await t.type('');
    expect(t.all()).toHaveLength(0);
  });
});

describe('selection window', () => {
  it('does not stay on screen when a command is typed after its first corner', async () => {
    add({ type: 'line', x1: 0, y1: 0, x2: 10, y2: 0 });
    await click(50, 50);
    expect(t.ed.window).not.toBeNull();
    await t.type('LINE');
    expect(t.ed.window).toBeNull();
    await click(20, 20);
    expect(t.ed.request.prompt).toBe('Next point');
    expect(t.ed.window).toBeNull();
  });
});

describe('double click on a grip', () => {
  const text = {
    type: 'text',
    x: 0,
    y: 0,
    h: 5,
    rot: 0,
    value: 'Hello',
    style: 'Standard',
    halign: 'left',
    valign: 'baseline',
    widthFactor: 1,
    oblique: 0,
  };

  it('opens a text double clicked at its insertion point instead of dragging its grip', async () => {
    add(text);
    const opened = [];
    t.ed.ui.editEntity = (id) => opened.push(id);
    const steps = t.drawing.undoStack.length;
    // The first click selects the text; the second lands on the grip that appeared.
    await click(0.5, 0.5);
    expect([...t.ed.selection]).toEqual([1]);
    await click(0.5, 0.5);
    mouse('dblclick', 0.5, 0.5);
    await flush();
    expect(opened).toEqual([1]);
    expect(t.ed.busy).toBe(false);
    expect(t.drawing.undoStack.length).toBe(steps);
  });

  it('opens a selected object without recording a grip edit', async () => {
    add({ type: 'line', x1: 0, y1: 0, x2: 10, y2: 0 });
    const opened = [];
    t.ed.ui.editEntity = (id) => opened.push(id);
    t.ed.setSelection([1]);
    const steps = t.drawing.undoStack.length;
    await click(10, 0);
    expect(t.ed.active?.def.name).toBe('GRIPEDIT');
    await click(10, 0);
    mouse('dblclick', 10, 0);
    await flush();
    expect(opened).toEqual([1]);
    expect(t.ed.busy).toBe(false);
    expect(t.drawing.undoStack.length).toBe(steps);
  });

  it('still places a grip with a second click somewhere else', async () => {
    add({ type: 'line', x1: 0, y1: 0, x2: 10, y2: 0 });
    t.ed.settings.polar = false;
    t.ed.setSelection([1]);
    await click(10, 0);
    await click(20, 5);
    expect(t.ed.busy).toBe(false);
    expect(t.drawing.get(1)).toMatchObject({ x2: 20, y2: 5 });
  });
});

describe('in-place text editing', () => {
  it('is not ended (losing the text) by Enter from the command line', async () => {
    // The request app.editText() installs while its text box is open.
    let settled = null;
    t.ed.editText = () =>
      new Promise((resolve, reject) => {
        t.ed.request = {
          kind: 'text',
          prompt: 'Type the text. Press Enter to finish.',
          opts: {},
          options: [],
          resolve: (v) => resolve((settled = ['resolved', v])),
          reject: (err) => reject((settled = err)),
        };
      });
    await t.type('TEXT', '0,0', '2.5', '0');
    expect(t.ed.request.kind).toBe('text');
    await t.type('', 'abc');
    expect(settled).toBeNull();
    expect(t.ed.request.kind).toBe('text');
    expect(t.ed.busy).toBe(true);
    // Escape still cancels it.
    t.ed.cancel();
    await flush();
    expect(settled).toBeInstanceOf(Error);
    expect(t.ed.busy).toBe(false);
  });
});

describe('dynamic input tooltip', () => {
  it('drops the polar readout once the cursor snaps to an object off the tracking line', async () => {
    let state = null;
    t.ed.overlay.draw = (s) => (state = s);
    add({ type: 'line', x1: 20, y1: 10, x2: 40, y2: 30 });
    await t.type('LINE', '0,0');
    t.ed.cursor.inside = true;
    const lines = (x, y) => {
      const s = t.ed.camera.toScreen(x, y);
      t.ed._updateCursor(s.x, s.y);
      t.ed.drawOverlay(true);
      return state.tooltip.lines;
    };
    expect(lines(30, 0.5)).toEqual(['Next point', 'Polar: 30.0000 < 0']);
    // On the end of the line: an object snap, not a polar point.
    expect(lines(20.3, 10.2)).toEqual(['Next point']);
    expect(t.ed.snap).toMatchObject({ x: 20, y: 10, mode: 'end' });
  });
});

describe('object snap tracking points', () => {
  it('stay acquired while the cursor rests on them, and clear on a second visit', async () => {
    add({ type: 'line', x1: 20, y1: 10, x2: 40, y2: 30 });
    await t.type('LINE');
    const at = t.ed.camera.toScreen(20.2, 10.1);
    const away = t.ed.camera.toScreen(-50, -50);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      t.ed._updateCursor(at.x, at.y);
      vi.advanceTimersByTime(600);
      expect(t.ed.acquired).toHaveLength(1);
      // Small movements over the same point, with pauses, keep it.
      t.ed._updateCursor(at.x + 1, at.y);
      vi.advanceTimersByTime(600);
      t.ed._updateCursor(at.x, at.y + 1);
      vi.advanceTimersByTime(600);
      expect(t.ed.acquired).toHaveLength(1);
      // A pass too short to count changes nothing.
      t.ed._updateCursor(away.x, away.y);
      t.ed._updateCursor(at.x, at.y);
      vi.advanceTimersByTime(100);
      t.ed._updateCursor(away.x, away.y);
      vi.advanceTimersByTime(600);
      expect(t.ed.acquired).toHaveLength(1);
      // Coming back and pausing clears the point.
      t.ed._updateCursor(at.x, at.y);
      vi.advanceTimersByTime(600);
      expect(t.ed.acquired).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('draw order of copies', () => {
  const square = (x, y) => [x, y, 0, x + 10, y, 0, x + 10, y + 10, 0, x, y + 10, 0];
  const fill = (x, y, color) =>
    add({ type: 'hatch', loops: [square(x, y)], pattern: 'SOLID', scale: 1, angle: 0, color });
  // Red under blue, selected top first (as picking or a window may give them).
  const setup2 = () => {
    fill(0, 0, 1);
    fill(5, 5, 5);
    t.ed.setSelection([2, 1]);
  };
  const colors = () => t.all().map((e) => e.color);

  it('COPY, MIRROR and arrays stack copies like the originals', async () => {
    setup2();
    await t.type('COPY', '0,0', '100,0', '');
    expect(colors()).toEqual([1, 5, 1, 5]);
    t.ed.setSelection([2, 1]);
    await t.type('MIRROR', '50,0', '50,10', 'N');
    expect(colors()).toEqual([1, 5, 1, 5, 1, 5]);
    t.ed.setSelection([2, 1]);
    await t.type('ARRAYRECT', '2', '1', '200', '200');
    expect(colors()).toEqual([1, 5, 1, 5, 1, 5, 1, 5]);
  });

  it('blocks and the clipboard keep the order too', async () => {
    setup2();
    await t.type('COPYCLIP');
    await flush();
    expect(t.ed.app.clipboard.entities.map((e) => e.color)).toEqual([1, 5]);
    t.ed.setSelection([2, 1]);
    await t.type('BLOCK', 'B1', '0,0');
    expect(t.drawing.blocks.get('B1').entities.map((e) => e.color)).toEqual([1, 5]);
  });

  it('grip copies keep the order', async () => {
    setup2();
    t.ed._startGripEdit(0, null);
    await flush();
    await t.type('', 'C', '@100,0', 'X');
    expect(t.ed.busy).toBe(false);
    expect(colors()).toEqual([1, 5, 1, 5]);
  });
});

describe('picking overlapping objects', () => {
  const square = (x, y) => [x, y, 0, x + 10, y, 0, x + 10, y + 10, 0, x, y + 10, 0];

  it('picks the fill on top after the draw order was changed', async () => {
    add({ type: 'hatch', loops: [square(0, 0)], pattern: 'SOLID', scale: 1, angle: 0 });
    add({ type: 'hatch', loops: [square(5, 5)], pattern: 'SOLID', scale: 1, angle: 0 });
    expect(t.ed._pick(7, 7).id).toBe(2);
    t.ed.setSelection([1]);
    await t.type('DRAWORDER', 'F');
    expect(t.ed._pick(7, 7).id).toBe(1);
    t.drawing.undo();
    expect(t.ed._pick(7, 7).id).toBe(2);
  });

  it('picks the upper of two coincident lines after the draw order was changed', async () => {
    add({ type: 'line', x1: 0, y1: 0, x2: 10, y2: 0 });
    add({ type: 'line', x1: 0, y1: 0, x2: 10, y2: 0 });
    expect(t.ed._pick(5, 0).id).toBe(2);
    t.ed.setSelection([2]);
    await t.type('DRAWORDER', 'B');
    expect(t.ed._pick(5, 0).id).toBe(1);
  });
});

describe('CUTCLIP', () => {
  it('does not erase from another drawing when the clipboard answers after a switch', async () => {
    add({ type: 'line', x1: 0, y1: 0, x2: 10, y2: 0 });
    const other = new Drawing();
    const index = new SpatialIndex(other);
    other.on((c) => index.applyChange(c));
    other.transaction('Add', () => other.add({ ...base, type: 'circle', cx: 0, cy: 0, r: 5 }));
    let release;
    const clipboard = { writeText: () => new Promise((r) => (release = r)) };
    const had = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true });
    try {
      t.ed.setSelection([1]);
      await t.type('CUTCLIP');
      expect(t.ed.busy).toBe(true);
      // What the app does when another drawing tab is chosen.
      t.ed.cancelAll();
      t.ed.attach({ drawing: other, index, selection: new Set(), viewStack: [] });
      release();
      await flush();
      await flush();
    } finally {
      if (had) Object.defineProperty(navigator, 'clipboard', had);
      else delete navigator.clipboard;
    }
    expect(t.ed.busy).toBe(false);
    expect(other.entities.size).toBe(1);
    expect(other.canUndo).toBe(true);
    expect(other.undoStack).toHaveLength(1);
    // The objects were copied; the first drawing keeps them.
    expect(t.drawing.entities.size).toBe(1);
    expect(t.ed.app.clipboard.entities).toHaveLength(1);
  });
});

describe('Pan tool on touch screens', () => {
  const touch = (type, id, sx, sy) => {
    const e = new MouseEvent(type, { clientX: sx, clientY: sy, button: 0, bubbles: true });
    Object.defineProperties(e, { pointerId: { value: id }, pointerType: { value: 'touch' } });
    t.ed.el.dispatchEvent(e);
  };

  it('does not jump when one finger of a pinch lifts and the other keeps moving', async () => {
    await t.type('PAN');
    touch('pointerdown', 1, 300, 300);
    touch('pointermove', 1, 310, 300);
    expect(t.ed.camera.state.cx).toBeCloseTo(-2.5);
    touch('pointerdown', 2, 500, 300);
    // Both fingers move 100 px to the right: a two-finger pan.
    touch('pointermove', 1, 410, 300);
    touch('pointermove', 2, 600, 300);
    expect(t.ed.camera.state.cx).toBeCloseTo(-27.5);
    touch('pointerup', 1, 410, 300);
    // The remaining finger pans on from where it is: 4 px is one unit.
    touch('pointermove', 2, 604, 300);
    expect(t.ed.camera.state.cx).toBeCloseTo(-28.5);
    touch('pointerup', 2, 604, 300);
    expect(t.ed.panning).toBeNull();
    expect(t.ed.busy).toBe(true);
  });

  it('survives a cancelled finger during the pinch', async () => {
    await t.type('PAN');
    touch('pointerdown', 1, 300, 300);
    touch('pointerdown', 2, 500, 300);
    touch('pointermove', 1, 400, 300);
    touch('pointermove', 2, 600, 300);
    const cx = t.ed.camera.state.cx;
    touch('pointercancel', 2, 600, 300);
    touch('pointermove', 1, 404, 300);
    expect(t.ed.camera.state.cx).toBeCloseTo(cx - 1);
  });
});

describe('Shift+click', () => {
  it('deselects an object clicked on one of its grips instead of dragging the grip', async () => {
    add({ type: 'line', x1: 0, y1: 0, x2: 10, y2: 0 });
    add({ type: 'line', x1: 0, y1: 5, x2: 10, y2: 5 });
    t.ed.setSelection([1, 2]);
    // The middle grip of the first line.
    await click(5, 0, { shiftKey: true });
    expect(t.ed.busy).toBe(false);
    expect([...t.ed.selection]).toEqual([2]);
    // Without Shift a grip is still picked up.
    await click(5, 5);
    expect(t.ed.active?.def.name).toBe('GRIPEDIT');
  });
});

describe('BREAK', () => {
  it('takes @ as the first break point, not the last point of an earlier command', async () => {
    await t.type('LINE', '0,0', '10,0', '');
    await t.type('BREAK');
    await t.pick(5, 0);
    await t.type('@');
    expect(t.ed.busy).toBe(false);
    const xs = t.all('line').map((l) => [l.x1, l.x2]);
    expect(xs).toEqual([
      [0, 5],
      [5, 10],
    ]);
  });
});

describe('zoom extents', () => {
  it('centres a drawing that is a single point instead of zooming in all the way', () => {
    add({ type: 'point', x: 5, y: 7 });
    t.ed.zoomExtents();
    expect(t.ed.camera.state).toEqual({ cx: 5, cy: 7, scale: 4 });
    // Clear of the floating command line and navigation bar, like any extents.
    t.ed.ui.viewInsets = () => ({ top: 0, right: 40, bottom: 80, left: 0 });
    t.ed.zoomExtents();
    const s = t.ed.camera.toScreen(5, 7);
    expect(s.x).toBeCloseTo((1000 - 40) / 2);
    expect(s.y).toBeCloseTo((800 - 80) / 2);
    expect(t.ed.camera.scale).toBe(4);
  });

  it('still fits a drawing with a size', () => {
    add({ type: 'line', x1: 0, y1: 5, x2: 100, y2: 5 });
    t.ed.zoomExtents();
    expect(t.ed.camera.scale).toBeGreaterThan(8);
    expect(t.ed.camera.scale).toBeLessThan(10);
  });
});
