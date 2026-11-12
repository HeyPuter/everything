import { test, expect, type Page } from '@playwright/test';
import { layer, newDocument } from '../../src/model/document';
import { readFileSync } from 'node:fs';
import { boot, compositePixel, historyLabels, idle, menu, openImage, openProject, run } from './helpers';

async function loadFixture(page: Page) {
  const doc = newDocument(320, 240, 'Poster');
  const paper = layer('solid', 'Paper', 320, 240);
  paper.color = '#f0f0f0';
  const a = layer('solid', 'Red', 60, 40),
    b = layer('solid', 'Blue', 40, 40);
  a.color = '#ff0000';
  b.color = '#0000ff';
  Object.assign(a.transform, { x: 20, y: 30 });
  Object.assign(b.transform, { x: 60, y: 50 });
  doc.layers = [paper, a, b];
  await openProject(page, doc, [], 'poster.photo');
  await page.evaluate(() => {
    const e = window.photoStudio;
    e.selectLayers(e.doc.layers.slice(1).map((l) => l.id));
    e.update();
  });
}
const state = (page: Page) =>
  page.evaluate(() => {
    const e = window.photoStudio;
    return {
      layers: e.doc.layers.map((l) => ({ name: l.name, kind: l.kind, contents: l.embed?.contents, t: l.transform })),
      embeds: Object.keys(e.doc.embeds ?? {}).length,
      sessions: e.sessions.length,
    };
  });

test('convert layers, edit the contents in a tab and save to update every instance', async ({ page }) => {
  await boot(page);
  await loadFixture(page);
  await menu(page, 'Layer', 'Embedded Objects', 'Convert to Embedded Object');
  await idle(page);
  let s = await state(page);
  expect(s.layers.map((l) => [l.name, l.kind])).toEqual([['Paper', 'solid'], ['Blue', 'image']]);
  expect(s.embeds).toBe(1);
  // The object covers exactly the two layers.
  expect(s.layers[1].t).toMatchObject({ x: 20, y: 30, width: 80, height: 60 });
  await expect(page.locator('#layers .layer-row.selected .embed-badge')).toHaveCount(1);

  // A duplicate shares the contents.
  await run(page, 'layer.duplicate');
  await page.evaluate(() => window.photoStudio.editLayer('Move', (l) => (l.transform = { ...l.transform, x: 200, y: 150 })));
  await idle(page);
  s = await state(page);
  expect(s.layers[2].contents).toBe(s.layers[1].contents);
  expect(await compositePixel(page, 70, 60)).toEqual([0, 0, 255, 255]);
  expect(await compositePixel(page, 250, 170)).toEqual([0, 0, 255, 255]);

  // Edit Contents opens the nested document in its own tab.
  await run(page, 'layer.embed-edit');
  s = await state(page);
  expect(s.sessions).toBe(2);
  await expect(page.locator('.document-tab.active')).toContainText('Contents');
  expect(await page.evaluate(() => [window.photoStudio.doc.width, window.photoStudio.doc.height, window.photoStudio.doc.layers.map((l) => l.name)])).toEqual([80, 60, ['Red', 'Blue']]);
  await page.evaluate(() => window.photoStudio.command('Recolor', (d) => (d.layers[1].color = '#00ff00')));
  await idle(page);
  // Save in the contents tab writes back into the parent.
  await page.locator('#viewport').focus();
  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(() => page.evaluate(() => window.photoStudio.sessions[0].history.labels.at(-1))).toBe('Edit Contents');
  await expect.poll(() => page.evaluate(() => window.photoStudio.session.dirty)).toBe(false);

  // Closing the saved tab asks nothing; both instances show the new content.
  await run(page, 'file.close');
  expect((await state(page)).sessions).toBe(1);
  expect(await compositePixel(page, 70, 60)).toEqual([0, 255, 0, 255]);
  expect(await compositePixel(page, 250, 170)).toEqual([0, 255, 0, 255]);
  expect(await compositePixel(page, 25, 35)).toEqual([255, 0, 0, 255]);

  // One undo step restores the previous contents everywhere.
  await run(page, 'edit.undo');
  expect(await compositePixel(page, 70, 60)).toEqual([0, 0, 255, 255]);
  expect(await compositePixel(page, 250, 170)).toEqual([0, 0, 255, 255]);
  await run(page, 'edit.redo');
  expect(await compositePixel(page, 250, 170)).toEqual([0, 255, 0, 255]);
  expect(await historyLabels(page)).toEqual(['Convert to Embedded Object', 'Duplicate layers', 'Move', 'Edit Contents']);
});

