import { expect, test, type Page } from '@playwright/test';
import {
  boot,
  canvasClick,
  canvasDrag,
  historyLabels,
  idle,
  openImage,
  run,
  tool,
  undo,
} from './helpers';

test.beforeEach(async ({ page }) => {
  await boot(page);
  await openImage(page, 600, 400, '#ffffff');
});

async function typeText(page: Page, x: number, y: number, ...lines: string[]) {
  await tool(page, 'Horizontal Type Tool');
  await canvasClick(page, x, y);
  for (const [i, l] of lines.entries()) {
    if (i) await page.keyboard.press('Enter');
    await page.keyboard.type(l);
  }
  await page.keyboard.press('Escape');
  await idle(page);
}

// The selected text layer's fit, layout summary and frame.
async function state(page: Page) {
  return page.evaluate(async () => {
    const e = window.photoStudio;
    const l = e.layer!;
    const { layoutOf, ppiOf, toDoc } = await import('/src/features/type/text-utils.ts');
    const d = l.textData!;
    const lay = layoutOf(d, ppiOf(e));
    return {
      fit: d.fit,
      path: d.path,
      block: d.block,
      text: l.text,
      origin: d.origin,
      frame: l.textFrame,
      fitBox: lay.fitBox,
      lines: lay.lines.filter((x) => x.visible).map((x) => ({ width: x.width, x: x.x })),
      glyphs: lay.runs.length,
      size: lay.runs[0]?.sizePx ?? 0,
      centers: lay.runs.map((r) =>
        toDoc(
          l,
          r.x + (r.width / 2) * Math.cos(r.angle ?? 0),
          r.y + (r.width / 2) * Math.sin(r.angle ?? 0),
        ).map((v) => Math.round(v * 10) / 10),
      ),
      transform: l.transform,
    };
  });
}

test('dynamic block text refits when the text is edited and the box is resized', async ({
  page,
}) => {
  await typeText(page, 60, 150, 'THE BIG SUMMER SALE');
  await run(page, 'type.fit-block');
  let s = await state(page);
  expect(s.fit).toMatchObject({ shape: 'block', autoLines: true });
  expect((await historyLabels(page)).at(-1)).toBe('Convert to Dynamic Text');
  // The frame is the box; every line spans its width.
  expect(s.frame!.width).toBeCloseTo(s.fit!.width, 3);
  expect(s.frame!.height).toBeCloseTo(s.fit!.height!, 3);
  for (const l of s.lines) expect(l.width).toBeCloseTo(s.fit!.width, 1);
  const oneLine = s.lines.length;
  const height = s.fit!.height!;

  // Stretching the layer three times taller refits: more, smaller lines.
  await page.evaluate(() => {
    const e = window.photoStudio;
    e.command('Transform', (d) => {
      const l = d.layers.find((x) => x.id === e.layer!.id)!;
      l.transform = {
        ...l.transform,
        y: l.transform.y - l.transform.height,
        height: l.transform.height * 3,
      };
    });
  });
  await idle(page);
  s = await state(page);
  expect(s.fit!.height).toBeCloseTo(height * 3, 3);
  expect(s.lines.length).toBeGreaterThan(oneLine);
  expect(s.text).toBe('THE BIG SUMMER SALE');
  for (const l of s.lines) expect(l.width).toBeLessThanOrEqual(s.fit!.width + 0.5);
  // Not stretched: the transform maps the frame one to one.
  expect(s.transform.width).toBeCloseTo(s.frame!.width, 3);
  expect(s.transform.height).toBeCloseTo(s.frame!.height, 3);

  // Editing the text refits it within the same box.
  const box = s.fit!;
  await run(page, 'type.edit');
  await page.keyboard.press('Meta+ArrowDown');
  await page.keyboard.type(' NOW');
  await page.keyboard.press('Escape');
  await idle(page);
  s = await state(page);
  expect(s.text).toBe('THE BIG SUMMER SALE NOW');
  expect(s.fit!.width).toBeCloseTo(box.width, 3);
  expect(s.fit!.height).toBeCloseTo(box.height!, 3);
  for (const l of s.lines) expect(l.width).toBeLessThanOrEqual(box.width + 0.5);

  // Dragging the box's right handle while editing makes it wider: one undo step.
  await run(page, 'type.edit');
  const before = (await historyLabels(page)).length;
  const [hx, hy] = await page.evaluate(async () => {
    const e = window.photoStudio;
    const { toDoc } = await import('/src/features/type/text-utils.ts');
    const d = e.layer!.textData!;
    return toDoc(e.layer!, d.origin.x + d.fit!.width, d.origin.y + d.fit!.height! / 2);
  });
  await canvasDrag(page, [
    [hx, hy],
    [hx + 60, hy],
  ]);
  await page.keyboard.press('Escape');
  await idle(page);
  s = await state(page);
  expect(s.fit!.width).toBeGreaterThan(box.width + 40);
  expect((await historyLabels(page)).length).toBe(before + 1);
});

