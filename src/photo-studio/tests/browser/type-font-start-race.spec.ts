import { expect, test, type Page } from '@playwright/test';
import { boot, canvasClick, idle, openImage, run, tool } from './helpers';

type TypeModule = typeof import('../../src/features/type/session');

async function prepare(page: Page) {
  await boot(page);
  await openImage(page, 200, 150, '#ffffff', 'other.png');
  const other = await page.evaluate(() => window.photoStudio.session.id);
  await openImage(page, 200, 150, '#ff0000', 'original.png');
  const original = await page.evaluate(() => window.photoStudio.session.id);
  await tool(page, 'Horizontal Type Tool');
  await page.evaluate(() => {
    const m = (window as unknown as { photoStudioType: TypeModule }).photoStudioType;
    m.typeDefaults(window.photoStudio).style.family = 'Caveat';
    const load = FontFace.prototype.load;
    FontFace.prototype.load = function () {
      if (!this.family.includes('Caveat')) return load.call(this);
      FontFace.prototype.load = load;
      return new Promise<void>((resolve) => Object.assign(window, { finishTypeFont: resolve })).then(() => load.call(this));
    };
  });
  return { other, original };
}

async function finishFont(page: Page) {
  await page.evaluate(() => (window as unknown as { finishTypeFont(): void }).finishTypeFont());
  await page.evaluate(async () => {
    const { ensureFont } = await import('/src/imaging/text/fonts.ts');
    await ensureFont('Caveat');
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  await idle(page);
}

async function editState(page: Page) {
  return page.evaluate(() => {
    const e = window.photoStudio;
    const m = (window as unknown as { photoStudioType: TypeModule }).photoStudioType;
    return { active: e.session.id, editing: !!m.currentSession(), docs: e.sessions.map((s) => ({ id: s.id, layers: s.doc.layers.length, history: s.history.labels })) };
  });
}

for (const departure of ['switch', 'switch back', 'close']) test(`a delayed new-text font is cancelled after ${departure}`, async ({ page }) => {
  const { other, original } = await prepare(page);
  await canvasClick(page, 50, 50);
  await page.waitForFunction(() => !!(window as unknown as { finishTypeFont?: () => void }).finishTypeFont);
  if (departure === 'close') {
    await page.locator('.document-tab.focused .tab-close').click();
  } else await page.locator(`.document-tab[data-session="${other}"]`).click();
  await expect.poll(() => page.evaluate(() => window.photoStudio.session.id)).toBe(other);
  if (departure === 'switch back') await page.locator(`.document-tab[data-session="${original}"]`).click();
  await finishFont(page);
  const state = await editState(page);
  expect(state.active).toBe(departure === 'switch back' ? original : other);
  expect(state.editing).toBe(false);
  expect(state.docs.map((s) => s.layers)).toEqual(departure === 'close' ? [1] : [1, 1]);
  // The cancelled request must not prevent a new click from starting text.
  await canvasClick(page, 60, 60);
  await page.keyboard.insertText('New request');
  await run(page, 'type.commit');
  expect(await page.evaluate(() => window.photoStudio.doc.layers.at(-1)!.text)).toBe('New request');
});

test('a new text request can finish while an abandoned font is still loading', async ({ page }) => {
  const { other, original } = await prepare(page);
  await canvasClick(page, 50, 50);
  await page.waitForFunction(() => !!(window as unknown as { finishTypeFont?: () => void }).finishTypeFont);
  await page.locator(`.document-tab[data-session="${other}"]`).click();
  await page.evaluate(() => {
    const m = (window as unknown as { photoStudioType: TypeModule }).photoStudioType;
    m.typeDefaults(window.photoStudio).style.family = 'Inter';
  });
  await canvasClick(page, 60, 60);
  await page.keyboard.insertText('Second request');
  const before = await page.evaluate(() => {
    const m = (window as unknown as { photoStudioType: TypeModule }).photoStudioType;
    return m.currentSession()?.layerId;
  });
  await finishFont(page);
  expect(before).toBeTruthy();
  expect(await page.evaluate(() => {
    const m = (window as unknown as { photoStudioType: TypeModule }).photoStudioType;
    return m.currentSession()?.layerId;
  })).toBe(before);
  await run(page, 'type.commit');
  expect(await page.evaluate(({ other, original }) => {
    const e = window.photoStudio;
    return { active: e.session.id, originalLayers: e.sessions.find((s) => s.id === original)!.doc.layers.length, text: e.sessions.find((s) => s.id === other)!.doc.layers.at(-1)!.text };
  }, { other, original })).toEqual({ active: other, originalLayers: 1, text: 'Second request' });
});

for (const sharedId of [false, true]) test(`a delayed existing-text request leaves another document ${sharedId ? 'with the same layer ID' : 'without that layer'} unchanged`, async ({ page }) => {
  const { other } = await prepare(page);
  await page.evaluate(async ({ other, sharedId }) => {
    const e = window.photoStudio;
    const { layer } = await import('/src/model/document.ts');
    const { textLayer } = await import('/src/imaging/text/model.ts');
    const l = layer('text', 'Existing', 100, 80);
    l.textData = textLayer('Existing');
    l.textData.content.paragraphs[0].runs[0].style.family = 'Caveat';
    e.command('Existing text fixture', (d) => { d.layers.push(l); });
    if (sharedId) {
      // Duplicate documents retain layer IDs but may have different text.
      const s = e.sessions.find((s) => s.id === other)!;
      s.history.reset({ ...s.doc, layers: [...s.doc.layers, { ...l, text: 'Other text', textData: textLayer('Other text', { family: 'Inter' }) }] });
    }
    const m = (window as unknown as { photoStudioType: TypeModule }).photoStudioType;
    void m.startEdit(e, l.id, 'all');
  }, { other, sharedId });
  await page.waitForFunction(() => !!(window as unknown as { finishTypeFont?: () => void }).finishTypeFont);
  await page.locator(`.document-tab[data-session="${other}"]`).click();
  await finishFont(page);
  const state = await editState(page);
  expect(state.active).toBe(other);
  if (sharedId) expect(await page.evaluate(() => window.photoStudio.doc.layers.at(-1)!.text)).toBe('Other text');
  expect(state.editing).toBe(false);
  expect(state.docs.find((s) => s.id === other)).toMatchObject({ layers: sharedId ? 2 : 1, history: [] });
});

for (const closeOther of [false, true]) test(`a delayed font still starts text ${closeOther ? 'after another document closes' : 'when the original document stays active'}`, async ({ page }) => {
  const { original, other } = await prepare(page);
  await canvasClick(page, 50, 50);
  await page.waitForFunction(() => !!(window as unknown as { finishTypeFont?: () => void }).finishTypeFont);
  if (closeOther) await page.locator(`.document-tab[data-session="${other}"] .tab-close`).click();
  await finishFont(page);
  expect(await editState(page)).toMatchObject({ active: original, editing: true });
  await page.keyboard.insertText('Original request');
  await run(page, 'type.commit');
  expect(await page.evaluate(() => window.photoStudio.doc.layers.at(-1)!.text)).toBe('Original request');
});

test('finishing an abandoned font does not release a newer pending text request', async ({ page }) => {
  const { other } = await prepare(page);
  await canvasClick(page, 50, 50);
  await page.waitForFunction(() => !!(window as unknown as { finishTypeFont?: () => void }).finishTypeFont);
  await page.locator(`.document-tab[data-session="${other}"]`).click();
  await page.evaluate(() => {
    const m = (window as unknown as { photoStudioType: TypeModule }).photoStudioType;
    m.typeDefaults(window.photoStudio).style.family = 'Crimson Pro';
    const load = FontFace.prototype.load;
    FontFace.prototype.load = function () {
      if (!this.family.includes('Crimson Pro')) return load.call(this);
      FontFace.prototype.load = load;
      return new Promise<void>((resolve) => Object.assign(window, { finishSecondTypeFont: resolve })).then(() => load.call(this));
    };
  });
  await canvasClick(page, 60, 60);
  await page.waitForFunction(() => !!(window as unknown as { finishSecondTypeFont?: () => void }).finishSecondTypeFont);
  await finishFont(page);
  // This duplicate click is ignored while the second request is pending.
  await canvasClick(page, 90, 90);
  await page.evaluate(() => (window as unknown as { finishSecondTypeFont(): void }).finishSecondTypeFont());
  await page.waitForFunction(() => !!(window as unknown as { photoStudioType: TypeModule }).photoStudioType.currentSession());
  expect(await page.evaluate(() => (window as unknown as { photoStudioType: TypeModule }).photoStudioType.currentSession()!.data.origin)).toMatchObject({ x: expect.closeTo(60, 1), y: expect.closeTo(60, 1) });
  await page.keyboard.insertText('Second pending request');
  await run(page, 'type.commit');
  expect(await page.evaluate(() => window.photoStudio.doc.layers.at(-1)!.text)).toBe('Second pending request');
});

test('a stalled font still permits fallback editing and preserves text when it arrives', async ({ page }) => {
  const { original } = await prepare(page);
  await canvasClick(page, 50, 50);
  await page.waitForFunction(() => !!(window as unknown as { finishTypeFont?: () => void }).finishTypeFont);
  // Wait for the editor's existing bounded font wait, without releasing the font.
  await page.waitForFunction(() => !!(window as unknown as { photoStudioType: TypeModule }).photoStudioType.currentSession());
  await page.keyboard.insertText('Fallback text');
  await finishFont(page);
  expect(await editState(page)).toMatchObject({ active: original, editing: true });
  await run(page, 'type.commit');
  expect(await page.evaluate(() => window.photoStudio.doc.layers.at(-1)!.text)).toBe('Fallback text');
});

for (const existing of [false, true]) test(`typing before the font arrives preserves ${existing ? 'existing' : 'new'} text edits`, async ({ page }) => {
  await prepare(page);
  if (existing) {
    await page.evaluate(async () => {
      const e = window.photoStudio;
      const { layer } = await import('/src/model/document.ts');
      const { textLayer } = await import('/src/imaging/text/model.ts');
      const l = layer('text', 'Existing', 100, 80);
      l.textData = textLayer('Existing', { family: 'Caveat' });
      e.command('Existing text fixture', (d) => { d.layers.push(l); });
      void (window as unknown as { photoStudioType: TypeModule }).photoStudioType.startEdit(e, l.id, 'all');
    });
  } else await canvasClick(page, 50, 50);
  await page.waitForFunction(() => !!(window as unknown as { finishTypeFont?: () => void }).finishTypeFont);
  await page.keyboard.type('brave');
  expect(await inputText(page)).toBe('brave');
  expect(await page.evaluate(() => window.photoStudio.tool)).toBe('type');
  await finishFont(page);
  await run(page, 'type.commit');
  expect(await page.evaluate(() => window.photoStudio.doc.layers.at(-1)!.text)).toBe('brave');
});

async function inputText(page: Page) {
  return page.evaluate(async () => {
    const { plainText } = await import('/src/imaging/text/model.ts');
    const s = (window as unknown as { photoStudioType: TypeModule }).photoStudioType.currentSession();
    return s ? plainText(s.data.content) : undefined;
  });
}

for (const input of ['IME', 'soft keyboard', 'paste']) test(`${input} starts editing before its font arrives`, async ({ page }) => {
  await prepare(page);
  await canvasClick(page, 50, 50);
  await page.waitForFunction(() => !!(window as unknown as { finishTypeFont?: () => void }).finishTypeFont);
  if (input === 'IME') {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.imeSetComposition', { text: 'にほん', selectionStart: 3, selectionEnd: 3 });
    expect(await inputText(page)).toBe('にほん');
    // Receiving the font during composition must preserve the composition.
    await finishFont(page);
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
  expect(await inputText(page)).toBe('日本');
  if (input !== 'IME') await finishFont(page);
  await page.keyboard.press('Meta+z');
  expect(await inputText(page)).toBe('');
  await page.keyboard.press('Meta+Shift+z');
  expect(await inputText(page)).toBe('日本');
  await run(page, 'type.commit');
  expect(await page.evaluate(() => window.photoStudio.doc.layers.at(-1)!.text)).toBe('日本');
});

test('Escape before a font arrives ends the empty request without changing the document', async ({ page }) => {
  await prepare(page);
  await canvasClick(page, 50, 50);
  await page.waitForFunction(() => !!(window as unknown as { finishTypeFont?: () => void }).finishTypeFont);
  await page.keyboard.press('Escape');
  await finishFont(page);
  expect(await inputText(page)).toBeUndefined();
  expect(await page.evaluate(() => ({ layers: window.photoStudio.doc.layers.length, dirty: window.photoStudio.session.dirty, history: window.photoStudio.history.labels }))).toEqual({ layers: 1, dirty: false, history: [] });
});

test('an early text commit remains in its document when the font arrives during another edit', async ({ page }) => {
  const { other, original } = await prepare(page);
  await canvasClick(page, 50, 50);
  await page.waitForFunction(() => !!(window as unknown as { finishTypeFont?: () => void }).finishTypeFont);
  await page.keyboard.type('First');
  await page.keyboard.press('Escape');
  await page.locator(`.document-tab[data-session="${other}"]`).click();
  await page.evaluate(() => {
    const m = (window as unknown as { photoStudioType: TypeModule }).photoStudioType;
    m.typeDefaults(window.photoStudio).style.family = 'Inter';
  });
  const [x, y] = await page.evaluate(() => window.photoStudio.clientPoint(60, 60));
  await page.mouse.click(x, y);
  await page.keyboard.type('Second');
  await page.evaluate(() => Object.assign(window, { secondDraft: window.photoStudio.doc }));
  await finishFont(page);
  expect(await page.evaluate(() => window.photoStudio.doc === (window as unknown as { secondDraft: unknown }).secondDraft)).toBe(true);
  expect(await inputText(page)).toBe('Second');
  await run(page, 'type.commit');
  expect(await page.evaluate(({ other, original }) => {
    const e = window.photoStudio;
    return [original, other].map((id) => {
      const s = e.sessions.find((s) => s.id === id)!;
      return { text: s.doc.layers.at(-1)!.text, history: s.history.labels };
    });
  }, { other, original })).toEqual([{ text: 'First', history: ['Type Tool'] }, { text: 'Second', history: ['Type Tool'] }]);
});
