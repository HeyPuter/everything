// Window and screen framework: area split / join / swap, header regions, fullscreen, workspaces,
// top bar menus, and the Text Editor, Console, Info and File Browser editors.
import { test, expect, type Page } from '@playwright/test';
import { openApp, expectNoErrors } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
const get = (page: Page, expr: string) => page.evaluate(`(() => { const app = window.app; return ${expr}; })()`);
const areaCount = (page: Page) => page.locator('.screen > .area:visible').count();
const areaBox = async (page: Page, editor: string, i = 0) => (await page.locator(`.area[data-editor="${editor}"]`).nth(i).boundingBox())!;

test('header context menu: collapse menus, hide and restore the header', async ({ page }) => {
  const errors = await openApp(page);
  const v = await areaBox(page, 'VIEW_3D');
  const hdr = page.locator('.area[data-editor="VIEW_3D"] .area-header');
  await page.mouse.move(v.x + 300, v.y + 12);
  await page.mouse.click(v.x + 300, v.y + 12, { button: 'right' });
  await expect(page.locator('.menu .menu-item', { hasText: 'Show Menus' })).toBeVisible();
  await page.locator('.menu .menu-item', { hasText: 'Show Menus' }).click();
  await expect(hdr.locator('.hdr-menu').first()).toBeHidden();
  await hdr.locator('.hdr-collapsed-menus').dispatchEvent('pointerdown');
  await expect(page.locator('.menu .menu-item', { hasText: 'Object' }).first()).toBeVisible();
  await page.locator('.menu .menu-item', { hasText: 'View' }).first().hover();
  await expect(page.locator('.menu .menu-item', { hasText: 'Sidebar' }).first()).toBeVisible();
  await page.keyboard.press('Escape');
  // hide the header, then bring it back with the reveal tab
  await page.mouse.click(v.x + 300, v.y + 12, { button: 'right' });
  await page.locator('.menu .menu-item', { hasText: 'Show Header' }).click();
  await expect(hdr).toBeHidden();
  await page.locator('.area[data-editor="VIEW_3D"] .area-header-reveal').click();
  await expect(hdr).toBeVisible();
  // flip to bottom
  await page.mouse.click(v.x + 300, v.y + 12, { button: 'right' });
  await page.locator('.menu .menu-item', { hasText: 'Flip to Bottom' }).click();
  await expect(page.locator('.area[data-editor="VIEW_3D"]')).toHaveClass(/header-bottom/);
  await expectNoErrors(errors);
});

test('corner drag splits an area, edge menu joins and swaps, close area', async ({ page }) => {
  const errors = await openApp(page);
  const n0 = await areaCount(page);
  const v = await areaBox(page, 'VIEW_3D');
  // drag from the bottom-left corner to the right: side-by-side split at the release point
  await page.mouse.move(v.x + 3, v.y + v.height - 3);
  await page.mouse.down();
  await page.mouse.move(v.x + 60, v.y + v.height - 40, { steps: 4 });
  await page.mouse.move(v.x + v.width * 0.4, v.y + v.height - 40, { steps: 4 });
  await page.mouse.up();
  expect(await areaCount(page)).toBe(n0 + 1);
  const views = page.locator('.area[data-editor="VIEW_3D"]');
  await expect(views).toHaveCount(2);
  const left = (await views.nth(0).boundingBox())!;
  expect(left.width / v.width).toBeGreaterThan(0.33);
  expect(left.width / v.width).toBeLessThan(0.47);
  // right-click the new edge: Join Right removes the right-hand area
  const right = (await views.nth(1).boundingBox())!;
  const edgeX = (left.x + left.width + right.x) / 2;
  await page.mouse.move(edgeX, left.y + 200);
  await page.mouse.click(edgeX, left.y + 200, { button: 'right' });
  await expect(page.locator('.menu .menu-item', { hasText: 'Swap Areas' })).toBeVisible();
  await page.locator('.menu .menu-item', { hasText: 'Join Right' }).click();
  expect(await areaCount(page)).toBe(n0);
  await expect(views).toHaveCount(1);
  // swap the 3D view and the timeline below it by operator: the editors exchange places
  const tl0 = await areaBox(page, 'TIMELINE');
  const v0 = await areaBox(page, 'VIEW_3D');
  await page.evaluate(() => {
    const a = (window as any).app;
    const area = a.hoverArea.screen.areas.find((x: any) => x.type === 'VIEW_3D');
    a.run('screen.area_swap', { direction: 'DOWN' }, { area, invoke: false });
  });
  const tl1 = await areaBox(page, 'TIMELINE');
  expect(tl1.y).toBeLessThan(tl0.y);
  expect(Math.abs(tl1.height - v0.height)).toBeLessThan(3);
  // close the timeline
  await page.evaluate(() => {
    const a = (window as any).app;
    const area = a.hoverArea.screen.areas.find((x: any) => x.type === 'TIMELINE');
    a.run('screen.area_close', {}, { area });
  });
  expect(await areaCount(page)).toBe(n0 - 1);
  await expectNoErrors(errors);
});

