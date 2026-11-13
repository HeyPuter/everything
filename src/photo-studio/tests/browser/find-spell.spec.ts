import { test, expect, type Page } from '@playwright/test';
import { boot, idle, openImage, run } from './helpers';

async function textDoc(page: Page, texts: string[]) {
  await page.evaluate(async (texts) => {
    const e = window.photoStudio;
    const { newDocument, layer: newLayer } = await import('/src/model/document.ts');
    const doc = newDocument(800, 400, 'Text');
    e.history.reset(doc);
    e.hasDocument = true;
    const { fromPlainText, defaultCharStyle } = await import('/src/imaging/text/model.ts');
    texts.forEach((text, i) => {
      const data = { content: fromPlainText(text, { ...defaultCharStyle(), size: 30 }), mode: 'point' as const, origin: { x: 40, y: 80 + i * 80 }, orientation: 'horizontal' as const, antiAlias: 'smooth' as const };
      const l = newLayer('text', text, 1, 1);
      l.textData = data;
      l.text = text;
      e.command('Add', (d) => d.layers.push(l));
      e.selected = l.id;
    });
    e.update();
  }, texts);
  await idle(page);
}
const layerTexts = (page: Page) => page.evaluate(() => window.photoStudio.doc.layers.map((l) => l.text));

test('Find and Replace changes text across layers', async ({ page }) => {
  await boot(page);
  await textDoc(page, ['a dog and a Dog', 'hotdog dog']);
  await page.evaluate(() => window.photoStudio.runCommand('edit.find-replace-text'));
  const dlg = page.locator('dialog.fr-workspace');
  await dlg.locator('#fr-find').fill('dog');
  await dlg.locator('#fr-change').fill('cat');
  await dlg.getByLabel('Whole Word Only').check();
  await dlg.getByRole('button', { name: 'Find Next' }).click();
  await expect(dlg.locator('#fr-status')).toContainText('Found in');
  await dlg.getByRole('button', { name: 'Change All' }).click();
  await expect(dlg.locator('#fr-status')).toContainText('Changed 3 occurrences in 2 layers');
  expect(await layerTexts(page)).toEqual(['a cat and a cat', 'hotdog cat']);
  expect(await page.evaluate(() => window.photoStudio.history.labels.at(-1))).toBe('Replace Text');
});

test('Check Spelling suggests and changes a misspelled word', async ({ page }) => {
  await boot(page);
  await textDoc(page, ['over teh lazy dog']);
  await page.evaluate(() => window.photoStudio.runCommand('edit.check-spelling'));
  const dlg = page.locator('dialog.sp-workspace');
  await expect(dlg.locator('#sp-word')).toHaveText('teh');
  await expect(dlg.locator('#sp-change')).toHaveValue('the');
  await dlg.getByRole('button', { name: 'Change', exact: true }).click();
  await expect(dlg.locator('#sp-status')).toHaveText('Spell check complete.');
  await dlg.getByRole('button', { name: 'Done' }).click();
  await page.evaluate(() => window.photoStudio.runCommand('select.deselect-layers'));
  await idle(page);
  expect(await layerTexts(page)).toEqual(['over the lazy dog']);
});

for (const change of ['replacement', 'query', 'options']) for (const action of ['close', 'change']) test(`Change All retains its original ${change} after ${action} during font loading`, async ({ page }) => {
  await boot(page);
  await textDoc(page, ['dog Dog hotdog', 'dog Dog hotdog']);
  await page.evaluate(() => {
    const load = FontFace.prototype.load;
    FontFace.prototype.load = function () {
      if (!this.family.includes('Caveat')) return load.call(this);
      FontFace.prototype.load = load;
      return new Promise<void>((resolve) => Object.assign(window, { releaseFindFont: resolve })).then(() => load.call(this));
    };
    window.photoStudio.command('Unloaded text font', (d) => {
      for (const l of d.layers) for (const p of l.textData!.content.paragraphs) for (const r of p.runs) r.style.family = 'Caveat';
    });
  });
  await page.evaluate(() => window.photoStudio.runCommand('edit.find-replace-text'));
  const dlg = page.locator('dialog.fr-workspace');
  await dlg.locator('#fr-find').fill('dog');
  await dlg.locator('#fr-change').fill('cat');
  await dlg.getByLabel('Whole Word Only').check();
  await dlg.getByRole('button', { name: 'Change All' }).click();
  await page.waitForFunction(() => !!(window as unknown as { releaseFindFont?: () => void }).releaseFindFont);
  if (change === 'replacement') await dlg.locator('#fr-change').fill('fox');
  else if (change === 'query') await dlg.locator('#fr-find').fill('hotdog');
  else {
    await dlg.getByLabel('Case Sensitive').check();
    await dlg.getByLabel('Whole Word Only').uncheck();
  }
  await dlg.getByRole('button', { name: action === 'close' ? 'Done' : 'Change', exact: true }).click();
  await page.evaluate(async () => {
    (window as unknown as { releaseFindFont(): void }).releaseFindFont();
    await (await import('/src/imaging/text/fonts.ts')).ensureFont('Caveat');
  });
  await idle(page);
  expect(await layerTexts(page)).toEqual(['cat cat hotdog', 'cat cat hotdog']);
  if (action === 'change') await expect(dlg.locator('#fr-status')).toHaveText('Changed 4 occurrences in 2 layers.');
  await run(page, 'edit.undo');
  expect(await layerTexts(page)).toEqual(['dog Dog hotdog', 'dog Dog hotdog']);
  await run(page, 'edit.redo');
  expect(await layerTexts(page)).toEqual(['cat cat hotdog', 'cat cat hotdog']);
  if (action === 'close') await page.evaluate(() => window.photoStudio.runCommand('edit.find-replace-text'));
  await expect(dlg.locator('#fr-find')).toHaveValue(change === 'query' ? 'hotdog' : 'dog');
  await expect(dlg.locator('#fr-change')).toHaveValue(change === 'replacement' ? 'fox' : 'cat');
  await expect(dlg.getByLabel('Case Sensitive')).toBeChecked({ checked: change === 'options' });
  await expect(dlg.getByLabel('Whole Word Only')).toBeChecked({ checked: change !== 'options' });
});

for (const ending of ['committed', 'live']) for (const newText of ['New dog dog', 'New words']) test(`Change All preserves newer ${ending} text '${newText}' while another layer's font loads`, async ({ page }) => {
  await boot(page);
  await textDoc(page, ['dog', 'dog']);
  await page.evaluate(() => {
    const load = FontFace.prototype.load;
    FontFace.prototype.load = function () {
      if (!this.family.includes('Caveat')) return load.call(this);
      FontFace.prototype.load = load;
      return new Promise<void>((resolve) => Object.assign(window, { releaseFindFont: resolve })).then(() => load.call(this));
    };
    window.photoStudio.command('Unloaded first layer', (d) => {
      d.layers[0].textData!.content.paragraphs[0].runs[0].style.family = 'Caveat';
    });
  });
  await page.evaluate(() => window.photoStudio.runCommand('edit.find-replace-text'));
  const dlg = page.locator('dialog.fr-workspace');
  await dlg.locator('#fr-find').fill('dog');
  await dlg.locator('#fr-change').fill('cat');
  await dlg.getByRole('button', { name: 'Change All' }).click();
  await page.waitForFunction(() => !!(window as unknown as { releaseFindFont?: () => void }).releaseFindFont);
  await page.evaluate(async () => {
    const e = window.photoStudio;
    e.setTool('type');
    await (window as unknown as { photoStudioType: typeof import('../../src/features/type/session') }).photoStudioType.startEdit(e, e.doc.layers.at(-1)!.id, 'all');
  });
  await expect(page.locator('textarea.type-input')).toBeFocused();
  await page.keyboard.insertText(newText);
  if (ending === 'committed') await run(page, 'type.commit');
  await page.evaluate(async () => {
    (window as unknown as { releaseFindFont(): void }).releaseFindFont();
    await (await import('/src/imaging/text/fonts.ts')).ensureFont('Caveat');
  });
  await idle(page);
  const replaced = newText.replaceAll('dog', 'cat');
  expect(await layerTexts(page)).toEqual(['cat', replaced]);
  await expect(dlg.locator('#fr-status')).toHaveText(newText.includes('dog') ? 'Changed 3 occurrences in 2 layers.' : 'Changed 1 occurrence in 1 layer.');
  await run(page, 'edit.undo');
  expect(await layerTexts(page)).toEqual(['dog', newText]);
  await run(page, 'edit.redo');
  expect(await layerTexts(page)).toEqual(['cat', replaced]);
  if (ending === 'live') {
    await expect(page.locator('textarea.type-input')).toBeFocused();
    await page.keyboard.insertText(' more');
    await run(page, 'type.commit');
    expect(await layerTexts(page)).toEqual(['cat', replaced + ' more']);
  }
});

