import { test, expect } from '@playwright/test';

// Text dragged into the message, from outside it or from within it.

test('text dropped into the message lands where it is dropped', async ({ page }) => {
  await page.goto('/tests/browser/composer.html');
  await page.getByRole('button', { name: 'Compose', exact: true }).click();
  const body = page.getByRole('textbox', { name: 'Message body' });
  await body.fill('Hello world, this is the first line of the message');
  await body.press('ControlOrMeta+End');
  // A draggable source outside the app (which is inert under the dialog).
  await page.evaluate(() => {
    const p = document.createElement('p');
    p.id = 'src';
    p.draggable = true;
    p.textContent = 'DRAGGED';
    p.style.cssText = 'position:fixed;top:4px;left:4px;z-index:9999;background:yellow;padding:4px;margin:0';
    p.addEventListener('dragstart', (event) => event.dataTransfer.setData('text/plain', 'DRAGGED'));
    document.body.append(p);
  });
  await page.locator('#src').dragTo(body, { targetPosition: { x: 4, y: 10 } });
  const text = await body.innerText();
  expect(text.startsWith('DRAGGED')).toBe(true);
});

test('dragging a word to another place in the message moves it rather than copying it', async ({ page }) => {
  await page.goto('/tests/browser/composer.html');
  await page.getByRole('button', { name: 'Compose', exact: true }).click();
  const body = page.getByRole('textbox', { name: 'Message body' });
  await body.fill('alpha beta gamma');
  // Select "gamma" (the last five characters).
  await body.press('ControlOrMeta+End');
  for (let i = 0; i < 5; i++) await body.press('Shift+ArrowLeft');
  const rect = await page.evaluate(() => {
    const range = document.getSelection().getRangeAt(0).getBoundingClientRect();
    const box = document.querySelector('.rte-body').getBoundingClientRect();
    return { x: range.left + range.width / 2, y: range.top + range.height / 2, bx: box.left + 2, by: range.top + range.height / 2 };
  });
  await page.mouse.move(rect.x, rect.y);
  await page.mouse.down();
  await page.waitForTimeout(150);
  await page.mouse.move(rect.x - 20, rect.y, { steps: 5 });
  await page.mouse.move(rect.bx, rect.by, { steps: 10 });
  await page.mouse.up();
  const text = await body.innerText();
  expect(text.match(/gamma/g)).toHaveLength(1);
  expect(text.startsWith('gamma')).toBe(true);
});
