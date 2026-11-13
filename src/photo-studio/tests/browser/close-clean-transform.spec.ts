import { expect, test, type Page } from '@playwright/test';
import { boot, canvasClick, canvasDrag, idle, openImage, run } from './helpers';
import type { Quad } from '../../src/features/transform/math';

async function prepare(page: Page, kind: string, changed: boolean) {
  await boot(page, 'default', `window.puter={env:'app',fs:{write:async(path,blob)=>{
    window.cleanCloseBlob=blob;return {path,name:'clean.photo'};
  }},ui:{showSaveFilePicker:async(blob)=>{
    window.cleanCloseBlob=blob;return {path:'/clean.photo',name:'clean.photo'};
  }}};`);
  await openImage(page, 32, 24, '#ff0000', 'original.png');
  if (kind.startsWith('embedded')) await page.evaluate(async () => {
    const { openFile } = await import('/src/features/files/open.ts');
    const c = new OffscreenCanvas(16, 12), g = c.getContext('2d')!;
    g.fillStyle = '#0000ff'; g.fillRect(0, 0, 16, 12);
    await openFile(window.photoStudio, await c.convertToBlob({ type: 'image/png' }), 'placed.png', true);
  });
  await run(page, 'file.save');
  expect(await page.evaluate(() => window.photoStudio.session.dirty)).toBe(false);
  return page.evaluate(async ({ kind, changed }) => {
    const e = window.photoStudio;
    delete (window as unknown as { cleanCloseBlob?: Blob }).cleanCloseBlob;
    if (kind === 'free') {
      e.transform.begin();
      if (changed) e.transform.nudge(4, 3);
    } else {
      const { startSession } = await import('/src/features/transform/session.ts');
      const transform = startSession(e, { mode: kind.endsWith('-warp') ? 'warp' : 'distort', ...(changed ? { quad: [{ x: 4, y: 3 }, { x: 26, y: 3 }, { x: 20, y: 15 }, { x: 4, y: 15 }] as Quad } : {}) })!;
      await new Promise<void>((resolve) => { const check = () => transform.ready ? resolve() : setTimeout(check, 10); check(); });
    }
    return e.session.id;
  }, { kind, changed });
}

for (const kind of ['free', 'pixel', 'embedded']) for (const choice of ['Cancel', 'Don’t Save', 'Save']) test(`closing a saved document with a pending ${kind} transform offers ${choice}`, async ({ page }) => {
  const original = await prepare(page, kind, true);
  await page.locator('.document-tab.focused .tab-close').click();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(await page.evaluate((id) => window.photoStudio.sessions.some((s) => s.id === id), original)).toBe(true);
  const dialog = page.locator('dialog[open]');
  await expect(dialog).toContainText('Save changes');
  await dialog.getByRole('button', { name: choice, exact: true }).click();
  await idle(page);
  await expect.poll(() => page.evaluate((id) => window.photoStudio.sessions.some((s) => s.id === id), original)).toBe(choice === 'Cancel');
  if (choice === 'Cancel') expect(await page.evaluate(() => ({ clean: !window.photoStudio.session.dirty, pending: window.photoStudio.transform.changed || !!window.photoStudio.modal }))).toEqual({ clean: true, pending: true });
  if (choice !== 'Save') expect(await page.evaluate(() => !!(window as unknown as { cleanCloseBlob?: Blob }).cleanCloseBlob)).toBe(false);
  else expect(await page.evaluate(async () => {
    const { deserialize } = await import('/src/model/serialization.ts');
    const saved = await deserialize((window as unknown as { cleanCloseBlob: Blob }).cleanCloseBlob);
    return saved.document.layers.at(-1)!.transform;
  })).toMatchObject({ x: 4, y: 3 });
});

for (const kind of ['free', 'pixel', 'embedded', 'pixel-warp', 'embedded-warp']) test(`an unchanged ${kind} transform closes without a save prompt`, async ({ page }) => {
  const original = await prepare(page, kind, false);
  await page.locator('.document-tab.focused .tab-close').click();
  await expect.poll(() => page.evaluate((id) => window.photoStudio.sessions.some((s) => s.id === id), original)).toBe(false);
  expect(await page.locator('dialog[open]').count()).toBe(0);
  expect(await page.evaluate(() => !!(window as unknown as { cleanCloseBlob?: Blob }).cleanCloseBlob)).toBe(false);
});

