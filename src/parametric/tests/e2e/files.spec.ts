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
        async delete(path: string) { if (path.includes('Locked')) throw { message: 'Permission denied' }; files.delete(path); },
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
  // And is the recent part to open again.
  const recent = await page.evaluate(() => JSON.parse(localStorage.getItem('parametric:recent') || '[]'));
  expect(recent[0]).toMatchObject({ name: 'Bracket', location: { type: 'cloud', path: '/tester/Documents/Bracket.parametric' } });
});

test('a file that is not a part is refused before asking to discard, and changes nothing', async ({ page }) => {
  await mockPuter(page);
  await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  await app(page);
  await expect(page).toHaveTitle('Part1 - Parametric');
  for (const [name, text] of [['empty.parametric', ''], ['notes.json', '{"hello": 1}'], ['cut.parametric', '{"format":"parametric-part","version":1,"feat'], ['fake.sldprt', 'not a SolidWorks part'.repeat(40)]]) {
    const chooser = page.waitForEvent('filechooser');
    await page.evaluate(() => (window as unknown as { __parametric: AppHandle }).__parametric.commands.run('openDevice'));
    await (await chooser).setFiles({ name, mimeType: 'application/json', buffer: bytes(text) });
    await expect(page.getByRole('region', { name: 'Notifications' }).getByText(/Could not open the (part|SolidWorks file)/).first()).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page).toHaveTitle('Part1 - Parametric');
  }
  // With unsaved changes: still no question about them.
  await page.evaluate(() => (window as unknown as { __parametric: AppHandle }).__parametric.store.change('A', (d) => { d.variables.push({ name: 'A', expr: '1' }); }));
  for (const [name, message] of [['x.parametric', 'This file is not a valid part file.'], ['x.sldprt', 'This is not a SolidWorks part file.']]) {
    const chooser = page.waitForEvent('filechooser');
    await page.evaluate(() => (window as unknown as { __parametric: AppHandle }).__parametric.commands.run('openDevice'));
    await (await chooser).setFiles({ name, mimeType: 'application/octet-stream', buffer: bytes('nope'.repeat(200)) });
    await expect(page.getByRole('region', { name: 'Notifications' }).getByText(message).first()).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  }
});

test('a recent part that no longer exists says so and leaves the recent list', async ({ page }) => {
  await mockPuter(page);
  await page.addInitScript(() => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    localStorage.setItem('parametric:recent', JSON.stringify([
      { location: { type: 'cloud', path: '/tester/AppData/parametric/Parts/Gone.parametric' }, name: 'Gone', opened: 2 },
      { location: { type: 'local', id: 'part-missing' }, name: 'Vanished', opened: 1 },
    ]));
  });
  await openApp(page);
  const toasts = page.getByRole('region', { name: 'Notifications' });
  await page.getByRole('button', { name: /^Gone/ }).click();
  await expect(toasts.getByText('"Gone" no longer exists. It may have been moved or deleted.')).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: /^Vanished/ }).click();
  await expect(toasts.getByText('"Vanished" no longer exists. It may have been moved or deleted.')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('parametric:recent'))).toBe('[]');
});

test('unsaved work the user chose not to save is not offered for recovery later', async ({ page }) => {
  await mockPuter(page);
  await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  await app(page);
  await page.evaluate(() => (window as unknown as { __parametric: AppHandle }).__parametric.store.change('A', (d) => { d.variables.push({ name: 'A', expr: '1' }); }));
  // The recovery snapshot is written a few seconds after the last change.
  const recovery = () => page.evaluate(async (url) => (await import(url)).readRecovery(), '/src/platform/files.ts');
  await expect.poll(recovery, { timeout: 10_000 }).toContain('"name":"A"');
  const part = JSON.stringify({ format: 'parametric-part', version: 1, name: 'Other', units: 'MMGS', features: [] });
  const chooser = page.waitForEvent('filechooser');
  await page.evaluate(() => (window as unknown as { __parametric: AppHandle }).__parametric.commands.run('openDevice'));
  await (await chooser).setFiles({ name: 'Other.parametric', mimeType: 'application/json', buffer: bytes(part) });
  await page.getByRole('dialog', { name: 'Save changes?' }).getByRole('button', { name: "Don't save" }).click();
  await expect(page).toHaveTitle(/Other - Parametric/);
  await expect.poll(recovery).toBeNull();
});

