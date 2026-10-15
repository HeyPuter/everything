import { test, expect, type Page } from '@playwright/test';
import { openApp, expectNoErrors } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Win = { app: any };

const row = (page: Page, name: string, nth = 0) =>
  page
    .locator('.outliner .ol-row', {
      has: page.locator('.ol-name', { hasText: new RegExp(`^${name}$`) }),
    })
    .nth(nth);
const names = (page: Page) => page.evaluate(() => [...document.querySelectorAll('.outliner .ol-row .ol-name')].map((e) => e.textContent));
const selected = (page: Page) =>
  page.evaluate(() => {
    const a = (window as unknown as Win).app;
    return Object.values(a.doc.objects as Record<string, { name: string; select: boolean }>)
      .filter((o) => o.select)
      .map((o) => o.name)
      .sort();
  });
const activeName = (page: Page) => page.evaluate(() => (window as unknown as Win).app.activeObject?.name ?? null);

async function hoverOutliner(page: Page) {
  const b = (await page.locator('.outliner .ol-list').first().boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height - 6);
}

test('outliner: click, ctrl and shift selection stay in sync with objects', async ({ page }) => {
  const errors = await openApp(page);
  await row(page, 'Light').locator('.ol-name').click();
  expect(await selected(page)).toEqual(['Light']);
  expect(await activeName(page)).toBe('Light');
  await row(page, 'Camera')
    .locator('.ol-name')
    .click({ modifiers: ['ControlOrMeta'] });
  expect(await selected(page)).toEqual(['Camera', 'Light']);
  expect(await activeName(page)).toBe('Camera');
  // shift: range from the active row
  await row(page, 'Light')
    .locator('.ol-name')
    .click({ modifiers: ['Shift'] });
  expect(await selected(page)).toEqual(['Camera', 'Cube', 'Light']);
  // clicking a collection selects it in the outliner and deselects objects
  await row(page, 'Collection').locator('.ol-name').click();
  expect(await selected(page)).toEqual([]);
  await expect(row(page, 'Collection')).toHaveClass(/selected/);
  // clicking an object's data toggles edit mode
  await row(page, 'Cube').locator('.ol-arrow').dispatchEvent('pointerdown');
  await row(page, 'Cube', 1).locator('.ol-name').click();
  await expect.poll(() => page.evaluate(() => (window as unknown as Win).app.doc.mode)).toBe('EDIT');
  expect(await activeName(page)).toBe('Cube');
  await row(page, 'Cube', 1).locator('.ol-name').click();
  await expect.poll(() => page.evaluate(() => (window as unknown as Win).app.doc.mode)).toBe('OBJECT');
  await row(page, 'Cube').locator('.ol-arrow').dispatchEvent('pointerdown');
  // clicking empty space deselects everything
  await row(page, 'Cube').locator('.ol-name').click();
  const list = (await page.locator('.outliner .ol-list').first().boundingBox())!;
  await page.mouse.click(list.x + list.width / 2, list.y + list.height - 4);
  expect(await selected(page)).toEqual([]);
  await expectNoErrors(errors);
});

test('outliner: keyboard walk, expand and rename', async ({ page }) => {
  const errors = await openApp(page);
  await row(page, 'Camera').locator('.ol-name').click();
  await hoverOutliner(page);
  await page.keyboard.press('ArrowDown');
  expect(await activeName(page)).toBe('Cube');
  await page.keyboard.press('Shift+ArrowDown');
  expect(await selected(page)).toEqual(['Cube', 'Light']);
  expect(await activeName(page)).toBe('Light');
  // Right opens the active object, Left closes it again
  await page.keyboard.press('ArrowRight');
  await expect(row(page, 'Light', 1)).toBeVisible();
  await page.keyboard.press('ArrowLeft');
  await expect(row(page, 'Light', 1)).toHaveCount(0);
  // Shift+A expands everything, again collapses
  await page.keyboard.press('Shift+A');
  await expect(page.locator('.outliner .ol-row', { hasText: 'Material' })).toHaveCount(1);
  await page.keyboard.press('Shift+A');
  await expect(page.locator('.outliner .ol-row', { hasText: 'Material' })).toHaveCount(0);
  // everything below the scene collection is closed now: Numpad + opens one level, Numpad - closes it
  await expect(row(page, 'Cube')).toHaveCount(0);
  await page.keyboard.press('NumpadAdd');
  await expect(row(page, 'Cube')).toHaveCount(1);
  await page.keyboard.press('NumpadSubtract');
  await expect(row(page, 'Cube')).toHaveCount(0);
  await page.keyboard.press('NumpadAdd');
  await expect(row(page, 'Cube')).toHaveCount(1);
  // F2 renames the active element
  await page.keyboard.press('F2');
  const input = page.locator('.outliner .ol-rename');
  await expect(input).toBeVisible();
  await input.fill('Lamp');
  await input.press('Enter');
  expect(await activeName(page)).toBe('Lamp');
  // double-click on a name renames too
  await row(page, 'Cube').locator('.ol-name').dblclick();
  await page.locator('.outliner .ol-rename').fill('Box');
  await page.locator('.outliner .ol-rename').press('Enter');
  expect((await names(page)).includes('Box')).toBe(true);
  await expectNoErrors(errors);
});