test('maximize and fullscreen area, status bar toggle', async ({ page }) => {
  const errors = await openApp(page);
  const n0 = await areaCount(page);
  const v = await areaBox(page, 'VIEW_3D');
  await page.mouse.move(v.x + 200, v.y + 200);
  await page.keyboard.press('Control+Space');
  expect(await areaCount(page)).toBe(1);
  await expect(page.locator('.area[data-editor="VIEW_3D"] .area-header')).toBeVisible();
  await page.keyboard.press('Control+Space');
  expect(await areaCount(page)).toBe(n0);
  await page.keyboard.press('Control+Alt+Space');
  await expect(page.locator('.area[data-editor="VIEW_3D"] .area-header')).toBeHidden();
  await page.locator('.screen-fs-exit').click();
  expect(await areaCount(page)).toBe(n0);
  await expect(page.locator('.area[data-editor="VIEW_3D"] .area-header')).toBeVisible();
  await page.evaluate(() => (window as any).app.run('screen.toggle_statusbar'));
  await expect(page.locator('.statusbar')).toBeHidden();
  await page.evaluate(() => (window as any).app.run('screen.toggle_statusbar'));
  await expect(page.locator('.statusbar')).toBeVisible();
  await expectNoErrors(errors);
});

test('workspace tab menu: reorder and delete others', async ({ page }) => {
  const errors = await openApp(page);
  await page.locator('.ws-tab', { hasText: 'Layout' }).click({ button: 'right' });
  await page.locator('.menu .menu-item', { hasText: 'Reorder to Back' }).click();
  await expect(page.locator('.ws-tab').last()).toHaveText('Layout');
  await page.locator('.ws-tab', { hasText: 'Shading' }).click({ button: 'right' });
  await page.locator('.menu .menu-item', { hasText: 'Reorder to Front' }).click();
  await expect(page.locator('.ws-tab').first()).toHaveText('Shading');
  await page.locator('.ws-tab', { hasText: 'Modeling' }).click({ button: 'right' });
  await page.locator('.menu .menu-item', { hasText: 'Delete All Others' }).click();
  await expect(page.locator('.ws-tab')).toHaveCount(1);
  await expect(page.locator('.ws-tab.on')).toHaveText('Modeling');
  await expectNoErrors(errors);
});

test('F3 searches the top bar and header menus with their paths', async ({ page }) => {
  const errors = await openApp(page);
  const v = await areaBox(page, 'VIEW_3D');
  await page.mouse.move(v.x + 300, v.y + 300);
  await page.keyboard.press('F3');
  await page.keyboard.type('recover auto');
  await expect(page.locator('.search-popup .menu-item').first()).toContainText('File ▸ Recover ▸ Auto Save');
  await page.locator('.search-input').fill('area toggle maximize');
  await expect(page.locator('.search-popup .menu-item').first()).toContainText('View ▸ Area ▸ Toggle Maximize Area');
  await page.keyboard.press('Enter');
  expect(await areaCount(page)).toBe(1);
  await expectNoErrors(errors);
});

