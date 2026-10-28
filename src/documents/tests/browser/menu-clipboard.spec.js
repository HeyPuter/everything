import { test, expect } from '@playwright/test';

const input = page => page.getByRole('textbox', { name: 'Document text' });

test('Copy from the menus writes the same text as the keyboard, without placeholder characters', async ({ browser }) => {
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'], viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  try {
    await page.goto('/mock.html#/new');
    await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
    await input(page).fill('Before after');
    // A picture between the words: the document holds it as one placeholder character.
    await page.evaluate(async () => {
      const e = window.__docs.current.view.engine; e.model.select(7); e.syncInput();
      const canvas = document.createElement('canvas'); canvas.width = 4; canvas.height = 4; canvas.getContext('2d').fillRect(0, 0, 4, 4);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      await e.insertImageFile(new File([blob], 'dot.png', { type: 'image/png' }));
    });
    const selectAll = () => page.evaluate(() => { const e = window.__docs.current.view.engine; e.model.select(0, e.model.text.length); e.syncInput(); e.onSelection(); });
    const clipboard = () => page.evaluate(() => navigator.clipboard.readText());
    await selectAll();
    await input(page).press('ControlOrMeta+c');
    const keyboard = await clipboard();
    expect(keyboard).toBe('Before [Image]after');
    await page.evaluate(() => navigator.clipboard.writeText(''));
    await page.locator('canvas.canvas-page').first().click({ button: 'right', position: { x: 150, y: 110 } });
    await selectAll();
    await page.getByRole('menu', { name: 'Document menu' }).getByRole('menuitem', { name: 'Copy', exact: true }).click();
    await expect.poll(clipboard).toBe(keyboard);
  } finally { await context.close(); }
});

test('Shift+Delete on a selection is left to the browser, which cuts on Windows and Linux', async ({ page }) => {
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await input(page).fill('Hello world');
  const select = (a, b) => input(page).evaluate((el, [a, b]) => { el.focus(); el.setSelectionRange(a, b); el.dispatchEvent(new Event('select')); }, [a, b]);
  const keydown = init => input(page).evaluate((el, init) => { const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }); el.dispatchEvent(event); return event.defaultPrevented; }, init);
  await select(0, 5);
  // The editor does not delete the selection itself, so the browser's Cut (or a Mac's forward delete) runs.
  expect(await keydown({ key: 'Delete', code: 'Delete', shiftKey: true })).toBe(false);
  await expect(input(page)).toHaveValue('Hello world');
  // The cut it sends copies the text and removes it as one undo step.
  const copied = await input(page).evaluate(el => {
    const data = new DataTransfer(); el.dispatchEvent(new ClipboardEvent('cut', { clipboardData: data, bubbles: true, cancelable: true }));
    return data.getData('text/plain');
  });
  expect(copied).toBe('Hello');
  await expect(input(page)).toHaveValue(' world');
  // Without a selection Shift+Delete deletes forward, and plain Delete is unchanged.
  await select(0, 0);
  expect(await keydown({ key: 'Delete', code: 'Delete', shiftKey: true })).toBe(true);
  await expect(input(page)).toHaveValue('world');
});

test('after a design change reopens the document, the Paste options menu still pastes into it', async ({ browser }) => {
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'], viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  try {
    await page.goto('/mock.html#/new');
    await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
    await input(page).fill('Quarterly report');
    // A theme rewrites the package and opens it again in place, with a new engine.
    await page.locator('#ribbon-tab-design').click();
    await page.locator('.ribbon-card').getByRole('button', { name: 'Themes' }).click();
    await page.getByRole('menu', { name: 'Themes' }).getByRole('menuitemradio', { name: 'Harbor theme' }).click();
    await expect.poll(() => page.evaluate(() => window.__docs.current.view.commands.packageHistory().undo)).toBe(true);
    await page.evaluate(() => navigator.clipboard.writeText(' for May'));
    await page.evaluate(() => { const e = window.__docs.current.view.engine; e.model.select(e.model.text.length); e.syncInput(); e.focus(); });
    await page.locator('#ribbon-tab-home').click();
    await page.getByRole('button', { name: 'Paste options', exact: true }).click();
    await page.getByRole('menu', { name: 'Paste options' }).getByRole('menuitem', { name: 'Keep Text Only' }).click();
    await expect(input(page)).toHaveValue('Quarterly report for May');
    // Its paste options chip offers the modes for what was pasted.
    await expect(page.getByRole('button', { name: 'Pasted text options' })).toBeVisible();
  } finally { await context.close(); }
});

test('Paste from the menus explains a clipboard the browser keeps closed, and names the keys that still paste', async ({ page }) => {
  // No clipboard permission is granted: the browser refuses to let the page read it.
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await input(page).fill('Hello');
  const menu = page.getByRole('menu', { name: 'Document menu' });
  for (const name of ['Paste', 'Paste without formatting']) {
    await page.locator('canvas.canvas-page').first().click({ button: 'right', position: { x: 150, y: 110 } });
    await menu.getByRole('menuitem', { name, exact: true }).click();
    const toast = page.locator('.toast').filter({ hasText: 'clipboard' }).last();
    await expect(toast).toHaveText(/The browser didn’t allow reading the clipboard\. Paste with (Cmd|Ctrl)\+V, or (Cmd|Ctrl)\+Shift\+V for the text alone\./);
    await expect(toast).not.toContainText('Failed to execute');
  }
  // The Paste options on the Home tab say the same.
  await page.getByRole('button', { name: 'Paste options', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Keep Text Only', exact: true }).click();
  const toast = page.locator('.toast').filter({ hasText: 'clipboard' }).last();
  await expect(toast).toHaveText('The clipboard could not be read. Allow clipboard access, or paste with the keyboard.');
  await expect(input(page)).toHaveValue('Hello');
});

test('Copy and Cut from the menus work in a frame given no clipboard access', async ({ page, baseURL }) => {
  // A desktop environment hosts the app in a frame from another origin; this one allows it no clipboard API.
  await page.goto(`${baseURL.replace('127.0.0.1', 'localhost')}/playground.html`);
  await page.setContent(`<iframe src="${baseURL}/mock.html#/new" style="width:1200px;height:850px;border:0"></iframe>`);
  const frame = page.frameLocator('iframe'), field = frame.getByRole('textbox', { name: 'Document text' });
  await expect(frame.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await field.fill('Hello brave world');
  const select = (a, b) => field.evaluate((el, [a, b]) => { el.focus(); el.setSelectionRange(a, b); el.dispatchEvent(new Event('select')); }, [a, b]);
  // The menu opened on the selected text, just before its end, where the caret is drawn.
  const choose = async name => {
    const caret = await field.evaluate(el => ({ x: parseFloat(el.style.left) - 3, y: parseFloat(el.style.top) + parseFloat(el.style.height) / 2 }));
    await frame.locator('.canvas-pages').click({ button: 'right', position: caret });
    await frame.getByRole('menu', { name: 'Document menu' }).getByRole('menuitem', { name, exact: true }).click();
  };
  await select(6, 12);
  await choose('Copy');
  await select(17, 17);
  await field.press('ControlOrMeta+v');
  await expect(field).toHaveValue('Hello brave worldbrave ');
  await select(0, 6);
  await choose('Cut');
  await expect(field).toHaveValue('brave worldbrave ');
  await select(17, 17);
  await field.press('ControlOrMeta+v');
  await expect(field).toHaveValue('brave worldbrave Hello ');
  await expect(frame.locator('.toast').filter({ hasText: 'clipboard' })).toHaveCount(0);
});
