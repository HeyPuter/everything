import { describe, it, expect, beforeAll } from 'vitest';
import { bootAppWithFeatures } from './helpers.js';
import { createPath, createImage, createText } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { fitTransform, listedImages, linkStatus } from '../src/features/panels/links.js';
import { documentReport, CATEGORIES } from '../src/features/panels/document-info-panel.js';

let app;
beforeAll(async () => {
  app = await bootAppWithFeatures();
});

const DATA = 'data:image/png;base64,iVBORw0KGgo=';

function setup() {
  const ed = app.newDocument({ name: 'Links' });
  const doc = ed.doc;
  const layer = doc.layers()[0];
  doc.assets.set('a1', { mime: 'image/png', data: DATA, name: 'zebra' });
  doc.assets.set('a2', { mime: 'image/jpeg', data: DATA, name: 'apple' });
  doc.assets.set('a3', { mime: 'image/png', name: 'gone' });
  const imgs = [
    createImage('a1', 100, 50, [1, 0, 0, 1, 0, 0], { name: 'zebra' }),
    createImage('a2', 100, 50, [1, 0, 0, 1, 200, 0], { name: 'apple', link: { source: 'puter', path: '/u/apple.jpg', name: 'apple.jpg', modified: 1 } }),
    createImage('a3', 100, 50, [1, 0, 0, 1, 400, 0], { name: 'gone' }),
  ];
  doc.transact('Build', () => imgs.forEach((n) => doc.insert(n, layer.id)));
  const panel = app.dock.panels.get('links');
  panel.ensureBuilt();
  return { ed, doc, imgs, panel };
}

describe('Links panel', () => {
  it('fits a replacement image by the placement option', () => {
    const node = { width: 100, height: 50, transform: [2, 0, 0, 2, 10, 20] };
    expect(fitTransform(node, 50, 50, 'transforms')).toEqual([2, 0, 0, 2, 10, 20]);
    expect(fitTransform(node, 50, 50, 'fit')).toEqual([2, 0, 0, 2, 60, 20]);
    expect(fitTransform(node, 50, 50, 'fill')).toEqual([4, 0, 0, 4, 10, -30]);
    expect(fitTransform(node, 50, 50, 'stretch')).toEqual([4, 0, 0, 2, 10, 20]);
    expect(fitTransform(node, 50, 50, 'center')).toEqual([2, 0, 0, 2, 60, 20]);
  });

  it('filters and sorts the list', () => {
    const { doc } = setup();
    const ids = (list) => list.map((n) => n.name);
    expect(ids(listedImages(doc, { sort: 'name' }))).toEqual(['apple', 'gone', 'zebra']);
    expect(ids(listedImages(doc, { sort: 'kind' }))).toEqual(['apple', 'gone', 'zebra']);
    expect(ids(listedImages(doc, { sort: 'status' }))).toEqual(['gone', 'apple', 'zebra']);
    expect(ids(listedImages(doc, { show: 'missing' }))).toEqual(['gone']);
    expect(ids(listedImages(doc, { show: 'linked' }))).toEqual(['apple']);
    expect(ids(listedImages(doc, { show: 'embedded' }))).toEqual(['zebra']);
    const modified = new Set([doc.layers()[0].children[1]]);
    expect(linkStatus(doc, doc.get(doc.layers()[0].children[1]), modified)).toBe('modified');
  });

  it('has a working panel menu: show filter, sort, placement options, embed, info', async () => {
    const { ed, doc, imgs, panel } = setup();
    panel.update();
    const labels = (spec) => spec.filter((x) => x !== '-').map((x) => x.label);
    expect(labels(panel.menu())).toEqual(
      expect.arrayContaining(['Relink...', 'Go To Link', 'Update Link', 'Edit Original', 'Placement Options...', 'Embed Image', 'Unembed...', 'Link Information...', 'Show', 'Sort', 'Panel Options...']),
    );
    const show = panel.menu().find((x) => x.label === 'Show');
    show.submenu.find((x) => x.label === 'Show Missing').run();
    expect(panel.list.querySelectorAll('.lk-row').length).toBe(1);
    panel.menu().find((x) => x.label === 'Show').submenu[0].run();
    panel.menu().find((x) => x.label === 'Sort').submenu.find((x) => x.label === 'Sort by Name').run();
    expect([...panel.list.querySelectorAll('.lk-name')].map((e) => e.textContent)).toEqual(['apple.jpg', 'gone', 'zebra']);

    app.dialogs.form = async () => ({ placement: 'fill' });
    await panel.menu().find((x) => x.label === 'Placement Options...').run();
    expect(app.prefs.get('linkPlacement')).toBe('fill');

    ed.select([imgs[1].id]);
    panel.update();
    await panel.menu().find((x) => x.label === 'Embed Image').run();
    expect(doc.get(imgs[1].id).link).toBeUndefined();

    let opened = null;
    app.dialogs.open = async (o) => (opened = o);
    await panel.menu().find((x) => x.label === 'Link Information...').run();
    expect(opened.title).toBe('Link Information');
    expect(opened.body.textContent).toContain('JPEG');

    app.dialogs.form = async () => ({ thumbs: 'none' });
    await panel.menu().find((x) => x.label === 'Panel Options...').run();
    expect(panel.list.querySelector('.lk-thumb')).toBeNull();
    app.prefs.set('linksPanel', null);
  });

  it('unembeds into Puter and links the saved file', async () => {
    const { ed, doc, imgs, panel } = setup();
    globalThis.fetch ??= async () => ({ blob: async () => new Blob(['x']) });
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ blob: async () => new Blob(['x'], { type: 'image/png' }) });
    app.user = { username: 'me' };
    app.puter = { ui: { showSaveFilePicker: async (blob, name) => ({ path: `/me/${name}`, name }) } };
    ed.select([imgs[0].id]);
    panel.update();
    await panel.menu().find((x) => x.label === 'Unembed...').run();
    expect(doc.get(imgs[0].id).link).toMatchObject({ source: 'puter', path: '/me/zebra.png' });
    globalThis.fetch = realFetch;
    app.user = null;
    app.puter = null;
  });
});