test('curved dynamic text fills its curve, changes shape and releases unchanged', async ({
  page,
}) => {
  await typeText(page, 150, 200, 'ROUND AND ROUND');
  const plain = await state(page);
  await run(page, 'type.fit-arch');
  let s = await state(page);
  expect(s.fit).toMatchObject({ shape: 'arch' });
  expect(s.path).toBeUndefined();
  expect(s.glyphs).toBe('ROUNDANDROUND'.length);
  // The type keeps about its size when converted.
  expect(s.size / plain.size).toBeGreaterThan(0.75);
  expect(s.size / plain.size).toBeLessThan(1.33);
  const box = s.fit!;

  // Another shape keeps the box; one undo step goes back.
  await run(page, 'type.fit-circle');
  s = await state(page);
  expect(s.fit).toMatchObject({ shape: 'circle', width: box.width, height: box.height });
  await undo(page);
  expect((await state(page)).fit!.shape).toBe('arch');
  await run(page, 'type.fit-circle');

  // More text: smaller type, still every glyph on the circle.
  const size = (await state(page)).size;
  await run(page, 'type.edit');
  await page.keyboard.press('Meta+ArrowDown');
  await page.keyboard.type(' AGAIN');
  await page.keyboard.press('Escape');
  await idle(page);
  s = await state(page);
  expect(s.size).toBeLessThan(size);
  expect(s.glyphs).toBe('ROUNDANDROUNDAGAIN'.length);

  // Release: ordinary circle text in the same place.
  const fitted = s.centers;
  await run(page, 'type.release-fit');
  s = await state(page);
  expect(s.fit).toBeUndefined();
  expect(s.path?.arc?.preset).toBe('circle');
  expect((await historyLabels(page)).at(-1)).toBe('Release Fit');
  s.centers.forEach((c, i) => {
    expect(Math.abs(c[0] - fitted[i][0])).toBeLessThan(0.6);
    expect(Math.abs(c[1] - fitted[i][1])).toBeLessThan(0.6);
  });
  // Released text is edited with Path Type Options again.
  expect(
    await page.evaluate(
      async () => (await import('/src/app/registry.ts')).commands.get('type.path-options')!.label,
    ),
  ).toBe('Path Type Options…');
});

test('dynamic text round-trips in projects and old block text opens as dynamic text', async ({
  page,
}) => {
  await typeText(page, 80, 150, 'WAVY', 'TEXT');
  await run(page, 'type.fit-wave');
  const s = await state(page);
  // Saved and opened again (the .photo format), the fit and the look are unchanged.
  const back = await page.evaluate(async () => {
    const e = window.photoStudio;
    const { serialize, deserialize } = await import('/src/model/serialization.ts');
    const { layoutOf, ppiOf } = await import('/src/features/type/text-utils.ts');
    const { document } = await deserialize(await serialize(e.doc, e.assets));
    const l = document.layers.find((x) => x.id === e.layer!.id)!;
    const a = layoutOf(e.layer!.textData!, ppiOf(e)),
      b = layoutOf(l.textData!, ppiOf(e));
    return {
      fit: l.textData!.fit,
      same:
        JSON.stringify(a.runs.map((r) => [r.x, r.y, r.sizePx])) ===
        JSON.stringify(b.runs.map((r) => [r.x, r.y, r.sizePx])),
    };
  });
  expect(back.fit).toEqual(s.fit);
  expect(back.same).toBe(true);

  // A project saved with block text (before dynamic text) opens unchanged, as
  // dynamic block text whose box follows its lines.
  const old = await page.evaluate(async () => {
    const e = window.photoStudio;
    const { serialize, deserialize } = await import('/src/model/serialization.ts');
    const { layoutOf, ppiOf } = await import('/src/features/type/text-utils.ts');
    const doc = structuredClone(e.doc);
    const l = doc.layers.find((x) => x.id === e.layer!.id)!;
    const { fit: _fit, ...rest } = l.textData!;
    l.textData = { ...rest, origin: { x: 100, y: 200 }, block: { width: 240, gap: 6 } };
    const before = layoutOf(l.textData, ppiOf(e));
    const { document } = await deserialize(await serialize(doc, e.assets));
    const d = document.layers.find((x) => x.id === l.id)!.textData!;
    const after = layoutOf(d, ppiOf(e));
    const sig = (lay: typeof before) =>
      JSON.stringify(
        lay.runs.map((r) => [
          Math.round(r.x * 1000),
          Math.round(r.y * 1000),
          Math.round(r.sizePx * 1000),
        ]),
      );
    return {
      block: d.block,
      fit: d.fit,
      same: sig(before) === sig(after),
      widths: after.lines.map((x) => x.width),
    };
  });
  expect(old.block).toBeUndefined();
  expect(old.fit).toMatchObject({ shape: 'block', width: 240, gap: 6, autoLines: false });
  expect(old.fit!.height).toBeUndefined();
  expect(old.same).toBe(true);
  for (const w of old.widths) expect(w).toBeCloseTo(240, 1);
});
