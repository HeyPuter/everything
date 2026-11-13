import { expect, test, type Page, type Locator } from '@playwright/test';
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

for (const action of ['typing', 'selection']) test(`a slow glyph font preserves subsequent ${action}`, async ({ page }) => {
  await boot(page);
  await openImage(page, 400, 200, '#ffffff');
  await run(page, 'type.add');
  await page.keyboard.insertText('ab');
  if (action === 'selection') await page.keyboard.press('Shift+ArrowLeft');
  await page.evaluate(() => {
    const load = FontFace.prototype.load;
    FontFace.prototype.load = function () {
      if (!this.family.includes('Caveat')) return load.call(this);
      FontFace.prototype.load = load;
      return new Promise<void>((resolve) => Object.assign(window, { releaseGlyphFont: resolve })).then(() => load.call(this));
    };
    window.photoStudio.dock.show('glyphs');
  });
  const body = await panel(page, 'Glyphs');
  await body.locator('select[aria-label="Font family"]').selectOption('Caveat');
  const cell = body.locator('.gl-grid [data-cp="38"]');
  await expect(cell).toBeVisible();
  await cell.dblclick();
  await page.waitForFunction(() => !!(window as unknown as { releaseGlyphFont?: () => void }).releaseGlyphFont);
  await page.locator('textarea.type-input').focus();
  if (action === 'typing') await page.keyboard.insertText('X');
  else {
    await page.keyboard.press('Home');
    await page.keyboard.press('Shift+ArrowRight');
  }
  await page.locator('#type-size').focus();
  await page.evaluate(async () => {
    (window as unknown as { releaseGlyphFont(): void }).releaseGlyphFont();
    await (await import('/src/imaging/text/fonts.ts')).ensureFont('Caveat');
  });
  await idle(page);
  const layerText = () => page.evaluate(() => window.photoStudio.doc.layers.at(-1)!.text);
  expect(await layerText()).toBe(action === 'typing' ? 'ab&X' : 'a&');
  await expect(page.locator('#type-size')).toBeFocused();
  expect(await page.evaluate(() => {
    const s = (window as unknown as { photoStudioType: TypeModule }).photoStudioType.currentSession()!;
    return [s.anchor, s.focus];
  })).toEqual(action === 'typing' ? [4, 4] : [0, 1]);
  if (action === 'selection') {
    await page.locator('textarea.type-input').focus();
    await page.keyboard.insertText('Z');
  }
  const finalText = action === 'typing' ? 'ab&X' : 'Z&';
  expect(await layerText()).toBe(finalText);
  await run(page, 'edit.undo');
  expect(await layerText()).toBe(action === 'typing' ? 'ab&' : 'a&');
  await run(page, 'edit.undo');
  expect(await layerText()).toBe('ab');
  await run(page, 'edit.redo');
  await run(page, 'edit.redo');
  expect(await layerText()).toBe(finalText);
  await run(page, 'type.commit');
  expect(await layerText()).toBe(finalText);
});

async function editingWithGlyphFontWaits(page: Page) {
  await boot(page);
  await openImage(page, 400, 200, '#ffffff');
  await run(page, 'type.add');
  await page.keyboard.insertText('ab');
  await page.evaluate(() => {
    const waits: Record<string, () => void> = {};
    Object.assign(window, { releaseGlyphFonts: waits });
    const load = FontFace.prototype.load;
    FontFace.prototype.load = function () {
      const family = ['Caveat', 'Crimson Pro'].find((f) => this.family.includes(f));
      if (!family) return load.call(this);
      return new Promise<void>((resolve) => { waits[family] = resolve; }).then(() => load.call(this));
    };
    window.photoStudio.dock.show('glyphs');
  });
  return panel(page, 'Glyphs');
}

async function pickGlyph(body: Locator, family: string, cp: number) {
  await body.locator('select[aria-label="Font family"]').selectOption(family);
  const cell = body.locator(`.gl-grid [data-cp="${cp}"]`);
  await expect(cell).toBeVisible();
  await cell.dblclick();
}

async function releaseGlyphFont(page: Page, family: string) {
  await page.evaluate(async (family) => {
    (window as unknown as { releaseGlyphFonts: Record<string, () => void> }).releaseGlyphFonts[family]();
    await (await import('/src/imaging/text/fonts.ts')).ensureFont(family);
  }, family);
  await idle(page);
}

