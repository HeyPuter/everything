// Board editor review, round 2, second pass: drags, drawing tools, layers,
// the kernel worker and the ratsnest, driven through a real PcbEditor in
// jsdom (no WebGL, so nothing is drawn).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { App } from '../src/app/app.js';
import { setPuterForTests } from '../src/app/puter.js';
import { closeMenus } from '../src/ui/menu.js';
import { mm } from '../src/core/units.js';
import { createKernel } from '../src/kernel/ops.js';
import { mstIslands, analyseBoard } from '../src/model/connectivity.js';
import { defaultRules } from '../src/model/schema.js';
import fs from 'node:fs';
import path from 'node:path';

async function bootBoard() {
  document.body.innerHTML = '<div id="app"></div><div id="live-region"></div>';
  setPuterForTests(null);
  delete window.puter;
  const app = new App(document.getElementById('app'), { puterTimeout: 10 });
  await app.init();
  app.settings.set('autoRepour', false);
  app.settings.set('onlineDrc', false);
  // jsdom cannot load the kernel; tests that need it stub these again.
  app.kernel.pours = async () => new Map();
  app.kernel.drc = async () => [];
  await app.openExample();
  app.openDoc(app.project.boards[0].id);
  const ed = app.activeEditor;
  return { app, ed };
}

const ev = (x, y) => ({ x, y, rawX: x, rawY: y });
const compOf = (ed, ref) => [...ed.doc.items()].find((o) => o.t === 'comp' && o.designator === ref);
const press = (ed, key, code, mods = {}) =>
  ed.canvas.dispatchEvent(
    new KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true, ...mods }),
  );

let ctx;
beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  ctx?.app.kernel.dispose();
  ctx = null;
  closeMenus();
  document.body.innerHTML = '';
});

describe('edits made while a board drag is in progress', () => {
  const startDrag = (ed, o) => {
    ed.setSelection([o.id]);
    ed.select.dragStart(ev(o.x, o.y));
    ed.select.drag(ev(o.x + mm(3), o.y));
  };

  it('keeps an undo undone instead of re-applying it when the drag ends', async () => {
    ctx = await bootBoard();
    const { app, ed } = ctx;
    const store = ed.doc.store;
    const r1 = compOf(ed, 'R1');
    store.transact('Value', (s) => s.update(r1.id, { value: '99k' }));
    startDrag(ed, store.get(r1.id));
    expect(ed.select.move).toBeTruthy();
    app.commands.run('edit.undo');
    ed.select.dragEnd();
    expect(store.get(r1.id)).toBe(r1);
    expect(store.canRedo).toBe(true);
    expect(ed.hidden.size).toBe(0);
    store.redo();
    expect(store.get(r1.id).value).toBe('99k');
  });

  it('does not stretch the tracks of a via deleted mid-drag', async () => {
    ctx = await bootBoard();
    const { app, ed } = ctx;
    const store = ed.doc.store;
    const via = {
      id: 'v1',
      t: 'via',
      x: mm(5),
      y: mm(5),
      d: mm(0.8),
      drill: mm(0.4),
      from: 'top',
      to: 'bottom',
    };
    const track = {
      id: 't1',
      t: 'track',
      layer: 'top',
      x1: mm(5),
      y1: mm(5),
      x2: mm(9),
      y2: mm(5),
      w: mm(0.25),
    };
    store.transact('Set up', (s) => {
      s.add(via);
      s.add(track);
    });
    startDrag(ed, via);
    app.commands.run('edit.delete');
    ed.select.dragEnd();
    expect(store.get('v1')).toBeFalsy();
    expect(store.get('t1')).toEqual(track);
    expect(store.undoLabel).toBe('Delete');
    store.undo();
    expect(store.get('v1')).toEqual(via);
  });

  it('still commits an ordinary drag as one step', async () => {
    ctx = await bootBoard();
    const { ed } = ctx;
    const store = ed.doc.store;
    const r1 = compOf(ed, 'R1');
    startDrag(ed, r1);
    ed.select.dragEnd();
    expect(store.get(r1.id).x - r1.x).toBe(mm(3));
    expect(store.undoLabel).toBe('Move');
    expect(ed.select.move).toBeNull();
    expect(ed.hidden.size).toBe(0);
    store.undo();
    expect(store.get(r1.id)).toBe(r1);
  });
});

