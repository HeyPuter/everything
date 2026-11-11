// Shared UI shell: menus, popups and fields in narrow windows and with the keyboard.
import { test, expect, type Page } from '@playwright/test';
import { openApp, expectNoErrors } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
const menuBoxes = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.popup-layer > .menu')].map((e) => {
      const r = e.getBoundingClientRect();
      return { left: r.left, right: r.right, scrollW: e.scrollWidth, clientW: e.clientWidth };
    }),
  );

test('a phone-width window keeps the editor type menu and the search popup on screen', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  const errors = await openApp(page);
  await page.locator('.area .editor-type').first().click();
  // the columns don't fit: every editor is reachable in one list inside the window
  await expect(page.locator('.menu .menu-item', { hasText: 'Spreadsheet' })).toBeVisible();
  let boxes = await menuBoxes(page);
  expect(boxes).toHaveLength(1);
  expect(boxes[0].right).toBeLessThanOrEqual(320);
  expect(boxes[0].scrollW).toBeLessThanOrEqual(boxes[0].clientW);
  await page.locator('.menu .menu-item', { hasText: 'Spreadsheet' }).scrollIntoViewIfNeeded();
  await page.keyboard.press('Escape');
  await page.mouse.move(160, 300);
  await page.keyboard.press('F3');
  await expect(page.locator('.search-popup')).toBeVisible();
  boxes = await menuBoxes(page);
  expect(boxes[0].left).toBeGreaterThanOrEqual(0);
  expect(boxes[0].right).toBeLessThanOrEqual(320);
  await page.keyboard.press('Escape');
  await expectNoErrors(errors);
});

/** The keys an input method sends while composing text (Enter picks a candidate, Esc drops it). */
const composingKey = (page: Page, selector: string, key: string) =>
  page.evaluate(
    ([sel, k]) => document.querySelector(sel)!.dispatchEvent(new KeyboardEvent('keydown', { key: k, isComposing: true, bubbles: true, cancelable: true })),
    [selector, key] as const,
  );

test('Enter and Esc that end an input method composition leave rename fields open', async ({ page }) => {
  const errors = await openApp(page);
  const v = (await page.locator('.area[data-editor="VIEW_3D"]').first().boundingBox())!;
  await page.mouse.move(v.x + v.width / 2, v.y + v.height / 2);
  // F2 in the 3D view: the rename prompt
  await page.keyboard.press('F2');
  const prompt = page.locator('.prompt-popup .prompt-input');
  await expect(prompt).toBeFocused();
  await prompt.fill('箱');
  await composingKey(page, '.prompt-popup .prompt-input', 'Enter');
  await composingKey(page, '.prompt-popup .prompt-input', 'Escape');
  await expect(prompt).toBeVisible();
  await prompt.press('Enter');
  expect(await page.evaluate(() => (window as any).app.activeObject.name)).toBe('箱');
  // the outliner's rename field
  await page.locator('.outliner .ol-row .ol-name', { hasText: /^箱$/ }).dblclick();
  const ol = page.locator('.outliner .ol-rename');
  await expect(ol).toBeVisible();
  await ol.fill('立方体');
  await composingKey(page, '.outliner .ol-rename', 'Enter');
  await composingKey(page, '.outliner .ol-rename', 'Escape');
  await expect(ol).toBeVisible();
  await ol.press('Enter');
  expect(await page.evaluate(() => (window as any).app.activeObject.name)).toBe('立方体');
  // a number field being typed into
  const field = page.locator('.properties .num-field[data-id]').first();
  await field.click();
  const input = page.locator('.properties input.num-field.editing');
  await expect(input).toBeFocused();
  await composingKey(page, '.properties input.num-field.editing', 'Escape');
  await expect(input).toBeVisible();
  await input.press('Escape');
  await expect(input).toHaveCount(0);
  await expectNoErrors(errors);
});

