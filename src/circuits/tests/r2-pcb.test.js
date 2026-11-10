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
