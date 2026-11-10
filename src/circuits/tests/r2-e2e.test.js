// End-to-end review, round 2: bugs found by driving complete workflows in the
// real app, pinned here through the App and its editors in jsdom.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { App } from '../src/app/app.js';
import { setPuterForTests } from '../src/app/puter.js';
import { closeMenus } from '../src/ui/menu.js';
import { placedOf } from '../src/render/pcb-scene.js';
import { planSync } from '../src/model/sync.js';
import { createKernel } from '../src/kernel/ops.js';
import { buildBom, toCsv } from '../src/io/bom.js';
import { pickAndPlace, unpopulated } from '../src/io/pnp.js';
import { buildFabricationZip } from '../src/io/fabrication.js';
import { unzipSync, strFromU8 } from 'fflate';
import fs from 'node:fs';
import path from 'node:path';

async function boot() {
  document.body.innerHTML = '<div id="app"></div><div id="live-region"></div>';
  setPuterForTests(null);
  delete window.puter;
  const app = new App(document.getElementById('app'), { puterTimeout: 10 });
  await app.init();
  app.settings.set('autoRepour', false);
  app.settings.set('onlineDrc', false);
  // jsdom cannot load the kernel; tests that need fills set them directly.
  app.kernel.pours = async () => new Map();
  app.kernel.drc = async () => [];
  return app;
}

async function bootBoard() {
  const app = await boot();
  await app.openExample();
  app.openDoc(app.project.boards[0].id);
  return { app, ed: app.activeEditor };
}

function padOf(ed, ref, num) {
  const comp = [...ed.doc.items()].find((o) => o.t === 'comp' && o.designator === ref);
  return placedOf(comp, ed.lib, ed.copperCount).pads.find((p) => p.num === num);
}

const count = (ed, t) => [...ed.doc.items()].filter((o) => o.t === t).length;
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

describe('interactive routing over copper pours', () => {
  it('continues a trace after a via onto a layer poured with another net', async () => {
    ctx = await bootBoard();
    const { app, ed } = ctx;
    expect(app.settings.get('routingMode')).toBe('stop');
    // The example's ground plane fills the whole bottom layer.
    const pour = [...ed.doc.items()].find((o) => o.t === 'pour' && o.layer === 'bottom');
    expect(pour.net).toBe('GND');
    ed.pourFills = new Map([[pour.id, [[pour.pts]]]]);
    const p = padOf(ed, 'U1', '2');
    expect(p.net).toBe('THR');
    ed.startTool('route');
    ed.tool.click(ev(p.x, p.y));
    ed.tool.click(ev(p.x - 3_000_000, p.y));
    key(ed, '*');
    expect(ed.tool.trace.layer).toBe('bottom');
    const before = count(ed, 'track');
    ed.tool.click(ev(p.x - 3_000_000, p.y + 5_000_000));
    // The pour is refilled around new copper, so it must not stop the trace.
    expect(count(ed, 'track')).toBeGreaterThan(before);
    const last = [...ed.doc.items()].filter((o) => o.t === 'track').pop();
    expect(last.layer).toBe('bottom');
    expect([last.x2, last.y2]).toEqual([p.x - 3_000_000, p.y + 5_000_000]);
  });

  it('still stops a trace at a pad of another net', async () => {
    ctx = await bootBoard();
    const { ed } = ctx;
    const a = padOf(ed, 'U1', '2');
    const b = padOf(ed, 'U1', '3');
    ed.startTool('route');
    // Started on the pad, so the trace has its net (a trace without one joins what it touches).
    ed.tool.click(ev(a.x, a.y));
    expect(ed.tool.trace.net).toBe(a.net);
    ed.tool.corner = 'any';
    // Straight at the neighbouring pad (net OUT): clipped short of it.
    const path = ed.tool._path(b.x, b.y);
    const end = path.slice(-2);
    expect(Math.hypot(end[0] - b.x, end[1] - b.y)).toBeGreaterThan(100_000);
  });
});