test('a damaged screen layout in a file leaves the workspace usable', async ({ page }) => {
  const errors = await openApp(page);
  const r = await page.evaluate(async () => {
    const { projectUiState } = await import('/src/io/files.ts');
    const { shell } = await import('/src/ui/shell.ts');
    // a split with one child, a list entry that is not a workspace
    projectUiState.load({ workspace: 'Layout', workspaces: [null, { name: 'Layout' }], layouts: { Layout: { split: 'h', ratio: 0.5, a: { area: { id: 'x1', type: 'VIEW_3D' } } } } });
    return { areas: shell.screen.areas.length, active: shell.active };
  });
  expect(r.active).toBe('Layout');
  expect(r.areas).toBeGreaterThan(1);
  await expect(page.locator('.area[data-editor="VIEW_3D"]')).toHaveCount(1);
  await expectNoErrors(errors);
});

test('Enter over the 3D view does not click the last button clicked with the mouse again', async ({ page }) => {
  const errors = await openApp(page);
  await page.locator('.properties [data-tab="PHYSICS"]').first().click();
  await page.locator('.properties button', { hasText: 'Collision' }).click();
  const mods = () => page.evaluate(() => (window as any).app.activeObject.modifiers.map((m: { type: string }) => m.type));
  expect(await mods()).toEqual(['COLLISION']);
  const v = (await page.locator('.area[data-editor="VIEW_3D"]').first().boundingBox())!;
  await page.mouse.move(v.x + v.width / 2, v.y + v.height / 2);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(100);
  expect(await mods()).toEqual(['COLLISION']);
  // a button reached with the keyboard still takes Enter
  await page.locator('.properties button', { hasText: 'Cloth' }).focus();
  await page.keyboard.press('Enter');
  await expect.poll(mods).toContain('CLOTH');
  await expectNoErrors(errors);
});

test('Esc in a text field drops the typed text instead of committing it', async ({ page }) => {
  const errors = await openApp(page);
  await page.locator('.properties [data-tab="OBJECT"]').first().click();
  const name = page.locator('.properties .id-row .text-field input').first();
  await expect(name).toHaveValue('Cube');
  await name.click();
  await name.fill('Typo');
  await name.press('Escape');
  await expect(name).not.toBeFocused();
  expect(await page.evaluate(() => (window as any).app.activeObject.name)).toBe('Cube');
  await expect(name).toHaveValue('Cube');
  // Enter still commits
  await name.click();
  await name.fill('Box');
  await name.press('Enter');
  expect(await page.evaluate(() => (window as any).app.activeObject.name)).toBe('Box');
  await expectNoErrors(errors);
});

test('tabbing through the keymap editor does not rebind keys to Tab', async ({ page }) => {
  const errors = await openApp(page);
  await page.evaluate(() => (window as any).app.run('screen.userpref_show', { section: 'KEYMAP' }));
  await expect(page.locator('.prefs-window')).toBeVisible();
  await page.locator('.prefs-nav-btn[data-section="KEYMAP"]').click();
  await page.locator('.km-search input').fill('view3d.toggle_sidebar');
  const key = page.locator('.km-item', { hasText: 'Sidebar' }).first().locator('.km-key');
  const before = await key.inputValue();
  // reach the key field with the keyboard and move on
  await key.focus();
  await expect(key).toHaveValue(before);
  await page.keyboard.press('Tab');
  await expect(key).toHaveValue(before);
  // Enter on the focused field starts capturing; a click still does too
  await key.focus();
  await page.keyboard.press('Enter');
  await expect(key).toHaveValue('Press a key…');
  await page.keyboard.press('Escape');
  await expect(key).toHaveValue(before);
  await key.click();
  await expect(key).toHaveValue('Press a key…');
  await page.keyboard.press('Shift+J');
  await expect(key).toHaveValue('Shift J');
  await expectNoErrors(errors);
});

test('Enter confirms an operator dialog and Esc closes it', async ({ page }) => {
  const errors = await openApp(page);
  await page.locator('.rail-tab[data-tab="DATA"]').first().click();
  const attrs = page.locator('[data-panel="me-attributes"]');
  if (!(await attrs.locator('.ul-side').isVisible())) await attrs.locator('.panel-header').click();
  const count = () => page.evaluate(() => { const a = (window as any).app; return (a.doc.meshes[a.activeObject.data].attributes ?? []).length; });
  const n0 = await count();
  const dlg = page.locator('.op-dialog[data-op-dialog="geometry.attribute_add"]');
  await attrs.locator('.ul-side .icon-btn[data-tip="Add"]').click();
  await expect(dlg).toBeVisible();
  await expect(dlg).toHaveAttribute('role', 'dialog');
  await page.keyboard.press('Escape');
  await expect(dlg).toHaveCount(0);
  expect(await count()).toBe(n0);
  await attrs.locator('.ul-side .icon-btn[data-tip="Add"]').click();
  await expect(dlg).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(dlg).toHaveCount(0);
  expect(await count()).toBe(n0 + 1);
  await expectNoErrors(errors);
});

