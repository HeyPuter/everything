import { type Page, expect, test } from '@playwright/test';
import { openApp } from './helpers';

type Mock = { __files: Map<string, { text: string }>; __writeDelay: number };
type AppHandle = { store: { dirty: boolean; change(label: string, fn: (d: { variables: { name: string; expr: string }[] }) => void): void }; commands: { run(id: string): boolean } };

// A signed-in Puter stand-in with an in-memory file system (never a real account).
async function mockPuter(page: Page) {
  await page.route(/js\.puter\.com/, (r) => r.fulfill({ body: '', contentType: 'text/javascript' }));
  await page.addInitScript(() => {
    const files = new Map<string, { text: string }>();
    const w = window as unknown as Mock & { puter: unknown };
    w.__files = files;
    w.__writeDelay = 0;
    const item = (path: string) => ({ name: path.split('/').pop()!, path, is_dir: false, modified: Math.floor(Date.now() / 1000), size: files.get(path)?.text.length ?? 0 });
    w.puter = {
      env: 'web',
      auth: { isSignedIn: () => true, signIn: async () => true, signOut: async () => {}, getUser: async () => ({ username: 'tester', uuid: 'u1' }) },
      fs: {
        async write(path: string, data: Blob | string) {
          const text = typeof data === 'string' ? data : await data.text();
          if (w.__writeDelay) await new Promise((r) => setTimeout(r, w.__writeDelay));
          const p = path.startsWith('/') ? path : `/tester/AppData/parametric/${path}`;
          files.set(p, { text });
          return item(p);
        },
        async read(path: string) { const f = files.get(path); if (!f) throw { code: 'subject_does_not_exist', message: 'Not found' }; return new Blob([f.text]); },
        async readdir(path: string) { const pre = `/tester/AppData/parametric/${path}/`; return [...files.keys()].filter((k) => k.startsWith(pre)).map(item); },
        async delete(path: string) { files.delete(path); },
        async rename(path: string, name: string) { const np = path.replace(/[^/]+$/, name); files.set(np, files.get(path)!); files.delete(path); return item(np); },
        async stat(path: string) { return item(path); },
        async mkdir() { return {}; },
        async listShared() { return { items: [] }; },
      },
      kv: { get: async () => undefined, set: async () => true, del: async () => true },
      ui: {
        // Puter's save dialog; the test decides what it answers.
        showSaveFilePicker(data: Blob, name: string) {
          const answer = (async () => {
            const path = await (w as unknown as { __savePick: (name: string) => Promise<string | undefined> }).__savePick(name);
            if (!path) return undefined;
            files.set(path, { text: await data.text() });
            return item(path);
          })();
          return Object.assign(answer.then((v) => v ?? Promise.reject(new Error('cancelled'))), { undefinedOnCancel: answer });
        },
      },
    };
  });
}

// File bytes for Playwright, which wants a Node Buffer (the project has no Node types).
const bytes = (s: string) => (globalThis as unknown as { Buffer: { from(s: string): never } }).Buffer.from(s);

const app = (page: Page) => page.waitForFunction(() => (window as unknown as { __parametric?: unknown }).__parametric);

test('edits made while a save is in progress stay unsaved', async ({ page }) => {
  await mockPuter(page);
  const errors = await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  await app(page);
  await page.evaluate(async () => {
    const w = window as unknown as Mock & { __parametric: AppHandle };
    const a = w.__parametric;
    a.store.change('A', (d) => { d.variables.push({ name: 'A', expr: '10' }); });
    w.__writeDelay = 800;
    a.commands.run('save');
    await new Promise((r) => setTimeout(r, 100));
    a.store.change('B', (d) => { d.variables.push({ name: 'B', expr: '20' }); });
  });
  await expect(page.getByRole('region', { name: 'Notifications' }).getByText('Saved to Parts/Part1.parametric')).toBeVisible();
  // The file has A only, so the part must still read as edited.
  expect(await page.evaluate(() => (window as unknown as { __parametric: AppHandle }).__parametric.store.dirty)).toBe(true);
  await expect(page).toHaveTitle(/^\* Part1/);
  expect(errors).toEqual([]);
});

test('cancelling the Save As location saves nothing', async ({ page }) => {
  await mockPuter(page);
  await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  await app(page);
  await page.evaluate(() => {
    const w = window as unknown as { __savePick: () => Promise<undefined>; __parametric: AppHandle };
    w.__savePick = async () => undefined;
    w.__parametric.store.change('A', (d) => { d.variables.push({ name: 'A', expr: '10' }); });
    w.__parametric.commands.run('saveAs');
  });
  await page.getByRole('dialog', { name: 'Save As' }).getByRole('textbox').fill('Bracket');
  await page.getByRole('button', { name: 'OK' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => [...(window as unknown as Mock).__files.keys()])).toEqual([]);
  await expect(page).toHaveTitle('* Part1 - Parametric');

  // Choosing a place saves there under the new name.
  await page.evaluate(() => {
    const w = window as unknown as { __savePick: (name: string) => Promise<string>; __parametric: AppHandle };
    w.__savePick = async (name) => `/tester/Documents/${name}`;
    w.__parametric.commands.run('saveAs');
  });
  await page.getByRole('dialog', { name: 'Save As' }).getByRole('textbox').fill('Bracket');
  await page.getByRole('button', { name: 'OK' }).click();
  await expect(page).toHaveTitle('Bracket - Parametric');
  const files = await page.evaluate(() => [...(window as unknown as Mock).__files.entries()].map(([k, v]) => [k, JSON.parse(v.text).name]));
  expect(files).toEqual([['/tester/Documents/Bracket.parametric', 'Bracket']]);
});

test('a file that is not a part is refused before asking to discard, and changes nothing', async ({ page }) => {
  await mockPuter(page);
  await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  await app(page);
  await expect(page).toHaveTitle('Part1 - Parametric');
  for (const [name, text] of [['empty.parametric', ''], ['notes.json', '{"hello": 1}'], ['cut.parametric', '{"format":"parametric-part","version":1,"feat']]) {
    const chooser = page.waitForEvent('filechooser');
    await page.evaluate(() => (window as unknown as { __parametric: AppHandle }).__parametric.commands.run('openDevice'));
    await (await chooser).setFiles({ name, mimeType: 'application/json', buffer: bytes(text) });
    await expect(page.getByRole('region', { name: 'Notifications' }).getByText('Could not open the part').first()).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page).toHaveTitle('Part1 - Parametric');
  }
  // With unsaved changes: still no question about them.
  await page.evaluate(() => (window as unknown as { __parametric: AppHandle }).__parametric.store.change('A', (d) => { d.variables.push({ name: 'A', expr: '1' }); }));
  const chooser = page.waitForEvent('filechooser');
  await page.evaluate(() => (window as unknown as { __parametric: AppHandle }).__parametric.commands.run('openDevice'));
  await (await chooser).setFiles({ name: 'x.parametric', mimeType: 'application/json', buffer: bytes('nope') });
  await expect(page.getByRole('region', { name: 'Notifications' }).getByText('This file is not a valid part file.').first()).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
