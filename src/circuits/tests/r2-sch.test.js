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

describe('edits made while a drag is in progress', () => {
  const startDrag = (ed, o) => {
    ed.setSelection([o.id]);
    ed.select.dragStart({ rawX: o.x, rawY: o.y, x: o.x, y: o.y });
    ed.select.drag({ rawX: o.x + mil(300), rawY: o.y, x: o.x + mil(300), y: o.y });
  };
  const bootR3 = async () => {
    app = await boot();
    const ed = withCamera(app.activeEditor);
    const r3 = [...ed.doc.items()].find((o) => o.designator === 'R3');
    return { ed, store: ed.doc.store, r3 };
  };

  it('keeps an undo undone instead of re-applying it when the drag ends', async () => {
    const { ed, store, r3 } = await bootR3();
    store.transact('Value', (s) => s.update(r3.id, { value: '99k' }));
    startDrag(ed, store.get(r3.id));
    expect(ed.select.move).toBeTruthy();
    app.commands.run('edit.undo');
    ed.select.dragEnd();
    expect(store.get(r3.id)).toBe(r3);
    expect(store.canRedo).toBe(true);
    expect(ed.hidden.size).toBe(0);
    store.redo();
    expect(store.get(r3.id).value).toBe('99k');
  });

  it('does not move the wires of a part deleted mid-drag', async () => {
    const { ed, store, r3 } = await bootR3();
    const wires = () => JSON.stringify([...ed.doc.items()].filter((o) => o.t === 'wire'));
    const before = wires();
    startDrag(ed, r3);
    app.commands.run('edit.delete');
    ed.select.dragEnd();
    expect(wires()).toBe(before);
    expect(store.undoLabel).toBe('Delete');
    store.undo();
    expect(store.get(r3.id)).toBe(r3);
  });

  it('still commits an ordinary drag as one step', async () => {
    const { ed, store, r3 } = await bootR3();
    startDrag(ed, r3);
    ed.select.dragEnd();
    expect(store.get(r3.id).x - r3.x).toBe(mil(300));
    expect(store.undoLabel).toBe('Move');
    expect(ed.select.move).toBeNull();
    store.undo();
    expect(store.get(r3.id)).toBe(r3);
  });
});

describe('net labels on a wire', () => {
  it('name the wire without drawing a junction dot on it', () => {
    const r1 = part('R1', 0, 0),
      r2 = part('R2', 1000, 0);
    const objects = [r1, r2, wire(200, 0, 800, 0), label('SIG', 500, 0)];
    const nl = buildNetlist([{ id: 's', objects }], lib);
    expect(nl.byPin.get(`${r1.id}:2`)).toBe('SIG');
    expect(nl.byPin.get(`${r2.id}:1`)).toBe('SIG');
    expect(nl.sheets.get('s').junctions).toEqual([]);
  });

  it('leave the dot of a wire that ends at the same place', () => {
    const r1 = part('R1', 0, 0);
    const objects = [r1, wire(200, 0, 800, 0), wire(500, 0, 500, 300), label('SIG', 500, 0)];
    const nl = buildNetlist([{ id: 's', objects }], lib);
    expect(nl.sheets.get('s').junctions).toEqual([[mil(500), 0]]);
  });
});

describe('pasting many parts', () => {
  it('numbers them in one pass over the project, not one pass per pasted part', async () => {
    app = await boot();
    const ed = withCamera(app.activeEditor);
    const store = ed.doc.store;
    ed.project.ensureComponent(res);
    const N = 40;
    store.transact('Set up', (s) => {
      for (const o of [...ed.doc.items()]) s.remove(o.id);
      for (let i = 0; i < N; i++) s.add(part(`R${i + 1}`, 1000 + i * 600, 1000));
    });
    ed.selectAll();
    const clip = ed.copySelection();
    // Count how often existing parts are looked at while the paste is numbered.
    let reads = 0;
    const sheetObjects = ed.project.sheetObjects.bind(ed.project);
    ed.project.sheetObjects = () =>
      sheetObjects().map((sh) => ({
        ...sh,
        objects: sh.objects.map(
          (o) => new Proxy(o, { get: (t, k) => (k === 'designator' && reads++, t[k]) }),
        ),
      }));
    ed.pasteClip(clip);
    ed.tool.click({ x: mil(1000), y: mil(3000) });
    const names = [...ed.doc.items()].map((o) => o.designator);
    expect(names).toHaveLength(2 * N);
    expect(new Set(names).size).toBe(2 * N);
    expect(ed.selectedObjects().map((o) => o.designator)).toEqual(
      Array.from({ length: N }, (_, i) => `R${N + i + 1}`),
    );
    expect(reads).toBeLessThanOrEqual(4 * N);
    expect(store.undoLabel).toBe('Paste');
  });
});

