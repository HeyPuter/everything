// Robustness sweep: every panel opens and every dialog command opens and
// cancels, with representative documents and selections, without throwing
// or logging errors.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { createPath, createText, createImage } from '../src/model/nodes.js';
import { rectangle, ellipse } from '../src/model/shapes.js';
import { cancelOpenDialogs } from '../src/ui/dialogs/dialog.js';
import { createGraph } from '../src/features/graphs/graph-ops.js';
import { createSymbolFrom } from '../src/features/symbols/model.js';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** Representative selections: name -> build(editor) selecting something. */
const FIXTURES = {
  paths(ed) {
    const a = createPath(rectangle(10, 10, 100, 80), true, { fill: { type: 'color', color: '#ff0000' } });
    const b = createPath(ellipse(60, 40, 90, 90), true, { fill: { type: 'color', color: '#0000ff' } });
    ed.doc.transact('Add', () => {
      ed.doc.insert(a, ed.targetLayer().id);
      ed.doc.insert(b, ed.targetLayer().id);
    });
    ed.select([a.id, b.id]);
  },
  text(ed) {
    const t = createText('Robust', 40, 100);
    ed.doc.transact('Add', () => ed.doc.insert(t, ed.targetLayer().id));
    ed.select([t.id]);
  },
  graph(ed) {
    let id;
    ed.doc.transact('Add', () => (id = createGraph(ed.doc, ed.targetLayer().id, { x: 20, y: 20, w: 200, h: 120 }, 'column')));
    ed.select([id]);
  },
  symbol(ed) {
    const a = createPath(rectangle(10, 10, 50, 50), true, { fill: { type: 'color', color: '#00aa00' } });
    let out;
    ed.doc.transact('Add', () => {
      ed.doc.insert(a, ed.targetLayer().id);
      out = createSymbolFrom(ed.doc, [a.id], { name: 'Robust' });
    });
    ed.select([out.instance.id]);
  },
  image(ed) {
    ed.doc.assets.set('img1', { mime: 'image/png', data: 'data:image/png;base64,AAAA' });
    const img = createImage('img1', 100, 50, [1, 0, 0, 1, 10, 10]);
    ed.doc.transact('Add', () => ed.doc.insert(img, ed.targetLayer().id));
    ed.select([img.id]);
  },
  empty() {},
};

let app;
const errors = [];
const origError = console.error;
const onError = (e) => errors.push(`window error: ${e.message}`);
const onRejection = (e) => errors.push(`unhandled rejection: ${e.reason?.stack || e.reason}`);

function fresh(fixture) {
  for (const ed of [...app.editors]) app.closeDocument(ed, { force: true });
  const ed = app.newDocument();
  FIXTURES[fixture](ed);
  return ed;
}

const labelOf = (c) => (typeof c.label === 'function' ? c.label(app) : c.label) || '';

beforeAll(async () => {
  app = await bootAppWithFeatures();
  console.error = (...a) => errors.push(a.map((x) => x?.stack || String(x)).join(' '));
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
});

afterAll(() => {
  console.error = origError;
  window.removeEventListener('error', onError);
  window.removeEventListener('unhandledrejection', onRejection);
});

describe('robustness sweep', () => {
  it('opens every registered panel with each kind of selection and with no document', async () => {
    const failures = [];
    const ids = [...app.dock.panels.keys()];
    expect(ids.length).toBeGreaterThan(30);
    for (const fixture of [...Object.keys(FIXTURES), null]) {
      if (fixture) fresh(fixture);
      else for (const ed of [...app.editors]) app.closeDocument(ed, { force: true });
      for (const id of ids) {
        errors.length = 0;
        try {
          app.dock.openPanel(id, { focus: false });
          const p = app.dock.panels.get(id);
          p.update();
          p.menu();
          await tick();
        } catch (err) {
          errors.push(err.stack || String(err));
        }
        app.dock.closeFlyout(false);
        await cancelOpenDialogs();
        if (errors.length) failures.push(`${id} (${fixture || 'no document'}): ${errors[0].split('\n').slice(0, 3).join(' | ')}`);
      }
    }
    expect(failures).toEqual([]);
  }, 300000);

  it('runs every dialog command with a selection it accepts, then cancels it', async () => {
    const failures = [];
    const left = [];
    let opened = 0;
    const cmds = [...app.commands.commands.values()].filter((c) => /(\.\.\.|…)$/.test(labelOf(c)));
    expect(cmds.length).toBeGreaterThan(150);
    for (const c of cmds) {
      const fixture = Object.keys(FIXTURES).find((f) => {
        fresh(f);
        return app.commands.isEnabled(c.id);
      });
      if (!fixture) continue;
      fresh(fixture);
      errors.length = 0;
      const run = Promise.resolve(app.commands.run(c.id)).catch((err) => errors.push(err?.stack || String(err)));
      let done = false;
      run.then(() => (done = true));
      // Some dialogs open after async work: wait for one (or for the command to finish).
      for (let t = 0; t < 30 && !done && !document.querySelector('dialog[open]'); t++) await tick(10);
      if (document.querySelector('dialog[open]')) opened++;
      // Nested confirmations can follow a cancel: cancel until none is left.
      for (let i = 0; i < 6; i++) {
        await cancelOpenDialogs();
        await Promise.race([run, tick(50)]);
        if (!document.querySelector('dialog[open]') && done) break;
      }
      if (document.querySelector('dialog[open]')) left.push(c.id);
      await cancelOpenDialogs();
      if (errors.length) failures.push(`${c.id} (${fixture}): ${errors[0].split('\n').slice(0, 3).join(' | ')}`);
    }
    expect(failures).toEqual([]);
    expect(left).toEqual([]);
    expect(opened).toBeGreaterThan(100);
  }, 600000);
});
