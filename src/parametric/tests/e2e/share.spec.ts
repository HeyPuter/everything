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

for (const scenario of ['next recipient', 'repeated Enter', 'failed request'] as const) test(`a pending share preserves ${scenario} behavior`, async ({ page }) => {
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
  if (scenario === 'repeated Enter') {
    await who.press('Enter');
    await who.press('Enter');
    expect(await page.evaluate(() => (window as unknown as { shareCalls: ShareCall[] }).shareCalls.length)).toBe(1);
  } else await who.fill('next');
  await page.evaluate(() => (window as unknown as { releaseShare: () => void }).releaseShare());
  await expect(dialog).toContainText(scenario === 'failed request' ? 'Could not share: Permission denied' : 'Shared with first');
  await expect(who).toHaveValue(scenario === 'repeated Enter' ? '' : 'next');
  await expect(share).toBeEnabled();
  if (scenario === 'repeated Enter') await who.fill('next');
  await share.click();
  await expect(dialog).toContainText('Shared with next');
  expect(await page.evaluate(() => (window as unknown as { shareCalls: ShareCall[] }).shareCalls.map((c) => c.recipient.username))).toEqual(['first', 'next']);
  await expect(who).toHaveValue('');
  expect(errors).toEqual([]);
});

test('failed access updates restore the last confirmed permission and allow retry', async ({ page }) => {
  const errors = await sharingApp(page);
  await page.evaluate(() => {
    type W = { __parametric: import('../../src/app/app').App; puter: { fs: { getShares: () => Promise<unknown>; share: (...args: unknown[]) => Promise<unknown> } }; releaseAccess: () => void; accessStarted: boolean };
    const w = window as unknown as W;
    const share = w.puter.fs.share;
    let calls = 0;
    const gate = new Promise<void>((resolve) => { w.releaseAccess = resolve; });
    w.puter.fs.getShares = async () => [{ holder: 'friend', mode: 'write' }];
    w.puter.fs.share = async (...args) => {
      const result = await share(...args);
      if (++calls !== 2) throw new Error('Permission denied');
      w.accessStarted = true; await gate; return result;
    };
    w.__parametric.commands.run('share');
  });
  const dialog = page.getByRole('dialog', { name: 'Share Original', exact: true });
  const access = dialog.getByRole('combobox', { name: 'Access for friend', exact: true });
  const remove = dialog.getByRole('button', { name: 'Remove friend', exact: true });
  await access.selectOption('read');
  await expect(dialog).toContainText('Permission denied');
  await expect(access).toHaveValue('write');
  await access.selectOption('read');
  await page.waitForFunction(() => (window as unknown as { accessStarted: boolean }).accessStarted);
  await expect(access).toBeDisabled();
  await expect(remove).toBeDisabled();
  await page.evaluate(() => (window as unknown as { releaseAccess: () => void }).releaseAccess());
  await expect(dialog).toContainText('Updated access for friend');
  await expect(access).toHaveValue('read');
  await expect(access).toBeEnabled();
  await expect(remove).toBeEnabled();
  await access.selectOption('write');
  await expect(dialog).toContainText('Permission denied');
  await expect(access).toHaveValue('read');
  expect(await page.evaluate(() => (window as unknown as { shareCalls: ShareCall[] }).shareCalls.map((c) => c.mode))).toEqual(['read', 'read', 'write']);
  expect(errors).toEqual([]);
});

for (const stale of ['rows', 'empty', 'error'] as const) test(`an older access-list ${stale} response cannot overwrite a refreshed list`, async ({ page }) => {
  const errors = await sharingApp(page);
  await page.evaluate((stale) => {
    type W = { __parametric: import('../../src/app/app').App; puter: { fs: { getShares: () => Promise<unknown> } }; releaseList: () => void; staleDelivered: boolean };
    const w = window as unknown as W;
    const gate = new Promise<void>((resolve) => { w.releaseList = resolve; });
    let calls = 0;
    w.puter.fs.getShares = async () => {
      if (++calls > 1) return [{ holder: 'friend', mode: 'read' }];
      await gate;
      w.staleDelivered = true;
      if (stale === 'error') throw new Error('Older listing failed');
      return stale === 'empty' ? [] : [{ holder: 'old-recipient', mode: 'write' }];
    };
    w.__parametric.commands.run('share');
  }, stale);
  const dialog = page.getByRole('dialog', { name: 'Share Original', exact: true });
  await dialog.getByRole('textbox', { name: 'Person to share with' }).fill('friend');
  await dialog.getByRole('button', { name: 'Share', exact: true }).click();
  await expect(dialog.getByRole('combobox', { name: 'Access for friend', exact: true })).toHaveValue('read');
  await page.evaluate(() => (window as unknown as { releaseList: () => void }).releaseList());
  await page.waitForFunction(() => (window as unknown as { staleDelivered: boolean }).staleDelivered);
  await expect(dialog.getByRole('table')).toHaveCount(1);
  await expect(dialog.getByRole('combobox', { name: /^Access for / })).toHaveCount(1);
  await expect(dialog).not.toContainText('Not shared with anyone yet.');
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  if (stale === 'error') {
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    await page.evaluate(() => {
      const w = window as unknown as { __parametric: import('../../src/app/app').App; puter: { fs: { getShares: () => Promise<unknown> } } };
      w.puter.fs.getShares = async () => { throw new Error('Current listing failed'); };
      w.__parametric.commands.run('share');
    });
    await expect(dialog.getByRole('alert')).toContainText('Current listing failed');
  }
  expect(errors).toEqual([]);
});