describe('layer changes while routing', () => {
  it('does not stack a second via when the layer is changed twice at one point', async () => {
    ctx = await bootBoard();
    const { ed } = ctx;
    const p = padOf(ed, 'U1', '2');
    ed.startTool('route');
    ed.tool.click(ev(p.x, p.y));
    ed.tool.click(ev(p.x - 3_000_000, p.y));
    key(ed, '*');
    expect(count(ed, 'via')).toBe(1);
    expect(ed.tool.trace.layer).toBe('bottom');
    // Back to the layer the trace came from: the via is not needed after all.
    key(ed, '*');
    expect(ed.tool.trace.layer).toBe('top');
    expect(ed.activeLayer).toBe('top');
    expect(count(ed, 'via')).toBe(0);
    // And the trace still works from there.
    key(ed, '*');
    expect(count(ed, 'via')).toBe(1);
    ed.tool.click(ev(p.x - 3_000_000, p.y + 5_000_000));
    expect([...ed.doc.items()].filter((o) => o.t === 'track').pop().layer).toBe('bottom');
  });

  it('keeps one via while stepping through the inner layers of a four layer board', async () => {
    ctx = await bootBoard();
    const { ed } = ctx;
    ed.doc.store.transact('Layers', (s) => s.update('board', { copper: 4 }));
    const p = padOf(ed, 'U1', '2');
    ed.startTool('route');
    ed.tool.click(ev(p.x, p.y));
    ed.tool.click(ev(p.x - 3_000_000, p.y));
    const seen = [];
    for (let i = 0; i < 3; i++) {
      key(ed, '*');
      seen.push(ed.tool.trace.layer);
      expect(count(ed, 'via')).toBe(1);
    }
    expect(new Set(seen).size).toBe(3);
    key(ed, '*');
    expect(ed.tool.trace.layer).toBe('top');
    expect(count(ed, 'via')).toBe(0);
  });
});

describe('messages for a removed document', () => {
  it('go away with the document instead of pointing into another one', async () => {
    const app = await boot();
    ctx = { app };
    await app.openExample();
    const second = app.addDoc('sch');
    second.store.transact('Add', (s) => s.add({ t: 'wire', pts: [0, 0, 2_540_000, 0] }));
    app.compile();
    const mine = app.panels.messages.items.filter((m) => m.docId === second.id);
    expect(mine.length).toBeGreaterThan(0);
    const others = app.panels.messages.items.length - mine.length;
    app.openDoc(app.project.boards[0].id);
    const board = app.activeEditor;
    let moved = 0;
    board.focusObject = () => moved++;
    app.removeDoc(second.id);
    expect(app.panels.messages.items.filter((m) => m.docId === second.id)).toHaveLength(0);
    expect(app.panels.messages.items).toHaveLength(others);
    // A row that is still on screen for a document that is gone does nothing.
    app.focusMessage(mine[0]);
    expect(moved).toBe(0);
    expect(app.activeEditor).toBe(board);
  });
});

describe('messages across projects', () => {
  it('drops check results when the project is closed or replaced', async () => {
    const app = await boot();
    ctx = { app };
    await app.openExample();
    const sheet = app.activeEditor;
    const part = [...sheet.doc.items()].find((o) => o.t === 'part' && o.designator === 'R1');
    sheet.doc.store.transact('Delete', (s) => s.remove(part.id));
    app.compile();
    expect(app.panels.messages.items.length).toBeGreaterThan(0);
    expect(app.status.querySelector('.msg-count')).not.toBeNull();

    await app.closeProject(true);
    expect(app.panels.messages.items).toHaveLength(0);
    // Nothing is open: no message counts, grid or cursor readout either.
    expect(app.status.querySelector('.msg-count')).toBeNull();
    expect(app.status.textContent).not.toMatch(/Grid/);

    await app.openExample();
    app.panels.messages.set(
      [{ severity: 'error', message: 'x', docId: 'gone', x: 5e7, y: 5e7 }],
      'T',
    );
    await app.openExample();
    expect(app.panels.messages.items).toHaveLength(0);
    expect(app.panels.messages.el.querySelectorAll('.list-row')).toHaveLength(0);
  });
});