test('a number drag the browser cancels (touch scrolling) puts the value back and stops following the pointer', async ({ page }) => {
  const errors = await openApp(page);
  await page.locator('.properties [data-tab="OBJECT"]').first().click();
  const field = page.locator('.properties .num-field[data-id$=".location.0"]').first();
  const b = (await field.boundingBox())!;
  const x = () => page.evaluate(() => (window as any).app.activeObject.location[0]);
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 5; i++) await page.mouse.move(b.x + b.width / 2 + i * 10, b.y + b.height / 2);
  expect(await x()).not.toBe(0);
  await page.evaluate(() => dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1 })));
  expect(await x()).toBe(0);
  // later pointer movement no longer edits the field
  for (let i = 1; i <= 5; i++) await page.mouse.move(b.x + b.width / 2 - i * 10, b.y + b.height / 2 + 40);
  expect(await x()).toBe(0);
  await page.mouse.up();
  expect(await x()).toBe(0);
  await expectNoErrors(errors);
});

test('the colour picker shows its value bar and cursor, and dragging the bar sets the brightness', async ({ page }) => {
  const errors = await openApp(page);
  await page.locator('.properties [data-tab="WORLD"]').first().click();
  await page.locator('.properties .color-swatch').first().click();
  const bar = page.locator('.popover .cp-value');
  await expect(bar).toBeVisible();
  const b = (await bar.boundingBox())!;
  expect(b.width).toBeGreaterThan(8);
  expect(b.height).toBeGreaterThan(100);
  expect(await page.locator('.popover .cp-cursor').evaluate((e) => getComputedStyle(e).position)).toBe('absolute');
  // the picker's V field
  const color = async () => [Number(await page.locator('.popover .num-field[data-id="cp-V"] .num-value').textContent())];
  const before = await color();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height - 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + 2, { steps: 4 });
  await page.mouse.up();
  const after = await color();
  expect(after[0]).toBeGreaterThan(before[0]);
  await expectNoErrors(errors);
});

test('an outliner box selection the browser cancels (touch scrolling) selects nothing later', async ({ page }) => {
  const errors = await openApp(page);
  const list = (await page.locator('.outliner .ol-list').first().boundingBox())!;
  const sel = () => page.evaluate(() => Object.values((window as any).app.doc.objects as Record<string, { name: string; select: boolean }>).filter((o) => o.select).map((o) => o.name).sort());
  const before = await sel();
  // press on the empty space under the rows, drag up over them, then the browser cancels
  const x = list.x + list.width / 2,
    y = list.y + list.height - 6;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, list.y + 4, { steps: 4 });
  await page.evaluate(() => dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1 })));
  await expect(page.locator('.outliner .ol-box')).toBeHidden();
  await page.mouse.up();
  expect(await sel()).toEqual(before);
  await expectNoErrors(errors);
});

test('a pie menu opened at the window edge moves in, and directions still count from the pointer', async ({ page }) => {
  const errors = await openApp(page);
  const v = (await page.locator('.area[data-editor="VIEW_3D"]').first().boundingBox())!;
  const shading = () => page.evaluate(async () => (await import('/src/editors/view3d/view3d.ts')).activeView3D()!.shading.type);
  const x = v.x + 40,
    y = v.y + v.height - 30;
  await page.mouse.move(x, y);
  await page.keyboard.down('z');
  await expect(page.locator('.pie-item')).toHaveCount(6);
  const boxes = await page.evaluate(() => [...document.querySelectorAll('.pie-item')].map((e) => e.getBoundingClientRect().toJSON()));
  const [w, hh] = await page.evaluate(() => [innerWidth, innerHeight]);
  for (const b of boxes) {
    expect(b.left).toBeGreaterThanOrEqual(0);
    expect(b.right).toBeLessThanOrEqual(w);
    expect(b.bottom).toBeLessThanOrEqual(hh);
  }
  // 4 picks Wireframe
  await page.keyboard.press('4');
  await page.keyboard.up('z');
  expect(await shading()).toBe('WIREFRAME');
  // a flick to the right (still left of the moved pie's middle) picks the east item, Solid
  await page.keyboard.down('z');
  await expect(page.locator('.pie-item')).toHaveCount(6);
  await page.mouse.move(x + 50, y, { steps: 3 });
  await page.waitForTimeout(350);
  await page.keyboard.up('z');
  await expect(page.locator('.pie-item')).toHaveCount(0);
  expect(await shading()).toBe('SOLID');
  await expectNoErrors(errors);
});

