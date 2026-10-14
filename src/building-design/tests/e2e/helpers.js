import { expect } from '@playwright/test';

/** Open the app with the alpha notice dismissed; collect page errors. */
export async function openApp(page, query = '') {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/puter|favicon|Failed to load resource/i.test(m.text())) errors.push(m.text());
  });
  await page.addInitScript(() => localStorage.setItem('bd.alphaNoticeSeen', '1'));
  await page.goto(`/${query}`);
  await expect(page.locator('.titlebar')).toBeVisible();
  return errors;
}

/** Screen position (page px) of a model point in the active plan view. */
export async function screenOf(page, x, y) {
  return page.evaluate(
    ([x, y]) => {
      const c = window.bd.vc;
      const r = window.bd.shell.overlay.getBoundingClientRect();
      const s = c.modelToScreen([x, y]);
      return [r.left + s.x, r.top + s.y];
    },
    [x, y],
  );
}

export async function clickModel(page, x, y) {
  const [sx, sy] = await screenOf(page, x, y);
  await page.mouse.move(sx + 3, sy + 3);
  await page.mouse.move(sx, sy, { steps: 2 });
  await page.mouse.click(sx, sy);
}

/** Fraction of canvas pixels that differ from the background colour. */
export async function inkCoverage(page) {
  return page.evaluate(async () => {
    const vp = window.bd.viewport;
    vp.render();
    const gl = vp.gl;
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const bg = [px[0], px[1], px[2]];
    let n = 0;
    for (let i = 0; i < px.length; i += 4 * 7) if (Math.abs(px[i] - bg[0]) + Math.abs(px[i + 1] - bg[1]) + Math.abs(px[i + 2] - bg[2]) > 30) n++;
    return n / (px.length / (4 * 7));
  });
}