test('outliner: box select, hide and collection operations', async ({ page }) => {
  const errors = await openApp(page);
  // drag over the empty right part of the rows
  const cam = (await row(page, 'Camera').boundingBox())!;
  const light = (await row(page, 'Light').boundingBox())!;
  await page.mouse.move(cam.x + cam.width - 90, cam.y + cam.height / 2);
  await page.mouse.down();
  await page.mouse.move(cam.x + cam.width - 90, light.y + 12, { steps: 5 });
  await page.mouse.up();
  expect(await selected(page)).toEqual(['Camera', 'Cube', 'Light']);
  // H hides the selection, Alt+H shows everything again
  await row(page, 'Cube').locator('.ol-name').click();
  await hoverOutliner(page);
  await page.keyboard.press('h');
  expect(await page.evaluate(() => Object.values((window as unknown as Win).app.doc.objects as Record<string, any>).find((o) => o.name === 'Cube').hide)).toBe(true);
  await page.keyboard.press('Alt+h');
  expect(await page.evaluate(() => Object.values((window as unknown as Win).app.doc.objects as Record<string, any>).find((o) => o.name === 'Cube').hide)).toBe(false);
  // C adds a collection inside the selected one; E excludes it, Alt+E brings it back
  await row(page, 'Collection').locator('.ol-name').click();
  await hoverOutliner(page);
  await page.keyboard.press('c');
  await expect(row(page, 'Collection.001')).toHaveCount(1);
  await page.keyboard.press('e');
  await expect(row(page, 'Collection.001')).toHaveClass(/dim/);
  await page.keyboard.press('Alt+e');
  await expect(row(page, 'Collection.001')).not.toHaveClass(/dim/);
  // context menu: color tag and Visibility > Hide
  await row(page, 'Collection.001').locator('.ol-name').click({ button: 'right' });
  await page.locator('.menu-item', { hasText: 'Set Color Tag' }).hover();
  await page.locator('.menu-item', { hasText: 'Color 03' }).click();
  expect(await page.evaluate(() => Object.values((window as unknown as Win).app.doc.collections as Record<string, any>).find((c) => c.name === 'Collection.001').color_tag)).toBe('COLOR_03');
  await expect(row(page, 'Collection.001').locator('.ol-icon')).toHaveClass(/ct-COLOR_03/);
  // Duplicate the main collection: its objects are copied
  await row(page, 'Collection').locator('.ol-name').click({ button: 'right' });
  await page.locator('.menu-item', { hasText: /^Duplicate Collection/ }).click();
  await expect(row(page, 'Cube.001')).toHaveCount(1);
  // X deletes the selected objects
  await row(page, 'Cube.001').locator('.ol-name').click();
  await hoverOutliner(page);
  await page.keyboard.press('x');
  await expect(row(page, 'Cube.001')).toHaveCount(0);
  await expectNoErrors(errors);
});

