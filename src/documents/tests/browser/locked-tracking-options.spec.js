import { test, expect } from '@playwright/test';

const engine = 'window.__docs.current.view.engine';
const review = page => page.locator('#ribbon-panel-review');
const revisions = page => page.evaluate(engine => { const m = eval(engine).model; return m.revisions.map(r => [r.type, m.text.slice(r.start, r.end)]); }, engine);

async function trackingOptions(page) {
  await review(page).locator('[aria-label="Tracking Options"]').evaluate(b => b.click());
  return page.getByRole('dialog', { name: 'Tracking Options' });
}
async function lockTracking(page) {
  await review(page).locator('[aria-label="Track Changes options"]').evaluate(b => b.click());
  await page.getByRole('menuitem', { name: 'Lock Tracking…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Lock Tracking' });
  await dialog.getByLabel('Password', { exact: true }).fill('lock');
  await dialog.getByLabel('Reenter password').fill('lock');
  await dialog.getByRole('button', { name: 'OK', exact: true }).click();
  await expect(review(page).getByRole('button', { name: 'Track Changes', exact: true })).toHaveAttribute('aria-pressed', 'true');
}

test('while tracking is locked, formatting changes are tracked even where the document turned formatting tracking off', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  const input = page.getByRole('textbox', { name: 'Document text' });
  await input.fill('Alpha beta gamma.');
  await page.getByRole('tab', { name: 'Review' }).click();
  // The author turns formatting tracking off, then locks tracking.
  let dialog = await trackingOptions(page);
  await dialog.getByRole('checkbox', { name: 'Track formatting' }).uncheck();
  await dialog.getByRole('button', { name: 'OK', exact: true }).click();
  await lockTracking(page);
  // Bold, made while tracking is locked, is a tracked change.
  await input.evaluate(el => { el.focus(); el.setSelectionRange(6, 10); el.dispatchEvent(new Event('select', { bubbles: true })); });
  await input.press('ControlOrMeta+b');
  await expect.poll(() => page.evaluate(engine => eval(engine).model.paragraphs[0].runs.some(r => r.bold), engine)).toBe(true);
  expect(await revisions(page)).toEqual([['format', 'beta']]);
  // Tracking Options cannot turn formatting tracking off while tracking is locked.
  dialog = await trackingOptions(page);
  const formatting = dialog.getByRole('checkbox', { name: 'Track formatting' });
  await expect(formatting).toBeChecked();
  await expect(formatting).toBeDisabled();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(errors).toEqual([]);
});
