import { expect, test, type Page } from '@playwright/test';
import { boot, idle, openImage, run, tool } from './helpers';

type TypeModule = typeof import('../../src/features/type/session');

async function prepare(page: Page, secondFont = false) {
  await boot(page);
  await openImage(page, 240, 160, '#ffffff', 'other.png');
  const other = await page.evaluate(() => window.photoStudio.session.id);
  await openImage(page, 240, 160, '#ffffff', 'original.png');
  const original = await page.evaluate(() => window.photoStudio.session.id);
  await page.evaluate(async ({ other, secondFont }) => {
    const e = window.photoStudio;
    const { layer } = await import('/src/model/document.ts');
    const { textLayer } = await import('/src/imaging/text/model.ts');
    const l = layer('text', 'Original', 180, 80);
    l.text = 'Original';
    l.textData = textLayer('Original', { family: 'Inter' });
    e.command('Text fixture', (d) => { d.layers.push(l); });
    e.selectLayers([l.id]);
    const s = e.sessions.find((s) => s.id === other)!;
    s.history.reset({ ...s.doc, layers: [...s.doc.layers, { ...l, name: 'Other', text: 'Other', textData: textLayer('Other', { family: 'Inter' }) }] });
    s.saved = s.doc;
    const load = FontFace.prototype.load;
    const waiting = new Set(secondFont ? ['Caveat', 'Crimson Pro'] : ['Caveat']);
    FontFace.prototype.load = function () {
      const family = [...waiting].find((f) => this.family.includes(f));
      if (!family) return load.call(this);
      waiting.delete(family);
      if (!waiting.size) FontFace.prototype.load = load;
      return new Promise<void>((resolve) => Object.assign(window, { [family === 'Caveat' ? 'releaseStyleFont' : 'releaseNewStyleFont']: resolve })).then(() => load.call(this));
    };
  }, { other, secondFont });
  await tool(page, 'Horizontal Type Tool');
  await idle(page);
  return { original, other };
}
async function pickFont(page: Page) {
  await page.locator('#type-family').click();
  await page.locator('.type-font-picker [data-family="Caveat"]').click();
  await page.waitForFunction(() => !!(window as unknown as { releaseStyleFont?: () => void }).releaseStyleFont);
}
async function finishFont(page: Page) {
  await page.evaluate(async () => {
    (window as unknown as { releaseStyleFont(): void }).releaseStyleFont();
    const { ensureFont } = await import('/src/imaging/text/fonts.ts');
    await ensureFont('Caveat');
  });
  await idle(page);
}
async function state(page: Page) {
  return page.evaluate(() => window.photoStudio.sessions.map((s) => ({ id: s.id, text: s.doc.layers.at(-1)!.text, family: s.doc.layers.at(-1)!.textData?.content.paragraphs[0].runs[0].style.family, history: s.history.labels })));
}

test('a pending font choice preserves text committed while its download is delayed', async ({ page }) => {
  await prepare(page);
  await pickFont(page);
  await page.evaluate(async () => {
    const e = window.photoStudio;
    await (window as unknown as { photoStudioType: TypeModule }).photoStudioType.startEdit(e, e.selected!, 'all');
  });
  await expect(page.locator('textarea.type-input')).toBeFocused();
  await page.keyboard.insertText('New text');
  await run(page, 'type.commit');
  expect((await state(page)).at(-1)?.text).toBe('New text');
  await finishFont(page);
  expect((await state(page)).at(-1)).toMatchObject({ text: 'New text', family: 'Caveat' });
  await run(page, 'edit.undo');
  expect((await state(page)).at(-1)).toMatchObject({ text: 'New text', family: 'Inter' });
  await run(page, 'edit.undo');
  expect((await state(page)).at(-1)?.text).toBe('Original');
});

test('a pending font choice preserves later character and paragraph formatting', async ({ page }) => {
  await prepare(page);
  await pickFont(page);
  await page.locator('#type-size').fill('48');
  await page.locator('#type-size').press('Enter');
  await page.locator('.type-align[data-align="center"]').click();
  await idle(page);
  await finishFont(page);
  expect(await page.evaluate(() => {
    const p = window.photoStudio.doc.layers.at(-1)!.textData!.content.paragraphs[0];
    return { family: p.runs[0].style.family, size: p.runs[0].style.size, align: p.style.align };
  })).toEqual({ family: 'Caveat', size: 48, align: 'center' });
});

