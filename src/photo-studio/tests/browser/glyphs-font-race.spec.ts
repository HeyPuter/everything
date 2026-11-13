import { expect, test } from '@playwright/test';
import { boot, idle, openImage, panel, run } from './helpers';

type TypeModule = typeof import('../../src/features/type/session');

for (const destination of ['other document', 'copied document', 'another layer', 'fresh edit']) test(`a pending glyph leaves ${destination} unchanged`, async ({ page }) => {
  await boot(page);
  await openImage(page, 400, 200, '#ffffff', 'other.png');
  const other = await page.evaluate(() => window.photoStudio.session.id);
  await openImage(page, 400, 200, '#ffffff', 'original.png');
  const original = await page.evaluate(() => window.photoStudio.session.id);
  await page.evaluate(async ({ other, destination }) => {
    const e = window.photoStudio;
    const { layer } = await import('/src/model/document.ts');
    const { textLayer } = await import('/src/imaging/text/model.ts');
    const load = FontFace.prototype.load;
    FontFace.prototype.load = function () {
      if (!this.family.includes('Caveat')) return load.call(this);
      FontFace.prototype.load = load;
      return new Promise<void>((resolve) => Object.assign(window, { releaseGlyphFont: resolve })).then(() => load.call(this));
    };
    const a = layer('text', 'Original', 200, 80);
    a.text = 'Original';
    a.textData = textLayer(a.text, { family: 'Caveat' });
    const b = layer('text', 'Other', 200, 80);
    b.text = 'Other';
    b.textData = textLayer(b.text, { family: 'Inter' });
    e.command('Text fixture', (d) => { d.layers = [a, b]; });
    const s = e.sessions.find((s) => s.id === other)!;
    s.history.reset({ ...s.doc, layers: [{ ...b, id: destination === 'copied document' ? a.id : b.id }] });
    e.selectLayers([a.id]);
    e.dock.show('glyphs');
  }, { other, destination });
  const body = await panel(page, 'Glyphs');
  const cell = body.locator('.gl-grid [data-cp="38"]');
  await expect(cell).toBeVisible();
  await cell.dblclick();
  await expect(page.locator('textarea.type-input')).toBeFocused();
  await page.waitForFunction(() => !!(window as unknown as { releaseGlyphFont?: () => void }).releaseGlyphFont);
  if (destination.includes('document')) await page.locator(`.document-tab[data-session="${other}"]`).click();
  else {
    await page.evaluate(() => window.photoStudio.setTool('move'));
    await page.evaluate(() => window.photoStudio.setTool('type'));
  }
  await page.evaluate((destination) => {
    const e = window.photoStudio;
    e.setTool('type');
    const target = destination === 'another layer' ? e.doc.layers[1] : e.doc.layers[0];
    void (window as unknown as { photoStudioType: TypeModule }).photoStudioType.startEdit(e, target.id, 'end');
  }, destination);
  await expect(page.locator('textarea.type-input')).toBeFocused();
  await page.keyboard.insertText(' draft');
  const expected = destination === 'fresh edit' ? 'Original draft' : 'Other draft';
  const currentText = () => page.evaluate(() => {
    const s = (window as unknown as { photoStudioType: TypeModule }).photoStudioType.currentSession()!;
    return window.photoStudio.doc.layers.find((l) => l.id === s.layerId)!.text;
  });
  expect(await currentText()).toBe(expected);
  await page.locator('#type-size').focus();
  await page.evaluate(async () => {
    (window as unknown as { releaseGlyphFont(): void }).releaseGlyphFont();
    await (await import('/src/imaging/text/fonts.ts')).ensureFont('Caveat');
  });
  await idle(page);
  expect(await currentText()).toBe(expected);
  await expect(page.locator('#type-size')).toBeFocused();
  expect(await body.locator('.gl-recent [data-cp="38"]')).toHaveCount(0);
  await page.locator('textarea.type-input').focus();
  await page.keyboard.insertText(' more');
  await run(page, 'type.commit');
  await run(page, 'edit.undo');
  const targetText = () => page.evaluate((destination) => window.photoStudio.doc.layers[destination === 'another layer' ? 1 : 0].text, destination);
  expect(await targetText()).toBe(destination === 'fresh edit' ? 'Original' : 'Other');
  await run(page, 'edit.redo');
  expect(await targetText()).toBe(expected + ' more');
  if (destination.includes('document')) expect(await page.evaluate((original) => window.photoStudio.sessions.find((s) => s.id === original)!.doc.layers[0].text, original)).toBe('Original');
});

for (const completion of ['font arrival', 'fallback timeout']) test(`a pending glyph inserts once after ${completion} in its original edit`, async ({ page }) => {
  await boot(page);
  await openImage(page, 400, 200, '#ffffff');
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { layer } = await import('/src/model/document.ts');
    const { textLayer } = await import('/src/imaging/text/model.ts');
    const load = FontFace.prototype.load;
    FontFace.prototype.load = function () {
      if (!this.family.includes('Caveat')) return load.call(this);
      FontFace.prototype.load = load;
      return new Promise<void>((resolve) => Object.assign(window, { releaseGlyphFont: resolve })).then(() => load.call(this));
    };
    const l = layer('text', 'Original', 200, 80);
    l.text = 'Original';
    l.textData = textLayer(l.text, { family: 'Caveat' });
    e.command('Text fixture', (d) => { d.layers = [l]; });
    e.selectLayers([l.id]);
    e.dock.show('glyphs');
  });
  const body = await panel(page, 'Glyphs');
  const cell = body.locator('.gl-grid [data-cp="38"]');
  await expect(cell).toBeVisible();
  await cell.dblclick();
  await page.waitForFunction(() => !!(window as unknown as { releaseGlyphFont?: () => void }).releaseGlyphFont);
  const layerText = () => page.evaluate(() => window.photoStudio.doc.layers[0].text);
  if (completion === 'fallback timeout') await expect.poll(layerText).toBe('Original&');
  await page.evaluate(async () => {
    (window as unknown as { releaseGlyphFont(): void }).releaseGlyphFont();
    await (await import('/src/imaging/text/fonts.ts')).ensureFont('Caveat');
  });
  await idle(page);
  await expect.poll(layerText).toBe('Original&');
  await expect(body.locator('.gl-recent [data-cp="38"]')).toHaveCount(1);
  expect(await page.evaluate(() => (window as unknown as { photoStudioType: TypeModule }).photoStudioType.currentSession()!.data.content.paragraphs[0].runs.map((r) => r.style.family))).toEqual(['Caveat']);
  await run(page, 'edit.undo');
  expect(await layerText()).toBe('Original');
  await run(page, 'edit.redo');
  expect(await layerText()).toBe('Original&');
  await run(page, 'type.commit');
  expect(await layerText()).toBe('Original&');
});
