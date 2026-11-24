import { expect, test } from '@playwright/test';
import { canvasCenter, chooseTheme, openApp, waitForFeature } from './helpers';

type Win = { __parametric: import('../../src/app/app').App };

test.describe('viewport', () => {
  test('history navigation in the same part keeps its accepted section plane', async ({ page }) => {
    const errors = await openApp(page);
    await page.getByRole('button', { name: /Mounting Bracket/ }).click();
    await waitForFeature(page, 'Fillet1');
    await page.getByRole('button', { name: 'Section View', exact: true }).click();
    const input = page.getByRole('textbox', { name: 'Offset', exact: true });
    await input.fill('15');
    await input.press('Tab');
    await page.getByRole('button', { name: 'OK', exact: true }).first().click();
    const expected = { normal: [0, 0, 1], offset: 15 };
    await page.evaluate(() => (window as unknown as Win).__parametric.store.change('Add variable', (doc) => doc.variables.push({ id: 'v1', name: 'Gap', expr: '10' })));
    for (const command of ['undo', 'redo']) {
      await page.evaluate((command) => (window as unknown as Win).__parametric.commands.run(command), command);
      expect(await page.evaluate(() => (window as unknown as Win).__parametric.renderer.section)).toEqual(expected);
    }
    expect(errors).toEqual([]);
  });

  for (const replacement of ['new', 'open'] as const) for (const editing of [false, true]) test(`${replacement} clears the previous part's section plane (panel open ${editing})`, async ({ page }) => {
    const errors = await openApp(page);
    await page.getByRole('button', { name: /Mounting Bracket/ }).click();
    await waitForFeature(page, 'Fillet1');
    const payload = await page.evaluate(() => JSON.stringify({ ...(window as unknown as Win).__parametric.store.doc, name: 'Replacement' }));
    const pickCorner = () => page.evaluate(() => {
      const a = (window as unknown as Win).__parametric;
      const [x, y] = a.viewport.project([60, 8, 30]);
      const hit = a.renderer.pick(x, y, { vertex: true });
      return hit ? [...a.vertexAt(hit.index)!] : null;
    });
    await expect.poll(pickCorner).toEqual([60, 8, 30]);
    await page.getByRole('button', { name: 'Section View', exact: true }).click();
    const input = page.getByRole('textbox', { name: 'Offset', exact: true });
    await input.fill('-1');
    await input.press('Tab');
    if (editing) await page.getByRole('button', { name: 'Section View', exact: true }).click();
    else await page.getByRole('button', { name: 'OK', exact: true }).first().click();
    expect(await pickCorner()).toBeNull();
    if (replacement === 'new') {
      await page.evaluate(() => (window as unknown as Win).__parametric.commands.run('new'));
      await expect(page).toHaveTitle(/Part\d+ - Parametric/);
      // Build geometry in the new part to detect a stale plane hiding its body.
      await page.evaluate((payload) => {
        const a = (window as unknown as Win).__parametric;
        const doc = JSON.parse(payload);
        a.store.change('Add new geometry', (d) => { d.features = doc.features; d.nextId = doc.nextId; });
      }, payload);
    } else {
      const chooser = page.waitForEvent('filechooser');
      await page.evaluate(() => (window as unknown as Win).__parametric.commands.run('openDevice'));
      const buffer = (globalThis as unknown as { Buffer: { from(s: string): never } }).Buffer.from(payload);
      await (await chooser).setFiles({ name: 'Replacement.parametric', mimeType: 'application/json', buffer });
      await expect(page).toHaveTitle(/Replacement - Parametric$/);
    }
    await waitForFeature(page, 'Fillet1');
    expect(await page.evaluate(() => (window as unknown as Win).__parametric.renderer.section)).toBeNull();
    await expect.poll(pickCorner).toEqual([60, 8, 30]);
    await expect(page.getByRole('button', { name: 'Section View', exact: true })).toHaveAttribute('aria-pressed', 'false');
    expect(errors).toEqual([]);
  });

  for (const units of ['IPS', 'MKS'] as const) for (const pending of [false, true]) test(`Section View updates its length field when units change to ${units} (pending ${pending})`, async ({ page }) => {
    const errors = await openApp(page);
    await page.getByRole('button', { name: /New part/ }).click();
    await page.evaluate(() => {
      const a = (window as unknown as Win).__parametric;
      a.store.change('Add variable', (doc) => { doc.variables = [{ id: 'gap', name: 'Gap', expr: '25.4' }]; });
      a.commands.run('sectionView');
    });
    const input = page.getByRole('textbox', { name: 'Offset', exact: true });
    await input.fill(pending ? '=Gap' : '25.4');
    if (pending) {
      // Change context before the field's debounce or blur commits its expression.
      await page.evaluate((units) => {
        const a = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric;
        a.store.change('Change units', (doc) => { doc.units = units; });
      }, units);
    } else {
      await input.press('Tab');
      await page.evaluate(() => (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric.commands.run('properties'));
      const properties = page.getByRole('dialog', { name: 'Part Properties', exact: true });
      await properties.getByRole('combobox', { name: 'Unit system' }).selectOption(units);
      await properties.getByRole('button', { name: 'OK', exact: true }).click();
    }
    const scale = units === 'IPS' ? 25.4 : 1000;
    expect(Number(await input.inputValue())).toBeCloseTo(25.4 / scale, 10);
    await input.fill('2');
    await input.press('Tab');
    await page.getByRole('button', { name: 'OK', exact: true }).first().click();
    expect(await page.evaluate(() => (window as unknown as Win).__parametric.renderer.section?.offset)).toBeCloseTo(2 * scale, 8);
    expect(errors).toEqual([]);
  });

  for (const flipped of [false, true]) test(`reopening Section View keeps its active plane (flipped ${flipped})`, async ({ page }) => {
    const errors = await openApp(page);
    await page.getByRole('button', { name: /Mounting Bracket/ }).click();
    await waitForFeature(page, 'Fillet1');
    const section = () => page.evaluate(() => (window as unknown as Win).__parametric.renderer.section);
    await page.getByRole('button', { name: 'Section View', exact: true }).click();
    await page.getByRole('group', { name: 'Section plane' }).getByRole('button', { name: 'Top', exact: true }).click();
    const input = page.getByRole('textbox', { name: 'Offset', exact: true });
    await input.fill('7');
    await input.press('Tab');
    if (flipped) await page.getByRole('checkbox', { name: 'Flip side', exact: true }).check();
    const original = await section();
    expect(original).toEqual({ normal: flipped ? [-0, -1, -0] : [0, 1, 0], offset: flipped ? -7 : 7 });
    await page.getByRole('button', { name: 'Section View', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Section View', exact: true })).toBeVisible();
    expect(await section()).toEqual(original);
    await input.fill('9');
    await input.press('Tab');
    expect((await section())?.offset).toBe(9);
    await page.getByRole('button', { name: 'Cancel', exact: true }).first().click();
    expect(await section()).toEqual(original);
    await page.getByRole('button', { name: 'Section View', exact: true }).click();
    expect(await section()).toBeNull();
    expect(errors).toEqual([]);
  });

  test('cancelling the first Section View restores the uncut view', async ({ page }) => {
    const errors = await openApp(page);
    await page.getByRole('button', { name: /Mounting Bracket/ }).click();
    await waitForFeature(page, 'Fillet1');
    await page.getByRole('button', { name: 'Section View', exact: true }).click();
    const input = page.getByRole('textbox', { name: 'Offset', exact: true });
    await input.fill('7');
    await input.press('Tab');
    expect(await page.evaluate(() => (window as unknown as Win).__parametric.renderer.section?.offset)).toBe(7);
    await page.getByRole('button', { name: 'Cancel', exact: true }).first().click();
    expect(await page.evaluate(() => (window as unknown as Win).__parametric.renderer.section)).toBeNull();
    expect(errors).toEqual([]);
  });

  for (const units of ['MMGS', 'IPS'] as const) for (const expression of ['=2+3', '=Gap/2', '2+3']) test(`Section View evaluates ${expression} in ${units} before applying its plane`, async ({ page }) => {
    const errors = await openApp(page);
    await page.getByRole('button', { name: /New part/ }).click();
    await page.evaluate((units) => {
      const a = (window as unknown as Win).__parametric;
      a.store.change('Set units and variable', (doc) => { doc.units = units; doc.variables = [{ id: 'gap', name: 'Gap', expr: '10' }]; });
      a.commands.run('sectionView');
    }, units);
    const input = page.getByRole('textbox', { name: 'Offset', exact: true });
    await expect(input).toHaveAttribute('inputmode', 'text');
    await input.fill(expression);
    await input.press('Tab');
    const offset = () => page.evaluate(() => (window as unknown as Win).__parametric.renderer.section?.offset);
    const expected = 5 * (units === 'IPS' ? 25.4 : 1);
    expect(await offset()).toBe(expected);
    await page.getByRole('checkbox', { name: 'Flip side', exact: true }).check();
    expect(await offset()).toBe(-expected);
    await page.getByRole('button', { name: 'OK', exact: true }).first().click();
    expect(await offset()).toBe(-expected);
    await page.evaluate(() => (window as unknown as Win).__parametric.commands.run('sectionView'));
    expect(await page.evaluate(() => (window as unknown as Win).__parametric.renderer.section)).toBeNull();
    expect(errors).toEqual([]);
  });

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

  test('the wheel zooms over a sketch dimension label and over the triad', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: /Mounting Bracket/ }).click();
    await waitForFeature(page, 'Fillet1');
    await page.evaluate(() => (window as unknown as Win).__parametric.editSketch('s1'));
    const label = page.locator('.dim-label').first();
    await expect(label).toBeVisible();
    const distance = () => page.evaluate(() => (window as unknown as Win).__parametric.renderer.camera.distance);
    for (const target of [label, page.locator('svg.triad')]) {
      const b = (await target.boundingBox())!;
      const before = await distance();
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
      await page.mouse.wheel(0, -200);
      await expect.poll(distance).toBeLessThan(before * 0.9);
    }
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
    const badge = page.locator('.rel-badge[aria-label="horizontal constraint"]').filter({ visible: true });
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

  test('says how to get the view back when the WebGL context stays lost', async ({ page }) => {
    const errors = await openApp(page);
    await page.getByRole('button', { name: /New part/ }).click();
    await page.evaluate(() => {
      const ext = (window as unknown as Win).__parametric.renderer.gl.getExtension('WEBGL_lose_context')!;
      (window as unknown as { __lose: WEBGL_lose_context }).__lose = ext;
      ext.loseContext();
    });
    const alert = page.locator('.viewport').getByRole('alert');
    // Not while the browser may still give the context back by itself.
    await page.waitForTimeout(1500);
    await expect(alert).toHaveCount(0);
    await expect(alert).toContainText('graphics processor was reset', { timeout: 5000 });
    await expect(alert.getByRole('button', { name: 'Reload' })).toBeVisible();
    await page.evaluate(() => (window as unknown as { __lose: WEBGL_lose_context }).__lose.restoreContext());
    await expect(alert).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('Ctrl or Cmd with plus or minus is left to the browser to zoom the page', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: /New part/ }).click();
    await page.locator('canvas.gl').focus();
    await page.evaluate(() => {
      const w = window as unknown as { __prevented: boolean[] };
      w.__prevented = [];
      window.addEventListener('keydown', (e) => { if (e.key === '-' || e.key === '=') w.__prevented.push(e.defaultPrevented); });
    });
    const distance = () => page.evaluate(() => (window as unknown as Win).__parametric.renderer.camera.distance);
    const d0 = await distance();
    for (const key of ['Control+-', 'Meta+-', 'Control+=', 'Meta+=']) {
      await page.keyboard.press(key);
      expect(await distance()).toBe(d0);
    }
    expect(await page.evaluate(() => (window as unknown as { __prevented: boolean[] }).__prevented)).toEqual([false, false, false, false]);
    // Without the modifier they zoom the model.
    await page.keyboard.press('=');
    await expect.poll(distance).toBeLessThan(d0);
  });

  test('the 3D view names the pan key of the platform, and that key pans', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: /New part/ }).click();
    const mac = await page.evaluate(() => /Mac/.test(navigator.platform));
    const canvas = page.locator('canvas.gl');
    // macOS keeps Control with the arrow keys for switching spaces.
    await expect(canvas).toHaveAttribute('aria-label', new RegExp(`${mac ? 'Command' : 'Ctrl'} and arrow keys to pan`));
    await canvas.focus();
    const target = () => page.evaluate(() => [...(window as unknown as Win).__parametric.renderer.camera.target]);
    const t0 = await target();
    await page.keyboard.press(mac ? 'Meta+ArrowLeft' : 'Control+ArrowLeft');
    expect(await target()).not.toEqual(t0);
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

  test('a resize redraws the view before it is painted', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: /Mounting Bracket/ }).click();
    await waitForFeature(page, 'Fillet1');
    // Observers run in creation order, so this one runs after the app's and
    // reads the canvas before the page is painted: a resized canvas that was
    // not redrawn is still cleared to black.
    await page.evaluate(() => {
      const app = (window as unknown as Win).__parametric;
      const gl = app.renderer.gl;
      const w = window as unknown as { __reads: number[][] };
      w.__reads = [];
      const c = app.renderer.canvas;
      let size = `${c.width}x${c.height}`;
      new ResizeObserver(() => {
        if (`${c.width}x${c.height}` === size) return;
        size = `${c.width}x${c.height}`;
        const px = new Uint8Array(4);
        gl.readPixels(2, 2, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        w.__reads.push([...px].slice(0, 3));
      }).observe(app.shell.viewport);
    });
    const size = page.viewportSize()!;
    for (const [i, dh] of [-120, -40].entries()) {
      await page.setViewportSize({ width: size.width, height: size.height + dh });
      await expect.poll(() => page.evaluate(() => (window as unknown as { __reads: number[][] }).__reads.length)).toBe(i + 1);
    }
    const bg = await page.evaluate(() => (window as unknown as Win).__parametric.renderer.theme.background.map((v) => Math.round(v * 255)));
    const reads = await page.evaluate(() => (window as unknown as { __reads: number[][] }).__reads);
    for (const px of reads) px.forEach((v, i) => expect(Math.abs(v - bg[i])).toBeLessThan(3));
  });

  test('a zoom to fit while the view is hidden still frames the part once it shows again', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: /Mounting Bracket/ }).click();
    await waitForFeature(page, 'Fillet1');
    await expect.poll(() => page.evaluate(() => !!(window as unknown as Win).__parametric.bbox)).toBe(true);
    const width = await page.evaluate(() => (window as unknown as Win).__parametric.renderer.camera.width);
    // Hidden (as in a minimised window), the view measures 0 × 0.
    await page.evaluate(() => { (window as unknown as Win).__parametric.shell.viewport.style.display = 'none'; });
    await page.waitForTimeout(200);
    await page.evaluate(() => (window as unknown as Win).__parametric.viewport.zoomToFit(false));
    await page.evaluate(() => { (window as unknown as Win).__parametric.shell.viewport.style.display = ''; });
    await expect.poll(() => page.evaluate(() => (window as unknown as Win).__parametric.renderer.camera.width)).toBe(width);
    const seen = await page.evaluate(() => {
      const app = (window as unknown as Win).__parametric;
      const [x, y] = app.viewport.project([30, 4, 30]);
      return { distance: app.renderer.camera.distance, pick: app.renderer.pick(x, y, { face: true })?.kind ?? null };
    });
    expect(Number.isFinite(seen.distance)).toBe(true);
    expect(seen.pick).toBe('face');
  });

  test('the section cap hides the edges of a hole behind it and is picked where it is', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: /Mounting Bracket/ }).click();
    await waitForFeature(page, 'Fillet1');
    await expect.poll(() => page.evaluate(() => !!(window as unknown as Win).__parametric.bbox)).toBe(true);
    // The base is cut at z = 20; the through hole (r 3 about x 24, z 15) lies behind the cap.
    // Its bottom circle, nearest point (24, 0, 18), is seen through the cap.
    const probe = () => page.evaluate(async () => {
      const app = (window as unknown as Win).__parametric;
      const r = app.renderer;
      r.section = { normal: [0, 0, 1], offset: 20 };
      const [x, y] = app.viewport.project([24, 0, 18]);
      const hit = r.pick(x, y, { face: true, edge: true, vertex: true });
      const img = new Image();
      img.src = r.capture(4096)!;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      const k = img.width / r.camera.width;
      const pixel = [...ctx.getImageData(Math.floor(x * k), Math.floor(y * k), 1, 1).data].slice(0, 3);
      return { kind: hit?.kind ?? null, z: hit?.point?.[2] ?? null, pixel, cap: r.theme.cap.map((v) => Math.round(v * 255)) };
    });
    const seen = await probe();
    expect(seen.kind).not.toBe('edge');
    // Picked on the cap (where a zoom closes in or an orbit turns about), not on the hole behind.
    expect(seen.z).toBeCloseTo(20, 1);
    seen.pixel.forEach((v, i) => expect(Math.abs(v - seen.cap[i])).toBeLessThan(25));
  });

  test('the section view shows its cut face only where the part is cut', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: /Mounting Bracket/ }).click();
    await waitForFeature(page, 'Fillet1');
    await expect.poll(() => page.evaluate(() => !!(window as unknown as Win).__parametric.bbox)).toBe(true);
    // Cut at x = 24 (keeping x < 24), seen from the isometric view: the cut face is the base's
    // cross-section there. Nowhere else, such as along the outline of the part, shows its colour.
    const stray = await page.evaluate(async () => {
      const app = (window as unknown as Win).__parametric;
      const r = app.renderer;
      app.viewport.setView('isometric', false);
      r.section = { normal: [1, 0, 0], offset: 24 };
      const img = new Image();
      img.src = r.capture(4096)!;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      const k = img.width / r.camera.width;
      const data = ctx.getImageData(0, 0, img.width, img.height).data;
      // Screen box of the cross-section (with the counterbore it is smaller still), plus a margin.
      const corners = [[24, 0, 0], [24, 8, 0], [24, 8, 30], [24, 0, 30]].map((p) => app.viewport.project(p as [number, number, number]).map((v) => v * k));
      const x0 = Math.min(...corners.map((q) => q[0])) - 3, x1 = Math.max(...corners.map((q) => q[0])) + 3;
      const y0 = Math.min(...corners.map((q) => q[1])) - 3, y1 = Math.max(...corners.map((q) => q[1])) + 3;
      let n = 0;
      for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
        if (x >= x0 && x <= x1 && y >= y0 && y <= y1) continue;
        const i = (y * img.width + x) * 4;
        if (data[i] - Math.max(data[i + 1], data[i + 2]) > 6) n++;
      }
      return n;
    });
    expect(stray).toBe(0);
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
    expect(await normal()).toEqual([0.707, 0.707, 0]);
    await planes.getByRole('button', { name: 'Front' }).click();
    expect(await normal()).toEqual([0, 0, 1]);
    await planes.getByRole('button', { name: 'Current' }).click();
    expect(await normal()).toEqual([0.707, 0.707, 0]);
  });

  for (const next of ['open', 'new'] as const) test(`Previous View does not go back to views of the part before (${next})`, async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: /Mounting Bracket/ }).click();
    await waitForFeature(page, 'Fillet1');
    await page.evaluate(() => { const v = (window as unknown as Win).__parametric.viewport; v.setView('front', false); v.setView('top', false); });
    await page.evaluate(async (next) => {
      const app = (window as unknown as Win).__parametric;
      if (next === 'new') app.newDocument();
      else app.loadDocument({ ...structuredClone(app.store.doc), name: 'Other' }, null);
      await app.whenBuilt();
    }, next);
    await expect.poll(() => page.evaluate(() => !!(window as unknown as Win).__parametric.bbox)).toBe(next === 'open');
    const state = () => page.evaluate(() => JSON.stringify((window as unknown as Win).__parametric.renderer.camera.goal()));
    const before = await state();
    await page.evaluate(() => (window as unknown as Win).__parametric.commands.run('previousView'));
    expect(await state()).toBe(before);
    await expect(page.locator('.view-label')).toHaveText('Trimetric');
  });

  test('Previous View after zooming to fit twice goes back to the view before', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: /Mounting Bracket/ }).click();
    await waitForFeature(page, 'Fillet1');
    await expect.poll(() => page.evaluate(() => !!(window as unknown as Win).__parametric.bbox)).toBe(true);
    const distance = () => page.evaluate(() => (window as unknown as Win).__parametric.renderer.camera.goal().distance);
    await page.evaluate(() => {
      const app = (window as unknown as Win).__parametric;
      app.viewport.setView('front', false);
      app.renderer.camera.zoomAt(0.25, 300, 300);
    });
    const zoomed = await distance();
    await page.evaluate(() => { const v = (window as unknown as Win).__parametric.viewport; v.zoomToFit(false); v.zoomToFit(false); });
    expect(await distance()).not.toBeCloseTo(zoomed, 3);
    await page.evaluate(() => (window as unknown as Win).__parametric.commands.run('previousView'));
    expect(await distance()).toBeCloseTo(zoomed, 6);
  });

  for (const orientation of [null, 'front'] as const) test(`an assistant capture right after it sets a view leaves that view (capture orientation ${orientation})`, async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: /Mounting Bracket/ }).click();
    await waitForFeature(page, 'Fillet1');
    await expect.poll(() => page.evaluate(() => !!(window as unknown as Win).__parametric.bbox)).toBe(true);
    const shot = await page.evaluate(async (orientation) => {
      const path = '/src/app/assistant-host.ts';
      const { appHost } = (await import(/* @vite-ignore */ path)) as typeof import('../../src/app/assistant-host');
      const app = (window as unknown as Win).__parametric;
      const host = appHost(app).ui!;
      app.viewport.setView('trimetric', false);
      // The view turns to Top over a few frames; the capture comes before it gets there.
      host.setView({ orientation: 'top' });
      return !!host.capture(orientation ? { orientation } : {});
    }, orientation);
    expect(shot).toBe(true);
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => (window as unknown as Win).__parametric.renderer.camera.viewName())).toBe('top');
  });

  test('Previous View keeps the perspective projection chosen since', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: /New part/ }).click();
    await page.evaluate(() => (window as unknown as Win).__parametric.viewport.setView('front', false));
    await page.evaluate(() => (window as unknown as Win).__parametric.commands.run('perspective'));
    await page.evaluate(() => (window as unknown as Win).__parametric.commands.run('previousView'));
    await expect(page.locator('.view-label')).toHaveText('Trimetric');
    expect(await page.evaluate(() => (window as unknown as Win).__parametric.renderer.camera.ortho)).toBe(false);
  });

  test('reversing the wheel zoom direction does not reverse a trackpad pinch', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: /New part/ }).click();
    const zoomed = (ctrlKey: boolean) => page.evaluate((ctrlKey) => {
      const app = (window as unknown as Win).__parametric;
      app.viewport.invertZoom = true;
      const cam = app.renderer.camera;
      const before = cam.distance;
      const r = app.viewport.canvas.getBoundingClientRect();
      // Spreading two fingers (or turning the wheel away, which reversed zooms out).
      app.viewport.canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -20, ctrlKey, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true }));
      return cam.distance / before;
    }, ctrlKey);
    expect(await zoomed(true)).toBeLessThan(1);
    expect(await zoomed(false)).toBeGreaterThan(1);
  });

  test('switching to perspective while zoomed in keeps the face in the middle of the view framed', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: /Mounting Bracket/ }).click();
    await waitForFeature(page, 'Fillet1');
    await expect.poll(() => page.evaluate(() => !!(window as unknown as Win).__parametric.bbox)).toBe(true);
    // Front view, orthographic, zoomed far in on the front face of the base (z = 30), in front
    // of the target zoom to fit put in the middle of the part (z = 15).
    const probe = () => page.evaluate(() => {
      const app = (window as unknown as Win).__parametric;
      const cam = app.renderer.camera;
      const p = app.renderer.pick(cam.width / 2, cam.height / 2, { face: true }, 0)?.point ?? null;
      const a = p && cam.project(p), b = p && cam.project([p[0] + 1, p[1], p[2]]);
      return { z: p?.[2] ?? null, pxPerMm: a && b ? Math.hypot(b[0] - a[0], b[1] - a[1]) : null };
    });
    await page.evaluate(() => {
      const app = (window as unknown as Win).__parametric;
      app.viewport.setView('front', false);
      const cam = app.renderer.camera;
      const [x, y] = app.viewport.project([30, 4, 30]);
      cam.pan(cam.width / 2 - x, cam.height / 2 - y);
      cam.zoomAt(1 / 300, cam.width / 2, cam.height / 2);
    });
    const before = await probe();
    expect(before.z).toBeCloseTo(30, 2);
    await page.evaluate(() => (window as unknown as Win).__parametric.commands.run('perspective'));
    const after = await probe();
    expect(after.z).toBeCloseTo(30, 2);
    expect(after.pxPerMm! / before.pxPerMm!).toBeCloseTo(1, 2);
  });

  for (const how of ['wheel', 'keys'] as const) test(`${how === 'wheel' ? 'wheel zoom' : 'zoom keys'} in perspective close in on the face there instead of passing through it`, async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: /Mounting Bracket/ }).click();
    await waitForFeature(page, 'Fillet1');
    // The front face of the base, well in front of the target at the middle of the part: under
    // the pointer, or for the keys (which zoom at the middle of the view) panned to the middle.
    const p: [number, number, number] = [55, 4, 30];
    await expect.poll(() => page.evaluate(([p, how]) => {
      const app = (window as unknown as Win).__parametric;
      if (!app.bbox) return null;
      app.viewport.setView('trimetric', false);
      const cam = app.renderer.camera;
      cam.ortho = false;
      let [x, y] = app.viewport.project(p);
      if (how === 'keys') { cam.pan(cam.width / 2 - x, cam.height / 2 - y); [x, y] = [cam.width / 2, cam.height / 2]; }
      return app.renderer.pick(x, y, { face: true }, 0)?.point?.[2];
    }, [p, how] as const)).toBeCloseTo(30, 1);
    const at = await page.evaluate(([p, how]) => {
      const app = (window as unknown as Win).__parametric;
      const cam = app.renderer.camera;
      const r = app.viewport.canvas.getBoundingClientRect();
      // The pointer is on a whole pixel of the page: zooms keep that point in place.
      let [x, y] = app.viewport.project(p);
      if (how === 'keys') [x, y] = [cam.width / 2, cam.height / 2];
      else [x, y] = [Math.round(r.left + x) - r.left, Math.round(r.top + y) - r.top];
      return { x, y, cx: r.left + x, cy: r.top + y, q: app.renderer.pick(x, y, { face: true }, 0)!.point! };
    }, [p, how] as const);
    if (how === 'wheel') {
      await page.mouse.move(at.cx, at.cy);
      for (let i = 0; i < 25; i++) await page.mouse.wheel(0, -100);
    } else {
      await page.locator('canvas.gl').focus();
      for (let i = 0; i < 25; i++) await page.keyboard.press('+');
    }
    const after = await page.evaluate((q) => {
      const app = (window as unknown as Win).__parametric;
      const cam = app.renderer.camera, e = cam.eye, b = cam.back;
      const [x, y] = app.viewport.project(q);
      const hit = app.renderer.pick(x, y, { face: true });
      return { ahead: -((q[0] - e[0]) * b[0] + (q[1] - e[1]) * b[1] + (q[2] - e[2]) * b[2]), distance: cam.distance, x, y, z: hit?.point?.[2] ?? null };
    }, at.q);
    // Zoomed in a long way, with the face still in front of the eye and where it was on screen.
    expect(after.distance).toBeLessThan(5);
    expect(after.ahead).toBeGreaterThan(0);
    expect(Math.hypot(after.x - at.x, after.y - at.y)).toBeLessThan(2);
    expect(after.z).toBeCloseTo(30, 1);
  });

  test('wireframe picks faces and still picks the edges and vertices behind them', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: /Mounting Bracket/ }).click();
    await waitForFeature(page, 'Fillet1');
    await expect.poll(() => page.evaluate(() => !!(window as unknown as Win).__parametric.bbox)).toBe(true);
    const picks = await page.evaluate(() => {
      const app = (window as unknown as Win).__parametric;
      app.commands.run('style:wireframe');
      app.viewport.setView('trimetric', false);
      const at = (p: [number, number, number], want: { face?: boolean; edge?: boolean; vertex?: boolean }) => {
        const [x, y] = app.viewport.project(p);
        const hit = app.renderer.pick(x, y, want);
        return hit ? { kind: hit.kind, p: hit.kind === 'vertex' ? [...app.vertexAt(hit.index)!] : null, z: hit.point?.[2] ?? null } : null;
      };
      return {
        // The top of the base, picking faces only (as a feature asking for a face does).
        face: at([40, 8, 15], { face: true }),
        // The corner at the back, behind the base.
        vertex: at([0, 0, 0], { face: true, edge: true, vertex: true }),
      };
    });
    expect(picks.face?.kind).toBe('face');
    expect(picks.vertex).toMatchObject({ kind: 'vertex', p: [0, 0, 0] });
  });

  test('picks the pixel under the pointer, not the one above it', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: /Mounting Bracket/ }).click();
    await waitForFeature(page, 'Fillet1');
    await expect.poll(() => page.evaluate(() => !!(window as unknown as Win).__parametric.bbox)).toBe(true);
    const rows = await page.evaluate(() => {
      const app = (window as unknown as Win).__parametric;
      app.viewport.setView('front', false);
      const b = app.bbox!, cam = app.renderer.camera;
      // The top of the upright, seen from the front: put it a quarter pixel above row k's top,
      // so pixel row k (centre at k + 0.5) is on the face and row k - 1 (centre k - 0.5) is not.
      const top: [number, number, number] = [b.min[0] + 2, b.max[1], b.max[2]];
      const [x, y0] = app.viewport.project(top);
      const k = Math.round(y0) + 10;
      cam.pan(0, k - 0.25 - y0);
      const [, y] = app.viewport.project(top);
      const at = (row: number) => app.renderer.pick(Math.floor(x), row, { face: true })?.kind ?? null;
      return { edge: y - k, k: at(k), above: at(k - 1) };
    });
    expect(rows.edge).toBeCloseTo(-0.25, 3);
    expect(rows).toMatchObject({ k: 'face', above: null });
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
    await chooseTheme(page, 'Dark');
    await expect(page.locator('html')).toHaveAttribute('data-theme-resolved', 'dark');
    expect(await contrast()).toBeGreaterThan(4.5);
  });

  test('shown sketches and the selected origin follow the theme', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: /Mounting Bracket/ }).click();
    await waitForFeature(page, 'Fillet1');
    const colours = () => page.evaluate(() => {
      const app = (window as unknown as Win).__parametric;
      const r = app.renderer as unknown as { lines: Map<string, { colors: Uint8Array }>; points: Map<string, { colors: Uint8Array }> };
      const token = getComputedStyle(document.documentElement).getPropertyValue('--sketch-inactive').trim();
      const hex = (c: ArrayLike<number>) => '#' + [0, 1, 2].map((i) => c[i].toString(16).padStart(2, '0')).join('');
      const sel = app.renderer.theme.selection.map((v) => Math.round(v * 255));
      return { sketch: hex(r.lines.get('sketches')!.colors), token, origin: hex(r.points.get('origin')!.colors), selection: hex(sel) };
    });
    await page.evaluate(() => {
      const app = (window as unknown as Win).__parametric;
      const sk = app.store.doc.features.find((f) => f.type === 'sketch')!;
      app.store.change('Show sketch', (d) => { d.features.find((f) => f.id === sk.id)!.hidden = false; });
      app.viewport.showOrigin = true;
      app.selection.set([{ kind: 'origin' }]);
    });
    for (const theme of ['Dark', 'Light']) {
      await chooseTheme(page, theme as 'Light' | 'Dark');
      await expect(page.locator('html')).toHaveAttribute('data-theme-resolved', theme.toLowerCase());
      const c = await colours();
      expect(c.sketch).toBe(c.token);
      expect(c.origin).toBe(c.selection);
    }
  });

  test('the points of a selected sketch are highlighted with its lines', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: /New part/ }).click();
    await page.evaluate(() => {
      const app = (window as unknown as Win).__parametric;
      app.store.change('Add sketch', (doc) => {
        doc.features.push({ id: 's1', name: 'Sketch1', type: 'sketch', plane: { kind: 'base', plane: 'front' }, entities: [
          { id: 'a', t: 'point', x: 0, y: 0 }, { id: 'b', t: 'point', x: 40, y: 0 }, { id: 'l', t: 'line', a: 'a', b: 'b' }, { id: 'p', t: 'point', x: 20, y: 30 },
        ], constraints: [] });
      });
    });
    await expect(page.getByRole('treeitem', { name: 'Sketch1' })).toBeVisible();
    const colours = () => page.evaluate(() => {
      const r = (window as unknown as Win).__parametric.renderer as unknown as { lines: Map<string, { colors: Uint8Array }>; points: Map<string, { colors: Uint8Array }> };
      return { line: [...r.lines.get('sketches')!.colors.slice(0, 3)], point: [...r.points.get('sketchPts')!.colors.slice(0, 3)] };
    });
    await expect.poll(() => page.evaluate(() => (window as unknown as Win).__parametric.renderer.boundsOf(['points:sketchPts']) !== null)).toBe(true);
    const shown = await colours();
    expect(shown.point).toEqual(shown.line);
    await page.evaluate(() => (window as unknown as Win).__parametric.selection.set([{ kind: 'feature', id: 's1' }]));
    const c = await colours();
    expect(c.point).toEqual(c.line);
    expect(c.line).toEqual(await page.evaluate(() => (window as unknown as Win).__parametric.renderer.theme.selection.map((v) => Math.round(v * 255))));
  });

  test('the section view cuts away the points of a shown sketch with its lines', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: /New part/ }).click();
    await page.evaluate(() => {
      const app = (window as unknown as Win).__parametric;
      app.store.change('Add sketch', (doc) => {
        doc.features.push({ id: 's1', name: 'Sketch1', type: 'sketch', plane: { kind: 'base', plane: 'front' }, entities: [{ id: 'p', t: 'point', x: 20, y: 30 }], constraints: [] });
      });
    });
    await expect.poll(() => page.evaluate(() => (window as unknown as Win).__parametric.renderer.boundsOf(['points:sketchPts']) !== null)).toBe(true);
    const pixel = () => page.evaluate(async () => {
      const app = (window as unknown as Win).__parametric;
      const r = app.renderer;
      const [x, y] = app.viewport.project([20, 30, 0]);
      const img = new Image();
      img.src = r.capture(4096)!;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      const k = img.width / r.camera.width;
      const px = [...ctx.getImageData(Math.floor(x * k), Math.floor(y * k), 1, 1).data].slice(0, 3);
      const bg = r.theme.background.map((v) => Math.round(v * 255));
      return Math.max(...px.map((v, i) => Math.abs(v - bg[i])));
    });
    expect(await pixel()).toBeGreaterThan(30);
    // Everything in front of z = 5 is cut away, the sketch on the Front Plane with it.
    await page.evaluate(() => { (window as unknown as Win).__parametric.renderer.section = { normal: [0, 0, -1], offset: -5 }; });
    expect(await pixel()).toBeLessThan(12);
  });

  test('the hover under a resting pointer follows what the active selection box can pick', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: /Mounting Bracket/ }).click();
    await waitForFeature(page, 'Fillet1');
    await expect.poll(() => page.evaluate(() => !!(window as unknown as Win).__parametric.bbox)).toBe(true);
    // A point on the wall of a counterbore (a cylinder, not a planar face).
    const at = await page.evaluate(() => {
      const app = (window as unknown as Win).__parametric;
      const r = app.viewport.canvas.getBoundingClientRect();
      for (let dx = -6; dx <= 6; dx += 0.5) for (let dz = -6; dz <= 6; dz += 0.5) for (const y0 of [4, 5, 6, 7]) {
        const [x, y] = app.viewport.project([24 + dx, y0, 15 + dz]);
        // Clear of edges, which the hover would prefer.
        const hit = app.renderer.pick(Math.round(x), Math.round(y), { face: true, edge: true, vertex: true }, 7);
        if (hit?.kind === 'face' && app.faces[hit.index]?.type === 'cylinder') return [r.left + Math.round(x), r.top + Math.round(y)];
      }
      return null;
    });
    expect(at).not.toBeNull();
    await page.mouse.move(at![0], at![1]);
    await page.mouse.move(at![0] + 1, at![1]);
    await expect.poll(() => page.evaluate(() => (window as unknown as Win).__parametric.selection.hover?.kind ?? null)).toBe('face');
    // Mirror starts on its plane box, which takes planar faces only; the pointer does not move.
    const hover = () => page.evaluate(() => (window as unknown as Win).__parametric.selection.hover?.kind ?? null);
    await page.evaluate(() => (window as unknown as Win).__parametric.commands.run('mirror'));
    await expect.poll(hover).toBeNull();
    // Tabbing to the features box, which takes any face, picks the face again.
    await page.getByRole('group', { name: 'Features to mirror' }).focus();
    await expect.poll(hover).toBe('face');
    await page.getByRole('group', { name: 'Mirror plane' }).focus();
    await expect.poll(hover).toBeNull();
  });

  test('a pointer leaving the view before its hover is picked leaves nothing hovered', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: /Mounting Bracket/ }).click();
    await waitForFeature(page, 'Fillet1');
    await expect.poll(() => page.evaluate(() => !!(window as unknown as Win).__parametric.bbox)).toBe(true);
    const hovered = () => page.evaluate(() => (window as unknown as Win).__parametric.selection.hover?.kind ?? null);
    // A fast move off the canvas: the move and the leave arrive in one frame.
    const move = (leave: boolean) => page.evaluate((leave) => {
      const app = (window as unknown as Win).__parametric;
      const c = app.viewport.canvas;
      const r = c.getBoundingClientRect();
      const [x, y] = app.viewport.project([30, 3, 25]);
      c.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, pointerType: 'mouse', clientX: r.left + x, clientY: r.top + y, bubbles: true }));
      if (leave) c.dispatchEvent(new PointerEvent('pointerleave', { pointerId: 1, pointerType: 'mouse', clientX: r.left - 50, clientY: r.top + y }));
    }, leave);
    await move(false);
    await expect.poll(hovered).toBe('face');
    await page.evaluate(() => (window as unknown as Win).__parametric.viewport.canvas.dispatchEvent(new PointerEvent('pointerleave', { pointerId: 1, pointerType: 'mouse' })));
    await expect.poll(hovered).toBe(null);
    await move(true);
    await page.waitForTimeout(400);
    expect(await hovered()).toBe(null);
  });

  test('the section view does not cut the outlines of reference planes', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: /Mounting Bracket/ }).click();
    await waitForFeature(page, 'Fillet1');
    await expect.poll(() => page.evaluate(() => !!(window as unknown as Win).__parametric.bbox)).toBe(true);
    const d = await page.evaluate(() => {
      const app = (window as unknown as Win).__parametric;
      const r = app.renderer;
      app.viewport.showPlanes = true;
      app.viewport.drawReferenceGeometry();
      r.section = { normal: [1, 0, 0], offset: 30 };
      // Midpoints of outline segments wholly on the cut-away side, on screen.
      const pos = (r as unknown as { lines: Map<string, { positions: Float32Array }> }).lines.get('planes')!.positions;
      const mids: [number, number][] = [];
      for (let i = 0; i < pos.length; i += 6) {
        if (pos[i] < 40 || pos[i + 3] < 40) continue;
        const [x, y] = app.viewport.project([(pos[i] + pos[i + 3]) / 2, (pos[i + 1] + pos[i + 4]) / 2, (pos[i + 2] + pos[i + 5]) / 2]);
        if (x > 5 && y > 5 && x < r.camera.width - 5 && y < r.camera.height - 5) mids.push([x, y]);
      }
      r.capture(16);
      const gl = r.gl, k = r.dpr;
      const edge = [0.44, 0.6, 0.88].map((v) => v * 255);
      return mids.map(([x, y]) => {
        const data = new Uint8Array(5 * 5 * 4);
        gl.readPixels(Math.round(x * k) - 2, r.canvas.height - Math.round(y * k) - 3, 5, 5, gl.RGBA, gl.UNSIGNED_BYTE, data);
        let best = Infinity;
        for (let i = 0; i < data.length; i += 4) best = Math.min(best, Math.hypot(data[i] - edge[0], data[i + 1] - edge[1], data[i + 2] - edge[2]));
        return best;
      });
    });
    expect(d.length).toBeGreaterThan(0);
    for (const v of d) expect(v).toBeLessThan(40);
  });

  test('the triad is hidden from assistive technology and names the shortcut of each axis view', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: /Mounting Bracket/ }).click();
    await waitForFeature(page, 'Fillet1');
    const triad = page.locator('svg.triad');
    await expect(triad).toHaveAttribute('aria-hidden', 'true');
    await expect(triad).not.toHaveAttribute('role', /./);
    const mac = await page.evaluate(() => /Mac/.test(navigator.platform));
    await expect(triad.locator('[data-axis="x"] > title')).toHaveText(`Look along X: Right view (${mac ? '⌘4' : 'Ctrl+4'})`);
    await expect(triad.locator('[data-axis="y"] > title')).toHaveText(/Top view/);
    await expect(triad.locator('[data-axis="z"] > title')).toHaveText(/Front view/);
    // The named shortcut gives the view clicking the axis does.
    await page.locator('canvas.gl').focus();
    await page.keyboard.press(mac ? 'Meta+4' : 'Control+4');
    await expect(page.locator('.view-label')).toHaveText('Right');
    await triad.locator('[data-axis="y"] line').last().click({ force: true });
    await expect(page.locator('.view-label')).toHaveText('Top');
  });

  test('the triad letters are readable in both themes', async ({ page }) => {
    await openApp(page);
    await expect(page.locator('.triad text')).toHaveCount(3);
    const contrasts = () => page.evaluate(() => {
      const rgb = (s: string) => (s.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map((v) => Number(v) / 255);
      const lum = (c: number[]) => { const l = c.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2]; };
      const bg = lum(rgb(getComputedStyle(document.querySelector('.viewport')!).backgroundColor));
      return [...document.querySelectorAll('.triad text')].map((t) => {
        const [a, b] = [lum(rgb(getComputedStyle(t).fill)), bg].sort((x, y) => y - x);
        return (a + 0.05) / (b + 0.05);
      });
    });
    for (const theme of ['Light', 'Dark']) {
      await chooseTheme(page, theme as 'Light' | 'Dark');
      await expect(page.locator('html')).toHaveAttribute('data-theme-resolved', theme.toLowerCase());
      for (const c of await contrasts()) expect(c).toBeGreaterThanOrEqual(4.5);
    }
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

  test('edges picked for a fillet stay highlighted over its preview', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: /Mounting Bracket/ }).click();
    await waitForFeature(page, 'Fillet1');
    await expect.poll(() => page.evaluate(() => !!(window as unknown as Win).__parametric.bbox)).toBe(true);
    await page.evaluate(() => (window as unknown as Win).__parametric.commands.run('fillet'));
    // A long straight edge in view, picked from the screen.
    const p = await page.evaluate(() => {
      const app = (window as unknown as Win).__parametric;
      for (const e of app.edges) {
        if (e.type !== 'line' || e.length < 20) continue;
        const [x, y] = app.viewport.project(e.mid);
        if (app.renderer.pick(x, y, { edge: true })?.kind === 'edge') return [x, y];
      }
      return null;
    });
    expect(p).not.toBeNull();
    const box = (await page.locator('canvas.gl').boundingBox())!;
    await page.mouse.click(box.x + p![0], box.y + p![1]);
    await page.mouse.move(box.x + 4, box.y + box.height / 2);
    await expect.poll(() => page.evaluate(() => (window as unknown as Win).__parametric.renderer.hasPreviewBody), { timeout: 30_000 }).toBe(true);
    // The pixel nearest the selection colour around where the edge was picked,
    // read straight after a draw (a JPEG capture blurs a thin line).
    const d = await page.evaluate(([x, y]) => {
      const r = (window as unknown as Win).__parametric.renderer;
      r.capture(16);
      const gl = r.gl, k = r.dpr;
      const data = new Uint8Array(7 * 7 * 4);
      gl.readPixels(Math.round(x * k) - 3, r.canvas.height - Math.round(y * k) - 4, 7, 7, gl.RGBA, gl.UNSIGNED_BYTE, data);
      const sel = r.theme.selection.map((v) => v * 255);
      let best = Infinity;
      for (let i = 0; i < data.length; i += 4) best = Math.min(best, Math.hypot(data[i] - sel[0], data[i + 1] - sel[1], data[i + 2] - sel[2]));
      return best;
    }, p!);
    expect(d).toBeLessThan(40);
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

  test('zoom to fit in a new, empty sketch keeps a view of a useful size', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: /New part/ }).click();
    await page.getByRole('treeitem', { name: 'Front Plane' }).click();
    await page.evaluate(() => (window as unknown as Win).__parametric.commands.run('sketch'));
    await expect(page.locator('.statusbar')).toContainText('Editing sketch');
    // Only the sketch origin is drawn: a point, not something to zoom in on.
    const height = await page.evaluate(() => {
      const app = (window as unknown as Win).__parametric;
      app.viewport.zoomToFit(false);
      const cam = app.renderer.camera;
      return cam.pixelSize * cam.height;
    });
    expect(height).toBeGreaterThan(20);
    expect(height).toBeLessThan(1000);
  });

  test('opening a part that has only sketches frames them', async ({ page }) => {
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
      const cam = app.renderer.camera;
      return [[300, 200, 0], [800, 500, 0]].every((p) => {
        const [x, y] = app.viewport.project(p as [number, number, number]);
        return x >= 0 && x <= cam.width && y >= 0 && y <= cam.height;
      });
    })).toBe(true);
  });

  test('zoom to fit frames the sketches shown beside the solid', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: /Mounting Bracket/ }).click();
    await waitForFeature(page, 'Fillet1');
    // A part with a sketch no feature uses, far to the right of the solid, opened.
    await page.evaluate(() => {
      const app = (window as unknown as Win).__parametric;
      const doc = structuredClone(app.store.doc);
      doc.features.push({ id: 's9', name: 'Sketch9', type: 'sketch', plane: { kind: 'base', plane: 'front' }, entities: [{ id: 'c', t: 'point', x: 400, y: 0 }, { id: 'k', t: 'circle', c: 'c', r: 20 }], constraints: [] });
      app.loadDocument(doc, null);
    });
    await expect(page.getByRole('treeitem', { name: 'Sketch9' })).toBeVisible();
    const framed = () => page.evaluate(() => {
      const app = (window as unknown as Win).__parametric;
      const cam = app.renderer.camera;
      return [[0, 0, 0], [60, 40, 30], [420, 0, 0], [380, -20, 0]].every((p) => {
        const [x, y] = app.viewport.project(p as [number, number, number]);
        return x >= 0 && x <= cam.width && y >= 0 && y <= cam.height;
      });
    });
    await expect.poll(() => page.evaluate(() => !!(window as unknown as Win).__parametric.bbox)).toBe(true);
    await expect.poll(framed).toBe(true);
    await page.evaluate(() => { const app = (window as unknown as Win).__parametric; app.viewport.setView('front', false); app.renderer.camera.zoomAt(0.2, 0, 0); });
    expect(await framed()).toBe(false);
    await page.evaluate(() => (window as unknown as Win).__parametric.viewport.zoomToFit(false));
    expect(await framed()).toBe(true);
    // Also while that sketch is being edited (it is drawn by the sketch editor then).
    await page.evaluate(() => (window as unknown as Win).__parametric.editSketch('s9'));
    await expect(page.locator('.statusbar')).toContainText('Under Defined');
    await page.evaluate(() => { const app = (window as unknown as Win).__parametric; app.viewport.setView('front', false); app.renderer.camera.zoomAt(0.2, 0, 0); });
    expect(await framed()).toBe(false);
    await page.evaluate(() => (window as unknown as Win).__parametric.viewport.zoomToFit(false));
    expect(await framed()).toBe(true);
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

  test('Control-click on macOS opens the context menu of what is under the pointer', async ({ page }) => {
    await openApp(page);
    // Headless Chromium reports macOS.
    test.skip(!(await page.evaluate(() => /Mac/.test(navigator.platform))), 'macOS only');
    const [x, y] = await countDoubleClicks(page);
    for (let i = 0; i < 2; i++) {
      await page.keyboard.down('Control');
      await page.mouse.click(x, y);
      await page.keyboard.up('Control');
      await expect(page.getByRole('menu', { name: 'Context menu' })).toBeVisible();
      await page.keyboard.press('Escape');
    }
    expect(await page.evaluate(() => (window as unknown as Win).__parametric.selection.items.map((it) => it.kind))).toEqual(['face']);
    // Two of them in a row are not a double click.
    expect(await page.evaluate(() => (window as unknown as { __dbl: number }).__dbl)).toBe(0);
  });

  test('orbiting right after a click is not a double click', async ({ page }) => {
    await openApp(page);
    const [x, y] = await countDoubleClicks(page);
    await page.mouse.click(x, y);
    // The second press within the double-click time drags: the browser still counts it as a
    // second click and sends a dblclick on release.
    const cdp = await page.context().newCDPSession(page);
    const send = (type: string, px: number, py: number, extra: object) => cdp.send('Input.dispatchMouseEvent', { type: type as 'mouseMoved', x: px, y: py, button: 'left', ...extra });
    await send('mousePressed', x, y, { clickCount: 2, buttons: 1 });
    for (let i = 1; i <= 8; i++) await send('mouseMoved', x + i * 10, y + i * 3, { buttons: 1 });
    await send('mouseReleased', x + 80, y + 24, { clickCount: 2, buttons: 0 });
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => (window as unknown as { __dbl: number }).__dbl)).toBe(0);
    // A real double click afterwards still counts.
    await page.mouse.dblclick(x + 80, y + 24);
    await expect.poll(() => page.evaluate(() => (window as unknown as { __dbl: number }).__dbl)).toBe(1);
  });

  for (const tool of ['line', 'rectangle']) test(`a pinch started while sketching with the ${tool} tool draws nothing`, async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: /New part/ }).click();
    await page.getByRole('treeitem', { name: 'Front Plane' }).click();
    await page.getByRole('tab', { name: 'Sketch' }).click();
    await page.locator('[data-cmd="sketch"]').first().click();
    await expect(page.locator('.view-label')).toHaveText('Front');
    const count = await page.evaluate((tool) => {
      const app = (window as unknown as Win).__parametric;
      app.commands.run(`tool:${tool}`);
      const c = document.querySelector('canvas.gl') as HTMLCanvasElement;
      // Synthetic pointers cannot be captured; the gesture logic is what is under test.
      c.setPointerCapture = () => {};
      c.releasePointerCapture = () => {};
      const r = c.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const P = (type: string, id: number, x: number, y: number) => c.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', clientX: x, clientY: y, bubbles: true, buttons: type === 'pointerup' ? 0 : 1 }));
      // Two fingers land a moment apart and spread: a pinch zoom.
      P('pointerdown', 21, cx - 40, cy - 40);
      P('pointerdown', 22, cx + 40, cy + 40);
      P('pointermove', 21, cx - 80, cy - 80);
      P('pointermove', 22, cx + 80, cy + 80);
      P('pointerup', 21, cx - 80, cy - 80);
      P('pointerup', 22, cx + 80, cy + 80);
      return app.sketchEditor!.sketch.entities.filter((e) => e.t !== 'point').length;
    }, tool);
    expect(count).toBe(0);
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

    test('a pinch zoom with wobbling fingers keeps the view upright, a clear twist rolls it', async ({ page }) => {
      await openApp(page);
      await page.getByRole('button', { name: /Mounting Bracket/ }).click();
      await waitForFeature(page, 'Fillet1');
      await page.evaluate(() => (window as unknown as Win).__parametric.viewport.setView('front', false));
      const gesture = (turn: number, wobble: number) => page.evaluate(([turn, wobble]) => {
        const c = document.querySelector('canvas.gl') as HTMLCanvasElement;
        // Synthetic pointers cannot be captured; the gesture logic is what is under test.
        c.setPointerCapture = () => {};
        c.releasePointerCapture = () => {};
        const r = c.getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        const P = (type: string, id: number, x: number, y: number) => c.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', clientX: x, clientY: y, bubbles: true, buttons: type === 'pointerup' ? 0 : 1 }));
        const at = (i: number, k: number) => {
          // Spreading from 60 to 140 px apart while turning by `turn`, each finger off by up to `wobble` px.
          const half = 30 + i, a = (turn * k) / 40 + (i % 2 ? 1 : -1) * Math.atan2(wobble, half);
          return [cx + Math.cos(a) * half, cy + Math.sin(a) * half, cx - Math.cos(a) * half, cy - Math.sin(a) * half];
        };
        let p = at(0, 0);
        P('pointerdown', 21, p[0], p[1]);
        P('pointerdown', 22, p[2], p[3]);
        for (let i = 1; i <= 40; i++) { p = at(i, i); P('pointermove', 21, p[0], p[1]); P('pointermove', 22, p[2], p[3]); }
        P('pointerup', 21, p[0], p[1]);
        P('pointerup', 22, p[2], p[3]);
        const cam = (window as unknown as Win).__parametric.renderer.camera;
        return { view: cam.viewName(), upX: cam.up[0] };
      }, [turn, wobble]);
      expect(await gesture(0, 1.5)).toMatchObject({ view: 'front' });
      const twisted = await gesture(Math.PI / 4, 0);
      expect(twisted.view).toBeNull();
      expect(Math.abs(twisted.upX)).toBeGreaterThan(0.3);
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

test('the View Orientation menu checks the standard view the model is seen from', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  await page.locator('canvas.gl').focus();
  await page.keyboard.press('Space');
  const menu = page.getByRole('menu', { name: 'View orientation' });
  await expect(menu.getByRole('menuitemradio', { name: 'Trimetric' })).toHaveAttribute('aria-checked', 'true');
  await expect(menu.getByRole('menuitemradio', { checked: true })).toHaveCount(1);
  await expect(menu.getByRole('menuitem', { name: 'Normal To' })).toBeVisible();
  await menu.getByRole('menuitemradio', { name: 'Front' }).click();
  await expect(page.locator('.view-label')).toHaveText('Front');
  await page.locator('canvas.gl').focus();
  await page.keyboard.press('Space');
  await expect(menu.getByRole('menuitemradio', { name: 'Front' })).toHaveAttribute('aria-checked', 'true');
  await expect(menu.getByRole('menuitemradio', { checked: true })).toHaveCount(1);
});
