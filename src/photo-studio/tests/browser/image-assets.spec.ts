// File → Generate → Image Assets: layers named like files become image files,
// downloaded as a ZIP or written beside a Puter document.
import { test, expect, type Page } from '@playwright/test';
import { layer, newDocument } from '../../src/model/document';
import { boot, downloadFrom, historyLabels, idle, menu, openProject, run } from './helpers';

function fixture() {
  const doc = newDocument(320, 240, 'Poster');
  const paper = layer('solid', 'Paper', 320, 240);
  paper.color = '#f0f0f0';
  const red = layer('solid', 'red.png', 60, 40);
  red.color = '#ff0000';
  Object.assign(red.transform, { x: 20, y: 30 });
  const blue = layer('solid', '200% blue.jpg80, icons/blue.webp', 40, 40);
  blue.color = '#0000ff';
  Object.assign(blue.transform, { x: 100, y: 50 });
  const green = layer('solid', 'Leaf', 30, 20);
  green.color = '#00ff00';
  Object.assign(green.transform, { x: 200, y: 100 });
  const group = layer('group', '48x48 icon.png', 320, 240);
  group.children = [green];
  const bad = layer('solid', 'icon.pngg', 10, 10);
  bad.color = '#ffff00';
  doc.layers = [paper, red, blue, group, bad];
  return doc;
}

/** Entries of a STORE-only ZIP (local file headers). */
function unzip(bytes: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let p = 0;
  while (bytes.readUInt32LE(p) === 0x04034b50) {
    const size = bytes.readUInt32LE(p + 18);
    const nameLength = bytes.readUInt16LE(p + 26),
      extra = bytes.readUInt16LE(p + 28);
    const name = bytes.subarray(p + 30, p + 30 + nameLength).toString('utf8');
    const start = p + 30 + nameLength + extra;
    out.set(name, bytes.subarray(start, start + size));
    p = start + size;
  }
  return out;
}

/** Decode images in the page; returns [width, height, first pixel]. */
function decode(page: Page, files: Map<string, Buffer>) {
  const list = [...files].map(([name, b]) => ({ name, data: b.toString('base64') }));
  return page.evaluate(async (list) => {
    const out: Record<string, [number, number, number[]]> = {};
    for (const f of list) {
      const bytes = Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0));
      const type = f.name.endsWith('.jpg') ? 'image/jpeg' : f.name.endsWith('.webp') ? 'image/webp' : 'image/png';
      const bmp = await createImageBitmap(new Blob([bytes], { type }));
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const g = c.getContext('2d')!;
      g.drawImage(bmp, 0, 0);
      const px = g.getImageData(Math.floor(bmp.width / 2), Math.floor(bmp.height / 2), 1, 1).data;
      out[f.name] = [bmp.width, bmp.height, [...px]];
    }
    return out;
  }, list);
}

test('layer names generate image files, downloaded as a ZIP, with problems listed', async ({ page }) => {
  await boot(page);
  await openProject(page, fixture(), [], 'poster.photo');
  await expect(page.locator('.image-assets-status')).toBeHidden();
  await menu(page, 'File', 'Generate', 'Image Assets');
  expect((await historyLabels(page)).at(-1)).toBe('Image Assets On');
  expect(await page.evaluate(() => window.photoStudio.doc.imageAssets)).toBe(true);
  // The status bar reports the files and the bad name once generated.
  const status = page.locator('.image-assets-status');
  await expect(status).toBeVisible();
  await expect(status).toHaveText('Assets: 4 · 1 error', { timeout: 30_000 });

  const zip = await downloadFrom(page, () => menu(page, 'File', 'Generate', 'Download Image Assets (.zip)'));
  expect(zip.name).toBe('poster-assets.zip');
  const files = unzip(zip.bytes);
  expect([...files.keys()].sort()).toEqual(['blue.jpg', 'icon.png', 'icons/blue.webp', 'red.png']);
  // PNG signature and size from IHDR.
  const red = files.get('red.png')!;
  expect(red.subarray(1, 4).toString()).toBe('PNG');
  expect([red.readUInt32BE(16), red.readUInt32BE(20)]).toEqual([60, 40]);
  const decoded = await decode(page, files);
  expect(decoded['red.png']).toEqual([60, 40, [255, 0, 0, 255]]);
  expect(decoded['blue.jpg'].slice(0, 2)).toEqual([80, 80]);
  expect(decoded['blue.jpg'][2][2]).toBeGreaterThan(200);
  expect(decoded['icons/blue.webp'].slice(0, 2)).toEqual([40, 40]);
  expect(decoded['icon.png']).toEqual([48, 48, [0, 255, 0, 255]]);

  // The popover lists files and the problem; choosing it selects the layer.
  await status.click();
  const pop = page.getByRole('dialog', { name: 'Image Assets' });
  await expect(pop).toBeVisible();
  await expect(pop.locator('.ia-file')).toHaveCount(4);
  await expect(pop.locator('.ia-issue')).toContainText('icon.pngg');
  await expect(pop.locator('.ia-issue')).toContainText('not a supported extension');
  await pop.locator('.ia-issue').click();
  await expect(pop).toBeHidden();
  expect(await page.evaluate(() => window.photoStudio.layer?.name)).toBe('icon.pngg');
  // Escape closes the popover.
  await status.click();
  await expect(pop).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(pop).toBeHidden();

  // Renaming a layer regenerates after the edit settles; unchanged files are reused.
  await page.evaluate(() => window.photoStudio.command('Rename', (d) => (d.layers[1].name = '50% red.png8')));
  await expect(status).toHaveText('Assets: 4 · 1 error', { timeout: 30_000 });
  const again = unzip((await downloadFrom(page, () => run(page, 'file.download-image-assets'))).bytes);
  const small = again.get('red.png')!;
  expect([small.readUInt32BE(16), small.readUInt32BE(20)]).toEqual([30, 20]);
  // Palette PNG: color type 3.
  expect(small[25]).toBe(3);

  // Turning it off hides the indicator; it is undoable.
  await menu(page, 'File', 'Generate', 'Image Assets');
  await expect(status).toBeHidden();
  expect((await historyLabels(page)).at(-1)).toBe('Image Assets Off');
  await idle(page);
});

