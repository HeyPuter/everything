// Files handed over by the Puter desktop: launched with (double-click, "Open
// with") or dragged onto the window from the desktop.
import { test, expect } from '@playwright/test';
import { boot, idle } from './helpers';

// A stubbed SDK whose drive holds /me/Desktop/card.png (a 6×4 red PNG drawn in
// the page) and whatever `window.__drive` adds; `launch` lists the launch items.
const sdk = (launch: string[]) => `
const png=async()=>{const c=new OffscreenCanvas(6,4);const g=c.getContext('2d');g.fillStyle='#f00';g.fillRect(0,0,6,4);return c.convertToBlob({type:'image/png'});};
const drive=window.__drive={'/me/Desktop/card.png':png};
const item=(path)=>({path,name:path.split('/').pop(),read(){return window.puter.fs.read(this.path);}});
window.__item=item;
window.puter={env:'app',auth:{isSignedIn:()=>true},
  fs:{read:async(path)=>{if(!drive[path])throw new Error('No such file');return drive[path]();},
      write:async(path,blob)=>{(window.__written??=[]).push(path);return item(path);}},
  ui:{onLaunchedWithItems:(fn)=>{const items=${JSON.stringify(launch)}.map(item);if(items.length)fn(items);}}};`;

test('a file the app is launched with opens from its Puter path', async ({ page }) => {
  await boot(page, 'default', sdk(['/me/Desktop/card.png']));
  await expect.poll(() => page.evaluate(() => window.photoStudio.hasDocument)).toBe(true);
  await idle(page);
  const state = await page.evaluate(() => {
    const e = window.photoStudio;
    return { name: e.doc.name, width: e.doc.width, height: e.doc.height, file: e.session.fileName, sessions: e.sessions.length };
  });
  expect(state).toEqual({ name: 'card', width: 6, height: 4, file: 'card.png', sessions: 1 });
  // It is listed in Open Recent by its Puter path.
  const recent = await page.evaluate(() => JSON.parse(localStorage.getItem('photo-studio-recent') ?? '[]'));
  expect(recent[0]).toMatchObject({ name: 'card.png', path: '/me/Desktop/card.png' });
});

test('a .photo project handed over by the desktop saves back to its own file', async ({ page }) => {
  await boot(page, 'default', sdk(['/me/Desktop/card.png']));
  await expect.poll(() => page.evaluate(() => window.photoStudio.hasDocument)).toBe(true);
  await idle(page);
  // An image has no project path of its own.
  expect(await page.evaluate(() => window.photoStudio.session.storage.path)).toBeUndefined();
  await page.evaluate(async () => {
    const w = window as unknown as { __drive: Record<string, () => Promise<Blob>>; __item: (path: string) => object };
    const { serialize } = await import('/src/model/serialization.ts');
    const blob = await serialize(window.photoStudio.doc, window.photoStudio.session.assets);
    w.__drive['/me/Documents/poster.photo'] = async () => blob;
    window.dispatchEvent(new CustomEvent('drop', { detail: { items: [w.__item('/me/Documents/poster.photo')] } }));
  });
  await expect.poll(() => page.evaluate(() => window.photoStudio.sessions.length)).toBe(2);
  await idle(page);
  expect(await page.evaluate(() => window.photoStudio.session.storage.path)).toBe('/me/Documents/poster.photo');
  await page.evaluate(() => window.photoStudio.runCommand('file.save'));
  await idle(page);
  expect(await page.evaluate(() => (window as unknown as { __written: string[] }).__written)).toEqual(['/me/Documents/poster.photo']);
});

test('files dragged in from the Puter desktop open; folders are refused', async ({ page }) => {
  await boot(page, 'default', sdk([]));
  expect(await page.evaluate(() => window.photoStudio.hasDocument)).toBe(false);
  await page.evaluate(() => {
    const w = window as unknown as { __item: (path: string) => object };
    window.dispatchEvent(new CustomEvent('drop', { detail: { items: [{ path: '/me/Pictures', name: 'Pictures', is_dir: true }] } }));
    (window as unknown as { __folderMessage: string | null }).__folderMessage = document.querySelector('#status')!.textContent;
    window.dispatchEvent(new CustomEvent('drop', { detail: { items: [w.__item('/me/Desktop/card.png')] } }));
  });
  expect(await page.evaluate(() => (window as unknown as { __folderMessage: string }).__folderMessage)).toContain('Folders cannot be opened');
  await expect.poll(() => page.evaluate(() => window.photoStudio.hasDocument)).toBe(true);
  await idle(page);
  expect(await page.evaluate(() => [window.photoStudio.doc.name, window.photoStudio.doc.width])).toEqual(['card', 6]);
});

test('a launched file that cannot be read says so', async ({ page }) => {
  await boot(page, 'default', sdk(['/me/Desktop/gone.png']));
  await expect(page.locator('#status')).toContainText('No such file');
  expect(await page.evaluate(() => window.photoStudio.hasDocument)).toBe(false);
});