test('File menu: save adds to Open Recent, revert, save copy, startup file', async ({ page }) => {
  const errors = await openApp(page);
  await page.evaluate(async () => {
    const s = await import('/src/io/session.ts');
    await s.sessionReady;
    await s.clearRecent();
    await s.clearStartupFile();
  });
  // save: the file becomes the first recent file
  const dl = page.waitForEvent('download');
  await page.evaluate(() => (window as any).app.run('wm.save_mainfile'));
  await dl;
  await expect.poll(() => page.evaluate(async () => (await import('/src/io/session.ts')).recentFiles().map((e) => e.name))).toEqual(['untitled.p3d']);
  // change something, then revert to the saved state
  await page.evaluate(() => {
    const a = (window as any).app;
    a.activeObject.location[0] = 5;
    a.pushUndo('Move');
    a.run('wm.revert_mainfile', {}, { invoke: false });
  });
  await expect.poll(() => get(page, 'app.activeObject.location[0]')).toBe(0);
  // Ctrl Shift O lists the recent file; picking it opens it
  const v = await areaBox(page, 'VIEW_3D');
  await page.mouse.move(v.x + 300, v.y + 300);
  await page.keyboard.press('Control+Shift+o');
  await expect(page.locator('.menu .menu-item', { hasText: 'untitled.p3d' })).toBeVisible();
  await page.keyboard.press('Escape');
  // Ctrl N opens the New File menu
  await page.keyboard.press('Control+n');
  await expect(page.locator('.menu .menu-item', { hasText: 'General' })).toBeVisible();
  await page.keyboard.press('Escape');
  // save copy keeps the current name
  await page.evaluate(() => {
    const a = (window as any).app;
    a.filename = 'mine.p3d';
  });
  const dl2 = page.waitForEvent('download');
  await page.evaluate(() => (window as any).app.run('wm.save_as_mainfile', { filepath: 'other.p3d', copy: true }, { invoke: false }));
  expect((await dl2).suggestedFilename()).toBe('other.p3d');
  expect(await get(page, 'app.filename')).toBe('mine.p3d');
  // startup file: New File starts from it
  await page.evaluate(async () => {
    const a = (window as any).app;
    a.activeObject.name = 'StartupCube';
    a.pushUndo('Rename');
    a.run('wm.save_homefile', {}, { invoke: false });
    await new Promise((r) => setTimeout(r, 200));
    a.run('wm.read_homefile', { use_factory_startup: true });
  });
  expect(await get(page, 'app.activeObject.name')).toBe('Cube');
  await page.evaluate(() => (window as any).app.run('wm.read_homefile'));
  expect(await get(page, 'app.activeObject.name')).toBe('StartupCube');
  await page.evaluate(async () => (await import('/src/io/session.ts')).clearStartupFile());
  await expectNoErrors(errors);
});

