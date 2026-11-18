import { expect, test, type Page } from '@playwright/test';
import { inflateRawSync } from 'node:zlib';
import { boot, canvasDrag, client, compositePixel, downloadFrom, historyLabels, idle, openImage, run, start, tool, undo, type Backend } from './helpers';

const artboards = (page: Page) =>
  page.evaluate(() =>
    window.photoStudio.doc.layers.filter((l) => l.artboard).map((l) => ({ id: l.id, name: l.name, rect: l.artboard!.rect, children: l.children.map((c) => c.name) })),
  );

/** Names of the entries in a stored (uncompressed) ZIP archive. */
function zipNames(bytes: Buffer) {
  const names: string[] = [];
  for (let p = 0; p + 30 <= bytes.length && bytes.readUInt32LE(p) === 0x04034b50; ) {
    const size = bytes.readUInt32LE(p + 18),
      nameLength = bytes.readUInt16LE(p + 26),
      extra = bytes.readUInt16LE(p + 28);
    names.push(bytes.subarray(p + 30, p + 30 + nameLength).toString());
    p += 30 + nameLength + extra + size;
  }
  void inflateRawSync;
  return names;
}

async function addSolid(page: Page, name: string, color: string, rect: { x: number; y: number; width: number; height: number }) {
  await page.evaluate(
    async ({ name, color, rect }) => {
      const e = window.photoStudio;
      const { layer } = await import('/src/model/document.ts');
      const l = layer('solid', name, rect.width, rect.height);
      l.color = color;
      l.transform = { ...rect, rotation: 0 };
      e.command('Add layer', (d) => d.layers.push(l));
      e.selectLayers([l.id]);
      e.update();
    },
    { name, color, rect },
  );
  await idle(page);
}

async function clippingWorks(page: Page) {
  await openImage(page, 600, 400, '#808080');
  await tool(page, 'Artboard Tool');
  await canvasDrag(page, [
    [20, 20],
    [120, 120],
    [220, 320],
  ]);
  const [a] = await artboards(page);
  expect(a.rect).toEqual({ x: 20, y: 20, width: 200, height: 300 });
  // White background inside, the gray image outside.
  expect(await compositePixel(page, 30, 30)).toEqual([255, 255, 255, 255]);
  expect(await compositePixel(page, 300, 30)).toEqual([128, 128, 128, 255]);
  // Content reaching past the artboard is clipped to it.
  await addSolid(page, 'Red', '#ff0000', { x: 120, y: 100, width: 150, height: 50 });
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { nestIntoArtboards } = await import('/src/model/artboard.ts');
    const id = e.layer!.id;
    e.command('Nest', (d) => nestIntoArtboards(d, [id]));
  });
  await idle(page);
  expect((await artboards(page))[0].children).toEqual(['Red']);
  expect(await compositePixel(page, 200, 120)).toEqual([255, 0, 0, 255]);
  expect(await compositePixel(page, 260, 120)).toEqual([128, 128, 128, 255]);
  // Transparent background with clipping off shows the content and the layer below.
  await page.evaluate(() => {
    const e = window.photoStudio;
    e.command('Background', (d) => {
      const ab = d.layers.find((l) => l.artboard)!;
      ab.artboard!.background = 'transparent';
      ab.artboard!.clip = false;
    });
  });
  await idle(page);
  expect(await compositePixel(page, 30, 30)).toEqual([128, 128, 128, 255]);
  expect(await compositePixel(page, 260, 120)).toEqual([255, 0, 0, 255]);
}

for (const backend of ['WebGPU', 'WebGL'] as Backend[])
  test(`artboards draw backgrounds and clip contents (${backend})`, async ({ page }) => {
    await boot(page, backend);
    await clippingWorks(page);
  });

