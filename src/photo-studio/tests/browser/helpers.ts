// Shared helpers for driving the Photo Studio workspace from Playwright.
// Tests wait for editor state (busy flags, renderer settle, history labels)
// instead of sleeping, so they stay reliable on heavily loaded machines.
import { expect, type Locator, type Page } from '@playwright/test';
import type { Editor } from '../../src/editor';
import type { PhotoDocument } from '../../src/model/document';

declare global {
  interface Window {
    photoStudio: Editor;
  }
}

export type Backend = 'default' | 'WebGPU' | 'WebGL';

/** Load the workspace with a stubbed Puter SDK and wait for the compositor. */
export async function boot(page: Page, backend: Backend = 'default', puter = 'window.puter={env:"app",auth:{isSignedIn:()=>true}};') {
  if (backend === 'WebGL') await page.addInitScript(() => Object.defineProperty(navigator, 'gpu', { value: undefined }));
  await page.route('https://js.puter.com/**', (route) => route.fulfill({ contentType: 'application/javascript', body: puter }));
  await page.goto('/');
  await page.waitForFunction(() => !!window.photoStudio?.renderer, null, { timeout: 90_000 });
  await expect(page.locator('#engine-status')).toHaveText(backend === 'WebGL' ? 'WebGL2' : backend === 'WebGPU' ? 'WebGPU' : /WebGPU|WebGL2/);
}

/** Wait until no command, tool gesture or render is pending. */
export async function idle(page: Page) {
  await page.waitForFunction(() => !window.photoStudio.busy && !window.photoStudio.toolBusy, null, { timeout: 90_000 });
  await page.evaluate(async () => {
    // Two frames let the update loop schedule its render before settling.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await window.photoStudio.renderer.settle();
  });
}

/** Run a registered command and wait for it (and its render) to finish. */
export async function run(page: Page, id: string, arg?: unknown) {
  await page.evaluate(({ id, arg }) => window.photoStudio.runCommand(id, arg), { id, arg });
  await idle(page);
}

/** Start a command that opens a dialog without waiting for it to close. */
export async function start(page: Page, id: string, arg?: unknown) {
  await page.evaluate(({ id, arg }) => void window.photoStudio.runCommand(id, arg), { id, arg });
}

/** Encode a document and its assets as a native .photo project (PHOTO001). */
export function photoFile(doc: PhotoDocument | object, assets: unknown[] = [], name = 'fixture.photo') {
  const json = Buffer.from(JSON.stringify({ document: doc, assets }));
  const header = Buffer.alloc(12);
  header.write('PHOTO001');
  header.writeUInt32LE(json.length, 8);
  return { name, mimeType: 'application/octet-stream', buffer: Buffer.concat([header, json]) };
}

/** Open files through the workspace's file input (as File → Open does). */
export async function openFiles(page: Page, files: { name: string; mimeType: string; buffer: Buffer } | { name: string; mimeType: string; buffer: Buffer }[]) {
  const list = Array.isArray(files) ? files : [files];
  // Opening resets the session history, so the current document object changes.
  await page.evaluate(() => ((window as unknown as { __beforeOpen: unknown }).__beforeOpen = window.photoStudio.doc));
  await page.locator('#file-input').setInputFiles(list);
  await page.waitForFunction(
    (name) => {
      const e = window.photoStudio;
      return !e.busy && e.hasDocument && e.doc !== (window as unknown as { __beforeOpen: unknown }).__beforeOpen && e.session.fileName === name;
    },
    list.at(-1)!.name,
    { timeout: 90_000 },
  );
  await idle(page);
}

export async function openProject(page: Page, doc: PhotoDocument | object, assets: unknown[] = [], name = 'fixture.photo') {
  await openFiles(page, photoFile(doc, assets, name));
}

/** Open a solid or generated image as a new document through `openFile`. */
export async function openImage(page: Page, width = 200, height = 150, fill = '#808080', name = 'image.png') {
  await page.evaluate(
    async ({ width, height, fill, name }) => {
      const c = new OffscreenCanvas(width, height);
      const g = c.getContext('2d')!;
      g.fillStyle = fill;
      g.fillRect(0, 0, width, height);
      const blob = await c.convertToBlob({ type: 'image/png' });
      const { openFile } = await import('/src/features/files/open.ts');
      await openFile(window.photoStudio, blob, name);
    },
    { width, height, fill, name },
  );
  await idle(page);
}

/** Select a toolbar tool by its label, using the flyout when it is hidden. */
export async function tool(page: Page, label: string) {
  const slots = page.getByRole('toolbar', { name: 'Editing tools' });
  const direct = slots.getByRole('button', { name: label, exact: true });
  if (await direct.count()) await direct.click();
  else {
    const found = await page.evaluate(async (label) => {
      const { tools } = await import('/src/app/registry.ts');
      const t = [...tools.values()].find((t) => t.label === label);
      return t && { id: t.id, group: t.group };
    }, label);
    if (!found?.group) throw new Error(`No tool labelled ${label}`);
    await slots.locator(`[data-slot="${found.group}"]`).click({ button: 'right' });
    // By id: a name match for 'Healing Brush Tool' also hits 'Spot Healing Brush Tool'.
    await page.locator(`[role="menuitemradio"][data-flyout-tool="${found.id}"]`).click();
  }
  await expect.poll(() => page.evaluate(() => window.photoStudio.activeTool?.label)).toBe(label);
}