test('outliner: drag and drop, restriction columns, filter and search', async ({ page }) => {
  const errors = await openApp(page);
  await page.evaluate(() =>
    (window as unknown as Win).app.run('outliner.collection_new', {
      nested: false,
    }),
  );
  await expect(row(page, 'Collection.001')).toHaveCount(1);
  // dropping a collection into the 3D viewport adds an instance of it
  await row(page, 'Collection.001').locator('.ol-item').dragTo(page.locator('.view3d').first());
  expect(
    await page.evaluate(() => {
      const a = (window as unknown as Win).app;
      const c = Object.values(a.doc.collections as Record<string, any>).find((x) => x.name === 'Collection.001');
      return Object.values(a.doc.objects as Record<string, any>).filter((o) => o.instance_collection === c.id).length;
    }),
  ).toBe(1);
  // drop an object onto another collection moves it there
  await row(page, 'Light').locator('.ol-item').dragTo(row(page, 'Collection.001').locator('.ol-name'));
  const where = await page.evaluate(() => {
    const a = (window as unknown as Win).app;
    const light = Object.values(a.doc.objects as Record<string, any>).find((o) => o.name === 'Light');
    return Object.values(a.doc.collections as Record<string, any>)
      .filter((c) => c.objects.includes(light.id))
      .map((c) => c.name);
  });
  expect(where).toEqual(['Collection.001']);
  // drop onto an object parents it
  await row(page, 'Camera').locator('.ol-item').dragTo(row(page, 'Cube').locator('.ol-name'));
  expect(
    await page.evaluate(() => {
      const a = (window as unknown as Win).app;
      const obs = Object.values(a.doc.objects as Record<string, any>);
      return obs.find((o) => o.name === 'Camera').parent === obs.find((o) => o.name === 'Cube').id;
    }),
  ).toBe(true);
  // restriction toggles: the eye hides an object; the filter popover adds the selectable column
  await row(page, 'Cube').locator('.ol-toggle.col-hide').dispatchEvent('pointerdown');
  expect(await page.evaluate(() => Object.values((window as unknown as Win).app.doc.objects as Record<string, any>).find((o) => o.name === 'Cube').hide)).toBe(true);
  await expect(page.locator('.outliner .ol-toggle.col-select')).toHaveCount(0);
  await page.locator('.ol-filter-btn').dispatchEvent('pointerdown');
  await page.locator('.olf-col[aria-label="Selectable"]').click();
  await expect(page.locator('.outliner .ol-toggle.col-select').first()).toBeVisible();
  // filter popover: hide lights
  await page.locator('.olf-check', { hasText: 'Lights' }).locator('.checkbox').dispatchEvent('pointerdown');
  await expect(row(page, 'Light')).toHaveCount(0);
  await page.keyboard.press('Escape');
  // search
  await page.locator('.ol-search input').fill('cam');
  await expect(row(page, 'Camera')).toHaveCount(1);
  await expect(row(page, 'Light')).toHaveCount(0);
  await expect(row(page, 'Camera')).toHaveClass(/match/);
  // display modes
  await page.locator('.ol-search input').fill('');
  await page.locator('.ol-display-mode').dispatchEvent('pointerdown');
  await page.locator('.menu-item', { hasText: 'Blender File' }).click();
  await expect(page.locator('.outliner .ol-row', { hasText: 'Current File' })).toHaveCount(1);
  await expect(page.locator('.outliner .ol-row', { hasText: 'Scenes' }).locator('.ol-count')).toHaveText('1');
  // the display mode is part of the editor state (layouts and workspace templates)
  expect(
    await page.evaluate(async () => {
      const { currentOutliner } = await import('/src/editors/outliner/current.ts');
      return (currentOutliner() as unknown as { serialize(): { displayMode: string } }).serialize().displayMode;
    }),
  ).toBe('BLENDER_FILE');
  await expectNoErrors(errors);
});

const field = (page: Page, suffix: string) => page.locator(`.properties .num-field[data-id$="${suffix}"]`).first();
const loc = (page: Page) => page.evaluate(() => [...(window as unknown as Win).app.activeObject.location].map((v: number) => Math.round(v * 1000) / 1000));

