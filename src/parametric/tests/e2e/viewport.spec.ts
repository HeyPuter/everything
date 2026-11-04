import { expect, test } from '@playwright/test';
import { canvasCenter, openApp, waitForFeature } from './helpers';

type Win = { __parametric: import('../../src/app/app').App };

test.describe('viewport', () => {
  test('sketch dimension labels follow the camera when zooming', async ({ page }) => {
    const errors = await openApp(page);
    await page.getByRole('button', { name: /New part/ }).click();
    await page.getByRole('treeitem', { name: 'Front Plane' }).click();
    await page.getByRole('tab', { name: 'Sketch' }).click();
    await page.locator('[data-cmd="sketch"]').first().click();
    await expect(page.locator('.statusbar')).toContainText('Defined');
    await page.waitForTimeout(400); // normal-to animation
    const { x, y } = await canvasCenter(page);
    await page.locator('[data-cmd="tool:rectangle"]').click();
    await page.mouse.click(x, y);
    await page.mouse.click(x + 160, y - 90);
    await page.keyboard.press('Escape');
    await expect(page.locator('.rel-badge').first()).toBeVisible();
    await page.keyboard.press('d');
    await page.mouse.click(x + 80, y);
    await page.mouse.click(x + 80, y + 40);
    const modify = page.getByRole('dialog', { name: /Modify/ });
    await modify.getByRole('textbox').fill('50');
    await modify.getByRole('textbox').press('Enter');
    const label = page.locator('.dim-label', { hasText: '50.00' });
    await expect(label).toBeVisible();
    const centre = async () => { const b = (await label.boundingBox())!; return [b.x + b.width / 2, b.y + b.height / 2]; };
    const [lx, ly] = await centre();
    // Zoom in about a fixed cursor without moving the mouse afterwards: the
    // label keeps its place on the sketch, so its offset from the cursor grows.
    const cx = x - 120, cy = y - 120;
    await page.mouse.move(cx, cy);
    await page.mouse.wheel(0, -200);
    const k = Math.exp(200 * 0.0018);
    await expect.poll(async () => { const [ax, ay] = await centre(); return Math.hypot(ax - (cx + (lx - cx) * k), ay - (cy + (ly - cy) * k)); }).toBeLessThan(3);
    expect(errors).toEqual([]);
  });

  test('redraws the model after the WebGL context is lost and restored', async ({ page }) => {
    const errors = await openApp(page);
    await page.getByRole('button', { name: /Mounting Bracket/ }).click();
    await waitForFeature(page, 'Fillet1');
    // Shaded model colour at the centre of the part, and a pick there.
    const probe = () => page.evaluate(async () => {
      const app = (window as unknown as Win).__parametric;
      const r = app.renderer;
      const [x, y] = app.viewport.project([30, 3, 25]);
      const url = r.capture(512);
      let pixel: number[] = [];
      if (url) {
        const img = new Image();
        img.src = url;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.width; c.height = img.height;
        const ctx = c.getContext('2d')!;
        ctx.drawImage(img, 0, 0);
        const k = img.width / r.camera.width;
        pixel = [...ctx.getImageData(Math.round(x * k), Math.round(y * k), 1, 1).data].slice(0, 3);
      }
      return { pick: r.pick(x, y, { face: true })?.kind ?? null, pixel };
    });
    await expect.poll(async () => (await probe()).pick).toBe('face');
    const before = await probe();
    await page.evaluate(() => {
      const ext = (window as unknown as Win).__parametric.renderer.gl.getExtension('WEBGL_lose_context')!;
      (window as unknown as { __lose: WEBGL_lose_context }).__lose = ext;
      ext.loseContext();
    });
    await expect.poll(() => page.evaluate(() => (window as unknown as Win).__parametric.renderer.lost)).toBe(true);
    await page.evaluate(() => (window as unknown as { __lose: WEBGL_lose_context }).__lose.restoreContext());
    await expect.poll(async () => (await probe()).pick).toBe('face');
    const after = await probe();
    after.pixel.forEach((v, i) => expect(Math.abs(v - before.pixel[i])).toBeLessThan(12));
    expect(errors).toEqual([]);
  });

  test('repeated arrow keys add up their rotations', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: /Mounting Bracket/ }).click();
    await waitForFeature(page, 'Fillet1');
    await page.evaluate(() => (window as unknown as Win).__parametric.viewport.setView('front', false));
    await page.locator('canvas.gl').focus();
    // Six 15 degree steps, faster than the 180 ms step animation (key repeat).
    for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowRight');
    await expect(page.locator('.view-label')).toHaveText('Right');
  });

  test('follows a change of device pixel ratio without a resize', async ({ page }) => {
    // Moving the window to a denser display changes devicePixelRatio and fires
    // a resolution media query change, but no resize. Emulate exactly that.
    await page.addInitScript(() => {
      const listeners: (() => void)[] = [];
      const mm = window.matchMedia.bind(window);
      window.matchMedia = (q: string) => {
        const mq = mm(q);
        if (/resolution/.test(q)) mq.addEventListener = (_t: string, fn: unknown) => { listeners.push(fn as () => void); };
        return mq;
      };
      (window as unknown as { __densityChange: (r: number) => void }).__densityChange = (r) => {
        Object.defineProperty(window, 'devicePixelRatio', { configurable: true, get: () => r });
        listeners.splice(0).forEach((fn) => fn());
      };
    });
    await openApp(page);
    const size = () => page.evaluate(() => { const r = (window as unknown as Win).__parametric.renderer; return [r.canvas.width, r.camera.width]; });
    await expect.poll(async () => (await size())[1]).toBeGreaterThan(100);
    const [w1, css] = await size();
    expect(w1).toBe(Math.round(css));
    await page.evaluate(() => (window as unknown as { __densityChange: (r: number) => void }).__densityChange(2));
    await expect.poll(async () => (await size())[0]).toBe(Math.round(css * 2));
  });
});
