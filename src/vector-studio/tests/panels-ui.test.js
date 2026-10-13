import { describe, it, expect } from 'vitest';
import axe from 'axe-core';
import { createPath, createImage } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { anchor } from '../src/model/bezier.js';
import { bootAppWithFeatures } from './helpers.js';
import { pathDirection, decorateSvg } from '../src/features/panels/attributes.js';
import { imageInfo, fitTransform, placedImages, embedImages } from '../src/features/panels/links.js';
import { documentReport, reportText } from '../src/features/panels/document-info-panel.js';
import { collectAssets, assetFileName, renderAssets, assetsOf, SCALE_PRESETS } from '../src/features/panels/asset-export.js';
import { wandOptions } from '../src/features/artboards/magic-wand.js';

const tick = () => new Promise((r) => setTimeout(r, 0));
const solid = (color) => ({ type: 'solid', color });
const PNG_1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function setup() {
  const app = await bootAppWithFeatures();
  const notes = [];
  app.notify = (m) => notes.push(m);
  const ed = app.newDocument({ width: 400, height: 300 });
  const doc = ed.doc;
  const add = (node) => {
    doc.transact('Add', () => doc.insert(node, ed.targetLayer().id));
    return node.id;
  };
  const panel = (id) => {
    app.openPanel(id);
    const p = app.dock.panels.get(id);
    p.update();
    return p;
  };
  return { app, ed, doc, add, panel, notes };
}

describe('Attributes panel', () => {
  it('sets overprint, center, fill rule, URL and notes with undo', async () => {
    const { ed, doc, add, panel } = await setup();
    const id = add(createPath(rectangle(0, 0, 50, 50), true, { fill: solid('#000000'), stroke: solid('#ff0000') }));
    ed.select([id]);
    const p = panel('attributes');
    expect(p.body.hidden).toBe(false);
    p.opFill.input.click();
    expect(doc.get(id).overprintFill).toBe(true);
    p.centerOn.click();
    expect(doc.get(id).showCenter).toBe(true);
    p.ruleEo.click();
    expect(doc.get(id).fillRule).toBe('evenodd');
    expect(p.ruleEo.getAttribute('aria-pressed')).toBe('true');
    p.url.value = 'https://example.com';
    p.url.dispatchEvent(new Event('change'));
    expect(doc.get(id).url).toBe('https://example.com');
    p.notes.value = 'Hero shape';
    p.notes.dispatchEvent(new Event('change'));
    expect(doc.get(id).notes).toBe('Hero shape');
    p.ruleNz.click();
    expect(doc.get(id).fillRule).toBeUndefined();
    doc.undo();
    expect(doc.get(id).fillRule).toBe('evenodd');
  });

  it('shows and reverses the path direction', async () => {
    const { ed, doc, add, panel } = await setup();
    const id = add(createPath(rectangle(0, 0, 50, 50), true));
    ed.select([id]);
    const p = panel('attributes');
    const dir = pathDirection(doc.get(id));
    expect(['cw', 'ccw']).toContain(dir);
    const other = dir === 'cw' ? p.dirCcw : p.dirCw;
    other.click();
    expect(pathDirection(doc.get(id))).not.toBe(dir);
    expect(other.getAttribute('aria-pressed')).toBe('true');
  });

  it('shows mixed values as indeterminate', async () => {
    const { ed, add, panel } = await setup();
    const a = add(createPath(rectangle(0, 0, 10, 10), true, { overprintFill: true }));
    const b = add(createPath(rectangle(20, 0, 10, 10), true));
    ed.select([a, b]);
    const p = panel('attributes');
    expect(p.opFill.input.indeterminate).toBe(true);
  });

  it('exports links, notes, overprint and the fill rule', async () => {
    const { app, ed, add } = await setup();
    const zig = [anchor(0, 0), anchor(100, 100), anchor(100, 0), anchor(0, 100)];
    add(createPath(zig, true, { fill: solid('#000000'), stroke: null, fillRule: 'evenodd', url: 'https://example.com/a?b=1&c=2', notes: 'say "hi"', overprintFill: true }));
    const svg = await app.exporters.svg(ed, {});
    expect(svg).toContain('<a href="https://example.com/a?b=1&amp;c=2">');
    expect(svg).toContain('data-notes="say &quot;hi&quot;"');
    expect(svg).toContain('data-overprint-fill="true"');
    expect(svg).toContain('fill-rule="evenodd"');
    const pdf = new TextDecoder('latin1').decode(await app.exporters.pdf(ed, {}));
    expect(pdf).toContain('/Subtype /Link');
    expect(pdf).toContain('/URI (https://example.com/a?b=1&c=2)');
    expect(pdf).toContain('/op true /OP false /OPM 1');
  });

  it('decorates markup only for meaningful values', () => {
    expect(decorateSvg({}, '<path d="M0 0"/>', { nl: '\n' })).toBe('<path d="M0 0"/>');
    expect(decorateSvg({ url: 'javascript:alert(1)' }, '<path/>', { nl: '' })).toBe('<path/>');
  });
});

