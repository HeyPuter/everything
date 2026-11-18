// Save follows the format a document came from: a PSD saves back as a PSD
// (asking first when it would lose something), and Save As offers both.
import { test, expect, type Page } from '@playwright/test';
import { boot, idle, openImage, run, start } from './helpers';

// A stubbed SDK with a drive in the page: writes and picker saves land in it.
const sdk = `
const drive=window.__drive={};
const item=(path)=>({path,name:path.split('/').pop(),read(){return window.puter.fs.read(this.path);}});
window.__item=item;window.__written=[];window.__picked=[];
window.puter={env:'app',auth:{isSignedIn:()=>true},
  fs:{read:async(path)=>{if(!drive[path])throw new Error('No such file');return drive[path];},
      write:async(path,blob)=>{drive[path]=blob;window.__written.push(path);return item(path);}},
  ui:{showSaveFilePicker:async(blob,name)=>{const path='/me/'+name;drive[path]=blob;window.__picked.push(name);return item(path);}}};`;

type Stub = { __drive: Record<string, Blob>; __item: (path: string) => object; __written: string[]; __picked: string[] };

/** Put a PSD of the open image on the drive and open it from there. */
async function openPsdFromDrive(page: Page, path = '/me/art.psd') {
  await openImage(page, 32, 24, '#ff0000', 'card.png');
  await page.evaluate(async (path) => {
    const w = window as unknown as Stub;
    const { buildPsd } = await import('/src/features/files/psd-export.ts');
    w.__drive[path] = (await buildPsd(window.photoStudio))!.blob;
    window.dispatchEvent(new CustomEvent('drop', { detail: { items: [w.__item(path)] } }));
  }, path);
  await expect.poll(() => page.evaluate(() => window.photoStudio.sessions.length)).toBe(2);
  await idle(page);
}
/** The first bytes of a drive file as text: "8BPS" for a PSD, "PHOTO001" for a project. */
const magic = (page: Page, path: string) =>
  page.evaluate(async (path) => new TextDecoder('latin1').decode(await (window as unknown as Stub).__drive[path].slice(0, 8).arrayBuffer()), path);
const stub = (page: Page) => page.evaluate(() => ({ written: (window as unknown as Stub).__written, picked: (window as unknown as Stub).__picked }));
const session = (page: Page) => page.evaluate(() => ({ file: window.photoStudio.session.fileName, path: window.photoStudio.session.storage.path, dirty: window.photoStudio.session.dirty }));

test('a PSD opened from Puter saves back to its own file as a PSD', async ({ page }) => {
  await boot(page, 'default', sdk);
  await openPsdFromDrive(page);
  expect(await session(page)).toEqual({ file: 'art.psd', path: '/me/art.psd', dirty: false });
  // Version History keeps a version on each save; versions are projects.
  await page.evaluate(async () => {
    window.photoStudio.preferences.versionsOnSave = true;
    const { VersionStore } = await import('/src/persistence/versions.ts');
    const add = VersionStore.prototype.add;
    VersionStore.prototype.add = async function (...args) {
      (window as unknown as { versionBlob: Blob }).versionBlob = args[1] as Blob;
      return add.apply(this, args);
    };
    window.photoStudio.command('Fade', (d) => (d.layers[0].opacity = 0.5));
  });
  await run(page, 'file.save');
  // Nothing would be lost, so nothing is asked.
  await expect(page.locator('#dialog[open]')).toHaveCount(0);
  expect(await stub(page)).toEqual({ written: ['/me/art.psd'], picked: [] });
  expect(await magic(page, '/me/art.psd')).toMatch(/^8BPS/);
  expect(await session(page)).toEqual({ file: 'art.psd', path: '/me/art.psd', dirty: false });
  // The file holds the edit.
  const opacity = await page.evaluate(async () => {
    const { openPsd } = await import('/src/model/psd.ts');
    const loaded = await openPsd((window as unknown as Stub).__drive['/me/art.psd'], 'art.psd', window.photoStudio.engine);
    return loaded.document.layers[0].opacity;
  });
  expect(opacity).toBeCloseTo(0.5, 2);
  await page.waitForFunction(() => !!(window as unknown as { versionBlob?: Blob }).versionBlob);
  const version = await page.evaluate(async () => {
    const { deserialize } = await import('/src/model/serialization.ts');
    return (await deserialize((window as unknown as { versionBlob: Blob }).versionBlob)).document.layers[0].opacity;
  });
  expect(version).toBe(0.5);
});