describe('editors whose WebGL context was dropped', () => {
  // Browsers keep about 16 WebGL contexts and drop the oldest for good, so
  // with many documents open the first ones come back as blank canvases.
  const lostRenderer = () => ({
    gl: { isContextLost: () => true },
    view: { cx: 1, cy: 2, scale: 3 },
    resize() {},
    release() {},
    dispose() {},
  });

  it('rebuilds a sheet editor when its tab is shown again', async () => {
    const app = await boot();
    ctx = { app };
    await app.openExample();
    const sheet = app.project.sheets[0];
    const board = app.project.boards[0];
    const first = app.activeEditor;
    app.openDoc(board.id);
    first.renderer = lostRenderer();
    app.openDoc(sheet.id);
    const again = app.activeEditor;
    expect(again).not.toBe(first);
    expect(first.disposed).toBe(true);
    expect(first.el.isConnected).toBe(false);
    expect(again.doc).toBe(sheet);
    expect(again.el.isConnected).toBe(true);
    expect(again.el.hidden).toBe(false);
    expect([...app.editors.values()].filter((e) => e.doc === sheet)).toHaveLength(1);
    // The document and its undo history are untouched.
    again.doc.store.transact('Add', (s) => s.add({ t: 'junction', x: 0, y: 0 }));
    expect(app.commands.get('edit.undo').enabled()).toBe(true);
  });

  it('leaves editors with a working canvas alone', async () => {
    const app = await boot();
    ctx = { app };
    await app.openExample();
    const first = app.activeEditor;
    app.openDoc(app.project.boards[0].id);
    app.openDoc(app.project.sheets[0].id);
    expect(app.activeEditor).toBe(first);
    expect(first.disposed).toBe(false);
  });
});

describe('long press on a touch screen', () => {
  const touchEvent = (type, x, y) => {
    const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
    Object.defineProperty(e, 'pointerId', { value: 7 });
    Object.defineProperty(e, 'pointerType', { value: 'touch' });
    return e;
  };

  afterEach(() => vi.useRealTimers());

  it('does not choose the menu item that opens under the finger when it lifts', async () => {
    const app = await boot();
    ctx = { app };
    await app.openExample();
    const ed = app.activeEditor;
    ed.canvas.setPointerCapture = () => {};
    const before = JSON.stringify([...ed.doc.items()]);
    ed.selectAll();
    const toasts = document.querySelectorAll('.toast').length;
    vi.useFakeTimers();
    ed.canvas.dispatchEvent(touchEvent('pointerdown', 200, 200));
    vi.advanceTimersByTime(700);
    const menu = document.querySelector('[role="menu"]');
    expect(menu).not.toBeNull();
    const item = [...menu.querySelectorAll('.menu-item')].find((b) => !b.disabled);
    // The finger lifts where it pressed, now over the menu; browsers that do
    // not treat the long press as their own gesture follow up with a click.
    ed.canvas.dispatchEvent(touchEvent('pointerup', 200, 200));
    item.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    expect(document.querySelectorAll('.toast')).toHaveLength(toasts);
    expect(JSON.stringify([...ed.doc.items()])).toBe(before);
    // A tap on an item after that is a real choice.
    vi.advanceTimersByTime(400);
    item.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });
});

