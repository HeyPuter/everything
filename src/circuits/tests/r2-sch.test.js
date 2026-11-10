import { describe, it, expect, afterEach } from 'vitest';
import { App } from '../src/app/app.js';
import { setPuterForTests } from '../src/app/puter.js';
import { Renderer2D } from '../src/render/renderer2d.js';
import { mil } from '../src/core/units.js';
import { buildNetlist } from '../src/model/netlist.js';
import { runErc } from '../src/model/erc.js';
import { findComponent, cloneDef } from '../src/model/library/builtin.js';

async function boot() {
  document.body.innerHTML = '<div id="app"></div><div id="live-region"></div>';
  setPuterForTests(null);
  delete window.puter;
  const app = new App(document.getElementById('app'), { puterTimeout: 10 });
  await app.init();
  await app.openExample();
  return app;
}
function cameraOnly(cssW = 800, cssH = 600) {
  const r = Object.create(Renderer2D.prototype);
  Object.assign(r, {
    view: { cx: 0, cy: 0, scale: 0.01 },
    cssW,
    cssH,
    dpr: 1,
    width: cssW,
    height: cssH,
  });
  r.draw = () => {};
  r.release = () => {};
  r.dispose = () => {};
  r.resize = function resize(w, h, dpr = 1) {
    this.cssW = w;
    this.cssH = h;
    this.dpr = dpr;
  };
  return r;
}
function withCamera(ed) {
  ed.renderer = cameraOnly();
  ed._sized = true;
  ed.canvas.setPointerCapture = () => {};
  ed.canvas.getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    width: 800,
    height: 600,
    right: 800,
    bottom: 600,
  });
  return ed;
}
let app;
afterEach(() => {
  app?.kernel.dispose();
  app = null;
  document.body.innerHTML = '';
});

const res = cloneDef(findComponent('res-0603'));
const lib = { [res.id]: res };
let n = 0;
const part = (designator, x, y, rot = 0, comp = res.id) => ({
  id: `p${++n}`,
  t: 'part',
  comp,
  designator,
  x: mil(x),
  y: mil(y),
  rot,
  uid: `u${n}`,
});
const wire = (...pts) => ({ id: `w${++n}`, t: 'wire', pts: pts.map(mil) });
const label = (text, x, y) => ({ id: `l${++n}`, t: 'label', text, x: mil(x), y: mil(y), rot: 0 });

/** The example's first sheet emptied, with two resistors joined by the given wire. */
async function twoResistors(...wirePts) {
  app = await boot();
  const ed = withCamera(app.activeEditor);
  const store = ed.doc.store;
  ed.project.ensureComponent(res);
  const r1 = part('R1', 1000, 1000),
    r2 = part('R2', 3000, 1000),
    w = wire(...wirePts);
  store.transact('Set up', (s) => {
    for (const o of [...ed.doc.items()]) s.remove(o.id);
    s.add(r1);
    s.add(r2);
    s.add(w);
  });
  const junctions = () => app.project.netlist().sheets.get(ed.doc.id).junctions;
  const pts = () => store.get(w.id)?.pts.map((v) => v / mil(1));
  return { ed, store, r1, r2, w, junctions, pts };
}

describe('wires dragged along with a moved part', () => {
  it('return to a plain wire, without a junction dot, when the part moves away and back', async () => {
    // R1 pin 2 ends at (1200, 1000), R2 pin 1 at (2800, 1000).
    const { ed, r1, junctions, pts } = await twoResistors(1200, 1000, 2800, 1000);
    ed.setSelection([r1.id]);
    ed.nudge(0, mil(100));
    expect(pts()).toEqual([1200, 1100, 1200, 1000, 2800, 1000]);
    ed.nudge(0, -mil(100));
    expect(pts()).toEqual([1200, 1000, 2800, 1000]);
    expect(junctions()).toEqual([]);
  });

  it('are removed when the pin lands on the other end of its wire', async () => {
    const { ed, store, r1, r2, w, junctions, pts } = await twoResistors(1200, 1000, 2800, 1000);
    ed.setSelection([r1.id]);
    ed.nudge(mil(1600), 0);
    expect(store.get(w.id)).toBeUndefined();
    expect(junctions()).toEqual([]);
    const nl = app.project.netlist();
    expect(nl.byPin.get(`${r1.id}:2`)).toBe(nl.byPin.get(`${r2.id}:1`));
    store.undo();
    expect(pts()).toEqual([1200, 1000, 2800, 1000]);
  });

  it('do not keep a stub doubling back when the pin moves past a corner', async () => {
    const { ed, r1, junctions, pts } = await twoResistors(
      1200,
      1000,
      1600,
      1000,
      1600,
      1500,
      2800,
      1500,
      2800,
      1000,
    );
    ed.setSelection([r1.id]);
    // Up to the level of the wire's next run, and past its corner.
    ed.nudge(mil(600), mil(500));
    expect(pts()).toEqual([1800, 1500, 2800, 1500, 2800, 1000]);
    expect(junctions()).toEqual([]);
  });
});
