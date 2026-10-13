import { describe, it, expect } from 'vitest';
import { paintSetup } from './panels-paint-helpers.js';
import { addSwatch, findSwatch, swatchesOf, updateSwatch } from '../src/features/paint/swatch-model.js';

const solid = (color, extra = {}) => ({ type: 'solid', color, ...extra });

describe('Color panel menu', () => {
  it('has the options, modes, invert, complement and new swatch entries', async () => {
    const { panel, menuItem, app } = await paintSetup();
    const p = panel('color');
    const labels = p.menu().filter((x) => typeof x === 'object').map((x) => x.label);
    expect(labels).toEqual(['Hide Options', 'Grayscale', 'RGB', 'HSB', 'CMYK', 'Web Safe RGB', 'Invert', 'Complement', 'Create New Swatch...']);
    menuItem(p, 'HSB').run();
    expect(p.sliders.mode).toBe('hsb');
    expect(menuItem(p, 'HSB').checked).toBe(true);
    menuItem(p, 'Hide Options').run();
    expect(p.el.classList.contains('options-hidden')).toBe(true);
    expect(app.prefs.get('colorPanelOptions')).toBe(false);
    expect(menuItem(p, 'Show Options')).toBeTruthy();
    // The dock shows the header menu button instead of an in-panel one.
    expect(p.el.querySelector('[aria-label="Color panel menu"]')).toBe(null);
  });

  it('inverts and complements the focused color', async () => {
    const { ed, add, panel, menuItem } = await paintSetup();
    const id = add({ fill: solid('#ff0000') });
    ed.select([id]);
    const p = panel('color');
    menuItem(p, 'Invert').run();
    expect(ed.doc.get(id).fill.color).toBe('#00ffff');
    p.update();
    menuItem(p, 'Complement').run();
    expect(ed.doc.get(id).fill.color).toBe('#ff0000');
  });

  it('creates a swatch from the current color', async () => {
    const { ed, add, panel, menuItem } = await paintSetup();
    const id = add({ fill: solid('#123456') });
    ed.select([id]);
    const p = panel('color');
    const n = swatchesOf(ed.doc).length;
    const done = menuItem(p, 'Create New Swatch...').run();
    await new Promise((r) => setTimeout(r, 0));
    [...document.querySelectorAll('dialog button')].find((b) => b.textContent === 'OK').click();
    await done;
    expect(swatchesOf(ed.doc).length).toBe(n + 1);
    expect(swatchesOf(ed.doc).at(-1).paint).toEqual(solid('#123456'));
  });

  it('swaps and resets fill and stroke from the panel', async () => {
    const { ed, add, panel } = await paintSetup();
    const id = add({ fill: solid('#ff0000'), stroke: solid('#0000ff'), strokeWidth: 1 });
    ed.select([id]);
    const p = panel('color');
    p.swapBtn.click();
    expect(ed.doc.get(id).fill.color).toBe('#0000ff');
    p.defaultBtn.click();
    expect(ed.doc.get(id).fill.color).toBe('#ffffff');
    expect(ed.doc.get(id).stroke.color).toBe('#000000');
  });

  it('shows a tint slider for paints linked to a global swatch', async () => {
    const { ed, add, panel } = await paintSetup();
    let sw;
    ed.doc.transact('t', () => (sw = addSwatch(ed.doc, { name: 'Brand', paint: solid('#0000ff'), global: true })));
    const id = add({ fill: solid('#0000ff', { swatchId: sw }) });
    ed.select([id]);
    const p = panel('color');
    expect(p.tintRow.hidden).toBe(false);
    expect(p.tintSwatchName.textContent).toBe('Brand');
    p.tintRange.value = '50';
    p.tintRange.dispatchEvent(new Event('input'));
    expect(ed.doc.get(id).fill).toEqual(solid('#8080ff', { swatchId: sw, tint: 0.5 }));
    ed.doc.transact('edit', () => updateSwatch(ed.doc, sw, { paint: solid('#ff0000') }));
    expect(ed.doc.get(id).fill.color).toBe('#ff8080');
    expect(findSwatch(ed.doc, sw).paint.color).toBe('#ff0000');
    // Unlinked colors have no tint row.
    ed.doc.transact('t', () => ed.doc.update(id, { fill: solid('#00ff00') }));
    p.update();
    expect(p.tintRow.hidden).toBe(true);
  });
});
