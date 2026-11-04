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

  test('relation badges do not swallow clicks while a sketch tool is active', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: /New part/ }).click();
    await page.getByRole('treeitem', { name: 'Front Plane' }).click();
    await page.getByRole('tab', { name: 'Sketch' }).click();
    await page.locator('[data-cmd="sketch"]').first().click();
    await expect(page.locator('.statusbar')).toContainText('Defined');
    await page.waitForTimeout(400);
    const { x, y } = await canvasCenter(page);
    await page.locator('[data-cmd="tool:rectangle"]').click();
    await page.mouse.click(x, y);
    await page.mouse.click(x + 160, y - 90);
    await page.keyboard.press('Escape');
    // The bottom edge's Horizontal badge sits up and right of its midpoint.
    const badge = page.locator('.rel-badge[aria-label="horizontal relation"]').filter({ visible: true });
    const boxes = await badge.evaluateAll((els) => els.map((e) => { const b = e.getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; }));
    boxes.sort((a, b) => b[1] - a[1]);
    const [bx, by] = boxes[0];
    expect(Math.hypot(bx - (x + 94), by - (y - 14))).toBeLessThan(4);
    // Smart Dimension: pick the edge, then place the dimension on the badge.
    await page.keyboard.press('d');
    await page.mouse.click(x + 80, y);
    await page.mouse.click(bx, by);
    await expect(page.getByRole('dialog', { name: /Modify/ })).toBeVisible();
    await page.keyboard.press('Escape');
    // With no tool active, clicking a badge (the top edge's) still selects its relation.
    await page.keyboard.press('Escape');
    await page.mouse.click(boxes[1][0], boxes[1][1]);
    await expect(page.locator('.rel-badge.selected')).toHaveCount(1);
  });

  test('a drag whose release never arrives does not stay active', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: /New part/ }).click();
    await page.getByRole('treeitem', { name: 'Front Plane' }).click();
    await page.getByRole('tab', { name: 'Sketch' }).click();
    await page.locator('[data-cmd="sketch"]').first().click();
    await expect(page.locator('.statusbar')).toContainText('Defined');
    await page.waitForTimeout(400);
    const { x, y } = await canvasCenter(page);
    await page.locator('[data-cmd="tool:rectangle"]').click();
    await page.mouse.click(x, y);
    await page.mouse.click(x + 160, y - 90);
    await page.keyboard.press('Escape');
    const state = () => page.evaluate(() => {
      const app = (window as unknown as Win).__parametric;
      return { active: app.viewport.gestureActive, batch: (app.store as unknown as { batchDepth: number }).batchDepth };
    });
    const cancel = (type: string) => page.evaluate((t) => {
      document.querySelector('canvas.gl')!.dispatchEvent(new PointerEvent(t, { pointerId: 1, pointerType: 'mouse', bubbles: true }));
    }, type);
    // The browser cancels a sketch corner drag: the drag ends and undo still works.
    await page.mouse.move(x + 160, y - 90);
    await page.mouse.down();
    await page.mouse.move(x + 180, y - 100, { steps: 4 });
    expect(await state()).toEqual({ active: true, batch: 1 });
    await cancel('pointercancel');
    await page.mouse.up();
    expect(await state()).toEqual({ active: false, batch: 0 });
    // Pointer capture lost mid-orbit, and a move with no button held.
    for (const end of ['lostpointercapture', 'move']) {
      await page.mouse.move(x - 200, y + 150);
      await page.mouse.down({ button: 'right' });
      await page.mouse.move(x - 160, y + 120, { steps: 4 });
      expect((await state()).active).toBe(true);
      if (end === 'move') await page.evaluate(([cx, cy]) => {
        document.querySelector('canvas.gl')!.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, pointerType: 'mouse', bubbles: true, clientX: cx, clientY: cy, buttons: 0 }));
      }, [x - 150, y + 110]);
      else await cancel(end);
      expect((await state()).active).toBe(false);
      await page.mouse.up({ button: 'right' });
    }
  });

  test('a wheel zoom re-picks the hover under a still cursor, and lands a view turn', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: /Mounting Bracket/ }).click();
    await waitForFeature(page, 'Fillet1');
    const [px, py] = await page.evaluate(() => {
      const app = (window as unknown as Win).__parametric;
      const r = app.viewport.canvas.getBoundingClientRect();
      const [x, y] = app.viewport.project([30, 3, 25]);
      return [x + r.left, y + r.top];
    });
    const hover = () => page.evaluate(() => {
      const app = (window as unknown as Win).__parametric;
      const m = app.viewport.mouse!;
      return { hover: JSON.stringify(app.selection.hover), under: JSON.stringify(app.viewport.pickItem(m.x, m.y, app.pickFilter())) };
    });
    await page.mouse.move(px, py);
    await expect.poll(async () => (await hover()).hover).toContain('"face"');
    const before = (await hover()).hover;
    // Zoom out about the still cursor until another entity is under it.
    for (let i = 0; i < 6; i++) await page.mouse.wheel(0, 300);
    expect((await hover()).under).not.toBe(before);
    await expect.poll(async () => { const h = await hover(); return h.hover === h.under; }).toBe(true);
    // A wheel zoom during a standard view animation still lands on the view.
    await page.evaluate(() => (window as unknown as Win).__parametric.viewport.setView('front'));
    await page.mouse.wheel(0, -100);
    await expect(page.locator('.view-label')).toHaveText('Front');
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

  test('does not pick vertices cut away by the section view', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: /Mounting Bracket/ }).click();
    await waitForFeature(page, 'Fillet1');
    const pickCorner = () => page.evaluate(() => {
      const app = (window as unknown as Win).__parametric;
      const [x, y] = app.viewport.project([60, 8, 30]);
      const hit = app.renderer.pick(x, y, { vertex: true });
      return hit ? [...app.vertexAt(hit.index)!] : null;
    });
    await expect.poll(pickCorner).toEqual([60, 8, 30]);
    // Section away everything in front of z = 15.
    await page.evaluate(() => { (window as unknown as Win).__parametric.renderer.section = { normal: [0, 0, 1], offset: 15 }; });
    const hit = await pickCorner();
    expect(hit === null || hit[2] <= 15).toBe(true);
  });

  test('line display styles keep visible edges readable in both themes', async ({ page }) => {
    await openApp(page);
    const contrast = () => page.evaluate(() => {
      const t = (window as unknown as Win).__parametric.readTheme();
      const lum = (c: number[]) => { const l = c.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2]; };
      const [a, b] = [lum(t.wire), lum(t.background)].sort((x, y) => y - x);
      return (a + 0.05) / (b + 0.05);
    });
    expect(await contrast()).toBeGreaterThan(4.5);
    await page.getByRole('button', { name: /Account/ }).click();
    await page.getByRole('menuitemradio', { name: 'Dark' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme-resolved', 'dark');
    expect(await contrast()).toBeGreaterThan(4.5);
  });

  test('line display styles show a selected face', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: /Mounting Bracket/ }).click();
    await waitForFeature(page, 'Fillet1');
    await expect.poll(() => page.evaluate(() => {
      const app = (window as unknown as Win).__parametric;
      const [x, y] = app.viewport.project([30, 3, 25]);
      return app.renderer.pick(x, y, { face: true })?.kind;
    })).toBe('face');
    // Colour at a face's centre, unselected and selected, in each style.
    const probe = (style: string) => page.evaluate(async (s) => {
      const app = (window as unknown as Win).__parametric;
      const r = app.renderer;
      const [x, y] = app.viewport.project([30, 3, 25]);
      r.displayStyle = 'shadedEdges';
      const face = app.viewport.pickItem(x, y, { face: true })!;
      r.displayStyle = s as typeof r.displayStyle;
      const pixel = async () => {
        const img = new Image();
        img.src = r.capture(512)!;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.width; c.height = img.height;
        const ctx = c.getContext('2d')!;
        ctx.drawImage(img, 0, 0);
        const k = img.width / r.camera.width;
        return [...ctx.getImageData(Math.round(x * k), Math.round(y * k), 1, 1).data].slice(0, 3);
      };
      app.selection.set([]);
      const plain = await pixel();
      app.selection.set([face]);
      const selected = await pixel();
      app.selection.set([]);
      return { plain, selected, bg: r.theme.background.map((v) => Math.round(v * 255)) };
    }, style);
    for (const style of ['hiddenRemoved', 'hiddenVisible', 'wireframe']) {
      const { plain, selected, bg } = await probe(style);
      // Unselected faces keep the background colour; a selected one is tinted.
      plain.forEach((v, i) => expect(Math.abs(v - bg[i])).toBeLessThan(4));
      expect(Math.abs(selected[2] - plain[2]) + Math.abs(selected[0] - plain[0])).toBeGreaterThan(20);
    }
  });

  test('zoom to fit fills the view with a sub-millimetre part', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: /New part/ }).click();
    await page.evaluate(() => {
      const app = (window as unknown as Win).__parametric;
      const doc = structuredClone(app.store.doc);
      const pts = [[0, 0], [0.6, 0], [0.6, 0.4], [0, 0.4]];
      const entities: import('../../src/model/types').SkEntity[] = pts.map(([x, y], i) => ({ id: `p${i}`, t: 'point', x, y }));
      pts.forEach((_, i) => entities.push({ id: `l${i}`, t: 'line', a: `p${i}`, b: `p${(i + 1) % 4}` }));
      doc.features.push({ id: 's1', name: 'Sketch1', type: 'sketch', plane: { kind: 'base', plane: 'front' }, entities, constraints: [] });
      doc.features.push({ id: 'f1', name: 'Extrude1', type: 'extrude', sketch: 's1', cut: false, end: 'blind', depth: 0.3, flip: false, dir2: null, draft: 0, draftOutward: false, thin: null });
      app.loadDocument(doc, null);
    });
    await waitForFeature(page, 'Extrude1');
    await expect.poll(() => page.evaluate(() => !!(window as unknown as Win).__parametric.bbox)).toBe(true);
    const fill = await page.evaluate(() => {
      const app = (window as unknown as Win).__parametric;
      app.viewport.zoomToFit(false);
      const b = app.bbox!;
      const xs: number[] = [], ys: number[] = [];
      for (const x of [b.min[0], b.max[0]]) for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) {
        const [px, py] = app.viewport.project([x, y, z]);
        xs.push(px); ys.push(py);
      }
      const cam = app.renderer.camera;
      return Math.max((Math.max(...xs) - Math.min(...xs)) / cam.width, (Math.max(...ys) - Math.min(...ys)) / cam.height);
    });
    expect(fill).toBeGreaterThan(0.5);
  });

  const countDoubleClicks = async (page: import('@playwright/test').Page) => {
    await page.getByRole('button', { name: /Mounting Bracket/ }).click();
    await waitForFeature(page, 'Fillet1');
    // The face must be under the point: wait for the built model.
    await expect.poll(() => page.evaluate(() => {
      const app = (window as unknown as Win).__parametric;
      const [x, y] = app.viewport.project([30, 4, 30]);
      return app.renderer.pick(x, y, { face: true })?.kind;
    })).toBe('face');
    return page.evaluate(() => {
      const app = (window as unknown as Win).__parametric;
      const w = window as unknown as { __dbl: number };
      w.__dbl = 0;
      app.onViewportDoubleClick = () => { w.__dbl++; };
      const r = app.viewport.canvas.getBoundingClientRect();
      const [x, y] = app.viewport.project([30, 4, 30]);
      return [x + r.left, y + r.top];
    });
  };

  test('a mouse double click runs the double-click action once', async ({ page }) => {
    await openApp(page);
    const [x, y] = await countDoubleClicks(page);
    await page.mouse.dblclick(x, y);
    await expect.poll(() => page.evaluate(() => (window as unknown as { __dbl: number }).__dbl)).toBe(1);
  });

  test.describe('touch', () => {
    test.use({ viewport: { width: 412, height: 839 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true });
    test('a double tap runs the double-click action once', async ({ page }) => {
      await openApp(page);
      const [x, y] = await countDoubleClicks(page);
      const cdp = await page.context().newCDPSession(page);
      for (let i = 0; i < 2; i++) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await page.waitForTimeout(60);
      }
      await page.waitForTimeout(500);
      expect(await page.evaluate(() => (window as unknown as { __dbl: number }).__dbl)).toBe(1);
    });
  });
});