test('Edit menu: repeat history, undo history submenu; splash and system menus', async ({ page }) => {
  const errors = await openApp(page);
  await page.evaluate(() => {
    const a = (window as any).app;
    a.run('mesh.primitive_cube_add', {}, { invoke: false });
  });
  const n = await get(page, 'Object.keys(app.doc.objects).length');
  await page.locator('.tb-menu', { hasText: 'Edit' }).dispatchEvent('pointerdown');
  await page.locator('.menu .menu-item', { hasText: 'Repeat History' }).click();
  await page.locator('.menu .menu-item', { hasText: 'Cube' }).first().click();
  expect(await get(page, 'Object.keys(app.doc.objects).length')).toBe((n as number) + 1);
  await page.locator('.tb-menu', { hasText: 'Edit' }).dispatchEvent('pointerdown');
  await page.locator('.menu .menu-item', { hasText: 'Undo History' }).hover();
  await expect(page.locator('.menu .menu-item', { hasText: 'Original' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.evaluate(() => (window as any).app.run('wm.splash'));
  await expect(page.locator('.splash')).toBeVisible();
  await expect(page.locator('.splash-item', { hasText: 'General' })).toBeVisible();
  await page.locator('.splash-hero').click();
  await expect(page.locator('.splash')).toHaveCount(0);
  await page.evaluate(() => {
    const a = (window as any).app;
    a.run('wm.memory_statistics');
    a.run('wm.redraw_timer', { type: 'DRAW', iterations: 3 });
  });
  const reports = (await get(page, 'app.reports.map(r => r.message).join("\\n")')) as string;
  expect(reports).toMatch(/Data-blocks: .*objects/);
  expect(reports).toMatch(/Draw Region: 3 iterations/);
  await expectNoErrors(errors);
});

/** Scripting workspace with a new text in the Text Editor; returns the text area locator. */
async function newText(page: Page, body: string) {
  await page.locator('.ws-tab', { hasText: 'Scripting' }).first().click();
  const te = page.locator('.area[data-editor="TEXT"]');
  const box = (await te.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.evaluate(() => {
    const a = (window as any).app;
    a.run('text.new', {}, { area: a.hoverArea });
  });
  const ta = te.locator('.te-input');
  await expect(ta).toBeVisible();
  await ta.click();
  await page.keyboard.insertText(body);
  return ta;
}
const body = (page: Page) => page.evaluate(() => Object.values((window as any).app.doc.texts as Record<string, { body: string }>)[0].body);

test('Text Editor: duplicate line, find set selected, autocomplete, overwrite, context menu', async ({ page }) => {
  const errors = await openApp(page);
  const ta = await newText(page, 'value = 1\nvalue_total = 2\n');
  // Ctrl D duplicates the caret line
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('Control+d');
  expect(await body(page)).toBe('value = 1\nvalue = 1\nvalue_total = 2\n');
  // Ctrl G: the word at the caret becomes the search text and the next match is selected
  await page.keyboard.press('Control+g');
  expect(await page.evaluate(() => { const t = document.querySelector('.te-input') as HTMLTextAreaElement; return [t.selectionStart, t.selectionEnd]; })).toEqual([10, 15]);
  // Tab after a word prefix: two candidates → list; Enter accepts the highlighted one
  await page.keyboard.press('Control+End');
  await page.keyboard.type('val');
  await page.keyboard.press('Tab');
  await expect(page.locator('.te-ac-item')).toHaveCount(2);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  expect(await body(page)).toBe('value = 1\nvalue = 1\nvalue_total = 2\nvalue_total');
  // overwrite mode replaces characters
  await page.keyboard.press('Home');
  await page.keyboard.press('Insert');
  await page.keyboard.type('XY');
  expect((await body(page)).endsWith('XYlue_total')).toBe(true);
  await expect(page.locator('.te-foot-ovr')).toBeVisible();
  await page.keyboard.press('Insert');
  // right-click menu
  const tb = (await ta.boundingBox())!;
  await page.mouse.click(tb.x + 40, tb.y + 10, { button: 'right' });
  await expect(page.locator('.menu .menu-item', { hasText: 'Toggle Comments' })).toBeVisible();
  await page.locator('.menu .menu-item', { hasText: 'Toggle Comments' }).click();
  expect((await body(page)).startsWith('# value = 1')).toBe(true);
  // Ctrl+wheel zooms the font
  const fs0 = await page.evaluate(() => getComputedStyle(document.querySelector('.text-editor')!).getPropertyValue('--te-fs'));
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -100);
  await page.keyboard.up('Control');
  const fs1 = await page.evaluate(() => getComputedStyle(document.querySelector('.text-editor')!).getPropertyValue('--te-fs'));
  expect(parseInt(fs1)).toBe(parseInt(fs0) + 1);
  await expectNoErrors(errors);
});

test('Text Editor: select and navigation operators, text to 3D object, reload from disk', async ({ page }) => {
  const errors = await openApp(page);
  await newText(page, 'first line\nsecond line\nthird');
  const sel = () => page.evaluate(() => { const t = document.querySelector('.te-input') as HTMLTextAreaElement; return [t.selectionStart, t.selectionEnd]; });
  const run = (op: string, props: Record<string, unknown> = {}) => page.evaluate(([o, p]) => { const a = (window as any).app; return a.run(o, p, { area: a.hoverArea }); }, [op, props] as const);
  await run('text.move', { type: 'FILE_TOP' });
  await run('text.move_select', { type: 'NEXT_WORD' });
  expect(await sel()).toEqual([0, 5]);
  await run('text.move_select', { type: 'NEXT_LINE' });
  expect(await sel()).toEqual([0, 16]);
  await run('text.select_line');
  expect(await sel()).toEqual([0, 22]);
  await run('text.select_all');
  expect(await sel()).toEqual([0, 28]);
  // text to 3D: one object per line
  const before = (await get(page, 'Object.keys(app.doc.objects).length')) as number;
  await run('text.to_3d_object', { split_lines: true });
  expect(await get(page, 'Object.values(app.doc.objects).filter(o => o.type === "FONT").length')).toBe(3);
  expect(await get(page, 'Object.keys(app.doc.objects).length')).toBe(before + 3);
  // open a text linked to a (fake) file on disk, change the file, reload
  await page.evaluate(() => {
    let content = 'print("v1")\n';
    let modified = 1000;
    const handle = { name: 'disk.py', kind: 'file', getFile: async () => new File([content], 'disk.py', { lastModified: modified }) };
    (window as any).__setDisk = (c: string) => ((content = c), (modified += 1000));
    (window as any).showOpenFilePicker = async () => [handle];
  });
  await run('text.open');
  await expect.poll(() => get(page, 'Object.values(app.doc.texts).map(t => t.name).join(",")')).toContain('disk.py');
  await page.evaluate(() => (window as any).__setDisk('print("v2")\n'));
  // coming back to the window checks the linked file
  await page.evaluate(() => dispatchEvent(new Event('focus')));
  await expect(page.locator('.te-conflict')).toBeVisible();
  await page.locator('.te-conflict .btn', { hasText: 'Reload from Disk' }).click();
  await expect.poll(() => get(page, 'Object.values(app.doc.texts).find(t => t.name === "disk.py").body')).toBe('print("v2")\n');
  await expect(page.locator('.te-conflict')).toBeHidden();
  await expectNoErrors(errors);
});

test('Console menus and operators; Info box select, replay and context menu', async ({ page }) => {
  const errors = await openApp(page);
  await page.locator('.ws-tab', { hasText: 'Scripting' }).first().click();
  const con = page.locator('.area[data-editor="CONSOLE"]');
  const cb = (await con.boundingBox())!;
  await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2);
  const input = con.locator('.pc-input');
  await input.click();
  await input.fill('alpha beta gamma');
  const run = (op: string, props: Record<string, unknown> = {}) => page.evaluate(([o, p]) => { const a = (window as any).app; return a.run(o, p, { area: a.hoverArea }); }, [op, props] as const);
  await run('console.move', { type: 'LINE_END' });
  await run('console.delete', { type: 'PREVIOUS_WORD' });
  await expect(input).toHaveValue('alpha beta ');
  await run('console.move', { type: 'LINE_BEGIN' });
  await run('console.move', { type: 'NEXT_WORD', select: true });
  expect(await input.evaluate((i: HTMLInputElement) => [i.selectionStart, i.selectionEnd])).toEqual([0, 5]);
  await run('console.indent');
  await expect(input).toHaveValue('    alpha beta ');
  await run('console.unindent');
  await expect(input).toHaveValue('alpha beta ');
  // history: switch to JavaScript, run two lines, step back through them
  await run('console.language_set', { language: 'JAVASCRIPT' });
  await input.fill('1 + 1');
  await page.keyboard.press('Enter');
  await input.fill('2 + 2');
  await page.keyboard.press('Enter');
  await run('console.history_cycle', { reverse: true });
  await expect(input).toHaveValue('2 + 2');
  await run('console.history_cycle', { reverse: true });
  await expect(input).toHaveValue('1 + 1');
  // right-click menu
  await page.mouse.click(cb.x + 100, cb.y + 100, { button: 'right' });
  await expect(page.locator('.menu .menu-item', { hasText: 'Backward in History' })).toBeVisible();
  await page.keyboard.press('Escape');

  // Info: two operator reports, box select them, replay adds two more cubes
  await page.evaluate(() => {
    const a = (window as any).app;
    a.run('mesh.primitive_cube_add', { location: [3, 0, 0] }, { invoke: false });
    a.run('mesh.primitive_cube_add', { location: [-3, 0, 0] }, { invoke: false });
  });
  const info = page.locator('.area[data-editor="INFO"]');
  const rows = info.locator('.info-row.operator');
  await expect(rows).toHaveCount(2);
  const r1 = (await rows.nth(0).boundingBox())!;
  const r2 = (await rows.nth(1).boundingBox())!;
  await page.mouse.move(r1.x + r1.width - 10, r1.y + 3);
  await page.mouse.down();
  await page.mouse.move(r2.x + r2.width - 20, r2.y + r2.height - 3, { steps: 4 });
  await page.mouse.up();
  await expect(info.locator('.info-row.sel')).toHaveCount(2);
  const n = (await get(page, 'Object.keys(app.doc.objects).length')) as number;
  await page.keyboard.press('r');
  expect(await get(page, 'Object.keys(app.doc.objects).length')).toBe(n + 2);
  await page.mouse.click(r1.x + 30, r1.y + 3, { button: 'right' });
  await expect(page.locator('.menu .menu-item', { hasText: 'Replay Operators' })).toBeVisible();
  await page.locator('.menu .menu-item', { hasText: 'Delete' }).click();
  await expectNoErrors(errors);
});

test('File Browser: browser storage, new folder, rename, keyboard selection, delete, bookmarks', async ({ page }) => {
  const errors = await openApp(page);
  // a clean browser-storage folder with two files
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    for await (const [name] of (root as any).entries()) await root.removeEntry(name, { recursive: true });
    for (const n of ['one.txt', 'two.py']) {
      const w = await (await root.getFileHandle(n, { create: true })).createWritable();
      await w.write(`# ${n}\n`);
      await w.close();
    }
  });
  // make the 3D view a File Browser and open Browser Storage
  const v = await areaBox(page, 'VIEW_3D');
  await page.mouse.move(v.x + 300, v.y + 300);
  await page.evaluate(() => (window as any).app.hoverArea.setType('FILE_BROWSER'));
  const fb = page.locator('.area[data-editor="FILE_BROWSER"]');
  await fb.locator('.fb-side-item', { hasText: 'Browser Storage' }).click();
  await expect(fb.locator('.fb-item')).toHaveCount(2);
  const run = (op: string, props: Record<string, unknown> = {}) => page.evaluate(([o, p]) => { const a = (window as any).app; return a.run(o, p, { area: a.hoverArea }); }, [op, props] as const);
  await page.mouse.move(v.x + 300, v.y + 300);
  // new folder (I), renamed
  await page.keyboard.press('i');
  await expect(fb.locator('.fb-item', { hasText: 'New Folder' })).toBeVisible();
  await run('file.rename', { new_name: 'assets' });
  await expect(fb.locator('.fb-item', { hasText: 'assets' })).toBeVisible();
  await expect(fb.locator('.fb-item.on')).toHaveText(/assets/);
  // keyboard: folders sort first; walk right to the first file, extend to the second
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowRight');
  await expect(fb.locator('.fb-item.on')).toHaveCount(2);
  await page.keyboard.press('Alt+a');
  await expect(fb.locator('.fb-item.on')).toHaveCount(0);
  await page.keyboard.press('a');
  await expect(fb.locator('.fb-item.on')).toHaveCount(3);
  // list view shows sizes; sorting by size puts the larger file first
  await run('file.select_all', { action: 'DESELECT' });
  await page.evaluate(() => { const fbEd = (window as any).app.hoverArea.editor; fbEd.setView('LIST_VERTICAL'); });
  await expect(fb.locator('.fb-items.list .fb-size').nth(1)).toHaveText(/B$/);
  // Enter on a text file opens it as a text data-block
  await fb.locator('.fb-item', { hasText: 'two.py' }).click();
  await page.keyboard.press('Enter');
  await expect.poll(() => get(page, 'Object.values(app.doc.texts).map(t => t.name).join(",")')).toContain('two.py');
  // delete the folder
  await fb.locator('.fb-item', { hasText: 'assets' }).click();
  await run('file.delete', { confirm: false });
  await expect(fb.locator('.fb-item')).toHaveCount(2);
  // bookmark the folder
  await page.keyboard.press('Control+b');
  await expect(fb.locator('.fb-side-item', { hasText: 'Browser Storage' })).toHaveCount(2);
  // right-click menu
  await fb.locator('.fb-item', { hasText: 'one.txt' }).click({ button: 'right' });
  await expect(page.locator('.menu .menu-item', { hasText: 'Rename' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expectNoErrors(errors);
});

test('Ctrl Alt Q toggles the quad view', async ({ page }) => {
  const errors = await openApp(page);
  const n0 = await areaCount(page);
  const v = await areaBox(page, 'VIEW_3D');
  await page.mouse.move(v.x + 300, v.y + 300);
  await page.keyboard.press('Control+Alt+q');
  await expect(page.locator('.area[data-editor="VIEW_3D"]')).toHaveCount(4);
  await expect(page.locator('.v3d-info', { hasText: 'Top Orthographic' })).toBeVisible();
  await expect(page.locator('.v3d-info', { hasText: 'Front Orthographic' })).toBeVisible();
  await expect(page.locator('.v3d-info', { hasText: 'Right Orthographic' })).toBeVisible();
  // toggling from one of the side views brings back the single view
  const top = (await page.locator('.area[data-editor="VIEW_3D"]').first().boundingBox())!;
  await page.mouse.move(top.x + 100, top.y + 150);
  await page.keyboard.press('Control+Alt+q');
  await expect(page.locator('.area[data-editor="VIEW_3D"]')).toHaveCount(1);
  expect(await areaCount(page)).toBe(n0);
  await expectNoErrors(errors);
});

test('Quick Favorites: add from a menu item, open with Q', async ({ page }) => {
  const errors = await openApp(page);
  await page.evaluate(() => localStorage.removeItem('p3d.quickfavorites.v1'));
  await page.locator('.tb-menu', { hasText: 'Edit' }).dispatchEvent('pointerdown');
  const item = page.locator('.menu .menu-item', { hasText: 'Menu Search' });
  await item.click({ button: 'right' });
  await page.locator('.menu .menu-item', { hasText: 'Add to Quick Favorites' }).click();
  await expect(page.locator('.menu')).toHaveCount(0);
  const v = await areaBox(page, 'VIEW_3D');
  await page.mouse.move(v.x + 300, v.y + 300);
  await page.keyboard.press('q');
  await expect(page.locator('.menu .menu-item', { hasText: 'Menu Search' })).toBeVisible();
  await page.locator('.menu .menu-item', { hasText: 'Menu Search' }).click();
  await expect(page.locator('.search-popup')).toBeVisible();
  await page.keyboard.press('Escape');
  await expectNoErrors(errors);
});

test('File > Append copies picked objects from another project', async ({ page }) => {
  const errors = await openApp(page);
  // a project file whose cube is renamed
  const bytes = await page.evaluate(async () => {
    const { startupDocument } = await import('/src/data/defaults.ts');
    const { encodeDocument } = await import('/src/io/native.ts');
    const d = startupDocument();
    Object.values(d.objects).find((o: any) => o.name === 'Cube')!.name = 'Crate';
    return Array.from(encodeDocument(d));
  });
  page.once('filechooser', (fc) => fc.setFiles({ name: 'library.p3d', mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) }));
  await page.evaluate(() => (window as any).app.run('wm.append'));
  const dlg = page.locator('.append-dlg');
  await expect(dlg).toBeVisible();
  await dlg.locator('.append-item', { hasText: 'Crate' }).click();
  await dlg.locator('.append-type', { hasText: 'Materials' }).click();
  await expect(dlg.locator('.append-item', { hasText: 'Material' })).toBeVisible();
  await dlg.locator('.btn', { hasText: 'Append 1' }).click();
  await expect(dlg).toHaveCount(0);
  expect(await get(page, 'app.activeObject.name')).toBe('Crate');
  expect(await get(page, 'Object.keys(app.doc.objects).length')).toBe(4);
  // undo removes it again
  await page.evaluate(() => (window as any).app.undoStep());
  expect(await get(page, 'Object.keys(app.doc.objects).length')).toBe(3);
  await expectNoErrors(errors);
});

test('File > External Data: report and find missing files, unpack resources', async ({ page }) => {
  const errors = await openApp(page);
  await page.evaluate(() => {
    const a = (window as any).app;
    a.doc.images.im_missing = { id: 'im_missing', name: 'wood', filepath: '//textures/wood.png', bytes: null, mime: 'image/png', width: 1, height: 1, source: 'FILE', colorspace: 'sRGB' };
    a.run('file.report_missing_files');
  });
  expect(await get(page, 'app.reports.some(r => r.message.includes("Missing image \\"wood\\""))')).toBe(true);
  const png = Buffer.from(
    await page.evaluate(async () => {
      const c = new OffscreenCanvas(2, 2);
      c.getContext('2d')!.fillRect(0, 0, 2, 2);
      return Array.from(new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer()));
    }),
  );
  page.once('filechooser', (fc) => fc.setFiles({ name: 'wood.png', mimeType: 'image/png', buffer: png }));
  await page.evaluate(() => (window as any).app.run('file.find_missing_files'));
  await expect.poll(() => get(page, 'app.doc.images.im_missing.width')).toBe(2);
  const dl = page.waitForEvent('download');
  await page.evaluate(() => (window as any).app.run('file.unpack_all'));
  expect((await dl).suggestedFilename()).toBe('untitled_resources.zip');
  await expectNoErrors(errors);
});
