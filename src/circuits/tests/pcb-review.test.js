// Board editor review: interactive routing, editing and the 3D view, driven
// through a real PcbEditor in jsdom (no WebGL, so the canvas is not drawn).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { App } from '../src/app/app.js';
import { setPuterForTests } from '../src/app/puter.js';
import { closeMenus } from '../src/ui/menu.js';
import { placedOf } from '../src/render/pcb-scene.js';
import { Batch } from '../src/render/batch.js';
import fs from 'node:fs';
import path from 'node:path';
import { createKernel } from '../src/kernel/ops.js';
import { defaultRules } from '../src/model/schema.js';
import { mm } from '../src/core/units.js';

async function bootBoard() {
  document.body.innerHTML = '<div id="app"></div><div id="live-region"></div>';
  setPuterForTests(null);
  delete window.puter;
  const app = new App(document.getElementById('app'), { puterTimeout: 10 });
  await app.init();
  app.settings.set('autoRepour', false);
  app.settings.set('onlineDrc', false);
  await app.openExample();
  app.openDoc(app.project.boards[0].id);
  const ed = app.activeEditor;
  return { app, ed };
}

function padOf(ed, ref, num) {
  const comp = [...ed.doc.items()].find((o) => o.t === 'comp' && o.designator === ref);
  return placedOf(comp, ed.lib, ed.copperCount).pads.find((p) => p.num === num);
}

const ev = (x, y) => ({ x, y, rawX: x, rawY: y });
const key = (ed, combo) => ed.tool.key({ key: combo, preventDefault() {} }, combo);

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

describe('interactive routing', () => {
  it('Backspace over a via returns the trace to the layer it came from', async () => {
    ctx = await bootBoard();
    const { ed } = ctx;
    const p = padOf(ed, 'U1', '1');
    ed.startTool('route');
    ed.tool.click(ev(p.x, p.y));
    ed.tool.click(ev(p.x - 3_000_000, p.y + 2_000_000));
    expect(ed.tool.trace.layer).toBe('top');
    key(ed, '*');
    expect(ed.tool.trace.layer).toBe('bottom');
    expect([...ed.doc.items()].filter((o) => o.t === 'via')).toHaveLength(1);
    key(ed, 'Backspace');
    expect([...ed.doc.items()].filter((o) => o.t === 'via')).toHaveLength(0);
    expect(ed.tool.trace.layer).toBe('top');
    expect(ed.activeLayer).toBe('top');
  });
});

describe('3D view', () => {
  it('opens one viewer when 3 is pressed twice while it loads', async () => {
    ctx = await bootBoard();
    const { app } = ctx;
    // jsdom has no WebGL2, so each viewer that gets created reports it once.
    await Promise.all([app.set3d(true), app.set3d(true)]);
    const notices = [...document.querySelectorAll('.toast')].filter((t) =>
      /needs WebGL2/.test(t.textContent),
    );
    expect(notices).toHaveLength(1);
  });

  it('does not open after it was closed while loading', async () => {
    ctx = await bootBoard();
    const { app } = ctx;
    await Promise.all([app.set3d(true), app.set3d(false)]);
    expect([...document.querySelectorAll('.toast')].some((t) => /WebGL2/.test(t.textContent))).toBe(
      false,
    );
  });
});

/** A WebGL2 stand-in that accepts every call and records uniforms by name. */
function fakeGl() {
  const uniforms = {};
  const target = {
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    getUniformLocation: (_, name) => name,
    uniform1f: (n, v) => {
      uniforms[n] = v;
    },
    uniform3fv: (n, v) => {
      uniforms[n] = [...v];
    },
    isContextLost: () => false,
  };
  const gl = new Proxy(target, {
    get: (t, k) =>
      k in t ? t[k] : typeof k === 'string' && /^[A-Z_0-9]+$/.test(k) ? 1 : () => ({}),
  });
  return { gl, uniforms };
}

