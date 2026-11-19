// Transitions, Interpret Footage and Slice Options in recorded actions: the
// settings confirmed while recording are recorded with the step, playback
// applies them without opening the dialog again, a step with its dialog on
// opens it showing them, and cancelling that dialog stops the action.
import { test, expect, type Page } from '@playwright/test';
import { boot, canvasDrag, idle, openImage, run, start, tool } from './helpers';

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
/** Fill a dialog's controls by name and confirm it. */
async function answer(page: Page, title: string, values: Record<string, string | boolean>) {
  const d = page.locator('dialog[open]', { hasText: title });
  await expect(d).toBeVisible();
  for (const [name, value] of Object.entries(values)) {
    const field = d.locator(`[name="${name}"]`);
    if (typeof value === 'boolean') await field.setChecked(value);
    else if ((await field.evaluate((el) => el.tagName)) === 'SELECT')
      await field.selectOption(value);
    else await field.fill(value);
  }
  await d.getByRole('button', { name: 'OK', exact: true }).click();
  await idle(page);
}
async function play(page: Page, name: string) {
  await page.locator('.actions-list .action-row.action', { hasText: name }).click();
  await page.evaluate(() => void window.photoStudio.runCommand('actions.play'));
  await page.waitForFunction(
    () => !window.photoStudio.busy || !!document.querySelector('dialog[open]'),
    null,
    { timeout: 60_000 },
  );
}
/** Play the action chosen in the panel; fails if any dialog opens. */
async function playWithoutDialogs(page: Page, name: string) {
  await play(page, name);
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  await idle(page);
}

test('transitions and interpret footage replay their settings without dialogs', async ({
  page,
}) => {
  const prepare = async (name: string) => {
    await openImage(page, 60, 40, '#808080', name);
    await run(page, 'timeline.create');
    await run(page, 'layer.video-new-blank');
  };
  const state = () =>
    page.evaluate(() => {
      const e = window.photoStudio;
      const l = e.layer as unknown as { video: { fps: number; alpha: string; loops: number } };
      const clip = e.doc.timeline!.clips[e.selected];
      return {
        fadeIn: clip?.fadeIn,
        fadeOut: clip?.fadeOut,
        video: { fps: l.video.fps, alpha: l.video.alpha, loops: l.video.loops },
      };
    });
  await prepare('a.png');
  await newAction(page, 'Footage');
  await start(page, 'timeline.transitions');
  await answer(page, 'Transitions', {
    in: 'fade-color',
    inSeconds: '0.5',
    out: 'fade',
    outSeconds: '1',
    color: '#336699',
  });
  await start(page, 'layer.video-interpret');
  await answer(page, 'Interpret Footage', { fps: '12', alpha: 'ignore', loops: '3' });
  await run(page, 'actions.stop');
  const recorded = await state();
  expect(recorded.fadeIn).toMatchObject({ kind: 'fade-color', color: '#336699' });
  expect(recorded.fadeOut).toMatchObject({ kind: 'fade' });
  expect(recorded.video).toEqual({ fps: 12, alpha: 'ignore', loops: 3 });
  const steps = await recordedSteps(page);
  expect(steps.map((s) => s.command)).toEqual(['timeline.transitions', 'layer.video-interpret']);
  expect(steps[0].arg?.params).toMatchObject({ in: 'fade-color', out: 'fade', color: '#336699' });
  expect(steps[1].arg?.params).toMatchObject({ fps: '12', alpha: 'ignore', forever: 'no' });

  await prepare('b.png');
  await playWithoutDialogs(page, 'Footage');
  expect(await state()).toEqual(recorded);
});

test('slice options replay without a dialog; with the dialog on it shows them, and Cancel stops', async ({
  page,
}) => {
  const prepare = async (name: string) => {
    await openImage(page, 300, 200, '#808080', name);
    await page.evaluate(() =>
      window.photoStudio.command(
        'Guides',
        (d) => (d.guides = [{ orientation: 'vertical', position: 150 }]),
      ),
    );
    await run(page, 'slices.from-guides');
    await tool(page, 'Slice Select Tool');
    await canvasDrag(page, [
      [50, 50],
      [50, 50],
    ]);
    await idle(page);
  };
  const slices = () =>
    page.evaluate(() =>
      window.photoStudio.doc.slices!.map(({ name, format, quality }) => ({
        name,
        format,
        quality,
      })),
    );
  await prepare('a.png');
  await newAction(page, 'Slices');
  await start(page, 'slices.options');
  await answer(page, 'Slice Options', { name: 'hero', format: 'jpeg', quality: '55' });
  await run(page, 'actions.stop');
  const recorded = await slices();
  expect(recorded[0]).toEqual({ name: 'hero', format: 'jpeg', quality: 55 });
  const steps = await recordedSteps(page);
  expect(steps.map((s) => s.command)).toEqual(['slices.options']);
  expect(steps[0].arg?.params).toMatchObject({ name: 'hero', format: 'jpeg', quality: '55' });

  await prepare('b.png');
  await playWithoutDialogs(page, 'Slices');
  expect(await slices()).toEqual(recorded);

  // With the step's dialog on, the dialog shows the recorded settings;
  // cancelling it stops the action and changes nothing.
  await page
    .locator('.actions-list .action-row.step')
    .first()
    .getByRole('button', { name: 'Toggle dialog' })
    .click();
  await prepare('c.png');
  await play(page, 'Slices');
  const d = page.locator('dialog[open]', { hasText: 'Slice Options' });
  await expect(d).toBeVisible();
  await expect(d.locator('[name=name]')).toHaveValue('hero');
  await expect(d.locator('[name=format]')).toHaveValue('jpeg');
  await expect(d.locator('[name=quality]')).toHaveValue('55');
  await d.getByRole('button', { name: 'Cancel' }).click();
  await idle(page);
  expect((await slices())[0]).toEqual({ name: undefined, format: undefined, quality: undefined });
  expect(await page.evaluate(() => window.photoStudio.busy)).toBe(false);
});
