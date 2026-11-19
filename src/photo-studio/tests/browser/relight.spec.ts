// Relight layers: created from the Layer menu, lights added in Properties,
// dragged on the canvas (one history step per drag), hidden with N, nudged
// with arrow keys, undone, rasterized, and kept through a .photo round trip.
// The compositor's result is compared with the CPU reference.
import { expect, test, type Page } from '@playwright/test';
import { boot, historyLabels, idle, menu, openFiles, panel, run, undo } from './helpers';

async function openScene(page: Page) {
  await page.evaluate(async () => {
    const c = new OffscreenCanvas(240, 160);
    const g = c.getContext('2d')!;
    g.fillStyle = '#4a4870';
    g.fillRect(0, 0, 240, 160);
    const r = g.createRadialGradient(105, 70, 4, 120, 80, 50);
    r.addColorStop(0, '#f2dcc4');
    r.addColorStop(1, '#6e4a32');
    g.fillStyle = r;
    g.beginPath();
    g.arc(120, 80, 48, 0, Math.PI * 2);
    g.fill();
    const blob = await c.convertToBlob({ type: 'image/png' });
    const { openFile } = await import('/src/features/files/open.ts');
    await openFile(window.photoStudio, blob, 'scene.png');
  });
  await idle(page);
}

const lights = (page: Page) =>
  page.evaluate(() => {
    const l = window.photoStudio.doc.layers.find((x) => x.adjustment?.kind === 'relight');
    return (
      (l?.adjustment?.params as { lights: { id: string; x: number; y: number }[] } | undefined)
        ?.lights ?? []
    );
  });
const handles = (page: Page) => page.locator('#overlay [data-relight-light]');

// The compositor's result for the first relight layer matches the CPU
// reference of the same settings, and visibly changes the image.
async function matchesCpu(page: Page) {
  const diff = await page.evaluate(async () => {
    const e = window.photoStudio;
    const { compositeRGBA } = await import('/src/features/pixels.ts');
    const { documentBelow } = await import('/src/features/adjust/source.ts');
    const { applyAdjustment } = await import('/src/imaging/adjust/index.ts');
    const { specAdjustment } = await import('/src/features/adjust/spec.ts');
    const l = e.doc.layers[1];
    const below = await compositeRGBA(e, documentBelow(e.doc, l.id));
    const cpu = applyAdjustment(below, specAdjustment(l.adjustment)!, undefined, undefined, {
      docWidth: e.doc.width,
      docHeight: e.doc.height,
    });
    const gpu = await compositeRGBA(e);
    let max = 0,
      sum = 0,
      changed = 0;
    for (let i = 0; i < gpu.data.length; i++) {
      if ((i & 3) === 3) continue;
      const d = Math.abs(gpu.data[i] - cpu.data[i]);
      max = Math.max(max, d);
      sum += d;
      if (Math.abs(gpu.data[i] - below.data[i]) > 8) changed++;
    }
    return { max, mean: sum / ((gpu.data.length / 4) * 3), changed };
  });
  expect(diff.changed).toBeGreaterThan(1000);
  expect(diff.mean).toBeLessThan(1);
  expect(diff.max).toBeLessThanOrEqual(6);
}

