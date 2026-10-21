import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';

const root = 'tests/fixtures/empty-control-prompt-pointer/';
const reference = JSON.parse(readFileSync(root + 'reference.json'));
async function open(page, source, zoom = 1, readOnly = false) {
  await page.goto('/playground.html');
  await page.evaluate(async ({ bytes, zoom, readOnly }) => {
    const { DocxPackage } = await import('/src/engine/docx.js');
    const { CanvasEditor } = await import('/src/engine/canvas-editor.js');
    const host = document.createElement('div'); host.id = 'prompt-pointer';
    host.style.cssText = 'position:fixed;inset:0;overflow:auto;background:white;z-index:1000'; document.body.append(host);
    window.promptPackage = await DocxPackage.open(new Uint8Array(bytes)); window.promptErrors = [];
    window.promptEditor = new CanvasEditor(host, { ...window.promptPackage, readOnly, onError: e => window.promptErrors.push(e.message) });
    window.promptEditor.zoom = zoom; window.promptEditor.relayout();
  }, { bytes: [...readFileSync(root + source)], zoom, readOnly });
  return page.locator('#prompt-pointer textarea');
}
async function point(page, position, dx = 0) {
  return page.evaluate(async ({ position, dx }) => {
    const { caretRect } = await import('/src/engine/layout.js'), e = window.promptEditor;
    const c = caretRect(e.selectionLayout, position), r = e.canvases[c.page].getBoundingClientRect();
    return { x: r.left + (c.x + dx) * e.zoom, y: r.top + (c.y + c.height / 2) * e.zoom };
  }, { position, dx });
}
async function click(page, position, dx = 0) { const p = await point(page, position, dx); await page.mouse.click(p.x, p.y); }
async function save(page, info, name) {
  const bytes = new Uint8Array(await page.evaluate(async () => [...new Uint8Array(await window.promptEditor.export(window.promptPackage).arrayBuffer())]));
  writeFileSync(info.outputPath(name + '.docx'), bytes); return unzipSync(bytes);
}
for (const zoom of [1, 0.75]) for (const ref of reference.cases) test(`restored prompt ${ref.name} at zoom ${zoom} matches native replacement`, async ({ page }, info) => {
  for (const [name, hash] of [[ref.source, ref.sourceSha256], [ref.result, ref.resultSha256]])
    expect(createHash('sha256').update(readFileSync(root + name)).digest('hex')).toBe(hash);
  const input = await open(page, ref.source, zoom), original = await input.inputValue(), parts = unzipSync(readFileSync(root + ref.source));
  expect(await save(page, info, 'noedit')).toEqual(parts);
  await click(page, 1);
  expect(await page.evaluate(() => window.promptEditor.model.selection.controlCaret?.side)).toBe('inside');
  await click(page, ref.position, ref.dx);
  const restored = await input.inputValue();
  expect(restored.length).toBeGreaterThan(original.length);
  // Infer the native selected suffix from the saved replacement, not our hit-test algorithm.
  expect(await input.evaluate(e => [e.selectionStart, e.selectionEnd])).toEqual([1, ref.originalSelectionEnd + restored.length - original.length]);
  await page.keyboard.insertText(ref.marker); await expect(input).toHaveValue(ref.text.replaceAll('\v', '\n'));
  expect(await page.evaluate(async () => {
    const { contentControlRanges } = await import('/src/engine/content-controls.js');
    return { controls: contentControlRanges(window.promptEditor.model.paragraphs).length, text: window.promptEditor.model.text };
  })).toEqual({ controls: ref.controlCount, text: ref.text });
  const edited = await save(page, info, 'edited');
  for (const [name, bytes] of Object.entries(parts)) if (name !== 'word/document.xml') expect(edited[name]).toEqual(bytes);
  expect(await page.evaluate(async bytes => {
    const { DocxPackage } = await import('/src/engine/docx.js');
    const p = await DocxPackage.open(new Uint8Array(bytes));
    return p.paragraphs.map(p => p.runs.map(r => r.text).join('')).join('\n');
  }, [...readFileSync(info.outputPath('edited.docx'))])).toBe(ref.text);
  await input.press('Control+z'); await expect(input).toHaveValue(restored);
  await input.press('Control+z'); await expect(input).toHaveValue(original);
  expect(await save(page, info, 'undo')).toEqual(parts);
  await input.press('Control+y'); await input.press('Control+y'); await expect(input).toHaveValue(ref.text.replaceAll('\v', '\n'));
  expect(await page.evaluate(() => window.promptErrors)).toEqual([]);
});

test('a later ordinary click selects only the already restored prompt', async ({ page }) => {
  const input = await open(page, 'tail.docx');
  await click(page, 1); await click(page, 4, 100);
  await click(page, 0); await click(page, 2);
  await page.keyboard.insertText('Q'); await expect(input).toHaveValue('AQXYZ');
});

test('read-only exit never restores or mutates the empty control', async ({ page }, info) => {
  const input = await open(page, 'tail.docx', 1, true);
  await click(page, 1); await click(page, 4, 100);
  await expect(input).toHaveValue('AXYZ');
  expect(await page.evaluate(() => window.promptEditor.session.history.length)).toBe(0);
  expect(await save(page, info, 'readonly')).toEqual(unzipSync(readFileSync(root + 'tail.docx')));
});

for (const key of ['Control', 'Alt', 'Meta']) test(`${key} click retains the existing prompt-only selection`, async ({ page }) => {
  await open(page, 'tail.docx'); await click(page, 1);
  await page.keyboard.down(key);
  try { await click(page, 4, 100); } finally { await page.keyboard.up(key); }
  // On a Mac, Control+click is the secondary click: like a right-click past the line's end, it puts the caret there.
  const secondary = key === 'Control' && await page.evaluate(() => /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || ''));
  expect(await page.evaluate(() => window.promptEditor.model.range)).toEqual(secondary ? [4, 4] : [1, 360]);
});