for (const choice of ['Cancel', 'Don’t Save', 'Save']) test(`closing clean embedded contents with a pending transform offers ${choice}`, async ({ page }) => {
  const parent = await prepare(page, 'embedded', false);
  await page.evaluate(() => window.photoStudio.modal?.cancel());
  await run(page, 'layer.embed-edit');
  const child = await page.evaluate(() => {
    const e = window.photoStudio;
    e.transform.begin();
    e.transform.nudge(4, 3);
    return e.session.id;
  });
  expect(await page.evaluate(() => window.photoStudio.session.dirty)).toBe(false);
  await page.locator('.document-tab.focused .tab-close').click();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(await page.evaluate((id) => window.photoStudio.sessions.some((s) => s.id === id), child)).toBe(true);
  const dialog = page.locator('dialog[open]');
  await expect(dialog).toContainText('Saving updates the embedded object');
  await dialog.getByRole('button', { name: choice, exact: true }).click();
  await idle(page);
  await expect.poll(() => page.evaluate((id) => window.photoStudio.sessions.some((s) => s.id === id), child)).toBe(choice === 'Cancel');
  if (choice === 'Cancel') expect(await page.evaluate(() => window.photoStudio.transform.changed)).toBe(true);
  if (choice === 'Save') expect(await page.evaluate(async (id) => {
    const s = window.photoStudio.sessions.find((s) => s.id === id)!;
    const contents = s.doc.embeds![s.doc.layers.at(-1)!.embed!.contents];
    const { deserialize } = await import('/src/model/serialization.ts');
    return (await deserialize(s.assets.blob(contents.project!))).document.layers.at(-1)!.transform;
  }, parent)).toMatchObject({ x: 4, y: 3 });
});

for (const warp of ['pin-warp', 'perspective-warp', 'context-scale']) for (const changed of [false, true]) test(`${warp} ${changed ? 'prompts to keep its pending edit' : 'closes unchanged without prompting'}`, async ({ page }) => {
  const original = await prepare(page, 'free', false);
  await page.evaluate(() => window.photoStudio.transform.cancel());
  await run(page, `edit.${warp}`);
  if (warp === 'context-scale') await page.waitForFunction(() => !!(window.photoStudio.modal as unknown as { smallOrders?: unknown })?.smallOrders);
  else await page.waitForFunction(() => !!(window.photoStudio.modal as unknown as { ready?: boolean })?.ready);
  if (changed) {
    if (warp === 'pin-warp') {
      await canvasClick(page, 8, 12);
      await canvasClick(page, 24, 12);
      await canvasDrag(page, [[24, 12], [24, 17]]);
    } else if (warp === 'perspective-warp') {
      await canvasDrag(page, [[4, 4], [28, 20]]);
      await page.locator('#tool-options').getByRole('button', { name: 'Warp', exact: true }).click();
      await canvasDrag(page, [[28, 4], [24, 8]]);
    } else {
      await page.locator('#cs-w').fill('24');
      await page.locator('#cs-w').press('Tab');
    }
  }
  await page.locator('.document-tab.focused .tab-close').click();
  if (changed) {
    const dialog = page.locator('dialog[open]');
    await expect(dialog).toContainText('Save changes');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(await page.evaluate(() => window.photoStudio.hasPendingChanges())).toBe(true);
  } else {
    await expect.poll(() => page.evaluate((id) => window.photoStudio.sessions.some((s) => s.id === id), original)).toBe(false);
    expect(await page.locator('dialog[open]').count()).toBe(0);
  }
});

test('closing another saved tab preserves the active tab’s pending transform', async ({ page }) => {
  const first = await prepare(page, 'free', false);
  await page.evaluate(() => window.photoStudio.transform.cancel());
  await openImage(page, 16, 12, '#ffffff', 'second.png');
  await run(page, 'file.save');
  const target = await page.evaluate((id) => {
    const e = window.photoStudio;
    e.transform.begin(); e.transform.nudge(4, 3);
    return e.views.find((v) => v.session.id === id)!.id;
  }, first);
  await page.locator(`[data-close-view="${target}"]`).click();
  await expect.poll(() => page.evaluate((id) => window.photoStudio.sessions.some((s) => s.id === id), first)).toBe(false);
  expect(await page.locator('dialog[open]').count()).toBe(0);
  expect(await page.evaluate(() => window.photoStudio.transform.changed)).toBe(true);
});

for (const changed of [false, true]) test(`an existing embedded mesh ${changed ? 'prompts after a mesh edit' : 'closes unchanged without prompting'}`, async ({ page }) => {
  const original = await prepare(page, 'embedded-warp', false);
  await page.evaluate(async () => {
    const { currentSession } = await import('/src/features/transform/session.ts');
    currentSession()!.setWarp('arc', 30);
    await window.photoStudio.modal!.apply();
  });
  await run(page, 'file.save');
  await page.evaluate(async (changed) => {
    const { startSession } = await import('/src/features/transform/session.ts');
    const transform = startSession(window.photoStudio, { mode: 'warp' })!;
    if (changed) transform.setWarp('arc', 60);
  }, changed);
  await page.locator('.document-tab.focused .tab-close').click();
  if (changed) {
    const dialog = page.locator('dialog[open]');
    await expect(dialog).toContainText('Save changes');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(await page.evaluate(() => window.photoStudio.hasPendingChanges())).toBe(true);
  } else {
    await expect.poll(() => page.evaluate((id) => window.photoStudio.sessions.some((s) => s.id === id), original)).toBe(false);
    expect(await page.locator('dialog[open]').count()).toBe(0);
  }
});