test('each tab keeps its own recovery copy, and only copies from closed tabs are offered', async ({ context }) => {
  type Doc = { name: string; variables: { name: string; expr: string }[] };
  const edit = (p: Page, name: string) => p.evaluate((n) => (window as unknown as { __parametric: { store: { change(l: string, fn: (d: Doc) => void): void } } }).__parametric.store.change('E', (d) => { d.name = n; d.variables.push({ name: 'X', expr: '1' }); }), name);
  const recovery = (p: Page) => p.evaluate(async (url) => (await import(url)).readRecovery(), '/src/platform/files.ts');
  const recover = (p: Page) => p.getByRole('dialog', { name: 'Recover unsaved work?' });
  const start = async () => {
    const p = await context.newPage();
    await mockPuter(p);
    await openApp(p);
    return p;
  };
  const a = await start();
  await a.getByRole('button', { name: /New part/ }).click();
  await edit(a, 'Alpha');
  await expect.poll(() => recovery(a), { timeout: 10_000 }).toContain('"name":"Alpha"');
  // Another tab opened meanwhile: Alpha is still open, so it is not offered.
  const b = await start();
  await expect(b.getByRole('button', { name: /New part/ })).toBeVisible();
  await expect(recover(b)).toHaveCount(0);
  await b.getByRole('button', { name: /New part/ }).click();
  await edit(b, 'Beta');
  await expect.poll(() => recovery(b), { timeout: 10_000 }).toContain('"name":"Beta"');
  expect(await recovery(a)).toContain('"name":"Alpha"');
  // Alpha's tab goes away: its work is offered; closing the question keeps it.
  await a.close();
  const c = await start();
  await expect(recover(c)).toContainText('"Alpha"');
  await c.keyboard.press('Escape');
  await c.reload();
  await expect(recover(c)).toContainText('"Alpha"');
  await recover(c).getByRole('button', { name: 'Discard' }).click();
  await expect(c.getByRole('button', { name: /New part/ })).toBeVisible();
  await c.reload();
  await expect(c.getByRole('button', { name: /New part/ })).toBeVisible();
  await expect(recover(c)).toHaveCount(0);
  expect(await recovery(b)).toContain('"name":"Beta"');
});

test('a pending recovery copy is written as soon as the tab is hidden', async ({ page }) => {
  await mockPuter(page);
  await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  await app(page);
  await page.evaluate(() => (window as unknown as { __parametric: AppHandle }).__parametric.store.change('A', (d) => { d.variables.push({ name: 'Hidden', expr: '1' }); }));
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  // Well before the usual few seconds after the last change.
  await expect.poll(() => page.evaluate(async (url) => (await import(url)).readRecovery(), '/src/platform/files.ts'), { timeout: 1500 }).toContain('"name":"Hidden"');
});

test('the start screen gives way to work started behind it, which an example then does not replace silently', async ({ page }) => {
  await mockPuter(page);
  await openApp(page);
  await app(page);
  const start = page.getByRole('dialog', { name: 'Parametric' });
  await expect(start).toBeVisible();
  // As the assistant or the ribbon would, with the start screen still showing.
  await page.evaluate(() => (window as unknown as { __parametric: AppHandle }).__parametric.store.change('A', (d) => { d.variables.push({ name: 'Work', expr: '1' }); }));
  await expect(start).toHaveCount(0);
  await expect(page).toHaveTitle('* Part1 - Parametric');
});

test('a view-only shared file that is not a part is refused before asking to discard', async ({ page }) => {
  await mockPuter(page);
  await page.addInitScript(() => {
    const w = window as unknown as Mock & { puter: { fs: { listShared(): Promise<unknown> } } };
    w.__files.set('/alice/Parts/Notes.parametric', { text: 'not a part' });
    w.puter.fs.listShared = async () => ({ items: [{ name: 'Notes.parametric', path: '/alice/Parts/Notes.parametric', owner: 'alice', mode: 'read' }] });
  });
  await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  await app(page);
  await page.evaluate(() => {
    const a = (window as unknown as { __parametric: AppHandle }).__parametric;
    a.store.change('A', (d) => { d.variables.push({ name: 'A', expr: '1' }); });
    a.commands.run('open');
  });
  await page.getByRole('dialog', { name: 'Open' }).getByRole('button', { name: /^Notes/ }).click();
  await expect(page.getByRole('region', { name: 'Notifications' }).getByText('This file is not a valid part file.')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page).toHaveTitle('* Part1 - Parametric');
});

