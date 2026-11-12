import { expect, test, type Page } from '@playwright/test';
import { boot, canvasClick, canvasDrag, client, compositePixel, idle, openImage, run, tool } from './helpers';

test.beforeEach(async ({ page }) => {
  await boot(page);
  await openImage(page, 400, 300, '#ffffff');
});

// An arch from (80, 200) over (200, 80) to (320, 200), as the work path.
async function workArc(page: Page) {
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { setActive } = await import('/src/features/vector/state.ts');
    const k = 0.5522847498307936 * 120;
    const knot = (x: number, y: number, ix: number, iy: number, ox: number, oy: number) => ({ linked: true, points: [ix, iy, x, y, ox, oy] });
    e.command('Work Path', (d) => {
      d.workPath = {
        paths: [{ open: true, operation: 'combine', fillRule: 'non-zero', knots: [knot(80, 200, 80, 200, 80, 200 - k), knot(200, 80, 200 - k, 80, 200 + k, 80), knot(320, 200, 320, 200 - k, 320, 200)] }],
      };
    });
    setActive(e, 'work');
    e.update();
  });
  await idle(page);
}

// Darkest pixel in a small square around a document point.
async function darkest(page: Page, x: number, y: number, r = 4) {
  return page.evaluate(
    async ([x, y, r]) => {
      const e = window.photoStudio;
      await e.renderer.settle();
      const { compositeRGBA } = await import('/src/features/pixels.ts');
      const img = await compositeRGBA(e);
      let min = 255;
      for (let j = Math.round(y - r); j <= Math.round(y + r); j++)
        for (let i = Math.round(x - r); i <= Math.round(x + r); i++) {
          const k = (j * img.width + i) * 4;
          min = Math.min(min, img.data[k], img.data[k + 1], img.data[k + 2]);
        }
      return min;
    },
    [x, y, r] as const,
  );
}

// Centers of the glyphs as laid out (document coordinates).
async function glyphCenters(page: Page) {
  return page.evaluate(async () => {
    const e = window.photoStudio;
    const l = e.layer!;
    const { layoutOf, ppiOf, toDoc } = await import('/src/features/type/text-utils.ts');
    const layout = layoutOf(l.textData!, ppiOf(e));
    return layout.runs.map((r) => {
      const a = r.angle ?? 0;
      // Middle of the glyph box, a third of the ascent above the baseline.
      const u = r.width / 2, v = -r.ascent / 3;
      return toDoc(l, r.x + u * Math.cos(a) - v * Math.sin(a), r.y + u * Math.sin(a) + v * Math.cos(a));
    });
  });
}

test('type on a path follows the curve and stays editable', async ({ page }) => {
  await workArc(page);
  await tool(page, 'Horizontal Type Tool');
  // Hovering the path shows the path type cursor.
  const [hx, hy] = await client(page, 200, 80);
  await page.mouse.move(hx, hy);
  await expect.poll(() => page.evaluate(() => (document.querySelector('#viewport') as HTMLElement).style.cursor)).toContain('data:image/svg+xml');
  // Click near the left end of the arc and type.
  await canvasClick(page, 92, 148);
  await page.keyboard.type('Over the arch and down');
  await page.keyboard.press('Escape');
  await idle(page);
  const data = await page.evaluate(() => window.photoStudio.layer!.textData!);
  expect(data.path?.kind).toBe('path');
  expect(data.path!.start).toBeGreaterThan(0.05);
  expect(await page.evaluate(() => window.photoStudio.history.labels.at(-1))).toBe('Type Tool');
  await page.screenshot({ path: test.info().outputPath('type-path.png') });
  // Ink lies along the curve: every glyph is drawn where the layout puts it,
  // and the glyphs climb then descend.
  const centers = await glyphCenters(page);
  expect(centers.length).toBeGreaterThan(10);
  for (const [x, y] of centers.filter((_, i) => ![3, 7].includes(i))) expect(await darkest(page, x, y, 5)).toBeLessThan(140);
  const ys = centers.map((c) => c[1]);
  expect(Math.min(...ys)).toBeLessThan(ys[0] - 40);
  expect(ys.at(-1)!).toBeGreaterThan(Math.min(...ys) + 10);
  // Nothing is drawn where straight text from the click point would be.
  expect(await darkest(page, 300, 150, 6)).toBe(255);
  // Clicking the text again edits it in place: the caret lands on the curve.
  await canvasClick(page, ...(centers[2] as [number, number]));
  const editing = await page.evaluate(() => (window as unknown as { photoStudioType: { session?: { focus: number } } }).photoStudioType.session?.focus);
  expect(editing).toBeGreaterThan(0);
  await page.keyboard.press('End');
  await page.keyboard.type('!');
  await page.keyboard.press('Escape');
  await idle(page);
  expect(await page.evaluate(() => window.photoStudio.layer!.text)).toBe('Over the arch and down!');
  // Outlines follow the curve too: the work path spans the placed glyphs.
  await run(page, 'type.create-work-path');
  const [path, frame] = await page.evaluate(async () => {
    const e = window.photoStudio;
    const { vectorBounds } = await import('/src/model/vector.ts');
    return [vectorBounds(e.doc.workPath!), e.layer!.transform];
  });
  expect(path!.width).toBeGreaterThan(frame.width * 0.85);
  expect(Math.abs(path!.y - frame.y)).toBeLessThan(12);
  await run(page, 'type.convert-to-shape');
  expect(await page.evaluate(() => window.photoStudio.layer!.kind)).toBe('vector');
});

