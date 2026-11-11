import { test, expect, type Page } from '@playwright/test';
import { boot, canvasClick, canvasDrag, idle, openImage, tool } from './helpers';

// Document switching and closing while asynchronous work is in progress, and
// the dialogs those flows show.

test.beforeEach(async ({ page }) => {
  await boot(page);
});

/** Two open documents, the second one active and with an unsaved edit. */
async function twoDocuments(page: Page) {
  await openImage(page, 64, 48, '#ff0000', 'first.png');
  await openImage(page, 80, 60, '#0000ff', 'second.png');
  await page.evaluate(() => window.photoStudio.command('Edit', (d) => void (d.guides = [{ orientation: 'horizontal', position: 10 }])));
  await idle(page);
  expect(await page.evaluate(() => window.photoStudio.sessions.length)).toBe(2);
}

test('a dialog opened over another one cancels the first instead of leaving it unanswered', async ({ page }) => {
  const results = await page.evaluate(async () => {
    const { formDialog } = await import('/src/ui/dialog.ts');
    const first = formDialog('First', [], 'OK');
    const second = formDialog('Second', [], 'OK');
    const settled = await Promise.race([first.then((v) => ({ v })), new Promise((r) => setTimeout(() => r('pending'), 500))]);
    document.querySelector<HTMLButtonElement>('#dialog #cancel-dialog')!.click();
    return { settled, second: await second };
  });
  expect(results.settled).toEqual({ v: null });
  expect(results.second).toBeNull();
  // A dialog that follows an answered one right away stays open for its own answer.
  const chained = await page.evaluate(async () => {
    const { formDialog } = await import('/src/ui/dialog.ts');
    const first = formDialog('First', [], 'OK');
    document.querySelector<HTMLButtonElement>('#dialog button[type=submit]')!.click();
    await first;
    const second = formDialog('Second', [{ name: 'v', label: 'Value', value: 'kept' }], 'OK');
    await new Promise((r) => setTimeout(r, 300));
    const open = document.querySelector<HTMLDialogElement>('#dialog')!.open;
    document.querySelector<HTMLButtonElement>('#dialog button[type=submit]')!.click();
    return { open, second: await second };
  });
  expect(chained).toEqual({ open: true, second: { v: 'kept' } });
});

test('clicking the close button of an unsaved document twice asks once and closes only it', async ({ page }) => {
  await twoDocuments(page);
  const close = page.locator('.document-tab.focused .tab-close');
  await close.dblclick();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: /Don.t Save|Close without saving/ }).click();
  await expect(dialog).toBeHidden();
  await idle(page);
  await expect.poll(() => page.evaluate(() => window.photoStudio.sessions.map((s) => s.doc.name))).toEqual(['first']);
  await expect(dialog).toBeHidden();
});

test('a feature whose code cannot be loaded is reported in plain words', async ({ page }) => {
  await page.evaluate(() => window.photoStudio.run(async () => void (await import(/* @vite-ignore */ `/src/features/missing-${Date.now()}.ts`))));
  await expect(page.locator('#status')).toHaveText(/could not be loaded/);
  await expect(page.locator('#status')).not.toHaveText(/https?:|\.ts/);
});

/** Puter stand-ins: writes are recorded; the save picker answers when told to. */
async function stubPuter(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { puter: Record<string, unknown>; written: string[]; answerPicker?: (path: string | null) => void };
    w.written = [];
    const item = (path: string) => ({ path, name: path.split('/').pop()!, read: async () => new Blob() });
    w.puter.fs = { write: async (path: string) => (w.written.push(path), item(path)) };
    // A dismissed Puter picker never settles.
    w.puter.ui = { showSaveFilePicker: () => new Promise((resolve) => (w.answerPicker = (path) => path && (w.written.push(path), resolve(item(path))))) };
  });
}
const names = (page: Page) => page.evaluate(() => window.photoStudio.sessions.map((s) => s.doc.name));

