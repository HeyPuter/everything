import { describe, it, expect } from 'vitest';
import { createPath, createImage } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { bootAppWithFeatures } from './helpers.js';
import { spotTint, spotInks, inkUsage, plateView, separationState, listedPlates, inkParams, drawSeparations, inkAt } from '../src/features/prepress/separations.js';
import { inkPixels } from '../src/features/prepress/ink-gl.js';
import { separatePixel } from '../src/features/prepress/color-management.js';
import { addSwatch } from '../src/features/paint/swatch-model.js';
import { swatchOptionsDialog } from '../src/features/paint/swatches-panel.js';
import { MENUS } from '../src/ui/menus.js';

const tick = () => new Promise((r) => setTimeout(r, 0));
const dlg = () => document.querySelector('dialog[open]');

async function setup() {
  const app = await bootAppWithFeatures();
  const ed = app.newDocument();
  const doc = ed.doc;
  const add = (style, extra = {}) => {
    const p = createPath(rectangle(0, 0, 10, 10), true, style, extra);
    doc.transact('Add', () => doc.insert(p, ed.targetLayer().id));
    return p.id;
  };
  let spotId;
  doc.transact('Spot', () => (spotId = addSwatch(doc, { name: 'Brand Orange', paint: { type: 'solid', color: '#ff8000' }, spot: true })));
  return { app, ed, doc, add, spotId };
}

describe('spot inks', () => {
  it('marks spot swatches global and lists them', async () => {
    const { doc, spotId } = await setup();
    const sw = doc.root.swatches.find((s) => s.id === spotId);
    expect(sw).toMatchObject({ spot: true, global: true });
    expect(spotInks(doc)).toEqual([{ id: spotId, name: 'Brand Orange', color: '#ff8000' }]);
  });

  it('offers Spot Color in Swatch Options', async () => {
    await bootAppWithFeatures();
    const app = { notify() {} };
    const p = swatchOptionsDialog(app, { swatch: { name: 'Ink', paint: { type: 'solid', color: '#123456' } } });
    await tick();
    const type = dlg().querySelector('#swo-type');
    expect([...type.options].map((o) => o.value)).toEqual(['process', 'global', 'spot']);
    type.value = 'spot';
    [...dlg().querySelectorAll('.dialog-footer button')].find((b) => b.textContent === 'OK').click();
    expect(await p).toMatchObject({ spot: true, global: true });
  });

  it('measures tints against the ink color', () => {
    expect(spotTint('#ff8000', '#ff8000')).toBeCloseTo(1, 5);
    expect(spotTint('#ffffff', '#ff8000')).toBeCloseTo(0, 5);
    expect(spotTint('#ffbf80', '#ff8000')).toBeCloseTo(0.5, 1);
    expect(spotTint('#ff8000', '#ff8000', 0.3)).toBe(0.3);
  });

  it('finds the inks the artwork uses', async () => {
    const { doc, add, spotId } = await setup();
    add({ fill: { type: 'solid', color: '#00ffff' }, stroke: null });
    add({ fill: { type: 'solid', color: '#ff8000', swatchId: spotId }, stroke: { type: 'solid', color: '#000000' } });
    const used = inkUsage(doc, 'basic');
    expect([...used.process].sort()).toEqual(['c', 'k']);
    expect([...used.spots]).toEqual([spotId]);
  });
});

describe('plate views', () => {
  it('knocks spot colors out of the process plates and other colors out of spot plates', async () => {
    const { doc, add, spotId } = await setup();
    const a = add({ fill: { type: 'solid', color: '#ff8000', swatchId: spotId } });
    const b = add({ fill: { type: 'solid', color: '#3366cc' } });
    const c = add({ fill: { type: 'solid', color: '#3366cc' } }, { overprintFill: true });
    const process = plateView(doc, 'process');
    expect(process.get(a).fill.color).toBe('#ffffff');
    expect(process.get(b).fill.color).toBe('#3366cc');
    const spot = plateView(doc, spotId);
    expect(spot.get(a).fill.color).toBe('#000000');
    expect(spot.get(b).fill.color).toBe('#ffffff');
    // Overprinting objects do not knock out the inks below.
    expect(spot.get(c).fill).toBeNull();
  });

  it('turns images into knockout shapes on spot plates', async () => {
    const { doc, ed, spotId } = await setup();
    const img = createImage('asset-1', 20, 10, [1, 0, 0, 1, 5, 5]);
    doc.transact('Img', () => doc.insert(img, ed.targetLayer().id));
    const n = plateView(doc, spotId).get(img.id);
    expect(n.type).toBe('path');
    expect(n.anchors.map((p) => [p.x, p.y])).toEqual([[5, 5], [25, 5], [25, 15], [5, 15]]);
  });
});

