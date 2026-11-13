import { expect, test, type Page } from '@playwright/test';
import { boot, canvasClick, canvasDrag, idle, openImage, run } from './helpers';
import type { Quad } from '../../src/features/transform/math';

async function prepare(page: Page, embedded = false) {
  await boot(page, 'default', `window.puter={env:'app',fs:{write:async(path)=>({path,name:'saved.photo'})},ui:{showSaveFilePicker:async()=>({path:'/saved.photo',name:'saved.photo'})}};`);
  await openImage(page, 32, 24, '#ff0000', 'original.png');
  if (embedded) await page.evaluate(async () => {
    const { openFile } = await import('/src/features/files/open.ts');
    const canvas = new OffscreenCanvas(16, 12), g = canvas.getContext('2d')!;
    g.fillStyle = '#0000ff'; g.fillRect(0, 0, 16, 12);
    await openFile(window.photoStudio, await canvas.convertToBlob({ type: 'image/png' }), 'placed.png', true);
  });
  await run(page, 'file.save');
  expect(await page.evaluate(() => window.photoStudio.session.dirty)).toBe(false);
  return page.evaluate(() => window.photoStudio.session.id);
}

async function markers(page: Page, id: string) {
  await idle(page);
  return page.locator(`.document-tab[data-session="${id}"] .dirty-dot`).evaluateAll((nodes) => nodes.map((n) => !(n as HTMLElement).hidden));
}

for (const kind of ['free', 'pixel', 'embedded']) test(`${kind} previews update every view’s unsaved marker and preserve tab focus`, async ({ page }) => {
  const id = await prepare(page, kind === 'embedded');
  await run(page, 'window.new-window');
  if (kind === 'pixel') await run(page, 'window.tile-all');
  if (kind === 'embedded') await run(page, 'window.float-all');
  await page.evaluate(async (kind) => {
    const e = window.photoStudio;
    if (kind === 'free') e.transform.begin();
    else {
      const { startSession } = await import('/src/features/transform/session.ts');
      const transform = startSession(e, { mode: 'distort' })!;
      await new Promise<void>((resolve) => { const check = () => transform.ready ? resolve() : setTimeout(check, 10); check(); });
    }
  }, kind);
  expect(await markers(page, id)).toEqual([false, false]);
  const close = page.locator('.document-tab.focused .tab-close');
  await close.focus();
  await page.evaluate(async (kind) => {
    Object.assign(window, { indicatorFocusedTab: document.activeElement });
    const e = window.photoStudio;
    if (kind === 'free') e.transform.nudge(4, 3);
    else {
      const { currentSession } = await import('/src/features/transform/session.ts');
      currentSession()!.nudge(4, 3);
    }
  }, kind);
  expect(await markers(page, id)).toEqual([true, true]);
  await expect(close).toBeFocused();
  expect(await page.evaluate(() => (window as unknown as { indicatorFocusedTab: Element }).indicatorFocusedTab.isConnected)).toBe(true);
  await page.evaluate(async (kind) => {
    if (kind === 'free') window.photoStudio.transform.nudge(-4, -3);
    else { const { currentSession } = await import('/src/features/transform/session.ts'); currentSession()!.nudge(-4, -3); }
  }, kind);
  expect(await markers(page, id)).toEqual([false, false]);
  await page.evaluate(() => { const e = window.photoStudio; e.transform.cancel(); e.modal?.cancel(); });
  expect(await markers(page, id)).toEqual([false, false]);
});

