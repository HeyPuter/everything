// Signing out of Puter: the Libraries panel used to keep saying "Synced with
// Puter" and new local comments kept the account's name.
import { test, expect } from '@playwright/test';
import { boot, idle, openImage, run, start } from './helpers';

const stub = `window.__in=true;window.__fs=new Map();window.puter={env:"web",auth:{isSignedIn:()=>window.__in,getUser:async()=>({username:"alice"}),signOut:()=>{window.__in=false;}},
fs:{read:async(p)=>{const b=window.__fs.get(p);if(!b)throw Object.assign(new Error(p+" does not exist"),{code:"subject_does_not_exist"});return b;},
write:async(p,d)=>{window.__fs.set(p,typeof d==="string"?new Blob([d]):d);return {path:p,name:p.split("/").pop()};}}};`;
// The account menu Puter provides on the web, which signs out by itself and then says so.
const menu = `customElements.define("puter-user-menu",class extends HTMLElement{});`;

async function setUp(page: import('@playwright/test').Page, puter: string) {
  await boot(page, 'default', puter);
  await page.evaluate(() => new Promise<void>((resolve) => {
    const r = indexedDB.deleteDatabase('photo-studio-libraries');
    r.onsuccess = r.onerror = r.onblocked = () => resolve();
  }));
  await openImage(page, 80, 60, '#808080');
  await page.evaluate(() => {
    const e = window.photoStudio;
    if (!e.dock.isVisible('libraries')) e.dock.show('libraries');
  });
  const status = page.locator('.libraries-panel .lib-sync');
  await run(page, 'libraries.add-foreground');
  await run(page, 'libraries.sync');
  await expect(status).toContainText('Synced with Puter');
  const author = () => page.evaluate(async () => (await import('/src/features/collab/state.ts')).localAuthor().name);
  await author();
  await expect.poll(author).toBe('alice');
  return { status, author };
}

test('signing out from the account dialog signs new comments locally', async ({ page }) => {
  const { status, author } = await setUp(page, stub);
  await start(page, 'app.account');
  const dialog = page.locator('#dialog[open]');
  await expect(dialog).toContainText('Signed in as alice');
  await dialog.getByRole('button', { name: 'Sign out' }).click();
  await idle(page);
  expect(await page.evaluate(() => window.puter!.auth.isSignedIn())).toBe(false);
  await expect(status).toContainText('Saved in this browser');
  expect(await author()).not.toBe('alice');
});

test('signing out from the Puter account menu updates the Libraries status', async ({ page }) => {
  const { status, author } = await setUp(page, stub + menu);
  await page.evaluate(() => {
    (window as unknown as { __in: boolean }).__in = false;
    document.querySelector('puter-user-menu')!.dispatchEvent(new Event('signout'));
  });
  await expect(page.locator('#toast')).toContainText('Signed out');
  await expect(status).toContainText('Saved in this browser');
  expect(await author()).not.toBe('alice');
});
