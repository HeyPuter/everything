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