describe('Links panel', () => {
  async function withImage() {
    const ctx = await setup();
    ctx.doc.assets.set('img1', { mime: 'image/png', data: PNG_1x1, name: 'photo' });
    const id = ctx.add(createImage('img1', 300, 150, [0.5, 0, 0, 0.5, 20, 30], { link: { source: 'puter', path: '/u/photo.png', name: 'photo.png' } }));
    return { ...ctx, id };
  }

  it('reports size, resolution, scale and link state', async () => {
    const { doc, id } = await withImage();
    const i = imageInfo(doc, doc.get(id));
    expect(i).toMatchObject({ name: 'photo.png', format: 'PNG', pixels: { w: 300, h: 150 }, placed: { w: 150, h: 75 }, ppi: { x: 144, y: 144 }, scale: { x: 50, y: 50 }, linked: true, location: '/u/photo.png' });
    expect(i.bytes).toBeGreaterThan(0);
    expect(placedImages(doc).map((n) => n.id)).toEqual([id]);
  });

  it('lists images, follows the selection and embeds', async () => {
    const { ed, doc, id, panel } = await withImage();
    ed.select([id]);
    const p = panel('links');
    expect(p.list.querySelectorAll('.lk-row').length).toBe(1);
    expect(p.info.textContent).toContain('144 ppi');
    expect(p.embedBtn.disabled).toBe(false);
    p.embedBtn.click();
    await tick();
    expect(doc.get(id).link).toBeUndefined();
    expect(embedImages(ed, [id])).toBe(0);
  });

  it('fits a replacement image into the placed box', () => {
    const node = { width: 100, height: 50, transform: [1, 0, 0, 1, 10, 10] };
    const m = fitTransform(node, 50, 50);
    // A square image fills the height and is centered horizontally.
    expect(m[0]).toBeCloseTo(1);
    expect(m[4]).toBeCloseTo(10 + 25);
    expect(m[5]).toBeCloseTo(10);
  });

  it('Edit Original is available for one selected image', async () => {
    const { app, ed, id } = await withImage();
    expect(app.commands.isEnabled('edit.editOriginal')).toBe(false);
    ed.select([id]);
    expect(app.commands.isEnabled('edit.editOriginal')).toBe(true);
  });
});

describe('Document Info panel', () => {
  it('summarizes the document or only the selection', async () => {
    const { ed, add, panel } = await setup();
    const a = add(createPath(rectangle(0, 0, 10, 10), true, { fill: solid('#ff0000') }));
    add(createPath(rectangle(20, 0, 10, 10), true, { fill: solid('#00ff00') }));
    const all = documentReport(ed);
    const objects = all.find((s) => s.id === 'objects').rows;
    expect(objects.find(([k]) => k === 'Paths')[1]).toBe(2);
    ed.select([a]);
    const sel = documentReport(ed, { selectionOnly: true });
    expect(sel.find((s) => s.id === 'objects').rows.find(([k]) => k === 'Paths')[1]).toBe(1);
    expect(sel.find((s) => s.id === 'document').rows.find(([k]) => k === 'Scope')[1]).toMatch(/1 object/);
    expect(reportText(sel)).toMatch(/Objects:\n {2}Paths: 1/);
    const p = panel('documentInfo');
    expect(p.body.querySelectorAll('.di-sec').length).toBe(12);
    p.cat.value = 'objects';
    p.cat.dispatchEvent(new Event('change'));
    expect(p.body.querySelectorAll('.di-sec').length).toBe(1);
  });
});

describe('Color Guide panel', () => {
  it('applies guide colors and takes the current color as base', async () => {
    const { ed, doc, add, panel, app } = await setup();
    const id = add(createPath(rectangle(0, 0, 10, 10), true, { fill: solid('#3366cc') }));
    ed.select([id]);
    const p = panel('colorGuide');
    p.baseBtn.click();
    expect(app.prefs.get('colorGuide').base).toBe('#3366cc');
    p.rule.value = 'complementary';
    p.rule.dispatchEvent(new Event('change'));
    const cells = p.strip.querySelectorAll('.cg-cell');
    expect(cells.length).toBe(2);
    cells[1].click();
    expect(doc.get(id).fill.color).not.toBe('#3366cc');
    expect(p.grid.querySelectorAll('.cg-grid-row').length).toBe(2);
    // Save the harmony as a color group.
    const groups = (doc.root.swatchGroups || []).length;
    p.saveGroup();
    expect(doc.root.swatchGroups.length).toBe(groups + 1);
    // Arrow keys move through the grid.
    const first = p.grid.querySelector('[tabindex="0"]');
    first.focus();
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(document.activeElement.dataset.c).toBe('1');
  });
});