describe('sizes typed into the board dialogs', () => {
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const dialog = () => [...document.querySelectorAll('.dialog')].pop();
  const fieldOf = (label) => {
    const l = [...dialog().querySelectorAll('label')].find((x) => x.textContent === label);
    return dialog().querySelector(`#${l.getAttribute('for')}`);
  };
  const apply = async () => {
    dialog().querySelector('button.primary').click();
    await tick();
  };

  it('refuses design rules that are negative, zero sizes or a via hole wider than the via', async () => {
    ctx = await bootBoard();
    const { app, ed } = ctx;
    const before = JSON.stringify(ed.doc.rules);
    const cases = [
      ['Track width (preferred)', '-0.25'],
      ['Track width (preferred)', '0'],
      ['Track width (minimum)', '0'],
      ['Copper clearance', '-0.2'],
      ['Via diameter', '0'],
      ['Via hole', '0'],
      ['Via hole', '5'],
      ['Copper to board edge', '-1'],
      ['Thermal relief spoke width', '0'],
    ];
    for (const [label, value] of cases) {
      const done = app.editRules();
      fieldOf(label).value = value;
      await apply();
      expect(dialog(), `${label} = ${value}`).toBeTruthy();
      expect(dialog().querySelector('[role="alert"]').textContent, `${label} = ${value}`).not.toBe(
        '',
      );
      expect(JSON.stringify(ed.doc.rules)).toBe(before);
      dialog().querySelector('[aria-label="Close dialog"]').click();
      await done;
    }
    // Zero clearances and negative mask or paste expansion are legitimate.
    const done = app.editRules();
    fieldOf('Copper to board edge').value = '0';
    fieldOf('Paste expansion').value = '-0.05';
    fieldOf('Track width (minimum)').value = '0.1';
    await apply();
    await done;
    expect(dialog()).toBeUndefined();
    expect(ed.doc.rules.edgeClearance).toBe(0);
    expect(ed.doc.rules.pasteExpansion).toBe(-50_000);
    expect(ed.doc.rules.minTrackWidth).toBe(100_000);
  });

  it('keeps focus on the rule that needs correcting', async () => {
    ctx = await bootBoard();
    const { app } = ctx;
    // Let the dialog place its initial focus before using it.
    const settled = () => new Promise((r) => setTimeout(r, 40));
    for (const fromTab of ['Clearances and sizes', 'Net classes']) {
      const done = app.editRules();
      await settled();
      const field = fieldOf('Via diameter');
      field.value = 'abc';
      [...dialog().querySelectorAll('[role="tab"]')].find((t) => t.textContent === fromTab).click();
      await apply();
      // Focus left on the page behind would also take Escape away from the dialog.
      expect(field.isConnected, fromTab).toBe(true);
      expect(document.activeElement, fromTab).toBe(field);
      expect(field.getAttribute('aria-invalid')).toBe('true');
      expect(dialog().querySelector('[role="alert"]').textContent).toMatch(/Via diameter/);
      dialog().querySelector('[aria-label="Close dialog"]').click();
      await done;
    }
    const done = app.editRules();
    await settled();
    fieldOf('Via hole').value = '2';
    await apply();
    expect(document.activeElement).toBe(fieldOf('Via hole'));
    dialog().querySelector('[aria-label="Close dialog"]').click();
    await done;
  });

  it('refuses a board thickness of zero or less', async () => {
    ctx = await bootBoard();
    const { app, ed } = ctx;
    const before = ed.doc.board.thickness;
    for (const value of ['0', '-1.6']) {
      const done = app.editLayerStack();
      fieldOf('Board thickness').value = value;
      await apply();
      expect(dialog(), value).toBeTruthy();
      expect(fieldOf('Board thickness').getAttribute('aria-invalid')).toBe('true');
      expect(ed.doc.board.thickness).toBe(before);
      dialog().querySelector('[aria-label="Close dialog"]').click();
      await done;
    }
    const done = app.editLayerStack();
    fieldOf('Board thickness').value = '0.8';
    await apply();
    await done;
    expect(ed.doc.board.thickness).toBe(800_000);
  });
});

describe('text field borders', () => {
  // Specificity of a simple selector list entry: [classes and attributes, types].
  const specificity = (sel) => {
    const inner = sel.replace(/:not\(([^)]*)\)/g, ' $1 ');
    const b = (inner.match(/\.[\w-]+|\[[^\]]*\]|:(?!not)[\w-]+/g) || []).length;
    const c = (inner.replace(/\.[\w-]+|\[[^\]]*\]|:[\w-]+/g, ' ').match(/[a-z][\w-]*/gi) || [])
      .length;
    return b * 100 + c;
  };
  const css = fs.readFileSync(path.resolve(__dirname, '../src/styles/app.css'), 'utf8');
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selectors: m[1]
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(',')
      .map((x) => x.trim()),
    body: m[2],
  }));
  const strongest = (test, scope) =>
    Math.max(
      ...rules
        .filter((r) => test(r.body))
        .flatMap((r) => r.selectors.filter((x) => x.startsWith(scope) && / input/.test(x)))
        .map(specificity),
    );

  it.each(['.dialog', '.prop-grid'])(
    'show focus and a refused value on %s text inputs',
    (scope) => {
      // The resting border comes from a selector with a chain of :not(); the
      // focus and invalid borders must outweigh it, or the field never changes.
      const base = strongest((b) => /border:\s*1px solid var\(--border-strong\)/.test(b), scope);
      const focus = strongest((b) => /border-color:\s*var\(--focus\)/.test(b), scope);
      const invalid = strongest((b) => /border-color:\s*var\(--danger\)/.test(b), scope);
      expect(base).toBeGreaterThan(0);
      expect(focus).toBeGreaterThan(base);
      expect(invalid).toBeGreaterThan(base);
      expect(invalid).toBeGreaterThanOrEqual(focus);
    },
  );
});

