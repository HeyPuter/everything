import { test, expect, type Page } from '@playwright/test';
import { boot, idle, run } from './helpers';

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