describe('3D bottom view', () => {
  it('shows the underside turned over left to right and lit from below', async () => {
    const { createViewer3D } = await import('../src/render/viewer3d.js');
    const { buildBoardScene } = await import('../src/render/mesh3d.js');
    const { gl, uniforms } = fakeGl();
    const canvas = document.createElement('canvas');
    canvas.getContext = () => gl;
    const v = createViewer3D(canvas);
    v.setScene(
      buildBoardScene({ board: { outline: [0, 0, 1e7, 0, 1e7, 1e7, 0, 1e7] }, objects: [] }),
    );
    v.setView('bottom');
    await new Promise((r) => setTimeout(r, 260));
    v.render();
    const { yaw, pitch } = v.camera;
    const rad = (d) => (d * Math.PI) / 180;
    // Camera right vector: +x on screen must be -x in the world from below.
    const right = [-Math.sin(rad(yaw)), Math.cos(rad(yaw))];
    expect(pitch).toBeLessThan(-80);
    expect(right[0]).toBeLessThan(-0.99);
    expect(uniforms.uSide).toBe(-1);
    expect(uniforms.uL0[2]).toBeLessThan(0);
    v.setView('top');
    await new Promise((r) => setTimeout(r, 260));
    v.render();
    expect(uniforms.uSide).toBe(1);
    expect(uniforms.uL0[2]).toBeGreaterThan(0);
    v.dispose();
  });
});

describe('routing and undo', () => {
  it('ends the trace when undo takes back its segments', async () => {
    ctx = await bootBoard();
    const { app, ed } = ctx;
    const p = padOf(ed, 'U1', '1');
    ed.startTool('route');
    ed.tool.click(ev(p.x, p.y));
    ed.tool.click(ev(p.x - 3_000_000, p.y + 2_000_000));
    expect([...ed.doc.items()].filter((o) => o.t === 'track').length).toBeGreaterThan(0);
    app.undo();
    expect([...ed.doc.items()].filter((o) => o.t === 'track')).toHaveLength(0);
    expect(ed.tool.trace).toBeNull();
    // The next click starts a new trace instead of continuing from a removed end.
    ed.tool.click(ev(p.x, p.y));
    expect(ed.tool.trace.pts).toEqual([p.x, p.y]);
  });
});

describe('pour previews', () => {
  it('moving a pour previews its outline, not the fill left at the old place', async () => {
    ctx = await bootBoard();
    const { ed } = ctx;
    const pour = [...ed.doc.items()].find((o) => o.t === 'pour');
    ed.pourFills = new Map([[pour.id, [[pour.pts]]]]);
    const mv = ed.beginMove([pour.id], { x: pour.pts[0], y: pour.pts[1] });
    mv.update(5_000_000, 0);
    const b = new Batch();
    mv.draw(b);
    expect(b.bufs.tri.count).toBe(0);
    expect(b.bufs.seg.count).toBeGreaterThan(0);
    mv.cancel();
    // The board layer itself still draws the committed fill.
    ed._dirtyLayers.add('*');
    ed._rebuildLayers();
    expect(ed.layerBatches.get(pour.layer).bufs.tri.count).toBeGreaterThan(0);
  });
});

describe('layer stack changes', () => {
  it('leaves an inner layer that undo removed', async () => {
    ctx = await bootBoard();
    const { app, ed } = ctx;
    await app.setCopperLayers(4);
    ed.setActiveLayer('in1');
    expect(ed.activeLayer).toBe('in1');
    app.undo();
    expect(ed.copperCount).toBe(2);
    expect(ed.activeLayer).toBe('top');
    ed.startTool('route');
    expect(ed.tool.hint()).toMatch(/Click a pad/);
  });
});

describe('pours and board cutouts', () => {
  it('keeps the edge clearance around a cutout so DRC finds nothing', async () => {
    const wasm = fs.readFileSync(path.resolve(import.meta.dirname, '../src/kernel/kernel.wasm'));
    const kernel = await createKernel(wasm);
    const sq = (x0, y0, x1, y1) => [x0, y0, x1, y0, x1, y1, x0, y1];
    const doc = {
      id: 'b',
      kind: 'pcb',
      name: 'Board',
      board: {
        outline: sq(0, 0, mm(40), mm(30)),
        // Drawn cutouts are stored clockwise.
        cutouts: [[mm(24), mm(9), mm(28), mm(9), mm(28), mm(3), mm(24), mm(3)]],
        origin: { x: 0, y: 0 },
        copper: 2,
        thickness: mm(1.6),
      },
      rules: defaultRules(),
      nets: { GND: {} },
      objects: [
        {
          id: 'p',
          t: 'pour',
          layer: 'bottom',
          net: 'GND',
          pts: sq(mm(1), mm(1), mm(39), mm(29)),
          clearance: mm(0.3),
          removeIslands: false,
        },
      ],
    };
    const fills = await kernel.pours(doc, {});
    expect(fills.get('p')?.length).toBeGreaterThan(0);
    const list = await kernel.drc(doc, {}, { pourFills: fills });
    expect(list.filter((v) => v.rule === 'edge')).toEqual([]);
  });
});