describe('ink math', () => {
  it('prints all process plates back to the original color', () => {
    const data = new Uint8ClampedArray([128, 128, 128, 255, 200, 60, 40, 255]);
    const params = { mode: 'separations', show: [1, 1, 1, 1], absorb: [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 1]], gain: 0, blackRel: [0, 0, 0] };
    inkPixels(data, params, (r, g, b, out) => separatePixel('basic', r, g, b, out));
    expect([...data.slice(0, 3)].every((v) => Math.abs(v - 128) <= 2)).toBe(true);
    expect(Math.abs(data[4] - 200) + Math.abs(data[5] - 60) + Math.abs(data[6] - 40)).toBeLessThan(8);
  });

  it('hides plates and shows one plate in black', () => {
    const lut = (r, g, b, out) => separatePixel('basic', r, g, b, out);
    const base = { mode: 'separations', absorb: [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 1]], gain: 0, blackRel: [0, 0, 0] };
    // Pure cyan with the cyan plate hidden prints nothing.
    const cyan = new Uint8ClampedArray([0, 255, 255, 255]);
    inkPixels(cyan, { ...base, show: [0, 1, 1, 1] }, lut);
    expect([...cyan.slice(0, 3)]).toEqual([255, 255, 255]);
    const single = new Uint8ClampedArray([0, 255, 255, 255]);
    inkPixels(single, { ...base, show: [1, 0, 0, 0], single: 0 }, lut);
    expect([...single.slice(0, 3)]).toEqual([0, 0, 0]);
    // Spot plates multiply in their ink color.
    const spot = new Uint8ClampedArray([255, 255, 255, 255]);
    inkPixels(spot, { ...base, show: [1, 1, 1, 1], spots: [{ data: new Uint8ClampedArray([0, 0, 0, 255]), absorb: [0, 0.5, 1], show: true }] }, lut);
    expect([...spot.slice(0, 3)]).toEqual([255, 128, 0]);
  });
});

describe('Separations Preview panel', () => {
  it('is listed in the Window menu and toggles the preview', async () => {
    const { app, ed, add, spotId } = await setup();
    expect(MENUS.find((m) => m.label === 'Window').submenu).toContain('panel.separations');
    add({ fill: { type: 'solid', color: '#ff8000', swatchId: spotId } });
    app.dock.openPanel('separations');
    const panel = app.dock.panels.get('separations');
    panel.update();
    const body = panel.el;
    const names = [...body.querySelectorAll('.sep-name')].map((n) => n.textContent);
    expect(names).toEqual(['CMYK', 'Cyan', 'Magenta', 'Yellow', 'Black', 'Brand Orange']);
    body.querySelector('#sep-on').click();
    expect(separationState(ed).on).toBe(true);
    // Hide black, then solo the spot plate with Alt+click.
    body.querySelector('[data-plate="k"] .sep-eye').click();
    expect(separationState(ed).hidden).toEqual(['k']);
    body.querySelector(`[data-plate="${spotId}"] .sep-eye`).dispatchEvent(new MouseEvent('click', { altKey: true, bubbles: true }));
    expect(new Set(separationState(ed).hidden)).toEqual(new Set(['c', 'm', 'y', 'k']));
    expect(inkParams(app, ed).spots[0]).toMatchObject({ id: spotId, show: true });
    // The composite row brings the process plates back.
    body.querySelector('[data-plate="cmyk"] .sep-eye').click();
    expect(separationState(ed).hidden).toEqual([]);
    // Unused spot inks only show when asked for.
    expect(listedPlates(app, ed).length).toBe(5);
    body.querySelector('#sep-over').click();
    expect(ed.viewOptions.overprint).toBe(true);
    expect(panel.menu().length).toBeGreaterThan(3);
  });

  it('renders and samples without a GPU', async () => {
    const { app, ed, add, spotId } = await setup();
    add({ fill: { type: 'solid', color: '#ff8000', swatchId: spotId } });
    ed.setViewOption('separations', { on: true });
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.canvas.width = 10;
    ctx.canvas.height = 10;
    expect(() => drawSeparations(app, ctx, ed)).not.toThrow();
    const r = inkAt(app, ed, 5, 5);
    expect(r).toMatchObject({ c: expect.any(Number), k: expect.any(Number) });
    expect(r.spots.map((s) => s.id)).toEqual([spotId]);
  });
});
