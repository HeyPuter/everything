import { test, expect } from '@playwright/test';
import { onTab } from './helpers/editor-tools.js';

const input = page => page.getByRole('textbox', { name: 'Document text' });
const ribbon = page => page.locator('#ribbon-panel-references');
const engineText = page => page.evaluate(() => window.__docs.current.view.engine.session.body.text);

test('a caption that would renumber others under Lock Tracking is refused with a plain reason', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await input(page).fill('Top\nChart one');
  await onTab(page, 'references');
  await ribbon(page).getByRole('button', { name: 'Insert Caption', exact: true }).click();
  let caption = page.getByRole('dialog', { name: 'Caption' });
  await caption.getByLabel('Caption text').fill('Revenue');
  await caption.getByRole('button', { name: 'OK', exact: true }).click();
  await expect.poll(() => engineText(page)).toBe('Top\nChart one\nFigure 1: Revenue');
  await onTab(page, 'review');
  await page.locator('#ribbon-panel-review [aria-label="Track Changes options"]').evaluate(b => b.click());
  await page.getByRole('menuitem', { name: 'Lock Tracking…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Lock Tracking' });
  await dialog.getByRole('button', { name: 'OK', exact: true }).click();
  await expect(dialog).toBeHidden();
  await input(page).evaluate(el => { el.focus(); el.setSelectionRange(3, 3); el.dispatchEvent(new Event('select')); });
  await onTab(page, 'references');
  await ribbon(page).getByRole('button', { name: 'Insert Caption', exact: true }).click();
  caption = page.getByRole('dialog', { name: 'Caption' });
  await caption.getByLabel('Caption text').fill('Costs');
  await caption.getByRole('button', { name: 'OK', exact: true }).click();
  // Renumbering the caption below cannot be tracked: the refusal says so instead of asking to turn tracking on.
  await expect(page.getByText('This change can’t be tracked, and tracking is locked. Unlock tracking to make it.')).toBeVisible();
  await expect(page.getByText(/Turn tracking back on/)).toHaveCount(0);
  expect(await engineText(page)).toBe('Top\nChart one\nFigure 1: Revenue');
  expect(errors).toEqual([]);
});
