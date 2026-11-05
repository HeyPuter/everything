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

  test('a rebuild re-picks the hover under a still cursor', async ({ page }) => {
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
    // A thinner base plate: the hovered face still exists but is no longer under the cursor.
    await page.evaluate(() => (window as unknown as Win).__parametric.store.change('Depth', (d) => { (d.features[1] as { depth: number }).depth = 5; }));
    await expect.poll(async () => (await hover()).under).not.toBe(before);
    await expect.poll(async () => { const h = await hover(); return h.hover === h.under; }).toBe(true);
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
    // Hover picks render offscreen: moving within one face redraws nothing.
    await page.evaluate(() => {
      const r = (window as unknown as Win).__parametric.renderer as unknown as { draw: () => void };
      const w = window as unknown as { __draws: number };
      const draw = r.draw.bind(r);
      w.__draws = 0;
      r.draw = () => { w.__draws++; draw(); };
    });
    for (let i = 1; i <= 8; i++) { await page.mouse.move(px + (i % 3), py + (i % 2)); await page.waitForTimeout(30); }
    expect((await hover()).hover).toBe(before);
    expect(await page.evaluate(() => (window as unknown as { __draws: number }).__draws)).toBe(0);
    // Zoom out about the still cursor until another entity is under it.
    for (let i = 0; i < 6; i++) await page.mouse.wheel(0, 300);
    expect((await hover()).under).not.toBe(before);
    await expect.poll(async () => { const h = await hover(); return h.hover === h.under; }).toBe(true);
    // A wheel zoom during a standard view animation still lands on the view.
    await page.evaluate(() => (window as unknown as Win).__parametric.viewport.setView('front'));
    await page.mouse.wheel(0, -100);
    await expect(page.locator('.view-label')).toHaveText('Front');
    // Previous View after a view change made mid-animation goes back to the
    // view that animation was heading to, not a half-turned one.
    await page.evaluate(() => { const v = (window as unknown as Win).__parametric.viewport; v.setView('right'); v.setView('top'); });
    await expect(page.locator('.view-label')).toHaveText('Top');
    await page.evaluate(() => (window as unknown as Win).__parametric.viewport.previousView());
    await expect(page.locator('.view-label')).toHaveText('Right');
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

  test('editing a sketch hides the sketches after it with the rest of the rolled-back model', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: /Mounting Bracket/ }).click();
    await waitForFeature(page, 'Fillet1');
    type R = { renderer: { points: Map<string, unknown>; lines: Map<string, unknown> }; store: { change(l: string, fn: (d: { features: object[] }) => void): void }; editSketch(id: string): void; exitSketch(keep: boolean): void; editFeature(id: string): void; closePanel(ok: boolean): Promise<unknown> };
    const shown = () => page.evaluate(() => {
      const r = (window as unknown as { __parametric: R }).__parametric.renderer;
      return [r.points.has('sketchPts'), r.lines.has('planes')];
    });
    // Show the hole's sketch (its two points, on the plate's top face) and add a plane after it.
    await page.evaluate(() => {
      (window as unknown as { __parametric: R }).__parametric.store.change('Show', (d) => {
        (d.features.find((f) => (f as { id: string }).id === 's2') as { hidden?: boolean }).hidden = false;
        d.features.push({ id: 'pl', name: 'Plane1', type: 'plane', ref: { kind: 'base', plane: 'top' }, offset: 50, flip: false });
      });
    });
    await expect.poll(shown).toEqual([true, true]);
    await page.evaluate(() => (window as unknown as { __parametric: R }).__parametric.editSketch('s1'));
    await expect.poll(shown).toEqual([false, false]);
    await page.evaluate(() => (window as unknown as { __parametric: R }).__parametric.exitSketch(true));
    await expect.poll(shown).toEqual([true, true]);
    // A plane being edited still shows where it goes.
    await page.evaluate(() => (window as unknown as { __parametric: R }).__parametric.editFeature('pl'));
    await expect(page.getByRole('heading', { name: 'Plane1' })).toBeVisible();
    await expect.poll(shown).toEqual([true, true]);
  });

  test('the section panel shows the plane it was started from', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: /Mounting Bracket/ }).click();
    await waitForFeature(page, 'Fillet1');
    const planes = page.getByRole('group', { name: 'Section plane' });
    const normal = () => page.evaluate(() => (window as unknown as Win).__parametric.renderer.section?.normal.map((v) => Math.round(v * 1000) / 1000));
    await page.getByRole('treeitem', { name: 'Top Plane' }).click();
    await page.getByRole('button', { name: 'Section View' }).click();
    await expect(planes.getByRole('button', { name: 'Top' })).toHaveAttribute('aria-pressed', 'true');
    await expect(planes.getByRole('button', { name: 'Front' })).toHaveAttribute('aria-pressed', 'false');
    expect(await normal()).toEqual([0, 1, 0]);
    // Running it again while open keeps the active (here oblique) section as its own choice.
    await page.evaluate(() => { (window as unknown as Win).__parametric.renderer.section = { normal: [Math.SQRT1_2, Math.SQRT1_2, 0], offset: 5 }; });
    await page.getByRole('button', { name: 'Section View' }).click();
    await expect(planes.getByRole('button', { name: 'Current' })).toHaveAttribute('aria-pressed', 'true');
    await planes.getByRole('button', { name: 'Front' }).click();
    expect(await normal()).toEqual([0, 0, 1]);
    await planes.getByRole('button', { name: 'Current' }).click();
    expect(await normal()).toEqual([0.707, 0.707, 0]);
  });

  test('zoomed in past a face, picking still finds where it was clicked', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: /Mounting Bracket/ }).click();
    await waitForFeature(page, 'Fillet1');
    await expect.poll(() => page.evaluate(() => !!(window as unknown as Win).__parametric.bbox)).toBe(true);
    const r = await page.evaluate(() => {
      const app = (window as unknown as Win).__parametric;
      const cam = app.renderer.camera;
      // Orthographic front view zoomed in so far that the eye sits inside the
      // part, behind the front face (z = 30) that is still drawn.
      app.viewport.setView('front', false);
      cam.setState({ ...cam.state(), target: [30, 4, 15], distance: 5 });
      const hit = app.renderer.pick(cam.width / 2, cam.height / 2, { face: true });
      app.viewport.showPlanes = true;
      app.viewport.drawReferenceGeometry();
      const item = app.viewport.pickItem(cam.width / 2, cam.height / 2, { face: true, plane: true });
      return { point: hit?.point?.map((v) => Math.round(v * 100) / 100), item: item?.kind };
    });
    expect(r.point).toEqual([30, 4, 30]);
    // The Front Plane behind the face is not picked through it.
    expect(r.item).toBe('face');
  });

  test('measures the angle between an edge and a face to the face', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: /Mounting Bracket/ }).click();
    await waitForFeature(page, 'Fillet1');
    await expect.poll(() => page.evaluate(() => (window as unknown as Win).__parametric.faces.length)).toBeGreaterThan(0);
    const angle = async (edgeAxis: number) => {
      await page.evaluate(async (k) => {
        const app = (window as unknown as Win).__parametric;
        if (app.panel) await app.closePanel(false);
        // The plate's front face (z = 30) and an edge along x lying in it, or one along z.
        const fi = app.faces.findIndex((f) => f.normal?.[2] === 1 && Math.abs(f.center[2] - 30) < 1e-6);
        const ei = app.edges.findIndex((e) => e.dir && Math.abs(Math.abs(e.dir[k]) - 1) < 1e-9 && (k === 2 || Math.abs(e.a[2] - 30) < 1e-6));
        app.selection.set([{ kind: 'face', index: fi, name: app.faces[fi].name }, { kind: 'edge', index: ei, name: app.edges[ei].name }]);
        app.commands.run('measure');
      }, edgeAxis);
      const row = page.locator('.pm-section tr', { hasText: 'Angle' });
      await expect(row).toBeVisible();
      return row.locator('td').innerText();
    };
    expect(await angle(0)).toBe('0.00°');
    expect(await angle(2)).toBe('90.00°');
  });

  test('measures a normal distance from a plane only to what is parallel to it', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: /Mounting Bracket/ }).click();
    await waitForFeature(page, 'Fillet1');
    await expect.poll(() => page.evaluate(() => (window as unknown as Win).__parametric.faces.length)).toBeGreaterThan(0);
    const measure = async (axis: number) => {
      await page.evaluate(async (k) => {
        const app = (window as unknown as Win).__parametric;
        if (app.panel) await app.closePanel(false);
        // The plate's front face (z = 30, parallel to the Front Plane) or its top face (y = 8, square to it).
        const fi = app.faces.findIndex((f) => f.normal?.[k] === 1 && Math.abs(f.center[k] - (k === 2 ? 30 : 8)) < 1e-6);
        app.selection.set([{ kind: 'plane', ref: { kind: 'base', plane: 'front' } }, { kind: 'face', index: fi, name: app.faces[fi].name }]);
        app.commands.run('measure');
      }, axis);
      await expect(page.locator('.pm-section tr', { hasText: 'Angle' })).toBeVisible();
      return page.locator('.pm-section table').innerText();
    };
    expect(await measure(2)).toMatch(/Normal distance\s+30\.00 mm/);
    // The top face spans z = 0 to 30: no single distance stands for it.
    expect(await measure(1)).not.toContain('Normal distance');
  });

  test('the measure panel drops a vertex that a rebuild took away and measures again', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: /Mounting Bracket/ }).click();
    await waitForFeature(page, 'Fillet1');
    const zMax = () => page.evaluate(() => (window as unknown as Win).__parametric.bbox?.max[2]);
    await expect.poll(zMax).toBe(30);
    // A deeper plate, undone, so that Redo changes the part while the panel is open.
    await page.evaluate(() => {
      const app = (window as unknown as Win).__parametric;
      app.store.change('Depth', (d) => { (d.features.find((f) => f.id === 'f1') as { depth: number }).depth = 40; });
    });
    await expect.poll(zMax).toBe(40);
    await page.evaluate(() => (window as unknown as Win).__parametric.commands.run('undo'));
    await expect.poll(zMax).toBe(30);
    await page.evaluate(() => {
      const app = (window as unknown as Win).__parametric;
      app.selection.set([{ kind: 'vertex', p: [60, 8, 30] }]);
      app.commands.run('measure');
    });
    const table = page.locator('.pm-section table');
    await expect(table).toContainText('60.00, 8.00, 30.00');
    await page.evaluate(() => (window as unknown as Win).__parametric.commands.run('redo'));
    await expect.poll(zMax).toBe(40);
    // The corner at z = 30 is gone: neither listed nor measured.
    await expect(page.getByRole('heading', { name: 'Measure' })).toBeVisible();
    await expect(page.locator('.pm-section').filter({ hasText: 'Entities' }).getByText(/^Vertex/)).toHaveCount(0);
    await expect(table).toHaveCount(0);
  });

  test('measures between two picked vertices', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: /Mounting Bracket/ }).click();
    await waitForFeature(page, 'Fillet1');
    await expect.poll(() => page.evaluate(() => (window as unknown as Win).__parametric.bbox?.max[2])).toBe(30);
    await page.evaluate(() => {
      const app = (window as unknown as Win).__parametric;
      app.selection.set([{ kind: 'vertex', p: [60, 8, 30] }]);
      app.commands.run('measure');
      // A second vertex picked in the graphics area joins the first.
      app.panel!.onPick({ kind: 'vertex', p: [60, 0, 0] }, false);
    });
    await expect(page.locator('.pm-section table')).toContainText(/Distance\s*31\.05 mm/);
    const leader = () => page.evaluate(() => (window as unknown as { __parametric: { renderer: { lines: Map<string, unknown> } } }).__parametric.renderer.lines.has('measure'));
    expect(await leader()).toBe(true);
    // A plane as the next pick replaces the older vertex; its leader goes with it.
    await page.evaluate(() => (window as unknown as Win).__parametric.panel!.onPick({ kind: 'plane', ref: { kind: 'base', plane: 'front' } }, false));
    await expect(page.locator('.pm-section table')).toContainText(/Normal distance\s*0\.00 mm/);
    expect(await leader()).toBe(false);
  });

  test('a measurement finishing late does not overwrite a newer one or outlive the panel', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: /Mounting Bracket/ }).click();
    await waitForFeature(page, 'Fillet1');
    await expect.poll(() => page.evaluate(() => (window as unknown as Win).__parametric.faces.length)).toBeGreaterThan(0);
    const r = await page.evaluate(async () => {
      const app = (window as unknown as Win).__parametric;
      const front = app.faces.findIndex((f) => f.normal?.[2] === 1 && Math.abs(f.center[2] - 30) < 1e-6);
      const back = app.faces.findIndex((f) => f.normal?.[2] === -1);
      const sel = [front, back].map((index) => ({ kind: 'face' as const, index, name: app.faces[index].name }));
      const settle = () => new Promise((res) => setTimeout(res, 800));
      // Two faces are being measured when one is removed from the selection.
      app.selection.set(sel);
      app.commands.run('measure');
      await settle();
      const box = (app.panel as unknown as { box: { items: unknown[]; setItems(i: unknown[], n: boolean): void } }).box;
      box.setItems(box.items.slice(), true);
      box.setItems(box.items.slice(0, 1), true);
      await settle();
      const text = document.querySelector('.pm-section table')!.textContent;
      // Closed while measuring: no leader is left in the view.
      await app.closePanel(false);
      app.selection.set(sel);
      app.commands.run('measure');
      await app.closePanel(false);
      await settle();
      return { text, leader: (app.renderer as unknown as { lines: Map<string, unknown> }).lines.has('measure') };
    });
    expect(r.text).not.toContain('Distance');
    expect(r.leader).toBe(false);
  });

  test('picks a vertex from either side of it', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: /Mounting Bracket/ }).click();
    await waitForFeature(page, 'Fillet1');
    await expect.poll(() => page.evaluate(() => !!(window as unknown as Win).__parametric.bbox)).toBe(true);
    const picked = await page.evaluate(() => {
      const app = (window as unknown as Win).__parametric;
      const [x, y] = app.viewport.project([60, 8, 30]);
      // Point sprites are centred on the point, not drawn to its right only.
      return [-3, 3].map((dx) => app.renderer.pick(x + dx, y, { vertex: true })?.kind ?? null);
    });
    expect(picked).toEqual(['vertex', 'vertex']);
  });

  test('a hovered or selected vertex shows as a dot', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: /Mounting Bracket/ }).click();
    await waitForFeature(page, 'Fillet1');
    await expect.poll(() => page.evaluate(() => !!(window as unknown as Win).__parametric.bbox)).toBe(true);
    const r = await page.evaluate(async () => {
      const app = (window as unknown as Win).__parametric;
      const [x, y] = app.viewport.project([60, 8, 30]);
      const pixels = async () => {
        const img = new Image();
        img.src = app.renderer.capture(4096)!;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.width; c.height = img.height;
        const ctx = c.getContext('2d')!;
        ctx.drawImage(img, 0, 0);
        const k = img.width / app.renderer.camera.width;
        return [-1.5, 1.5].map((dx) => [...ctx.getImageData(Math.round((x + dx) * k), Math.round(y * k), 1, 1).data].slice(0, 3));
      };
      const before = await pixels();
      const d = (a: number[], b: number[]) => Math.hypot(...a.map((v, i) => v - b[i]));
      // Left and right of the vertex, inside the dot: now in the hover or selection colour.
      const shown = async (colour: number[]) => {
        const c = colour.map((v) => v * 255);
        return (await pixels()).map((p, i) => d(p, c) < d(before[i], c) / 3);
      };
      app.selection.setHover({ kind: 'vertex', p: [60, 8, 30] });
      const hover = await shown(app.renderer.theme.hover);
      app.selection.setHover(null);
      app.selection.set([{ kind: 'vertex', p: [60, 8, 30] }]);
      return { hover, selected: await shown(app.renderer.theme.selection) };
    });
    expect(r).toEqual({ hover: [true, true], selected: [true, true] });
  });

  test('a plane behind a face that may not be picked is not picked through it', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: /Mounting Bracket/ }).click();
    await waitForFeature(page, 'Fillet1');
    await expect.poll(() => page.evaluate(() => !!(window as unknown as Win).__parametric.bbox)).toBe(true);
    const item = await page.evaluate(() => {
      const app = (window as unknown as Win).__parametric;
      // The fillet's cylindrical face, with the Front Plane shown behind it; only planar faces count.
      const f = app.faces.find((x) => x.type === 'cylinder' && (x.radius ?? 0) > 3)!;
      app.viewport.showPlanes = true;
      app.viewport.drawReferenceGeometry();
      const [x, y] = app.viewport.project(f.center);
      return app.viewport.pickItem(x, y, { plane: true, planarOnly: true, face: true });
    });
    expect(item).toBeNull();
  });

  test('line display styles outline where the section view cuts the part', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: /Mounting Bracket/ }).click();
    await waitForFeature(page, 'Fillet1');
    await expect.poll(() => page.evaluate(() => !!(window as unknown as Win).__parametric.bbox)).toBe(true);
    const r = await page.evaluate(async () => {
      const app = (window as unknown as Win).__parametric;
      const ren = app.renderer;
      ren.displayStyle = 'hiddenRemoved';
      ren.section = { normal: [1, 0, 0], offset: 30 };
      // On the plate's front face (z = 30), where the cut at x = 30 crosses it: no model edge there.
      const [x, y] = app.viewport.project([30, 4, 30]);
      const img = new Image();
      img.src = ren.capture(4096)!;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      const k = img.width / ren.camera.width;
      const px = [...ctx.getImageData(Math.round(x * k), Math.round(y * k), 1, 1).data].slice(0, 3);
      const d = (a: number[]) => Math.hypot(...a.map((v, i) => v * 255 - px[i]));
      return { toWire: d(ren.theme.wire), toBackground: d(ren.theme.background) };
    });
    expect(r.toWire).toBeLessThan(r.toBackground);
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

  test('zoom to fit frames a sketch when there is no solid yet', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: /New part/ }).click();
    await page.evaluate(() => {
      const app = (window as unknown as Win).__parametric;
      const doc = structuredClone(app.store.doc);
      const pts = [[300, 200], [800, 200], [800, 500], [300, 500]];
      const entities: import('../../src/model/types').SkEntity[] = pts.map(([x, y], i) => ({ id: `p${i}`, t: 'point', x, y }));
      pts.forEach((_, i) => entities.push({ id: `l${i}`, t: 'line', a: `p${i}`, b: `p${(i + 1) % 4}` }));
      doc.features.push({ id: 's1', name: 'Sketch1', type: 'sketch', plane: { kind: 'base', plane: 'front' }, entities, constraints: [] });
      app.loadDocument(doc, null);
    });
    await expect(page.getByRole('treeitem', { name: 'Sketch1' })).toBeVisible();
    await expect.poll(() => page.evaluate(() => {
      const app = (window as unknown as Win).__parametric;
      app.viewport.zoomToFit(false);
      const cam = app.renderer.camera;
      return [[300, 200, 0], [800, 500, 0]].every((p) => {
        const [x, y] = app.viewport.project(p as [number, number, number]);
        return x >= 0 && x <= cam.width && y >= 0 && y <= cam.height;
      });
    })).toBe(true);
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

    test('lifting one of three fingers does not make the view jump', async ({ page }) => {
      await openApp(page);
      await page.getByRole('button', { name: /Mounting Bracket/ }).click();
      await waitForFeature(page, 'Fillet1');
      const jump = await page.evaluate(() => {
        const c = document.querySelector('canvas.gl') as HTMLCanvasElement;
        // Synthetic pointers cannot be captured; the gesture logic is what is under test.
        c.setPointerCapture = () => {};
        c.releasePointerCapture = () => {};
        const r = c.getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        const P = (type: string, id: number, x: number, y: number) => c.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', clientX: x, clientY: y, bubbles: true, buttons: type === 'pointerup' ? 0 : 1 }));
        const cam = (window as unknown as Win).__parametric.renderer.camera;
        P('pointerdown', 11, cx - 60, cy - 60);
        P('pointerdown', 12, cx + 60, cy + 60);
        P('pointerdown', 13, cx + 80, cy - 150);
        const t0 = [...cam.target], d0 = cam.distance;
        P('pointerup', 11, cx - 60, cy - 60);
        P('pointermove', 13, cx + 81, cy - 150);
        const moved = Math.hypot(cam.target[0] - t0[0], cam.target[1] - t0[1], cam.target[2] - t0[2]) / cam.pixelSize;
        P('pointerup', 12, cx + 60, cy + 60);
        P('pointerup', 13, cx + 81, cy - 150);
        return { moved, zoom: cam.distance / d0 };
      });
      // A 1 px finger move pans about a pixel and barely zooms.
      expect(jump.moved).toBeLessThan(3);
      expect(Math.abs(jump.zoom - 1)).toBeLessThan(0.02);
    });
  });
});

test('the design tree flyout stays clear of the view toolbar in a narrow graphics area', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  const run = (id: string) => page.evaluate((id) => (window as unknown as { __parametric: { commands: { run(id: string): void }; taskPaneOpen(): string | null } }).__parametric.commands.run(id), id);
  if (!await page.evaluate(() => (window as unknown as { __parametric: { taskPaneOpen(): string | null } }).__parametric.taskPaneOpen())) await run('assistant');
  await page.getByRole('treeitem', { name: 'Extrude1' }).dblclick();
  const flyout = page.locator('.flyout-tree > button');
  await expect(flyout).toBeVisible();
  const a = (await flyout.boundingBox())!;
  const b = (await page.locator('.hud').boundingBox())!;
  expect(a.x + a.width <= b.x || a.x >= b.x + b.width || a.y + a.height <= b.y || a.y >= b.y + b.height).toBe(true);
  await flyout.click();
  await expect(flyout).toHaveAttribute('aria-expanded', 'true');
});