describe('Asset Export', () => {
  it('collects single and multiple assets and names files by setting', async () => {
    const { app, ed, doc, add } = await setup();
    const a = add(createPath(rectangle(0, 0, 10, 10), true, {}, { name: 'Star' }));
    const b = add(createPath(rectangle(20, 0, 10, 10), true));
    ed.select([a, b]);
    await app.commands.run('assetExport.multiple');
    expect(assetsOf(doc).map((x) => x.name)).toEqual(['Star', 'Path']);
    await app.commands.run('assetExport.single');
    expect(assetsOf(doc)[2].ids).toEqual([a, b]);
    doc.undo();
    expect(assetsOf(doc).length).toBe(2);
    expect(assetFileName({ name: 'Icon/Home' }, { suffix: '@2x', format: 'png' })).toBe('Icon-Home@2x.png');
    expect(SCALE_PRESETS.ios.map((s) => s.suffix)).toEqual(['', '@2x', '@3x']);
    doc.transact('More', () => collectAssets(doc, [a], { single: true }));
    expect(assetsOf(doc)[2].name).toBe('Star 2');
  });

  it('renders each asset at each setting', async () => {
    const { app, ed, doc, add } = await setup();
    const a = add(createPath(rectangle(10, 10, 30, 20), true, {}, { name: 'Badge' }));
    doc.transact('Collect', () => collectAssets(doc, [a]));
    const files = await renderAssets(app, ed, assetsOf(doc), [{ scale: 1, suffix: '', format: 'svg' }, { scale: 2, suffix: '@2x', format: 'svg' }, { scale: 1, suffix: '', format: 'pdf' }]);
    expect(files.map((f) => f.name)).toEqual(['Badge.svg', 'Badge@2x.svg', 'Badge.pdf']);
    const svg = await files[0].blob.text();
    expect(svg).toMatch(/viewBox="0 0 3\d(\.\d+)? 2\d(\.\d+)?"/);
  });

  it('the panel lists assets and edits export settings', async () => {
    const { ed, doc, add, panel } = await setup();
    const a = add(createPath(rectangle(10, 10, 30, 20), true));
    ed.select([a]);
    doc.transact('Collect', () => collectAssets(doc, [a]));
    const p = panel('assetExport');
    expect(p.grid.querySelectorAll('.ae-tile').length).toBe(1);
    p.addScale();
    expect(doc.root.assetExportSettings.length).toBe(2);
    expect(doc.root.assetExportSettings[1]).toMatchObject({ scale: 1.5, suffix: '@1.5x' });
    p.update();
    const fmt = p.settingsList.querySelectorAll('.ae-setting')[1].querySelectorAll('select')[1];
    fmt.value = 'svg';
    fmt.dispatchEvent(new Event('change'));
    expect(doc.root.assetExportSettings[1].format).toBe('svg');
    p.grid.querySelector('.ae-tile').click();
    expect(p.selected.size).toBe(1);
    p.removeSelected();
    expect(assetsOf(doc).length).toBe(0);
  });
});

describe('Magic Wand panel', () => {
  it('edits the wand options live', async () => {
    const { app, panel } = await setup();
    const p = panel('magicWand');
    const stroke = p.rows.get('stroke');
    stroke.chk.click();
    expect(wandOptions(app).stroke.on).toBe(true);
    stroke.num.value = '12';
    stroke.num.dispatchEvent(new Event('change'));
    expect(wandOptions(app).stroke.tol).toBe(12);
    p.blend.click();
    expect(wandOptions(app).blendMode.on).toBe(true);
    p.reset();
    expect(wandOptions(app).stroke.on).toBe(false);
  });

  it('double-clicking the tool opens the panel', async () => {
    const { app } = await setup();
    app.setTool('magic-wand');
    app.tool.openOptions();
    expect(app.dock.isOpen('magicWand')).toBe(true);
  });
});

describe('panel accessibility', () => {
  for (const id of ['history', 'actions', 'links', 'attributes', 'documentInfo', 'colorGuide', 'assetExport', 'magicWand']) {
    it(`${id} has no serious axe violations`, async () => {
      const { ed, add, panel, doc } = await setup();
      doc.assets.set('img1', { mime: 'image/png', data: PNG_1x1, name: 'photo' });
      const a = add(createPath(rectangle(0, 0, 10, 10), true));
      add(createImage('img1', 10, 10));
      ed.select([a]);
      doc.transact('Collect', () => collectAssets(doc, [a]));
      const p = panel(id);
      if (id === 'actions') {
        p.expanded.add('set-default');
        p.update();
      }
      await tick();
      const result = await axe.run(p.el, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
      const serious = result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
      expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`)).toEqual([]);
    });
  }
});