test('with a document saved on Puter, assets are written to a folder beside it', async ({ page }) => {
  const stub = `window.__writes=[];window.puter={env:"app",auth:{isSignedIn:()=>true},fs:{
    write:async(path,blob,opts)=>{window.__writes.push({path,size:blob.size,type:blob.type,opts});return{path,name:path.split('/').pop()}},
    read:async()=>{throw new Error('no read')}},ui:{}};`;
  await boot(page, 'default', stub);
  await openProject(page, fixture(), [], 'poster.photo');
  await page.evaluate(() => {
    const e = window.photoStudio;
    e.session.storage.path = '/nj/Documents/Poster v2.photo';
  });
  await run(page, 'file.image-assets');
  await expect(page.locator('.image-assets-status')).toHaveText('Assets: 4 · 1 error', { timeout: 30_000 });
  const writes = await page.evaluate(() => (window as unknown as { __writes: { path: string; size: number; type: string; opts: Record<string, unknown> }[] }).__writes);
  expect(writes.map((w) => w.path).sort()).toEqual([
    '/nj/Documents/Poster v2-assets/blue.jpg',
    '/nj/Documents/Poster v2-assets/icon.png',
    '/nj/Documents/Poster v2-assets/icons/blue.webp',
    '/nj/Documents/Poster v2-assets/red.png',
  ]);
  expect(writes.every((w) => w.size > 0 && w.opts.overwrite === true && w.opts.createMissingParents === true)).toBe(true);
  expect(writes.find((w) => w.path.endsWith('.jpg'))!.type).toBe('image/jpeg');

  // An edit to one layer rewrites only its files.
  await page.evaluate(() => {
    (window as unknown as { __writes: unknown[] }).__writes.length = 0;
    window.photoStudio.command('Recolor', (d) => (d.layers[1].color = '#00ffff'));
  });
  await page.waitForFunction(() => (window as unknown as { __writes: unknown[] }).__writes.length > 0, null, { timeout: 30_000 });
  await idle(page);
  await expect(page.locator('.image-assets-status')).toHaveText('Assets: 4 · 1 error');
  expect(await page.evaluate(() => (window as unknown as { __writes: { path: string }[] }).__writes.map((w) => w.path))).toEqual(['/nj/Documents/Poster v2-assets/red.png']);
  await page.locator('.image-assets-status').click();
  await expect(page.getByRole('dialog', { name: 'Image Assets' })).toContainText('Written to /nj/Documents/Poster v2-assets');
  await page.keyboard.press('Escape');
});

test('the toggle is saved in .photo projects', async ({ page }) => {
  await boot(page);
  const doc = fixture();
  (doc as { imageAssets?: boolean }).imageAssets = true;
  await openProject(page, doc, [], 'saved.photo');
  await expect(page.locator('.image-assets-status')).toHaveText(/Assets: 4/, { timeout: 30_000 });
  const ok = await page.evaluate(async () => {
    const { serialize, deserialize } = await import('/src/model/serialization.ts');
    const e = window.photoStudio;
    const back = await deserialize(await serialize(e.doc, e.assets));
    return back.document.imageAssets;
  });
  expect(ok).toBe(true);
});
