// Dialog commands in recorded actions: confirmed settings are recorded and
// replayed without the dialog, and cancelled dialogs are not recorded.
import { test, expect, type Page } from '@playwright/test';
import { boot, idle, layerPixel, openImage, run, start } from './helpers';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.removeItem('photo-studio-actions'));
  await boot(page);
});

type Step = { command: string; arg?: { params?: Record<string, unknown> }; enabled?: boolean; dialog?: boolean };
const recordedSteps = (page: Page): Promise<Step[]> => page.evaluate(() => JSON.parse(localStorage.getItem('photo-studio-actions') ?? '[]').flatMap((s: { actions: { steps: unknown[] }[] }) => s.actions).at(-1)?.steps ?? []);
const docInfo = (page: Page) => page.evaluate(() => ({ width: window.photoStudio.doc.width, height: window.photoStudio.doc.height, layers: window.photoStudio.doc.layers.map((l) => l.name), selection: !!window.photoStudio.doc.selection }));

async function newAction(page: Page, name = 'Test') {
  await start(page, 'actions.new');
  const d = page.locator('dialog[open]', { hasText: 'New Action' });
  await d.getByLabel('Name').fill(name);
  await d.getByRole('button', { name: 'Record' }).click();
  await expect(page.locator('.actions-list .action-row.recording')).toHaveCount(1);
}
/** Load an action set and select its first action. */
async function loadAction(page: Page, name: string, steps: Step[]) {
  await page.evaluate(() => window.photoStudio.dock.show('actions'));
  const file = { format: 'photo-studio-actions', version: 1, sets: [{ name: 'Loaded', open: true, actions: [{ name, steps }] }] };
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.evaluate(() => void window.photoStudio.runCommand('actions.import'))]);
  await chooser.setFiles({ name: 'actions.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(file)) });
  await page.locator('.actions-list .action-row.action', { hasText: name }).click();
}
/** Start playing the selected action without waiting for it. */
async function startPlay(page: Page) {
  await page.evaluate(() => void window.photoStudio.runCommand('actions.play'));
}
const confirm = (page: Page, title: string, submit = 'OK') => page.locator('dialog[open]', { hasText: title }).getByRole('button', { name: submit, exact: true }).click();

test('New Layer, Feather, Fill, Rotate, Canvas Size and Image Size replay their settings without dialogs', async ({ page }) => {
  await openImage(page, 80, 60, '#808080', 'a.png');
  await newAction(page, 'Dialogs');
  await start(page, 'layer.new');
  await page.locator('dialog[open]', { hasText: 'New Layer' }).getByLabel('Name').fill('Painted');
  await confirm(page, 'New Layer');
  await idle(page);
  await run(page, 'select.all');
  await start(page, 'select.modify-feather');
  await page.locator('dialog[open]', { hasText: 'Feather Selection' }).getByLabel('Feather Radius (px)').fill('3');
  await confirm(page, 'Feather Selection');
  await idle(page);
  await start(page, 'edit.fill');
  const fill = page.locator('dialog[open]', { hasText: 'Fill' });
  await fill.getByRole('combobox', { name: 'Contents', exact: true }).selectOption('black');
  await fill.getByLabel('Opacity (%)').fill('50');
  await confirm(page, 'Fill');
  await idle(page);
  await run(page, 'select.deselect');
  await start(page, 'image.rotate-arbitrary');
  await page.locator('dialog[open]', { hasText: 'Rotate Canvas' }).getByLabel('Angle (°)').fill('90');
  await confirm(page, 'Rotate Canvas', 'Rotate');
  await idle(page);
  await start(page, 'image.canvas-size');
  const cs = page.locator('dialog[open]', { hasText: 'Canvas Size' });
  await cs.locator('#cs-w').fill('100');
  await cs.locator('#cs-w').press('Tab');
  await confirm(page, 'Canvas Size');
  await idle(page);
  await start(page, 'image.image-size');
  const is = page.locator('dialog[open]', { hasText: 'Image Size' });
  await is.locator('#is-w').fill('50');
  await is.locator('#is-w').press('Tab');
  await confirm(page, 'Image Size');
  await idle(page);
  await run(page, 'actions.stop');
  const recorded = await docInfo(page);
  const pixel = await layerPixel(page, 10, 10);
  expect(recorded).toMatchObject({ width: 50, layers: ['Background', 'Painted'] });
  const steps = await recordedSteps(page);
  expect(steps.map((s) => s.command)).toEqual(['layer.new', 'select.all', 'select.modify-feather', 'edit.fill', 'select.deselect', 'image.rotate-arbitrary', 'image.canvas-size', 'image.image-size']);
  expect(steps[0].arg?.params).toMatchObject({ name: 'Painted' });
  expect(steps[2].arg?.params).toMatchObject({ value: '3' });
  expect(steps[3].arg?.params).toMatchObject({ contents: 'black', opacity: '50' });
  expect(steps[5].arg?.params).toMatchObject({ angle: '90' });
  expect(steps[6].arg?.params).toMatchObject({ width: 100, height: 80 });
  expect(steps[7].arg?.params).toMatchObject({ width: 50, height: 40 });

  await openImage(page, 80, 60, '#808080', 'b.png');
  await page.locator('.actions-list .action-row.action', { hasText: 'Dialogs' }).click();
  await startPlay(page);
  await page.waitForFunction(() => !window.photoStudio.busy || !!document.querySelector('dialog[open]'), null, { timeout: 60_000 });
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  await idle(page);
  expect(await docInfo(page)).toEqual(recorded);
  expect(await layerPixel(page, 10, 10)).toEqual(pixel);
});

test('a cancelled dialog is not recorded', async ({ page }) => {
  await openImage(page, 40, 30, '#808080', 'a.png');
  await newAction(page, 'Cancelled');
  for (const [id, title] of [['layer.new', 'New Layer'], ['image.canvas-size', 'Canvas Size'], ['image.image-size', 'Image Size'], ['adjust.levels', 'Levels']]) {
    await start(page, id);
    const d = page.locator('dialog[open]', { hasText: title });
    await d.getByRole('button', { name: 'Cancel' }).click();
    await idle(page);
  }
  await run(page, 'actions.stop');
  expect(await recordedSteps(page)).toEqual([]);
});
