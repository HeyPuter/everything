import { expect, test, type Page } from '@playwright/test';
import { layer, newDocument } from '../../src/model/document';
import { encodePng } from '../../src/features/files/png';
import { photoFile } from '../browser/helpers';

async function openSavedDocument(page: Page, image = false) {
  await page.route('https://js.puter.com/**', (route) => route.fulfill({ contentType: 'application/javascript', body: 'window.puter={env:"app",auth:{isSignedIn:()=>true}};' }));
  await page.goto('/');
  await expect(page.locator('#engine-status')).toHaveText(/WebGPU|WebGL2/);
  const doc = newDocument(64, 48, 'Saved');
  doc.layers = [layer(image ? 'image' : 'solid', 'White rectangle', 32, 24)];
  const png = encodePng({ width: 32, height: 24, data: new Uint8Array(32 * 24 * 4).fill(255), channels: 4 });
  if (image) doc.layers[0].asset = 'original';
  const file = photoFile(doc, image ? [{ id: 'original', size: png.length, type: 'image/png' }] : [], 'saved.photo');
  if (image) file.buffer = Buffer.concat([file.buffer, png]);
  await page.locator('#file-input').setInputFiles(file);
  await expect(page.locator('.document-tab.focused')).toContainText('Saved');
  await expect(page.locator('#app')).not.toHaveAttribute('aria-busy', 'true');
  await page.locator('#viewport').focus();
}

async function refresh(page: Page, shouldPrompt: boolean) {
  const dialogs: string[] = [];
  const dismissed = new Promise<void>((resolve) => page.once('dialog', async (dialog) => {
    dialogs.push(dialog.type());
    await dialog.dismiss();
    resolve();
  }));
  // A dismissed beforeunload leaves reload waiting for a navigation that was cancelled.
  const reload = page.reload().catch((error) => { if (!dialogs.length) throw error; });
  await Promise.race([reload, dismissed]);
  expect(dialogs).toEqual(shouldPrompt ? ['beforeunload'] : []);
}

for (const state of ['saved', 'unchanged tool', 'pending transform', 'committed transform']) test(`refreshing a document with ${state}`, async ({ page }) => {
  await openSavedDocument(page);
  if (state !== 'saved') {
    await page.keyboard.press('ControlOrMeta+t');
    await expect(page.locator('#tool-options').getByRole('button', { name: 'Apply', exact: true })).toBeVisible();
    if (state !== 'unchanged tool') await page.keyboard.press('ArrowRight');
    if (state === 'committed transform') await page.keyboard.press('Enter');
  }
  await refresh(page, state === 'pending transform' || state === 'committed transform');
  if (state === 'pending transform') {
    await expect(page.locator('#tool-options').getByRole('button', { name: 'Apply', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await refresh(page, false);
  }
});

for (const state of ['unchanged', 'preview', 'asset write', 'background asset write']) test(`refreshing during an image transform ${state}`, async ({ page }) => {
  const commit = state.endsWith('asset write');
  await openSavedDocument(page, true);
  await page.getByRole('menubar').getByRole('menuitem', { name: 'Edit', exact: true }).click();
  const transform = page.locator('.menubar-entry.open > .menu-pop > .menu-item').filter({ has: page.locator(':scope > .menu-label', { hasText: /^Transform$/ }) });
  await transform.hover();
  await transform.locator('.submenu > .menu-item').filter({ has: page.locator(':scope > .menu-label', { hasText: /^Distort$/ }) }).click();
  const apply = page.locator('#tool-options').getByRole('button', { name: 'Commit transform', exact: true });
  await expect(apply).toBeEnabled();
  if (state === 'unchanged') {
    await refresh(page, false);
    return;
  }
  const handle = await page.locator('[data-ts-handle="ne"] .handle-hit').boundingBox();
  await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle!.x + handle!.width / 2 - 20, handle!.y + handle!.height / 2 + 10, { steps: 4 });
  await page.mouse.up();
  if (commit) {
    await page.evaluate(() => {
      const original = window.createImageBitmap.bind(window);
      window.createImageBitmap = (async (...args: Parameters<typeof createImageBitmap>) => {
        window.createImageBitmap = original;
        await new Promise<void>((resolve) => Object.assign(window, { finishUnloadAsset: resolve }));
        return original(...args);
      }) as typeof createImageBitmap;
    });
    await apply.click();
    await page.waitForFunction(() => !!(window as unknown as { finishUnloadAsset?: () => void }).finishUnloadAsset);
    await expect(apply).toHaveCount(0);
    await expect(page.locator('#dirty')).toBeHidden();
  }
  if (state === 'background asset write') {
    await page.locator('#file-input').setInputFiles(photoFile(newDocument(32, 24, 'Other'), [], 'other.photo'));
    await expect(page.locator('.document-tab.focused')).toContainText('Other');
    await expect(page.locator('#app')).not.toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('#dirty')).toBeHidden();
  }
  await refresh(page, true);
  if (commit) {
    await page.evaluate(() => (window as unknown as { finishUnloadAsset(): void }).finishUnloadAsset());
    await expect(page.locator('.document-tab').filter({ hasText: 'Saved' }).locator('.dirty-dot')).toBeVisible();
    if (state === 'background asset write') await page.locator('.document-tab').filter({ hasText: 'Saved' }).click();
    await page.locator('#viewport').focus();
    await page.keyboard.press('ControlOrMeta+z');
    await expect(page.locator('#dirty')).toBeHidden();
  } else {
    await expect(apply).toBeVisible();
    await page.locator('#tool-options').getByRole('button', { name: 'Cancel transform', exact: true }).click();
  }
  await refresh(page, false);
});
