// Relight layers: created from the Layer menu, lights added in Properties,
// dragged on the canvas (one history step per drag), hidden with N, nudged
// with arrow keys, undone, rasterized, and kept through a .photo round trip.
// The compositor's result is compared with the CPU reference.
import { expect, test, type Page } from '@playwright/test';
import {
  boot,
  canvasClick,
  canvasDrag,
  historyLabels,
  idle,
  menu,
  openFiles,
  openImage,
  panel,
  run,
  tool,
  undo,
} from './helpers';

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

  // Dragging moves the Properties sliders along; Escape puts the light back.
  const before = await lights(page);
  const steps = (await historyLabels(page)).length;
  const second = (await handles(page).nth(1).boundingBox())!;
  await page.mouse.move(second.x + second.width / 2, second.y + second.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 4; i++)
    await page.mouse.move(second.x + second.width / 2 + i * 10, second.y + second.height / 2);
  const field = props.getByRole('spinbutton', { name: 'Horizontal value' });
  await expect(field).not.toHaveValue(String(Math.round(before[1].x * 100)));
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await idle(page);
  expect(await lights(page)).toEqual(before);
  expect((await historyLabels(page)).length).toBe(steps);
  await expect(field).toHaveValue(String(Math.round(before[1].x * 100)));

  // Drag Light 1: many pointer moves, one history step.
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

test('relight layer: PSD export and rasterize keep the look, duplicate keeps the lights, grayscale refuses', async ({
  page,
}) => {
  await boot(page);
  await openScene(page);
  await run(page, 'layer.new-relight');
  const shown = await page.evaluate(async () => {
    const { compositeRGBA } = await import('/src/features/pixels.ts');
    return Array.from((await compositeRGBA(window.photoStudio)).data);
  });
  // PSD has no relight record: the layer is written as its relit pixels.
  const psd = await page.evaluate(async () => {
    const e = window.photoStudio;
    (e.preferences as { psdCompatibility: string }).psdCompatibility = 'always';
    const { buildPsd } = await import('/src/features/files/psd-export.ts');
    const out = await buildPsd(e);
    return Array.from(new Uint8Array(await out!.blob.arrayBuffer()));
  });
  await openFiles(page, {
    name: 'relit.psd',
    mimeType: 'image/vnd.adobe.photoshop',
    buffer: Buffer.from(psd),
  });
  const reopened = await page.evaluate(async () => {
    const { compositeRGBA } = await import('/src/features/pixels.ts');
    const e = window.photoStudio;
    return {
      layers: e.doc.layers.map((l) => [l.name, l.kind]),
      pixels: Array.from((await compositeRGBA(e)).data),
    };
  });
  // PSD rasters open as image layers.
  expect(reopened.layers).toEqual([
    ['Background', 'image'],
    ['Relight 1', 'image'],
  ]);
  let psdMax = 0;
  for (let i = 0; i < shown.length; i++)
    psdMax = Math.max(psdMax, Math.abs(shown[i] - reopened.pixels[i]));
  expect(psdMax).toBeLessThanOrEqual(2);
  await page.evaluate(async () => {
    const e = window.photoStudio;
    await e.closeSession(e.session, true);
  });
  await idle(page);
  expect(await page.evaluate(() => window.photoStudio.session.fileName)).toBe('scene.png');

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

// The path selection tools own the arrow keys: with a relight layer
// selected they nudge the selected path, not the selected light.
test('relight layer: arrow keys nudge a selected path with the path tools', async ({ page }) => {
  await boot(page);
  await openImage(page, 1200, 900, '#3080ff');
  await run(page, 'layer.new-relight');
  await tool(page, 'Rectangle Tool');
  await page.selectOption('#vec-mode', 'path');
  await canvasDrag(page, [
    [200, 200],
    [600, 500],
  ]);
  const left = () =>
    page.evaluate(() => window.photoStudio.doc.workPath?.paths[0]?.knots[0].points[2]);
  expect(await left()).toBe(200);
  const before = await lights(page);
  await tool(page, 'Path Selection Tool');
  await canvasClick(page, 200, 280);
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
  await expect.poll(left).toBe(203);
  await idle(page);
  expect(await lights(page)).toEqual(before);
});

test('relight layer: a hidden relight layer, or one in a hidden group, shows no light handles and its lights stay put', async ({
  page,
}) => {
  await boot(page);
  await openScene(page);
  await run(page, 'layer.new-relight');
  await expect(handles(page)).toHaveCount(1);
  const box = (await handles(page).first().boundingBox())!;
  const before = await lights(page);
  await run(page, 'layer.hide');
  await expect(handles(page)).toHaveCount(0);
  // Arrow keys and a drag where the handle was leave the lights alone (the
  // Hand tool neither selects nor moves layers).
  await page.evaluate(() => window.photoStudio.setTool('hand'));
  await page.locator('#viewport').focus();
  await page.keyboard.press('ArrowRight');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 + 20, { steps: 4 });
  await page.mouse.up();
  await idle(page);
  expect(await lights(page)).toEqual(before);
  await run(page, 'layer.hide');
  await expect(handles(page)).toHaveCount(1);
  // Inside a hidden group.
  await run(page, 'layer.group');
  await expect(handles(page)).toHaveCount(0);
  await page.evaluate(() => {
    const e = window.photoStudio;
    const group = e.doc.layers.find((l) => l.kind === 'group')!;
    e.selectLayer(group.children[0].id);
    e.update();
  });
  await idle(page);
  await expect(handles(page)).toHaveCount(1);
  await page.evaluate(() =>
    window.photoStudio.command('Hide Group', (d) => {
      d.layers.find((l) => l.kind === 'group')!.visible = false;
    }),
  );
  await idle(page);
  await expect(handles(page)).toHaveCount(0);
});

// A slider moved and put back without a release (no change event) leaves no
// preview behind: handles follow later edits of the stored settings.
test('relight layer: handles follow nudges and undo after a slider returns to its value', async ({
  page,
}) => {
  await boot(page);
  await openScene(page);
  await run(page, 'layer.new-relight');
  await panel(page, 'Properties');
  const props = page.locator('#properties');
  const range = props.getByRole('slider', { name: 'Horizontal' });
  await expect(range).toBeVisible();
  await range.evaluate((el: HTMLInputElement) => {
    const was = el.value;
    el.value = '90';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.value = was;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const handleX = () =>
    page.evaluate(() =>
      Number(document.querySelector('#overlay .relight-dot')?.getAttribute('cx')),
    );
  await page.locator('#viewport').focus();
  await page.keyboard.press('Shift+ArrowRight');
  await idle(page);
  expect((await historyLabels(page)).at(-1)).toBe('Nudge Light');
  expect(await handleX()).toBeCloseTo((await lights(page))[0].x * 240, 3);
  await undo(page);
  expect(await handleX()).toBeCloseTo((await lights(page))[0].x * 240, 3);
});
