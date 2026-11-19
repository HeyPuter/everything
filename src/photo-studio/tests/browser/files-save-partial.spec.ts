// An image file opened only in part (the first frame of an animation, the
// first page of a multi-page TIFF) is not silently replaced by that part when
// Save writes back to it.
import { test, expect, type Page } from '@playwright/test';
import { boot, idle, run, start } from './helpers';

const sdk = `
const drive=window.__drive={};
const item=(path)=>({path,name:path.split('/').pop(),read(){return window.puter.fs.read(this.path);}});
window.__item=item;window.__written=[];window.__picked=[];
window.puter={env:'app',auth:{isSignedIn:()=>true},
  fs:{read:async(path)=>{if(!drive[path])throw new Error('No such file');return drive[path];},
      write:async(path,blob)=>{drive[path]=blob;window.__written.push(path);return item(path);}},
  ui:{showSaveFilePicker:async(blob,name)=>{const path='/me/'+name;drive[path]=blob;window.__picked.push(name);return item(path);}}};`;

type Stub = {
  __drive: Record<string, Blob>;
  __item: (path: string) => object;
  __written: string[];
  __picked: string[];
};
const stub = (page: Page) =>
  page.evaluate(() => ({
    written: (window as unknown as Stub).__written,
    picked: (window as unknown as Stub).__picked,
  }));

/** Put a three-frame GIF on the drive and start opening it from there. */
async function dropAnimatedGif(page: Page, path: string) {
  await page.evaluate(async (path) => {
    const w = window as unknown as Stub;
    const { encodeGif } = await import('/src/imaging/codecs/gif.ts');
    const frame = (r: number, g: number, b: number) => {
      const data = new Uint8ClampedArray(8 * 6 * 4);
      for (let i = 0; i < data.length; i += 4) data.set([r, g, b, 255], i);
      return { rgba: { width: 8, height: 6, data }, delayMs: 100 };
    };
    w.__drive[path] = new Blob(
      [
        encodeGif([
          frame(255, 0, 0),
          frame(0, 255, 0),
          frame(0, 0, 255),
        ]) as Uint8Array<ArrayBuffer>,
      ],
      { type: 'image/gif' },
    );
    window.dispatchEvent(new CustomEvent('drop', { detail: { items: [w.__item(path)] } }));
  }, path);
}
/** The number of frames of a GIF on the drive. */
const gifFrames = (page: Page, path: string) =>
  page.evaluate(async (path) => {
    const { decodeImage } = await import('/src/imaging/codecs/decode.ts');
    const bytes = new Uint8Array(await (window as unknown as Stub).__drive[path].arrayBuffer());
    const d = decodeImage(bytes, {});
    return d?.gifFrames?.length ?? 1;
  }, path);

test('Save asks before replacing an animated GIF opened as its first frame', async ({ page }) => {
  await boot(page, 'default', sdk);
  await dropAnimatedGif(page, '/me/anim.gif');
  const dialog = page.locator('#dialog[open]');
  await dialog.locator('select').selectOption('first');
  await dialog.getByRole('button', { name: 'Open', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.photoStudio.hasDocument)).toBe(true);
  await idle(page);
  expect(await page.evaluate(() => window.photoStudio.session.storage.path)).toBe('/me/anim.gif');
  await page.evaluate(() =>
    window.photoStudio.command('Fill', (d) => (d.layers[0].name = 'Edited')),
  );
  // A recovery copy carries it, so Save still asks after a restore.
  const recovered = await page.evaluate(async () => {
    const { recoveryTick } = await import('/src/features/versions/recovery.ts');
    const { RecoveryStore } = await import('/src/persistence/versions.ts');
    await recoveryTick(window.photoStudio);
    const store = new RecoveryStore();
    const id = window.photoStudio.session.id;
    const record = (await store.list()).find((r) => r.sessionId === id);
    await store.remove(id);
    return record?.leftOut;
  });
  expect(recovered).toEqual({
    name: 'anim.gif',
    path: '/me/anim.gif',
    what: ['the other 2 frames'],
  });
  await start(page, 'file.save');
  await expect(dialog).toContainText('the other 2 frames of anim.gif');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await idle(page);
  expect(await stub(page)).toEqual({ written: [], picked: [] });
  expect(await gifFrames(page, '/me/anim.gif')).toBe(3);

  // Agreeing writes the one frame back, and is not asked again.
  await start(page, 'file.save');
  await dialog.getByRole('button', { name: 'Save as GIF', exact: true }).click();
  await idle(page);
  expect(await stub(page)).toEqual({ written: ['/me/anim.gif'], picked: [] });
  expect(await gifFrames(page, '/me/anim.gif')).toBe(1);
  await page.evaluate(() =>
    window.photoStudio.command('Fill', (d) => (d.layers[0].name = 'Again')),
  );
  await run(page, 'file.save');
  await expect(dialog).toHaveCount(0);
  expect((await stub(page)).written).toEqual(['/me/anim.gif', '/me/anim.gif']);
});