describe('rotate and flip keys in board drawing tools', () => {
  it.each([
    'line',
    'fill',
    'dim',
    'measure',
    'pour',
    'region',
    'keepout',
    'board',
    'cutout',
    'route',
  ])('do not turn the selection left from before the %s tool started', async (tool) => {
    ctx = await bootBoard();
    const { ed } = ctx;
    const r1 = compOf(ed, 'R1');
    ed.setSelection([r1.id]);
    ed.startTool(tool);
    ed.tool.click(ev(mm(40), mm(40)));
    press(ed, ' ', 'Space');
    press(ed, ' ', 'Space', { shiftKey: true });
    press(ed, 'l', 'KeyL');
    expect(ed.doc.store.get(r1.id)).toBe(r1);
    expect(ed.tool.name).not.toBe('select');
  });

  it.each(['via', 'text'])('do not flip the selection while placing a %s', async (tool) => {
    ctx = await bootBoard();
    const { ed } = ctx;
    const r1 = compOf(ed, 'R1');
    ed.setSelection([r1.id]);
    ed.startTool(tool);
    press(ed, 'l', 'KeyL');
    expect(ed.doc.store.get(r1.id)).toBe(r1);
  });

  it('do not turn the selection while pasting', async () => {
    ctx = await bootBoard();
    const { ed } = ctx;
    const r1 = compOf(ed, 'R1');
    ed.setSelection([r1.id]);
    ed.pasteClip(ed.copySelection());
    press(ed, ' ', 'Space', { shiftKey: true });
    press(ed, 'l', 'KeyL');
    expect(ed.doc.store.get(r1.id)).toBe(r1);
    expect(ed.tool.name).toBe('paste');
  });

  it('still rotate and flip the selection in the select tool', async () => {
    ctx = await bootBoard();
    const { ed } = ctx;
    const r1 = compOf(ed, 'R1');
    ed.setSelection([r1.id]);
    press(ed, ' ', 'Space');
    expect(ed.doc.store.get(r1.id).rot).toBe(((r1.rot || 0) + 90) % 360);
    press(ed, 'l', 'KeyL');
    expect(ed.doc.store.get(r1.id).side).not.toBe(r1.side);
  });
});

describe('copper on hidden layers', () => {
  const setUp = async () => {
    ctx = await bootBoard();
    const { ed } = ctx;
    const y = mm(70);
    ed.doc.store.transact('Set up', (s) => {
      s.add({
        id: 'tb',
        t: 'track',
        layer: 'bottom',
        x1: 0,
        y1: y,
        x2: mm(4),
        y2: y,
        w: mm(0.3),
        net: 'HID',
      });
      s.add({
        id: 'vb',
        t: 'via',
        x: mm(8),
        y,
        d: mm(0.8),
        drill: mm(0.4),
        from: 'top',
        to: 'bottom',
        net: 'VIA',
      });
    });
    return { ed, y };
  };

  it('is not named by the readout or highlighted with Ctrl+click', async () => {
    const { ed, y } = await setUp();
    expect(ed.netUnder(mm(2), y)).toBe('HID');
    ed.setLayerVisible('bottom', false);
    expect(ed.netUnder(mm(2), y)).toBeNull();
    ed.select.click({ ...ev(mm(2), y), ctrl: true });
    expect(ed.highlight).toBeNull();
    // A via shows through the board on the layers still visible.
    expect(ed.netUnder(mm(8), y)).toBe('VIA');
    ed.setLayerVisible('bottom', true);
    ed.select.click({ ...ev(mm(2), y), ctrl: true });
    expect(ed.highlight.net).toBe('HID');
  });

  it('is not named in single layer mode when other layers are hidden', async () => {
    const { ed, y } = await setUp();
    ed.singleLayer = 'hide';
    expect(ed.activeLayer).toBe('top');
    expect(ed.netUnder(mm(2), y)).toBeNull();
    expect(ed.netUnder(mm(8), y)).toBe('VIA');
  });

  it('still gives its net to a via placed on it', async () => {
    const { ed, y } = await setUp();
    ed.setLayerVisible('bottom', false);
    ed.startTool('via');
    ed.tool.click(ev(mm(2), y));
    const via = [...ed.doc.items()].find((o) => o.t === 'via' && o.x === mm(2));
    expect(via.net).toBe('HID');
  });
});