test('a pending font choice preserves newer text in every selected layer', async ({ page }) => {
  await prepare(page);
  await page.evaluate(() => {
    const e = window.photoStudio;
    const first = e.doc.layers.at(-1)!;
    const second = { ...structuredClone(first), id: crypto.randomUUID() };
    e.command('Second fixture', (d) => { d.layers.push(second); });
    e.selectLayers([first.id, second.id]);
  });
  await pickFont(page);
  await page.evaluate(async () => {
    const { textLayer } = await import('/src/imaging/text/model.ts');
    window.photoStudio.command('Update both texts', (d) => {
      d.layers.filter((l) => l.kind === 'text').forEach((l, i) => {
        l.text = `Updated ${i + 1}`;
        l.textData = textLayer(l.text, { family: 'Inter', size: 30 + i * 6 });
      });
    });
  });
  await finishFont(page);
  const texts = () => page.evaluate(() => window.photoStudio.doc.layers.filter((l) => l.kind === 'text').map((l) => ({ text: l.text, family: l.textData!.content.paragraphs[0].runs[0].style.family, size: l.textData!.content.paragraphs[0].runs[0].style.size })));
  expect(await texts()).toEqual([{ text: 'Updated 1', family: 'Caveat', size: 30 }, { text: 'Updated 2', family: 'Caveat', size: 36 }]);
  await run(page, 'edit.undo');
  expect(await texts()).toEqual([{ text: 'Updated 1', family: 'Inter', size: 30 }, { text: 'Updated 2', family: 'Inter', size: 36 }]);
});

test('rebasing a pending font edit does not restore a deleted layer', async ({ page }) => {
  await prepare(page);
  await pickFont(page);
  const before = await page.evaluate(() => {
    const e = window.photoStudio;
    e.command('Delete text', (d) => { d.layers.pop(); });
    return { layers: e.doc.layers.map((l) => l.id), history: e.history.labels };
  });
  await finishFont(page);
  expect(await page.evaluate(() => ({ layers: window.photoStudio.doc.layers.map((l) => l.id), history: window.photoStudio.history.labels }))).toEqual(before);
});

test('paragraph formatting follows text changes across successive font waits', async ({ page }) => {
  await prepare(page, true);
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { textLayer } = await import('/src/imaging/text/model.ts');
    e.command('Unloaded font fixture', (d) => { d.layers.at(-1)!.textData = textLayer('Original', { family: 'Caveat' }); });
    const m = (window as unknown as { photoStudioType: TypeModule }).photoStudioType;
    void m.applyParagraph(e, { align: 'center' }).then(() => Object.assign(window, { paragraphDone: true }));
  });
  await page.waitForFunction(() => !!(window as unknown as { releaseStyleFont?: () => void }).releaseStyleFont);
  await page.evaluate(async () => {
    const { textLayer } = await import('/src/imaging/text/model.ts');
    window.photoStudio.command('New font and words', (d) => {
      const l = d.layers.at(-1)!;
      l.text = 'Updated';
      l.textData = textLayer(l.text, { family: 'Crimson Pro' });
    });
    (window as unknown as { releaseStyleFont(): void }).releaseStyleFont();
    await (await import('/src/imaging/text/fonts.ts')).ensureFont('Caveat');
  });
  await page.waitForFunction(() => !!(window as unknown as { releaseNewStyleFont?: () => void }).releaseNewStyleFont);
  expect(await page.evaluate(() => !!(window as unknown as { paragraphDone?: boolean }).paragraphDone)).toBe(false);
  await page.evaluate(async () => {
    const { textLayer } = await import('/src/imaging/text/model.ts');
    window.photoStudio.command('Latest words', (d) => {
      const l = d.layers.at(-1)!;
      l.text = 'Latest';
      l.textData = textLayer(l.text, { family: 'Crimson Pro' });
    });
    (window as unknown as { releaseNewStyleFont(): void }).releaseNewStyleFont();
    await (await import('/src/imaging/text/fonts.ts')).ensureFont('Crimson Pro');
  });
  await page.waitForFunction(() => !!(window as unknown as { paragraphDone?: boolean }).paragraphDone);
  await idle(page);
  const text = () => page.evaluate(() => {
    const l = window.photoStudio.doc.layers.at(-1)!;
    const p = l.textData!.content.paragraphs[0];
    return { text: l.text, family: p.runs[0].style.family, align: p.style.align };
  });
  expect(await text()).toEqual({ text: 'Latest', family: 'Crimson Pro', align: 'center' });
  await run(page, 'edit.undo');
  expect(await text()).toEqual({ text: 'Latest', family: 'Crimson Pro', align: 'left' });
});