test('the search popup stays inside the window and keeps the highlighted result in view', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 600 });
  const errors = await openApp(page);
  const v = (await page.locator('.area[data-editor="VIEW_3D"]').first().boundingBox())!;
  await page.mouse.move(v.x + v.width / 2, v.y + v.height / 2);
  await page.keyboard.press('F3');
  await expect(page.locator('.search-popup input')).toBeFocused();
  await page.keyboard.type('e');
  await expect(page.locator('.search-popup .menu-item')).toHaveCount(40);
  const box = (await page.locator('.search-popup').boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(600);
  for (let i = 0; i < 39; i++) await page.keyboard.press('ArrowDown');
  const hl = (await page.locator('.search-popup .menu-item.hl').boundingBox())!;
  expect(hl.y).toBeGreaterThanOrEqual(box.y);
  expect(hl.y + hl.height).toBeLessThanOrEqual(box.y + box.height + 1);
  // the query field stays reachable at the top
  await expect(page.locator('.search-popup input')).toBeInViewport();
  await page.keyboard.press('Escape');
  await expectNoErrors(errors);
});

test('menu buttons that open on press also open from the keyboard', async ({ page }) => {
  const errors = await openApp(page);
  // the top bar's File menu
  await page.locator('.topbar .tb-menu', { hasText: 'File' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.popup-layer > .menu')).toHaveCount(1);
  await expect(page.locator('.menu .menu-item', { hasText: 'Save As' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.popup-layer > .menu')).toHaveCount(0);
  // an enum dropdown in the Properties editor
  await page.locator('.properties [data-tab="OBJECT"]').first().click();
  const mode = page.locator('.properties .enum-menu', { hasText: 'XYZ Euler' }).first();
  await mode.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.menu .menu-item', { hasText: 'Quaternion' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.popup-layer > .menu')).toHaveCount(0);
  await expect(mode).toBeFocused();
  await expectNoErrors(errors);
});

test('a dropdown or colour picker opened inside a popover opens over it and closes back to it', async ({ page }) => {
  const errors = await openApp(page);
  const v = (await page.locator('.area[data-editor="VIEW_3D"]').first().boundingBox())!;
  await page.mouse.move(v.x + v.width / 2, v.y + v.height / 2);
  await page.evaluate(async () => {
    const { activeView3D } = await import('/src/editors/view3d/view3d.ts');
    activeView3D()!.shading.color_type = 'SINGLE';
    (window as any).app.changed('ui');
  });
  await page.locator('.area[data-editor="VIEW_3D"] .area-header button[data-tip^="Shading"]').first().click();
  const pop = page.locator('.popup-layer > .popover');
  await expect(pop).toHaveCount(1);
  // the studio light dropdown
  const dd = pop.locator('.enum-menu').first();
  const ddBox = (await dd.boundingBox())!;
  await dd.click();
  const menu = page.locator('.popup-layer > .menu');
  await expect(menu).toHaveCount(1);
  const mBox = (await menu.boundingBox())!;
  expect(Math.abs(mBox.x - ddBox.x)).toBeLessThan(4);
  expect(mBox.y).toBeGreaterThan(ddBox.y);
  await expect(pop).toHaveCount(1);
  // picking an entry keeps the popover
  await menu.locator('.menu-item').nth(1).click();
  await expect(menu).toHaveCount(0);
  await expect(pop).toHaveCount(1);
  // Esc in a dropdown closes just the dropdown; Esc again closes the popover
  await dd.click();
  await expect(menu).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(pop).toHaveCount(1);
  // the single colour's swatch: the picker opens next to it, over the shading popover
  const sw = pop.first().locator('.color-swatch').first();
  const swBox = (await sw.boundingBox())!;
  await sw.click();
  await expect(page.locator('.popup-layer > .popover')).toHaveCount(2);
  const picker = (await page.locator('.popup-layer > .popover.cp-pop').boundingBox())!;
  expect(Math.abs(picker.y - (swBox.y + swBox.height))).toBeLessThan(8);
  // moving into the picker keeps both; Esc closes everything
  await page.mouse.move(picker.x + picker.width / 2, picker.y + picker.height / 2, { steps: 4 });
  await expect(page.locator('.popup-layer > .popover')).toHaveCount(2);
  await page.keyboard.press('Escape');
  await expect(page.locator('.popup-layer > .popover')).toHaveCount(0);
  await expectNoErrors(errors);
});

test('renaming in the Properties name fields keeps names unique and ignores empty names', async ({ page }) => {
  const errors = await openApp(page);
  await page.locator('.properties [data-tab="OBJECT"]').first().click();
  const name = page.locator('.properties .id-row .text-field input').first();
  // an empty name is refused
  await name.click();
  await name.fill('   ');
  await name.press('Enter');
  expect(await page.evaluate(() => (window as any).app.activeObject.name)).toBe('Cube');
  await expect(name).toHaveValue('Cube');
  // another object's name gets a number
  await name.click();
  await name.fill('Camera');
  await name.press('Enter');
  expect(await page.evaluate(() => (window as any).app.activeObject.name)).toBe('Camera.001');
  // data-blocks (the mesh) too
  await page.evaluate(() => {
    const a = (window as any).app;
    a.run('mesh.primitive_plane_add', {}, { invoke: false });
  });
  await page.locator('.properties [data-tab="DATA"]').first().click();
  const mesh = page.locator('.properties .id-selector .text-field input').first();
  await expect(mesh).toHaveValue('Plane');
  await mesh.click();
  await mesh.fill('Cube');
  await mesh.press('Enter');
  expect(await page.evaluate(() => { const a = (window as any).app; return a.doc.meshes[a.activeObject.data].name; })).toBe('Cube.001');
  await expectNoErrors(errors);
});

test('switching workspaces never leaves the app pointing at the old, removed areas', async ({ page }) => {
  const errors = await openApp(page);
  const v = (await page.locator('.area[data-editor="VIEW_3D"]').first().boundingBox())!;
  await page.mouse.move(v.x + v.width / 2, v.y + v.height / 2);
  await page.mouse.click(v.x + v.width / 2, v.y + v.height / 2);
  // over the top bar: no area takes the hover when the new layout appears
  await page.mouse.move(700, 10);
  await page.keyboard.press('Control+PageDown');
  await expect(page.locator('.ws-tab.on')).not.toHaveText('Layout');
  const r = await page.evaluate(() => {
    const a = (window as any).app;
    return { hover: a.hoverArea ? a.hoverArea.el.isConnected : null, active: a.activeArea ? a.activeArea.el.isConnected : null };
  });
  expect(r.hover).not.toBe(false);
  expect(r.active).not.toBe(false);
  await expectNoErrors(errors);
});

test('a phone-width window starts with the assistant closed, and the button still opens it', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 700 });
  const errors = await openApp(page);
  await expect(page.locator('.assistant-dock')).toBeHidden();
  const view = (await page.locator('.area[data-editor="VIEW_3D"]').first().boundingBox())!;
  expect(view.width).toBeGreaterThan(150);
  // the same in the other workspaces
  for (const ws of ['Modeling', 'Shading']) {
    await page.locator('.ws-tab', { hasText: ws }).first().click();
    await expect(page.locator('.assistant-dock')).toBeHidden();
  }
  await page.evaluate(() => (window as any).app.run('wm.assistant_toggle'));
  await expect(page.locator('.assistant')).toBeVisible();
  await expectNoErrors(errors);
});