test('path selection drags the start marker and flips the text', async ({ page }) => {
  await workArc(page);
  await tool(page, 'Horizontal Type Tool');
  await canvasClick(page, 92, 148);
  await page.keyboard.type('Flip');
  await page.keyboard.press('Escape');
  await idle(page);
  const before = await page.evaluate(() => window.photoStudio.layer!.textData!.path!);
  await tool(page, 'Path Selection Tool');
  // The start marker sits on the path where the text begins.
  const startPoint = await page.evaluate(async () => {
    const { pathGeometry, pointAt } = await import('/src/imaging/text/path-text.ts');
    const { toDoc } = await import('/src/features/type/text-utils.ts');
    const l = window.photoStudio.layer!;
    const p = l.textData!.path!;
    const g = pathGeometry(p.knots, p.closed);
    const q = pointAt(g, p.start * g.length);
    return toDoc(l, q.x, q.y);
  });
  // Along the path toward the top, then across it (into the arch) to flip.
  await canvasDrag(page, [startPoint as [number, number], [120, 118], [150, 98]]);
  const moved = await page.evaluate(() => window.photoStudio.layer!.textData!.path!);
  expect(moved.start).toBeGreaterThan(before.start + 0.05);
  expect(moved.flip).toBe(false);
  expect(await page.evaluate(() => window.photoStudio.history.labels.at(-1))).toBe('Move Type on Path');
  const at = await page.evaluate(async () => {
    const { pathGeometry, pointAt } = await import('/src/imaging/text/path-text.ts');
    const l = window.photoStudio.layer!;
    const p = l.textData!.path!;
    const g = pathGeometry(p.knots, p.closed);
    const q = pointAt(g, p.start * g.length);
    return [q.x, q.y];
  });
  await canvasDrag(page, [at as [number, number], [at[0] + 20, at[1] + 30]]);
  expect(await page.evaluate(() => window.photoStudio.layer!.textData!.path!.flip)).toBe(true);
  expect(await page.evaluate(() => window.photoStudio.history.labels.at(-1))).toBe('Flip Type on Path');
  await page.screenshot({ path: test.info().outputPath('type-path-flip-dark.png') });
  await run(page, 'window.theme-light');
  await page.screenshot({ path: test.info().outputPath('type-path-flip-light.png') });
});

test('area type flows inside a closed path; arc text converts point text', async ({ page }) => {
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { setActive } = await import('/src/features/vector/state.ts');
    const c = (x: number, y: number) => ({ linked: false, points: [x, y, x, y, x, y] });
    e.command('Work Path', (d) => {
      d.workPath = { paths: [{ open: false, operation: 'combine', fillRule: 'non-zero', knots: [c(60, 40), c(340, 40), c(200, 260)] }] };
    });
    setActive(e, 'work');
    e.update();
  });
  await idle(page);
  await tool(page, 'Horizontal Type Tool');
  await canvasClick(page, 200, 100);
  await page.keyboard.type('Words pour into the triangle and wrap along its sloping sides until it is full');
  await page.keyboard.press('Escape');
  await idle(page);
  const lines = await page.evaluate(async () => {
    const e = window.photoStudio;
    const { layoutOf, ppiOf } = await import('/src/features/type/text-utils.ts');
    const layout = layoutOf(e.layer!.textData!, ppiOf(e));
    return layout.lines.filter((l) => l.visible).map((l) => ({ x: l.x, y: l.y, w: l.width }));
  });
  expect(await page.evaluate(() => window.photoStudio.layer!.textData!.path!.kind)).toBe('area');
  expect(lines.length).toBeGreaterThan(2);
  // Each line fits the triangle's width at its baseline.
  for (const l of lines) {
    const half = ((260 - l.y) / 220) * 140;
    expect(l.x).toBeGreaterThanOrEqual(200 - half - 1);
    expect(l.x + l.w).toBeLessThanOrEqual(200 + half + 1);
  }
  expect(lines[0].w).toBeGreaterThan(lines.at(-1)!.w);

  // Point text -> Arch.
  await page.evaluate(async () => {
    const { setActive } = await import('/src/features/vector/state.ts');
    setActive(window.photoStudio, 'none');
  });
  await canvasClick(page, 40, 270);
  await page.keyboard.type('ARCHED');
  await page.keyboard.press('Escape');
  await idle(page);
  await run(page, 'type.arc-arch');
  const arc = await page.evaluate(() => window.photoStudio.layer!.textData!.path!);
  expect(arc.kind).toBe('path');
  expect(arc.arc?.preset).toBe('arch');
  expect(await page.evaluate(() => window.photoStudio.history.labels.at(-1))).toBe('Convert to Arc Text');
  const px = await compositePixel(page, 5, 5);
  expect(px[0]).toBe(255);
  await page.screenshot({ path: test.info().outputPath('type-area-arc.png') });
});

test('cancelling Path Type Options while editing leaves no undo step behind', async ({ page }) => {
  await workArc(page);
  await tool(page, 'Horizontal Type Tool');
  await canvasClick(page, 92, 148);
  await page.keyboard.type('Arch');
  const session = () =>
    page.evaluate(async () => {
      const s = (window as unknown as { photoStudioType: typeof import('../../src/features/type/session') }).photoStudioType.currentSession()!;
      const { plainText } = await import('/src/imaging/text/model.ts');
      return { text: plainText(s.data.content), start: s.data.path!.start };
    });
  const before = await session();
  await page.evaluate(() => void window.photoStudio.runCommand('type.path-options'));
  const dialog = page.locator('dialog[open]');
  await dialog.locator('input[name="start"]').fill('40');
  await expect.poll(async () => (await session()).start).toBeCloseTo(0.4, 5);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  expect(await session()).toEqual(before);
  // The first undo removes the typing.
  await page.keyboard.press('Meta+z');
  expect((await session()).text).toBe('');
});