describe('Document Info panel', () => {
  it('reports brushes, global colors, patterns, gradients and font details', () => {
    const ed = app.newDocument({ name: 'Info' });
    const doc = ed.doc;
    const layer = doc.layers()[0];
    doc.transact('Build', () => {
      doc.updateRoot({ swatches: [{ id: 'sw1', name: 'Brand Red', global: true, paint: { type: 'solid', color: '#ff0000' } }], patterns: [{ id: 'pt1', name: 'Dots' }] });
      doc.insert(createPath(rectangle(0, 0, 10, 10), true, { fill: { type: 'solid', color: '#ff0000', swatchId: 'sw1' } }), layer.id);
      doc.insert(createPath(rectangle(0, 0, 10, 10), true, { fill: { type: 'pattern', id: 'pt1' } }), layer.id);
      doc.insert(createPath(rectangle(0, 0, 10, 10), true, { fill: { type: 'linear', angle: 0, stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }] } }), layer.id);
      doc.insert(createText('Hello', 0, 0, { char: { fontFamily: 'Inter', fontSize: 12, fontWeight: 700 } }), layer.id);
    });
    const r = Object.fromEntries(documentReport(ed).map((s) => [s.id, s]));
    for (const c of CATEGORIES) if (c.id !== 'all') expect(r[c.id], c.id).toBeTruthy();
    expect(r.globalColors.items).toEqual(['Brand Red: 1 use']);
    expect(r.patterns.items).toEqual(['Dots: 1 use']);
    expect(r.gradients.items[0]).toMatch(/^Linear, 2 stops: #000000 > #FFFFFF \(1 use\)$/);
    expect(r.fontDetails.items[0]).toMatch(/^Inter Bold: weight 700, upright, 1 use, 5 characters$/);
    expect(r.brushes.items.length).toBeGreaterThan(0);
  });

  it('has Selection Only and the categories in its menu', () => {
    app.newDocument({ name: 'Info menu' });
    const panel = app.dock.panels.get('documentInfo');
    panel.ensureBuilt();
    const menu = panel.menu();
    menu.find((x) => x.label === 'Selection Only').run();
    expect(panel.selOnly.checked).toBe(true);
    menu.find((x) => x.label === 'Font Details').run();
    expect(panel.cat.value).toBe('fontDetails');
    expect(panel.menu().find((x) => x.label === 'Font Details').checked).toBe(true);
    expect(panel.menu().find((x) => x.label === 'Save...')).toBeTruthy();
    panel.setCategory('all');
    panel.setSelectionOnly(false);
  });
});
