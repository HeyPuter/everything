import { test, expect } from '@playwright/test';
import { menuBarMenu } from './helpers/editor-tools.js';

const engine = 'window.__docs.current.view.engine';
/** A three-page document with a comment near the top of its first page. */
async function commented(page, width, height) {
  await page.setViewportSize({ width, height });
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await page.getByRole('textbox', { name: 'Document text' }).fill(Array.from({ length: 70 }, (_, i) => `Paragraph ${i} has some words that wrap around the line because it is fairly long text.`).join('\n'));
  await page.evaluate(engine => { const e = eval(engine); e.model.addComment({ author: 'Ada', text: 'A note on the first page', range: [10, 18] }); e.model.select(0); e.relayout(); e.onChange(); }, engine);
  await expect(page.locator('.ed-comment-card')).toHaveCount(1);
}
/** The card's box, the visible part of the pages' scroller, and the pages it covers. */
const geometry = page => page.evaluate(() => {
  const card = document.querySelector('.ed-comment-card').getBoundingClientRect(), host = document.querySelector('.canvas-host'), view = host.getBoundingClientRect();
  const covered = [...document.querySelectorAll('.canvas-pages > canvas')].map(c => c.getBoundingClientRect()).filter(r => r.left < card.right && card.left < r.right && r.top < card.bottom && card.top < r.bottom).length;
  return { card: [card.left, card.right], view: [view.left, view.left + host.clientWidth], covered, overflow: host.scrollWidth - host.clientWidth };
});
async function expectBeside(page) {
  await expect.poll(async () => { const g = await geometry(page); return g.card[0] >= g.view[0] && g.card[1] <= g.view[1] && g.covered === 0; }, { message: JSON.stringify(await geometry(page)) }).toBe(true);
}

for (const [width, height, columns] of [[1280, 800, 1], [2000, 1000, 2]]) {
  test(`in Read Mode with ${columns} reading column${columns > 1 ? 's' : ''} a comment card sits beside the pages, in view`, async ({ page }) => {
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await commented(page, width, height);
    await page.getByRole('button', { name: 'Read Mode', exact: true }).last().click();
    await expect(page.locator('.read-counter')).toHaveText(columns > 1 ? /^Pages 1–2 of/ : /^Page 1 of/);
    await expectBeside(page);
    expect(errors).toEqual([]);
  });
}

test('in Side to Side a comment card sits beside its page without covering the next one', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await commented(page, 1280, 800);
  await (await menuBarMenu(page, 'View')).getByRole('menuitem', { name: 'Page Movement' }).click();
  await page.getByRole('menuitemradio', { name: 'Side to Side' }).click();
  await expect(page.locator('.canvas-host')).toHaveClass(/is-side-to-side/);
  await expectBeside(page);
  expect(errors).toEqual([]);
});

test('in Web Layout the text leaves room for the comment cards', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await commented(page, 1280, 800);
  await page.getByRole('button', { name: 'Web Layout', exact: true }).last().click();
  await expect(page.locator('.canvas-host')).toHaveClass(/view-web/);
  await expectBeside(page);
  expect((await geometry(page)).overflow).toBeLessThanOrEqual(0);
  expect(errors).toEqual([]);
});

for (const [width, pane] of [[1100, false], [1440, true]]) {
  test(`at ${width} pixels${pane ? ' with a side pane open' : ''} the comment column fits the window`, async ({ page }) => {
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await commented(page, width, 800);
    if (pane) {
      await page.getByRole('tab', { name: 'Review' }).click();
      await page.locator('#ribbon-panel-review').getByRole('button', { name: 'Restrict Editing', exact: true }).click();
      await expect(page.getByRole('complementary', { name: 'Restrict Editing pane' })).toBeVisible();
    }
    await expectBeside(page);
    expect((await geometry(page)).overflow).toBeLessThanOrEqual(0);
    expect(errors).toEqual([]);
  });
}