for (const replacement of ['kitten', 'x']) for (const selection of ['caret', 'forward range', 'backward range', 'matched word', 'newly typed']) test(`delayed Change All keeps ${selection} after replacing dog with ${replacement}`, async ({ page }) => {
  await boot(page);
  await textDoc(page, ['dog', 'dog tail']);
  await page.evaluate(() => {
    const load = FontFace.prototype.load;
    FontFace.prototype.load = function () {
      if (!this.family.includes('Caveat')) return load.call(this);
      FontFace.prototype.load = load;
      return new Promise<void>((resolve) => Object.assign(window, { releaseFindFont: resolve })).then(() => load.call(this));
    };
    window.photoStudio.command('Unloaded first layer', (d) => {
      d.layers[0].textData!.content.paragraphs[0].runs[0].style.family = 'Caveat';
    });
  });
  await page.evaluate(() => window.photoStudio.runCommand('edit.find-replace-text'));
  const dlg = page.locator('dialog.fr-workspace');
  await dlg.locator('#fr-find').fill('dog');
  await dlg.locator('#fr-change').fill(replacement);
  await dlg.getByRole('button', { name: 'Change All' }).click();
  await page.waitForFunction(() => !!(window as unknown as { releaseFindFont?: () => void }).releaseFindFont);
  await page.evaluate(async (selection) => {
    const e = window.photoStudio;
    e.setTool('type');
    const m = (window as unknown as { photoStudioType: typeof import('../../src/features/type/session') }).photoStudioType;
    await m.startEdit(e, e.doc.layers.at(-1)!.id, 'end');
    const [anchor, focus] = selection === 'forward range' ? [4, 8] : selection === 'backward range' ? [8, 4] : selection === 'matched word' ? [0, 3] : [4, 4];
    m.setSelection(e, anchor, focus);
  }, selection);
  if (selection === 'newly typed') {
    await expect(page.locator('textarea.type-input')).toBeFocused();
    await page.keyboard.insertText('dog ');
  }
  await page.evaluate(async () => {
    (window as unknown as { releaseFindFont(): void }).releaseFindFont();
    await (await import('/src/imaging/text/fonts.ts')).ensureFont('Caveat');
  });
  await idle(page);
  const n = replacement.length;
  const original = selection === 'newly typed' ? 'dog dog tail' : 'dog tail';
  const replaced = original.replaceAll('dog', replacement);
  const before = selection === 'forward range' ? [4, 8] : selection === 'backward range' ? [8, 4] : selection === 'matched word' ? [0, 3] : selection === 'newly typed' ? [8, 8] : [4, 4];
  const after = selection === 'forward range' ? [n + 1, n + 5] : selection === 'backward range' ? [n + 5, n + 1] : selection === 'matched word' ? [0, n] : selection === 'newly typed' ? [2 * n + 2, 2 * n + 2] : [n + 1, n + 1];
  const offsets = () => page.evaluate(() => {
    const s = (window as unknown as { photoStudioType: typeof import('../../src/features/type/session') }).photoStudioType.currentSession()!;
    return [s.anchor, s.focus];
  });
  expect(await layerTexts(page)).toEqual([replacement, replaced]);
  expect(await offsets()).toEqual(after);
  await run(page, 'edit.undo');
  expect(await layerTexts(page)).toEqual(['dog', original]);
  expect(await offsets()).toEqual(before);
  await run(page, 'edit.redo');
  expect(await offsets()).toEqual(after);
  await expect(page.locator('textarea.type-input')).toBeFocused();
  await page.keyboard.insertText('X');
  await run(page, 'type.commit');
  const [a, b] = [...after].sort((a, b) => a - b);
  expect(await layerTexts(page)).toEqual([replacement, replaced.slice(0, a) + 'X' + replaced.slice(b)]);
});

for (const ending of ['committed', 'live']) for (const correction of ['the', 'these', 'a']) for (const newText of ['new teh TEH Teh dog', 'new dog']) test(`bulk spelling preserves newer ${ending} '${newText}' with correction '${correction}' during a font wait`, async ({ page }) => {
  await boot(page);
  await textDoc(page, ['teh', 'teh']);
  await page.evaluate(() => {
    const load = FontFace.prototype.load;
    FontFace.prototype.load = function () {
      if (!this.family.includes('Caveat')) return load.call(this);
      FontFace.prototype.load = load;
      return new Promise<void>((resolve) => Object.assign(window, { releaseFindFont: resolve })).then(() => load.call(this));
    };
    window.photoStudio.command('Unloaded first layer', (d) => {
      d.layers[0].textData!.content.paragraphs[0].runs[0].style.family = 'Caveat';
    });
  });
  await page.evaluate(() => window.photoStudio.runCommand('edit.check-spelling'));
  const dlg = page.locator('dialog.sp-workspace');
  await expect(dlg.locator('#sp-word')).toHaveText('teh');
  await dlg.locator('#sp-change').fill(correction);
  await dlg.getByRole('button', { name: 'Change All' }).click();
  await page.waitForFunction(() => !!(window as unknown as { releaseFindFont?: () => void }).releaseFindFont);
  await page.evaluate(async () => {
    const e = window.photoStudio;
    e.setTool('type');
    await (window as unknown as { photoStudioType: typeof import('../../src/features/type/session') }).photoStudioType.startEdit(e, e.doc.layers.at(-1)!.id, 'all');
  });
  await expect(page.locator('textarea.type-input')).toBeFocused();
  await page.keyboard.insertText(newText);
  if (ending === 'committed') await run(page, 'type.commit');
  await page.evaluate(async () => {
    (window as unknown as { releaseFindFont(): void }).releaseFindFont();
    await (await import('/src/imaging/text/fonts.ts')).ensureFont('Caveat');
  });
  await idle(page);
  const corrected = newText.includes('teh') ? `new ${correction} ${correction.toUpperCase()} ${correction[0].toUpperCase() + correction.slice(1)} dog` : newText;
  expect(await layerTexts(page)).toEqual([correction, corrected]);
  await expect(dlg.locator('#sp-status')).toHaveText('Spell check complete.');
  await run(page, 'edit.undo');
  expect(await layerTexts(page)).toEqual(['teh', newText]);
  await run(page, 'edit.redo');
  expect(await layerTexts(page)).toEqual([correction, corrected]);
  if (ending === 'live') {
    await expect(page.locator('textarea.type-input')).toBeFocused();
    await page.keyboard.insertText(' more');
    await run(page, 'type.commit');
    expect(await layerTexts(page)).toEqual([correction, corrected + ' more']);
  }
});

for (const phase of ['correction', 'initial search', 'find search']) for (const action of ['Done', 'Escape', 'keep open']) test(`${action} during ${phase} respects the pending search lifetime`, async ({ page }) => {
  await boot(page);
  await textDoc(page, phase === 'correction' ? ['teh', 'teh wrod'] : ['teh']);
  await page.evaluate(() => {
    const load = FontFace.prototype.load;
    FontFace.prototype.load = function () {
      if (!this.family.includes('Caveat')) return load.call(this);
      FontFace.prototype.load = load;
      return new Promise<void>((resolve) => Object.assign(window, { releaseFindFont: resolve })).then(() => load.call(this));
    };
    window.photoStudio.command('Unloaded first layer', (d) => {
      d.layers[0].textData!.content.paragraphs[0].runs[0].style.family = 'Caveat';
    });
  });
  await page.evaluate((phase) => window.photoStudio.runCommand(phase === 'find search' ? 'edit.find-replace-text' : 'edit.check-spelling'), phase);
  const dlg = page.locator(phase === 'find search' ? 'dialog.fr-workspace' : 'dialog.sp-workspace');
  if (phase === 'find search') {
    await dlg.locator('#fr-find').fill('teh');
    await dlg.getByRole('button', { name: 'Find Next' }).click();
  }
  if (phase === 'correction') {
    await expect(dlg.locator('#sp-word')).toHaveText('teh');
    await dlg.locator('#sp-change').fill('the');
    await dlg.getByRole('button', { name: 'Change All' }).click();
  } else await expect(page.locator('textarea.type-input')).toBeFocused();
  await page.waitForFunction(() => !!(window as unknown as { releaseFindFont?: () => void }).releaseFindFont);
  expect(await page.evaluate(() => !!(window as unknown as { photoStudioType: typeof import('../../src/features/type/session') }).photoStudioType.currentSession())).toBe(false);
  if (action === 'Done') await dlg.getByRole('button', { name: 'Done' }).click();
  else if (action === 'Escape') await dlg.locator(phase === 'find search' ? '#fr-find' : '#sp-change').press('Escape');
  await expect(dlg).toHaveCount(action === 'keep open' ? 1 : 0);
  await page.evaluate(async () => {
    (window as unknown as { releaseFindFont(): void }).releaseFindFont();
    await (await import('/src/imaging/text/fonts.ts')).ensureFont('Caveat');
  });
  await idle(page);
  expect(await layerTexts(page)).toEqual(phase === 'correction' ? ['the', 'the wrod'] : ['teh']);
  expect(await page.evaluate(() => !!(window as unknown as { photoStudioType: typeof import('../../src/features/type/session') }).photoStudioType.currentSession())).toBe(action === 'keep open');
});


test('reopening Find starts a new search while the removed dialog still waits for a font', async ({ page }) => {
  await boot(page);
  await textDoc(page, ['teh wrod']);
  await page.evaluate(() => {
    const load = FontFace.prototype.load;
    FontFace.prototype.load = function () {
      if (!this.family.includes('Caveat')) return load.call(this);
      FontFace.prototype.load = load;
      return new Promise<void>((resolve) => Object.assign(window, { releaseFindFont: resolve })).then(() => load.call(this));
    };
    window.photoStudio.command('Unloaded font', (d) => {
      d.layers[0].textData!.content.paragraphs[0].runs[0].style.family = 'Caveat';
    });
  });
  await page.evaluate(() => window.photoStudio.runCommand('edit.find-replace-text'));
  const dlg = page.locator('dialog.fr-workspace');
  await dlg.locator('#fr-find').fill('teh');
  await dlg.getByRole('button', { name: 'Find Next' }).click();
  await expect(page.locator('textarea.type-input')).toBeFocused();
  await page.evaluate(() => window.photoStudio.runCommand('edit.find-replace-text'));
  await expect(dlg).toHaveCount(1);
  await dlg.locator('#fr-find').fill('wrod');
  await dlg.getByRole('button', { name: 'Find Next' }).click();
  await page.evaluate(async () => {
    (window as unknown as { releaseFindFont(): void }).releaseFindFont();
    await (await import('/src/imaging/text/fonts.ts')).ensureFont('Caveat');
  });
  await idle(page);
  expect(await page.evaluate(() => {
    const s = (window as unknown as { photoStudioType: typeof import('../../src/features/type/session') }).photoStudioType.currentSession()!;
    return [s.anchor, s.focus];
  })).toEqual([4, 8]);
  await expect(dlg.getByRole('button', { name: 'Find Next' })).toBeFocused();
});

