// Scripting: installing and running a script from File → Scripts (one undo
// step), the sandbox's isolation from the app, stopping a script that hangs,
// a sample script with its form, and a script run by a document event.
import { test, expect, type Page } from '@playwright/test';
import { boot, idle, menu, openImage, settleCommand } from './helpers';

const addLayers = `// @name Add Two Layers
// @description Test script
const doc = await studio.documents.active();
const red = await doc.addLayer({ name: 'From script', fill: '#ff0000', rect: { x: 10, y: 10, width: 50, height: 40 } });
await red.set({ opacity: 50, blendMode: 'multiply' });
await red.move(5, 5);
const px = await red.pixels({ x: 15, y: 15, width: 1, height: 1 });
console.log('pixel', Array.from(px.data).join(','));
await doc.addLayer({ kind: 'text', name: 'Caption', text: 'Hello', size: 20, x: 4, y: 4 });
`;

/** Run a script source directly (trusted, as the editor's Run does) and return its output lines. */
async function runSource(page: Page, source: string, name = 'Test') {
  return page.evaluate(
    async ({ source, name }) => {
      const { runScript, scriptLog, clearScriptLog } = await import('/src/features/scripting/run.ts');
      clearScriptLog();
      const from = scriptLog.length;
      await window.photoStudio.run(async () => void (await runScript(window.photoStudio, { name, source, trusted: true })));
      return scriptLog.slice(from).map((l) => `${l.level}: ${l.text}`);
    },
    { source, name },
  );
}

test.beforeEach(async ({ page }) => {
  await boot(page);
  await openImage(page, 160, 120, '#3070c0', 'script.png');
});

test('installs a script, runs it from File → Scripts after confirming, and undoes it in one step', async ({ page }) => {
  // The Scripts panel's install button (a click, so the browser shows the picker).
  await page.evaluate(() => window.photoStudio.dock.show('scripts'));
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Install script from file' }).click()]);
  await chooser.setFiles({ name: 'add-two-layers.js', mimeType: 'text/javascript', buffer: Buffer.from(addLayers) });
  await expect.poll(() => page.evaluate(async () => (await import('/src/features/scripting/store.ts')).listScripts().some((s) => s.name === 'Add Two Layers'))).toBe(true);
  await idle(page);
  const before = await page.evaluate(() => ({ position: window.photoStudio.history.position, layers: window.photoStudio.doc.layers.length }));

  await menu(page, 'File', 'Scripts', 'Add Two Layers');
  // A newly installed script asks before its first run.
  const confirm = page.getByRole('dialog', { name: 'Run Script?' });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Run Script' }).click();
  await expect.poll(() => page.evaluate(() => window.photoStudio.doc.layers.map((l) => l.name))).toEqual(['Background', 'From script', 'Caption']);
  await idle(page);
  const after = await page.evaluate(() => {
    const e = window.photoStudio;
    const red = e.doc.layers[1];
    return { position: e.history.position, opacity: red.opacity, blend: red.blend, x: red.transform.x, label: e.history.labels.at(-1), text: e.doc.layers[2].text };
  });
  expect(after).toMatchObject({ position: before.position + 1, opacity: 0.5, blend: 'multiply', x: 15, label: 'Add Two Layers (script)', text: 'Hello' });
  const log = await page.evaluate(async () => (await import('/src/features/scripting/run.ts')).scriptLog.map((l) => l.text));
  expect(log).toContain('pixel 255,0,0,255');

  await page.evaluate(() => window.photoStudio.runCommand('edit.undo'));
  await idle(page);
  expect(await page.evaluate(() => window.photoStudio.doc.layers.length)).toBe(before.layers);
  // Trusted now: the second run does not ask again.
  const id = await page.evaluate(async () => (await import('/src/features/scripting/store.ts')).listScripts().find((s) => s.name === 'Add Two Layers')!.id);
  await page.evaluate((id) => window.photoStudio.runCommand(`script.run.${id}`), id);
  await idle(page);
  await expect(page.getByRole('dialog', { name: 'Run Script?' })).toHaveCount(0);
  expect(await page.evaluate(() => window.photoStudio.doc.layers.length)).toBe(before.layers + 2);
});

test('keeps scripts away from the page, its storage and the network', async ({ page }) => {
  await page.evaluate(() => {
    localStorage.setItem('photo-studio-secret', 'xyz');
    document.cookie = 'session=abc';
  });
  const out = await runSource(
    page,
    `const probe = async (name, f) => { try { console.log(name, String(await f())); } catch (e) { console.log(name, 'blocked'); } };
await probe('window', () => typeof window);
await probe('document', () => typeof document);
await probe('parent', () => typeof parent);
await probe('localStorage', () => localStorage.getItem('photo-studio-secret'));
await probe('cookie', () => document.cookie);
await probe('indexedDB', () => new Promise((ok, no) => { const r = indexedDB.open('photo-studio-local'); r.onsuccess = () => ok('opened'); r.onerror = () => no(r.error); }));
await probe('fetch', async () => (await fetch(${JSON.stringify('http://127.0.0.1:' + (process.env.PHOTO_EDITOR_TEST_PORT ?? 5175) + '/index.html')})).status);
await probe('origin', () => self.origin);
await probe('puter', () => typeof puter);`,
  );
  expect(out).toEqual(
    expect.arrayContaining([
      'log: window undefined',
      'log: document undefined',
      'log: parent undefined',
      'log: localStorage blocked',
      'log: cookie blocked',
      'log: indexedDB blocked',
      'log: fetch blocked',
      'log: origin null',
      'log: puter undefined',
    ]),
  );
});