for (const failed of [false, true]) test(`pending asset ${failed ? 'failure clears' : 'completion preserves'} the unsaved marker in background views`, async ({ page }) => {
  const id = await prepare(page, true);
  await run(page, 'window.new-window');
  await page.evaluate(async (failed) => {
    const e = window.photoStudio;
    const { startSession } = await import('/src/features/transform/session.ts');
    const transform = startSession(e, { mode: 'distort', quad: [{ x: 4, y: 3 }, { x: 26, y: 3 }, { x: 20, y: 15 }, { x: 4, y: 15 }] as Quad })!;
    await new Promise<void>((resolve) => { const check = () => transform.ready ? resolve() : setTimeout(check, 10); check(); });
    const assets = e.assets, add = assets.add.bind(assets);
    assets.add = async (...args) => {
      assets.add = add;
      await new Promise<void>((resolve) => Object.assign(window, { finishIndicatorAsset: resolve }));
      if (failed) throw new Error('Indicator asset failed');
      return add(...args);
    };
  }, failed);
  await page.locator('#tool-options').getByRole('button', { name: 'Commit transform', exact: true }).click();
  await page.waitForFunction(() => !!(window as unknown as { finishIndicatorAsset?: () => void }).finishIndicatorAsset);
  const pending = await markers(page, id);
  await openImage(page, 16, 12, '#ffffff', 'other.png');
  await run(page, 'file.save');
  const background = await markers(page, id);
  const other = await page.evaluate(() => window.photoStudio.session.id);
  expect(await markers(page, other)).toEqual([false]);
  await page.evaluate(() => (window as unknown as { finishIndicatorAsset(): void }).finishIndicatorAsset());
  await page.evaluate(async (id) => { await window.photoStudio.sessions.find((s) => s.id === id)!.waitForEdits().catch(() => {}); }, id);
  expect(await markers(page, id)).toEqual([!failed, !failed]);
  expect(await markers(page, other)).toEqual([false]);
  expect(pending).toEqual([true, true]);
  expect(background).toEqual([true, true]);
});

for (const warp of ['pin-warp', 'perspective-warp', 'context-scale']) test(`${warp} shows pending changes and clears the marker on cancel`, async ({ page }) => {
  const id = await prepare(page);
  await run(page, `edit.${warp}`);
  if (warp === 'context-scale') await page.waitForFunction(() => !!(window.photoStudio.modal as unknown as { smallOrders?: unknown })?.smallOrders);
  else await page.waitForFunction(() => !!(window.photoStudio.modal as unknown as { ready?: boolean })?.ready);
  expect(await markers(page, id)).toEqual([false]);
  if (warp === 'pin-warp') {
    await canvasClick(page, 8, 12); await canvasClick(page, 24, 12);
    await canvasDrag(page, [[24, 12], [24, 17]]);
  } else if (warp === 'perspective-warp') {
    await canvasDrag(page, [[4, 4], [28, 20]]);
    await page.locator('#tool-options').getByRole('button', { name: 'Warp', exact: true }).click();
    await canvasDrag(page, [[28, 4], [24, 8]]);
  } else {
    await page.locator('#cs-w').fill('24'); await page.locator('#cs-w').press('Tab');
  }
  expect(await markers(page, id)).toEqual([true]);
  await page.evaluate(() => window.photoStudio.modal?.cancel());
  expect(await markers(page, id)).toEqual([false]);
});

for (const grouped of [false, true]) test(`free-transform marker updates avoid serializing the whole document for changed ${grouped ? 'group' : 'layer'} geometry`, async ({ page }) => {
  const id = await prepare(page);
  if (grouped) { await run(page, 'layer.group'); await run(page, 'file.save'); }
  await page.evaluate(() => {
    const e = window.photoStudio;
    e.transform.begin();
    const stringify = JSON.stringify;
    Object.assign(window, { indicatorSerializations: 0, restoreIndicatorStringify: () => { JSON.stringify = stringify; } });
    JSON.stringify = ((value: unknown, ...args: unknown[]) => {
      const doc = value as { version?: number; layers?: unknown } | undefined;
      if (doc?.version === 1 && doc.layers) (window as unknown as { indicatorSerializations: number }).indicatorSerializations++;
      return Reflect.apply(stringify, JSON, [value, ...args]);
    }) as typeof JSON.stringify;
    e.transform.nudge(4, 3);
  });
  try {
    expect(await markers(page, id)).toEqual([true]);
    expect(await page.evaluate(() => (window as unknown as { indicatorSerializations: number }).indicatorSerializations)).toBe(0);
  } finally {
    await page.evaluate(() => (window as unknown as { restoreIndicatorStringify(): void }).restoreIndicatorStringify());
  }
});
