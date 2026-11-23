import { test, expect } from '@playwright/test';
import { loadImage, createCanvas } from '@napi-rs/canvas';

// With no scroll bar, the quick tools gave no sign of the tools past the end that fits: on a
// phone turned sideways the column ended at a divider, and Image, Sign and Fill forms below it
// looked absent. A shade now marks the end with more tools, and goes once that end is reached.
test('the quick tools show a shade where more tools lie past the edge', async ({
  page,
  isMobile,
}) => {
  await page.emulateMedia({ colorScheme: 'light' });
  // A column on a 844px phone turned sideways; a row that scrolls on a 667px one.
  await page.setViewportSize(isMobile ? { width: 667, height: 375 } : { width: 844, height: 390 });
  await page.route('https://js.puter.com/**', (route) => route.abort());
  await page.goto('/');
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  const tools = page.getByRole('toolbar', { name: 'PDF tools' });
  const box = (await tools.boundingBox()) ?? { x: 0, y: 0, width: 0, height: 0 };
  // Inside the far edge, in the padding past the last button, clear of the rounded corners.
  const at = isMobile
    ? { x: Math.floor(box.x + box.width) - 2, y: Math.floor(box.y + box.height / 2) }
    : { x: Math.floor(box.x + box.width / 2), y: Math.floor(box.y + box.height) - 2 };
  const brightness = async () => {
    const image = await loadImage(await page.screenshot({ clip: { ...at, width: 1, height: 1 } }));
    const context = createCanvas(1, 1).getContext('2d');
    context.drawImage(image, 0, 0);
    const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
    return (r + g + b) / 3;
  };
  expect(
    await tools.evaluate(
      (node) =>
        node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 1,
    ),
  ).toBe(true);
  // Only the toolbar's own background is compared: the buttons and dividers scroll past.
  await tools.evaluate((node) => {
    for (const child of node.children) child.style.visibility = 'hidden';
  });
  const shaded = await brightness();
  await tools.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
    node.scrollLeft = node.scrollWidth;
  });
  await expect.poll(brightness).toBeGreaterThan(shaded + 5);
});