describe('pour copper in exported files', () => {
  // A kernel that takes a moment, like the real worker, and counts its runs.
  async function bootSlowPours() {
    const app = await boot();
    app.settings.set('autoRepour', true);
    let runs = 0;
    app.kernel.pours = (doc) =>
      new Promise((resolve) => {
        const n = ++runs;
        const fills = new Map(
          doc.objects.filter((o) => o.t === 'pour').map((o) => [o.id, [[o.pts]]]),
        );
        fills.run = n;
        fills.tracks = doc.objects.filter((o) => o.t === 'track').length;
        setTimeout(() => resolve(fills), 20);
      });
    await app.openExample();
    return { app, runs: () => runs };
  }

  it('waits for the pour to be filled when exporting right after the board opens', async () => {
    const { app } = await bootSlowPours();
    ctx = { app };
    const board = app.project.boards[0];
    app.openDoc(board.id);
    const ed = app.activeEditor;
    // Nothing is filled yet: exporting this would leave the ground plane out.
    expect(ed.pourFills.size).toBe(0);
    const fills = await app._fills(board, ed);
    expect(fills.size).toBe(1);
  });

  it('does not export a pour computed before the last edit', async () => {
    const { app, runs } = await bootSlowPours();
    ctx = { app };
    const board = app.project.boards[0];
    app.openDoc(board.id);
    const ed = app.activeEditor;
    expect((await app._fills(board, ed)).tracks).toBe(0);
    const track = { t: 'track', layer: 'bottom', x1: 5e6, y1: 5e6, x2: 2e7, y2: 5e6, w: 250_000 };
    ed.doc.store.transact('Route', (s) => s.add({ ...track, net: 'VCC' }));
    // The repour for the new track is still to come; the export must not use
    // the fill from before it, which has no clearance around the track.
    const fills = await app._fills(board, ed);
    expect(fills.tracks).toBe(1);
    // Up to date fills are used as they are.
    const before = runs();
    expect(await app._fills(board, ed)).toBe(ed.pourFills);
    expect(runs()).toBe(before);
  });
});

describe('start-up without the Puter SDK', () => {
  it('does not make the app wait for the SDK script to arrive', () => {
    const html = fs.readFileSync(path.resolve(__dirname, '../index.html'), 'utf8');
    const sdk = /<script[^>]*js\.puter\.com[^>]*>/.exec(html)[0];
    // A deferred script runs before the module that starts the app, so a
    // connection that stalls on the SDK would leave the page blank; an async
    // one does not hold anything up, and loadPuter() waits for it briefly.
    expect(sdk).toMatch(/\sasync(\s|>)/);
    expect(sdk).not.toMatch(/\sdefer(\s|>)/);
    expect(sdk).toMatch(/onerror="window\.__puterFailed = true"/);
  });
});

describe('design rule check right after an edit', () => {
  it('checks against the pour as it will be filled, not the fill from before the edit', async () => {
    const app = await boot();
    ctx = { app };
    app.settings.set('autoRepour', true);
    let checked = null;
    app.kernel.pours = (doc) =>
      new Promise((resolve) => {
        const fills = new Map();
        fills.tracks = doc.objects.filter((o) => o.t === 'track').length;
        setTimeout(() => resolve(fills), 20);
      });
    app.kernel.drc = async (doc, lib, opts) => {
      checked = opts.pourFills;
      return [];
    };
    await app.openExample();
    app.openDoc(app.project.boards[0].id);
    const ed = app.activeEditor;
    await ed.currentFills();
    const track = { t: 'track', layer: 'bottom', x1: 5e6, y1: 5e6, x2: 2e7, y2: 5e6, w: 250_000 };
    ed.doc.store.transact('Route', (s) => s.add({ ...track, net: 'VCC' }));
    // Asked for at once, before the automatic repour: the old fill has no
    // clearance around the new track and would be reported as a violation.
    await ed.runDrc();
    expect(checked.tracks).toBe(1);
  });
});

