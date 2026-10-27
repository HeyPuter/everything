import { test, expect } from '@playwright/test';

const input = page => page.getByRole('textbox', { name: 'Document text' });
const engine = 'window.__docs.current.view.engine';
const select = (field, at) => field.evaluate((el, at) => { el.setSelectionRange(at, at); el.dispatchEvent(new Event('select', { bubbles: true })); }, at);

// Typing in a tracked change changes what one Reviewing Pane entry shows. The pane rebuilt every entry at each
// keystroke, which made typing slow with the pane open in a much-reviewed document. Only the entries that changed
// are built again now, and the list is the one a rebuild would show.
test('typing in a tracked change with the Reviewing Pane open rebuilds only its entry, and the list is as a rebuild shows it', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await input(page).fill(Array.from({ length: 80 }, (_, i) => `Paragraph ${i} has some words.`).join('\n'));
  // A tracked insertion in every paragraph, a deletion in every third, and comments.
  await page.evaluate(engine => {
    const e = eval(engine), m = e.model;
    e.execute(() => {
      m.trackChanges = true;
      for (let i = 79; i >= 0; i--) {
        const at = m.text.indexOf(`Paragraph ${i} `);
        if (i % 3 === 0) { m.select(at + 13, at + 18); m.replace(''); }
        m.select(at + 10); m.replace(`added${i} `);
      }
      m.trackChanges = false;
    });
    for (const i of [4, 30, 60]) { const at = m.text.indexOf(`Paragraph ${i} `); m.addComment({ author: 'Bo', text: `Note ${i}`, range: [at, at + 9] }); }
    e.relayout(); e.onChange();
  }, engine);
  await page.getByRole('tab', { name: 'Review' }).click();
  await page.getByRole('button', { name: 'Reviewing Pane', exact: true }).filter({ visible: true }).first().click();
  const pane = page.getByRole('complementary', { name: 'Reviewing Pane' }), list = pane.locator('.review-pane-list'), items = pane.locator('.review-pane-item');
  await expect(items).toHaveCount(80 + 27 + 3);
  // Mark every entry, and scroll the list to its middle.
  await list.evaluate(node => { for (const [i, item] of [...node.children].entries()) item.dataset.probe = String(i); node.scrollTop = node.scrollHeight / 2; });
  const scroll = await list.evaluate(node => node.scrollTop);
  expect(scroll).toBeGreaterThan(200);
  // Track Changes on, typing on at the end of the insertion in paragraph 2: well above the entries in view.
  await input(page).focus();
  await input(page).press('ControlOrMeta+Shift+e');
  await expect.poll(() => page.evaluate(engine => !!eval(engine).model.trackChanges, engine)).toBe(true);
  const at = await page.evaluate(engine => eval(engine).model.text.indexOf('added2 ') + 7, engine);
  await select(input(page), at);
  await page.keyboard.type('and these words make the entry long enough to wrap onto its second line');
  await expect(items.filter({ hasText: 'second line' })).toHaveCount(1);
  await page.waitForTimeout(200);
  const marked = await list.evaluate(node => [...node.children].map(item => item.dataset.probe ?? null));
  const changed = marked.map((probe, i) => [probe, i]).filter(([probe]) => probe === null).map(([, i]) => i);
  // Only the typed change's entry was built again; the list stayed where it was scrolled.
  expect(changed).toHaveLength(1);
  expect(await items.nth(changed[0]).textContent()).toContain('added2 and these words');
  expect(await list.evaluate(node => node.scrollTop)).toBe(scroll);
  // A keystroke that starts a new change adds its entry where it belongs.
  const before = await page.evaluate(engine => eval(engine).model.text.indexOf('Paragraph 50 '), engine);
  await select(input(page), before);
  await page.keyboard.type('Z');
  await expect(items).toHaveCount(80 + 27 + 3 + 1);
  await page.waitForTimeout(200);
  // The list is exactly what a rebuild of the pane shows.
  const shown = await list.evaluate(node => node.innerHTML.replace(/ data-probe="\d+"/g, ''));
  const summary = await pane.locator('.review-pane-summary').textContent();
  // Choosing an entry after the new one selects its own change.
  const entry = items.filter({ hasText: 'added51' });
  await entry.click();
  await expect.poll(() => page.evaluate(engine => { const m = eval(engine).model; return m.text.slice(...m.range); }, engine)).toBe('added51 ');
  const reviewing = page.getByRole('button', { name: 'Reviewing Pane', exact: true }).filter({ visible: true }).first();
  await reviewing.click(); await reviewing.click();
  await expect(items).toHaveCount(80 + 27 + 3 + 1);
  expect(await list.evaluate(node => node.innerHTML)).toBe(shown);
  expect(await pane.locator('.review-pane-summary').textContent()).toBe(summary);
  expect(errors).toEqual([]);
});
