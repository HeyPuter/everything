import { describe, it, expect, beforeAll } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { applyTransform } from '../src/commands/core.js';
import { translate } from '../src/lib/matrix.js';
import { navigatorExtent } from '../src/features/artboards/navigator-panel.js';
import { alignTarget } from '../src/features/artboards/align-panel.js';

let app;
beforeAll(async () => {
  app = await bootAppWithFeatures();
});

function setup() {
  const ed = app.newDocument({ name: 'Small panels', width: 200, height: 100 });
  const doc = ed.doc;
  const p = createPath(rectangle(0, 0, 10, 10), true, { fill: { type: 'pattern', id: 'pt', transform: [1, 0, 0, 1, 0, 0] } });
  doc.transact('Build', () => doc.insert(p, doc.layers()[0].id));
  ed.select([p.id]);
  return { ed, doc, p };
}

const panel = (id) => {
  const p = app.dock.panels.get(id);
  p.ensureBuilt();
  p.visible = true;
  p.update();
  return p;
};
const item = (p, label) => p.menu().find((x) => x.label === label);

describe('Align panel menu', () => {
  it('shows and hides options, sets preview bounds and the align target', () => {
    setup();
    const p = panel('align');
    item(p, 'Hide Options').run();
    expect(p.optionSections.every((s) => s.hidden)).toBe(true);
    item(p, 'Show Options').run();
    expect(p.optionSections.some((s) => s.hidden)).toBe(false);
    item(p, 'Use Preview Bounds').run();
    expect(app.prefs.get('previewBounds')).toBe(true);
    item(p, 'Use Preview Bounds').run();
    item(p, 'Align to Artboard').run();
    expect(alignTarget(app)).toBe('artboard');
    expect(item(p, 'Align to Artboard').checked).toBe(true);
    item(p, 'Align to Key Object').run();
    expect(alignTarget(app)).toBe('key');
    item(p, 'Cancel Key Object').run();
    expect(alignTarget(app)).toBe('selection');
  });
});

describe('Transform panel menu', () => {
  it('transforms objects only, patterns only or both', () => {
    const { ed, doc, p } = setup();
    const tp = panel('transform');
    const x0 = () => doc.get(p.id).anchors[0].x;
    const px = () => doc.get(p.id).fill.transform[4];
    item(tp, 'Transform Object Only').run();
    applyTransform(ed, 'Move', translate(5, 0));
    expect([x0(), px()]).toEqual([5, 0]);
    item(tp, 'Transform Pattern Only').run();
    applyTransform(ed, 'Move', translate(5, 0));
    expect([x0(), px()]).toEqual([5, 5]);
    item(tp, 'Transform Both').run();
    applyTransform(ed, 'Move', translate(5, 0));
    expect([x0(), px()]).toEqual([10, 10]);
    expect(tp.menu()).toContain('object.flipH');
    item(tp, 'Scale Strokes & Effects').run();
    expect(app.prefs.get('scaleStrokes')).toBe(true);
    item(tp, 'Scale Strokes & Effects').run();
    item(tp, 'Hide Options').run();
    expect(tp.checksSection.hidden).toBe(true);
    item(tp, 'Show Options').run();
    expect(tp.checksSection.hidden).toBe(false);
  });
});

describe('Info and Attributes panel menus', () => {
  it('hide and show their options', () => {
    setup();
    const info = panel('info');
    item(info, 'Hide Options').run();
    expect(info.paintSection.hidden).toBe(true);
    item(info, 'Show Options').run();
    expect(info.paintSection.hidden).toBe(false);
    const attr = panel('attributes');
    item(attr, 'Hide Options').run();
    expect(attr.options.hidden).toBe(true);
    item(attr, 'Show Options').run();
    expect(attr.options.hidden).toBe(false);
    expect(attr.menu()).toContain('color.overprintBlack');
  });
});

describe('Navigator panel menu', () => {
  it('views the active artboard only', () => {
    const { ed, doc } = setup();
    const all = navigatorExtent(doc);
    const one = navigatorExtent(doc, { artboard: ed.artboard() });
    expect(one.w).toBeLessThanOrEqual(all.w);
    const nav = panel('navigator');
    item(nav, 'View Artboard Only').run();
    expect(nav.options.artboardOnly).toBe(true);
    expect(item(nav, 'View Artboard Only').checked).toBe(true);
    app.dialogs.form = async () => ({ boxColor: '#00ff00', outline: true, artboardOnly: false });
    return item(nav, 'Panel Options...')
      .run()
      .then(() => {
        expect(nav.options).toMatchObject({ boxColor: '#00ff00', outline: true, artboardOnly: false });
        app.prefs.set('navigator', null);
      });
  });
});

describe('Info panel colors', () => {
  it('shows CMYK percentages in CMYK documents', async () => {
    const { paintInfo } = await import('../src/features/artboards/info-panel.js');
    expect(paintInfo({ type: 'solid', color: '#ff0000' })).toBe('R 255  G 0  B 0  #FF0000');
    // Converted colors show their CMYK numbers; others their separation in the document's CMYK profile.
    expect(paintInfo({ type: 'solid', color: '#ff0000', cmyk: { c: 0, m: 100, y: 100, k: 0 } }, 'CMYK')).toBe('C 0%  M 100%  Y 100%  K 0%');
    expect(paintInfo({ type: 'solid', color: '#ff0000' }, 'CMYK')).toMatch(/^C 0% {2}M (9\d|100)% {2}Y (8\d|9\d|100)% {2}K 0%$/);
  });
});