describe('the layers panel', () => {
  const open = async () => {
    ctx = await bootBoard();
    const { app, ed } = ctx;
    app.showPanel('layers');
    const panel = app.panels.layers;
    panel.refresh();
    return { app, ed, panel };
  };

  it('refreshes pad net labels when single layer mode is chosen, as Shift+S does', async () => {
    const { ed, panel } = await open();
    const mode = panel.body.querySelector('select[aria-label="Single layer mode"]');
    clearTimeout(ed._labelTimer);
    let rebuilt = 0;
    ed._rebuildLabels = () => rebuilt++;
    mode.value = 'hide';
    mode.dispatchEvent(new Event('change', { bubbles: true }));
    expect(ed.singleLayer).toBe('hide');
    await new Promise((r) => setTimeout(r, 120));
    expect(rebuilt).toBe(1);
  });

  it('marks the current layer without list-box attributes on plain list items', async () => {
    const { ed, panel } = await open();
    expect(panel.body.querySelectorAll('li[aria-selected]')).toHaveLength(0);
    const current = panel.body.querySelectorAll('li[aria-current="true"]');
    expect(current).toHaveLength(1);
    expect(current[0].textContent).toContain('Top');
    ed.setActiveLayer('bottom');
    expect(panel.body.querySelector('li[aria-current="true"]').textContent).toContain('Bottom');
  });

  it('keeps keyboard focus on the control that was just changed', async () => {
    const { ed, panel } = await open();
    const box = () => panel.body.querySelector('input[aria-label="Show Bottom Layer"]');
    const name = box() ? 'Show Bottom Layer' : null;
    expect(name).toBeTruthy();
    box().focus();
    box().checked = false;
    box().dispatchEvent(new Event('change', { bubbles: true }));
    expect(ed.hiddenLayers.has('bottom')).toBe(true);
    expect(document.activeElement).toBe(box());
    const mode = () => panel.body.querySelector('select[aria-label="Single layer mode"]');
    mode().focus();
    mode().value = 'gray';
    mode().dispatchEvent(new Event('change', { bubbles: true }));
    expect(document.activeElement).toBe(mode());
    expect(mode().value).toBe('gray');
  });
});

describe('a board file with tracks and vias that lack a size', () => {
  const wasm = fs.readFileSync(path.resolve(import.meta.dirname, '../src/kernel/kernel.wasm'));
  const pad = (num, x) => ({ num, x, y: 0, shape: 'rect', w: mm(1), h: mm(1), side: 'top' });
  const lib = {
    r: {
      id: 'r',
      symbol: { pins: [], graphics: [] },
      footprint: { pads: [pad('1', -mm(1.5)), pad('2', mm(1.5))], graphics: [] },
    },
  };
  const comp = (id, x, padNets) => ({
    ...{ id, t: 'comp', comp: 'r', x, y: mm(10), rot: 0, side: 'top', designator: id },
    padNets,
  });
  const track = (id, y, net, w) => ({
    ...{ id, t: 'track', layer: 'top', x1: mm(1), y1: y, x2: mm(8), y2: y, w, net },
  });
  const board = () => ({
    id: 'b',
    kind: 'pcb',
    name: 'Board',
    board: { outline: [0, 0, mm(30), 0, mm(30), mm(20), 0, mm(20)], copper: 2 },
    rules: defaultRules(),
    nets: { GND: {}, SIG: {} },
    objects: [
      comp('R1', mm(5), { 1: 'GND', 2: 'SIG' }),
      comp('R2', mm(20), { 1: 'SIG', 2: 'GND' }),
      // Two tracks of different nets, 0.05 mm apart: a real clearance violation.
      track('t1', mm(2), 'SIG', mm(0.25)),
      track('t2', mm(2.3), 'GND', mm(0.25)),
      // Damaged: no width, no diameter.
      track('bad', mm(5), 'SIG', undefined),
      { id: 'badvia', t: 'via', x: mm(3), y: mm(15), from: 'top', to: 'bottom', net: 'SIG' },
    ],
  });

  it('is still checked against the design rules', async () => {
    const kernel = await createKernel(wasm);
    const list = await kernel.drc(board(), lib);
    const hit = list.find((v) => v.rule === 'clearance' && v.ids.includes('t1'));
    expect(hit?.ids).toContain('t2');
  });

  it('can still be autorouted', async () => {
    const kernel = await createKernel(wasm);
    const res = await kernel.autoroute(board(), lib, { timeLimitMs: 3000 });
    expect(res.routed).toBeGreaterThan(0);
  });
});