test('closing an unsaved document offers Save, which saves before closing', async ({ page }) => {
  await twoDocuments(page);
  await stubPuter(page);
  await page.evaluate(() => (window.photoStudio.session.storage.path = '/user/Documents/second.photo'));
  await page.locator('.document-tab.focused .tab-close').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeFocused();
  await expect(dialog.getByRole('button', { name: 'Don’t Save' })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect.poll(() => names(page)).toEqual(['first']);
  expect(await page.evaluate(() => (window as unknown as { written: string[] }).written)).toEqual(['/user/Documents/second.photo']);
});

test('a first save before closing waits for the save picker, and a dismissed picker keeps the document', async ({ page }) => {
  await twoDocuments(page);
  await stubPuter(page);
  const close = async () => {
    await page.locator('.document-tab.focused .tab-close').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect.poll(() => page.evaluate(() => typeof (window as unknown as { answerPicker?: unknown }).answerPicker)).toBe('function');
  };
  // The picker is dismissed (it never answers) and the user goes on working:
  // the document stays open, and a later save does not close it.
  await close();
  expect(await names(page)).toEqual(['first', 'second']);
  await page.mouse.click(700, 400);
  await page.evaluate(() => (window as unknown as { answerPicker: (p: string) => void }).answerPicker('/user/Documents/later.photo'));
  await idle(page);
  expect(await names(page)).toEqual(['first', 'second']);
  // Another document closed the same way: the picker answers, the document is saved and closes.
  await page.locator('.document-tab', { hasText: 'first' }).click();
  await page.evaluate(() => window.photoStudio.command('Edit', (d) => void (d.guides = [{ orientation: 'vertical', position: 3 }])));
  await page.evaluate(() => delete (window as unknown as { answerPicker?: unknown }).answerPicker);
  await close();
  await page.evaluate(() => (window as unknown as { answerPicker: (p: string) => void }).answerPicker('/user/Documents/first.photo'));
  await expect.poll(() => names(page)).toEqual(['second']);
  expect(await page.evaluate(() => (window as unknown as { written: string[] }).written)).toEqual(['/user/Documents/later.photo', '/user/Documents/first.photo']);
});

test('Cancel keeps an unsaved document open and Don’t Save closes it', async ({ page }) => {
  await twoDocuments(page);
  const dialog = page.getByRole('dialog');
  await page.locator('.document-tab.focused .tab-close').click();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  expect(await names(page)).toEqual(['first', 'second']);
  await page.locator('.document-tab.focused .tab-close').click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  expect(await names(page)).toEqual(['first', 'second']);
  await page.locator('.document-tab.focused .tab-close').click();
  await dialog.getByRole('button', { name: 'Don’t Save' }).click();
  await expect.poll(() => names(page)).toEqual(['first']);
});

/** History labels of every open document, by name. */
const histories = (page: Page) =>
  page.evaluate(() => Object.fromEntries(window.photoStudio.sessions.map((s) => [s.doc.name, s.history.labels])));

test('a tab clicked while a command is running switches when the command finishes', async ({ page }) => {
  await twoDocuments(page);
  const labels = await histories(page);
  // A command that edits its document after waiting for something.
  await page.evaluate(() => {
    const e = window.photoStudio;
    (window as unknown as { done: Promise<void> }).done = e.run(async () => {
      await new Promise((r) => setTimeout(r, 1500));
      e.command('Slow Edit', (d) => void (d.guides = [{ orientation: 'vertical', position: 5 }]));
    });
  });
  await page.locator('.document-tab', { hasText: 'first' }).click();
  await expect(page.locator('#status')).toContainText('first');
  expect(await page.evaluate(() => window.photoStudio.doc.name)).toBe('second');
  await page.evaluate(() => (window as unknown as { done: Promise<void> }).done);
  await expect.poll(() => page.evaluate(() => window.photoStudio.doc.name)).toBe('first');
  expect(await histories(page)).toEqual({ first: labels.first, second: [...labels.second, 'Slow Edit'] });
});

test('switching documents commits a Type Mask into the document it was typed in', async ({ page }) => {
  await twoDocuments(page);
  await tool(page, 'Horizontal Type Mask Tool');
  await canvasClick(page, 10, 30);
  await page.keyboard.type('Mask');
  await page.locator('.document-tab', { hasText: 'first' }).click();
  await idle(page);
  await expect.poll(() => page.evaluate(() => window.photoStudio.doc.name)).toBe('first');
  const state = await page.evaluate(() => window.photoStudio.sessions.map((s) => ({ name: s.doc.name, selection: !!s.doc.selection, label: s.history.labels.at(-1) })));
  expect(state).toEqual([
    { name: 'first', selection: false, label: expect.not.stringMatching(/Type Mask/) },
    { name: 'second', selection: true, label: 'Type Mask' },
  ]);
});

test('Remove tool strokes waiting to be applied stay with their document when another one opens', async ({ page }) => {
  // Gray with a red spot to remove.
  await page.evaluate(async () => {
    const c = new OffscreenCanvas(120, 90);
    const g = c.getContext('2d')!;
    g.fillStyle = '#808080';
    g.fillRect(0, 0, 120, 90);
    g.fillStyle = '#ff0000';
    g.fillRect(40, 30, 12, 8);
    const { openFile } = await import('/src/features/files/open.ts');
    await openFile(window.photoStudio, await c.convertToBlob({ type: 'image/png' }), 'painted.png');
  });
  await idle(page);
  await tool(page, 'Remove Tool');
  await page.evaluate(() => (window.photoStudio.settings.removeEach = false));
  await page.evaluate(() => window.photoStudio.setTool(window.photoStudio.tool));
  await canvasDrag(page, [[38, 34], [54, 34]]);
  await idle(page);
  await expect(page.locator('#remove-apply')).toBeVisible();
  await openImage(page, 100, 80, '#00ff00', 'other.png');
  // The new document has nothing to apply, and Enter does not edit it.
  await expect(page.locator('#remove-apply')).toHaveCount(0);
  await expect(page.locator('#overlay .retouch-stroke')).toHaveCount(0);
  await page.locator('#viewport').focus();
  await page.keyboard.press('Enter');
  await idle(page);
  expect((await histories(page)).other).toEqual([]);
  // Back in the painted document the strokes are there to apply.
  await page.locator('.document-tab', { hasText: 'painted' }).click();
  await idle(page);
  await expect(page.locator('#remove-apply')).toBeVisible();
  await page.locator('#remove-apply').click();
  await idle(page);
  expect(await histories(page)).toEqual({ painted: ['Remove Tool'], other: [] });
});

test('a document is not closed under a running task', async ({ page }) => {
  await twoDocuments(page);
  await page.evaluate(() => {
    const e = window.photoStudio;
    (window as unknown as { done: Promise<void> }).done = e.run(() => new Promise((r) => setTimeout(r, 1500)));
  });
  await page.locator('.document-tab.focused .tab-close').click();
  await expect(page.locator('#status')).toContainText('can be closed when the current task finishes');
  await expect(page.getByRole('dialog')).toBeHidden();
  await page.evaluate(() => (window as unknown as { done: Promise<void> }).done);
  expect(await names(page)).toEqual(['first', 'second']);
});

test('Ask when opening asks about each of several files opened together', async ({ page }) => {
  await page.evaluate(() => {
    localStorage.setItem('photo-studio-color-settings', JSON.stringify({ rgb: 'builtin:display-p3', askMissing: true }));
  });
  await page.reload();
  await boot(page);
  const png = async (fill: string) =>
    Buffer.from(
      await page.evaluate(async (fill) => {
        const c = new OffscreenCanvas(30, 20);
        const g = c.getContext('2d')!;
        g.fillStyle = fill;
        g.fillRect(0, 0, 30, 20);
        return Array.from(new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer()));
      }, fill),
    );
  await page.locator('#file-input').setInputFiles([
    { name: 'one.png', mimeType: 'image/png', buffer: await png('#f00') },
    { name: 'two.png', mimeType: 'image/png', buffer: await png('#00f') },
  ]);
  const dialog = page.getByRole('dialog');
  for (const name of ['one', 'two']) {
    await expect(dialog).toContainText(`“${name}” does not have an embedded RGB profile`);
    await dialog.getByRole('combobox').selectOption('working');
    await dialog.getByRole('button', { name: 'OK' }).click();
  }
  await expect(dialog).toBeHidden();
  await idle(page);
  await expect
    .poll(() => page.evaluate(() => window.photoStudio.sessions.map((s) => [s.doc.name, !!s.doc.iccProfile, s.history.labels.at(-1)])))
    .toEqual([
      ['one', true, 'Assign Profile'],
      ['two', true, 'Assign Profile'],
    ]);
});
