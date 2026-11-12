// Recording and replaying actions in the real workspace: every recorded step
// replays as it was recorded, without asking again unless its dialog toggle is on.
import { test, expect, type Page } from '@playwright/test';
import { boot, idle, layerPixel, openImage, run, start } from './helpers';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.removeItem('photo-studio-actions'));
  await boot(page);
});

const recordedSteps = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('photo-studio-actions') ?? '[]').flatMap((s: { actions: { steps: unknown[] }[] }) => s.actions).at(-1)?.steps);

async function newAction(page: Page, name = 'Test') {
  await start(page, 'actions.new');
  const d = page.locator('dialog[open]', { hasText: 'New Action' });
  await d.getByLabel('Name').fill(name);
  await d.getByRole('button', { name: 'Record' }).click();
  await expect(page.locator('.actions-list .action-row.recording')).toHaveCount(1);
}

/** Play the selected action; returns early when playback stops at a dialog. */
async function play(page: Page) {
  await page.evaluate(() => {
    const e = window.photoStudio;
    (window as unknown as { __played: Promise<void> }).__played = e.runCommand('actions.play');
  });
  await page.waitForFunction(() => !window.photoStudio.busy || !!document.querySelector('dialog[open]'), null, { timeout: 60_000 });
  if (!(await page.locator('dialog[open]').count())) await idle(page);
}

test('an adjustment confirmed in its dialog replays its settings without the dialog', async ({ page }) => {
  await openImage(page, 40, 30, '#808080', 'a.png');
  await newAction(page, 'Brighten');
  await start(page, 'adjust.brightness-contrast');
  const dialog = page.locator('dialog.adj-dialog[open]');
  await expect(dialog).toBeVisible();
  const num = dialog.getByRole('spinbutton', { name: 'Brightness value' });
  await num.fill('60');
  await num.press('Tab');
  await dialog.getByRole('button', { name: 'OK' }).click();
  await idle(page);
  await run(page, 'actions.stop');
  const recorded = await layerPixel(page, 5, 5);
  expect(recorded[0]).toBeGreaterThan(150);
  const steps = await recordedSteps(page);
  expect(steps).toHaveLength(1);
  expect(steps[0]).toMatchObject({ command: 'adjust.brightness-contrast', dialog: false, arg: { params: { brightness: 60 } } });

  await openImage(page, 40, 30, '#808080', 'b.png');
  await play(page);
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  expect(await layerPixel(page, 5, 5)).toEqual(recorded);
});
