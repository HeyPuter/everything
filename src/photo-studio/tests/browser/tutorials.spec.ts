// Help → Hands-on Tutorials, What's New and the start screen's Learn area.
import { test, expect, type Page } from '@playwright/test';
import { boot, canvasClick, canvasDrag, idle, menu, openImage, tool } from './helpers';

const card = (page: Page) => page.locator('.tour-card');

async function ringAround(page: Page, selector: string) {
  return page.evaluate((selector) => {
    const ring = document.querySelector<HTMLElement>('.tour-ring')!;
    const target = [...document.querySelectorAll<HTMLElement>(selector)].find((el) => el.getClientRects().length)!;
    const a = ring.getBoundingClientRect(),
      b = target.getBoundingClientRect();
    return !ring.hidden && a.left <= b.left && a.top <= b.top && a.right >= b.right && a.bottom >= b.bottom && a.width < b.width + 20;
  }, selector);
}

test('a tutorial advances when the user performs each step', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await boot(page);
  await menu(page, 'Help', 'Hands-on Tutorials');
  const chooser = page.locator('dialog.tutorials-window');
  await expect(chooser).toBeVisible();
  await expect(chooser.locator('.tutorial-tile')).toHaveCount(6);
  await chooser.getByRole('button', { name: /Layers basics/ }).click();
  await expect(chooser).toHaveCount(0);

  // The sample document opens and the first (reading) step is shown.
  await expect(card(page)).toContainText('Step 1 of 7');
  await expect.poll(() => page.evaluate(() => window.photoStudio.doc.name)).toBe('Meadow');
  await expect(card(page).getByRole('button', { name: 'Back' })).toBeDisabled();
  await card(page).getByRole('button', { name: 'Next' }).click();

  // Step 2 points at the New Layer button and finishes when it is clicked.
  await expect(card(page)).toContainText('Add an empty layer');
  await expect.poll(() => ringAround(page, '[data-command="layer.new-quick"]')).toBe(true);
  await page.locator('[data-panel="layers"] [data-command="layer.new-quick"]').click();
  await expect(card(page)).toContainText('Done');
  await expect(card(page)).toContainText('Step 3 of 7');

  // Step 3: choosing the Brush tool finishes it.
  await tool(page, 'Brush Tool');
  await expect(card(page)).toContainText('Step 4 of 7');

  // Step 4: painting on the new layer.
  await idle(page);
  await canvasDrag(page, [[200, 120], [400, 160], [600, 120]]);
  await expect(card(page)).toContainText('Step 5 of 7');

  // Back returns to the painting step; Skip moves on without doing it.
  await card(page).getByRole('button', { name: 'Back' }).click();
  await expect(card(page)).toContainText('Step 4 of 7');
  await card(page).getByRole('button', { name: 'Skip step' }).click();
  await expect(card(page)).toContainText('Step 5 of 7');

  // Restart opens a fresh sample and goes back to the first step.
  const docs = await page.evaluate(() => window.photoStudio.sessions.length);
  await card(page).getByRole('button', { name: 'Restart' }).click();
  await expect(card(page)).toContainText('Step 1 of 7');
  await expect.poll(() => page.evaluate(() => window.photoStudio.sessions.length)).toBe(docs + 1);

  // The card fits the 1280 × 720 window.
  const box = (await card(page).boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(720);
  expect(box.x + box.width).toBeLessThanOrEqual(1280);

  await card(page).getByRole('button', { name: 'Close tutorial' }).click();
  await expect(card(page)).toHaveCount(0);
  await expect(page.locator('.tour-ring')).toHaveCount(0);
});