test('a save that fails offers to download a copy of the part', async ({ page }) => {
  await mockPuter(page);
  await page.addInitScript(() => {
    (window as unknown as { puter: { fs: { write(): Promise<never> } } }).puter.fs.write = async () => { throw new TypeError('Failed to fetch'); };
  });
  await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  await app(page);
  await page.evaluate(() => {
    const a = (window as unknown as { __parametric: AppHandle }).__parametric;
    a.store.change('A', (d) => { d.variables.push({ name: 'Width', expr: '10' }); });
    a.commands.run('save');
  });
  const toasts = page.getByRole('region', { name: 'Notifications' });
  await expect(toasts.getByText('Puter could not be reached. Check your connection and try again.')).toBeVisible();
  const download = page.waitForEvent('download');
  await toasts.getByRole('button', { name: 'Download a copy' }).click();
  expect((await download).suggestedFilename()).toBe('Part1.parametric');
  await expect(page).toHaveTitle('* Part1 - Parametric');
});

test('closing the Puter desktop window asks about unsaved changes first', async ({ page }) => {
  await mockPuter(page);
  await page.addInitScript(() => {
    const w = window as unknown as { puter: { env: string; exit(): void; ui: { onWindowClose(fn: () => void): void } }; __close?: () => void; __exited: number };
    w.__exited = 0;
    w.puter.env = 'app';
    w.puter.exit = () => { w.__exited++; };
    w.puter.ui.onWindowClose = (fn) => { w.__close = fn; };
  });
  await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  await app(page);
  type W = { __close: () => void; __exited: number; __parametric: AppHandle };
  const close = () => page.evaluate(() => { void (window as unknown as W).__close(); });
  const exited = () => page.evaluate(() => (window as unknown as W).__exited);
  await page.evaluate(() => (window as unknown as W).__parametric.store.change('A', (d) => { d.variables.push({ name: 'A', expr: '1' }); }));
  await close();
  const ask = page.getByRole('dialog', { name: 'Save changes?' });
  await ask.getByRole('button', { name: 'Cancel' }).click();
  expect(await exited()).toBe(0);
  await close();
  await ask.getByRole('button', { name: "Don't save" }).click();
  await expect.poll(exited).toBe(1);
});

test('parts are deleted from the Open dialog with a button, and stay listed when that fails', async ({ page }) => {
  await mockPuter(page);
  await page.addInitScript(() => {
    const files = (window as unknown as Mock).__files;
    for (const n of ['Bracket', 'Locked']) files.set(`/tester/AppData/parametric/Parts/${n}.parametric`, { text: JSON.stringify({ format: 'parametric-part', version: 1, name: n, units: 'MMGS', features: [] }) });
  });
  await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  await app(page);
  await page.evaluate(() => (window as unknown as { __parametric: AppHandle }).__parametric.commands.run('open'));
  const dialog = page.getByRole('dialog', { name: 'Open' });
  await expect(dialog.getByRole('listitem')).toHaveCount(2);
  await dialog.getByRole('button', { name: 'Delete Bracket' }).click();
  await page.getByRole('dialog', { name: 'Delete part' }).getByRole('button', { name: 'Delete' }).click();
  await expect(dialog.getByRole('button', { name: /^Bracket/ })).toHaveCount(0);
  expect(await page.evaluate(() => [...(window as unknown as Mock).__files.keys()])).toEqual(['/tester/AppData/parametric/Parts/Locked.parametric']);
  await dialog.getByRole('button', { name: 'Delete Locked' }).click();
  await page.getByRole('dialog', { name: 'Delete part' }).getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByRole('region', { name: 'Notifications' }).getByText('Permission denied')).toBeVisible();
  await expect(dialog.getByRole('button', { name: /^Locked/ })).toBeVisible();
});

test('opening a part puts it first in the recent parts', async ({ page }) => {
  await mockPuter(page);
  await page.addInitScript(() => {
    const files = (window as unknown as Mock).__files;
    for (const n of ['Bracket', 'Gear']) files.set(`/tester/AppData/parametric/Parts/${n}.parametric`, { text: JSON.stringify({ format: 'parametric-part', version: 1, name: n, units: 'MMGS', features: [] }) });
  });
  await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  await app(page);
  const recent = () => page.evaluate(() => (JSON.parse(localStorage.getItem('parametric:recent') || '[]') as { name: string }[]).map((r) => r.name));
  for (const name of ['Gear', 'Bracket']) {
    await page.evaluate(() => (window as unknown as { __parametric: AppHandle }).__parametric.commands.run('open'));
    await page.getByRole('dialog', { name: 'Open' }).getByRole('button', { name: new RegExp(`^${name}`) }).click();
    await expect(page).toHaveTitle(`${name} - Parametric`);
  }
  expect(await recent()).toEqual(['Bracket', 'Gear']);
});

