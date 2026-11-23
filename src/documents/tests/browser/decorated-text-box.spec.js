import { test, expect } from '@playwright/test';

// A text box with a link, underlines, strikethrough, highlight and shading opens editable and shows them
// as body text does (it opened read-only). Fixture: tools/decorated_text_box_fixture.py.
test('a text box with a link and decorated text opens editable and paints highlight, shading and underlines', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/playground.html');
  const input = page.getByRole('textbox', { name: 'Document text' }), previous = await input.elementHandle();
  await page.getByLabel('Open DOCX file').setInputFiles('tests/fixtures/decorated-text-box/control.docx');
  await expect.poll(() => previous.evaluate(e => e.isConnected)).toBe(false);
  await expect(input).toHaveValue('Before the text box\n￼\nAfter the text box');
  await expect(input).toHaveJSProperty('readOnly', false);
  await expect(page.getByText(/read-only/)).toHaveCount(0);
  const counts = () => page.locator('canvas.canvas-page').first().evaluate(canvas => {
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data, count = { yellow: 0, green: 0, red: 0 };
    for (let i = 0; i < data.length; i += 4) {
      const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
      if (r > 245 && g > 245 && b < 10) count.yellow++;
      else if (Math.abs(r - 0xC6) < 4 && Math.abs(g - 0xE0) < 4 && Math.abs(b - 0xB4) < 4) count.green++;
      else if (r > 200 && g < 60 && b < 60) count.red++;
    }
    return count;
  });
  await expect.poll(async () => (await counts()).yellow).toBeGreaterThan(200);
  const { green, red } = await counts();
  expect(green).toBeGreaterThan(200);
  expect(red).toBeGreaterThan(10);
  expect(errors).toEqual([]);
});