describe('the ratsnest of nets with large islands', () => {
  // The implementation before the grid search, kept as the reference.
  function mstIslandsReference(islands) {
    const n = islands.length;
    const inTree = new Uint8Array(n);
    const best = new Float64Array(n).fill(Infinity);
    const bestPair = new Array(n);
    inTree[0] = 1;
    const relax = (from) => {
      const A = islands[from].pts;
      for (let j = 0; j < n; j++) {
        if (inTree[j]) continue;
        const B = islands[j].pts;
        for (const [ax, ay] of A)
          for (const [bx, by] of B) {
            const d = (ax - bx) ** 2 + (ay - by) ** 2;
            if (d < best[j]) {
              best[j] = d;
              bestPair[j] = { x1: ax, y1: ay, x2: bx, y2: by };
            }
          }
      }
    };
    relax(0);
    const out = [];
    for (let k = 1; k < n; k++) {
      let m = -1;
      for (let j = 0; j < n; j++) if (!inTree[j] && (m < 0 || best[j] < best[m])) m = j;
      if (m < 0 || best[m] === Infinity) break;
      inTree[m] = 1;
      out.push(bestPair[m]);
      relax(m);
    }
    return out;
  }

  // Deterministic random numbers (mulberry32).
  const rng = (seed) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  /** Islands of mixed sizes; `step` puts anchors on a coarse grid so that ties abound. */
  function randomIslands(rand, { count, maxSize, span, step, shape }) {
    const int = (n) => Math.floor(rand() * n);
    const islands = [];
    for (let i = 0; i < count; i++) {
      const size = 1 + int(rand() < 0.5 ? maxSize : 6);
      const ox = int(span) * step,
        oy = int(span) * step;
      const spread = 1 + int(shape === 'far' ? 8 : span);
      const pts = [];
      for (let k = 0; k < size; k++) {
        if (shape === 'line') pts.push([ox + int(spread) * step, oy]);
        else if (shape === 'chain' && pts.length && rand() < 0.5)
          pts.push([...pts[pts.length - 1]]);
        else pts.push([ox + int(spread) * step, oy + int(spread) * step]);
      }
      islands.push({ pts });
    }
    return islands;
  }

  it('is the same, pair for pair, as the plain search gives', () => {
    const rand = rng(20261109);
    let big = 0;
    for (let round = 0; round < 260; round++) {
      const shape = ['blob', 'line', 'chain', 'far'][round % 4];
      const opts = {
        count: 2 + Math.floor(rand() * 14),
        maxSize: [60, 150, 400][round % 3],
        span: [6, 40, 3000][Math.floor(rand() * 3)],
        step: [1, 7, 250000, 0.37][Math.floor(rand() * 4)],
        shape,
      };
      const islands = randomIslands(rand, opts);
      if (islands.some((i) => i.pts.length >= 48)) big++;
      expect(mstIslands(islands), JSON.stringify(opts)).toEqual(mstIslandsReference(islands));
    }
    expect(big).toBeGreaterThan(150);
  });

  it('is the same when anchors are missing a coordinate or lie infinitely far away', () => {
    const rand = rng(7);
    for (const bad of [NaN, Infinity, -Infinity]) {
      for (let round = 0; round < 12; round++) {
        const islands = randomIslands(rand, {
          count: 6,
          maxSize: 120,
          span: 30,
          step: 5,
          shape: 'blob',
        });
        islands[round % 6].pts[0] = [bad, 3];
        islands[(round + 2) % 6].pts.push([4, bad]);
        expect(mstIslands(islands)).toEqual(mstIslandsReference(islands));
      }
    }
    const lost = [{ pts: Array.from({ length: 60 }, () => [NaN, NaN]) }, { pts: [[1, 1]] }];
    expect(mstIslands(lost)).toEqual(mstIslandsReference(lost));
  });

  it('compares each anchor of a long routed trace with a few neighbours, not with every anchor', () => {
    // Two parallel traces of 400 segments each, 1 mm apart, on one net.
    const objects = [];
    for (let c = 0; c < 2; c++) {
      for (let i = 0; i < 400; i++) {
        const y = c * mm(1);
        const seg = { x1: i * mm(0.2), y1: y, x2: (i + 1) * mm(0.2), y2: y, w: mm(0.15) };
        objects.push({ id: `t${c}_${i}`, t: 'track', layer: 'top', net: 'GND', ...seg });
      }
    }
    // Count the anchor coordinates read while the ratsnest is worked out.
    let reads = 0;
    const res = analyseBoard({ board: { copper: 2 } }, objects, {});
    const islands = [0, 1].map((c) => ({
      pts: res.items
        .filter((it) => it.y1 === c * mm(1))
        .flatMap((it) => it.anchors)
        .map((p) => new Proxy(p, { get: (t, k) => (k === '0' && reads++, t[k]) })),
    }));
    expect(islands[0].pts).toHaveLength(800);
    const lines = mstIslands(islands);
    expect(lines).toEqual([{ x1: 0, y1: 0, x2: 0, y2: mm(1) }]);
    expect(res.ratsnest).toEqual([{ net: 'GND', ...lines[0] }]);
    // The plain search reads 800 x 800 pairs.
    expect(reads).toBeLessThan(800 * 60);
  });
});