for (const failure of [false, true]) test(`access removal submits once and ${failure ? 'allows retry after failure' : 'refreshes after success'}`, async ({ page }) => {
  const errors = await sharingApp(page);
  await page.evaluate((failure) => {
    type W = { __parametric: import('../../src/app/app').App; puter: { fs: { getShares: () => Promise<unknown>; unshare: () => Promise<unknown> } }; releaseRemove: () => void; removeCalls: number };
    const w = window as unknown as W;
    let present = true;
    w.removeCalls = 0;
    const gate = new Promise<void>((resolve) => { w.releaseRemove = resolve; });
    w.puter.fs.getShares = async () => present ? [{ holder: 'friend', mode: 'read' }] : [];
    w.puter.fs.unshare = async () => {
      const call = ++w.removeCalls;
      await gate;
      if (failure && call === 1) throw new Error('Permission denied');
      present = false;
      return { revoked: 1 };
    };
    w.__parametric.commands.run('share');
  }, failure);
  const dialog = page.getByRole('dialog', { name: 'Share Original', exact: true });
  const remove = dialog.getByRole('button', { name: 'Remove friend', exact: true });
  const access = dialog.getByRole('combobox', { name: 'Access for friend', exact: true });
  await remove.dblclick();
  expect(await page.evaluate(() => (window as unknown as { removeCalls: number }).removeCalls)).toBe(1);
  await expect(remove).toBeDisabled();
  await expect(access).toBeDisabled();
  await page.evaluate(() => (window as unknown as { releaseRemove: () => void }).releaseRemove());
  if (failure) {
    await expect(dialog).toContainText('Permission denied');
    await expect(remove).toBeEnabled();
    await expect(access).toBeEnabled();
    await expect(access).toHaveValue('read');
    await remove.click();
  }
  await expect(dialog).toContainText('friend no longer has access');
  await expect(remove).toHaveCount(0);
  await expect(dialog).toContainText('Not shared with anyone yet.');
  expect(await page.evaluate(() => (window as unknown as { removeCalls: number }).removeCalls)).toBe(failure ? 2 : 1);
  expect(errors).toEqual([]);
});

for (const scenario of ['update', 'late list', 'failed update', 'remove', 'failed remove'] as const) test(`a Share list refresh preserves a pending ${scenario}`, async ({ page }) => {
  const errors = await sharingApp(page);
  await page.evaluate((scenario) => {
    type W = { __parametric: import('../../src/app/app').App; puter: { fs: { getShares: () => Promise<unknown>; share: (path: string, person: { username: string }, mode: string) => Promise<unknown>; unshare: () => Promise<unknown> } }; releaseMutation: () => void; releaseRefresh: () => void; mutationStarted: boolean; refreshStarted: boolean; refreshDelivered: boolean };
    const w = window as unknown as W;
    const people = new Map([['friend', 'write']]);
    const mutation = new Promise<void>((resolve) => { w.releaseMutation = resolve; });
    const refresh = new Promise<void>((resolve) => { w.releaseRefresh = resolve; });
    let reads = 0;
    w.puter.fs.getShares = async () => {
      const snapshot = [...people].map(([holder, mode]) => ({ holder, mode }));
      if (++reads === 2 && scenario === 'late list') { w.refreshStarted = true; await refresh; w.refreshDelivered = true; }
      return snapshot;
    };
    w.puter.fs.share = async (_path, person, mode) => {
      if (person.username === 'friend') { w.mutationStarted = true; await mutation; if (scenario === 'failed update') throw new Error('Update failed'); }
      people.set(person.username, mode); return [{ isNew: true }];
    };
    w.puter.fs.unshare = async () => {
      w.mutationStarted = true; await mutation;
      if (scenario === 'failed remove') throw new Error('Removal failed');
      people.delete('friend'); return { revoked: 1 };
    };
    w.__parametric.commands.run('share');
  }, scenario);
  const dialog = page.getByRole('dialog', { name: 'Share Original', exact: true });
  const access = dialog.getByRole('combobox', { name: 'Access for friend', exact: true });
  const remove = dialog.getByRole('button', { name: 'Remove friend', exact: true });
  if (scenario.includes('remove')) await remove.click();
  else await access.selectOption('read');
  await page.waitForFunction(() => (window as unknown as { mutationStarted: boolean }).mutationStarted);
  await dialog.getByRole('textbox', { name: 'Person to share with' }).fill('other');
  await dialog.getByRole('button', { name: 'Share', exact: true }).click();
  if (scenario === 'late list') {
    await page.waitForFunction(() => (window as unknown as { refreshStarted: boolean }).refreshStarted);
    await page.evaluate(() => (window as unknown as { releaseMutation: () => void }).releaseMutation());
    await expect(dialog).toContainText('Updated access for friend');
    await page.evaluate(() => (window as unknown as { releaseRefresh: () => void }).releaseRefresh());
    await page.waitForFunction(() => (window as unknown as { refreshDelivered: boolean }).refreshDelivered);
  } else {
    await expect(dialog.getByRole('combobox', { name: 'Access for other', exact: true })).toBeVisible();
    await expect(access).toBeDisabled();
    await expect(remove).toBeDisabled();
    await page.evaluate(() => (window as unknown as { releaseMutation: () => void }).releaseMutation());
  }
  if (scenario === 'remove') await expect(access).toHaveCount(0);
  else {
    await expect(access).toBeEnabled();
    await expect(remove).toBeEnabled();
    await expect(access).toHaveValue(scenario.startsWith('failed') ? 'write' : 'read');
  }
  await expect(dialog.getByRole('combobox', { name: 'Access for other', exact: true })).toHaveValue('read');
  if (scenario.startsWith('failed')) await expect(dialog).toContainText(scenario === 'failed update' ? 'Update failed' : 'Removal failed');
  expect(errors).toEqual([]);
});
