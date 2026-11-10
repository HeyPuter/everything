// Board editor review, round 2: routing, selection, connectivity and checks,
// driven through a real PcbEditor in jsdom (no WebGL, so nothing is drawn).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { App } from '../src/app/app.js';
import { setPuterForTests } from '../src/app/puter.js';
import { closeMenus } from '../src/ui/menu.js';
import { placedOf } from '../src/render/pcb-scene.js';
import { mm } from '../src/core/units.js';

async function bootBoard() {
  document.body.innerHTML = '<div id="app"></div><div id="live-region"></div>';
  setPuterForTests(null);
  delete window.puter;
  const app = new App(document.getElementById('app'), { puterTimeout: 10 });
  await app.init();
  app.settings.set('autoRepour', false);
  app.settings.set('onlineDrc', false);
  // jsdom cannot load the kernel; tests that need fills stub these again.
  app.kernel.pours = async () => new Map();
  app.kernel.drc = async () => [];
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
const tracks = (ed) => [...ed.doc.items()].filter((o) => o.t === 'track');

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

describe('routing a trace without a net', () => {
  it('draws more than one segment and extends from its own end in stop mode', async () => {
    ctx = await bootBoard();
    const { app, ed } = ctx;
    expect(app.settings.get('routingMode')).toBe('stop');
    ed.startTool('route');
    ed.tool.corner = 'any';
    ed.tool.click(ev(mm(25), mm(26)));
    ed.tool.click(ev(mm(28), mm(26)));
    ed.tool.click(ev(mm(28), mm(28)));
    expect(tracks(ed)).toHaveLength(2);
    ed.tool.finish();
    // A new trace picks up the end of the first segment and leaves it again.
    ed.tool.click(ev(mm(25), mm(26)));
    ed.tool.click(ev(mm(25), mm(24)));
    expect(tracks(ed)).toHaveLength(3);
  });

  it('reaches a pad and takes its net in stop mode', async () => {
    ctx = await bootBoard();
    const { ed } = ctx;
    const p = padOf(ed, 'R1', '2');
    ed.startTool('route');
    ed.tool.corner = 'any';
    ed.tool.click(ev(p.x + mm(4), p.y));
    ed.tool.click(ev(p.x, p.y));
    const [t] = tracks(ed);
    expect([t.x2, t.y2]).toEqual([p.x, p.y]);
    expect(t.net).toBe('VCC');
    expect(ed.tool.trace).toBeNull();
  });
});

describe('starting a trace', () => {
  it('routes on copper when the current layer is silkscreen', async () => {
    ctx = await bootBoard();
    const { ed } = ctx;
    ed.setActiveLayer('topOverlay');
    ed.startTool('route');
    const p = padOf(ed, 'U1', '1');
    ed.tool.click(ev(p.x, p.y));
    expect(ed.tool.trace.layer).toBe('top');
    expect(ed.tool.trace.net).toBe('GND');
    ed.tool.click(ev(p.x - mm(3), p.y));
    expect(tracks(ed).map((t) => [t.layer, t.net])).toEqual([['top', 'GND']]);
  });

  it('starts on the layer of a surface-mount pad on the other side', async () => {
    ctx = await bootBoard();
    const { ed } = ctx;
    const r1 = [...ed.doc.items()].find((o) => o.designator === 'R1');
    ed.setSelection([r1.id]);
    ed.flipSelection();
    const p = padOf(ed, 'R1', '1');
    expect(p.side).toBe('bottom');
    ed.startTool('route');
    ed.tool.click(ev(p.x, p.y));
    expect(ed.tool.trace.net).toBe('DIS');
    expect(ed.tool.trace.layer).toBe('bottom');
    expect(ed.activeLayer).toBe('bottom');
    ed.tool.finish();
    // A pad on a hidden layer is not picked up.
    ed.setActiveLayer('top');
    ed.setLayerVisible('bottom', false);
    ed.tool.click(ev(p.x, p.y));
    expect(ed.tool.trace.net).toBe('');
    expect(ed.tool.trace.layer).toBe('top');
  });
});

describe('online rule check', () => {
  it('runs again after an edit when automatic repour is off', async () => {
    ctx = await bootBoard();
    const { app, ed } = ctx;
    let runs = 0;
    app.kernel.drc = async () => {
      runs++;
      return [];
    };
    app.settings.set('onlineDrc', true);
    expect(app.settings.get('autoRepour')).toBe(false);
    // Turning the check on runs it once; wait that out.
    await new Promise((r) => setTimeout(r, 800));
    runs = 0;
    const track = { id: 't1', t: 'track', layer: 'top', w: mm(0.25), net: 'VCC' };
    ed.doc.store.transact('Add', (s) =>
      s.add({ ...track, x1: mm(1), y1: mm(1), x2: mm(38), y2: mm(28) }),
    );
    await new Promise((r) => setTimeout(r, 1200));
    expect(runs).toBeGreaterThan(0);
  });
});

describe('hidden layers and selection', () => {
  it('a selection box leaves parts, pads and vias on hidden layers alone', async () => {
    ctx = await bootBoard();
    const { ed } = ctx;
    const r1 = [...ed.doc.items()].find((o) => o.designator === 'R1');
    ed.setSelection([r1.id]);
    ed.flipSelection();
    ed.setSelection([]);
    const pad = { t: 'pad', shape: 'rect', w: mm(1), h: mm(1), num: '' };
    ed.doc.store.transact('Add', (s) => {
      s.add({ ...pad, id: 'bottomPad', side: 'bottom', x: mm(35), y: mm(25) });
      s.add({ ...pad, id: 'topPad', side: 'top', x: mm(37), y: mm(25) });
      s.add({ id: 'via', t: 'via', x: mm(35), y: mm(27), d: mm(0.6), drill: mm(0.3) });
    });
    const box = { minX: mm(26), minY: mm(18), maxX: mm(39), maxY: mm(29) };
    const pick = () => ed.boxSelect(box, true).sort();
    const pour = [...ed.doc.items()].find((o) => o.t === 'pour');
    expect(pour.layer).toBe('bottom');
    expect(pick()).toEqual(['bottomPad', r1.id, pour.id, 'topPad', 'via'].sort());
    ed.setLayerVisible('bottom', false);
    ed.setLayerVisible('bottomOverlay', false);
    // The bottom-side resistor and pad are not drawn any more: they stay unselected.
    expect(pick()).toEqual(['topPad', 'via']);
    expect(ed.pickAll(mm(35), mm(25))).toEqual([]);
    expect(ed.pickAll(mm(37), mm(25)).map((o) => o.id)).toEqual(['topPad']);
    // A via shows on the multi-layer and on every copper layer.
    ed.setLayerVisible('multi', false);
    expect(pick()).toEqual(['topPad', 'via']);
    ed.setActiveLayer('topOverlay');
    ed.setLayerVisible('top', false);
    expect(pick()).toEqual([]);
  });
});

describe('editing a footprint in the library', () => {
  it('moves the ratsnest and the routing targets with the pad', async () => {
    ctx = await bootBoard();
    const { app, ed } = ctx;
    const before = padOf(ed, 'U1', '1');
    expect(ed.copperAt(before.x, before.y, 'top', true)?.net).toBe('GND');
    const u1 = [...ed.doc.items()].find((o) => o.designator === 'U1');
    const def = structuredClone(ed.lib[u1.comp]);
    def.footprint.pads.find((p) => p.num === '1').x -= mm(5);
    app.project.putComponent(def);
    const after = padOf(ed, 'U1', '1');
    expect(after.x).toBe(before.x - mm(5));
    expect(ed.copperAt(after.x, after.y, 'top', true)?.net).toBe('GND');
    expect(ed.copperAt(before.x, before.y, 'top', true)).toBeNull();
    const ends = ed.analysis().ratsnest.flatMap((l) => [`${l.x1},${l.y1}`, `${l.x2},${l.y2}`]);
    expect(ends).toContain(`${after.x},${after.y}`);
    expect(ends).not.toContain(`${before.x},${before.y}`);
  });
});

describe('finishing a trace', () => {
  it('ends on another pad of the same part that lines up with the first', async () => {
    ctx = await bootBoard();
    const { ed } = ctx;
    // Pins 1 and 2 of U1 sit in one column; put them on one net.
    const u1 = [...ed.doc.items()].find((o) => o.designator === 'U1');
    ed.doc.store.transact('Nets', (s) => s.update(u1.id, { padNets: { ...u1.padNets, 1: 'THR' } }));
    const a = padOf(ed, 'U1', '1');
    const b = padOf(ed, 'U1', '2');
    expect(a.x).toBe(b.x);
    ed.startTool('route');
    ed.tool.corner = 'any';
    ed.tool.click(ev(a.x, a.y));
    ed.tool.click(ev(b.x, b.y));
    expect(tracks(ed)).toHaveLength(1);
    expect(ed.tool.trace).toBeNull();
  });
});

describe('unroute all', () => {
  it('removes copper tracks and vias but keeps silkscreen and mechanical lines', async () => {
    ctx = await bootBoard();
    const { ed } = ctx;
    const drawLine = (layer, y) => {
      ed.setActiveLayer(layer);
      ed.startTool('line');
      ed.tool.click(ev(mm(2), y));
      ed.tool.click(ev(mm(8), y));
      ed.endTool();
    };
    drawLine('topOverlay', mm(3));
    drawLine('mech1', mm(4));
    drawLine('top', mm(5));
    ed.doc.store.transact('Add', (s) => {
      s.add({ id: 'v', t: 'via', x: mm(8), y: mm(5), d: mm(0.6), drill: mm(0.3), net: 'VCC' });
      s.add({
        id: 'a',
        t: 'arc',
        layer: 'topOverlay',
        cx: mm(5),
        cy: mm(8),
        r: mm(1),
        a0: 0,
        sweep: 180,
        w: mm(0.15),
      });
    });
    expect(tracks(ed)).toHaveLength(3);
    expect(ed.unrouteNet(null)).toBe(2);
    const left = [...ed.doc.items()].filter((o) => ['track', 'arc', 'via'].includes(o.t));
    expect(left.map((o) => o.layer).sort()).toEqual(['mech1', 'topOverlay', 'topOverlay']);
  });
});

describe('online rule check and pours', () => {
  it('never checks an edited board against fills from before the edit', async () => {
    ctx = await bootBoard();
    const { app, ed } = ctx;
    const pour = [...ed.doc.items()].find((o) => o.t === 'pour');
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // Fills remember the revision they were computed for.
    app.kernel.pours = async () =>
      Object.assign(new Map([[pour.id, [[pour.pts]]]]), { rev: ed.doc.store.revision });
    const stale = [];
    app.kernel.drc = async (doc, lib, { pourFills }) => {
      if (pourFills.rev !== ed.doc.store.revision) stale.push(ed.doc.store.revision);
      return [];
    };
    app.settings.set('autoRepour', true);
    app.settings.set('onlineDrc', true);
    await ed.repour();
    const track = { t: 'track', layer: 'bottom', w: mm(0.25), net: 'VCC', x1: mm(5), x2: mm(9) };
    const add = (id, y) =>
      ed.doc.store.transact('Add', (s) => s.add({ ...track, id, y1: y, y2: y }));
    add('first', mm(5));
    // The repour for the first edit has finished and its rule check is waiting
    // when the second edit arrives.
    await sleep(600);
    add('second', mm(7));
    await sleep(1200);
    expect(stale).toEqual([]);
    expect(ed.pourFills.rev).toBe(ed.doc.store.revision);
  });
});

describe('changing layer while routing', () => {
  const vias = (ed) => [...ed.doc.items()].filter((o) => o.t === 'via');

  it('drops one via when stepping over an inner layer', async () => {
    ctx = await bootBoard();
    const { app, ed } = ctx;
    await app.setCopperLayers(4);
    const p = padOf(ed, 'U1', '1');
    ed.startTool('route');
    ed.tool.click(ev(p.x, p.y));
    ed.tool.click(ev(p.x - mm(3), p.y + mm(2)));
    key(ed, '*');
    key(ed, '*');
    expect(ed.tool.trace.layer).toBe('in2');
    expect(ed.activeLayer).toBe('in2');
    expect(vias(ed)).toHaveLength(1);
    // Backspace takes the via back and returns to the layer the trace came from.
    key(ed, 'Backspace');
    expect(vias(ed)).toHaveLength(0);
    expect(ed.tool.trace.layer).toBe('top');
  });

  it('takes the via back when the trace returns to the layer it left', async () => {
    ctx = await bootBoard();
    const { ed } = ctx;
    const p = padOf(ed, 'U1', '1');
    ed.startTool('route');
    ed.tool.click(ev(p.x, p.y));
    ed.tool.click(ev(p.x - mm(3), p.y + mm(2)));
    key(ed, '*');
    expect(vias(ed)).toHaveLength(1);
    key(ed, '*');
    expect(ed.tool.trace.layer).toBe('top');
    expect(vias(ed)).toHaveLength(0);
    // The trace carries on from the same point on the top layer.
    ed.tool.click(ev(p.x - mm(6), p.y + mm(2)));
    expect(tracks(ed).every((t) => t.layer === 'top')).toBe(true);
  });
});

describe('shelving a pour', () => {
  it('takes its copper off the board at once, without waiting for a repour', async () => {
    ctx = await bootBoard();
    const { ed } = ctx;
    const pour = [...ed.doc.items()].find((o) => o.t === 'pour');
    ed.pourFills = new Map([[pour.id, [[pour.pts]]]]);
    const copper = () => ed.analysis().items.filter((it) => it.pour).length;
    expect(copper()).toBe(1);
    ed.doc.store.transact('Shelve', (s) => s.update(pour.id, { shelved: true }));
    // Exports and the 3D view read the same fills.
    expect(ed.pourFills.has(pour.id)).toBe(false);
    expect(copper()).toBe(0);
  });
});

describe('dragging a component', () => {
  it('does not snap onto its own pads where they were before the move', async () => {
    ctx = await bootBoard();
    const { ed } = ctx;
    const u1 = [...ed.doc.items()].find((o) => o.designator === 'U1');
    const pad = padOf(ed, 'U1', '8');
    const grid = ed.grid;
    expect(pad.y % grid).not.toBe(0);
    ed.setSelection([u1.id]);
    ed.select.dragStart({ ...ev(u1.x, u1.y), sx: 0, sy: 0 });
    // The part's origin passes over the place one of its own pads started at.
    ed.select.drag({ ...ev(pad.x + 2000, pad.y + 2000), sx: 0, sy: 0 });
    ed.select.dragEnd();
    const moved = ed.doc.store.get(u1.id);
    expect([moved.x, moved.y]).toEqual([
      Math.round(pad.x / grid) * grid,
      Math.round(pad.y / grid) * grid,
    ]);
  });
});
