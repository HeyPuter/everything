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

test('Share waiting for Save does not open for a replacement document', async ({ page }) => {
  const errors = await sharingApp(page);
  await page.evaluate(() => {
    type W = { __parametric: import('../../src/app/app').App; puter: { fs: { write: (...args: unknown[]) => Promise<unknown> } }; saveStarted: boolean; releaseSave: () => void; shareDone: boolean };
    const w = window as unknown as W;
    const write = w.puter.fs.write;
    const gate = new Promise<void>((resolve) => { w.releaseSave = resolve; });
    w.puter.fs.write = async (...args) => { w.saveStarted = true; await gate; return write(...args); };
    w.__parametric.store.change('Original edits', (d) => { d.variables.push({ id: 'v1', name: 'Original', expr: '17' }); });
    void Promise.resolve(w.__parametric.commands.get('share')!.run()).then(() => { w.shareDone = true; });
  });
  await page.waitForFunction(() => (window as unknown as { saveStarted: boolean }).saveStarted);
  await page.evaluate(() => {
    const w = window as unknown as { __parametric: import('../../src/app/app').App; releaseSave: () => void };
    const a = w.__parametric;
    a.loadDocument({ ...a.store.doc, name: 'Replacement', variables: [] }, { type: 'cloud', path: '/tester/Replacement.parametric' });
    w.releaseSave();
  });
  await expect.poll(() => page.evaluate(() => (window as unknown as { shareDone: boolean }).shareDone)).toBe(true);
  await expect(page.getByRole('dialog', { name: /^Share / })).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { shareCalls: ShareCall[] }).shareCalls)).toEqual([]);
  await expect(page).toHaveTitle('Replacement - Parametric');
  expect(errors).toEqual([]);
});

for (const change of ['new document', 'Save As', 'rename'] as const) test(`Share closes when ${change} changes its target`, async ({ page }) => {
  const errors = await sharingApp(page);
  await page.evaluate(() => {
    const w = window as unknown as { __parametric: import('../../src/app/app').App; puter: { fs: { rename: (path: string, name: string) => Promise<unknown> } } };
    w.puter.fs.rename = async (path, name) => ({ path: path.replace(/[^/]+$/, name) });
    w.__parametric.commands.run('share');
  });
  const dialog = page.getByRole('dialog', { name: 'Share Original', exact: true });
  await expect(dialog).toBeVisible();
  await page.evaluate(() => {
    const a = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric;
    a.store.change('Edit', (d) => { d.variables.push({ id: 'v1', name: 'Width', expr: '17' }); });
    a.store.undo();
  });
  await expect(dialog).toBeVisible();
  if (change === 'new document') {
    await page.evaluate(() => {
      const a = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric;
      a.loadDocument({ ...a.store.doc, name: 'Replacement' }, { type: 'cloud', path: '/tester/Replacement.parametric' });
    });
  } else {
    await page.evaluate((change) => (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric.commands.run(change === 'Save As' ? 'saveAs' : 'rename'), change);
    const prompt = page.getByRole('dialog', { name: change === 'Save As' ? 'Save As' : 'Rename part', exact: true });
    await prompt.getByRole('textbox').fill('Replacement');
    await prompt.getByRole('button', { name: 'OK', exact: true }).click();
  }
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveTitle(/Replacement - Parametric/);
  expect(await page.evaluate(() => (window as unknown as { shareCalls: ShareCall[] }).shareCalls)).toEqual([]);
  expect(errors).toEqual([]);
});

test('a document replacement at Share acceptance prevents the old request', async ({ page }) => {
  const errors = await sharingApp(page);
  await page.evaluate(() => (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric.commands.run('share'));
  const dialog = page.getByRole('dialog', { name: 'Share Original', exact: true });
  await dialog.getByRole('textbox', { name: 'Person to share with' }).fill('friend');
  const share = dialog.getByRole('button', { name: 'Share', exact: true });
  await share.evaluate((button) => button.addEventListener('click', () => {
    const a = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric;
    a.newDocument('Replacement');
  }, { capture: true, once: true }));
  await share.click();
  expect(await page.evaluate(() => (window as unknown as { shareCalls: ShareCall[] }).shareCalls)).toEqual([]);
  await expect(dialog).toHaveCount(0);
  expect(errors).toEqual([]);
});

for (const scenario of ['next recipient', 'failed request'] as const) test(`a pending share preserves ${scenario} behavior`, async ({ page }) => {
  const errors = await sharingApp(page);
  await page.evaluate((scenario) => {
    type W = { __parametric: import('../../src/app/app').App; puter: { fs: { share: (...args: unknown[]) => Promise<unknown> } }; releaseShare: () => void; shareStarted: boolean };
    const w = window as unknown as W;
    const share = w.puter.fs.share;
    const gate = new Promise<void>((resolve) => { w.releaseShare = resolve; });
    let first = true;
    w.puter.fs.share = async (...args) => {
      const result = await share(...args);
      if (first) { first = false; w.shareStarted = true; await gate; if (scenario === 'failed request') throw new Error('Permission denied'); }
      return result;
    };
    w.__parametric.commands.run('share');
  }, scenario);
  const dialog = page.getByRole('dialog', { name: 'Share Original', exact: true });
  const who = dialog.getByRole('textbox', { name: 'Person to share with' });
  const share = dialog.getByRole('button', { name: 'Share', exact: true });
  await who.fill('first');
  await share.click();
  await page.waitForFunction(() => (window as unknown as { shareStarted: boolean }).shareStarted);
  await who.fill('next');
  await page.evaluate(() => (window as unknown as { releaseShare: () => void }).releaseShare());
  await expect(dialog).toContainText(scenario === 'failed request' ? 'Could not share: Permission denied' : 'Shared with first');
  await expect(who).toHaveValue('next');
  await expect(share).toBeEnabled();
  await share.click();
  await expect(dialog).toContainText('Shared with next');
  expect(await page.evaluate(() => (window as unknown as { shareCalls: ShareCall[] }).shareCalls.map((c) => c.recipient.username))).toEqual(['first', 'next']);
  await expect(who).toHaveValue('');
  expect(errors).toEqual([]);
});
