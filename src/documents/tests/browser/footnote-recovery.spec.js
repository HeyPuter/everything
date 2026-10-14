import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { openReadOnlyPreview } from './helpers/preview.js';
import { downloadDocx } from './helpers/editor-tools.js';
import { unzipSync } from 'fflate';

const approximations = {
  ordinal: ['note numbers displayed as decimal'],
};
// Restarting and symbol numbering are supported: these open editable with their own numbers.
const supported = ['eachPage', 'eachSect', 'chicago', 'chicago-eachPage'];

for (const zoom of [1, .75]) test(`footnote numbering preview retains mixed content at zoom ${zoom}`, async ({ page }) => {
  test.setTimeout(120000);
  await page.goto('/playground.html', { waitUntil: 'domcontentloaded' });
  const inputs = Object.fromEntries(['continuous', ...Object.keys(approximations), ...supported].map(name => [name, [...readFileSync(`tests/fixtures/footnote-recovery/${name}.docx`)]]));
  const results = await page.evaluate(async ({ inputs, zoom }) => {
    const { openCanvasDocument } = await import('/src/engine/open-document.js');
    const { CanvasEditor } = await import('/src/engine/canvas-editor.js');
    const results = {};
    for (const [name, bytes] of Object.entries(inputs)) {
      const { pkg, images } = await openCanvasDocument(new Uint8Array(bytes));
      const host = document.createElement('div'); document.body.append(host);
      const errors = [];
      const editor = new CanvasEditor(host, { ...pkg, images, onError: e => errors.push(e.message) });
      editor.setZoom(zoom);
      results[name] = { readOnly: !!pkg.readOnly, issues: pkg.previewIssues, errors,
        pages: editor.canvases.length, tables: pkg.tables.length, images: images.size,
        notes: Object.values(pkg.pageStories.stories).filter(s => s.kind === 'footnote').length,
        text: editor.model.text, pixels: editor.canvases.map(c => c.toDataURL()),
        geometry: [...editor.layout.lines, ...editor.storyLayout.lines].map(l => ({ page: l.page, y: l.y, height: l.height,
          fragments: l.fragments.map(f => ({ text: f.text, x: f.x, width: f.width })) })) };
      editor.destroy(); host.remove();
    }
    return results;
  }, { inputs, zoom });
  const control = results.continuous;
  expect(control.readOnly).toBe(false);
  expect(control.pages).toBe(2);
  for (const name of supported) {
    const current = results[name];
    expect(current.readOnly, name).toBe(false);
    expect(current.errors).toEqual([]);
    expect(current.tables).toBe(1); expect(current.images).toBe(2); expect(current.notes).toBe(2);
    expect(current.text).toEqual(control.text);
  }
  for (const [name, warnings] of Object.entries(approximations)) {
    const current = results[name];
    expect(current.readOnly).toBe(true);
    for (const warning of warnings) expect(current.issues.join(' ')).toContain(warning);
    expect(current.errors).toEqual([]);
    expect(current.tables).toBe(1); expect(current.images).toBe(2); expect(current.notes).toBe(2);
    expect(current.text).toEqual(control.text);
    expect(current.geometry).toEqual(control.geometry);
    expect(current.pixels).toEqual(control.pixels);
    await openReadOnlyPreview(page, `tests/fixtures/footnote-recovery/${name}.docx`);
    await page.locator('.canvas-message summary').click();
    for (const warning of warnings) await expect(page.locator('.canvas-message li').filter({ hasText: warning })).toHaveCount(1);
  }
});

test('continuous footnotes survive body editing, undo and reopening', async ({ page }, info) => {
  test.setTimeout(90000);
  page.on('dialog', async dialog => {
    expect(dialog.type()).toBe('confirm');
    expect(dialog.message()).toBe('Open another document? Download your current changes first if you want to keep them.');
    await dialog.accept();
  });
  const file = 'tests/fixtures/footnote-recovery/continuous.docx';
  await page.goto('/playground.html', { waitUntil: 'domcontentloaded' });
  const old = await page.getByRole('textbox', { name: 'Document text' }).elementHandle();
  await page.getByLabel('Open DOCX file').setInputFiles(file);
  await expect.poll(() => old.evaluate(el => el.isConnected)).toBe(false);
  const input = page.getByRole('textbox', { name: 'Document text' });
  await expect(input).toHaveJSProperty('readOnly', false);
  const originalText = await input.inputValue();
  await input.press('ControlOrMeta+Home'); await page.keyboard.insertText('Edited ');
  await expect(input).toHaveValue('Edited ' + originalText);
  const event = page.waitForEvent('download'); await downloadDocx(page);
  const saved = info.outputPath('edited-footnotes.docx'); await (await event).saveAs(saved);
  const originalParts = unzipSync(readFileSync(file)), savedParts = unzipSync(readFileSync(saved));
  expect(Object.keys(savedParts).sort()).toEqual(Object.keys(originalParts).sort());
  for (const [name, bytes] of Object.entries(originalParts)) if (name !== 'word/document.xml') expect(savedParts[name], name).toEqual(bytes);
  await input.press('ControlOrMeta+z'); await expect(input).toHaveValue(originalText);
  const undoneEvent = page.waitForEvent('download'); await downloadDocx(page);
  const undone = info.outputPath('undone-footnotes.docx'); await (await undoneEvent).saveAs(undone);
  expect(unzipSync(readFileSync(undone))).toEqual(originalParts);
  const previous = await input.elementHandle();
  await page.getByLabel('Open DOCX file').setInputFiles(saved);
  await expect.poll(() => previous.evaluate(el => el.isConnected)).toBe(false);
  await expect(input).toHaveValue('Edited ' + originalText);
  await expect(input).toHaveJSProperty('readOnly', false);
  await expect(page.locator('.canvas-message-error')).toHaveCount(0);
  await expect(page.locator('canvas.canvas-page')).toHaveCount(2);
});