test('steps finish only for the real action in the tutorial document', async ({ page }) => {
  await boot(page);
  await page.evaluate(async () => (await import('/src/features/help/windows.ts')).beginTutorial(window.photoStudio, 'layers'));
  await expect(card(page)).toContainText('Step 1 of 7');
  await card(page).getByRole('button', { name: 'Next' }).click();
  await expect(card(page)).toContainText('Add an empty layer');
  // Long enough for the poll (250 ms) and the done delay (700 ms) to have acted.
  const settle = () => page.waitForTimeout(1500);

  // Another document with more layers is not the tutorial's layer added.
  await openImage(page, 300, 200, '#405060', 'other.png');
  await page.evaluate(async () => {
    const { layer } = await import('/src/model/document.ts');
    window.photoStudio.command('Add layers', (d) => void d.layers.push(layer('pixel', 'A', 300, 200), layer('pixel', 'B', 300, 200)));
  });
  await settle();
  await expect(card(page)).toContainText('Step 2 of 7');
  // Back in the sample, adding a layer finishes the step.
  await page.evaluate(() => {
    const e = window.photoStudio;
    e.session = e.sessions.find((s) => s.history.document.name === 'Meadow')!;
    e.update();
  });
  await idle(page);
  await settle();
  await expect(card(page)).toContainText('Step 2 of 7');
  await page.locator('[data-panel="layers"] [data-command="layer.new-quick"]').click();
  await expect(card(page)).toContainText('Step 3 of 7');
  await tool(page, 'Brush Tool');
  await expect(card(page)).toContainText('Step 4 of 7');

  // Renaming the new layer or changing its blend mode is not painting on it.
  await page.evaluate(() => {
    const e = window.photoStudio;
    const id = e.selected;
    e.command('Rename Layer', (d) => void (d.layers.find((l) => l.id === id)!.name = 'Sky strokes'));
    e.command('Blend Mode', (d) => void (d.layers.find((l) => l.id === id)!.blend = 'multiply'));
  });
  await settle();
  await expect(card(page)).toContainText('Step 4 of 7');
  // Painting in another document does not count either.
  await page.evaluate(() => {
    const e = window.photoStudio;
    e.session = e.sessions.find((s) => s.history.document.name !== 'Meadow')!;
    e.update();
  });
  await idle(page);
  await canvasDrag(page, [[50, 50], [200, 120]]);
  await settle();
  await expect(card(page)).toContainText('Step 4 of 7');
  await page.evaluate(() => {
    const e = window.photoStudio;
    e.session = e.sessions.find((s) => s.history.document.name === 'Meadow')!;
    e.update();
  });
  await idle(page);
  await settle();
  await expect(card(page)).toContainText('Step 4 of 7');
  // Painting on the new layer finishes it.
  await canvasDrag(page, [[200, 120], [400, 160], [600, 120]]);
  await expect(card(page)).toContainText('Step 5 of 7');
});

test('an export step finishes when the command runs', async ({ page }) => {
  await boot(page);
  await page.evaluate(async () => (await import('/src/features/help/windows.ts')).beginTutorial(window.photoStudio, 'exporting'));
  await expect(card(page)).toContainText('Step 1 of 4');
  await card(page).getByRole('button', { name: 'Next' }).click();
  await expect(card(page)).toContainText('Export a copy');
  await expect.poll(() => ringAround(page, '.export-button')).toBe(true);
  await page.locator('.export-button').click();
  // Whether the user exports or cancels the window, the step is done once it closes.
  const exportWindow = page.locator('dialog[open]');
  await expect(exportWindow).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(card(page)).toContainText('Step 3 of 4');
});

test("What's New lists features and Try it runs one", async ({ page }) => {
  await boot(page);
  await menu(page, 'Help', 'What’s New');
  const win = page.locator('dialog.whats-new-window');
  await expect(win).toBeVisible();
  await expect(win.locator('.whats-new-item').first()).toBeVisible();
  // Every Try it button refers to something registered.
  const dead = await page.evaluate(async () => {
    const { findCommand } = await import('/src/app/registry.ts');
    const { WHATS_NEW } = await import('/src/features/help/whats-new-data.ts');
    const shown = [...document.querySelectorAll<HTMLElement>('[data-try]')].map((b) => b.dataset.try);
    return WHATS_NEW.filter((w) => shown.includes(w.id) && w.action && 'commands' in w.action && !w.action.commands.some((c) => findCommand(c))).map((w) => w.id);
  });
  expect(dead).toEqual([]);
  await win.getByRole('button', { name: 'Try Pattern Preview' }).click();
  await expect(win).toHaveCount(0);
  // A sample opens (there was no document) and the feature is turned on.
  await expect.poll(() => page.evaluate(() => window.photoStudio.hasDocument)).toBe(true);
  await expect
    .poll(() => page.evaluate(async () => (await import('/src/app/registry.ts')).commands.get('view.pattern-preview')!.checked!(window.photoStudio)))
    .toBe(true);
});