/** Click through the menu bar, e.g. menu(page, 'Layer', 'New', 'Layer via Copy'). */
export async function menu(page: Page, ...path: string[]) {
  const bar = page.getByRole('menubar');
  await bar.getByRole('menuitem', { name: path[0], exact: true }).click();
  let scope: Locator = bar.locator('.menubar-entry.open > .menu-pop');
  for (const [i, label] of path.slice(1).entries()) {
    const item = scope.locator(':scope > .menu-item').filter({ has: page.locator(':scope > .menu-label', { hasText: new RegExp(`^${escapeRegExp(label)}$`) }) });
    await expect(item).toHaveCount(1);
    if (i < path.length - 2) {
      await item.hover();
      scope = item.locator(':scope > .submenu');
    } else await item.click();
  }
  await settleCommand(page);
}

/** After starting a command: wait for it to finish, or for its dialog to open. */
export async function settleCommand(page: Page) {
  await page.waitForFunction(() => !window.photoStudio.busy || !!document.querySelector('dialog[open]'), null, { timeout: 90_000 });
  if (!(await page.locator('dialog[open]').count())) await idle(page);
}

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Bring a dock panel forward (tabs) or open its strip drawer. */
export async function panel(page: Page, title: string) {
  await page.evaluate((title) => {
    const e = window.photoStudio;
    const id = [...document.querySelectorAll<HTMLElement>('[data-panel-tab],[data-strip-panel]')].find((b) => (b.textContent?.trim() || b.getAttribute('aria-label')) === title);
    const key = id?.dataset.panelTab ?? id?.dataset.stripPanel;
    if (!key) throw new Error(`No panel ${title}`);
    if (!e.dock.isVisible(key)) e.dock.show(key);
  }, title);
  const body = page.locator(`.panel-body[aria-label="${title}"]`);
  await expect(body).toBeVisible();
  return body;
}

/** Client coordinates of a document point. */
export async function client(page: Page, x: number, y: number) {
  return page.evaluate(([x, y]) => window.photoStudio.clientPoint(x, y), [x, y] as const);
}

/** Click on the canvas at document coordinates. */
export async function canvasClick(page: Page, x: number, y: number, modifiers: ('Shift' | 'Alt' | 'ControlOrMeta')[] = []) {
  const [cx, cy] = await client(page, x, y);
  for (const m of modifiers) await page.keyboard.down(m);
  await page.mouse.click(cx, cy);
  for (const m of modifiers.reverse()) await page.keyboard.up(m);
  await idle(page);
}

/** Drag across the canvas through document points. */
export async function canvasDrag(page: Page, points: [number, number][], steps = 6, modifiers: ('Shift' | 'Alt' | 'ControlOrMeta')[] = []) {
  const [first, ...rest] = points;
  const start = await client(page, ...first);
  for (const m of modifiers) await page.keyboard.down(m);
  await page.mouse.move(start[0], start[1]);
  await page.mouse.down();
  for (const p of rest) {
    const [cx, cy] = await client(page, ...p);
    await page.mouse.move(cx, cy, { steps });
  }
  await page.mouse.up();
  for (const m of modifiers.reverse()) await page.keyboard.up(m);
  await idle(page);
}

export const historyLabels = (page: Page) => page.evaluate(() => window.photoStudio.history.labels);
export const layerNames = (page: Page) => page.evaluate(() => window.photoStudio.doc.layers.map((l) => l.name));
export const layerCount = (page: Page) => page.locator('#layer-count');

/** A layer row's select button in the Layers panel. */
export const layerRow = (page: Page, name: string) => page.locator('#layers').getByRole('button', { name, exact: true });
export const selectedRows = (page: Page) => page.locator('#layers .layer-row.selected');

export async function undo(page: Page) {
  await run(page, 'edit.undo');
}
export async function redo(page: Page) {
  await run(page, 'edit.redo');
}

/** RGBA of the flattened document at a point (GPU readback). */
export async function compositePixel(page: Page, x: number, y: number) {
  return page.evaluate(
    async ([x, y]) => {
      const e = window.photoStudio;
      await e.renderer.settle();
      const { compositeRGBA } = await import('/src/features/pixels.ts');
      const img = await compositeRGBA(e);
      const i = (Math.floor(y) * img.width + Math.floor(x)) * 4;
      return Array.from(img.data.slice(i, i + 4));
    },
    [x, y] as const,
  );
}

/** RGBA of the selected pixel layer's tiles at a document point. */
export async function layerPixel(page: Page, x: number, y: number) {
  return page.evaluate(
    async ([x, y]) => {
      const e = window.photoStudio;
      const { readRGBA } = await import('/src/model/tiles.ts');
      const l = e.layer!;
      if (!l.pixels) throw new Error(`Layer ${l.name} has no pixels`);
      return Array.from(readRGBA(e.assets.tiles, l.pixels, { x, y, width: 1, height: 1 }).data);
    },
    [x, y] as const,
  );
}

/** Rectangular selection made through the model (fast, exact). */
export async function selectRect(page: Page, r: { x: number; y: number; width: number; height: number }) {
  await page.evaluate(async (r) => {
    const e = window.photoStudio;
    const { filledMask } = await import('/src/model/tiles.ts');
    const { applySelection } = await import('/src/model/selection.ts');
    e.command('Rectangular Marquee', (d) => applySelection(d, filledMask(e.assets.tiles, r)));
  }, r);
  await idle(page);
}

/** Download triggered by a command; returns its bytes and suggested name. */
export async function downloadFrom(page: Page, trigger: () => Promise<unknown>) {
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 90_000 }), trigger()]);
  const path = await download.path();
  const { readFile } = await import('node:fs/promises');
  return { name: download.suggestedFilename(), bytes: await readFile(path!) };
}