test('menu entries tell assistive technology about toggles, choices and submenus', async ({ page }) => {
  const errors = await openApp(page);
  await page.locator('.topbar .tb-menu', { hasText: 'Window' }).click();
  const menu = page.locator('.popup-layer > .menu').first();
  await expect(menu).toHaveAttribute('role', 'menu');
  // Window ▸ AI Assistant is a toggle
  const toggle = menu.locator('.menu-item', { hasText: 'AI Assistant' });
  await expect(toggle).toHaveAttribute('role', 'menuitemcheckbox');
  await expect(toggle).toHaveAttribute('aria-checked', /true|false/);
  await expect(menu.locator('.menu-sep').first()).toHaveAttribute('role', 'separator');
  await page.keyboard.press('Escape');
  await page.locator('.topbar .tb-menu', { hasText: 'File' }).click();
  const sub = page.locator('.popup-layer > .menu').first().locator('.menu-item.has-sub').first();
  await expect(sub).toHaveAttribute('aria-haspopup', 'menu');
  await sub.hover();
  await expect(page.locator('.popup-layer > .menu')).toHaveCount(2);
  await expect(sub).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expectNoErrors(errors);
});

test('with online access off the page does not fetch the Puter SDK; with it on the account menu still comes', async ({ page }) => {
  const hits: string[] = [];
  await page.route('https://js.puter.com/**', (r) => {
    hits.push(r.request().url());
    return r.fulfill({ contentType: 'application/javascript', body: 'customElements.define("puter-user-menu", class extends HTMLElement {}); window.puter = { env: "web", auth: { isSignedIn: () => false } };' });
  });
  await page.addInitScript(() => {
    if (sessionStorage.getItem('r5-online')) return;
    sessionStorage.setItem('r5-online', '1');
    localStorage.setItem('p3d.preferences.v1', JSON.stringify({ use_online_access: false }));
  });
  const errors = await openApp(page);
  await page.waitForTimeout(500);
  expect(hits).toEqual([]);
  await expect(page.locator('.topbar > puter-user-menu')).toHaveCount(0);
  // online again: the next start loads it and the top bar shows the account menu
  await page.evaluate(() => localStorage.setItem('p3d.preferences.v1', JSON.stringify({ use_online_access: true })));
  await page.reload();
  await page.waitForFunction(() => !!(window as any).app);
  await expect(page.locator('.topbar > puter-user-menu')).toHaveCount(1);
  expect(hits.length).toBe(1);
  await expectNoErrors(errors);
});