test('artboards: create, add beside, nest moved layers, frames and exports', async ({ page }) => {
  await boot(page);
  await openImage(page, 600, 400, '#808080');
  await tool(page, 'Artboard Tool');
  await canvasDrag(page, [
    [20, 20],
    [220, 320],
  ]);
  expect((await historyLabels(page)).at(-1)).toBe('New Artboard');
  // The "+" buttons beside the selected artboard add neighbors of the same size.
  await page.locator('[data-artboard-add="right"]').click();
  await idle(page);
  await page.locator('[data-artboard-add="right"]').click();
  await idle(page);
  const list = await artboards(page);
  expect(list.map((a) => a.name)).toEqual(['Artboard 1', 'Artboard 2', 'Artboard 3']);
  expect(list.map((a) => a.rect.x)).toEqual([20, 252, 484]);
  // The canvas grew to hold the third artboard.
  expect(await page.evaluate(() => window.photoStudio.doc.width)).toBe(684);
  await expect(page.locator('#stage.has-artboards')).toHaveCount(1);
  await expect(page.locator('.artboard-name')).toHaveCount(3);

  // Moving a layer onto another artboard puts it into that artboard.
  await addSolid(page, 'Box', '#0000ff', { x: 60, y: 60, width: 40, height: 40 });
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { nestIntoArtboards } = await import('/src/model/artboard.ts');
    const id = e.layer!.id;
    e.command('Nest', (d) => nestIntoArtboards(d, [id]));
  });
  await idle(page);
  expect((await artboards(page))[0].children).toEqual(['Box']);
  await tool(page, 'Move Tool');
  await canvasDrag(page, [
    [80, 80],
    [200, 80],
    [320, 80],
  ]);
  const after = await artboards(page);
  expect(after[0].children).toEqual([]);
  expect(after[1].children).toEqual(['Box']);

  // Dragging an artboard by its name moves its contents with it.
  const name = page.locator('.artboard-name', { hasText: 'Artboard 2' });
  const box = (await name.boundingBox())!;
  const z = await page.evaluate(() => window.photoStudio.zoom);
  await page.mouse.move(box.x + 5, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 5, box.y + box.height / 2 + 40 * z, { steps: 4 });
  await page.mouse.up();
  await idle(page);
  const moved = await page.evaluate(() => {
    const ab = window.photoStudio.doc.layers.find((l) => l.name === 'Artboard 2')!;
    return { rect: ab.artboard!.rect, child: ab.children[0].transform.y };
  });
  expect(moved.rect.y).toBeGreaterThan(40);
  expect(moved.child - moved.rect.y).toBe(40);
  await undo(page);

  // An elliptical frame inside the first artboard masks a placed image.
  await tool(page, 'Frame Tool');
  await page.locator('[data-frame-shape="ellipse"]').click();
  await canvasDrag(page, [
    [40, 40],
    [200, 200],
  ]);
  const frame = await page.evaluate(() => {
    const ab = window.photoStudio.doc.layers[1];
    const f = ab.children.find((c) => c.frame)!;
    return { parent: ab.name, rect: f.frame!.rect, shape: f.frame!.shape, id: f.id };
  });
  expect(frame).toMatchObject({ parent: 'Artboard 1', shape: 'ellipse', rect: { x: 40, y: 40, width: 160, height: 160 } });
  await page.evaluate(async (id) => {
    const c = new OffscreenCanvas(64, 32);
    const g = c.getContext('2d')!;
    g.fillStyle = '#00ff00';
    g.fillRect(0, 0, 64, 32);
    const blob = await c.convertToBlob({ type: 'image/png' });
    const { placeIntoFrame } = await import('/src/features/layout/frames.ts');
    await window.photoStudio.run(() => placeIntoFrame(window.photoStudio, id, new File([blob], 'green.png', { type: 'image/png' })));
  }, frame.id);
  await idle(page);
  // Fill mode covers the frame; the ellipse masks the corners.
  expect(await compositePixel(page, 120, 120)).toEqual([0, 255, 0, 255]);
  expect(await compositePixel(page, 45, 45)).toEqual([255, 255, 255, 255]);
  const content = await page.evaluate((id) => {
    const find = (ls: import('../../src/model/document').Layer[]): import('../../src/model/document').Layer | undefined => ls.map((l) => (l.id === id ? l : find(l.children))).find(Boolean);
    const f = find(window.photoStudio.doc.layers)!;
    return f.children[0].transform;
  }, frame.id);
  expect(content).toMatchObject({ x: -40, y: 40, width: 320, height: 160 });

  // Projects keep artboards and frames.
  const roundTrip = await page.evaluate(async () => {
    const e = window.photoStudio;
    const { serialize, deserialize } = await import('/src/model/serialization.ts');
    const { document } = await deserialize(await serialize(e.doc, e.assets));
    return { boards: document.layers.filter((l) => l.artboard).length, frame: JSON.stringify(document).includes('"shape":"ellipse"') };
  });
  expect(roundTrip).toEqual({ boards: 3, frame: true });

  // Export: one PDF page and one file per artboard.
  await start(page, 'file.export-artboards-pdf');
  const pdfDialog = page.locator('dialog.page-export-dialog[open]');
  await expect(pdfDialog).toBeVisible();
  const pdf = await downloadFrom(page, () => pdfDialog.getByRole('button', { name: 'Export PDF' }).click());
  await idle(page);
  const text = pdf.bytes.toString('latin1');
  expect(text.startsWith('%PDF-1.4')).toBe(true);
  expect(text).toContain('/Count 3');
  expect(text).toContain('/MediaBox [0 0 200 300]');
  await start(page, 'file.export-artboards-files');
  const filesDialog = page.locator('dialog.page-export-dialog[open]');
  await expect(filesDialog).toBeVisible();
  const zip = await downloadFrom(page, () => filesDialog.getByRole('button', { name: 'Export' }).click());
  await idle(page);
  expect(zipNames(zip.bytes).sort()).toEqual(['image_Artboard 1.png', 'image_Artboard 2.png', 'image_Artboard 3.png']);

  // Fit Artboard on Screen centers the selected artboard.
  await page.evaluate(() => window.photoStudio.selectLayers([window.photoStudio.doc.layers[2].id]));
  await run(page, 'view.fit-artboard');
  const center = await page.evaluate(() => {
    const v = document.querySelector('#viewport')!.getBoundingClientRect();
    return [v.left + v.width / 2, v.top + v.height / 2];
  });
  const [cx, cy] = await client(page, 252 + 100, 20 + 150);
  expect(Math.abs(cx - center[0])).toBeLessThan(2);
  expect(Math.abs(cy - center[1])).toBeLessThan(2);
});

test('a blank artboard name keeps the default name', async ({ page }) => {
  await boot(page);
  await openImage(page, 300, 200);
  const submit = async (name: string) => {
    await page.locator('#dialog input[name="name"]').fill(name);
    await page.locator('#dialog button[type=submit]').click();
    await idle(page);
  };
  await start(page, 'layer.new-artboard');
  await submit('   ');
  expect((await artboards(page)).map((a) => a.name)).toEqual(['Artboard 1']);
  // Renaming to a blank name leaves the name as it was.
  const id = (await artboards(page))[0].id;
  await page.evaluate((id) => window.photoStudio.selectLayers([id]), id);
  await page.locator(`[data-artboard-name="${id}"]`).dblclick();
  await submit('  ');
  expect((await artboards(page)).map((a) => a.name)).toEqual(['Artboard 1']);
  await page.locator(`[data-artboard-name="${id}"]`).dblclick();
  await submit('  Cover  ');
  expect((await artboards(page)).map((a) => a.name)).toEqual(['Cover']);
});
