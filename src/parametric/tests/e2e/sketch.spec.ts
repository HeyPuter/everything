import { type Page, expect, test } from '@playwright/test';
import { canvasCenter, openApp } from './helpers';
import type { SketchFeature, UnitSystem } from '../../src/model/types';

for (const units of ['MMGS', 'MKS', 'IPS'] as const) test(`accepting an unchanged sketch dimension preserves precision in ${units}`, async ({ page }) => {
  const errors = await openApp(page);
  await startSketch(page);
  await page.evaluate((units) => {
    const app = (window as unknown as { __parametric: {
      store: { doc: { units: UnitSystem } };
      sketchEditor: { edit(label: string, fn: (sk: SketchFeature) => void): void; openModify(id: string): void };
    } }).__parametric;
    app.store.doc.units = units;
    app.sketchEditor.edit('Add precise circle', (sk) => {
      sk.entities.push({ id: 'pc', t: 'point', x: 0, y: 0 }, { id: 'circle', t: 'circle', c: 'pc', r: 30.123456789 / 2 });
      sk.constraints.push({ id: 'diameter', type: 'diameter', refs: ['circle'], value: 30.123456789, at: [20, 20], name: 'D1' });
    });
    app.sketchEditor.openModify('diameter');
  }, units);
  const modify = page.getByRole('dialog', { name: 'Modify D1' });
  await modify.getByRole('textbox').press('Enter');
  await expect(modify).toHaveCount(0);
  const value = await page.evaluate(() => {
    const ed = (window as unknown as { __parametric: { sketchEditor: { sketch: SketchFeature } } }).__parametric.sketchEditor;
    return (ed.sketch.constraints.find((c) => c.id === 'diameter') as { value: number }).value;
  });
  expect(value).toBeCloseTo(30.123456789, 12);
  expect(errors).toEqual([]);
});

/** Opens a sketch on the Front plane once the camera faces it. */
async function startSketch(page: Page) {
  await page.getByRole('button', { name: /New part/ }).click();
  await page.getByRole('treeitem', { name: 'Front Plane' }).click();
  await page.getByRole('tab', { name: 'Sketch' }).click();
  await page.locator('[data-cmd="sketch"]').first().click();
  await expect(page.locator('.view-label')).toHaveText('Front');
  return canvasCenter(page);
}

