import { test, expect } from '@playwright/test';

const text = page => page.getByRole('textbox', { name: 'Document text' });
async function select(page, start, end) {
  await text(page).evaluate((el, [a, b]) => { el.focus(); el.setSelectionRange(a, b); el.dispatchEvent(new Event('select')); }, [start, end]);
}

test('the status bar word count follows typing, selection, undo and same-length edits', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  const count = page.locator('.ed-statusbar .ed-word-count');
  await text(page).fill('one two three');
  await expect(count).toHaveText('3 words');
  await select(page, 0, 7);
  await expect(count).toHaveText('2 of 3 words');
  await select(page, 4, 13);
  await expect(count).toHaveText('2 of 3 words');
  await select(page, 0, 3);
  await expect(count).toHaveText('1 of 3 words');
  await select(page, 13, 13);
  await expect(count).toHaveText('3 words');
  // A space typed over a letter keeps the length but adds a word, inside and outside a selection.
  await select(page, 1, 2);
  await page.keyboard.type(' ');
  await expect(count).toHaveText('4 words');
  await select(page, 0, 13);
  await expect(count).toHaveText('4 of 4 words');
  await select(page, 13, 13);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  // Undo selects the letter it brings back.
  await expect(count).toHaveText('1 of 3 words');
  await select(page, 13, 13);
  await expect(count).toHaveText('3 words');
  await page.keyboard.type(' four');
  await expect(count).toHaveText('4 words');
  await page.keyboard.press('Shift+Home');
  await expect(count).toHaveText('4 of 4 words');
});

test('the status bar counts the words of Thai text written without spaces', async ({ page }) => {
  await page.goto('/playground.html');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  const count = page.locator('.ed-statusbar .ed-word-count');
  await text(page).fill('ฉันไปโรงเรียนทุกวันเพราะอยากเรียนรู้');
  await expect(count).toHaveText('9 words');
  await select(page, 0, 13);
  await expect(count).toHaveText('3 of 9 words');
  await text(page).fill('ฉัน ไป โรงเรียน ทุก วัน');
  await expect(count).toHaveText('5 words');
});

test('at 320 pixels wide the status bar shows the whole word count instead of cutting it off', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto('/mock.html#/new');
  await page.locator('.ribbon-card').waitFor();
  await text(page).focus();
  await page.keyboard.insertText('word '.repeat(1234));
  const count = page.locator('.ed-word-count');
  await expect(count).toHaveText('1234 words');
  // Every status bar control is whole and inside the window, and none covers another.
  const problems = await page.locator('.ed-statusbar').evaluate(bar => {
    // A field inside its label counts as the label.
    const controls = [...bar.querySelectorAll('button, label, select')].filter(n => n.getClientRects().length && n.getBoundingClientRect().width > 0 && !(n.matches('select') && n.closest('label')));
    const out = [];
    for (const n of controls) {
      const r = n.getBoundingClientRect();
      if (n.scrollWidth > n.clientWidth + 1) out.push(`${n.textContent.trim()} is cut off`);
      for (let a = n.parentElement; a && a !== bar.parentElement; a = a.parentElement) {
        const box = a.getBoundingClientRect();
        if (getComputedStyle(a).overflowX !== 'visible' && (r.right > box.right + 1 || r.left < box.left - 1)) out.push(`${n.textContent.trim()} is clipped`);
      }
      if (r.right > innerWidth || r.left < 0) out.push(`${n.textContent.trim()} is outside the window`);
      for (const m of controls) {
        if (m === n || m.contains(n) || n.contains(m)) continue;
        const q = m.getBoundingClientRect();
        if (Math.min(r.right, q.right) - Math.max(r.left, q.left) > 1 && Math.min(r.bottom, q.bottom) - Math.max(r.top, q.top) > 1) out.push(`${n.textContent.trim()} overlaps ${m.textContent.trim()}`);
      }
    }
    return [...new Set(out)];
  });
  expect(problems).toEqual([]);
});