test('buttons: keyframes, reset, copy/paste, data path and the button menu', async ({ page }) => {
  const errors = await openApp(page);
  await field(page, '.location.0').hover();
  await page.keyboard.press('i');
  const curves = () =>
    page.evaluate(() => {
      const a = (window as unknown as Win).app;
      const act = a.doc.actions[a.activeObject.animation_data?.action];
      return act ? act.fcurves.map((f: any) => `${f.data_path}[${f.array_index}]`) : [];
    });
  expect(await curves()).toEqual(['location[0]', 'location[1]', 'location[2]']);
  await expect(field(page, '.location.0')).toHaveClass(/anim-keyed/);
  // Alt+I deletes the keys on this frame, I again and Shift+Alt+I clears the curves
  await page.keyboard.press('Alt+i');
  expect(await curves()).toEqual([]);
  await page.keyboard.press('i');
  await page.keyboard.press('Shift+Alt+i');
  expect(await curves()).toEqual([]);
  // Backspace resets to the default value
  await page.evaluate(() => {
    const a = (window as unknown as Win).app;
    a.activeObject.location = [1, 2, 3];
    a.activeObject.scale = [2, 2, 2];
    a.changed('doc');
  });
  await field(page, '.location.1').hover();
  await page.keyboard.press('Backspace');
  expect(await loc(page)).toEqual([0, 0, 0]);
  await field(page, '.scale.0').hover();
  await page.keyboard.press('Backspace');
  expect(await page.evaluate(() => [...(window as unknown as Win).app.activeObject.scale])).toEqual([1, 1, 1]);
  // Ctrl+C / Ctrl+V copy a single value, Ctrl+Alt+C / Ctrl+Alt+V the whole vector
  await page.evaluate(() => {
    const a = (window as unknown as Win).app;
    a.activeObject.scale = [1.5, 2.5, 3.5];
    a.changed('doc');
  });
  await field(page, '.scale.1').hover();
  await page.keyboard.press('ControlOrMeta+c');
  await field(page, '.location.0').hover();
  await page.keyboard.press('ControlOrMeta+v');
  await expect.poll(() => loc(page)).toEqual([2.5, 0, 0]);
  await field(page, '.scale.0').hover();
  await page.keyboard.press('ControlOrMeta+Alt+c');
  await field(page, '.location.2').hover();
  await page.keyboard.press('ControlOrMeta+Alt+v');
  await expect.poll(() => loc(page)).toEqual([1.5, 2.5, 3.5]);
  // Ctrl+Shift+Alt+C copies the full data path
  await page.keyboard.press('ControlOrMeta+Shift+Alt+c');
  expect(await page.evaluate(() => (window as unknown as Win).app.reports.at(-1).message)).toBe('Copied: bpy.data.objects["Cube"].location[2]');
  // right-click menu on a button
  await field(page, '.location.2').click({ button: 'right' });
  await expect(page.locator('.menu-item', { hasText: 'Insert Single Keyframe' })).toBeVisible();
  await page.locator('.menu-item', { hasText: 'Reset Single to Default Value' }).click();
  expect(await loc(page)).toEqual([1.5, 2.5, 0]);
  await expectNoErrors(errors);
});

test('buttons: multi-drag, Alt copy to selected, eyedropper and enum Ctrl+wheel', async ({ page }) => {
  const errors = await openApp(page);
  // drag down over the stacked location fields, then sideways: all three change together
  const a = (await field(page, '.location.0').boundingBox())!;
  const c = (await field(page, '.location.2').boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2, a.y + 20, { steps: 3 });
  await page.mouse.move(c.x + c.width / 2, c.y + c.height / 2, { steps: 4 });
  await expect(page.locator('.num-field.multi-sel')).toHaveCount(3);
  await page.mouse.move(c.x + c.width / 2 + 60, c.y + c.height / 2, { steps: 6 });
  await page.mouse.up();
  const [x, y, z] = await loc(page);
  expect(x).toBeGreaterThan(0);
  expect(y).toBe(x);
  expect(z).toBe(x);
  // Alt+drag applies to the other selected objects too
  await page.evaluate(() => {
    const ap = (window as unknown as Win).app;
    for (const o of Object.values(ap.doc.objects as Record<string, any>)) o.select = true;
    ap.changed('select');
  });
  const s = (await field(page, '.scale.2').boundingBox())!;
  await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2);
  await page.mouse.down();
  await page.mouse.move(s.x + s.width / 2 + 40, s.y + s.height / 2, { steps: 5 });
  await page.keyboard.down('Alt');
  await page.mouse.up();
  await page.keyboard.up('Alt');
  const scales = await page.evaluate(() => Object.values((window as unknown as Win).app.doc.objects as Record<string, any>).map((o) => Math.round(o.scale[2] * 1000)));
  expect(new Set(scales).size).toBe(1);
  expect(scales[0]).not.toBe(1000);
  // object eyedropper on a modifier object field: E, then click an object row in the outliner
  await page.evaluate(() => {
    const ap = (window as unknown as Win).app;
    for (const o of Object.values(ap.doc.objects as Record<string, any>)) o.select = o.name === 'Cube';
    ap.run('object.modifier_add', { type: 'ARRAY' });
    (window as unknown as { __propertiesTab?: string }).__propertiesTab = 'MODIFIER';
    ap.changed('ui');
  });
  const obField = page.locator('.properties .enum-menu[data-id$=".offset_object"]').first();
  await expect(obField).toBeVisible();
  await obField.hover();
  await page.keyboard.press('e');
  await expect(page.locator('body.eyedropper-active')).toHaveCount(1);
  await row(page, 'Light').locator('.ol-name').click();
  expect(
    await page.evaluate(() => {
      const ap = (window as unknown as Win).app;
      const cube = Object.values(ap.doc.objects as Record<string, any>).find((o) => o.name === 'Cube');
      return ap.doc.objects[cube.modifiers[0].offset_object]?.name;
    }),
  ).toBe('Light');
  // Ctrl+wheel over an enum steps through its items
  const fit = page.locator('.properties .enum-menu[data-id$=".fit_type"]').first();
  await fit.hover();
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, 100);
  await page.keyboard.up('Control');
  await expect.poll(() => page.evaluate(() => (window as unknown as Win).app.activeObject.modifiers[0].fit_type)).not.toBe('FIXED_COUNT');
  await expectNoErrors(errors);
});

