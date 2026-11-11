// Statistics, batch Lens Correction and batch links in the real workspace.
import { test, expect } from '@playwright/test';
import { boot, idle, openImage } from './helpers';

test.beforeEach(async ({ page }) => {
  await boot(page);
});

test('Statistics combines open documents into an embedded object with a stack mode', async ({ page }) => {
  await openImage(page, 64, 48, '#204080', 'a.png');
  await openImage(page, 64, 48, '#4080c0', 'b.png');
  await openImage(page, 64, 48, '#ff0000', 'c.png');
  await page.evaluate(() => void window.photoStudio.runCommand('file.statistics'));
  const d = page.getByRole('dialog', { name: 'Statistics' });
  await d.getByRole('button', { name: 'Add open documents' }).click();
  await d.getByLabel('Stack mode').selectOption('median');
  await d.getByRole('button', { name: 'Combine' }).click();
  await expect(d).toHaveCount(0, { timeout: 60_000 });
  await idle(page);
  const r = await page.evaluate(async () => {
    const e = window.photoStudio;
    const l = e.doc.layers[0];
    const { contentsOf } = await import('/src/model/embedded.ts');
    const { compositeRGBA } = await import('/src/features/pixels.ts');
    const px = (await compositeRGBA(e)).data;
    return { name: e.doc.name, layers: e.doc.layers.length, stack: contentsOf(e.doc, l)?.stack, pixel: [px[0], px[1], px[2]] };
  });
  expect(r).toMatchObject({ name: 'Statistics (Median)', layers: 1, stack: 'median' });
  // The median of the three colors per channel.
  expect(r.pixel[0]).toBeLessThan(80);
  expect(r.pixel[2]).toBeGreaterThan(110);
});

test('Lens Correction corrects open documents into a ZIP', async ({ page }) => {
  await openImage(page, 120, 90, '#808080', 'lens.png');
  await page.evaluate(() => void window.photoStudio.runCommand('file.lens-correction-batch'));
  const d = page.getByRole('dialog', { name: 'Lens Correction' });
  await d.getByRole('button', { name: 'Add open documents' }).click();
  await d.getByLabel('Custom').check();
  await d.getByLabel('Vignette amount').fill('40');
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), d.getByRole('button', { name: 'Correct' }).click()]);
  expect(download.suggestedFilename()).toBe('lens-corrected.zip');
});

test('a batch link opens ready to run its action on dropped photos', async ({ page }) => {
  const hash = await page.evaluate(async () => {
    const { encodeBatchLink } = await import('/src/features/scripting/batch-link-core.ts');
    return encodeBatchLink({ v: 1, name: 'Mirror and Gray', steps: [{ command: 'image.flip-horizontal' }, { command: 'adjust.desaturate' }], format: 'png', quality: 90 });
  });
  // A fresh start from the link (as a bookmark opens it).
  await page.goto('about:blank');
  await page.goto(`/${hash}`);
  await page.waitForFunction(() => !!window.photoStudio?.renderer, null, { timeout: 90_000 });
  const d = page.getByRole('dialog', { name: 'Batch: Mirror and Gray' });
  await expect(d).toBeVisible({ timeout: 30_000 });
  await expect(d.locator('.batch-link-list li')).toHaveText(['Flip Canvas Horizontal', 'Desaturate']);
  // Drop a photo onto the window.
  await page.evaluate(async () => {
    const c = new OffscreenCanvas(40, 30);
    const g = c.getContext('2d')!;
    g.fillStyle = '#ff0000';
    g.fillRect(0, 0, 20, 30);
    const file = new File([await c.convertToBlob({ type: 'image/png' })], 'photo.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    document.querySelector('dialog.batch-link-run')!.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await expect(d.locator('.processor-list li')).toHaveText(['photo.png']);
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), d.getByRole('button', { name: 'Run' }).click()]);
  expect(download.suggestedFilename()).toBe('Mirror and Gray.zip');
  await expect(d.locator('.processor-status')).toContainText('Saved 1 file');
});

test('a damaged or hostile actions file loads safely and the app still starts afterwards', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.evaluate(() => localStorage.removeItem('photo-studio-actions'));
  await page.evaluate(() => window.photoStudio.dock.show('actions'));
  const hostile = '"><img id="injected" src="x" onerror="window.__injected=1">';
  const file = { format: 'photo-studio-actions', version: 1, sets: [{ id: hostile, name: 'Shared', open: true, actions: [{ id: hostile, name: 'Copy Layer', steps: [{ command: 'layer.duplicate', enabled: true, dialog: false }] }] }, { name: 'Without actions', open: true }, null] };
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.evaluate(() => void window.photoStudio.runCommand('actions.import'))]);
  await chooser.setFiles({ name: 'actions.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(file)) });
  const row = page.locator('.actions-list .action-row.action', { hasText: 'Copy Layer' });
  await expect(row).toHaveCount(1);
  await row.click();
  await expect(page.locator('.actions-list .action-row.step')).toHaveCount(1);
  await expect(page.locator('.actions-list .action-row.step')).toContainText('Duplicate Layer');
  await expect(page.locator('.actions-list .action-row.set', { hasText: 'Without actions' })).toHaveCount(1);
  expect(await page.locator('#injected').count()).toBe(0);
  expect(await page.evaluate(() => (window as unknown as { __injected?: number }).__injected)).toBeUndefined();
  // The loaded sets are stored; the next start still works.
  await page.reload();
  await page.waitForFunction(() => !!window.photoStudio?.renderer, null, { timeout: 90_000 });
  await page.evaluate(() => window.photoStudio.dock.show('actions'));
  await expect(page.locator('.actions-list .action-row.set', { hasText: 'Shared' })).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('deleting the action being recorded stops the recording', async ({ page }) => {
  await page.evaluate(() => localStorage.removeItem('photo-studio-actions'));
  await page.reload();
  await page.waitForFunction(() => !!window.photoStudio?.renderer, null, { timeout: 90_000 });
  await openImage(page, 64, 48, '#204080', 'rec.png');
  await page.evaluate(() => window.photoStudio.dock.show('actions'));
  await page.locator('.actions-list .action-row.action', { hasText: 'Mirror Canvas' }).click();
  await page.evaluate(() => window.photoStudio.runCommand('actions.record'));
  await expect(page.locator('.actions-list .action-row.recording')).toHaveCount(1);
  await page.evaluate(() => window.photoStudio.runCommand('actions.delete'));
  await expect(page.locator('.actions-list .action-row.action', { hasText: 'Mirror Canvas' })).toHaveCount(0);
  // Nothing is recorded any more, and Stop has nothing to stop.
  expect(await page.evaluate(() => !!window.photoStudio.recorder)).toBe(false);
  await expect(page.getByRole('button', { name: 'Stop recording' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Begin recording' })).toBeDisabled();
});
