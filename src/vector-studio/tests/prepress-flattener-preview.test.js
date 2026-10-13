import { describe, it, expect } from 'vitest';
import { createPath, createText, createImage } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { bootAppWithFeatures } from './helpers.js';
import { analyzeFlattening, highlightTargets, isTransparentNode, HIGHLIGHTS } from '../src/features/prepress/flattener-preview.js';
import { FLATTENER_BUILTINS } from '../src/features/prepress/flattener-presets.js';
import { MENUS } from '../src/ui/menus.js';

const solid = (color, extra = {}) => ({ type: 'solid', color, ...extra });
const grad = { type: 'linear', angle: 0, stops: [{ offset: 0, color: '#000000', opacity: 1 }, { offset: 1, color: '#ffffff', opacity: 1 }] };

async function setup() {
  const app = await bootAppWithFeatures();
  const ed = app.newDocument();
  const doc = ed.doc;
  const ids = {};
  doc.transact('Art', () => {
    const layer = ed.targetLayer().id;
    const add = (name, node) => {
      doc.insert(node, layer);
      ids[name] = node.id;
    };
    add('under', createPath(rectangle(0, 0, 100, 100), true, { fill: grad, stroke: solid('#000000'), strokeWidth: 2 }));
    add('text', createText('Hello', 45, 60));
    add('img', createImage('asset-x', 10, 10, [5, 0, 0, 5, 20, 20], { link: { path: '/a.png' } }));
    add('glass', createPath(rectangle(40, 40, 100, 100), true, { fill: solid('#ff0000'), stroke: null, opacity: 0.5 }));
    add('away', createPath(rectangle(400, 400, 50, 50), true, { fill: solid('#00ff00'), stroke: solid('#000000'), strokeWidth: 1 }));
    add('over', createPath(rectangle(500, 0, 50, 50), true, { fill: solid('#0000ff'), stroke: null, overprintFill: true }));
  });
  return { app, ed, doc, ids };
}

describe('flattening analysis', () => {
  it('finds transparent objects and what lies under them', async () => {
    const { doc, ids } = await setup();
    const a = analyzeFlattening(doc, FLATTENER_BUILTINS['Medium Resolution']);
    expect([...a.transparent]).toEqual([ids.glass]);
    expect(['under', 'text', 'img', 'glass'].filter((k) => !a.affected.has(ids[k]))).toEqual([]);
    expect(a.affected.has(ids.away)).toBe(false);
    expect([...a.links]).toEqual([ids.img]);
    // Gradient, image and type need the image; plain colors do not.
    expect(a.complexRegions.length).toBe(3);
    expect(a.rasterFill.has(ids.text)).toBe(true);
    expect(a.strokes.has(ids.under)).toBe(false);
  });

  it('follows the preset: outlined text and strokes, everything raster at balance 0', async () => {
    const { doc, ids } = await setup();
    const a = analyzeFlattening(doc, { ...FLATTENER_BUILTINS['Medium Resolution'], textToOutlines: true, strokesToOutlines: true, balance: 0 });
    expect(a.text.has(ids.text)).toBe(true);
    expect(a.rasterFill.has(ids.text)).toBe(false);
    expect(a.strokes.has(ids.under)).toBe(true);
    expect(a.complexRegions.length).toBe(4);
  });

  it('treats overprint as transparency when simulated', async () => {
    const { doc, ids } = await setup();
    expect(isTransparentNode(doc.get(ids.over))).toBe(false);
    expect(analyzeFlattening(doc, {}, { overprint: 'simulate' }).transparent.has(ids.over)).toBe(true);
  });

  it('maps highlight modes to objects or regions', async () => {
    const { doc } = await setup();
    const a = analyzeFlattening(doc, {});
    expect(HIGHLIGHTS.map(([v]) => v)).toEqual(['none', 'complex', 'transparent', 'affected', 'links', 'patterns', 'strokes', 'text', 'rasterFill', 'rasterized']);
    expect(highlightTargets(a, 'affected').ids).toBe(a.affected);
    expect(highlightTargets(a, 'complex').rects).toBe(a.complexRegions);
    expect(highlightTargets(a, 'none').ids.size).toBe(0);
  });
});

describe('Flattener Preview panel', () => {
  it('refreshes, highlights and zooms', async () => {
    const { app, ed, doc, ids } = await setup();
    expect(MENUS.find((m) => m.label === 'Window').submenu).toContain('panel.flattenerPreview');
    app.dock.openPanel('flattenerPreview');
    const panel = app.dock.panels.get('flattenerPreview');
    panel.update();
    const el = panel.el;
    const hl = el.querySelector('select[aria-label="Highlight"]');
    expect([...hl.options].length).toBe(HIGHLIGHTS.length);
    hl.value = 'transparent';
    hl.dispatchEvent(new Event('change'));
    expect(el.querySelector('.fp-status').textContent).toMatch(/Transparent Objects: 1 object\./);
    // Changing the document asks for a refresh.
    doc.transact('More', () => doc.update(ids.away, { opacity: 0.3 }));
    panel.update();
    expect(el.querySelector('.fp-status').textContent).toMatch(/Refresh to update/);
    [...el.querySelectorAll('button')].find((b) => b.textContent.includes('Refresh')).click();
    expect(el.querySelector('.fp-status').textContent).toMatch(/Transparent Objects: 2 objects\./);
    // Presets and custom settings.
    const preset = el.querySelector('select[aria-label="Flattener preset"]');
    preset.value = 'High Resolution';
    preset.dispatchEvent(new Event('change'));
    expect(panel.values.balance).toBe(100);
    const s0 = panel.view.s;
    el.querySelector('button[aria-label="Zoom in"]').click();
    expect(panel.view.s).toBeCloseTo(s0 * 1.5, 6);
    el.querySelector('button[aria-label="Fit artboard"]').click();
    expect(panel.view.s).toBeCloseTo(s0, 6);
    const labels = panel.menu().map((m) => (typeof m === 'string' ? m : typeof m.label === 'function' ? m.label() : m.label));
    expect(labels).toContain('Save Flattener Preset...');
    panel.toggleOptions(true);
    expect(el.querySelector('.fp-options').hidden).toBe(false);
    void ed;
  });
});
