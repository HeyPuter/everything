import { test, expect } from '@playwright/test';

// Fit page, actual size, and fit width are Ctrl/⌘ 0, 1, and 2. On a French (AZERTY) keyboard
// the digit keys type à, &, and é unless Shift is held, so the shortcuts are also known by the
// key's place, as the letter shortcuts are for layouts whose letters are not Latin.
const press = (page, key, code) =>
  page.evaluate(
    ([key, code]) =>
      document.querySelector('.workspace').dispatchEvent(
        new KeyboardEvent('keydown', {
          key,
          code,
          metaKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    [key, code],
  );

test('the zoom shortcuts work by the digit keys on an AZERTY keyboard', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'keyboard shortcuts');
  await page.route('https://js.puter.com/**', (route) => route.abort());
  await page.goto('/');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  const zoom = page.getByRole('combobox', { name: 'Zoom', exact: true });
  await page.keyboard.press('Meta+0');
  await expect(zoom).toHaveValue('page');
  // Each event is cancelled, so the browser does not also zoom the whole interface.
  expect(await press(page, '&', 'Digit1')).toBe(false);
  await expect(zoom).toHaveValue('1');
  expect(await press(page, 'é', 'Digit2')).toBe(false);
  await expect(zoom).toHaveValue('fit');
  expect(await press(page, 'à', 'Digit0')).toBe(false);
  await expect(zoom).toHaveValue('page');
});