for (const editing of [false, true]) test(`a newer font choice wins while ${editing ? 'editing text' : 'a text layer is selected'}`, async ({ page }) => {
  await prepare(page);
  if (editing) await page.evaluate(async () => {
    const e = window.photoStudio;
    await (window as unknown as { photoStudioType: TypeModule }).photoStudioType.startEdit(e, e.selected!, 'all');
  });
  await pickFont(page);
  await page.locator('#type-family').click();
  await page.locator('.type-font-picker [data-family="Inter"]').click();
  await finishFont(page);
  if (editing) await run(page, 'type.commit');
  expect((await state(page)).at(-1)?.family).toBe('Inter');
});

for (const first of ['older', 'newer']) test(`the latest font choice wins when the ${first} download finishes first`, async ({ page }) => {
  await prepare(page, true);
  await pickFont(page);
  await page.locator('#type-family').click();
  await page.locator('.type-font-picker [data-family="Crimson Pro"]').click();
  await page.waitForFunction(() => !!(window as unknown as { releaseNewStyleFont?: () => void }).releaseNewStyleFont);
  const finishNew = async () => {
    await page.evaluate(async () => {
      (window as unknown as { releaseNewStyleFont(): void }).releaseNewStyleFont();
      await (await import('/src/imaging/text/fonts.ts')).ensureFont('Crimson Pro');
    });
    await idle(page);
  };
  if (first === 'older') {
    await finishFont(page);
    expect((await state(page)).at(-1)?.family).toBe('Inter');
    await finishNew();
  } else {
    await finishNew();
    await finishFont(page);
  }
  expect((await state(page)).at(-1)).toMatchObject({ family: 'Crimson Pro', history: ['Text fixture', 'Change Character Style'] });
  await run(page, 'edit.undo');
  expect((await state(page)).at(-1)?.family).toBe('Inter');
  await run(page, 'edit.redo');
  expect((await state(page)).at(-1)?.family).toBe('Crimson Pro');
});

test('repeating a pending font choice commits only the latest request', async ({ page }) => {
  await prepare(page);
  await pickFont(page);
  await pickFont(page);
  await finishFont(page);
  expect((await state(page)).at(-1)).toMatchObject({ family: 'Caveat', history: ['Text fixture', 'Change Character Style'] });
});

test('a newer font choice supersedes only overlapping selected layers', async ({ page }) => {
  await prepare(page);
  const second = await page.evaluate(() => {
    const e = window.photoStudio;
    const first = e.doc.layers.at(-1)!;
    const second = { ...structuredClone(first), id: crypto.randomUUID(), name: 'Second' };
    e.command('Second fixture', (d) => { d.layers.push(second); });
    e.selectLayers([first.id, second.id]);
    return second.id;
  });
  await pickFont(page);
  await page.evaluate((id) => window.photoStudio.selectLayers([id]), second);
  await page.locator('#type-family').click();
  await page.locator('.type-font-picker [data-family="Inter"]').click();
  await finishFont(page);
  expect(await page.evaluate(() => window.photoStudio.doc.layers.filter((l) => l.kind === 'text').map((l) => l.textData!.content.paragraphs[0].runs[0].style.family))).toEqual(['Caveat', 'Inter']);
});

test('font choices in another document do not supersede a matching layer ID', async ({ page }) => {
  const { original, other } = await prepare(page);
  await pickFont(page);
  await page.locator(`.document-tab[data-session="${other}"]`).click();
  await page.evaluate(() => {
    const e = window.photoStudio;
    e.selectLayers([e.doc.layers.at(-1)!.id]);
  });
  await page.locator('#type-family').click();
  await page.locator('.type-font-picker [data-family="Inter"]').click();
  await finishFont(page);
  const docs = await state(page);
  expect(docs.find((s) => s.id === original)?.family).toBe('Caveat');
  expect(docs.find((s) => s.id === other)?.family).toBe('Inter');
});

