import { type Page, expect, test } from '@playwright/test';
import { openApp } from './helpers';

type ShareCall = { path: string; recipient: { username?: string; email?: string }; mode: string };

// Isolates the dialog's SDK calls; these tests make no claims about Puter HTTP behavior.
async function sharingApp(page: Page) {
  await page.route(/js\.puter\.com/, (r) => r.fulfill({ body: '', contentType: 'text/javascript' }));
  await page.addInitScript(() => {
    const w = window as unknown as { puter: unknown; shareCalls: ShareCall[] };
    w.shareCalls = [];
    w.puter = {
      env: 'web',
      auth: { isSignedIn: () => true, getUser: async () => ({ username: 'tester' }) },
      kv: { get: async () => undefined, set: async () => true },
      fs: {
        getShares: async () => [],
        share: async (path: string, recipient: ShareCall['recipient'], mode: string) => { w.shareCalls.push({ path, recipient, mode }); return [{ isNew: true }]; },
        unshare: async () => ({ revoked: 1 }),
        write: async (path: string) => ({ path, name: path.split('/').pop() }),
        readdir: async () => [],
        listShared: async () => ({ items: [] }),
      },
      ui: {},
    };
  });
  const errors = await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  await page.evaluate(() => {
    const a = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric;
    a.loadDocument({ ...a.store.doc, name: 'Original' }, { type: 'cloud', path: '/tester/Original.parametric' });
  });
  return errors;
}

for (const legacy of [false, true]) test(`IME ${legacy ? 'keyCode 229' : 'composition'} Enter does not submit a share`, async ({ page }) => {
  const errors = await sharingApp(page);
  await page.evaluate(() => (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric.commands.run('share'));
  const dialog = page.getByRole('dialog', { name: 'Share Original', exact: true });
  const who = dialog.getByRole('textbox', { name: 'Person to share with' });
  await who.fill('candidate');
  await who.evaluate((el, legacy) => {
    el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: !legacy, keyCode: legacy ? 229 : 13, bubbles: true, cancelable: true }));
    el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'candidate' }));
  }, legacy);
  expect(await page.evaluate(() => (window as unknown as { shareCalls: ShareCall[] }).shareCalls)).toEqual([]);
  await expect(who).toHaveValue('candidate');
  await expect(dialog).toBeVisible();
  await who.fill('chosen@example.test');
  await who.press('Enter');
  await expect(dialog).toContainText('Shared with chosen@example.test');
  expect(await page.evaluate(() => (window as unknown as { shareCalls: ShareCall[] }).shareCalls)).toEqual([
    { path: '/tester/Original.parametric', recipient: { email: 'chosen@example.test' }, mode: 'read' },
  ]);
  expect(errors).toEqual([]);
});