test('an STL exported right after a change has the changed geometry', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await expect(page.getByRole('treeitem', { name: 'Fillet1' })).toBeVisible();
  await page.evaluate(() => (window as unknown as { __parametric: { whenBuilt(): Promise<void> } }).__parametric.whenBuilt());
  const download = page.waitForEvent('download');
  // Capture the exported file, then make the extrude 80 deep and export at once.
  const height = page.evaluate(() => new Promise<number>((resolve) => {
    const create = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (b: Blob | MediaSource) => {
      void (b as Blob).arrayBuffer().then((buf) => {
        const v = new DataView(buf);
        let lo = Infinity, hi = -Infinity;
        for (let i = 0, n = v.getUint32(80, true); i < n; i++) for (let k = 0; k < 3; k++) { const z = v.getFloat32(84 + i * 50 + 12 + k * 12 + 8, true); lo = Math.min(lo, z); hi = Math.max(hi, z); }
        resolve(hi - lo);
      });
      return create(b);
    };
    const a = (window as unknown as { __parametric: { store: { change(l: string, fn: (d: { features: { id: string; depth?: number }[] }) => void): void }; commands: { run(id: string): boolean } } }).__parametric;
    a.store.change('Depth', (d) => { d.features.find((f) => f.id === 'f1')!.depth = 80; });
    a.commands.run('exportStl');
  }));
  expect((await download).suggestedFilename()).toBe('Mounting Bracket.stl');
  expect(await height).toBeCloseTo(80, 3);
});

test('a feature panel with changes not applied asks before another part replaces it', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await expect(page.getByRole('treeitem', { name: 'Fillet1' })).toBeVisible();
  await page.getByRole('treeitem', { name: 'Extrude1', exact: true }).dblclick();
  const depth = page.getByRole('textbox', { name: /Depth/ }).first();
  await depth.fill('55');
  await depth.press('Tab');
  type Handle = { panel: unknown; store: { dirty: boolean; doc: { name: string; features: { id: string; depth?: unknown }[] } }; commands: { run(id: string): boolean } };
  const run = (id: string) => page.evaluate((c) => (window as unknown as { __parametric: Handle }).__parametric.commands.run(c), id);
  await run('new');
  const ask = page.getByRole('dialog', { name: 'Save changes?' });
  await expect(ask).toContainText('Extrude1');
  await ask.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator('.doc-title')).toHaveText('Mounting Bracket');
  await expect(depth).toHaveValue('55');
  // Save applies the panel first, then saves.
  await run('new');
  await ask.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.doc-title')).not.toHaveText('Mounting Bracket');
  // The saved part has the depth typed in the panel.
  const saved = await page.evaluate(async () => {
    const texts: string[] = [];
    const walk = async (d: FileSystemDirectoryHandle) => {
      for await (const h of (d as unknown as { values(): AsyncIterable<FileSystemHandle> }).values()) {
        if (h.kind === 'directory') await walk(h as FileSystemDirectoryHandle);
        else texts.push(await (await (h as FileSystemFileHandle).getFile()).text());
      }
    };
    await walk(await navigator.storage.getDirectory());
    return texts.some((t) => t.includes('"name":"Mounting Bracket"') && t.includes('"depth":55'));
  });
  expect(saved).toBe(true);
});

test('a part file too large to read is refused with a message, before it is read', async ({ page }, info) => {
  const errors = await openApp(page);
  // A sparse file: its size without its bytes on disk.
  const fs = await import('node:fs');
  const path = info.outputPath('huge.parametric');
  fs.mkdirSync(info.outputDir, { recursive: true });
  fs.writeFileSync(path, '');
  fs.truncateSync(path, 250_000_000);
  try {
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: /Open from device/ }).click();
    await (await chooser).setFiles(path);
    await expect(page.locator('.toast.error')).toContainText('too large to open as a part (200 MB limit)');
  } finally {
    fs.rmSync(path);
  }
  expect(errors).toEqual([]);
});