test('saving a PSD that would lose something asks once per kind of loss', async ({ page }) => {
  await boot(page, 'default', sdk);
  await openPsdFromDrive(page);
  // Guides are written to the PSD; slices are not.
  await page.evaluate(() =>
    window.photoStudio.command('Slice', (d) => {
      d.guides = [{ orientation: 'vertical', position: 4 }];
      d.slices = [{ id: crypto.randomUUID(), rect: { x: 0, y: 0, width: 8, height: 8 } }];
    }),
  );
  await start(page, 'file.save');
  const dialog = page.locator('#dialog[open]');
  await expect(dialog).toContainText('A PSD leaves out slices. A .photo project keeps everything.');
  // Cancelling writes nothing and leaves the document unsaved.
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await idle(page);
  expect(await stub(page)).toEqual({ written: [], picked: [] });
  expect((await session(page)).dirty).toBe(true);

  await start(page, 'file.save');
  await dialog.getByRole('button', { name: 'Save as PSD', exact: true }).click();
  await idle(page);
  expect(await stub(page)).toEqual({ written: ['/me/art.psd'], picked: [] });
  expect(await session(page)).toEqual({ file: 'art.psd', path: '/me/art.psd', dirty: false });

  // The same loss is not asked about again.
  await page.evaluate(() => window.photoStudio.command('Fade', (d) => (d.layers[0].opacity = 0.5)));
  await run(page, 'file.save');
  await expect(dialog).toHaveCount(0);
  expect((await stub(page)).written).toEqual(['/me/art.psd', '/me/art.psd']);

  // A new kind of loss asks again; a project goes to a file of its own.
  await page.evaluate(() => window.photoStudio.command('Info', (d) => (d.info = { title: 'Poster' })));
  await start(page, 'file.save');
  await expect(dialog).toContainText('A PSD leaves out slices and File Info.');
  await dialog.getByRole('button', { name: 'Save as .photo', exact: true }).click();
  await expect.poll(async () => (await stub(page)).picked).toEqual(['art.photo']);
  await idle(page);
  expect((await stub(page)).written).toEqual(['/me/art.psd', '/me/art.psd']);
  expect(await magic(page, '/me/art.photo')).toBe('PHOTO001');
  expect(await magic(page, '/me/art.psd')).toMatch(/^8BPS/);
  expect(await session(page)).toEqual({ file: 'art.photo', path: '/me/art.photo', dirty: false });
  // From here it is a project and saves as one.
  await page.evaluate(() => window.photoStudio.command('Fade', (d) => (d.layers[0].opacity = 0.25)));
  await run(page, 'file.save');
  await expect(dialog).toHaveCount(0);
  expect((await stub(page)).written).toEqual(['/me/art.psd', '/me/art.psd', '/me/art.photo']);
});

test('a new document saves as a project; Save As offers a PSD, which later saves keep', async ({ page }) => {
  await boot(page, 'default', sdk);
  await openImage(page, 32, 24, '#00ff00', 'card.png');
  await run(page, 'file.save');
  await expect.poll(async () => (await stub(page)).picked).toEqual(['card.photo']);
  await idle(page);
  expect(await magic(page, '/me/card.photo')).toBe('PHOTO001');

  await start(page, 'file.save-as');
  const dialog = page.locator('#dialog[open]');
  await expect(dialog.getByRole('button', { name: 'Photo Studio Project', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'PSD', exact: true }).click();
  await expect.poll(async () => (await stub(page)).picked).toEqual(['card.photo', 'card.psd']);
  await idle(page);
  expect(await magic(page, '/me/card.psd')).toMatch(/^8BPS/);
  expect(await session(page)).toEqual({ file: 'card.psd', path: '/me/card.psd', dirty: false });

  await page.evaluate(() => window.photoStudio.command('Fade', (d) => (d.layers[0].opacity = 0.5)));
  await run(page, 'file.save');
  await expect(dialog).toHaveCount(0);
  expect(await stub(page)).toEqual({ written: ['/me/card.psd'], picked: ['card.photo', 'card.psd'] });

  // A copy as a project leaves the document saving to its PSD.
  await start(page, 'file.save-copy');
  await dialog.getByRole('button', { name: 'Photo Studio Project', exact: true }).click();
  await expect.poll(async () => (await stub(page)).picked).toEqual(['card.photo', 'card.psd', 'card.photo']);
  await idle(page);
  expect(await session(page)).toEqual({ file: 'card.psd', path: '/me/card.psd', dirty: false });
});

test('an edited preview of a PSD that cannot be rewritten offers a project instead', async ({ page }) => {
  await boot(page, 'default', sdk);
  // Fill opacity is not imported: the file opens as a preview that keeps the original.
  await page.evaluate(async () => {
    const w = window as unknown as Stub;
    const { writePsd } = await import('/tests/browser/psd-codec.ts');
    const data = new Uint8ClampedArray(8 * 6 * 4).fill(255);
    const image = { width: 8, height: 6, data };
    const bytes = writePsd({ width: 8, height: 6, imageData: image, children: [{ name: 'Half', imageData: image, fillOpacity: 0.5 }] }, { noBackground: true });
    w.__drive['/me/preview.psd'] = new Blob([bytes]);
    window.dispatchEvent(new CustomEvent('drop', { detail: { items: [w.__item('/me/preview.psd')] } }));
  });
  await expect.poll(() => page.evaluate(() => window.photoStudio.hasDocument)).toBe(true);
  const dialog = page.locator('#dialog[open]');
  // The import notice.
  await dialog.getByRole('button').first().click();
  await idle(page);
  expect(await page.evaluate(() => !!window.photoStudio.doc.psdOriginal)).toBe(true);

  // Unedited, Save writes the original file back.
  const before = await page.evaluate(() => (window as unknown as Stub).__drive['/me/preview.psd'].size);
  await run(page, 'file.save');
  expect(await stub(page)).toEqual({ written: ['/me/preview.psd'], picked: [] });
  expect(await page.evaluate(() => (window as unknown as Stub).__drive['/me/preview.psd'].size)).toBe(before);

  await page.evaluate(() => window.photoStudio.command('Fade', (d) => (d.layers[0].opacity = 0.5)));
  await start(page, 'file.save');
  await expect(dialog).toContainText('This document cannot be saved as a PSD.');
  await dialog.getByRole('button', { name: 'Save as .photo', exact: true }).click();
  await expect.poll(async () => (await stub(page)).picked).toEqual(['preview.photo']);
  await idle(page);
  expect((await stub(page)).written).toEqual(['/me/preview.psd']);
  expect(await magic(page, '/me/preview.photo')).toBe('PHOTO001');
  expect(await session(page)).toEqual({ file: 'preview.photo', path: '/me/preview.photo', dirty: false });
});
