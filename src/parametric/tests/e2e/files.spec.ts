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
      ui: {},
    };
  });
}

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