for (const first of ['Caveat', 'Crimson Pro']) test(`glyph order and fonts survive ${first} finishing first`, async ({ page }) => {
  const body = await editingWithGlyphFontWaits(page);
  await pickGlyph(body, 'Caveat', 38);
  await pickGlyph(body, 'Crimson Pro', 64);
  const runs = () => page.evaluate(() => (window as unknown as { photoStudioType: TypeModule }).photoStudioType.currentSession()!.data.content.paragraphs[0].runs.map((r) => [r.text, r.style.family]));
  const expected = [['ab', 'Inter'], ['&', 'Caveat'], ['@', 'Crimson Pro']];
  expect(await runs()).toEqual(expected);
  await page.locator('#type-size').focus();
  for (const family of [first, first === 'Caveat' ? 'Crimson Pro' : 'Caveat']) {
    await releaseGlyphFont(page, family);
    expect(await runs()).toEqual(expected);
    await expect(page.locator('#type-size')).toBeFocused();
  }
  await expect(body.locator('.gl-recent [data-cp="38"]')).toHaveCount(1);
  await expect(body.locator('.gl-recent [data-cp="64"]')).toHaveCount(1);
  // Consecutive glyph insertions share the editor's existing undo group.
  await run(page, 'edit.undo');
  expect(await runs()).toEqual(expected.slice(0, 1));
  await run(page, 'edit.redo');
  expect(await runs()).toEqual(expected);
});

for (const ending of ['undo', 'cancel', 'commit']) test(`a glyph's late font preserves an early ${ending}`, async ({ page }) => {
  const body = await editingWithGlyphFontWaits(page);
  await pickGlyph(body, 'Caveat', 38);
  const layerText = () => page.evaluate(() => window.photoStudio.doc.layers.find((l) => l.kind === 'text')?.text ?? null);
  expect(await layerText()).toBe('ab&');
  await run(page, ending === 'undo' ? 'edit.undo' : ending === 'cancel' ? 'type.cancel' : 'type.commit');
  const expected = ending === 'undo' ? 'ab' : ending === 'cancel' ? null : 'ab&';
  expect(await layerText()).toBe(expected);
  const history = await page.evaluate(() => window.photoStudio.history.labels);
  await releaseGlyphFont(page, 'Caveat');
  expect(await layerText()).toBe(expected);
  expect(await page.evaluate(() => window.photoStudio.history.labels)).toEqual(history);
  expect(await page.evaluate(() => !!(window as unknown as { photoStudioType: TypeModule }).photoStudioType.currentSession())).toBe(ending === 'undo');
  if (ending === 'undo') {
    await run(page, 'edit.redo');
    expect(await layerText()).toBe('ab&');
  } else if (ending === 'commit') {
    await run(page, 'edit.undo');
    expect(await layerText()).toBeNull();
    await run(page, 'edit.redo');
    expect(await layerText()).toBe('ab&');
  }
});

async function startGlyphWithPendingFont(page: Page) {
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
    l.text = 'ab';
    l.textData = textLayer(l.text, { family: 'Caveat' });
    e.command('Text fixture', (d) => { d.layers = [l]; });
    e.selectLayers([l.id]);
    e.dock.show('glyphs');
  });
  const body = await panel(page, 'Glyphs');
  const cell = body.locator('.gl-grid [data-cp="38"]');
  await expect(cell).toBeVisible();
  await cell.dblclick();
  await expect(page.locator('textarea.type-input')).toBeFocused();
  await page.waitForFunction(() => !!(window as unknown as { releaseGlyphFont?: () => void }).releaseGlyphFont);
  return body;
}

async function finishStartingGlyphFont(page: Page) {
  await page.evaluate(async () => {
    (window as unknown as { releaseGlyphFont(): void }).releaseGlyphFont();
    await (await import('/src/imaging/text/fonts.ts')).ensureFont('Caveat');
  });
  await idle(page);
}

for (const action of ['typing', 'selection']) test(`a glyph that starts editing preserves subsequent ${action}`, async ({ page }) => {
  const body = await startGlyphWithPendingFont(page);
  if (action === 'typing') await page.keyboard.insertText('X');
  else {
    await page.keyboard.press('Home');
    await page.keyboard.press('Shift+ArrowRight');
  }
  await page.locator('#type-size').focus();
  await finishStartingGlyphFont(page);
  const layerText = () => page.evaluate(() => window.photoStudio.doc.layers[0].text);
  expect(await layerText()).toBe(action === 'typing' ? 'ab&X' : 'ab&');
  await expect(page.locator('#type-size')).toBeFocused();
  expect(await page.evaluate(() => {
    const s = (window as unknown as { photoStudioType: TypeModule }).photoStudioType.currentSession()!;
    return [s.anchor, s.focus];
  })).toEqual(action === 'typing' ? [4, 4] : [0, 1]);
  await expect(body.locator('.gl-recent [data-cp="38"]')).toHaveCount(1);
  await page.locator('textarea.type-input').focus();
  await page.keyboard.insertText('Z');
  const finalText = action === 'typing' ? 'ab&XZ' : 'Zb&';
  expect(await layerText()).toBe(finalText);
  await run(page, 'edit.undo');
  expect(await layerText()).toBe('ab&');
  await run(page, 'edit.undo');
  expect(await layerText()).toBe('ab');
  await run(page, 'edit.redo');
  await run(page, 'edit.redo');
  expect(await layerText()).toBe(finalText);
  await run(page, 'type.commit');
  expect(await layerText()).toBe(finalText);
});