test('stops a script that hangs, reports errors with line numbers, and validates arguments', async ({ page }) => {
  const t0 = Date.now();
  const hang = await runSource(page, '// @timeout 2\nwhile (true) {}', 'Hang');
  expect(Date.now() - t0).toBeLessThan(15_000);
  expect(hang.join('\n')).toContain('did not respond for 2 seconds');
  // A loop that keeps logging, or calling the API, without awaiting is still stopped.
  const flood = await runSource(page, '// @timeout 2\nwhile (true) console.log("again")', 'Flood');
  expect(flood.at(-1)).toContain('did not respond for 2 seconds');
  expect(flood.length).toBeLessThan(200);
  const calls = await runSource(page, '// @timeout 2\nwhile (true) studio.app.info()', 'Calls');
  expect(calls.join('\n')).toMatch(/failed at line 2: More than 10000 API calls are waiting/);
  const swallowed = await runSource(page, '// @timeout 2\nwhile (true) try { studio.app.info() } catch {}', 'Swallowed');
  expect(swallowed.join('\n')).toContain('did not respond for 2 seconds');
  expect(Date.now() - t0).toBeLessThan(60_000);
  const failed = await runSource(page, 'const doc = await studio.documents.active();\n\nawait doc.addLayer({ kind: "sparkles" });', 'Bad');
  expect(failed.join('\n')).toMatch(/failed at line 3: kind must be/);
  const syntax = await runSource(page, 'let x = ;', 'Syntax');
  expect(syntax.join('\n')).toMatch(/Syntax.*failed/);
  // The workspace is free again.
  expect(await page.evaluate(() => window.photoStudio.busy)).toBe(false);
});

test('runs a sample script with its form', async ({ page }) => {
  await expect.poll(() => page.evaluate(async () => (await import('/src/features/scripting/store.ts')).listScripts().filter((s) => s.sample).length), { timeout: 20_000 }).toBeGreaterThanOrEqual(6);
  await menu(page, 'File', 'Scripts', 'Add Watermark');
  const form = page.getByRole('dialog', { name: 'Add Watermark' });
  await expect(form).toBeVisible();
  await expect(form.getByText('Script: Add Watermark')).toBeVisible();
  await form.getByLabel('Text', { exact: true }).fill('© Test');
  await form.getByRole('button', { name: 'Add' }).click();
  await expect.poll(() => page.evaluate(() => window.photoStudio.doc.layers.at(-1)?.name)).toBe('Watermark');
  await idle(page);
  const w = await page.evaluate(() => {
    const l = window.photoStudio.doc.layers.at(-1)!;
    return { text: l.text, opacity: l.opacity, shadow: !!(l.style as { dropShadow?: unknown[] } | undefined)?.dropShadow?.length, right: l.transform.x + l.transform.width };
  });
  expect(w.text).toBe('© Test');
  expect(w.opacity).toBeCloseTo(0.7);
  expect(w.shadow).toBe(true);
  expect(w.right).toBeLessThanOrEqual(160);
  expect(w.right).toBeGreaterThan(120);
});

test('runs a script when a new document is created (Script Events Manager)', async ({ page }) => {
  const id = await page.evaluate(async () => {
    const store = await import('/src/features/scripting/store.ts');
    const r = store.newScriptRecord(`// @name Stamp New Documents\nconst doc = await studio.documents.get(studio.event.documentId);\nawait doc.addLayer({ name: 'Stamped by ' + studio.event.name, fill: '#00ff00', rect: { x: 0, y: 0, width: 8, height: 8 } });`, 'Stamp', { trusted: true });
    await store.saveScript(r);
    return r.id;
  });
  await page.evaluate(() => void window.photoStudio.runCommand('file.script-events'));
  const manager = page.getByRole('dialog', { name: 'Script Events Manager' });
  await expect(manager).toBeVisible();
  await manager.getByLabel('When').selectOption('new-document');
  await manager.getByLabel('Which').selectOption(id);
  await manager.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(manager.getByText('New Document → Script: Stamp New Documents')).toBeVisible();
  await manager.getByRole('button', { name: 'Done' }).click();
  await settleCommand(page);

  await page.evaluate(async () => {
    const { createDocument } = await import('/src/features/files/new-document.ts');
    await createDocument(window.photoStudio, { name: 'Evented', width: 64, height: 48, unit: 'px', ppi: 72, ppiUnit: 'ppi', mode: 'rgb', background: 'white', color: '#ffffff', profile: 'working', pixelAspect: 1, artboards: false } as never);
  });
  await expect.poll(() => page.evaluate(() => window.photoStudio.doc.layers.map((l) => l.name))).toEqual(['Background', 'Stamped by New Document']);
  // Opening a file is a different event: no stamp.
  await openImage(page, 40, 30, '#ff00ff', 'other.png');
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window.photoStudio.doc.layers.map((l) => l.name))).toEqual(['Background']);
});

test('runs a script from its row in the Scripts panel even when it is not listed in File → Scripts', async ({ page }) => {
  await page.evaluate(async () => {
    const store = await import('/src/features/scripting/store.ts');
    const r = store.newScriptRecord(`// @name Unlisted Script\nconst doc = await studio.documents.active();\nawait doc.addLayer({ name: 'From unlisted', fill: '#00ff00', rect: { x: 0, y: 0, width: 8, height: 8 } });`, 'Unlisted', { trusted: true, enabled: false });
    await store.saveScript(r);
    window.photoStudio.dock.show('scripts');
  });
  const row = page.locator('.script-row', { hasText: 'Unlisted Script' });
  await expect(row.getByRole('checkbox')).not.toBeChecked();
  await row.getByRole('button', { name: 'Run Unlisted Script' }).click();
  await expect.poll(() => page.evaluate(() => window.photoStudio.doc.layers.map((l) => l.name))).toContain('From unlisted');
});
