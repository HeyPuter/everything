// Dialog commands of the Timeline and layout features in recorded actions:
// the settings confirmed while recording are recorded with the step, and
// playback applies them without opening the dialog again.
import { test, expect, type Page } from '@playwright/test';
import { boot, idle, openImage, run, start } from './helpers';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.removeItem('photo-studio-actions'));
  await boot(page);
});

type Step = { command: string; arg?: { params?: Record<string, unknown> } };
const recordedSteps = (page: Page): Promise<Step[]> =>
  page.evaluate(
    () =>
      JSON.parse(localStorage.getItem('photo-studio-actions') ?? '[]')
        .flatMap((s: { actions: { steps: unknown[] }[] }) => s.actions)
        .at(-1)?.steps ?? [],
  );

async function newAction(page: Page, name: string) {
  await start(page, 'actions.new');
  const d = page.locator('dialog[open]', { hasText: 'New Action' });
  await d.getByLabel('Name').fill(name);
  await d.getByRole('button', { name: 'Record' }).click();
  await expect(page.locator('.actions-list .action-row.recording')).toHaveCount(1);
}
async function answer(page: Page, title: string, values: Record<string, string>, submit: string) {
  const d = page.locator('dialog[open]', { hasText: title });
  await expect(d).toBeVisible();
  for (const [label, value] of Object.entries(values)) {
    const field = d.getByLabel(label, { exact: true });
    if ((await field.evaluate((el) => el.tagName)) === 'SELECT') await field.selectOption(value);
    else await field.fill(value);
  }
  await d.getByRole('button', { name: submit, exact: true }).click();
  await idle(page);
}
/** Play the action chosen in the panel; fails if any dialog opens. */
async function playWithoutDialogs(page: Page, name: string) {
  await page.locator('.actions-list .action-row.action', { hasText: name }).click();
  await page.evaluate(() => void window.photoStudio.runCommand('actions.play'));
  await page.waitForFunction(
    () => !window.photoStudio.busy || !!document.querySelector('dialog[open]'),
    null,
    { timeout: 60_000 },
  );
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  await idle(page);
}

test('frame delay, looping and onion skin settings replay without dialogs', async ({ page }) => {
  const animate = async () => {
    await run(page, 'animation.create');
    await run(page, 'animation.new-frame');
  };
  const state = () =>
    page.evaluate(() => {
      const a = window.photoStudio.doc.animation!;
      return { delays: a.frames.map((f) => f.delay), loop: a.loop, onion: a.onion };
    });
  await openImage(page, 60, 40, '#808080', 'a.png');
  await animate();
  await newAction(page, 'Timing');
  await start(page, 'animation.delay-custom');
  await answer(page, 'Frame Delay', { 'Delay (seconds)': '0.35' }, 'OK');
  await start(page, 'animation.loop-custom');
  await answer(page, 'Looping', { 'Play the animation (times)': '4' }, 'OK');
  await start(page, 'animation.onion-settings');
  await answer(page, 'Onion Skins', { 'Frames before': '2', 'Opacity (%)': '40' }, 'OK');
  await run(page, 'actions.stop');
  const recorded = await state();
  expect(recorded).toMatchObject({
    delays: [100, 350],
    loop: 4,
    onion: { before: 2, opacity: 0.4 },
  });
  const steps = await recordedSteps(page);
  expect(steps.map((s) => s.command)).toEqual([
    'animation.delay-custom',
    'animation.loop-custom',
    'animation.onion-settings',
  ]);
  expect(steps[0].arg?.params).toMatchObject({ seconds: '0.35' });

  await openImage(page, 60, 40, '#808080', 'b.png');
  await animate();
  await playWithoutDialogs(page, 'Timing');
  expect(await state()).toEqual(recorded);
});

test('tween replays its settings without a dialog', async ({ page }) => {
  const prepare = async () => {
    await run(page, 'animation.create');
    await run(page, 'animation.new-frame');
    await page.evaluate(() =>
      window.photoStudio.command('Move', (d) => (d.layers[0].transform.x += 20)),
    );
    await idle(page);
  };
  const frames = () => page.evaluate(() => window.photoStudio.doc.animation!.frames.length);
  await openImage(page, 60, 40, '#808080', 'a.png');
  await prepare();
  await newAction(page, 'Tween');
  await start(page, 'animation.tween');
  await answer(page, 'Tween', { 'Frames to add': '3' }, 'Tween');
  await run(page, 'actions.stop');
  expect(await frames()).toBe(5);
  expect((await recordedSteps(page))[0].arg?.params).toMatchObject({
    count: '3',
    with: 'previous',
  });

  await openImage(page, 60, 40, '#808080', 'b.png');
  await prepare();
  await playWithoutDialogs(page, 'Tween');
  expect(await frames()).toBe(5);
});

test('new artboard replays its settings without a dialog', async ({ page }) => {
  const info = () =>
    page.evaluate(() => {
      const d = window.photoStudio.doc;
      return {
        artboards: d.layers
          .filter((l) => l.artboard)
          .map((l) => ({
            name: l.name,
            width: l.artboard!.rect.width,
            height: l.artboard!.rect.height,
          })),
      };
    });
  await openImage(page, 60, 40, '#808080', 'a.png');
  await newAction(page, 'Layout');
  await start(page, 'layer.new-artboard');
  await answer(
    page,
    'New Artboard',
    { Name: 'Cover', 'Width (px)': '120', 'Height (px)': '90' },
    'Create',
  );
  await run(page, 'actions.stop');
  const recorded = await info();
  expect(recorded.artboards).toEqual([{ name: 'Cover', width: 120, height: 90 }]);

  await openImage(page, 60, 40, '#808080', 'b.png');
  await playWithoutDialogs(page, 'Layout');
  expect(await info()).toEqual(recorded);
});
