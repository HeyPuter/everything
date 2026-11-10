import { test, expect } from '@playwright/test';

const engine = 'window.__docs.current.view.engine';
const input = page => page.getByRole('textbox', { name: 'Document text' });

// Under protection that allows only comments (or no changes, or filling in forms), Accept and Reject stayed
// available: choosing one only reported that the document is protected. They are unavailable, as Track Changes is.
test('Accept and Reject are unavailable while protection allows only comments, and come back when it stops', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await input(page).fill('Alpha beta gamma.');
  await page.evaluate(engine => { const e = eval(engine), m = e.model; e.execute(() => { m.trackChanges = true; m.select(6); m.replace('new '); m.trackChanges = false; }); }, engine);
  await page.getByRole('tab', { name: 'Review' }).click();
  const ribbon = page.locator('#ribbon-panel-review');
  const accept = ribbon.getByRole('button', { name: 'Accept', exact: true }), reject = ribbon.getByRole('button', { name: 'Reject', exact: true });
  const caretInChange = () => input(page).evaluate(el => { el.focus(); el.setSelectionRange(7, 7); el.dispatchEvent(new Event('select', { bubbles: true })); });
  await caretInChange();
  await expect(accept).toBeEnabled();
  await page.getByRole('button', { name: 'Restrict Editing' }).filter({ visible: true }).first().click();
  const pane = page.getByRole('complementary', { name: 'Restrict Editing pane' });
  await pane.getByRole('checkbox', { name: /Allow only this type/ }).check();
  await pane.getByRole('combobox', { name: 'Type of editing allowed' }).selectOption('comments');
  await pane.getByRole('button', { name: 'Yes, Start Enforcing Protection' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'OK' }).click();
  await caretInChange();
  await expect(accept).toBeDisabled();
  await expect(reject).toBeDisabled();
  await expect(ribbon.getByRole('button', { name: 'Accept options' })).toBeDisabled();
  expect(await page.evaluate(engine => eval(engine).session.body.revisions.length, engine)).toBe(1);
  // Stopping protection makes them available again.
  await pane.getByRole('button', { name: 'Stop Protection' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Stop Protection' }).click();
  await caretInChange();
  await expect(accept).toBeEnabled();
  await accept.click();
  await expect.poll(() => page.evaluate(engine => eval(engine).session.body.revisions.length, engine)).toBe(0);
  expect(errors).toEqual([]);
});