test('properties: search, tab cycling, panel collapse and reorder', async ({ page }) => {
  const errors = await openApp(page);
  const body = (await page.locator('.prop-body').boundingBox())!;
  await page.mouse.move(body.x + 80, body.y + body.height - 40);
  await page.keyboard.press('ControlOrMeta+f');
  await page.keyboard.type('delta');
  await page.keyboard.press('Enter');
  await expect(page.locator('.prop-body > .panel:visible')).toHaveCount(1);
  await expect(page.locator('.rail-tab.search-miss').first()).toBeVisible();
  await page.mouse.move(body.x + 80, body.y + body.height - 40);
  await page.keyboard.press('Alt+f');
  await expect(page.locator('.prop-body > .panel:visible').nth(2)).toBeVisible();
  // Ctrl+wheel cycles tabs
  const before = await page.locator('.rail-tab.on').getAttribute('data-tab');
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, 100);
  await page.keyboard.up('Control');
  await expect(page.locator('.rail-tab.on')).not.toHaveAttribute('data-tab', before!);
  await page.locator('.rail-tab[data-tab="OBJECT"]').click();
  await expect(page.locator('.rail-tab.on')).toHaveAttribute('data-tab', 'OBJECT');
  await page.mouse.move(body.x + 80, body.y + 40);
  // Ctrl+click on a header opens it and collapses the others
  await page.locator('.prop-body > .panel > .panel-header', { hasText: 'Visibility' }).click({ modifiers: ['ControlOrMeta'] });
  await expect.poll(() => page.evaluate(() => [...document.querySelectorAll('.prop-body > .panel.open')].map((e) => (e as HTMLElement).dataset.panel))).toEqual(['ob-visibility']);
  // drag a panel by its grip to the top
  const first = await page.evaluate(() => (document.querySelector('.prop-body > .panel') as HTMLElement).dataset.panel);
  const grip = (await page.locator('.prop-body > .panel', { hasText: 'Visibility' }).locator('.ph-grip').boundingBox())!;
  const top = (await page.locator('.prop-body > .panel').first().boundingBox())!;
  await page.mouse.move(grip.x + 4, grip.y + 4);
  await page.mouse.down();
  await page.mouse.move(grip.x + 4, top.y + 3, { steps: 6 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => [...document.querySelectorAll('.prop-body > .panel')].slice(0, 2).map((e) => (e as HTMLElement).dataset.panel))).toEqual(['ob-visibility', first]);
  // pinning keeps showing the object while another one becomes active, and edits go to it
  await page.locator('.prop-pin').click();
  await row(page, 'Light').locator('.ol-name').click();
  await expect(page.locator('.prop-crumbs')).toContainText('Cube');
  await page.locator('.rail-tab[data-tab="MODIFIER"]').click();
  await page.locator('.add-mod').dispatchEvent('pointerdown');
  await page.locator('.menu-item', { hasText: 'Generate' }).first().hover();
  await page
    .locator('.menu-item', { hasText: /^Array/ })
    .first()
    .click();
  expect(
    await page.evaluate(() =>
      Object.values((window as unknown as Win).app.doc.objects as Record<string, any>)
        .map((o) => `${o.name}:${o.modifiers.length}`)
        .sort(),
    ),
  ).toEqual(['Camera:0', 'Cube:1', 'Light:0']);
  await expect.poll(() => activeName(page)).toBe('Light');
  await page.locator('.prop-pin').click();
  await expect(page.locator('.prop-crumbs')).toContainText('Light');
  await page.locator('.rail-tab[data-tab="OBJECT"]').click();
  await row(page, 'Cube').locator('.ol-name').click();
  // options popover hides a tab from the rail
  await page.locator('.prop-options-btn').dispatchEvent('pointerdown');
  await page.locator('.prop-opts .olf-check', { hasText: 'Physics' }).locator('.checkbox').dispatchEvent('pointerdown');
  await expect(page.locator('.rail-tab[data-tab="PHYSICS"]')).toHaveCount(0);
  await page.keyboard.press('Escape');
  // property tooltips show the data path
  await page.locator('.prop-body > .panel > .panel-header', { hasText: 'Transform' }).click();
  await page.mouse.move(10, 400);
  await field(page, '.location.1').hover();
  await expect(page.locator('.tooltip')).toContainText('bpy.data.objects["Cube"].location[1]');
  await expectNoErrors(errors);
});