test.describe('sketching', () => {
  for (const action of ['invalid cancel', 'invalid correction', 'live cancel', 'live accept', 'linked cancel'] as const) test(`an open Modify box preserves unit meaning on ${action}`, async ({ page }) => {
    const errors = await openApp(page);
    await startSketch(page);
    await page.evaluate((action) => {
      const a = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric;
      a.store.change('Add variable', (doc) => { doc.variables = [{ id: 'v1', name: 'Width', expr: '25.4' }]; });
      a.sketchEditor!.edit('Add dimensioned circle', (sk) => {
        sk.entities.push({ id: 'pc', t: 'point', x: 0, y: 0 }, { id: 'circle', t: 'circle', c: 'pc', r: 12.7 });
        sk.constraints.push({ id: 'diameter', type: 'diameter', refs: ['circle'], value: action === 'linked cancel' ? '=Width' : '=25.4', at: [20, 20], name: 'D1' });
      });
      a.sketchEditor!.openModify('diameter');
    }, action);
    const modify = page.getByRole('dialog', { name: 'Modify D1', exact: true });
    const input = modify.getByRole('textbox');
    await input.fill(action.startsWith('invalid') ? '-5' : action === 'linked cancel' ? '=Width*2' : '=50.8');
    if (action.startsWith('invalid')) {
      await page.evaluate(() => (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric.commands.run('properties'));
      const properties = page.getByRole('dialog', { name: 'Part Properties', exact: true });
      await properties.getByRole('combobox', { name: 'Unit system' }).selectOption('IPS');
      await properties.getByRole('button', { name: 'OK', exact: true }).click();
      await expect(input).toHaveValue('-5');
    } else {
      await page.evaluate(async (url) => {
        const { changeUnits } = await import(url);
        const a = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric;
        a.store.change('Change units', (doc) => changeUnits(doc, 'IPS'));
      }, '/src/model/document.ts');
      await expect(input).toHaveValue(action === 'linked cancel' ? '=Width*2' : '=2');
    }
    if (action.endsWith('cancel')) await input.press('Escape');
    else {
      if (action === 'invalid correction') await input.fill('2');
      await input.press('Enter');
    }
    await expect(modify).toHaveCount(0);
    const dimension = () => page.evaluate(() => {
      const ed = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric.sketchEditor!;
      const d = ed.sketch.constraints.find((c) => c.id === 'diameter') as import('../../src/model/types').SkDimension;
      return { value: ed.dimValue(d), expression: d.value, units: ed.app.store.doc.units };
    });
    expect((await dimension()).value).toBeCloseTo(action.endsWith('cancel') ? 25.4 : 50.8, 9);
    if (action === 'linked cancel') expect((await dimension()).expression).toBe('=Width');
    if (action === 'live accept') {
      await page.evaluate(() => (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric.commands.run('undo'));
      expect((await dimension()).value).toBeCloseTo(25.4, 9);
      expect((await dimension()).units).toBe('IPS');
    }
    expect(errors).toEqual([]);
  });

  for (const units of ['IPS', 'MKS'] as const) test(`a selected sketch dimension follows a change to ${units}`, async ({ page }) => {
    const errors = await openApp(page);
    await startSketch(page);
    await page.evaluate(() => {
      const a = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric;
      a.sketchEditor!.edit('Add dimensioned circle', (sk) => {
        sk.entities.push({ id: 'pc', t: 'point', x: 0, y: 0 }, { id: 'circle', t: 'circle', c: 'pc', r: 12.7 });
        sk.constraints.push({ id: 'diameter', type: 'diameter', refs: ['circle'], value: 25.4, at: [20, 20], name: 'D1' });
      });
      a.selection.set([{ kind: 'skdim', id: 'diameter' }]);
      a.commands.run('properties');
    });
    const properties = page.getByRole('dialog', { name: 'Part Properties', exact: true });
    await properties.getByRole('combobox', { name: 'Unit system' }).selectOption(units);
    await properties.getByRole('button', { name: 'OK', exact: true }).click();
    const field = page.getByRole('textbox', { name: 'Value', exact: true });
    await expect(field).toHaveValue(units === 'IPS' ? '1' : '0.0254');
    await page.evaluate(() => (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric.commands.run('undo'));
    await expect(field).toHaveValue('25.4');
    await page.evaluate(() => (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric.commands.run('redo'));
    await expect(field).toHaveValue(units === 'IPS' ? '1' : '0.0254');
    await field.fill('2');
    await field.press('Enter');
    const value = await page.evaluate(() => {
      const ed = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric.sketchEditor!;
      return ed.dimValue(ed.sketch.constraints.find((c) => c.id === 'diameter') as import('../../src/model/types').SkDimension);
    });
    expect(value).toBe(units === 'IPS' ? 50.8 : 2000);
    expect(errors).toEqual([]);
  });

  for (const action of ['Tab', 'Increase Value', 'Driven (reference only)'] as const) test(`leaving an edited dimension for ${action} completes the intended interaction`, async ({ page }) => {
    const errors = await openApp(page);
    const { x, y } = await startSketch(page);
    await page.locator('[data-cmd="tool:line"]').click();
    await page.mouse.click(x - 100, y + 60);
    await page.mouse.click(x + 100, y + 20);
    await page.keyboard.press('Escape');
    await page.keyboard.press('d');
    await page.mouse.click(x, y + 40);
    await page.mouse.click(x - 20, y + 100);
    await page.getByRole('dialog', { name: /Modify/ }).getByRole('textbox').press('Enter');
    await page.keyboard.press('Escape');
    await page.locator('.dim-label').click();
    const field = page.getByRole('textbox', { name: 'Value', exact: true });
    const driven = page.getByRole('checkbox', { name: 'Driven (reference only)' });
    await field.fill('25');
    if (action === 'Tab') {
      await field.press('Tab');
      await expect(driven).toBeFocused();
      await expect(field).toHaveValue('25');
    } else if (action === 'Increase Value') {
      await page.getByRole('button', { name: action, exact: true }).click();
      await expect(field).toHaveValue('26');
    } else {
      await driven.click();
      await expect(driven).toBeChecked();
      await expect(field).toHaveCount(0);
    }
    expect(errors).toEqual([]);
  });

  test('typing a sketch dimension keeps focus and unfinished decimal text through delayed updates', async ({ page }) => {
    const errors = await openApp(page);
    const { x, y } = await startSketch(page);
    await page.locator('[data-cmd="tool:line"]').click();
    await page.mouse.click(x - 100, y + 60);
    await page.mouse.click(x + 100, y + 20);
    await page.keyboard.press('Escape');
    await page.keyboard.press('d');
    await page.mouse.click(x, y + 40);
    await page.mouse.click(x - 20, y + 100);
    await page.getByRole('dialog', { name: /Modify/ }).getByRole('textbox').press('Enter');
    await page.keyboard.press('Escape');
    await page.locator('.dim-label').click();
    const field = page.getByRole('textbox', { name: 'Value', exact: true });
    const original = await field.inputValue();
    await field.fill('25.');
    await page.waitForTimeout(500);
    await expect(field).toBeFocused();
    await expect(field).toHaveValue('25.');
    await page.keyboard.type('5');
    await page.waitForTimeout(500);
    await expect(field).toBeFocused();
    await expect(field).toHaveValue('25.5');
    await field.evaluate((input: HTMLInputElement) => input.setSelectionRange(1, 1));
    await page.keyboard.type('0');
    await page.waitForTimeout(500);
    await expect(field).toHaveValue('205.5');
    expect(await field.evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd])).toEqual([2, 2]);
    await field.press('Escape');
    await expect(field).toHaveValue(original);
    await field.fill('25.5');
    await page.waitForTimeout(500);
    await field.press('ArrowUp');
    await expect(field).toHaveValue('26.5');
    await field.press('Tab');
    await page.locator('.dim-label').dblclick();
    await expect(page.getByRole('dialog', { name: /Modify/ }).getByRole('textbox')).toHaveValue('26.5');
    expect(errors).toEqual([]);
  });

  test('correcting an invalid dimension still accepts the value on an outside click', async ({ page }) => {
    const errors = await openApp(page);
    const { x, y } = await startSketch(page);
    await page.locator('[data-cmd="tool:line"]').click();
    await page.mouse.click(x - 100, y + 60);
    await page.mouse.click(x + 100, y + 20);
    await page.keyboard.press('Escape');
    await page.keyboard.press('d');
    await page.mouse.click(x, y + 40);
    await page.mouse.click(x - 20, y + 100);
    const modify = page.getByRole('dialog', { name: /Modify/ });
    const input = modify.getByRole('textbox');
    await input.fill('-5');
    await page.locator('.statusbar').click();
    await expect(modify.getByRole('alert')).toContainText('greater than zero');
    await input.fill('25');
    await page.locator('.statusbar').click();
    await expect(modify).toHaveCount(0);
    await page.locator('.dim-label').dblclick();
    await expect(input).toHaveValue('25');
    await input.press('Escape');
    expect(errors).toEqual([]);
  });

  test('a dimension that would over-define the sketch is driven and undoes in one step', async ({ page }) => {
    const errors = await openApp(page);
    const { x, y } = await startSketch(page);
    await page.locator('[data-cmd="tool:rectangle"]').click();
    await page.mouse.click(x - 100, y + 60);
    await page.mouse.click(x + 100, y - 60);
    await page.keyboard.press('Escape');
    await page.keyboard.press('d');
    // Bottom edge, then the top edge, whose length the rectangle already fixes.
    await page.mouse.click(x, y + 60);
    await page.mouse.click(x, y + 110);
    await page.getByRole('dialog', { name: /Modify/ }).getByRole('textbox').press('Enter');
    await page.mouse.click(x, y - 60);
    await page.mouse.click(x, y - 110);
    await expect(page.locator('.toast')).toContainText('driven');
    await expect(page.locator('.dim-label.driven')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await page.keyboard.press('ControlOrMeta+z');
    await expect(page.locator('.dim-label')).toHaveCount(1);
    await expect(page.locator('.statusbar')).toContainText('Under Defined');
    expect(errors).toEqual([]);
  });

  test('a new dimension stays driving when the sketch was already over defined elsewhere', async ({ page }) => {
    const errors = await openApp(page);
    const { x, y } = await startSketch(page);
    await page.locator('[data-cmd="tool:rectangle"]').click();
    await page.mouse.click(x - 100, y + 60);
    await page.mouse.click(x + 100, y - 60);
    await page.keyboard.press('Escape');
    // A redundant second horizontal relation on the bottom edge over-defines the sketch.
    await page.evaluate(() => {
      type Ed = { edit(l: string, f: (sk: { entities: { id: string; t: string }[]; constraints: unknown[] }) => void): void };
      const ed = (window as unknown as { __parametric: { sketchEditor: Ed } }).__parametric.sketchEditor;
      ed.edit('Add horizontal relation', (sk) => { sk.constraints.push({ id: 'extra', type: 'horizontal', refs: [sk.entities.filter((e) => e.t === 'line')[0].id] }); });
    });
    await expect(page.locator('.statusbar')).toContainText('Over Defined');
    // Dimensioning the left edge is unrelated to that conflict: it must stay driving.
    await page.keyboard.press('d');
    await page.mouse.click(x - 100, y);
    await page.mouse.click(x - 150, y);
    await expect(page.getByRole('dialog', { name: /Modify/ })).toBeVisible();
    await expect(page.locator('.dim-label.driven')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('previews in the Modify box never leave the geometry moved or broken', async ({ page }) => {
    const errors = await openApp(page);
    const { x, y } = await startSketch(page);
    await page.locator('[data-cmd="tool:line"]').click();
    await page.mouse.click(x - 100, y + 60);
    await page.mouse.click(x + 100, y + 20);
    await page.keyboard.press('Escape');
    await page.keyboard.press('d');
    await page.mouse.click(x, y + 40);
    await page.mouse.click(x - 20, y + 100);
    const points = () => page.evaluate(() => JSON.stringify((window as unknown as { __parametric: { sketchEditor: { sketch: { entities: unknown[] } } } }).__parametric.sketchEditor.sketch.entities));
    const before = await points();
    const box = page.getByRole('dialog', { name: /Modify/ }).getByRole('textbox');
    // Variable names are case-sensitive: phone keyboards must not capitalise or correct them.
    await expect(box).toHaveAttribute('autocapitalize', 'off');
    await expect(box).toHaveAttribute('autocorrect', 'off');
    // An absurd value overflows the solver; Esc then restores the line exactly.
    await box.fill('1e300');
    await box.fill('5');
    await box.press('Escape');
    expect(await points()).toBe(before);
    expect(before).not.toContain('null');
    // Esc with focus moved off the value (onto the box's Cancel button) also reverts.
    await page.locator('.dim-label').dblclick();
    await box.fill('5');
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Escape');
    await expect(box).toHaveCount(0);
    expect(await points()).toBe(before);
    // The value field in the panel refuses negative lengths too.
    await page.locator('.dim-label').click();
    const field = page.getByRole('textbox', { name: 'Value' });
    await field.fill('-5');
    await field.press('Enter');
    await expect(field).toHaveClass(/invalid/);
    expect(await points()).toBe(before);
    expect(errors).toEqual([]);
  });

  test('angle dimensions show degrees, accept a typed degree sign and reject angles over 180', async ({ page }) => {
    const errors = await openApp(page);
    const { x, y } = await startSketch(page);
    await page.locator('[data-cmd="tool:line"]').click();
    await page.mouse.click(x - 200, y + 100);
    await page.mouse.click(x - 100, y + 100);
    await page.mouse.click(x - 150, y + 20);
    await page.keyboard.press('Escape');
    await page.keyboard.press('d');
    await page.mouse.click(x - 140, y + 100);
    await page.mouse.click(x - 120, y + 60);
    await page.mouse.click(x - 112, y + 80);
    const modify = page.getByRole('dialog', { name: /Modify/ });
    await modify.getByRole('textbox').fill('200');
    await expect(modify.getByRole('alert')).toHaveText('Angle must be between 0° and 180°');
    await modify.getByRole('textbox').fill('30°');
    await expect(modify.getByRole('alert')).toHaveText('');
    await modify.getByRole('textbox').press('Enter');
    await expect(page.locator('.dim-label')).toHaveText('30.0°');
    await expect(page.locator('.statusbar')).toContainText('Under Defined');
    // The value field in the panel refuses angles over 180 too.
    await page.locator('.dim-label').click();
    const field = page.getByRole('textbox', { name: 'Value' });
    await field.fill('200');
    await field.press('Enter');
    await expect(field).toHaveClass(/invalid/);
    await expect(page.locator('.dim-label')).toHaveText('30.0°');
    await expect(page.locator('.statusbar')).toContainText('Under Defined');
    expect(errors).toEqual([]);
  });

  test('double-clicking a point while drawing does not drop or collapse the shape', async ({ page }) => {
    const errors = await openApp(page);
    const { x, y } = await startSketch(page);
    const kinds = () => page.evaluate(() => (window as unknown as { __parametric: { sketchEditor: { sketch: { entities: { t: string }[] } } } }).__parametric.sketchEditor.sketch.entities.filter((e) => e.t !== 'point').map((e) => e.t).join());
    // Slot: a double-click on the second centre waits for the width.
    await page.locator('[data-cmd="tool:slot"]').click();
    await page.mouse.click(x - 100, y - 80);
    await page.mouse.dblclick(x, y - 80);
    await page.mouse.click(x - 50, y - 55);
    await expect.poll(kinds).toBe('line,line,arc,arc,line');
    // Centerpoint arc: a double-click on the start point waits for the end.
    await page.locator('[data-cmd="tool:centerArc"]').click();
    await page.mouse.click(x, y + 60);
    await page.mouse.dblclick(x + 80, y + 60);
    expect(await kinds()).toBe('line,line,arc,arc,line');
    await page.mouse.click(x, y + 140);
    await expect.poll(kinds).toBe('line,line,arc,arc,line,arc');
    expect(errors).toEqual([]);
  });

  test('double-clicks in the 3 point arc, tangent arc and polygon tools keep the shape', async ({ page }) => {
    const errors = await openApp(page);
    const { x, y } = await startSketch(page);
    const kinds = () => page.evaluate(() => (window as unknown as { __parametric: { sketchEditor: { sketch: { entities: { t: string }[] } } } }).__parametric.sketchEditor.sketch.entities.filter((e) => e.t !== 'point').map((e) => e.t).join());
    // 3 point arc: a double-click on the start point still waits for the end point.
    await page.locator('[data-cmd="tool:arc3"]').click();
    await page.mouse.dblclick(x - 150, y - 80);
    await page.mouse.click(x - 50, y - 80);
    await page.mouse.click(x - 100, y - 120);
    await expect.poll(kinds).toBe('arc');
    // Tangent arc from that arc's end: a double-click on the start keeps the tool's start.
    await page.locator('[data-cmd="tool:tangentArc"]').click();
    await page.mouse.dblclick(x - 50, y - 80);
    await page.mouse.click(x, y - 40);
    await expect.poll(kinds).toBe('arc,arc');
    // Polygon: a double-click on the centre waits for the vertex.
    await page.locator('[data-cmd="tool:polygon"]').click();
    await page.mouse.dblclick(x + 100, y + 80);
    await page.mouse.click(x + 140, y + 80);
    await expect.poll(kinds).toBe('arc,arc,circle,line,line,line,line,line,line');
    expect(errors).toEqual([]);
  });

  test('Enter finishes a spline and keeps the tool, even after another command', async ({ page }) => {
    const errors = await openApp(page);
    const { x, y } = await startSketch(page);
    const kinds = () => page.evaluate(() => (window as unknown as { __parametric: { sketchEditor: { sketch: { entities: { t: string }[] } } } }).__parametric.sketchEditor.sketch.entities.filter((e) => e.t !== 'point').map((e) => e.t).join());
    const tool = () => page.evaluate(() => (window as unknown as { __parametric: { sketchEditor: { tool: { id: string } | null } } }).__parametric.sketchEditor.tool?.id);
    await page.locator('[data-cmd="tool:spline"]').click();
    await page.mouse.click(x - 100, y);
    await page.mouse.click(x, y - 50);
    await page.mouse.click(x + 100, y);
    await page.keyboard.press('Enter');
    await expect.poll(kinds).toBe('spline');
    expect(await tool()).toBe('spline');
    // Another command in between (zoom to fit) must not take over Enter.
    await page.mouse.click(x - 100, y + 80);
    await page.mouse.click(x, y + 120);
    await page.keyboard.press('f');
    await page.keyboard.press('Enter');
    await expect.poll(kinds).toBe('spline,spline');
    expect(await tool()).toBe('spline');
    expect(errors).toEqual([]);
  });

  test('undo in the middle of a line chain starts a fresh chain', async ({ page }) => {
    const errors = await openApp(page);
    const { x, y } = await startSketch(page);
    await page.locator('[data-cmd="tool:line"]').click();
    await page.mouse.click(x - 100, y + 60);
    await page.mouse.click(x + 100, y + 20);
    await page.keyboard.press('ControlOrMeta+z');
    await page.mouse.click(x + 100, y - 80);
    await page.mouse.click(x - 50, y - 80);
    // One new line whose end points both exist (not one hanging off the undone point).
    const dangling = () => page.evaluate(() => {
      const ents = (window as unknown as { __parametric: { sketchEditor: { sketch: { entities: { id: string; t: string; a?: string; b?: string }[] } } } }).__parametric.sketchEditor.sketch.entities;
      const ids = new Set(ents.map((e) => e.id));
      const lines = ents.filter((e) => e.t === 'line');
      return { lines: lines.length, dangling: lines.filter((l) => !ids.has(l.a!) || !ids.has(l.b!)).length };
    });
    await expect.poll(dangling).toEqual({ lines: 1, dangling: 0 });
    expect(errors).toEqual([]);
  });
  test('leaving a sketch with a tool still active leaves no sketch drawn over the model', async ({ page }) => {
    const errors = await openApp(page);
    const { x, y } = await startSketch(page);
    await page.locator('[data-cmd="tool:circle"]').click();
    await page.mouse.click(x, y);
    await page.mouse.click(x + 60, y);
    await page.mouse.move(x + 100, y + 30);
    // The circle tool is still active: cancelling it queues a preview redraw.
    await page.locator('button.ok[aria-label="Exit sketch"]').click();
    await page.waitForTimeout(200);
    const layers = await page.evaluate(() => {
      const r = (window as unknown as { __parametric: { renderer: { lines: Map<string, unknown>; points: Map<string, unknown> } } }).__parametric.renderer;
      return [...r.lines.keys(), ...r.points.keys()].filter((k) => k.startsWith('sk-'));
    });
    expect(layers).toEqual([]);
    expect(errors).toEqual([]);
  });
  test('dragging geometry keeps its definition state and colour', async ({ page }) => {
    const errors = await openApp(page);
    const { x, y } = await startSketch(page);
    await page.locator('[data-cmd="tool:rectangle"]').click();
    await page.mouse.click(x - 100, y + 60);
    await page.mouse.click(x + 100, y - 60);
    await page.keyboard.press('Escape');
    const status = page.locator('.statusbar');
    await expect(status).toContainText('Under Defined (4 DOF)');
    await page.mouse.move(x + 100, y);
    await page.mouse.down();
    await page.mouse.move(x + 140, y + 10, { steps: 5 });
    // Mid-drag the rectangle is still under defined (blue), not shown as fully defined.
    await expect(status).toContainText('Under Defined (4 DOF)');
    const free = await page.evaluate(() => (window as unknown as { __parametric: { sketchEditor: { solve: { freeEntities: Set<string> } } } }).__parametric.sketchEditor.solve.freeEntities.size);
    expect(free).toBeGreaterThan(0);
    await page.mouse.up();
    expect(errors).toEqual([]);
  });
  test('dragging a fully defined rectangle leaves it where it is', async ({ page }) => {
    const errors = await openApp(page);
    const { x, y } = await startSketch(page);
    await page.locator('[data-cmd="tool:rectangle"]').click();
    await page.mouse.click(x - 100, y + 60);
    await page.mouse.click(x + 100, y - 60);
    await page.keyboard.press('Escape');
    // Anchor the first corner at the origin and dimension both sides.
    const corners = () => page.evaluate(() => {
      type Ent = { id: string; t: string; x: number; y: number; a: string };
      type Ed = { sketch: { entities: Ent[]; constraints: unknown[] }; edit(l: string, f: (sk: { entities: Ent[]; constraints: unknown[] }) => void): void };
      const ed = (window as unknown as { __parametric: { sketchEditor: Ed } }).__parametric.sketchEditor;
      if (!ed.sketch.constraints.some((c) => (c as { id: string }).id === 'anchor')) {
        ed.edit('setup', (sk) => {
          const lines = sk.entities.filter((e) => e.t === 'line');
          sk.constraints.push({ id: 'anchor', type: 'coincident', refs: [lines[0].a, 'O'] },
            { id: 'dw', type: 'distance', refs: [lines[0].id], value: 30, at: [0, -10], name: 'D1' },
            { id: 'dh', type: 'distance', refs: [lines[1].id], value: 20, at: [40, 10], name: 'D2' });
        });
      }
      return ed.sketch.entities.filter((e) => e.t === 'point').map((e) => [Math.round(e.x * 1e6) / 1e6, Math.round(e.y * 1e6) / 1e6]);
    });
    const before = await corners();
    await expect(page.locator('.statusbar')).toContainText('Fully Defined');
    // Grab the corner opposite the anchor and pull it across to the other side.
    const c = await page.evaluate(() => {
      const ed = (window as unknown as { __parametric: { sketchEditor: { toScreen(p: number[]): number[] } } }).__parametric.sketchEditor;
      return ed.toScreen([30, 20]);
    });
    const box = (await page.locator('canvas.gl').boundingBox())!;
    await page.mouse.move(box.x + c[0], box.y + c[1]);
    await page.mouse.down();
    await page.mouse.move(box.x + c[0] - 300, box.y + c[1] + 250, { steps: 6 });
    await page.mouse.up();
    expect(await corners()).toEqual(before);
    await expect(page.locator('.statusbar')).toContainText('Fully Defined');
    expect(errors).toEqual([]);
  });
});

test('discard restores sketch edits even after the undo history fills', async ({ page }) => {
  const errors = await openApp(page);
  await startSketch(page);
  const state = () => page.evaluate(() => {
    const app = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric;
    return app.store.doc.features.map((f) => f.type === 'sketch' ? f.entities : []);
  });
  await page.evaluate(() => {
    const app = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric;
    // More edits than the bounded history can retain in one sketch session.
    for (let i = 0; i < 125; i++) app.sketchEditor!.edit('Add point', (sk) => {
      sk.entities.push({ id: `p${i}`, t: 'point', x: i, y: 10 });
    });
  });
  expect((await state())[0]).toHaveLength(125);
  await page.getByRole('button', { name: 'Discard sketch changes', exact: true }).click();
  await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect.poll(state).toEqual([]);
  // Discard can itself be taken back, even when individual edits aged out.
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(async () => (await state())[0]?.length).toBe(125);
  expect(errors).toEqual([]);
});