test('closing Find preserves typing already started during its font wait', async ({ page }) => {
  await boot(page);
  await textDoc(page, ['teh']);
  await page.evaluate(() => {
    const load = FontFace.prototype.load;
    FontFace.prototype.load = function () {
      if (!this.family.includes('Caveat')) return load.call(this);
      FontFace.prototype.load = load;
      return new Promise<void>((resolve) => Object.assign(window, { releaseFindFont: resolve })).then(() => load.call(this));
    };
    window.photoStudio.command('Unloaded font', (d) => {
      d.layers[0].textData!.content.paragraphs[0].runs[0].style.family = 'Caveat';
    });
  });
  await page.evaluate(() => window.photoStudio.runCommand('edit.find-replace-text'));
  const dlg = page.locator('dialog.fr-workspace');
  await dlg.locator('#fr-find').fill('teh');
  await dlg.getByRole('button', { name: 'Find Next' }).click();
  await expect(page.locator('textarea.type-input')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.insertText(' more');
  await dlg.getByRole('button', { name: 'Done' }).click();
  await page.evaluate(async () => {
    (window as unknown as { releaseFindFont(): void }).releaseFindFont();
    await (await import('/src/imaging/text/fonts.ts')).ensureFont('Caveat');
  });
  await idle(page);
  expect(await layerTexts(page)).toEqual(['teh more']);
  expect(await page.evaluate(() => {
    const s = (window as unknown as { photoStudioType: typeof import('../../src/features/type/session') }).photoStudioType.currentSession()!;
    return [s.anchor, s.focus];
  })).toEqual([8, 8]);
  await expect(page.locator('textarea.type-input')).toBeFocused();
  await page.keyboard.insertText(' text');
  await run(page, 'type.commit');
  expect(await layerTexts(page)).toEqual(['teh more text']);
});

for (const state of ['loading', 'failure']) for (const action of ['Done', 'Escape']) test(`spelling can close with ${action} during dictionary ${state}`, async ({ page }) => {
  await boot(page);
  await textDoc(page, ['teh']);
  let release: (() => void) | undefined;
  await page.route('**/dictionaries/en-US.txt.gz', async (route) => {
    if (state === 'failure') return route.fulfill({ status: 503, body: 'Unavailable' });
    await new Promise<void>((resolve) => { release = resolve; });
    await route.continue();
  });
  await page.evaluate(() => window.photoStudio.runCommand('edit.check-spelling'));
  const dlg = page.locator('dialog.sp-workspace');
  if (state === 'loading') await expect.poll(() => !!release).toBe(true);
  else await expect(dlg.locator('#sp-status')).toHaveText('The dictionary could not be loaded (503).');
  if (action === 'Done') await dlg.getByRole('button', { name: 'Done' }).click();
  else await dlg.locator('#sp-change').press('Escape');
  const remainingDialogs = await dlg.count();
  if (state === 'loading') {
    const response = page.waitForResponse('**/dictionaries/en-US.txt.gz');
    release!();
    await (await response).finished();
    await idle(page);
  }
  expect(remainingDialogs).toBe(0);
  expect(await page.evaluate(() => !!(window as unknown as { photoStudioType: typeof import('../../src/features/type/session') }).photoStudioType.currentSession())).toBe(false);
  expect(await layerTexts(page)).toEqual(['teh']);
  if (state === 'failure') {
    await page.unroute('**/dictionaries/en-US.txt.gz');
    await page.evaluate(() => window.photoStudio.runCommand('edit.check-spelling'));
    await expect(dlg.locator('#sp-word')).toHaveText('teh');
    await dlg.getByRole('button', { name: 'Done' }).click();
    await expect(dlg).toHaveCount(0);
  }
});

for (const query of ['wrod', 'absent', '']) test(`a newer Find query '${query}' supersedes a result waiting for fonts`, async ({ page }) => {
  await boot(page);
  await textDoc(page, ['teh wrod']);
  await page.evaluate(() => {
    const load = FontFace.prototype.load;
    FontFace.prototype.load = function () {
      if (!this.family.includes('Caveat')) return load.call(this);
      FontFace.prototype.load = load;
      return new Promise<void>((resolve) => Object.assign(window, { releaseFindFont: resolve })).then(() => load.call(this));
    };
    window.photoStudio.command('Unloaded font', (d) => {
      d.layers[0].textData!.content.paragraphs[0].runs[0].style.family = 'Caveat';
    });
  });
  await page.evaluate(() => window.photoStudio.runCommand('edit.find-replace-text'));
  const dlg = page.locator('dialog.fr-workspace');
  await dlg.locator('#fr-find').fill('teh');
  await dlg.getByRole('button', { name: 'Find Next' }).click();
  await expect(page.locator('textarea.type-input')).toBeFocused();
  await dlg.locator('#fr-find').fill(query);
  await dlg.getByRole('button', { name: 'Find Next' }).click();
  await page.evaluate(async () => {
    (window as unknown as { releaseFindFont(): void }).releaseFindFont();
    await (await import('/src/imaging/text/fonts.ts')).ensureFont('Caveat');
  });
  await idle(page);
  const selected = await page.evaluate(() => {
    const s = (window as unknown as { photoStudioType: typeof import('../../src/features/type/session') }).photoStudioType.currentSession();
    return s && [s.anchor, s.focus];
  });
  if (query === 'wrod') {
    expect(selected).toEqual([4, 8]);
    await dlg.locator('#fr-change').fill('word');
    await dlg.getByRole('button', { name: 'Change', exact: true }).click();
    await run(page, 'type.commit');
    expect(await layerTexts(page)).toEqual(['teh word']);
    await run(page, 'edit.undo');
    expect(await layerTexts(page)).toEqual(['teh wrod']);
    await run(page, 'edit.redo');
    expect(await layerTexts(page)).toEqual(['teh word']);
  } else {
    expect(selected).toBeUndefined();
    await expect(dlg.locator('#fr-status')).toHaveText(query ? 'No matches.' : 'Type the text to find.');
  }
});

for (const reset of [false, true]) test(`a newer Find result starts before an abandoned font finishes${reset ? ' after a no-match query' : ''}`, async ({ page }) => {
  await boot(page);
  await textDoc(page, ['teh', 'wrod']);
  const target = await page.evaluate(() => window.photoStudio.doc.layers.at(-1)!.id);
  await page.evaluate(() => {
    const load = FontFace.prototype.load;
    FontFace.prototype.load = function () {
      if (!this.family.includes('Caveat')) return load.call(this);
      FontFace.prototype.load = load;
      return new Promise<void>((resolve) => Object.assign(window, { releaseFindFont: resolve })).then(() => load.call(this));
    };
    window.photoStudio.command('Unloaded first layer', (d) => {
      d.layers[0].textData!.content.paragraphs[0].runs[0].style.family = 'Caveat';
    });
  });
  await page.evaluate(() => window.photoStudio.runCommand('edit.find-replace-text'));
  const dlg = page.locator('dialog.fr-workspace');
  await dlg.locator('#fr-find').fill('teh');
  await dlg.getByRole('button', { name: 'Find Next' }).click();
  await expect(page.locator('textarea.type-input')).toBeFocused();
  if (reset) {
    await dlg.locator('#fr-find').fill('absent');
    await dlg.getByRole('button', { name: 'Find Next' }).click();
    await expect(dlg.locator('#fr-status')).toHaveText('No matches.');
  }
  await dlg.locator('#fr-find').fill('wrod');
  await dlg.getByRole('button', { name: 'Find Next' }).click();
  const selection = () => page.evaluate(() => {
    const s = (window as unknown as { photoStudioType: typeof import('../../src/features/type/session') }).photoStudioType.currentSession();
    return s && { layer: s.layerId, anchor: s.anchor, focus: s.focus };
  });
  await expect.poll(selection).toEqual({ layer: target, anchor: 0, focus: 4 });
  await page.evaluate(async () => {
    (window as unknown as { releaseFindFont(): void }).releaseFindFont();
    await (await import('/src/imaging/text/fonts.ts')).ensureFont('Caveat');
  });
  await idle(page);
  expect(await selection()).toEqual({ layer: target, anchor: 0, focus: 4 });
  await expect(dlg.getByRole('button', { name: 'Find Next' })).toBeFocused();
});

for (const sharedId of [true, false]) for (const dialog of ['Find', 'Spelling']) test(`a delayed ${dialog} result preserves another document's text selection and focus${sharedId ? ' with matching layer IDs' : ''}`, async ({ page }) => {
  await boot(page);
  await openImage(page, 240, 160, '#ffffff', 'other.png');
  const other = await page.evaluate(() => window.photoStudio.session.id);
  await openImage(page, 240, 160, '#ffffff', 'original.png');
  await textDoc(page, ['teh']);
  await page.evaluate(async ({ other, sharedId }) => {
    const e = window.photoStudio;
    const { textLayer } = await import('/src/imaging/text/model.ts');
    const l = e.doc.layers[0];
    const s = e.sessions.find((s) => s.id === other)!;
    // Duplicated documents retain layer IDs while their text can diverge.
    s.history.reset({ ...s.doc, layers: [{ ...l, id: sharedId ? l.id : crypto.randomUUID(), name: 'Other text', text: 'Other text', textData: textLayer('Other text', { family: 'Inter' }) }] });
    const load = FontFace.prototype.load;
    FontFace.prototype.load = function () {
      if (!this.family.includes('Caveat')) return load.call(this);
      FontFace.prototype.load = load;
      return new Promise<void>((resolve) => Object.assign(window, { releaseFindFont: resolve })).then(() => load.call(this));
    };
    e.command('Unloaded font', (d) => {
      d.layers[0].textData!.content.paragraphs[0].runs[0].style.family = 'Caveat';
    });
  }, { other, sharedId });
  await page.evaluate((dialog) => window.photoStudio.runCommand(dialog === 'Find' ? 'edit.find-replace-text' : 'edit.check-spelling'), dialog);
  if (dialog === 'Find') {
    const dlg = page.locator('dialog.fr-workspace');
    await dlg.locator('#fr-find').fill('teh');
    await dlg.getByRole('button', { name: 'Find Next' }).click();
  }
  await expect(page.locator('textarea.type-input')).toBeFocused();
  await page.locator(`.document-tab[data-session="${other}"]`).click();
  await page.evaluate(async () => {
    const e = window.photoStudio;
    await (window as unknown as { photoStudioType: typeof import('../../src/features/type/session') }).photoStudioType.startEdit(e, e.doc.layers[0].id, 'end');
  });
  await page.locator('#type-size').focus();
  await page.evaluate(async () => {
    (window as unknown as { releaseFindFont(): void }).releaseFindFont();
    await (await import('/src/imaging/text/fonts.ts')).ensureFont('Caveat');
  });
  await idle(page);
  expect(await page.evaluate(() => {
    const s = (window as unknown as { photoStudioType: typeof import('../../src/features/type/session') }).photoStudioType.currentSession()!;
    return [s.anchor, s.focus];
  })).toEqual([10, 10]);
  await expect(page.locator('#type-size')).toBeFocused();
  await page.locator('textarea.type-input').focus();
  await page.keyboard.insertText(' more');
  await run(page, 'type.commit');
  expect(await layerTexts(page)).toEqual(['Other text more']);
  await run(page, 'edit.undo');
  expect(await layerTexts(page)).toEqual(['Other text']);
  await run(page, 'edit.redo');
  expect(await layerTexts(page)).toEqual(['Other text more']);
  if (dialog === 'Find') {
    const dlg = page.locator('dialog.fr-workspace');
    await dlg.locator('#fr-find').fill('more');
    await dlg.getByRole('button', { name: 'Find Next' }).click();
    await expect(dlg.locator('#fr-status')).toContainText('Found in');
    expect(await page.evaluate(() => {
      const s = (window as unknown as { photoStudioType: typeof import('../../src/features/type/session') }).photoStudioType.currentSession()!;
      return [s.anchor, s.focus];
    })).toEqual([11, 15]);
  }
});

for (const [changed, newText, action] of [
  ['text', 'Other text', 'Change'],
  ['document', 'Other text', 'Change'],
  ['text', 'new teh', 'Change'],
  ['text', 'new teh', 'Change All'],
  ['document', 'teh', 'Change'],
  ['document', 'teh', 'Change All'],
  ['text', 'teh2', 'Change'],
  ['text', 'teh2', 'Change All'],
  ['text', 'teh more', 'Change'],
  ['text', 'Other text', 'Ignore'],
  ['document', 'Other text', 'Ignore'],
]) test(`spelling ${action} validates its match after changing ${changed} to '${newText}'`, async ({ page }) => {
  await boot(page);
  let other: string | undefined;
  if (changed === 'document') {
    await openImage(page, 240, 160, '#ffffff', 'other.png');
    other = await page.evaluate(() => window.photoStudio.session.id);
    await openImage(page, 240, 160, '#ffffff', 'original.png');
  }
  await textDoc(page, ['teh']);
  if (other) await page.evaluate(async ({ other, newText }) => {
    const e = window.photoStudio;
    const { textLayer } = await import('/src/imaging/text/model.ts');
    const l = e.doc.layers[0];
    const s = e.sessions.find((s) => s.id === other)!;
    s.history.reset({ ...s.doc, layers: [{ ...l, name: newText, text: newText, textData: textLayer(newText, { family: 'Inter' }) }] });
  }, { other, newText });
  await page.evaluate(() => window.photoStudio.runCommand('edit.check-spelling'));
  const dlg = page.locator('dialog.sp-workspace');
  await expect(dlg.locator('#sp-word')).toHaveText('teh');
  if (other) {
    await page.locator(`.document-tab[data-session="${other}"]`).click();
    await page.evaluate(async () => {
      const e = window.photoStudio;
      await (window as unknown as { photoStudioType: typeof import('../../src/features/type/session') }).photoStudioType.startEdit(e, e.doc.layers[0].id, 'end');
    });
  } else {
    await page.locator('textarea.type-input').focus();
    await page.keyboard.insertText(newText);
  }
  await dlg.getByRole('button', { name: action, exact: true }).click();
  await idle(page);
  const valid = newText === 'teh more';
  expect(await layerTexts(page)).toEqual([valid ? 'the more' : newText]);
  const refreshed = newText === 'new teh' || newText === 'teh';
  if (refreshed) {
    await expect(dlg.locator('#sp-word')).toHaveText('teh');
    const at = newText.indexOf('teh');
    expect(await page.evaluate(() => {
      const s = (window as unknown as { photoStudioType: typeof import('../../src/features/type/session') }).photoStudioType.currentSession()!;
      return [s.anchor, s.focus];
    })).toEqual([at, at + 3]);
    await dlg.getByRole('button', { name: action, exact: true }).click();
  }
  await expect(dlg.locator('#sp-status')).toHaveText('Spell check complete.');
  if (action === 'Ignore') expect(await page.evaluate(() => {
    const s = (window as unknown as { photoStudioType: typeof import('../../src/features/type/session') }).photoStudioType.currentSession()!;
    return [s.anchor, s.focus];
  })).toEqual([newText.length, newText.length]);
  await run(page, 'type.commit');
  const finalText = refreshed || valid ? newText.replace('teh', 'the') : newText;
  expect(await layerTexts(page)).toEqual([finalText]);
  if (refreshed || valid) {
    await run(page, 'edit.undo');
    expect(await layerTexts(page)).toEqual([action === 'Change All' ? newText : 'teh']);
    await run(page, 'edit.redo');
    expect(await layerTexts(page)).toEqual([finalText]);
  }
});

for (const phase of ['initial search', 'next word']) for (const action of ['bulk correction', 'custom correction', 'Ignore All']) test(`spelling ${action} uses the displayed result during ${phase}`, async ({ page }) => {
  await boot(page);
  await textDoc(page, phase === 'initial search' ? ['teh'] : ['wrod', 'teh']);
  await page.evaluate(() => {
    const load = FontFace.prototype.load;
    FontFace.prototype.load = function () {
      if (!this.family.includes('Caveat')) return load.call(this);
      FontFace.prototype.load = load;
      return new Promise<void>((resolve) => Object.assign(window, { releaseFindFont: resolve })).then(() => load.call(this));
    };
    window.photoStudio.command('Unloaded first layer', (d) => {
      d.layers[0].textData!.content.paragraphs[0].runs[0].style.family = 'Caveat';
    });
  });
  await page.evaluate(() => window.photoStudio.runCommand('edit.check-spelling'));
  const dlg = page.locator('dialog.sp-workspace');
  if (phase === 'next word') {
    await expect(dlg.locator('#sp-word')).toHaveText('teh');
    await dlg.getByRole('button', { name: 'Change', exact: true }).click();
  }
  await expect(page.locator('textarea.type-input')).toBeFocused();
  const displayed = await dlg.evaluate((d) => ({
    word: d.querySelector('#sp-word')!.textContent,
    replacement: d.querySelector<HTMLInputElement>('#sp-change')!.value,
    status: d.querySelector('#sp-status')!.textContent,
  }));
  if (action === 'custom correction') await dlg.locator('#sp-change').fill('custom');
  else await dlg.getByRole('button', { name: action === 'Ignore All' ? action : 'Change All' }).click();
  await page.evaluate(async () => {
    (window as unknown as { releaseFindFont(): void }).releaseFindFont();
    await (await import('/src/imaging/text/fonts.ts')).ensureFont('Caveat');
  });
  await idle(page);
  expect(displayed).toEqual(phase === 'initial search' ? { word: 'teh', replacement: 'the', status: 'In “teh”.' } : { word: 'wrod', replacement: 'word', status: 'In “wrod”.' });
  if (action === 'Ignore All') {
    expect(await layerTexts(page)).toEqual(phase === 'initial search' ? ['teh'] : ['wrod', 'the']);
    await expect(dlg.locator('#sp-status')).toHaveText('Spell check complete.');
    expect(await page.evaluate(() => !!(window as unknown as { photoStudioType: typeof import('../../src/features/type/session') }).photoStudioType.currentSession())).toBe(false);
    return;
  }
  if (action === 'custom correction') {
    await expect(dlg.locator('#sp-change')).toHaveValue('custom');
    await dlg.getByRole('button', { name: 'Change All' }).click();
    await idle(page);
  }
  const replacement = action === 'custom correction' ? 'custom' : phase === 'initial search' ? 'the' : 'word';
  const corrected = phase === 'initial search' ? [replacement] : [replacement, 'the'];
  expect(await layerTexts(page)).toEqual(corrected);
  await expect(dlg.locator('#sp-status')).toHaveText('Spell check complete.');
  await run(page, 'type.commit');
  await run(page, 'edit.undo');
  expect(await layerTexts(page)).toEqual(phase === 'initial search' ? ['teh'] : ['wrod', 'the']);
  await run(page, 'edit.redo');
  expect(await layerTexts(page)).toEqual(corrected);
});

for (const target of ['dialog field', 'unchanged']) for (const dialog of ['Find', 'Spelling']) test(`a delayed ${dialog} result respects ${target} focus`, async ({ page }) => {
  await boot(page);
  await textDoc(page, target === 'unchanged' ? ['teh teh'] : ['teh']);
  await page.evaluate(() => {
    const load = FontFace.prototype.load;
    FontFace.prototype.load = function () {
      if (!this.family.includes('Caveat')) return load.call(this);
      FontFace.prototype.load = load;
      return new Promise<void>((resolve) => Object.assign(window, { releaseFindFont: resolve })).then(() => load.call(this));
    };
    window.photoStudio.command('Unloaded font', (d) => {
      d.layers[0].textData!.content.paragraphs[0].runs[0].style.family = 'Caveat';
    });
  });
  await page.evaluate((dialog) => window.photoStudio.runCommand(dialog === 'Find' ? 'edit.find-replace-text' : 'edit.check-spelling'), dialog);
  const dlg = page.locator(dialog === 'Find' ? 'dialog.fr-workspace' : 'dialog.sp-workspace');
  if (dialog === 'Find') {
    await dlg.locator('#fr-find').fill('teh');
    await dlg.getByRole('button', { name: 'Find Next' }).click();
  }
  await expect(page.locator('textarea.type-input')).toBeFocused();
  const field = dlg.locator(dialog === 'Find' ? '#fr-find' : '#sp-change');
  if (target !== 'unchanged') await field.fill('custom');
  if (target !== 'unchanged') await field.evaluate((el) => {
    (window as unknown as { searchFieldBlurred: boolean }).searchFieldBlurred = false;
    el.addEventListener('blur', () => { (window as unknown as { searchFieldBlurred: boolean }).searchFieldBlurred = true; }, { once: true });
  });
  await page.evaluate(async () => {
    (window as unknown as { releaseFindFont(): void }).releaseFindFont();
    await (await import('/src/imaging/text/fonts.ts')).ensureFont('Caveat');
  });
  await idle(page);
  if (target === 'unchanged') {
    // Focus must survive the text editor's deferred 300 ms options refresh.
    await page.waitForTimeout(450);
    const button = dlg.getByRole('button', { name: dialog === 'Find' ? 'Find Next' : 'Change', exact: true });
    await expect(button).toBeFocused();
    await page.keyboard.press('Space');
    await expect.poll(() => page.evaluate(() => {
      const s = (window as unknown as { photoStudioType: typeof import('../../src/features/type/session') }).photoStudioType.currentSession()!;
      return [s.anchor, s.focus];
    })).toEqual([4, 7]);
    expect(await layerTexts(page)).toEqual([dialog === 'Find' ? 'teh teh' : 'the teh']);
    await page.waitForTimeout(450);
    await expect(button).toBeFocused();
    return;
  }
  await expect(field).toBeFocused();
  if (target === 'dialog field') expect(await page.evaluate(() => (window as unknown as { searchFieldBlurred: boolean }).searchFieldBlurred)).toBe(false);
  await page.keyboard.insertText(' word');
  await expect(field).toHaveValue('custom word');
  expect(await layerTexts(page)).toEqual(['teh']);
});

for (const dialog of ['Find', 'Spelling']) test(`a delayed ${dialog} result retains the numeric caret while activating text`, async ({ page }) => {
  await boot(page);
  await textDoc(page, ['teh']);
  await page.evaluate(() => {
    const load = FontFace.prototype.load;
    FontFace.prototype.load = function () {
      if (!this.family.includes('Caveat')) return load.call(this);
      FontFace.prototype.load = load;
      return new Promise<void>((resolve) => Object.assign(window, { releaseFindFont: resolve })).then(() => load.call(this));
    };
    window.photoStudio.command('Unloaded font', (d) => {
      d.layers[0].textData!.content.paragraphs[0].runs[0].style.family = 'Caveat';
    });
  });
  await page.evaluate((dialog) => window.photoStudio.runCommand(dialog === 'Find' ? 'edit.find-replace-text' : 'edit.check-spelling'), dialog);
  const dlg = page.locator(dialog === 'Find' ? 'dialog.fr-workspace' : 'dialog.sp-workspace');
  if (dialog === 'Find') {
    await dlg.locator('#fr-find').fill('teh');
    await dlg.getByRole('button', { name: 'Find Next' }).click();
  }
  await expect(page.locator('textarea.type-input')).toBeFocused();
  const field = page.locator('#type-size');
  await field.fill('42');
  await field.evaluate((el) => {
    (window as unknown as { searchFieldBlurred: boolean }).searchFieldBlurred = false;
    el.addEventListener('blur', () => { (window as unknown as { searchFieldBlurred: boolean }).searchFieldBlurred = true; }, { once: true });
  });
  await page.evaluate(async () => {
    (window as unknown as { releaseFindFont(): void }).releaseFindFont();
    await (await import('/src/imaging/text/fonts.ts')).ensureFont('Caveat');
  });
  await idle(page);
  await expect(field).toBeFocused();
  expect(await page.evaluate(() => (window as unknown as { searchFieldBlurred: boolean }).searchFieldBlurred)).toBe(false);
  await page.keyboard.insertText('0');
  await expect(field).toHaveValue('420');
  expect(await layerTexts(page)).toEqual(['teh']);
  await expect(page.locator('#tool-options [data-command="type.commit"]')).toHaveCount(1);
  await field.press('Enter');
  await run(page, 'type.commit');
  await expect(page.locator('#tool-options [data-command="type.commit"]')).toHaveCount(0);
  const size = () => page.evaluate(() => window.photoStudio.doc.layers[0].textData!.content.paragraphs[0].runs[0].style.size);
  expect(await size()).toBe(420);
  await run(page, 'edit.undo');
  expect(await size()).toBe(30);
  await run(page, 'edit.redo');
  expect(await size()).toBe(420);
});

for (const texts of [['teh'], ['teh teh'], ['teh', 'teh']]) test(`Ignore skips each occurrence once in ${JSON.stringify(texts)}`, async ({ page }) => {
  await boot(page);
  await textDoc(page, texts);
  await page.evaluate(() => window.photoStudio.runCommand('edit.check-spelling'));
  const dlg = page.locator('dialog.sp-workspace');
  await expect(dlg.locator('#sp-word')).toHaveText('teh');
  const count = texts.join(' ').split(' ').length;
  for (let i = 0; i < count; i++) {
    await dlg.getByRole('button', { name: 'Ignore', exact: true }).click();
    await idle(page);
  }
  expect(await dlg.locator('#sp-status').textContent()).toBe('Spell check complete.');
  expect(await layerTexts(page)).toEqual(texts);
  await dlg.getByRole('button', { name: 'Done' }).click();
  await page.evaluate(() => window.photoStudio.runCommand('edit.check-spelling'));
  await expect(dlg.locator('#sp-word')).toHaveText('teh');
});

for (const action of ['Change', 'Change All']) for (const replacement of ['a', 'word', 'words']) test(`Ignore remains attached to a word after ${action} changes earlier text to '${replacement}'`, async ({ page }) => {
  await boot(page);
  await textDoc(page, ['wrod teh']);
  await page.evaluate(() => window.photoStudio.runCommand('edit.check-spelling'));
  const dlg = page.locator('dialog.sp-workspace');
  await expect(dlg.locator('#sp-word')).toHaveText('wrod');
  await dlg.locator('#sp-change').fill('wrod');
  await dlg.getByRole('button', { name: 'Change', exact: true }).click();
  await expect(dlg.locator('#sp-word')).toHaveText('teh');
  await dlg.getByRole('button', { name: 'Ignore', exact: true }).click();
  await expect(dlg.locator('#sp-word')).toHaveText('wrod');
  await dlg.locator('#sp-change').fill(replacement);
  await dlg.getByRole('button', { name: action, exact: true }).click();
  await expect(dlg.locator('#sp-status')).toHaveText('Spell check complete.');
  await run(page, 'type.commit');
  expect(await layerTexts(page)).toEqual([`${replacement} teh`]);
  await run(page, 'edit.undo');
  expect(await layerTexts(page)).toEqual(['wrod teh']);
  await run(page, 'edit.redo');
  expect(await layerTexts(page)).toEqual([`${replacement} teh`]);
});

for (const action of ['Change', 'Change All']) test(`Ignore skips one repeated word before ${action}`, async ({ page }) => {
  await boot(page);
  await textDoc(page, ['teh teh']);
  await page.evaluate(() => window.photoStudio.runCommand('edit.check-spelling'));
  const dlg = page.locator('dialog.sp-workspace');
  await expect(dlg.locator('#sp-word')).toHaveText('teh');
  await dlg.getByRole('button', { name: 'Ignore', exact: true }).click();
  await idle(page);
  expect(await page.evaluate(() => {
    const s = (window as unknown as { photoStudioType: typeof import('../../src/features/type/session') }).photoStudioType.currentSession()!;
    return [s.anchor, s.focus];
  })).toEqual([4, 7]);
  await dlg.getByRole('button', { name: action, exact: true }).click();
  await expect(dlg.locator('#sp-status')).toHaveText('Spell check complete.');
  expect(await layerTexts(page)).toEqual([action === 'Change' ? 'teh the' : 'the the']);
});

for (const nextLayer of [false, true]) test(`Ignore works before a pending font arrives${nextLayer ? ' and starts the next ready layer' : ''}`, async ({ page }) => {
  await boot(page);
  await textDoc(page, nextLayer ? ['wrod', 'teh'] : ['teh']);
  await page.evaluate(() => {
    const load = FontFace.prototype.load;
    FontFace.prototype.load = function () {
      if (!this.family.includes('Caveat')) return load.call(this);
      FontFace.prototype.load = load;
      return new Promise<void>((resolve) => Object.assign(window, { releaseFindFont: resolve })).then(() => load.call(this));
    };
    window.photoStudio.command('Unloaded current layer', (d) => {
      d.layers.at(-1)!.textData!.content.paragraphs[0].runs[0].style.family = 'Caveat';
    });
  });
  await page.evaluate(() => window.photoStudio.runCommand('edit.check-spelling'));
  const dlg = page.locator('dialog.sp-workspace');
  await expect(page.locator('textarea.type-input')).toBeFocused();
  await dlg.getByRole('button', { name: 'Ignore', exact: true }).click();
  if (nextLayer) {
    await expect(dlg.locator('#sp-word')).toHaveText('wrod');
    await expect.poll(() => page.evaluate(() => {
      const s = (window as unknown as { photoStudioType: typeof import('../../src/features/type/session') }).photoStudioType.currentSession();
      return s && [s.layerId, s.anchor, s.focus];
    })).toEqual([await page.evaluate(() => window.photoStudio.doc.layers[0].id), 0, 4]);
  } else await expect(dlg.locator('#sp-status')).toHaveText('Spell check complete.');
  await page.evaluate(async () => {
    (window as unknown as { releaseFindFont(): void }).releaseFindFont();
    await (await import('/src/imaging/text/fonts.ts')).ensureFont('Caveat');
  });
  await idle(page);
  if (nextLayer) await dlg.getByRole('button', { name: 'Change', exact: true }).click();
  await expect(dlg.locator('#sp-status')).toHaveText('Spell check complete.');
  expect(await layerTexts(page)).toEqual(nextLayer ? ['word', 'teh'] : ['teh']);
});

test('Ignore choices are rechecked after manually editing the layer', async ({ page }) => {
  await boot(page);
  await textDoc(page, ['teh wrod']);
  await page.evaluate(() => window.photoStudio.runCommand('edit.check-spelling'));
  const dlg = page.locator('dialog.sp-workspace');
  await expect(dlg.locator('#sp-word')).toHaveText('teh');
  await dlg.getByRole('button', { name: 'Ignore', exact: true }).click();
  await expect(dlg.locator('#sp-word')).toHaveText('wrod');
  await page.locator('textarea.type-input').focus();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText('teh new');
  await dlg.getByRole('button', { name: 'Ignore', exact: true }).click();
  await expect(dlg.locator('#sp-word')).toHaveText('teh');
  expect(await layerTexts(page)).toEqual(['teh new']);
  await dlg.getByRole('button', { name: 'Ignore', exact: true }).click();
  await expect(dlg.locator('#sp-status')).toHaveText('Spell check complete.');
});

test('Ignore choices stay in their document when copied layers share IDs', async ({ page }) => {
  await boot(page);
  await openImage(page, 240, 160, '#ffffff', 'other.png');
  const other = await page.evaluate(() => window.photoStudio.session.id);
  await openImage(page, 240, 160, '#ffffff', 'original.png');
  await textDoc(page, ['teh wrod']);
  const original = await page.evaluate((other) => {
    const e = window.photoStudio;
    const s = e.sessions.find((s) => s.id === other)!;
    s.history.reset({ ...s.doc, layers: structuredClone(e.doc.layers) });
    return e.session.id;
  }, other);
  await page.evaluate(() => window.photoStudio.runCommand('edit.check-spelling'));
  const dlg = page.locator('dialog.sp-workspace');
  await expect(dlg.locator('#sp-word')).toHaveText('teh');
  await dlg.getByRole('button', { name: 'Ignore', exact: true }).click();
  await expect(dlg.locator('#sp-word')).toHaveText('wrod');
  for (const id of [other, original]) {
    await page.locator(`.document-tab[data-session="${id}"]`).click();
    await page.evaluate(async () => {
      const e = window.photoStudio;
      await (window as unknown as { photoStudioType: typeof import('../../src/features/type/session') }).photoStudioType.startEdit(e, e.doc.layers[0].id, 'end');
    });
    await dlg.getByRole('button', { name: 'Ignore', exact: true }).click();
    await expect(dlg.locator('#sp-word')).toHaveText(id === other ? 'teh' : 'wrod');
    expect(await layerTexts(page)).toEqual(['teh wrod']);
  }
});

test('Ignore choices made while bulk spelling waits follow the completed correction', async ({ page }) => {
  await boot(page);
  await textDoc(page, ['wrod', 'wrod teh']);
  await page.evaluate(() => {
    const load = FontFace.prototype.load;
    FontFace.prototype.load = function () {
      if (!this.family.includes('Caveat')) return load.call(this);
      FontFace.prototype.load = load;
      return new Promise<void>((resolve) => Object.assign(window, { releaseFindFont: resolve })).then(() => load.call(this));
    };
    window.photoStudio.command('Unloaded first layer', (d) => {
      d.layers[0].textData!.content.paragraphs[0].runs[0].style.family = 'Caveat';
    });
  });
  await page.evaluate(() => window.photoStudio.runCommand('edit.check-spelling'));
  const dlg = page.locator('dialog.sp-workspace');
  await expect(dlg.locator('#sp-word')).toHaveText('wrod');
  await dlg.locator('#sp-change').fill('words');
  await dlg.getByRole('button', { name: 'Change All' }).click();
  await page.waitForFunction(() => !!(window as unknown as { releaseFindFont?: () => void }).releaseFindFont);
  for (const word of ['wrod', 'teh', 'wrod']) {
    await expect(dlg.locator('#sp-word')).toHaveText(word);
    await dlg.getByRole('button', { name: 'Ignore', exact: true }).click();
  }
  await expect(dlg.locator('#sp-status')).toHaveText('Spell check complete.');
  await page.evaluate(async () => {
    (window as unknown as { releaseFindFont(): void }).releaseFindFont();
    await (await import('/src/imaging/text/fonts.ts')).ensureFont('Caveat');
  });
  await idle(page);
  expect(await layerTexts(page)).toEqual(['words', 'words teh']);
  await expect(dlg.locator('#sp-status')).toHaveText('Spell check complete.');
  await run(page, 'edit.undo');
  expect(await layerTexts(page)).toEqual(['wrod', 'wrod teh']);
  await run(page, 'edit.redo');
  expect(await layerTexts(page)).toEqual(['words', 'words teh']);
});

for (const reverse of [false, true]) test(`Find opens with the ${reverse ? 'backward' : 'forward'} text selection as its query`, async ({ page }) => {
  await boot(page);
  await textDoc(page, ['first dog dog']);
  await page.evaluate(async (reverse) => {
    const e = window.photoStudio;
    const m = (window as unknown as { photoStudioType: typeof import('../../src/features/type/session') }).photoStudioType;
    e.setTool('type');
    await m.startEdit(e, e.doc.layers[0].id, 'end');
    m.setSelection(e, reverse ? 9 : 6, reverse ? 6 : 9);
    Object.assign(window, { editBeforeFind: m.currentSession() });
  }, reverse);
  await page.evaluate(() => window.photoStudio.runCommand('edit.find-replace-text'));
  const dlg = page.locator('dialog.fr-workspace');
  expect(await dlg.locator('#fr-find').inputValue()).toBe('dog');
  expect(await page.evaluate(() => (window as unknown as { photoStudioType: typeof import('../../src/features/type/session') }).photoStudioType.currentSession() === (window as unknown as { editBeforeFind: unknown }).editBeforeFind)).toBe(true);
  await dlg.locator('#fr-change').fill('cat');
  await dlg.getByRole('button', { name: 'Change', exact: true }).click();
  await run(page, 'type.commit');
  expect(await layerTexts(page)).toEqual(['first cat dog']);
  await run(page, 'edit.undo');
  expect(await layerTexts(page)).toEqual(['first dog dog']);
  await run(page, 'edit.redo');
  expect(await layerTexts(page)).toEqual(['first cat dog']);
});

for (const action of ['Done', 'Change', 'Change All']) test(`Find preserves draft text and undo before ${action}`, async ({ page }) => {
  await boot(page);
  await textDoc(page, ['first dog']);
  await page.evaluate(async () => {
    const e = window.photoStudio;
    e.setTool('type');
    await (window as unknown as { photoStudioType: typeof import('../../src/features/type/session') }).photoStudioType.startEdit(e, e.doc.layers[0].id, 'end');
  });
  await page.keyboard.insertText(' dog');
  const history = await page.evaluate(() => {
    const e = window.photoStudio;
    const m = (window as unknown as { photoStudioType: typeof import('../../src/features/type/session') }).photoStudioType;
    m.setSelection(e, 10, 13);
    return e.history.labels;
  });
  if (action === 'Done') {
    await page.getByRole('menubar').getByRole('menuitem', { name: 'Edit', exact: true }).click();
    await page.locator('.menubar-entry.open > .menu-pop > .menu-item').filter({ has: page.locator(':scope > .menu-label', { hasText: 'Find and Replace Text' }) }).first().click();
  } else await page.evaluate(() => window.photoStudio.runCommand('edit.find-replace-text'));
  const dlg = page.locator('dialog.fr-workspace');
  await expect(dlg.locator('#fr-find')).toHaveValue('dog');
  expect(await page.evaluate(() => window.photoStudio.history.labels)).toEqual(history);
  if (action === 'Done') {
    await dlg.getByRole('button', { name: 'Done' }).click();
    await run(page, 'type.cancel');
    expect(await layerTexts(page)).toEqual(['first dog']);
    expect(await page.evaluate(() => window.photoStudio.history.labels)).toEqual(history);
    return;
  }
  await dlg.locator('#fr-change').fill('cat');
  await dlg.getByRole('button', { name: action, exact: true }).click();
  await idle(page);
  if (action === 'Change') {
    expect(await layerTexts(page)).toEqual(['first dog cat']);
    await run(page, 'edit.undo');
    expect(await layerTexts(page)).toEqual(['first dog dog']);
    await run(page, 'edit.undo');
    expect(await layerTexts(page)).toEqual(['first dog']);
    await run(page, 'edit.redo');
    await run(page, 'edit.redo');
    expect(await layerTexts(page)).toEqual(['first dog cat']);
    expect(await page.evaluate(() => window.photoStudio.history.labels)).toEqual(history);
    await run(page, 'type.commit');
  } else {
    expect(await layerTexts(page)).toEqual(['first cat cat']);
    expect(await page.evaluate(() => window.photoStudio.history.labels.length)).toBe(history.length + 2);
    await run(page, 'edit.undo');
    expect(await layerTexts(page)).toEqual(['first dog dog']);
    await run(page, 'edit.undo');
    expect(await layerTexts(page)).toEqual(['first dog']);
    await run(page, 'edit.redo');
    await run(page, 'edit.redo');
    expect(await layerTexts(page)).toEqual(['first cat cat']);
  }
});

for (const selection of ['caret', 'multiple lines']) test(`Find retains the saved query for a ${selection} selection`, async ({ page }) => {
  await boot(page);
  await textDoc(page, ['first\nsecond']);
  await page.evaluate(() => window.photoStudio.runCommand('edit.find-replace-text'));
  const dlg = page.locator('dialog.fr-workspace');
  await dlg.locator('#fr-find').fill('saved query');
  await dlg.getByRole('button', { name: 'Done' }).click();
  await page.evaluate(async (selection) => {
    const e = window.photoStudio;
    e.setTool('type');
    await (window as unknown as { photoStudioType: typeof import('../../src/features/type/session') }).photoStudioType.startEdit(e, e.doc.layers[0].id, selection === 'caret' ? 'end' : 'all');
  }, selection);
  await page.evaluate(() => window.photoStudio.runCommand('edit.find-replace-text'));
  await expect(dlg.locator('#fr-find')).toHaveValue('saved query');
  expect(await page.evaluate(() => !!(window as unknown as { photoStudioType: typeof import('../../src/features/type/session') }).photoStudioType.currentSession())).toBe(true);
  await dlg.getByRole('button', { name: 'Done' }).click();
  await run(page, 'type.cancel');
  expect(await layerTexts(page)).toEqual(['first\nsecond']);
});

test('opening Find on newly typed text leaves the new layer cancellable', async ({ page }) => {
  await boot(page);
  await textDoc(page, []);
  await page.evaluate(async () => {
    const e = window.photoStudio;
    e.setTool('type');
    await (window as unknown as { photoStudioType: typeof import('../../src/features/type/session') }).photoStudioType.startNew(e, { x: 40, y: 80, vertical: false, mask: false });
  });
  await page.keyboard.insertText('dog');
  await page.evaluate(() => {
    const m = (window as unknown as { photoStudioType: typeof import('../../src/features/type/session') }).photoStudioType;
    m.setSelection(window.photoStudio, 0, 3);
  });
  await page.evaluate(() => window.photoStudio.runCommand('edit.find-replace-text'));
  const dlg = page.locator('dialog.fr-workspace');
  await expect(dlg.locator('#fr-find')).toHaveValue('dog');
  await dlg.getByRole('button', { name: 'Done' }).click();
  await run(page, 'type.cancel');
  expect(await layerTexts(page)).toEqual([]);
  expect(await page.evaluate(() => window.photoStudio.history.labels)).toEqual([]);
});

for (const sharedId of [false, true]) test(`bulk spelling completion preserves another document${sharedId ? ' with matching layer IDs' : ''}`, async ({ page }) => {
  await boot(page);
  await openImage(page, 240, 160, '#ffffff', 'other.png');
  const other = await page.evaluate(() => window.photoStudio.session.id);
  await openImage(page, 240, 160, '#ffffff', 'original.png');
  await textDoc(page, ['teh']);
  const original = await page.evaluate(() => window.photoStudio.session.id);
  await page.evaluate(async ({ other, sharedId }) => {
    const e = window.photoStudio;
    const { textLayer } = await import('/src/imaging/text/model.ts');
    const l = e.doc.layers[0];
    const s = e.sessions.find((s) => s.id === other)!;
    s.history.reset({ ...s.doc, layers: [{ ...l, id: sharedId ? l.id : crypto.randomUUID(), name: 'Other', text: 'teh other', textData: textLayer('teh other', { family: 'Inter' }) }] });
    const load = FontFace.prototype.load;
    FontFace.prototype.load = function () {
      if (!this.family.includes('Caveat')) return load.call(this);
      FontFace.prototype.load = load;
      return new Promise<void>((resolve) => Object.assign(window, { releaseFindFont: resolve })).then(() => load.call(this));
    };
    e.command('Unloaded font', (d) => { d.layers[0].textData!.content.paragraphs[0].runs[0].style.family = 'Caveat'; });
  }, { other, sharedId });
  await page.evaluate(() => window.photoStudio.runCommand('edit.check-spelling'));
  const dlg = page.locator('dialog.sp-workspace');
  await expect(dlg.locator('#sp-word')).toHaveText('teh');
  await dlg.getByRole('button', { name: 'Change All' }).click();
  await page.waitForFunction(() => !!(window as unknown as { releaseFindFont?: () => void }).releaseFindFont);
  await page.locator(`.document-tab[data-session="${other}"]`).click();
  await page.evaluate(async () => {
    const e = window.photoStudio;
    e.setTool('type');
    await (window as unknown as { photoStudioType: typeof import('../../src/features/type/session') }).photoStudioType.startEdit(e, e.doc.layers[0].id, 'end');
  });
  await dlg.locator('#sp-change').fill('custom');
  await page.evaluate(async () => {
    (window as unknown as { releaseFindFont(): void }).releaseFindFont();
    await (await import('/src/imaging/text/fonts.ts')).ensureFont('Caveat');
  });
  await expect.poll(() => page.evaluate((original) => window.photoStudio.sessions.find((s) => s.id === original)!.doc.layers[0].text, original)).toBe('the');
  await idle(page);
  expect(await page.evaluate(() => {
    const s = (window as unknown as { photoStudioType: typeof import('../../src/features/type/session') }).photoStudioType.currentSession()!;
    return [s.anchor, s.focus];
  })).toEqual([9, 9]);
  await expect(dlg.locator('#sp-change')).toHaveValue('custom');
  await expect(dlg.locator('#sp-change')).toBeFocused();
  await page.locator('textarea.type-input').focus();
  await page.keyboard.insertText(' more');
  await run(page, 'type.commit');
  expect(await layerTexts(page)).toEqual(['teh other more']);
  await run(page, 'edit.undo');
  expect(await layerTexts(page)).toEqual(['teh other']);
  await run(page, 'edit.redo');
  expect(await layerTexts(page)).toEqual(['teh other more']);
  await page.locator(`.document-tab[data-session="${original}"]`).click();
  await run(page, 'edit.undo');
  expect(await layerTexts(page)).toEqual(['teh']);
  await run(page, 'edit.redo');
  expect(await layerTexts(page)).toEqual(['the']);
});

for (const action of ['Change', 'Change All']) for (const correction of ['the', 'these', 'a']) test(`bulk spelling completion preserves a newer spelling result for ${action} after '${correction}'`, async ({ page }) => {
  await boot(page);
  await textDoc(page, ['teh', 'teh wrod wrod']);
  await page.evaluate(() => {
    const load = FontFace.prototype.load;
    FontFace.prototype.load = function () {
      if (!this.family.includes('Caveat')) return load.call(this);
      FontFace.prototype.load = load;
      return new Promise<void>((resolve) => Object.assign(window, { releaseFindFont: resolve })).then(() => load.call(this));
    };
    window.photoStudio.command('Unloaded first layer', (d) => { d.layers[0].textData!.content.paragraphs[0].runs[0].style.family = 'Caveat'; });
  });
  await page.evaluate(() => window.photoStudio.runCommand('edit.check-spelling'));
  const dlg = page.locator('dialog.sp-workspace');
  await expect(dlg.locator('#sp-word')).toHaveText('teh');
  await dlg.locator('#sp-change').fill(correction);
  await dlg.getByRole('button', { name: 'Change All' }).click();
  await page.waitForFunction(() => !!(window as unknown as { releaseFindFont?: () => void }).releaseFindFont);
  await dlg.getByRole('button', { name: 'Ignore', exact: true }).click();
  await expect(dlg.locator('#sp-word')).toHaveText('wrod');
  await dlg.locator('#sp-change').fill('custom');
  const selection = () => page.evaluate(() => {
    const s = (window as unknown as { photoStudioType: typeof import('../../src/features/type/session') }).photoStudioType.currentSession()!;
    return [s.anchor, s.focus];
  });
  expect(await selection()).toEqual([4, 8]);
  await page.evaluate(async () => {
    (window as unknown as { releaseFindFont(): void }).releaseFindFont();
    await (await import('/src/imaging/text/fonts.ts')).ensureFont('Caveat');
  });
  await expect.poll(() => layerTexts(page)).toEqual([correction, `${correction} wrod wrod`]);
  await idle(page);
  expect(await selection()).toEqual([correction.length + 1, correction.length + 5]);
  await expect(dlg.locator('#sp-change')).toHaveValue('custom');
  await expect(dlg.locator('#sp-change')).toBeFocused();
  await dlg.getByRole('button', { name: action, exact: true }).click();
  const changed = [correction, `${correction} custom ${action === 'Change All' ? 'custom' : 'wrod'}`];
  await expect.poll(() => layerTexts(page)).toEqual(changed);
  await run(page, 'edit.undo');
  expect(await layerTexts(page)).toEqual([correction, `${correction} wrod wrod`]);
  await run(page, 'edit.redo');
  expect(await layerTexts(page)).toEqual(changed);
  await run(page, 'type.commit');
  expect(await layerTexts(page)).toEqual(changed);
});

for (const phase of ['initial search', 'next word']) test(`single spelling Change applies a custom correction during ${phase} font loading`, async ({ page }) => {
  await boot(page);
  await textDoc(page, phase === 'initial search' ? ['teh'] : ['wrod', 'teh']);
  await page.evaluate(() => {
    const load = FontFace.prototype.load;
    FontFace.prototype.load = function () {
      if (!this.family.includes('Caveat')) return load.call(this);
      FontFace.prototype.load = load;
      return new Promise<void>((resolve) => Object.assign(window, { releaseFindFont: resolve })).then(() => load.call(this));
    };
    window.photoStudio.command('Unloaded first layer', (d) => { d.layers[0].textData!.content.paragraphs[0].runs[0].style.family = 'Caveat'; });
  });
  await page.evaluate(() => window.photoStudio.runCommand('edit.check-spelling'));
  const dlg = page.locator('dialog.sp-workspace');
  if (phase === 'next word') {
    await expect(dlg.locator('#sp-word')).toHaveText('teh');
    await dlg.getByRole('button', { name: 'Change', exact: true }).click();
  }
  await expect(dlg.locator('#sp-word')).toHaveText(phase === 'initial search' ? 'teh' : 'wrod');
  await page.waitForFunction(() => !!(window as unknown as { releaseFindFont?: () => void }).releaseFindFont);
  await dlg.locator('#sp-change').fill('custom');
  await dlg.getByRole('button', { name: 'Change', exact: true }).click();
  const corrected = phase === 'initial search' ? ['custom'] : ['custom', 'the'];
  expect(await layerTexts(page)).toEqual(corrected);
  await expect(dlg.locator('#sp-status')).toHaveText('Spell check complete.');
  await page.evaluate(async () => {
    (window as unknown as { releaseFindFont(): void }).releaseFindFont();
    await (await import('/src/imaging/text/fonts.ts')).ensureFont('Caveat');
  });
  await idle(page);
  expect(await layerTexts(page)).toEqual(corrected);
  await expect(dlg.locator('#sp-status')).toHaveText('Spell check complete.');
  await run(page, 'type.commit');
  await run(page, 'edit.undo');
  expect(await layerTexts(page)).toEqual(phase === 'initial search' ? ['teh'] : ['wrod', 'the']);
  await run(page, 'edit.redo');
  expect(await layerTexts(page)).toEqual(corrected);
});

for (const ending of ['cancel', 'commit', 'lock']) test(`pending single spelling corrections respect ${ending} before font arrival`, async ({ page }) => {
  await boot(page);
  await textDoc(page, ['teh teh']);
  await page.evaluate(() => {
    const load = FontFace.prototype.load;
    FontFace.prototype.load = function () {
      if (!this.family.includes('Caveat')) return load.call(this);
      FontFace.prototype.load = load;
      return new Promise<void>((resolve) => Object.assign(window, { releaseFindFont: resolve })).then(() => load.call(this));
    };
    window.photoStudio.command('Unloaded font', (d) => { d.layers[0].textData!.content.paragraphs[0].runs[0].style.family = 'Caveat'; });
  });
  await page.evaluate(() => window.photoStudio.runCommand('edit.check-spelling'));
  const dlg = page.locator('dialog.sp-workspace');
  await expect(dlg.locator('#sp-word')).toHaveText('teh');
  await page.waitForFunction(() => !!(window as unknown as { releaseFindFont?: () => void }).releaseFindFont);
  if (ending === 'lock') await page.evaluate(() => window.photoStudio.command('Lock text', (d) => { d.layers[0].locked = true; }));
  const history = await page.evaluate(() => window.photoStudio.history.labels);
  await dlg.getByRole('button', { name: 'Change', exact: true }).click();
  if (ending === 'lock') {
    await expect(dlg.locator('#sp-status')).toContainText('locked');
    expect(await layerTexts(page)).toEqual(['teh teh']);
  } else {
    expect(await layerTexts(page)).toEqual(['the teh']);
    await dlg.locator('#sp-change').fill('custom');
    await dlg.getByRole('button', { name: 'Change', exact: true }).click();
    expect(await layerTexts(page)).toEqual(['the custom']);
    await expect(dlg.locator('#sp-status')).toHaveText('Spell check complete.');
    await run(page, 'edit.undo');
    expect(await layerTexts(page)).toEqual(['the teh']);
    await run(page, 'edit.redo');
    expect(await layerTexts(page)).toEqual(['the custom']);
    await run(page, ending === 'cancel' ? 'type.cancel' : 'type.commit');
  }
  await dlg.getByRole('button', { name: 'Done' }).click();
  await page.evaluate(async () => {
    (window as unknown as { releaseFindFont(): void }).releaseFindFont();
    await (await import('/src/imaging/text/fonts.ts')).ensureFont('Caveat');
  });
  await idle(page);
  expect(await layerTexts(page)).toEqual([ending === 'commit' ? 'the custom' : 'teh teh']);
  expect(await page.evaluate(() => !!(window as unknown as { photoStudioType: typeof import('../../src/features/type/session') }).photoStudioType.currentSession())).toBe(false);
  if (ending === 'commit') {
    await run(page, 'edit.undo');
    expect(await layerTexts(page)).toEqual(['teh teh']);
    await run(page, 'edit.redo');
    expect(await layerTexts(page)).toEqual(['the custom']);
  } else expect(await page.evaluate(() => window.photoStudio.history.labels)).toEqual(history);
});

for (const input of ['typing', 'arrow', 'IME']) for (const dialog of ['Find', 'Spelling']) test(`early ${input} in a pending ${dialog} result survives font arrival`, async ({ page }) => {
  await boot(page);
  await textDoc(page, ['prefix teh suffix']);
  await page.evaluate(() => {
    const load = FontFace.prototype.load;
    FontFace.prototype.load = function () {
      if (!this.family.includes('Caveat')) return load.call(this);
      FontFace.prototype.load = load;
      return new Promise<void>((resolve) => Object.assign(window, { releaseFindFont: resolve })).then(() => load.call(this));
    };
    window.photoStudio.command('Unloaded font', (d) => { d.layers[0].textData!.content.paragraphs[0].runs[0].style.family = 'Caveat'; });
  });
  await page.evaluate((dialog) => window.photoStudio.runCommand(dialog === 'Find' ? 'edit.find-replace-text' : 'edit.check-spelling'), dialog);
  if (dialog === 'Find') {
    const dlg = page.locator('dialog.fr-workspace');
    await dlg.locator('#fr-find').fill('teh');
    await dlg.getByRole('button', { name: 'Find Next' }).click();
  }
  await page.waitForFunction(() => !!(window as unknown as { releaseFindFont?: () => void }).releaseFindFont);
  await expect(page.locator('textarea.type-input')).toBeFocused();
  const cdp = input === 'IME' ? await page.context().newCDPSession(page) : undefined;
  if (input === 'IME') await cdp!.send('Input.imeSetComposition', { text: 'にほん', selectionStart: 3, selectionEnd: 3 });
  else if (input === 'arrow') await page.keyboard.press('ArrowLeft');
  else await page.keyboard.insertText('custom');
  expect(await layerTexts(page)).toEqual([input === 'IME' ? 'prefix にほん suffix' : input === 'arrow' ? 'prefix teh suffix' : 'prefix custom suffix']);
  await page.evaluate(async () => {
    (window as unknown as { releaseFindFont(): void }).releaseFindFont();
    await (await import('/src/imaging/text/fonts.ts')).ensureFont('Caveat');
  });
  await idle(page);
  expect(await page.evaluate(() => {
    const s = (window as unknown as { photoStudioType: typeof import('../../src/features/type/session') }).photoStudioType.currentSession()!;
    return [s.anchor, s.focus];
  })).toEqual(input === 'IME' ? [10, 10] : input === 'arrow' ? [7, 7] : [13, 13]);
  await expect(page.locator('textarea.type-input')).toBeFocused();
  if (input === 'IME') {
    expect(await page.evaluate(() => !!(window as unknown as { photoStudioType: typeof import('../../src/features/type/session') }).photoStudioType.currentSession()!.composing)).toBe(true);
    await cdp!.send('Input.insertText', { text: '日本' });
  }
  await page.keyboard.insertText('X');
  const changed = input === 'IME' ? 'prefix 日本X suffix' : input === 'arrow' ? 'prefix Xteh suffix' : 'prefix customX suffix';
  await run(page, 'type.commit');
  expect(await layerTexts(page)).toEqual([changed]);
  await run(page, 'edit.undo');
  expect(await layerTexts(page)).toEqual(['prefix teh suffix']);
  await run(page, 'edit.redo');
  expect(await layerTexts(page)).toEqual([changed]);
});

for (const key of ['Enter', 'Space']) for (const button of ['Done', 'Change', 'Change/Find', 'Change All', 'Find Next']) test(`${key} activates the focused Find ${button} button`, async ({ page }) => {
  await boot(page);
  await textDoc(page, ['dog dog']);
  await page.evaluate(() => window.photoStudio.runCommand('edit.find-replace-text'));
  const dlg = page.locator('dialog.fr-workspace');
  await dlg.locator('#fr-find').fill('dog');
  await dlg.locator('#fr-change').fill('cat');
  await dlg.getByRole('button', { name: 'Find Next', exact: true }).click();
  await expect(dlg.locator('#fr-status')).toContainText('Found in');
  const target = dlg.getByRole('button', { name: button, exact: true });
  await target.evaluate((el) => {
    const w = window as unknown as { findButtonClicks: number };
    w.findButtonClicks = 0;
    el.addEventListener('click', () => { w.findButtonClicks++; });
  });
  await target.focus();
  await page.keyboard.press(key);
  const expected = button === 'Change All' ? 'cat cat' : button.startsWith('Change') ? 'cat dog' : 'dog dog';
  if (button === 'Done') await expect(dlg).toHaveCount(0, { timeout: 5000 });
  await expect.poll(() => layerTexts(page), { timeout: 5000 }).toEqual([expected]);
  expect(await page.evaluate(() => (window as unknown as { findButtonClicks: number }).findButtonClicks)).toBe(1);
  if (button !== 'Done' && button !== 'Change All') await expect(target).toBeFocused();
  if (button === 'Find Next' || button === 'Change/Find') {
    await expect.poll(() => page.evaluate(() => {
      const s = (window as unknown as { photoStudioType: typeof import('../../src/features/type/session') }).photoStudioType.currentSession()!;
      return [s.anchor, s.focus];
    })).toEqual([4, 7]);
  }
  if (button.startsWith('Change')) {
    await run(page, 'edit.undo');
    expect(await layerTexts(page)).toEqual(['dog dog']);
    await run(page, 'edit.redo');
    expect(await layerTexts(page)).toEqual([expected]);
  }
});

for (const field of ['#fr-find', '#fr-change']) test(`Enter in Find field ${field} searches without changing canvas text`, async ({ page }) => {
  await boot(page);
  await textDoc(page, ['dog dog']);
  await page.evaluate(() => window.photoStudio.runCommand('edit.find-replace-text'));
  const dlg = page.locator('dialog.fr-workspace');
  await dlg.locator('#fr-find').fill('dog');
  await dlg.locator('#fr-change').fill('cat');
  for (const range of [[0, 3], [4, 7]]) {
    await dlg.locator(field).press('Enter');
    await expect(dlg.locator('#fr-status')).toContainText('Found in');
    await expect.poll(() => page.evaluate(() => {
      const s = (window as unknown as { photoStudioType: typeof import('../../src/features/type/session') }).photoStudioType.currentSession()!;
      return [s.anchor, s.focus];
    })).toEqual(range);
    expect(await layerTexts(page)).toEqual(['dog dog']);
  }
  await dlg.locator(field).press('Escape');
  await expect(dlg).toHaveCount(0);
  expect(await layerTexts(page)).toEqual(['dog dog']);
});

test('Find checkbox Space and Escape retain their native actions', async ({ page }) => {
  await boot(page);
  await textDoc(page, ['dog dog']);
  await page.evaluate(() => window.photoStudio.runCommand('edit.find-replace-text'));
  const dlg = page.locator('dialog.fr-workspace');
  await dlg.locator('#fr-find').fill('dog');
  await dlg.getByRole('button', { name: 'Find Next', exact: true }).click();
  await expect(dlg.locator('#fr-status')).toContainText('Found in');
  const checkbox = dlg.getByLabel('Case Sensitive');
  await checkbox.focus();
  await page.keyboard.press('Space');
  await expect(checkbox).toBeChecked();
  expect(await layerTexts(page)).toEqual(['dog dog']);
  expect(await page.evaluate(() => {
    const s = (window as unknown as { photoStudioType: typeof import('../../src/features/type/session') }).photoStudioType.currentSession()!;
    return [s.anchor, s.focus];
  })).toEqual([0, 3]);
  await page.keyboard.press('Escape');
  await expect(dlg).toHaveCount(0);
  expect(await layerTexts(page)).toEqual(['dog dog']);
});
