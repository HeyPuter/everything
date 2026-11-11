import { test, expect, type Page } from '@playwright/test';
import { boot, idle, openImage } from './helpers';

// Document switching and closing while asynchronous work is in progress, and
// the dialogs those flows show.

test.beforeEach(async ({ page }) => {
  await boot(page);
});

/** Two open documents, the second one active and with an unsaved edit. */
async function twoDocuments(page: Page) {
  await openImage(page, 64, 48, '#ff0000', 'first.png');
  await openImage(page, 80, 60, '#0000ff', 'second.png');
  await page.evaluate(() => window.photoStudio.command('Edit', (d) => void (d.name = 'second.png')));
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