test('the start screen offers tutorials without overflowing', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await boot(page);
  const learn = page.locator('#empty .start-learn');
  await expect(learn).toBeVisible();
  await expect(learn.locator('[data-learn]')).toHaveCount(6);
  await expect(learn.locator('[data-learn-thumb] img').first()).toBeVisible();
  const overflow = await page.evaluate(() => {
    const host = document.querySelector<HTMLElement>('#empty')!;
    return host.scrollWidth > host.clientWidth + 1 || document.documentElement.scrollWidth > window.innerWidth;
  });
  expect(overflow).toBe(false);
  await learn.getByRole('button', { name: /Retouching a blemish/ }).click();
  await expect(card(page)).toContainText('Step 1 of 5');
  await expect.poll(() => page.evaluate(() => window.photoStudio.doc.name)).toBe('Skin Close-up');
});

test('the other tutorials complete with real actions', async ({ page }) => {
  test.setTimeout(240_000);
  await boot(page);
  const begin = (id: string) => page.evaluate(async (id) => (await import('/src/features/help/windows.ts')).beginTutorial(window.photoStudio, id), id);
  const next = () => card(page).getByRole('button', { name: /^(Next|Finish)$/ }).click();
  const at = (n: number, of: number) => expect(card(page)).toContainText(`Step ${n} of ${of}`);
  const command = (id: string) => page.evaluate((id) => window.photoStudio.runCommand(id), id);

  // Masking: select the subject, add a mask, paint on it.
  await begin('masking');
  await at(1, 6);
  await next();
  await command('select.subject');
  await at(3, 6);
  await page.locator('[data-panel="layers"] [data-command="layer.add-mask"]').click();
  await at(4, 6);
  await tool(page, 'Brush Tool');
  await at(5, 6);
  await idle(page);
  await page.evaluate(() => window.photoStudio.setForeground('#000000'));
  await canvasDrag(page, [[400, 330], [560, 340]]);
  await at(6, 6);
  await next();
  await expect(card(page)).toContainText('Tutorial complete');

  // Adjustment layers: add one, change it, hide it and show it again.
  await begin('adjustments');
  await next();
  await page.locator('[data-layer-adjust]').click();
  await page.getByRole('menuitem', { name: 'Levels', exact: true }).click();
  await at(3, 5);
  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    const e = window.photoStudio;
    e.editLayer('Levels', (l) => (l.adjustment = { ...l.adjustment!, params: { ...l.adjustment!.params, inBlack: 30 } }));
  });
  await at(4, 5);
  await page.locator('#layers [data-visibility]').first().click();
  await at(5, 5);
  await page.locator('#layers [data-visibility]').first().click();
  await expect(card(page)).toContainText('Tutorial complete');

  // Retouching: zoom in, choose the tool, heal a spot.
  await begin('retouch');
  await next();
  await command('view.zoom-in');
  await at(3, 5);
  await tool(page, 'Spot Healing Brush Tool');
  await at(4, 5);
  const { SKIN_SPOTS } = await import('../../src/features/help/samples');
  const [u, v] = SKIN_SPOTS[0];
  await canvasClick(page, u * 960, v * 640);
  await at(5, 5);

  // Text and shapes: type a title, draw a rectangle, add a shadow.
  await begin('text-shapes');
  await next();
  await tool(page, 'Horizontal Type Tool');
  await at(3, 7);
  await canvasClick(page, 100, 120);
  await page.keyboard.type('Hello');
  await page.keyboard.press('Escape');
  await at(4, 7);
  await tool(page, 'Rectangle Tool');
  await at(5, 7);
  await canvasDrag(page, [[300, 300], [600, 450]]);
  await at(6, 7);
  await page.evaluate(() => void window.photoStudio.runCommand('layer.style-drop-shadow'));
  await page.locator('dialog[open]').getByRole('button', { name: 'OK', exact: true }).click();
  await at(7, 7);
});