describe('rotate and mirror keys in drawing tools', () => {
  const press = (ed, key, code) =>
    ed.canvas.dispatchEvent(
      new KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true }),
    );

  it.each(['wire', 'bus', 'line', 'rect', 'circle'])(
    'do not turn the selection left from before the %s tool started',
    async (tool) => {
      app = await boot();
      const ed = withCamera(app.activeEditor);
      const r3 = [...ed.doc.items()].find((o) => o.designator === 'R3');
      ed.setSelection([r3.id]);
      ed.startTool(tool);
      ed.tool.click({ x: mil(1000), y: mil(1000) });
      press(ed, ' ', 'Space');
      press(ed, 'x', 'KeyX');
      press(ed, 'y', 'KeyY');
      expect(ed.doc.store.get(r3.id)).toBe(r3);
      expect(ed.tool.name).not.toBe('select');
    },
  );

  it('still rotate the selection in the select tool', async () => {
    app = await boot();
    const ed = withCamera(app.activeEditor);
    const r3 = [...ed.doc.items()].find((o) => o.designator === 'R3');
    ed.setSelection([r3.id]);
    press(ed, ' ', 'Space');
    expect(ed.doc.store.get(r3.id).rot).toBe(90);
  });
});

describe('ERC: names that touch nothing', () => {
  const power = (net, x, y) => ({
    id: `pw${++n}`,
    t: 'power',
    net,
    style: 'bar',
    x: mil(x),
    y: mil(y),
    rot: 0,
  });
  const check = (objects) => {
    const sheets = [{ id: 's', name: 'Sheet1', objects }];
    return runErc(sheets, lib, buildNetlist(sheets, lib), { requireFootprints: false });
  };
  // R1-R2 carry CLK properly; R3-R4 are meant to, but their label misses the wire.
  const wired = () => [
    part('R1', 0, 0),
    part('R2', 1000, 0),
    wire(200, 0, 800, 0),
    label('CLK', 500, 0),
    part('R3', 0, 1000),
    part('R4', 1000, 1000),
    wire(200, 1000, 800, 1000),
  ];
  const quiet = (list) => list.filter((e) => e.rule !== 'unconnected-pin');

  it('reports a net label beside a wire whose name already exists elsewhere', () => {
    const loose = label('CLK', 500, 1100);
    const list = quiet(check([...wired(), loose]));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ rule: 'floating-label', severity: 'warning', ids: [loose.id] });
    expect(list[0]).toMatchObject({ x: loose.x, y: loose.y, sheetId: 's' });
  });

  it('reports a power port that touches nothing', () => {
    const loose = power('VCC', 500, 1100);
    const list = quiet(check([...wired(), power('VCC', -200, 0), loose]));
    expect(list.map((e) => e.ids)).toEqual([[loose.id]]);
  });

  it('accepts labels and power ports on a wire end, along a wire and directly on a pin', () => {
    const objects = [
      ...wired(),
      label('CLK', 600, 1000),
      label('CLK', 800, 1000),
      power('VCC', -200, 0),
    ];
    expect(quiet(check(objects))).toEqual([]);
  });

  it('accepts a label naming a bus', () => {
    const bus = { id: `b${++n}`, t: 'bus', pts: [0, 2000, 1000, 2000].map(mil) };
    const list = quiet(check([...wired(), bus, label('D[0..7]', 400, 2000)]));
    expect(list.filter((e) => /not attached/.test(e.message))).toEqual([]);
  });

  it('reports a lone label once', () => {
    const loose = label('NOWHERE', 500, 2000);
    const list = quiet(check([...wired(), loose]));
    expect(list.map((e) => e.ids)).toEqual([[loose.id]]);
  });
});

describe('designators of parts being placed', () => {
  it('skip numbers taken on another sheet while the tool was waiting', async () => {
    app = await boot();
    const first = app.activeEditor;
    const sheet1 = first.doc;
    first.placePart(res);
    const waiting = first.tool.template.designator;
    // Same component on a second sheet takes that number first.
    app.addDoc('sch');
    const second = app.activeEditor;
    expect(second.doc).not.toBe(sheet1);
    second.placePart(res);
    second.tool.click({ x: mil(1000), y: mil(1000) });
    expect([...second.doc.items()][0].designator).toBe(waiting);
    app.openDoc(sheet1.id);
    first.tool.click({ x: mil(6000), y: mil(6000) });
    const names = app.project
      .sheetObjects()
      .flatMap((sh) => sh.objects.filter((o) => o.t === 'part').map((o) => o.designator));
    expect(new Set(names).size).toBe(names.length);
  });

  it('reuse the number of a placement that was undone', async () => {
    app = await boot();
    const ed = app.activeEditor;
    ed.placePart(res);
    const des = ed.tool.template.designator;
    ed.tool.click({ x: mil(6000), y: mil(6000) });
    ed.doc.store.undo();
    ed.tool.click({ x: mil(6000), y: mil(6000) });
    expect(ed.selection.size).toBe(0);
    expect([...ed.doc.items()].filter((o) => o.designator === des)).toHaveLength(1);
    expect(ed.tool.template.designator).not.toBe(des);
  });
});
