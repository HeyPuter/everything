// Help → Hands-on Tutorials, What's New and the start screen's Learn area.
import { test, expect, type Page } from '@playwright/test';
import { boot, canvasDrag, idle, menu, tool } from './helpers';

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