test('font choices stay on their text ranges while an earlier font is loading', async ({ page }) => {
  await prepare(page);
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const m = (window as unknown as { photoStudioType: TypeModule }).photoStudioType;
    await m.startEdit(e, e.selected!, 'all');
    m.setSelection(e, 0, 4);
  });
  await pickFont(page);
  await page.evaluate(() => {
    const m = (window as unknown as { photoStudioType: TypeModule }).photoStudioType;
    m.setSelection(window.photoStudio, 4, 8);
  });
  await page.locator('#type-family').click();
  await page.locator('.type-font-picker [data-family="Inter"]').click();
  await finishFont(page);
  await run(page, 'type.commit');
  expect(await page.evaluate(() => window.photoStudio.doc.layers.at(-1)!.textData!.content.paragraphs[0].runs.map((r) => [r.text, r.style.family]))).toEqual([['Orig', 'Caveat'], ['inal', 'Inter']]);
});

test('a font chosen during editing supersedes an earlier selected-layer font request', async ({ page }) => {
  await prepare(page);
  await pickFont(page);
  await page.evaluate(async () => {
    const e = window.photoStudio;
    await (window as unknown as { photoStudioType: TypeModule }).photoStudioType.startEdit(e, e.selected!, 'all');
  });
  await page.locator('#type-family').click();
  await page.locator('.type-font-picker [data-family="Inter"]').click();
  await expect(page.locator('textarea.type-input')).toBeFocused();
  await page.keyboard.insertText('New text');
  expect(await page.evaluate(() => (window as unknown as { photoStudioType: TypeModule }).photoStudioType.currentSession()!.data.content.paragraphs[0].runs.map((r) => r.text).join(''))).toBe('New text');
  await finishFont(page);
  await run(page, 'type.commit');
  expect((await state(page)).at(-1)).toMatchObject({ text: 'New text', family: 'Inter' });
});

test('a delayed font edit preserves later layer properties and their undo history', async ({ page }) => {
  await prepare(page);
  await pickFont(page);
  await page.evaluate(() => {
    window.photoStudio.command('Layer properties', (d) => {
      const l = d.layers.at(-1)!;
      l.name = 'Renamed while loading';
      l.opacity = 0.4;
      l.visible = false;
    });
  });
  await finishFont(page);
  const properties = () => page.evaluate(() => {
    const l = window.photoStudio.doc.layers.at(-1)!;
    return { name: l.name, opacity: l.opacity, visible: l.visible, family: l.textData!.content.paragraphs[0].runs[0].style.family };
  });
  const changed = { name: 'Renamed while loading', opacity: 0.4, visible: false };
  expect(await properties()).toEqual({ ...changed, family: 'Caveat' });
  await run(page, 'edit.undo');
  expect(await properties()).toEqual({ ...changed, family: 'Inter' });
  await run(page, 'edit.undo');
  expect(await properties()).toEqual({ name: 'Original', opacity: 1, visible: true, family: 'Inter' });
  await run(page, 'edit.redo');
  await run(page, 'edit.redo');
  expect(await properties()).toEqual({ ...changed, family: 'Caveat' });
});

test('a delayed font edit preserves later text translation, scale, and rotation', async ({ page }) => {
  await prepare(page);
  await page.evaluate(() => {
    window.photoStudio.command('Text frame fixture', (d) => {
      const l = d.layers.at(-1)!;
      l.textFrame = { x: 0, y: 0, width: 180, height: 80 };
    });
  });
  await pickFont(page);
  const expected = await page.evaluate(async () => {
    const e = window.photoStudio;
    e.command('Place text', (d) => {
      d.layers.at(-1)!.transform = { x: 31, y: 47, width: 216, height: 120, rotation: 27 };
    });
    const { textMatrix } = await import('/src/model/text-layer.ts');
    return textMatrix(e.doc.layers.at(-1)!);
  });
  await finishFont(page);
  const actual = await page.evaluate(async () => {
    const { textMatrix } = await import('/src/model/text-layer.ts');
    return textMatrix(window.photoStudio.doc.layers.at(-1)!);
  });
  actual.forEach((v, i) => expect(v).toBeCloseTo(expected[i], 8));
  expect((await state(page)).at(-1)?.family).toBe('Caveat');
});

test('a font chosen before switching tabs updates only its original document', async ({ page }) => {
  const { original, other } = await prepare(page);
  await pickFont(page);
  await page.locator(`.document-tab[data-session="${other}"]`).click();
  await finishFont(page);
  const docs = await state(page);
  expect(docs.find((s) => s.id === other)).toMatchObject({ text: 'Other', family: 'Inter', history: [] });
  expect(docs.find((s) => s.id === original)).toMatchObject({ text: 'Original', family: 'Caveat', history: ['Text fixture', 'Change Character Style'] });
  await page.locator(`.document-tab[data-session="${original}"]`).click();
  await run(page, 'edit.undo');
  expect((await state(page)).find((s) => s.id === original)?.family).toBe('Inter');
  await run(page, 'edit.redo');
  expect((await state(page)).find((s) => s.id === original)?.family).toBe('Caveat');
});