test('relight layer: add and drag lights, N hides them, undo, and save and reopen', async ({
  page,
}) => {
  await boot(page);
  await openScene(page);
  await menu(page, 'Layer', 'New Relight Layer');
  await idle(page);
  expect(await page.evaluate(() => window.photoStudio.doc.layers.map((l) => l.name))).toEqual([
    'Background',
    'Relight 1',
  ]);
  expect((await historyLabels(page)).at(-1)).toBe('New Relight Layer');
  await panel(page, 'Properties');
  const props = page.locator('#properties');
  await expect(props.getByRole('button', { name: 'Add a light' })).toBeVisible();
  await expect(handles(page)).toHaveCount(1);

  await matchesCpu(page);

  await props.getByRole('button', { name: 'Add a light' }).click();
  await idle(page);
  expect((await historyLabels(page)).at(-1)).toBe('Add Light');
  await expect(handles(page)).toHaveCount(2);
  await expect(props.getByRole('button', { name: 'Light 2', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  // Drag Light 1: many pointer moves, one history step.
  const before = await lights(page);
  const steps = (await historyLabels(page)).length;
  const box = (await handles(page).first().boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++)
    await page.mouse.move(box.x + box.width / 2 + i * 8, box.y + box.height / 2 + i * 3);
  await page.mouse.up();
  await idle(page);
  const moved = await lights(page);
  expect(moved[0].x).toBeGreaterThan(before[0].x + 0.1);
  expect(moved[1]).toEqual(before[1]);
  expect((await historyLabels(page)).length).toBe(steps + 1);
  expect((await historyLabels(page)).at(-1)).toBe('Move Light');
  await expect(props.getByRole('button', { name: 'Light 1', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  // Arrow keys nudge the selected light; N hides and shows the handles.
  await page.locator('#viewport').focus();
  await page.keyboard.press('Shift+ArrowLeft');
  await idle(page);
  expect((await historyLabels(page)).at(-1)).toBe('Nudge Light');
  expect((await lights(page))[0].x).toBeCloseTo(moved[0].x - 10 / 240, 6);
  await page.keyboard.press('n');
  await expect(handles(page)).toHaveCount(0);
  await page.keyboard.press('n');
  await expect(handles(page)).toHaveCount(2);

  await undo(page);
  await undo(page);
  expect((await lights(page))[0].x).toBeCloseTo(before[0].x, 6);

  // Save as a project and open it again.
  const bytes = await page.evaluate(async () => {
    const { serialize } = await import('/src/model/serialization.ts');
    const blob = await serialize(window.photoStudio.doc, window.photoStudio.assets);
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
  const saved = await page.evaluate(() => window.photoStudio.doc.layers[1].adjustment);
  await openFiles(page, {
    name: 'relit.photo',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from(bytes),
  });
  expect(
    await page.evaluate(() => window.photoStudio.doc.layers.map((l) => [l.name, l.kind])),
  ).toEqual([
    ['Background', 'pixel'],
    ['Relight 1', 'adjustment'],
  ]);
  expect(await page.evaluate(() => window.photoStudio.doc.layers[1].adjustment)).toEqual(saved);
});

test('relight layer: rasterize keeps the look, duplicate keeps the lights, grayscale refuses', async ({
  page,
}) => {
  await boot(page);
  await openScene(page);
  await run(page, 'layer.new-relight');
  const shown = await page.evaluate(async () => {
    const { compositeRGBA } = await import('/src/features/pixels.ts');
    return Array.from((await compositeRGBA(window.photoStudio)).data);
  });
  await run(page, 'layer.duplicate');
  expect(
    await page.evaluate(() =>
      window.photoStudio.doc.layers.map((l) => l.adjustment?.kind ?? l.kind),
    ),
  ).toEqual(['pixel', 'relight', 'relight']);
  await undo(page);
  await run(page, 'layer.rasterize');
  expect((await historyLabels(page)).at(-1)).toBe('Rasterize Layer');
  const after = await page.evaluate(async () => {
    const { compositeRGBA } = await import('/src/features/pixels.ts');
    const l = window.photoStudio.doc.layers[1];
    return {
      kind: l.kind,
      name: l.name,
      pixels: Array.from((await compositeRGBA(window.photoStudio)).data),
    };
  });
  expect(after).toMatchObject({ kind: 'pixel', name: 'Relight 1' });
  let max = 0;
  for (let i = 0; i < shown.length; i++) max = Math.max(max, Math.abs(shown[i] - after.pixels[i]));
  expect(max).toBeLessThanOrEqual(2);

  // A grayscale document cannot hold colored light.
  await page.evaluate(() =>
    window.photoStudio.command('Grayscale', (d) => void (d.mode = 'grayscale')),
  );
  await idle(page);
  const count = await page.evaluate(() => window.photoStudio.doc.layers.length);
  await run(page, 'layer.new-relight');
  expect(await page.evaluate(() => window.photoStudio.doc.layers.length)).toBe(count);
  await expect(page.locator('#status')).toContainText('Relight layers need');
});

test('relight layer: the WebGL2 compositor matches the CPU reference, shadows and several lights included', async ({
  page,
}) => {
  await boot(page, 'WebGL');
  await openScene(page);
  await run(page, 'layer.new-relight');
  await page.evaluate(() => {
    const e = window.photoStudio;
    const l = e.doc.layers[1];
    const p = structuredClone(l.adjustment!.params) as {
      lights: Record<string, unknown>[];
      shadows: number;
    };
    p.lights.push({
      ...p.lights[0],
      id: 'light-2',
      name: 'Light 2',
      x: 0.9,
      y: 0.8,
      depth: -40,
      color: [80, 140, 255],
    });
    p.shadows = 80;
    e.command('Lights', (d) => void (d.layers[1].adjustment = { kind: 'relight', params: p }));
  });
  await idle(page);
  await matchesCpu(page);
});
