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
  for (const units of ['IPS', 'MKS'] as const) for (const pending of [false, true]) test(`Offset updates its length field when units change to ${units} (pending ${pending})`, async ({ page }) => {
    const errors = await openApp(page);
    await startSketch(page);
    await page.evaluate(() => {
      const a = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric;
      a.store.change('Add variable', (doc) => { doc.variables = [{ id: 'gap', name: 'Gap', expr: '25.4' }]; });
      a.sketchEditor!.edit('Add circle', (sk) => sk.entities.push({ id: 'c', t: 'point', x: 0, y: 0 }, { id: 'circle', t: 'circle', c: 'c', r: 100 }));
      a.selection.set([{ kind: 'sk', id: 'circle' }]);
      a.commands.run('offset');
    });
    const input = page.getByRole('textbox', { name: 'Offset distance', exact: true });
    await input.fill(pending ? '=Gap' : '25.4');
    if (pending) {
      // Change context before the field's debounce or blur commits its expression.
      await page.evaluate((units) => {
        const a = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric;
        a.store.change('Change units', (doc) => { doc.units = units; });
      }, units);
    } else {
      await input.press('Tab');
      await page.evaluate(() => (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric.commands.run('properties'));
      const properties = page.getByRole('dialog', { name: 'Part Properties', exact: true });
      await properties.getByRole('combobox', { name: 'Unit system' }).selectOption(units);
      await properties.getByRole('button', { name: 'OK', exact: true }).click();
    }
    const scale = units === 'IPS' ? 25.4 : 1000;
    expect(Number(await input.inputValue())).toBeCloseTo(25.4 / scale, 10);
    await input.fill('2');
    await input.press('Tab');
    await page.getByRole('button', { name: 'OK', exact: true }).first().click();
    const radius = await page.evaluate(() => {
      const e = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric.sketchEditor!.sketch.entities.find((e) => e.t === 'circle' && e.id !== 'circle');
      return e?.t === 'circle' ? e.r : null;
    });
    expect(radius).toBeCloseTo(100 + 2 * scale, 8);
    expect(errors).toEqual([]);
  });

  for (const units of ['MMGS', 'IPS'] as const) for (const expression of ['=2+3', '=Gap/2', '2+3']) test(`Offset evaluates ${expression} in ${units} before creating geometry`, async ({ page }) => {
    const errors = await openApp(page);
    await startSketch(page);
    await page.evaluate((units) => {
      const a = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric;
      a.store.change('Set units and variable', (doc) => { doc.units = units; doc.variables = [{ id: 'gap', name: 'Gap', expr: '10' }]; });
      a.sketchEditor!.edit('Add circle', (sk) => sk.entities.push({ id: 'c', t: 'point', x: 0, y: 0 }, { id: 'circle', t: 'circle', c: 'c', r: 100 }));
      a.selection.set([{ kind: 'sk', id: 'circle' }]);
      a.commands.run('offset');
    }, units);
    const input = page.getByRole('textbox', { name: 'Offset distance', exact: true });
    await expect(input).toHaveAttribute('inputmode', 'text');
    await input.fill(expression);
    await input.press('Tab');
    await page.getByRole('button', { name: 'OK', exact: true }).first().click();
    const radii = () => page.evaluate(() => (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric.sketchEditor!.sketch.entities.filter((e) => e.t === 'circle').map((e) => e.r));
    const expected = [100, 100 + 5 * (units === 'IPS' ? 25.4 : 1)];
    expect(await radii()).toEqual(expected);
    await page.evaluate(() => (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric.commands.run('undo'));
    expect(await radii()).toEqual([100]);
    await page.evaluate(() => (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric.commands.run('redo'));
    expect(await radii()).toEqual(expected);
    expect(errors).toEqual([]);
  });

  for (const shape of ['semicircle', 'lens'] as const) test(`an impossible inward ${shape} offset leaves the sketch and Redo unchanged`, async ({ page }) => {
    const errors = await openApp(page);
    await startSketch(page);
    const original = await page.evaluate((shape) => {
      const a = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric;
      const ed = a.sketchEditor!;
      ed.edit('Add curved profile', (sk) => sk.entities.push(...(shape === 'semicircle' ? [
        { id: 'c', t: 'point', x: 0, y: 0 }, { id: 'a', t: 'point', x: 5, y: 0 }, { id: 'b', t: 'point', x: -5, y: 0 },
        { id: 'arc', t: 'arc', c: 'c', a: 'a', b: 'b' }, { id: 'line', t: 'line', a: 'b', b: 'a' },
      ] : [
        { id: 'c', t: 'point', x: 3, y: 0 }, { id: 'd', t: 'point', x: -3, y: 0 },
        { id: 'a', t: 'point', x: 0, y: 4 }, { id: 'b', t: 'point', x: 0, y: -4 },
        { id: 'arc', t: 'arc', c: 'c', a: 'a', b: 'b' }, { id: 'arc2', t: 'arc', c: 'd', a: 'b', b: 'a' },
      ]) as import('../../src/model/types').SkEntity[]));
      ed.edit('Add marker', (sk) => sk.entities.push({ id: 'marker', t: 'point', x: 30, y: 30 }));
      a.commands.run('undo');
      a.selection.set(ed.sketch.entities.filter((e) => e.t !== 'point').map((e) => ({ kind: 'sk', id: e.id })));
      a.commands.run('offset');
      return JSON.stringify(ed.sketch);
    }, shape);
    await page.getByRole('textbox', { name: 'Offset distance', exact: true }).fill(shape === 'semicircle' ? '3' : '2');
    await page.getByRole('checkbox', { name: 'Reverse (inward)', exact: true }).check();
    await page.getByRole('button', { name: 'OK', exact: true }).first().click();
    expect(await page.evaluate(() => JSON.stringify((window as unknown as { __parametric: import('../../src/app/app').App }).__parametric.sketchEditor!.sketch))).toBe(original);
    await expect(page.locator('.toast')).toContainText('Nothing could be offset');
    await page.evaluate(() => (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric.commands.run('redo'));
    expect(await page.evaluate(() => (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric.sketchEditor!.sketch.entities.some((e) => e.id === 'marker'))).toBe(true);
    expect(errors).toEqual([]);
  });

  test('Offset joins a short line to its arc beyond the former extension range through Undo/Redo', async ({ page }) => {
    const errors = await openApp(page);
    await startSketch(page);
    await page.evaluate(() => {
      const a = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric;
      a.sketchEditor!.edit('Add connected line and arc', (sk) => sk.entities.push(
        { id: 'c', t: 'point', x: 0, y: 0 }, { id: 'a', t: 'point', x: 1, y: 0 }, { id: 'b', t: 'point', x: 0, y: 1 },
        { id: 'line', t: 'line', a: 'c', b: 'a' }, { id: 'arc', t: 'arc', c: 'c', a: 'a', b: 'b' },
      ));
      a.selection.set([{ kind: 'sk', id: 'line' }, { kind: 'sk', id: 'arc' }]);
      a.commands.run('offset');
    });
    await page.getByRole('textbox', { name: 'Offset distance', exact: true }).fill('1000000');
    await page.getByRole('checkbox', { name: 'Reverse (inward)', exact: true }).check();
    await page.getByRole('button', { name: 'OK', exact: true }).first().click();
    const geometry = () => page.evaluate(() => {
      const ed = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric.sketchEditor!;
      const line = ed.sketch.entities.find((e) => e.t === 'line' && e.id !== 'line');
      const arc = ed.sketch.entities.find((e) => e.t === 'arc' && e.id !== 'arc');
      return {
        count: ed.sketch.entities.filter((e) => e.t !== 'point').length,
        joined: line?.t === 'line' && arc?.t === 'arc' && [line.a, line.b].includes(arc.a),
        converged: ed.solve?.converged,
      };
    });
    expect(await geometry()).toEqual({ count: 4, joined: true, converged: true });
    await page.evaluate(() => (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric.commands.run('undo'));
    expect((await geometry()).count).toBe(2);
    await page.evaluate(() => (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric.commands.run('redo'));
    expect(await geometry()).toEqual({ count: 4, joined: true, converged: true });
    expect(errors).toEqual([]);
  });

  for (const offset of [0, 20]) test(`the rectangle tool creates a filletable corner at ${offset},${offset}`, async ({ page }) => {
    const errors = await openApp(page);
    await startSketch(page);
    const result = await page.evaluate((offset) => {
      const a = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric;
      const ed = a.sketchEditor!;
      a.commands.run('tool:rectangle');
      const first: [number, number] = [offset, offset], second: [number, number] = [offset + 40, offset + 30];
      ed.tool!.click!({ p: first, raw: first, kind: offset === 0 ? 'origin' : 'none' }, {} as import('../../src/app/viewport').VPEvent);
      ed.tool!.click!({ p: second, raw: second, kind: 'none' }, {} as import('../../src/app/viewport').VPEvent);
      const corner = ed.sketch.entities.find((e) => e.t === 'point' && e.x === offset && e.y === offset)!;
      const picked = ed.pickAt(first);
      a.commands.run('tool:sketchFillet');
      ed.tool!.click!({ p: first, raw: first, kind: 'none' }, {} as import('../../src/app/viewport').VPEvent);
      return { corner: corner.id, picked, arcs: ed.sketch.entities.filter((e) => e.t === 'arc').length, converged: ed.solve?.converged };
    }, offset);
    expect(result.arcs).toBe(1);
    expect(result.picked).toEqual({ kind: 'point', id: result.corner });
    expect(result.converged).toBe(true);
    await page.evaluate(() => (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric.commands.run('undo'));
    expect(await page.evaluate(() => (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric.sketchEditor!.sketch.entities.filter((e) => e.t === 'arc'))).toEqual([]);
    await page.evaluate(() => (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric.commands.run('redo'));
    expect(await page.evaluate(() => (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric.sketchEditor!.sketch.entities.filter((e) => e.t === 'arc'))).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  test('point picking preserves the origin fallback and stable coincident-point order', async ({ page }) => {
    const errors = await openApp(page);
    await startSketch(page);
    const result = await page.evaluate(() => {
      const ed = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric.sketchEditor!;
      const bare = ed.pickAt([0, 0]);
      ed.edit('Add nearby point', (sk) => sk.entities.push({ id: 'nearby', t: 'point', x: ed.px, y: 0 }));
      const closerOrigin = ed.pickAt([0, 0]), closerPoint = ed.pickAt([ed.px, 0]);
      ed.edit('Add coincident points', (sk) => sk.entities.push(
        { id: 'first', t: 'point', x: 0, y: 0 }, { id: 'second', t: 'point', x: 0, y: 0 },
      ));
      return { bare, closerOrigin, closerPoint, coincident: ed.pickAt([0, 0]) };
    });
    expect(result.bare).toEqual({ kind: 'point', id: 'O' });
    expect(result.closerOrigin).toEqual(result.bare);
    expect(result.closerPoint).toEqual({ kind: 'point', id: 'nearby' });
    expect(result.coincident).toEqual({ kind: 'point', id: 'first' });
    expect(errors).toEqual([]);
  });

  test('filleting construction lines keeps the arc out of solid profiles through Undo/Redo', async ({ page }) => {
    const errors = await openApp(page);
    await startSketch(page);
    await page.evaluate(() => {
      const a = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric;
      a.sketchEditor!.edit('Add construction corner', (sk) => sk.entities.push(
        { id: 'corner', t: 'point', x: 20, y: 20 }, { id: 'a', t: 'point', x: 40, y: 20 }, { id: 'b', t: 'point', x: 20, y: 40 },
        { id: 'h', t: 'line', a: 'corner', b: 'a', construction: true }, { id: 'v', t: 'line', a: 'b', b: 'corner', construction: true },
        { id: 'c', t: 'point', x: 25, y: 20 }, { id: 'd', t: 'point', x: 20, y: 25 }, { id: 'chord', t: 'line', a: 'c', b: 'd' },
      ));
      a.commands.run('tool:sketchFillet');
      a.sketchEditor!.tool!.click!({ p: [20, 20], raw: [20, 20], kind: 'none' }, {} as import('../../src/app/viewport').VPEvent);
    });
    const state = () => page.evaluate(async (url) => {
      const { buildProfiles } = await import(url);
      const a = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric;
      const entities = a.sketchEditor!.sketch.entities;
      return { arcs: entities.filter((e) => e.t === 'arc'), profiles: buildProfiles(entities).regions.length };
    }, '/src/sketch/profiles.ts');
    expect(await state()).toMatchObject({ arcs: [expect.objectContaining({ construction: true })], profiles: 0 });
    await page.evaluate(() => (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric.commands.run('undo'));
    expect(await state()).toEqual({ arcs: [], profiles: 0 });
    await page.evaluate(() => (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric.commands.run('redo'));
    expect(await state()).toMatchObject({ arcs: [expect.objectContaining({ construction: true })], profiles: 0 });
    expect(errors).toEqual([]);
  });

  for (const action of ['delete', 'driven', 'replaced'] as const) test(`an open Modify box retires when its dimension becomes ${action}`, async ({ page }) => {
    const errors = await openApp(page);
    await startSketch(page);
    await page.evaluate(() => {
      const a = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric;
      a.sketchEditor!.edit('Add dimensioned circle', (sk) => {
        sk.entities.push({ id: 'pc', t: 'point', x: 0, y: 0 }, { id: 'circle', t: 'circle', c: 'pc', r: 15 });
        sk.constraints.push({ id: 'diameter', type: 'diameter', refs: ['circle'], value: 30, at: [20, 20], name: 'D1' });
      });
      a.selection.set([{ kind: 'skdim', id: 'diameter' }]);
      a.sketchEditor!.openModify('diameter');
    });
    const modify = page.getByRole('dialog', { name: 'Modify D1', exact: true });
    await modify.getByRole('textbox').fill('40');
    const oldInput = await modify.getByRole('textbox').elementHandle();
    const afterChange = await page.evaluate((action) => {
      const a = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric;
      if (action === 'delete') a.commands.run('delete');
      else if (action === 'driven') a.sketchEditor!.edit('Make dimension driven', (sk) => { (sk.constraints[0] as import('../../src/model/types').SkDimension).driven = true; });
      else a.sketchEditor!.edit('Replace dimension', (sk) => { sk.constraints[0] = { ...(sk.constraints[0] as import('../../src/model/types').SkDimension), value: 60 }; });
      return JSON.stringify(a.sketchEditor!.sketch);
    }, action);
    // A queued input/composition callback from the former editor must be inert.
    await oldInput!.evaluate((input) => {
      (input as HTMLInputElement).value = '50';
      input.dispatchEvent(new InputEvent('input', { bubbles: true }));
      input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    });
    expect(errors).toEqual([]);
    await expect(modify).toHaveCount(0);
    expect(await page.evaluate(() => JSON.stringify((window as unknown as { __parametric: import('../../src/app/app').App }).__parametric.sketchEditor!.sketch))).toBe(afterChange);
    await page.evaluate(() => (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric.commands.run('undo'));
    expect(await page.evaluate(() => (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric.sketchEditor!.sketch.constraints)).toEqual([
      expect.objectContaining({ id: 'diameter', value: 30 }),
    ]);
    await page.evaluate(() => (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric.commands.run('redo'));
    expect(await page.evaluate(() => JSON.stringify((window as unknown as { __parametric: import('../../src/app/app').App }).__parametric.sketchEditor!.sketch))).toBe(afterChange);
    expect(errors).toEqual([]);
  });

  test('deleting a dimension cancels its pending field without errors and supports Undo', async ({ page }) => {
    const errors = await openApp(page);
    await startSketch(page);
    await page.evaluate(() => {
      const a = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric;
      a.sketchEditor!.edit('Add dimensioned circle', (sk) => {
        sk.entities.push({ id: 'pc', t: 'point', x: 0, y: 0 }, { id: 'circle', t: 'circle', c: 'pc', r: 15 });
        sk.constraints.push({ id: 'diameter', type: 'diameter', refs: ['circle'], value: 30, at: [20, 20], name: 'D1' });
      });
      a.selection.set([{ kind: 'skdim', id: 'diameter' }]);
    });
    await page.getByRole('textbox', { name: 'Value', exact: true }).fill('40');
    await page.evaluate(() => (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric.commands.run('delete'));
    await page.waitForTimeout(550);
    expect(await page.evaluate(() => (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric.sketchEditor!.sketch.constraints)).toEqual([]);
    expect(errors).toEqual([]);
    await page.evaluate(() => (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric.commands.run('undo'));
    expect(await page.evaluate(() => (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric.sketchEditor!.sketch.constraints)).toEqual([
      expect.objectContaining({ id: 'diameter', value: 30 }),
    ]);
    await page.evaluate(() => (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric.commands.run('redo'));
    expect(await page.evaluate(() => (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric.sketchEditor!.sketch.constraints)).toEqual([]);
    await page.evaluate(() => {
      const a = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric;
      a.commands.run('undo');
      a.selection.set([{ kind: 'skdim', id: 'diameter' }]);
    });
    await page.getByRole('textbox', { name: 'Value', exact: true }).fill('42');
    await page.getByRole('textbox', { name: 'Value', exact: true }).press('Enter');
    expect(await page.evaluate(() => (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric.sketchEditor!.sketch.constraints)).toEqual([
      expect.objectContaining({ id: 'diameter', value: 42 }),
    ]);
    expect(errors).toEqual([]);
  });

  test('Trim at an intersection preserves the sketch and Redo, then accepts a click beside it', async ({ page }) => {
    const errors = await openApp(page);
    await startSketch(page);
    const state = await page.evaluate(() => {
      const a = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric;
      const ed = a.sketchEditor!;
      ed.edit('Add crossing lines', (sk) => sk.entities.push(
        { id: 'a', t: 'point', x: 0, y: 10 }, { id: 'b', t: 'point', x: 100, y: 10 },
        { id: 'h', t: 'line', a: 'a', b: 'b' },
        { id: 'c', t: 'point', x: 50, y: -30 }, { id: 'd', t: 'point', x: 50, y: 50 },
        { id: 'v', t: 'line', a: 'c', b: 'd' },
      ));
      ed.edit('Add point', (sk) => sk.entities.push({ id: 'extra', t: 'point', x: 200, y: 200 }));
      a.commands.run('undo');
      a.commands.run('tool:trim');
      const before = JSON.stringify(ed.sketch);
      ed.tool!.click!({ p: [50, 10], raw: [50, 10], kind: 'none' }, {} as import('../../src/app/viewport').VPEvent);
      return { before, after: JSON.stringify(ed.sketch), canRedo: a.store.canRedo };
    });
    expect(state.after).toBe(state.before);
    expect(state.canRedo).toBe(true);
    await expect(page.locator('.statusbar')).toContainText('Click between intersections');
    const ends = await page.evaluate(() => {
      const a = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric;
      const ed = a.sketchEditor!;
      ed.tool!.click!({ p: [40, 10], raw: [40, 10], kind: 'none' }, {} as import('../../src/app/viewport').VPEvent);
      const line = ed.sketch.entities.find((e) => e.id === 'h');
      if (line?.t !== 'line') throw new Error('Expected trimmed line');
      return [line.a, line.b].map((id) => {
        const point = ed.sketch.entities.find((e) => e.id === id);
        return point?.t === 'point' ? [point.x, point.y] : null;
      });
    });
    expect(ends).toEqual([[50, 10], [100, 10]]);
    await expect(page.locator('.statusbar')).not.toContainText('Nothing trimmed');
    expect(errors).toEqual([]);
  });

  test('trimming a circle at a repeated tangent cut removes it and supports Undo/Redo', async ({ page }) => {
    const errors = await openApp(page);
    await startSketch(page);
    await page.evaluate(() => {
      const a = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric;
      a.sketchEditor!.edit('Add circle with split tangent', (sk) => {
        sk.entities.push(
          { id: 'o', t: 'point', x: 0, y: 0 }, { id: 'circle', t: 'circle', c: 'o', r: 30 },
          { id: 'a', t: 'point', x: 30, y: -40 }, { id: 'b', t: 'point', x: 30, y: 0 }, { id: 'c', t: 'point', x: 30, y: 40 },
          { id: 'l1', t: 'line', a: 'a', b: 'b' }, { id: 'l2', t: 'line', a: 'b', b: 'c' },
        );
      });
      a.commands.run('tool:trim');
      a.sketchEditor!.tool!.click!({ p: [-30, 0], raw: [-30, 0], kind: 'none' }, {} as import('../../src/app/viewport').VPEvent);
    });
    const curves = () => page.evaluate(() => {
      const a = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric;
      return a.sketchEditor!.sketch.entities.filter((e) => e.t !== 'point').map((e) => ({ id: e.id, t: e.t }));
    });
    expect(await curves()).toEqual([{ id: 'l1', t: 'line' }, { id: 'l2', t: 'line' }]);
    await page.evaluate(() => (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric.commands.run('undo'));
    expect(await curves()).toEqual([{ id: 'circle', t: 'circle' }, { id: 'l1', t: 'line' }, { id: 'l2', t: 'line' }]);
    await page.evaluate(() => (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric.commands.run('redo'));
    expect(await curves()).toEqual([{ id: 'l1', t: 'line' }, { id: 'l2', t: 'line' }]);
    expect(errors).toEqual([]);
  });

  for (const tool of ['perimeterCircle', 'arc3'] as const) for (const offset of [0, 1e9]) test(`${tool} preserves three picked points at coordinate offset ${offset}`, async ({ page }) => {
    const errors = await openApp(page);
    await startSketch(page);
    const result = await page.evaluate(({ tool, offset }) => {
      const a = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric;
      a.commands.run(`tool:${tool}`);
      const ed = a.sketchEditor!;
      // Feed exact snapped positions to the real drawing tool and sketch solver.
      const positions: [number, number][] = [[offset + 5, offset], [offset - 5, offset], [offset, offset + 5]];
      for (const p of positions) ed.tool!.click!({ p, raw: p, kind: 'none' }, {} as import('../../src/app/viewport').VPEvent);
      const curve = ed.sketch.entities.find((e) => e.t === 'circle' || e.t === 'arc');
      const center = curve && ed.sketch.entities.find((e) => e.id === curve.c);
      return { curve, center: center?.t === 'point' ? [center.x, center.y] : null, points: ed.sketch.entities.filter((e) => e.t === 'point'), converged: ed.solve?.converged };
    }, { tool, offset });
    expect(result.center?.[0]).toBeCloseTo(offset, 7);
    expect(result.center?.[1]).toBeCloseTo(offset, 7);
    if (tool === 'perimeterCircle') expect(result.curve).toMatchObject({ t: 'circle', r: 5 });
    else {
      expect(result.points).toEqual(expect.arrayContaining([
        expect.objectContaining({ x: offset + 5, y: offset }), expect.objectContaining({ x: offset - 5, y: offset }),
      ]));
    }
    expect(result.converged).toBe(true);
    expect(errors).toEqual([]);
  });

  for (const action of ['undo', 'redo', 'replace', 'save'] as const) test(`pending sketch input is handled before ${action} removes its field`, async ({ page }) => {
    const errors = await openApp(page);
    await startSketch(page);
    await page.evaluate((action) => {
      const a = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric;
      a.sketchEditor!.edit('Add dimensioned circle', (sk) => {
        sk.entities.push({ id: 'pc', t: 'point', x: 0, y: 0 }, { id: 'circle', t: 'circle', c: 'pc', r: 15 });
        sk.constraints.push({ id: 'diameter', type: 'diameter', refs: ['circle'], value: 30, at: [20, 20], name: 'D1' });
      });
      a.sketchEditor!.edit('Resize circle', (sk) => { (sk.constraints[0] as import('../../src/model/types').SkDimension).value = 35; });
      if (action === 'redo') a.commands.run('undo');
      a.selection.set([{ kind: 'skdim', id: 'diameter' }]);
    }, action);
    await page.getByRole('textbox', { name: 'Value', exact: true }).fill('40');
    if (action === 'save') await page.keyboard.press('ControlOrMeta+s');
    else await page.evaluate((action) => {
      const a = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric;
      if (action === 'undo' || action === 'redo') a.commands.run(action);
      else a.newDocument('Replacement');
    }, action);
    await page.waitForTimeout(550);
    const state = await page.evaluate(() => {
      const a = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric;
      const sk = a.store.doc.features.find((f) => f.type === 'sketch');
      return { name: a.store.doc.name, value: sk?.constraints.find((c) => c.id === 'diameter'), dirty: a.store.dirty, canRedo: a.store.canRedo, inSketch: a.inSketch };
    });
    expect(errors).toEqual([]);
    if (action === 'replace') expect(state).toMatchObject({ name: 'Replacement', dirty: false });
    else {
      expect(state.value).toMatchObject({ value: action === 'save' ? 40 : action === 'redo' ? 35 : 30 });
      if (action === 'undo' || action === 'redo') {
        expect(state.canRedo).toBe(action === 'undo');
        // The replacement field remains editable after retiring the old one.
        await page.getByRole('textbox', { name: 'Value', exact: true }).fill('42');
        await page.getByRole('textbox', { name: 'Value', exact: true }).press('Enter');
        expect(await page.evaluate(() => {
          const a = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric;
          return (a.sketchEditor!.sketch.constraints[0] as import('../../src/model/types').SkDimension).value;
        })).toBe(42);
      }
      else {
        expect(state).toMatchObject({ dirty: false, inSketch: false });
        const saved = await page.evaluate(async (url) => {
          const a = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric;
          const { loadText } = await import(url);
          return JSON.parse(await loadText(a.location!));
        }, '/src/platform/files.ts');
        expect(saved.features[0].constraints[0].value).toBe(40);
      }
    }
  });

  test('a collapsed mirror axis gives feedback without adding geometry or undo history', async ({ page }) => {
    const errors = await openApp(page);
    await startSketch(page);
    const before = await page.evaluate(() => {
      const app = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric;
      app.sketchEditor!.edit('Collapse mirror axis', (sk) => {
        sk.entities.push(
          { id: 'a', t: 'point', x: 0, y: -10 }, { id: 'b', t: 'point', x: 0, y: 10 }, { id: 'axis', t: 'line', a: 'a', b: 'b', construction: true },
          { id: 'p', t: 'point', x: 3, y: 1 }, { id: 'q', t: 'point', x: 6, y: 4 }, { id: 'line', t: 'line', a: 'p', b: 'q' },
        );
        sk.constraints.push({ id: 'collapse', type: 'coincident', refs: ['a', 'b'] });
      });
      app.selection.set([{ kind: 'sk', id: 'line' }, { kind: 'sk', id: 'axis' }]);
      return { sketch: JSON.stringify(app.sketchEditor!.sketch), undo: app.store.undoLabel };
    });
    await page.locator('[data-cmd="mirrorEntities"]').first().click();
    await expect(page.getByText('Choose a mirror axis with distinct endpoints.', { exact: true })).toBeVisible();
    const after = await page.evaluate(() => {
      const app = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric;
      return { sketch: JSON.stringify(app.sketchEditor!.sketch), undo: app.store.undoLabel };
    });
    expect(after).toEqual(before);
    await page.evaluate(() => {
      const app = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric;
      app.sketchEditor!.edit('Restore mirror axis', (sk) => {
        sk.constraints = sk.constraints.filter((c) => c.id !== 'collapse');
        const a = sk.entities.find((e) => e.id === 'a')!;
        const b = sk.entities.find((e) => e.id === 'b')!;
        if (a.t === 'point' && b.t === 'point') { a.x = b.x = 0; a.y = -10; b.y = 10; }
      });
    });
    await page.locator('[data-cmd="mirrorEntities"]').first().click();
    const mirrored = await page.evaluate(() => {
      const app = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric;
      return { points: app.sketchEditor!.sketch.entities.filter((e) => e.t === 'point').map((e) => [e.x, e.y]), undo: app.store.undoLabel };
    });
    expect(mirrored.points).toEqual(expect.arrayContaining([[-3, 1], [-6, 4]]));
    expect(mirrored.undo).toBe('Mirror entities');
    expect(errors).toEqual([]);
  });

  for (const editor of ['panel', 'Modify', 'Modify live'] as const) for (const action of ['rename', 'delete'] as const) test(`the sketch ${editor} follows a variable ${action}`, async ({ page }) => {
    const errors = await openApp(page);
    await startSketch(page);
    await page.evaluate((editor) => {
      const a = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric;
      a.store.change('Add variable', (doc) => { doc.variables = [{ id: 'v1', name: 'Width', expr: '25.4' }]; });
      a.sketchEditor!.edit('Add linked circle', (sk) => {
        sk.entities.push({ id: 'pc', t: 'point', x: 0, y: 0 }, { id: 'circle', t: 'circle', c: 'pc', r: 12.7 });
        sk.constraints.push({ id: 'diameter', type: 'diameter', refs: ['circle'], value: '=Width', at: [20, 20], name: 'D1' });
      });
      if (editor !== 'panel') a.sketchEditor!.openModify('diameter');
      else a.selection.set([{ kind: 'skdim', id: 'diameter' }]);
    }, editor);
    const field = editor !== 'panel' ? page.getByRole('dialog', { name: 'Modify D1', exact: true }).getByRole('textbox') : page.getByRole('textbox', { name: 'Value', exact: true });
    // Invalid text keeps Modify open while interacting with the equations dialog.
    if (editor === 'Modify') await field.fill('-5');
    if (editor === 'Modify live') await field.fill('=Width*2');
    await page.evaluate(() => (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric.commands.run('equations'));
    const equations = page.getByRole('dialog', { name: 'Equations and Global Variables', exact: true });
    if (action === 'rename') await equations.getByRole('textbox', { name: 'Name of variable 1' }).fill('Span');
    else if (editor === 'Modify live') await equations.getByRole('button', { name: 'Delete Width', exact: true }).press('Enter');
    else await equations.getByRole('button', { name: 'Delete Width', exact: true }).click();
    if (editor === 'Modify live') await equations.getByRole('button', { name: 'OK', exact: true }).press('Enter');
    else await equations.getByRole('button', { name: 'OK', exact: true }).click();
    if (editor !== 'panel') {
      await expect(field).toHaveValue(editor === 'Modify' ? '-5' : action === 'rename' ? '=Span*2' : '=25.4*2');
      await field.press('Escape');
    } else {
      await expect(field).toHaveValue(action === 'rename' ? '=Span' : '=25.4');
      await field.press('Enter');
    }
    const value = await page.evaluate(() => {
      const ed = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric.sketchEditor!;
      return ed.dimValue(ed.sketch.constraints.find((c) => c.id === 'diameter') as import('../../src/model/types').SkDimension);
    });
    expect(value).toBeCloseTo(25.4, 9);
    if (editor === 'Modify live') for (const command of ['undo', 'redo']) {
      const state = await page.evaluate((command) => {
        const a = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric;
        a.commands.run(command);
        const ed = a.sketchEditor!;
        const dim = ed.sketch.constraints.find((c) => c.id === 'diameter') as import('../../src/model/types').SkDimension;
        const circle = ed.sketch.entities.find((e) => e.id === 'circle');
        return { value: ed.dimValue(dim), expression: dim.value, radius: circle?.t === 'circle' ? circle.r : null };
      }, command);
      expect(state.value).toBeCloseTo(25.4, 9);
      expect(state.radius).toBeCloseTo(12.7, 9);
      expect(state.expression).toBe(command === 'undo' ? '=Width' : action === 'rename' ? '=Span' : '=25.4');
    }
    expect(errors).toEqual([]);
  });

  for (const action of ['invalid cancel', 'invalid correction', 'live cancel', 'live accept', 'linked cancel', 'live undo'] as const) test(`an open Modify box preserves unit meaning on ${action}`, async ({ page }) => {
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
    if (action === 'live undo') await page.evaluate(() => (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric.commands.run('undo'));
    else if (action.endsWith('cancel')) await input.press('Escape');
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
    expect((await dimension()).value).toBeCloseTo(action.endsWith('cancel') || action === 'live undo' ? 25.4 : 50.8, 9);
    if (action === 'live undo') {
      expect((await dimension()).units).toBe('MMGS');
      await page.evaluate(() => (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric.commands.run('redo'));
      expect((await dimension()).units).toBe('IPS');
      expect((await dimension()).value).toBeCloseTo(25.4, 9);
    }
    if (action === 'linked cancel') expect((await dimension()).expression).toBe('=Width');
    if (action === 'live accept') {
      await page.evaluate(() => (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric.commands.run('undo'));
      expect((await dimension()).value).toBeCloseTo(25.4, 9);
      expect((await dimension()).units).toBe('IPS');
      await page.evaluate(() => (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric.commands.run('undo'));
      expect((await dimension()).units).toBe('MMGS');
      expect((await dimension()).value).toBeCloseTo(25.4, 9);
      await page.evaluate(() => (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric.commands.run('redo'));
      expect((await dimension()).units).toBe('IPS');
      expect((await dimension()).value).toBeCloseTo(25.4, 9);
      await page.evaluate(() => (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric.commands.run('redo'));
      expect((await dimension()).value).toBeCloseTo(50.8, 9);
    }
    if (action.endsWith('cancel')) {
      await page.evaluate(() => (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric.commands.run('undo'));
      expect((await dimension()).units).toBe('MMGS');
      expect((await dimension()).value).toBeCloseTo(25.4, 9);
      await page.evaluate(() => (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric.commands.run('redo'));
      expect((await dimension()).units).toBe('IPS');
      expect((await dimension()).value).toBeCloseTo(25.4, 9);
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

  for (const [input, change, delay] of [
    ['40', 'units', 0], ['=Width + 10', 'units', 0], ['Width + 10', 'units', 0], ['=Width + 10', 'units', 500],
    ['=Width + 10', 'rename', 0], ['=Width + 10', 'delete', 0],
  ] as const) test(`a sketch ${change} change preserves dimension input ${input} after ${delay} ms`, async ({ page }) => {
    const errors = await openApp(page);
    await startSketch(page);
    await page.evaluate(async (url) => {
      await import(url);
      const a = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric;
      a.store.change('Add variable', (doc) => { doc.variables = [{ id: 'v1', name: 'Width', expr: '30' }]; });
      a.sketchEditor!.edit('Add circle', (sk) => {
        sk.entities.push({ id: 'pc', t: 'point', x: 0, y: 0 }, { id: 'circle', t: 'circle', c: 'pc', r: 15 });
        sk.constraints.push({ id: 'diameter', type: 'diameter', refs: ['circle'], value: '=Width', at: [20, 20], name: 'D1' });
      });
      a.selection.set([{ kind: 'skdim', id: 'diameter' }]);
    }, '/src/model/document.ts');
    const field = page.getByRole('textbox', { name: 'Value', exact: true });
    await field.fill(input);
    if (delay) await page.waitForTimeout(delay);
    await page.evaluate(async ({ url, change }) => {
      const { changeUnits, mapExpressions } = await import(url);
      const a = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric;
      a.store.change('Change context', (doc) => {
        if (change === 'units') changeUnits(doc, 'IPS');
        else {
          mapExpressions(doc, (src: string) => src.replace(/Width/g, change === 'rename' ? 'Span' : '30'));
          if (change === 'rename') doc.variables[0].name = 'Span';
          else doc.variables = [];
        }
      });
    }, { url: '/src/model/document.ts', change });
    await page.waitForTimeout(500);
    const dimension = () => page.evaluate(() => {
      const a = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric;
      const d = a.sketchEditor!.sketch.constraints.find((c) => c.id === 'diameter') as import('../../src/model/types').SkDimension;
      return a.sketchEditor!.dimValue(d);
    });
    expect(await dimension()).toBeCloseTo(40, 8);
    if (change === 'rename') await expect(field).toHaveValue('=Span + 10');
    if (change === 'delete') await expect(field).toHaveValue('=30 + 10');
    await field.press('Enter');
    expect(await dimension()).toBeCloseTo(40, 8);
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

for (const splineFirst of [false, true]) test(`Smart Dimension rejects spline curves and accepts their points (spline first ${splineFirst})`, async ({ page }) => {
  const errors = await openApp(page);
  await startSketch(page);
  await page.getByRole('button', { name: 'Close task pane', exact: true }).click();
  await page.evaluate(() => {
    const a = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric;
    a.sketchEditor!.edit('Add spline and line', (sk) => sk.entities.push(
      { id: 's0', t: 'point', x: 20, y: 30 }, { id: 's1', t: 'point', x: 40, y: 30 }, { id: 's2', t: 'point', x: 60, y: 30 },
      { id: 'sp', t: 'spline', pts: ['s0', 's1', 's2'] },
      { id: 'a', t: 'point', x: 20, y: 10 }, { id: 'b', t: 'point', x: 60, y: 10 }, { id: 'l', t: 'line', a: 'a', b: 'b' },
    ));
    a.sketchEditor!.edit('Add marker', (sk) => sk.entities.push({ id: 'marker', t: 'point', x: 100, y: 100 }));
    a.commands.run('undo');
    a.commands.run('tool:smartDimension');
    a.viewport.zoomToFit(false);
  });
  const click = async (p: [number, number]) => {
    const at = await page.evaluate((p) => {
      const ed = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric.sketchEditor!;
      const [x, y] = ed.toScreen(p), box = ed.app.viewport.canvas.getBoundingClientRect();
      return { x: x + box.x, y: y + box.y };
    }, p);
    await page.mouse.click(at.x, at.y);
  };
  await click([30, splineFirst ? 30 : 10]);
  await click([30, splineFirst ? 10 : 30]);
  await click([30, 20]);
  const state = () => page.evaluate(() => {
    const a = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric;
    return { constraints: a.sketchEditor!.sketch.constraints, canRedo: a.store.canRedo };
  });
  expect(await state()).toEqual({ constraints: [], canRedo: true });
  await expect(page.getByText('These entities cannot be dimensioned together. Select one or two lines, points, circles or arcs.', { exact: true })).toBeVisible();
  // Retry with the spline's points without restarting the tool.
  await click([20, 30]);
  await click([40, 30]);
  await click([30, 20]);
  await page.getByRole('dialog', { name: 'Modify D1', exact: true }).getByRole('textbox').press('Enter');
  expect((await state()).constraints).toEqual([expect.objectContaining({ type: 'hdistance', refs: ['s0', 's1'], value: 20 })]);
  await page.evaluate(() => (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric.commands.run('undo'));
  expect((await state()).constraints).toEqual([]);
  await page.evaluate(() => (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric.commands.run('redo'));
  expect((await state()).constraints).toEqual([expect.objectContaining({ type: 'hdistance', refs: ['s0', 's1'], value: 20 })]);
  expect(errors).toEqual([]);
});

for (const tool of ['smartDimension', 'line', 'spline'] as const) test(`Delete resets pending ${tool} references and allows a fresh operation`, async ({ page }) => {
  const errors = await openApp(page);
  await startSketch(page);
  await page.getByRole('button', { name: 'Close task pane', exact: true }).click();
  await page.evaluate(() => {
    const a = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric;
    a.sketchEditor!.edit('Add two lines', (sk) => sk.entities.push(
      { id: 'a', t: 'point', x: 20, y: 10 }, { id: 'b', t: 'point', x: 60, y: 10 }, { id: 'l1', t: 'line', a: 'a', b: 'b' },
      { id: 'c', t: 'point', x: 20, y: 30 }, { id: 'd', t: 'point', x: 60, y: 30 }, { id: 'l2', t: 'line', a: 'c', b: 'd' },
    ));
    a.viewport.zoomToFit(false);
  });
  const click = async (p: [number, number]) => {
    const at = await page.evaluate((p) => {
      const ed = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric.sketchEditor!;
      const [x, y] = ed.toScreen(p), box = ed.app.viewport.canvas.getBoundingClientRect();
      return { x: x + box.x, y: y + box.y };
    }, p);
    await page.mouse.click(at.x, at.y);
  };
  const state = () => page.evaluate(() => {
    const a = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric;
    const sk = a.sketchEditor!.sketch;
    const ids = new Set(sk.entities.filter((e) => e.t === 'point').map((e) => e.id));
    const valid = sk.entities.every((e) => e.t === 'point' || (e.t === 'line' ? [e.a, e.b] : e.t === 'spline' ? e.pts : e.t === 'circle' ? [e.c] : [e.c, e.a, e.b]).every((id) => ids.has(id)));
    return { lines: sk.entities.filter((e) => e.t === 'line').map((e) => e.id), splines: sk.entities.filter((e) => e.t === 'spline').length, constraints: sk.constraints, valid, tool: a.sketchEditor!.tool?.id };
  });
  await click([30, 10]);
  await page.evaluate((tool) => (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric.commands.run(`tool:${tool}`), tool);
  await click(tool === 'smartDimension' ? [30, 10] : [60, 10]);
  if (tool === 'spline') await click([40, 20]);
  await page.keyboard.press('Delete');
  expect(await state()).toMatchObject({ lines: ['l2'], splines: 0, valid: true, tool });
  if (tool === 'smartDimension') {
    await click([30, 30]);
    await click([30, 20]);
    const modify = page.getByRole('dialog', { name: 'Modify D1', exact: true });
    await expect(modify).toBeVisible();
    await modify.getByRole('textbox').press('Enter');
    expect((await state()).constraints).toEqual([expect.objectContaining({ type: 'hdistance', refs: ['l2'], value: 40 })]);
  } else if (tool === 'line') {
    await click([40, 20]);
    expect(await state()).toMatchObject({ lines: ['l2'], valid: true });
    await click([20, 20]);
    expect((await state()).lines).toHaveLength(2);
  } else {
    await click([20, 20]);
    await click([40, 20]);
    await click([60, 20]);
    await page.keyboard.press('Enter');
    expect((await state()).splines).toBe(1);
  }
  expect((await state()).valid).toBe(true);
  await page.keyboard.press('ControlOrMeta+z');
  expect(await state()).toMatchObject({ lines: ['l2'], splines: 0, constraints: [], valid: true });
  await page.keyboard.press('ControlOrMeta+z');
  expect((await state()).lines).toEqual(['l1', 'l2']);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  expect(await state()).toMatchObject({ lines: ['l2'], splines: 0, constraints: [], valid: true });
  expect(errors).toEqual([]);
});

for (const tool of ['line', 'spline'] as const) test(`Delete with no selection preserves an unfinished ${tool}`, async ({ page }) => {
  const errors = await openApp(page);
  const { x, y } = await startSketch(page);
  await page.locator(`[data-cmd="tool:${tool}"]`).click();
  await page.mouse.click(x - 100, y + 50);
  await page.keyboard.press('Delete');
  await page.mouse.click(x, y + 50);
  if (tool === 'spline') {
    await page.mouse.click(x + 100, y + 100);
    await page.keyboard.press('Enter');
  }
  const curves = await page.evaluate(() => (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric.sketchEditor!.sketch.entities.filter((e) => e.t !== 'point'));
  expect(curves).toHaveLength(1);
  expect(curves[0].t).toBe(tool);
  expect(errors).toEqual([]);
});

for (const history of ['undo', 'redo'] as const) for (const tool of ['idle', 'line', 'spline'] as const) test(`${history} removes the active sketch safely with ${tool} pending`, async ({ page }) => {
  const errors = await openApp(page);
  const { x, y } = await startSketch(page);
  if (history === 'redo') {
    await page.evaluate(() => {
      const a = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric;
      const id = a.sketchEditor!.sketchId;
      a.exitSketch(true);
      void a.deleteFeatures([id]);
    });
    await page.getByRole('dialog', { name: 'Delete', exact: true }).getByRole('button', { name: 'Delete', exact: true }).click();
    await page.keyboard.press('ControlOrMeta+z');
    await page.evaluate(() => {
      const a = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric;
      a.editSketch(a.store.doc.features[0].id);
    });
  }
  if (tool !== 'idle') {
    await page.locator(`[data-cmd="tool:${tool}"]`).click();
    await page.mouse.click(x - 100, y + 50);
    if (tool === 'spline') await page.mouse.click(x, y + 50);
  }
  await page.keyboard.press(history === 'undo' ? 'ControlOrMeta+z' : 'ControlOrMeta+Shift+z');
  const state = () => page.evaluate(() => {
    const a = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric;
    return { inSketch: a.inSketch, features: a.store.doc.features, canRedo: a.store.canRedo, viewportTool: !!a.viewport.tool };
  });
  const undone = await state();
  expect(errors).toEqual([]);
  expect(undone).toEqual({ inSketch: false, features: [], canRedo: history === 'undo', viewportTool: false });
  await page.keyboard.press(history === 'undo' ? 'ControlOrMeta+Shift+z' : 'ControlOrMeta+z');
  expect(await state()).toMatchObject({ inSketch: false, features: [expect.objectContaining({ type: 'sketch', entities: [], constraints: [] })], viewportTool: false });
  // The restored sketch can be reopened and edited normally.
  await page.evaluate(() => {
    const a = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric;
    a.editSketch(a.store.doc.features[0].id);
  });
  await page.locator('[data-cmd="tool:line"]').click();
  await page.mouse.click(x - 100, y + 50);
  await page.mouse.click(x, y + 50);
  expect(await page.evaluate(() => (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric.sketchEditor!.sketch.entities.filter((e) => e.t === 'line').length)).toBe(1);
  expect(errors).toEqual([]);
});

test('normal Exit Sketch still finishes an unfinished spline as an undoable edit', async ({ page }) => {
  const errors = await openApp(page);
  const { x, y } = await startSketch(page);
  await page.locator('[data-cmd="tool:spline"]').click();
  await page.mouse.click(x - 100, y + 50);
  await page.mouse.click(x, y + 50);
  await page.locator('[data-cmd="sketch"]').first().click();
  const state = () => page.evaluate(() => {
    const a = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric;
    const sk = a.store.doc.features.find((f) => f.type === 'sketch')!;
    return { inSketch: a.inSketch, splines: sk.entities.filter((e) => e.t === 'spline').length };
  });
  expect(await state()).toEqual({ inSketch: false, splines: 1 });
  await page.keyboard.press('ControlOrMeta+z');
  expect(await state()).toEqual({ inSketch: false, splines: 0 });
  await page.keyboard.press('ControlOrMeta+Shift+z');
  expect(await state()).toEqual({ inSketch: false, splines: 1 });
  expect(errors).toEqual([]);
});