for (const departure of ['stay', 'switch back', 'close original', 'close other']) test(`a delayed font edit behaves correctly after ${departure}`, async ({ page }) => {
  const { original, other } = await prepare(page);
  await pickFont(page);
  if (departure === 'switch back') {
    await page.locator(`.document-tab[data-session="${other}"]`).click();
    await page.locator(`.document-tab[data-session="${original}"]`).click();
  } else if (departure === 'close original') {
    await page.locator('.document-tab.focused .tab-close').click();
    await page.locator('dialog[open]').getByRole('button', { name: 'Don’t Save', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.photoStudio.session.id)).toBe(other);
  } else if (departure === 'close other') {
    await page.locator(`.document-tab[data-session="${other}"] .tab-close`).click();
    await expect.poll(() => page.evaluate((id) => window.photoStudio.sessions.some((s) => s.id === id), other)).toBe(false);
  }
  await finishFont(page);
  const docs = await state(page);
  if (departure === 'close original') {
    expect(docs).toEqual([{ id: other, text: 'Other', family: 'Inter', history: [] }]);
  } else {
    expect(docs.find((s) => s.id === original)).toMatchObject({ text: 'Original', family: 'Caveat' });
    if (departure !== 'close other') expect(docs.find((s) => s.id === other)).toMatchObject({ text: 'Other', family: 'Inter', history: [] });
  }
});

test('one delayed font edit keeps every selected layer in its originating document', async ({ page }) => {
  const { original, other } = await prepare(page);
  await page.evaluate(({ other }) => {
    const e = window.photoStudio;
    const first = e.doc.layers.at(-1)!;
    const second = { ...structuredClone(first), id: crypto.randomUUID(), name: 'Second' };
    e.command('Second fixture', (d) => { d.layers.push(second); });
    e.selectLayers([first.id, second.id]);
    const s = e.sessions.find((s) => s.id === other)!;
    s.history.reset({ ...s.doc, layers: [...s.doc.layers, { ...structuredClone(s.doc.layers.at(-1)!), id: second.id }] });
  }, { other });
  await pickFont(page);
  await page.locator(`.document-tab[data-session="${other}"]`).click();
  await finishFont(page);
  expect(await page.evaluate(({ original, other }) => [original, other].map((id) => {
    const s = window.photoStudio.sessions.find((s) => s.id === id)!;
    return { families: s.doc.layers.filter((l) => l.textData).map((l) => l.textData!.content.paragraphs[0].runs[0].style.family), history: s.history.labels };
  }), { original, other })).toEqual([
    { families: ['Caveat', 'Caveat'], history: ['Text fixture', 'Second fixture', 'Change Character Style'] },
    { families: ['Inter', 'Inter'], history: [] },
  ]);
});

test('text style definitions and their layers stay together after a tab switch', async ({ page }) => {
  const { original, other } = await prepare(page);
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const m = (window as unknown as { photoStudioType: TypeModule }).photoStudioType;
    const { applyCharStyle, textLength } = await import('/src/imaging/text/model.ts');
    void m.editLayers(e, 'Style fixture', (d) => ({ ...d, content: applyCharStyle(d.content, 0, textLength(d.content), { family: 'Caveat', charStyle: 'heading' }) }), undefined, (d) => {
      d.textStyles = { character: [{ id: 'heading', name: 'Heading', style: { family: 'Caveat' } }], paragraph: [] };
    });
  });
  await page.waitForFunction(() => !!(window as unknown as { releaseStyleFont?: () => void }).releaseStyleFont);
  await page.locator(`.document-tab[data-session="${other}"]`).click();
  await finishFont(page);
  expect(await page.evaluate(({ original, other }) => [original, other].map((id) => {
    const s = window.photoStudio.sessions.find((s) => s.id === id)!;
    return { styles: s.doc.textStyles?.character.map((c) => c.name) ?? [], family: s.doc.layers.at(-1)!.textData!.content.paragraphs[0].runs[0].style.family };
  }), { original, other })).toEqual([{ styles: ['Heading'], family: 'Caveat' }, { styles: [], family: 'Inter' }]);
});
