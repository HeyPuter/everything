// Accessibility sweep: axe over every panel and every dialog a command opens
// (contrast is checked in tokens tests; jsdom cannot compute it).
import { describe, it, expect, beforeAll } from 'vitest';
import axe from 'axe-core';
import { bootAppWithFeatures } from './helpers.js';
import { createPath, createText } from '../src/model/nodes.js';
import { rectangle, ellipse } from '../src/model/shapes.js';
import { cancelOpenDialogs } from '../src/ui/dialogs/dialog.js';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const OPTIONS = { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } };
const serious = (result) =>
  result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`);

let app;
let ids;

/** A fresh document with two paths and a text object (fresh per command, so previews never pile up). */
function fresh() {
  for (const ed of [...app.editors]) app.closeDocument(ed, { force: true });
  const ed = app.newDocument();
  const a = createPath(rectangle(10, 10, 100, 80), true, { fill: { type: 'solid', color: '#ff0000' } });
  const b = createPath(ellipse(60, 40, 90, 90), true, { fill: { type: 'solid', color: '#0000ff' } });
  const t = createText('Access', 40, 200);
  ed.doc.transact('Add', () => {
    for (const n of [a, b, t]) ed.doc.insert(n, ed.targetLayer().id);
  });
  ids = { paths: [a.id, b.id], text: [t.id] };
  return ed;
}

beforeAll(async () => {
  app = await bootAppWithFeatures();
  fresh();
});

describe('accessibility sweep', () => {
  it('every panel passes axe with a selection', async () => {
    const failures = [];
    app.editor.select(ids.paths);
    for (const id of app.dock.panels.keys()) {
      app.dock.openPanel(id, { focus: false });
      await tick();
      const root = app.dock.flyoutId === id ? document.querySelector('.panel-flyout') : app.dock.panels.get(id).el;
      for (const v of serious(await axe.run(root, OPTIONS))) failures.push(`${id}: ${v}`);
      app.dock.closeFlyout(false);
    }
    expect(failures).toEqual([]);
  }, 300000);

  it('every dialog passes axe', async () => {
    const failures = [];
    const seen = new Set();
    const label = (c) => (typeof c.label === 'function' ? c.label(app) : c.label) || '';
    const cmds = [...app.commands.commands.values()].filter((c) => /(\.\.\.|…)$/.test(label(c)));
    for (const c of cmds) {
      const ed = fresh();
      ed.select(ids.paths.filter((id) => ed.doc.has(id)));
      if (!app.commands.isEnabled(c.id)) ed.select(ids.text);
      if (!app.commands.isEnabled(c.id)) continue;
      let done = false;
      const run = Promise.resolve(app.commands.run(c.id)).then(() => (done = true));
      for (let i = 0; i < 30 && !done && !document.querySelector('dialog[open]'); i++) await tick(10);
      const dlg = document.querySelector('dialog[open]');
      const title = dlg?.querySelector('.dialog-title')?.textContent;
      if (dlg && !seen.has(title)) {
        seen.add(title);
        for (const v of serious(await axe.run(dlg, OPTIONS))) failures.push(`${c.id} "${title}": ${v}`);
      }
      for (let i = 0; i < 6; i++) {
        await cancelOpenDialogs();
        await Promise.race([run, tick(50)]);
        if (done && !document.querySelector('dialog[open]')) break;
      }
    }
    expect(seen.size).toBeGreaterThan(100);
    expect(failures).toEqual([]);
  }, 600000);
});