describe('parts marked do not populate', () => {
  it('are left out of the pick and place file as they are out of the bill of materials', async () => {
    const app = await boot();
    ctx = { app };
    await app.openExample();
    const sheet = app.activeEditor;
    const r1 = [...sheet.doc.items()].find((o) => o.t === 'part' && o.designator === 'R1');
    sheet.doc.store.transact('Do not populate', (s) => s.update(r1.id, { dnp: true }));
    const project = app.project.toJSON();
    const board = project.documents.find((d) => d.kind === 'pcb');
    const listed = (csv) => csv.split('\r\n').map((l) => l.split(',')[0]);

    expect(listed(toCsv(buildBom(project)))).not.toContain('R1');
    const skip = unpopulated(project);
    expect([...skip]).toEqual([r1.uid]);
    const pnp = listed(pickAndPlace(board, project.library, { skip }));
    expect(pnp).not.toContain('R1');
    expect(pnp).toContain('R2');
    // Without the list every component is placed, as before.
    expect(listed(pickAndPlace(board, project.library))).toContain('R1');

    const zip = unzipSync(buildFabricationZip(project, board.id, {}));
    expect(listed(strFromU8(zip['assembly/bom.csv']))).not.toContain('R1');
    expect(listed(strFromU8(zip['assembly/pick-and-place.csv']))).not.toContain('R1');
    expect(listed(strFromU8(zip['assembly/pick-and-place.csv']))).toContain('R2');
  });
});

describe('cutting and pasting schematic parts', () => {
  const parts = (app) =>
    app.project.sheets.flatMap((d) => [...d.items()].filter((o) => o.t === 'part'));

  it('keeps the part linked to its board component when it is moved to another sheet', async () => {
    const app = await boot();
    ctx = { app };
    await app.openExample();
    const board = app.project.boards[0];
    expect(planSync(app.project, board)).toHaveLength(0);
    const sheet = app.activeEditor;
    const r2 = [...sheet.doc.items()].find((o) => o.t === 'part' && o.designator === 'R2');
    sheet.setSelection([r2.id]);
    app.cut();
    expect(parts(app).some((p) => p.uid === r2.uid)).toBe(false);

    const second = app.addDoc('sch');
    await app.paste();
    app.activeEditor.tool.click({ x: 50_800_000, y: 50_800_000 });
    const moved = [...second.items()].find((o) => o.t === 'part');
    expect(moved.uid).toBe(r2.uid);
    expect(moved.designator).toBe('R2');
    // The board keeps its placed component: nothing to remove and add again.
    const kinds = planSync(app.project, board).map((c) => c.kind);
    expect(kinds).not.toContain('add');
    expect(kinds).not.toContain('remove');

    // Pasting the same clipboard again makes a new part, like a copy.
    await app.paste();
    app.activeEditor.tool.click({ x: 76_200_000, y: 50_800_000 });
    const all = parts(app);
    expect(new Set(all.map((p) => p.uid)).size).toBe(all.length);
    expect(new Set(all.map((p) => p.designator)).size).toBe(all.length);
  });

  it('gives a copied part its own identity and designator', async () => {
    const app = await boot();
    ctx = { app };
    await app.openExample();
    const sheet = app.activeEditor;
    const r2 = [...sheet.doc.items()].find((o) => o.t === 'part' && o.designator === 'R2');
    sheet.setSelection([r2.id]);
    app.copy();
    await app.paste();
    sheet.tool.click({ x: 50_800_000, y: 50_800_000 });
    const copy = sheet.selectedObjects()[0];
    expect(copy.uid).not.toBe(r2.uid);
    expect(copy.designator).not.toBe('R2');
    expect(copy.designator).toMatch(/^R\d+$/);
  });
});

