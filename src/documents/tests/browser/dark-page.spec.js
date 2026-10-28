import { test, expect } from '@playwright/test';

// The page canvas's pixels: the paper in the top margin, and how much of the page is light ink.
const pagePixels = (page, pick = 'screen') => page.evaluate(pick => {
  const engine = window.__docs.current.view.engine;
  const canvas = pick === 'print' ? engine.printSheets([0])[0] : engine.canvases[0];
  const ctx = canvas.getContext('2d'), { width, height } = canvas;
  const lum = (d, i) => (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
  const paper = ctx.getImageData(Math.round(width * 0.05), Math.round(height * 0.03), 1, 1).data;
  const all = ctx.getImageData(0, 0, width, Math.round(height / 3)).data;
  let light = 0, dark = 0;
  for (let i = 0; i < all.length; i += 4) { const l = lum(all, i); if (l > 0.7) light++; else if (l < 0.15) dark++; }
  return { paper: lum(paper, 0), light, dark };
}, pick);

test.describe('dark page', () => {
  test.use({ colorScheme: 'dark', viewport: { width: 1280, height: 800 } });

  test('Dark page draws dark paper with light ink on screen, and leaves printing white', async ({ page }) => {
    await page.addInitScript(() => { try { localStorage.setItem('documents:dark-page', '1'); } catch { /* storage unavailable */ } });
    await page.goto('/mock.html#/new');
    await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
    await page.getByRole('textbox', { name: 'Document text' }).fill('Ink on dark paper. '.repeat(30));
    await expect.poll(async () => (await pagePixels(page)).paper).toBeLessThan(0.15);
    const screen = await pagePixels(page);
    // Light ink, on mostly dark paper.
    expect(screen.light).toBeGreaterThan(200);
    expect(screen.dark).toBeGreaterThan(screen.light);
    // Printing, PDF and the saved file are untouched: their sheets are white paper with dark ink.
    const print = await pagePixels(page, 'print');
    expect(print.paper).toBeGreaterThan(0.95);
    // Turned off in Preferences, the page is white again at once.
    await page.getByRole('textbox', { name: 'Document text' }).press('ControlOrMeta+,');
    const dialog = page.getByRole('dialog', { name: 'Preferences' });
    const toggle = dialog.getByRole('switch', { name: /Dark page/ });
    await expect(toggle).toBeChecked();
    await dialog.locator('.pref-row', { hasText: 'Dark page' }).click();
    await expect(toggle).not.toBeChecked();
    await expect.poll(async () => (await pagePixels(page)).paper).toBeGreaterThan(0.95);
  });

  test('the light appearance keeps white paper whatever the Dark page setting', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.addInitScript(() => { try { localStorage.setItem('documents:dark-page', '1'); } catch { /* storage unavailable */ } });
    await page.goto('/mock.html#/new');
    await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
    await page.getByRole('textbox', { name: 'Document text' }).fill('Ink on white paper.');
    await expect.poll(async () => (await pagePixels(page)).paper).toBeGreaterThan(0.95);
  });

  test('a dark page context turns colors but not pictures, and reads colors back as they were set', async ({ page }) => {
    await page.goto('/playground.html');
    const result = await page.evaluate(async () => {
      const { setDarkPage } = await import('/src/engine/canvas-dark-page.js');
      const canvas = Object.assign(document.createElement('canvas'), { width: 4, height: 1 }), ctx = canvas.getContext('2d');
      const picture = Object.assign(document.createElement('canvas'), { width: 1, height: 1 }), pctx = picture.getContext('2d');
      pctx.fillStyle = '#ff0000'; pctx.fillRect(0, 0, 1, 1);
      setDarkPage(ctx, true);
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 1, 1);
      const readBack = ctx.fillStyle;
      ctx.save(); ctx.fillStyle = '#000000'; ctx.fillRect(1, 0, 1, 1); ctx.restore();
      const restored = ctx.fillStyle;
      ctx.drawImage(picture, 2, 0);
      // The insertion caret's blue.
      ctx.fillStyle = '#375f91'; ctx.fillRect(3, 0, 1, 1);
      const px = x => [...ctx.getImageData(x, 0, 1, 1).data.slice(0, 3)];
      return { paper: px(0), ink: px(1), picture: px(2), caret: px(3), readBack, restored };
    });
    expect(result.paper).toEqual([28, 28, 28]);
    expect(result.ink).toEqual([227, 227, 227]);
    expect(result.picture).toEqual([255, 0, 0]);
    expect(result.readBack).toBe('#ffffff');
    expect(result.restored).toBe('#ffffff');
    // The caret stays a light blue that stands out on the dark paper.
    expect(result.caret[2]).toBeGreaterThan(result.caret[0]);
    expect(Math.min(...result.caret)).toBeGreaterThan(110);
  });
});
