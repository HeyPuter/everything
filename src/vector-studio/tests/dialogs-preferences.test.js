import { describe, it, expect, afterEach } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { applyAll, sections } from '../src/features/files/preferences.js';
import { parseLength, unitOptions } from '../src/lib/units.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  unitOptions.bareUnit = null;
  delete document.documentElement.dataset.tooltips;
});

describe('Preferences dialog', () => {
  it('has the sections and opens on the one asked for', async () => {
    const app = await bootAppWithFeatures();
    const ids = sections(app).map((s) => s.id);
    expect(ids).toEqual(['general', 'selection', 'type', 'units', 'guides', 'alignment', 'slices', 'ui', 'performance', 'files']);
    const done = app.commands.run('edit.preferences.type');
    await tick();
    const dlg = document.querySelector('dialog[open]');
    const tab = dlg.querySelector('.prefs-tab[aria-selected="true"]');
    expect(tab.textContent).toBe('Type');
    [...dlg.querySelectorAll('button')].find((b) => b.textContent === 'Cancel').click();
    await done;
  });

  it('search filters settings across sections', async () => {
    const app = await bootAppWithFeatures();
    const done = app.commands.run('edit.preferences');
    await tick();
    const dlg = document.querySelector('dialog[open]');
    const search = dlg.querySelector('.prefs-search');
    search.value = 'scale corners';
    search.dispatchEvent(new Event('input'));
    const visiblePanels = [...dlg.querySelectorAll('.prefs-panel')].filter((p) => !p.hidden);
    expect(visiblePanels).toHaveLength(1);
    const rows = [...visiblePanels[0].querySelectorAll('.form > *')].filter((r) => !r.hidden);
    expect(rows.map((r) => r.textContent)).toEqual(['Scale Corners']);
    search.value = 'zzzz';
    search.dispatchEvent(new Event('input'));
    expect(dlg.querySelector('.prefs-nomatch').hidden).toBe(false);
    search.value = '';
    search.dispatchEvent(new Event('input'));
    expect([...dlg.querySelectorAll('.prefs-panel')].filter((p) => !p.hidden)).toHaveLength(1);
    [...dlg.querySelectorAll('button')].find((b) => b.textContent === 'Cancel').click();
    await done;
  });

  it('writes the settings on OK', async () => {
    const app = await bootAppWithFeatures();
    const done = app.commands.run('edit.preferences.general');
    await tick();
    const dlg = document.querySelector('dialog[open]');
    const box = [...dlg.querySelectorAll('.form-row.check')].find((r) => r.textContent.startsWith('Show Tool Tips')).querySelector('input');
    box.checked = false;
    [...dlg.querySelectorAll('button')].find((b) => b.textContent === 'OK').click();
    await done;
    expect(app.prefs.get('showTooltips')).toBe(false);
    expect(document.documentElement.dataset.tooltips).toBe('off');
  });
});

describe('Preference effects', () => {
  it('reads bare numbers as points when asked', async () => {
    const app = await bootAppWithFeatures();
    expect(parseLength('1', 'in')).toBe(72);
    applyAll(app, { bareNumbersArePoints: true });
    expect(parseLength('1', 'in')).toBe(1);
    expect(parseLength('1in', 'in')).toBe(72);
  });

  it('limits the history to the History States setting', async () => {
    const app = await bootAppWithFeatures();
    app.newDocument();
    applyAll(app, { undoLevels: 5 });
    const doc = app.editor.doc;
    for (let i = 0; i < 9; i++) doc.transact(`step ${i}`, () => doc.updateRoot({ units: i % 2 ? 'pt' : 'px' }));
    expect(doc.undoStack.length).toBe(5);
  });

  it('paints the canvas white when asked', async () => {
    const app = await bootAppWithFeatures();
    applyAll(app, { canvasColor: 'white' });
    expect(document.documentElement.style.getPropertyValue('--pasteboard')).toBe('#ffffff');
    applyAll(app, { canvasColor: 'match' });
    expect(document.documentElement.style.getPropertyValue('--pasteboard')).toBe('');
  });

  it('keeps the home screen hidden when it is turned off', async () => {
    const app = await bootAppWithFeatures();
    app.newDocument();
    app.prefs.set('showStartScreen', false);
    await app.closeDocument(app.editor, { force: true });
    expect(app.home.hidden).toBe(true);
    app.prefs.set('showStartScreen', true);
    app.newDocument();
    await app.closeDocument(app.editor, { force: true });
    expect(app.home.hidden).toBe(false);
  });

  it('zooms toward the selection', async () => {
    const app = await bootAppWithFeatures();
    app.newDocument();
    const ed = app.editor;
    ed.view.width = 800;
    ed.view.height = 600;
    const n = createPath(rectangle(500, 500, 20, 20), true, { fill: { type: 'solid', color: '#000000' } });
    ed.doc.transact('r', () => ed.doc.insert(n, ed.targetLayer().id));
    ed.select([n.id]);
    app.commands.run('view.zoomIn');
    const s = ed.view.toScreen(510, 510);
    expect(s.x).toBeCloseTo(400);
    expect(s.y).toBeCloseTo(300);
  });
});

describe('Type and slice preferences', () => {
  it('limits and hides recent fonts', async () => {
    const app = await bootAppWithFeatures();
    const { recentFonts } = await import('../src/features/type/font-tools.js');
    app.prefs.set('recentFonts', ['Inter', 'Inter', 'Inter'].map((f, i) => (i ? `${f}` : f)));
    const all = recentFonts(app).length;
    app.prefs.set('recentFontsCount', 1);
    expect(recentFonts(app).length).toBeLessThanOrEqual(1);
    expect(all).toBeGreaterThanOrEqual(recentFonts(app).length);
    app.prefs.set('showRecentFonts', false);
    expect(app.menuSources.get('recentFonts')(app)).toEqual([]);
  });

  it('offers slice line colors as colors', async () => {
    const app = await bootAppWithFeatures();
    const slices = sections(app).find((s) => s.id === 'slices');
    const f = slices.fields.find((x) => x.key === 'sliceLineColor');
    expect(f.options.every((o) => /^#[0-9a-f]{6}$/i.test(o.value))).toBe(true);
  });
});
