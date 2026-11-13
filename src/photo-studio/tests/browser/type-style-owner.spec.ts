import { expect, test, type Page } from '@playwright/test';
import { boot, idle, openImage, run, tool } from './helpers';

type TypeModule = typeof import('../../src/features/type/session');

async function prepare(page: Page) {
  await boot(page);
  await openImage(page, 240, 160, '#ffffff', 'other.png');
  const other = await page.evaluate(() => window.photoStudio.session.id);
  await openImage(page, 240, 160, '#ffffff', 'original.png');
  const original = await page.evaluate(() => window.photoStudio.session.id);
  await page.evaluate(async ({ other }) => {
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
    FontFace.prototype.load = function () {
      if (!this.family.includes('Caveat')) return load.call(this);
      FontFace.prototype.load = load;
      return new Promise<void>((resolve) => Object.assign(window, { releaseStyleFont: resolve })).then(() => load.call(this));
    };
  }, { other });
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