test('a changed contents tab offers to save when closed, and a distortion stays editable', async ({ page }) => {
  await boot(page);
  await loadFixture(page);
  await run(page, 'layer.embed-convert');
  await run(page, 'layer.embed-edit');
  await page.evaluate(() => window.photoStudio.command('Recolor', (d) => (d.layers[0].color = '#ffff00')));
  await idle(page);
  void page.evaluate(() => window.photoStudio.runCommand('file.close'));
  const dialog = page.locator('#dialog[open]');
  await expect(dialog).toContainText('Save changes');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.photoStudio.sessions.length)).toBe(1);
  await idle(page);
  expect(await compositePixel(page, 25, 35)).toEqual([255, 255, 0, 255]);

  // Distort: stored as a frame on the embedded object, re-rendered from its contents.
  await page.evaluate(async () => {
    const { startSession } = await import('/src/features/transform/session.ts');
    const e = window.photoStudio;
    const t = e.layer!.transform;
    const s = startSession(e, { mode: 'distort', quad: [{ x: t.x, y: t.y }, { x: t.x + t.width + 30, y: t.y }, { x: t.x + t.width, y: t.y + t.height }, { x: t.x, y: t.y + t.height }] })!;
    await new Promise<void>((r) => {
      const wait = () => (s.ready ? r() : setTimeout(wait, 20));
      wait();
    });
    s.apply();
  });
  await expect.poll(() => page.evaluate(() => window.photoStudio.history.labels.at(-1))).toBe('Transform');
  await idle(page);
  const framed = await page.evaluate(() => ({ kind: window.photoStudio.layer!.kind, frame: !!window.photoStudio.layer!.embed?.frame }));
  expect(framed).toEqual({ kind: 'image', frame: true });
  await run(page, 'layer.embed-reset');
  expect(await page.evaluate(() => ({ frame: !!window.photoStudio.layer!.embed?.frame, t: window.photoStudio.layer!.transform }))).toMatchObject({ frame: false, t: { width: 80, height: 60, rotation: 0 } });
});

test('a GPU adapter request that never answers does not leave the editor busy', async ({ page }) => {
  await boot(page);
  await loadFixture(page);
  // The visible canvas already has its compositor; the private one for the
  // embedded object asks for a new adapter, which hangs on some machines.
  await page.evaluate(() => {
    if (navigator.gpu) navigator.gpu.requestAdapter = () => new Promise(() => {});
  });
  await page.evaluate(() => void window.photoStudio.runCommand('layer.embed-convert'));
  await page.waitForFunction(() => !window.photoStudio.busy, null, { timeout: 30_000 });
  await idle(page);
  expect(await page.evaluate(() => window.photoStudio.doc.layers.map((l) => l.kind))).toEqual(['solid', 'image']);
  expect(await compositePixel(page, 70, 60)).toEqual([0, 0, 255, 255]);
  expect(await compositePixel(page, 25, 35)).toEqual([255, 0, 0, 255]);
});

test('placed PSD files and projects are recognized by their contents whatever their extension', async ({ page }) => {
  await boot(page);
  await openImage(page, 200, 150);
  const psd = Array.from(readFileSync('tests/fixtures/layer-order.psd'));
  const placed = await page.evaluate(async (psd) => {
    const e = window.photoStudio;
    const { openFile } = await import('/src/features/files/open.ts');
    const { serialize } = await import('/src/model/serialization.ts');
    const project = await serialize(e.doc, e.assets);
    await openFile(e, new File([new Uint8Array(psd)], 'downloaded.png', { type: 'image/png' }), 'downloaded.png', true);
    await openFile(e, new File([project], 'project-copy.bin'), 'project-copy.bin', true);
    return e.doc.layers.map((l) => [l.name, l.kind, !!l.embed]);
  }, psd);
  expect(placed).toEqual([
    ['Background', 'pixel', false],
    ['downloaded', 'image', true],
    ['project-copy', 'image', true],
  ]);
});