describe('cutting and pasting board components', () => {
  it('keeps a cut component linked to its schematic part', async () => {
    ctx = await bootBoard();
    const { app, ed } = ctx;
    const r2 = [...ed.doc.items()].find((o) => o.t === 'comp' && o.designator === 'R2');
    ed.setSelection([r2.id]);
    app.cut();
    await app.paste();
    ed.tool.click({ x: 10_000_000, y: 5_000_000 });
    const pasted = ed.selectedObjects()[0];
    expect(pasted.uid).toBe(r2.uid);
    const kinds = planSync(app.project, ed.doc).map((c) => c.kind);
    expect(kinds).not.toContain('add');
    expect(kinds).not.toContain('remove');
    // A second paste, like a copy, is a component of its own.
    await app.paste();
    ed.tool.click({ x: 20_000_000, y: 5_000_000 });
    const comps = [...ed.doc.items()].filter((o) => o.t === 'comp');
    expect(new Set(comps.map((c) => c.uid)).size).toBe(comps.length);
  });
});

describe('Delete while dragging', () => {
  it('deletes the part without leaving its wires stretched to the pointer', async () => {
    const app = await boot();
    ctx = { app };
    await app.openExample();
    const ed = app.activeEditor;
    const r1 = [...ed.doc.items()].find((o) => o.t === 'part' && o.designator === 'R1');
    const wires = () => JSON.stringify([...ed.doc.items()].filter((o) => o.t === 'wire'));
    const before = wires();
    ed.setSelection([r1.id]);
    const at = (x, y) => ({ x, y, rawX: x, rawY: y });
    ed.tool.dragStart(at(r1.x, r1.y));
    ed.tool.drag(at(r1.x + 5_080_000, r1.y + 2_540_000));
    expect(ed.tool.move).toBeTruthy();
    // The key is not the tool's own: it ends the drag and goes on to the Delete command.
    expect(ed.tool.key({ key: 'Delete' }, 'Delete')).toBe(false);
    app.commands.run('edit.delete');
    ed.tool.dragEnd(at(r1.x + 5_080_000, r1.y + 2_540_000));
    expect(ed.doc.store.get(r1.id)).toBeUndefined();
    expect(wires()).toBe(before);
    expect(ed.hidden.size).toBe(0);
    // One step to undo, and the part is back where it was.
    app.undo();
    expect(ed.doc.store.get(r1.id)).toMatchObject({ x: r1.x, y: r1.y });
    expect(ed.doc.store.undoLabel).not.toBe('Move');
  });
});

describe('autorouting a board with a copper pour', () => {
  it('routes the other nets across a plane on the component side', async () => {
    ctx = await bootBoard();
    const { app, ed } = ctx;
    const wasm = fs.readFileSync(path.resolve(__dirname, '../src/kernel/kernel.wasm'));
    app.kernel = await createKernel(wasm);
    // A ground plane over the whole top layer, where every pad is.
    const o = ed.doc.board.outline;
    const pts = [
      o[0] + 1e6,
      o[1] + 1e6,
      o[2] - 1e6,
      o[3] + 1e6,
      o[4] - 1e6,
      o[5] - 1e6,
      o[6] + 1e6,
      o[7] - 1e6,
    ];
    const rules = ed.doc.rules;
    const pour = { t: 'pour', layer: 'top', pts, net: 'GND', clearance: rules.pourClearance };
    ed.doc.store.transact('Pour', (s) =>
      s.add({ ...pour, removeIslands: true, thermals: true, priority: 0 }),
    );
    await ed.repour();
    expect([...ed.pourFills.values()].some((f) => f.length)).toBe(true);
    const before = ed.analysis().unrouted;
    expect(before.get('THR')).toBeGreaterThan(0);

    await app.autoroute();
    const tracks = [...ed.doc.items()].filter((x) => x.t === 'track');
    // The plane is refilled around new tracks: it must not wall the router in.
    expect(tracks.length).toBeGreaterThan(0);
    expect(new Set(tracks.map((t) => t.net)).size).toBeGreaterThan(2);
    expect(ed.analysis().unrouted.get('THR') || 0).toBeLessThan(before.get('THR'));
    expect(document.querySelector('.dialog')).toBeNull();
  });
});