test('the default layout at phone width keeps the Properties editor readable', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 700 });
  const errors = await openApp(page);
  const props = (await page.locator('.area[data-editor="PROPERTIES"]').boundingBox())!;
  expect(props.width).toBeGreaterThanOrEqual(150);
  const view = (await page.locator('.area[data-editor="VIEW_3D"]').boundingBox())!;
  expect(view.width).toBeGreaterThanOrEqual(150);
  // the Location X value is shown, not clipped away
  const value = page.locator('.properties .num-field[data-id$=".location.0"] .num-value').first();
  expect((await value.boundingBox())!.width).toBeGreaterThan(12);
  // the divider between them sits where they meet and still drags (the Properties side wider)
  const edgeX = view.x + view.width + 1;
  await page.mouse.move(edgeX, view.y + 200);
  await page.mouse.down();
  await page.mouse.move(edgeX - 30, view.y + 200, { steps: 3 });
  await page.mouse.up();
  expect((await page.locator('.area[data-editor="PROPERTIES"]').boundingBox())!.width).toBeGreaterThan(props.width + 20);
  await expectNoErrors(errors);
});

test('splitting an area with a factor of 0 or 1 keeps both parts visible', async ({ page }) => {
  const errors = await openApp(page);
  const r = await page.evaluate(async () => {
    const { shell } = await import('/src/ui/shell.ts');
    const a = (window as any).app;
    const v = () => shell.screen.areas.find((x: { type: string }) => x.type === 'VIEW_3D');
    a.run('screen.area_split', { direction: 'VERTICAL', factor: 0 }, { invoke: false, area: v() });
    a.run('screen.area_split', { direction: 'HORIZONTAL', factor: 1 }, { invoke: false, area: v() });
    return shell.screen.areas.map((x: { rect: { w: number; h: number } }) => [x.rect.w, x.rect.h]);
  });
  for (const [w, h] of r) {
    expect(w).toBeGreaterThanOrEqual(24);
    expect(h).toBeGreaterThanOrEqual(24);
  }
  await expectNoErrors(errors);
});