for (const input of ['IME', 'soft keyboard', 'paste']) test(`a starting glyph precedes early ${input} input`, async ({ page }) => {
  await startGlyphWithPendingFont(page);
  const layerText = () => page.evaluate(() => window.photoStudio.doc.layers[0].text);
  if (input === 'IME') {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.imeSetComposition', { text: 'にほん', selectionStart: 3, selectionEnd: 3 });
    expect(await layerText()).toBe('ab&にほん');
    await finishStartingGlyphFont(page);
    expect(await layerText()).toBe('ab&にほん');
    expect(await page.evaluate(() => !!(window as unknown as { photoStudioType: TypeModule }).photoStudioType.currentSession()!.composing)).toBe(true);
    await cdp.send('Input.insertText', { text: '日本' });
  } else if (input === 'soft keyboard') {
    await page.evaluate(() => {
      const el = document.activeElement!;
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Unidentified', keyCode: 229, bubbles: true, cancelable: true }));
      el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: '日本', bubbles: true, cancelable: true }));
      el.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: '日本', bubbles: true }));
    });
  } else {
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.setData('text/plain', '日本');
      document.activeElement!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
  }
  expect(await layerText()).toBe('ab&日本');
  if (input !== 'IME') await finishStartingGlyphFont(page);
  expect(await layerText()).toBe('ab&日本');
  await run(page, 'edit.undo');
  expect(await layerText()).toBe('ab&');
  await run(page, 'edit.undo');
  expect(await layerText()).toBe('ab');
  await run(page, 'edit.redo');
  await run(page, 'edit.redo');
  expect(await layerText()).toBe('ab&日本');
});

for (const ending of ['undo', 'cancel', 'commit']) test(`a starting glyph respects ${ending} before font arrival`, async ({ page }) => {
  await startGlyphWithPendingFont(page);
  await page.keyboard.insertText('X');
  const layerText = () => page.evaluate(() => window.photoStudio.doc.layers[0].text);
  expect(await layerText()).toBe('ab&X');
  if (ending === 'undo') {
    await run(page, 'edit.undo');
    await run(page, 'edit.undo');
  } else await run(page, ending === 'cancel' ? 'type.cancel' : 'type.commit');
  const expected = ending === 'commit' ? 'ab&X' : 'ab';
  expect(await layerText()).toBe(expected);
  const history = await page.evaluate(() => window.photoStudio.history.labels);
  await finishStartingGlyphFont(page);
  expect(await layerText()).toBe(expected);
  expect(await page.evaluate(() => window.photoStudio.history.labels)).toEqual(history);
  expect(await page.evaluate(() => !!(window as unknown as { photoStudioType: TypeModule }).photoStudioType.currentSession())).toBe(ending === 'undo');
  if (ending === 'undo') {
    await run(page, 'edit.redo');
    await run(page, 'edit.redo');
    expect(await layerText()).toBe('ab&X');
  } else if (ending === 'commit') {
    await run(page, 'edit.undo');
    expect(await layerText()).toBe('ab');
    await run(page, 'edit.redo');
    expect(await layerText()).toBe('ab&X');
  }
});

for (const completion of ['font arrival', 'fallback timeout']) test(`a starting glyph retains field focus at ${completion}`, async ({ page }) => {
  await startGlyphWithPendingFont(page);
  await page.locator('#type-size').focus();
  const layerText = () => page.evaluate(() => window.photoStudio.doc.layers[0].text);
  if (completion === 'fallback timeout') await expect.poll(layerText).toBe('ab&');
  await finishStartingGlyphFont(page);
  expect(await layerText()).toBe('ab&');
  await expect(page.locator('#type-size')).toBeFocused();
  await page.locator('textarea.type-input').focus();
  await page.keyboard.insertText('X');
  expect(await layerText()).toBe('ab&X');
  await run(page, 'edit.undo');
  expect(await layerText()).toBe('ab&');
  await run(page, 'edit.undo');
  expect(await layerText()).toBe('ab');
});
