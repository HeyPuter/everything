import { test, expect } from '@playwright/test';

const text = page => page.getByRole('textbox', { name: 'Document text', exact: true });
const model = page => page.evaluate(() => window.__docs.current.view.engine.model.text);

test('a click between ribbon controls, beside the tabs or on the status bar leaves typing in the document', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await text(page).focus();
  await page.keyboard.type('Text');
  const empty = async (container, label) => {
    // A point inside the container that hits it (or a group's own space), not a control.
    const point = await page.locator(container).first().evaluate(node => {
      const box = node.getBoundingClientRect();
      for (let y = box.top + 2; y < box.bottom - 2; y += 4) for (let x = box.right - 4; x > box.left + 2; x -= 6) {
        const hit = document.elementFromPoint(x, y);
        if (hit && node.contains(hit) && !hit.closest('button, input, select, textarea, label, a, [tabindex], [role=button], [role=option], [role=tab], [role=menu]')) return { x, y };
      }
      return null;
    });
    expect(point, label).not.toBeNull();
    return point;
  };
  let typed = 'Text';
  for (const [container, label] of [['.ribbon-card', 'ribbon'], ['.ribbon-tabs', 'tab row'], ['.ed-statusbar', 'status bar']]) {
    const { x, y } = await empty(container, label);
    await page.mouse.click(x, y);
    await expect(text(page), label).toBeFocused();
    await page.keyboard.type('!'); typed += '!';
    expect(await model(page), label).toBe(typed);
  }
  // The zoom steps change the zoom and leave the keyboard where it was.
  await page.getByRole('button', { name: 'Zoom In', exact: true }).click();
  await expect(text(page)).toBeFocused();
  await page.getByRole('button', { name: 'Zoom Out', exact: true }).click();
  await expect(text(page)).toBeFocused();
  // The status bar's menu, opened with a right-click on its text-mode label, hands the keyboard back to the text.
  await page.locator('.ed-statusbar .canvas-text-mode').click({ button: 'right' });
  const menu = page.getByRole('menu', { name: 'Customize Status Bar' });
  await expect(menu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(text(page)).toBeFocused();
  await page.keyboard.type('?');
  expect(await model(page)).toBe(`${typed}?`);
  // Fields still take the focus they are clicked for.
  await page.getByRole('spinbutton', { name: 'Font size (pt)', exact: true }).click();
  await expect(page.getByRole('spinbutton', { name: 'Font size (pt)', exact: true })).toBeFocused();
});