test('an animated WebP opens as its first frame and Save asks before replacing it', async ({
  page,
}) => {
  await boot(page, 'default', sdk);
  await page.evaluate(async () => {
    const w = window as unknown as Stub;
    const { muxAnimatedWebp } = await import('/src/imaging/codecs/webp-anim.ts');
    const still = async (color: string) => {
      const c = new OffscreenCanvas(8, 6);
      const g = c.getContext('2d')!;
      g.fillStyle = color;
      g.fillRect(0, 0, 8, 6);
      return new Uint8Array(
        await (await c.convertToBlob({ type: 'image/webp', quality: 1 })).arrayBuffer(),
      );
    };
    const frames = [await still('#ff0000'), await still('#00ff00')].map((webp) => ({
      webp,
      width: 8,
      height: 6,
      delayMs: 100,
      blend: false,
    }));
    w.__drive['/me/anim.webp'] = new Blob(
      [muxAnimatedWebp(frames, { width: 8, height: 6, plays: 0 }) as Uint8Array<ArrayBuffer>],
      { type: 'image/webp' },
    );
    window.dispatchEvent(
      new CustomEvent('drop', { detail: { items: [w.__item('/me/anim.webp')] } }),
    );
  });
  await expect.poll(() => page.evaluate(() => window.photoStudio.hasDocument)).toBe(true);
  await idle(page);
  await page.evaluate(() =>
    window.photoStudio.command('Fill', (d) => (d.layers[0].name = 'Edited')),
  );
  await start(page, 'file.save');
  const dialog = page.locator('#dialog[open]');
  await expect(dialog).toContainText('A WebP leaves out the other frames of anim.webp.');
  await dialog.getByRole('button', { name: 'Save as .photo', exact: true }).click();
  await expect.poll(async () => (await stub(page)).picked).toEqual(['anim.photo']);
  expect((await stub(page)).written).toEqual([]);
});

test('Save asks before writing a JPEG without the EXIF metadata of the file it replaces', async ({
  page,
}) => {
  await boot(page, 'default', sdk);
  await page.evaluate(async () => {
    const w = window as unknown as Stub;
    const c = new OffscreenCanvas(8, 6);
    const g = c.getContext('2d')!;
    g.fillStyle = '#ff0000';
    g.fillRect(0, 0, 8, 6);
    const plain = new Uint8Array(
      await (await c.convertToBlob({ type: 'image/jpeg' })).arrayBuffer(),
    );
    // An APP1 Exif segment holding an empty TIFF directory, after SOI.
    const body = [...'Exif\0\0']
      .map((ch) => ch.charCodeAt(0))
      .concat([0x49, 0x49, 42, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const app1 = new Uint8Array([0xff, 0xe1, 0, body.length + 2, ...body]);
    w.__drive['/me/IMG_1.jpg'] = new Blob([plain.subarray(0, 2), app1, plain.subarray(2)], {
      type: 'image/jpeg',
    });
    window.dispatchEvent(
      new CustomEvent('drop', { detail: { items: [w.__item('/me/IMG_1.jpg')] } }),
    );
  });
  await expect.poll(() => page.evaluate(() => window.photoStudio.hasDocument)).toBe(true);
  await idle(page);
  await page.evaluate(() =>
    window.photoStudio.command('Fill', (d) => (d.layers[0].name = 'Edited')),
  );
  await start(page, 'file.save');
  const dialog = page.locator('#dialog[open]');
  await expect(dialog).toContainText(
    'A JPEG leaves out the EXIF metadata of IMG_1.jpg. A .photo project keeps everything else and leaves IMG_1.jpg as it is.',
  );
  await dialog.getByRole('button', { name: 'Save as JPEG', exact: true }).click();
  await idle(page);
  expect(await stub(page)).toEqual({ written: ['/me/IMG_1.jpg'], picked: [] });

  // The same file opened from this device saves to a new Puter file: nothing to ask.
  await page.evaluate(async () => {
    const { openFile } = await import('/src/features/files/open.ts');
    const blob = (window as unknown as Stub).__drive['/me/IMG_1.jpg'];
    await openFile(window.photoStudio, blob, 'IMG_2.jpg');
  });
  await idle(page);
  await page.evaluate(() =>
    window.photoStudio.command('Fill', (d) => (d.layers[0].name = 'Edited')),
  );
  await run(page, 'file.save');
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await stub(page)).picked).toEqual(['IMG_2.jpg']);
});

test('agreeing to flatten a copy does not let Save flatten the file itself without asking', async ({
  page,
}) => {
  await boot(page, 'default', sdk);
  await page.evaluate(async () => {
    const w = window as unknown as Stub;
    const c = new OffscreenCanvas(8, 6);
    c.getContext('2d')!.fillRect(0, 0, 8, 6);
    w.__drive['/me/card.png'] = await c.convertToBlob({ type: 'image/png' });
    window.dispatchEvent(
      new CustomEvent('drop', { detail: { items: [w.__item('/me/card.png')] } }),
    );
  });
  await expect.poll(() => page.evaluate(() => window.photoStudio.hasDocument)).toBe(true);
  await idle(page);
  await page.evaluate(async () => {
    const { newPixelLayer } = await import('/src/model/pixel-layer.ts');
    window.photoStudio.command('Layer', (d) => d.layers.push(newPixelLayer('Top', d)));
  });
  await start(page, 'file.save-copy', 'png');
  const dialog = page.locator('#dialog[open]');
  await expect(dialog).toContainText('A PNG flattens the layers into pixels.');
  await dialog.getByRole('button', { name: 'Save as PNG', exact: true }).click();
  await expect.poll(async () => (await stub(page)).picked).toEqual(['card.png']);
  await idle(page);
  // Save writes over the file itself: it asks again.
  await start(page, 'file.save');
  await expect(dialog).toContainText('A PNG flattens the layers into pixels.');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await idle(page);
  expect((await stub(page)).written).toEqual([]);
});
