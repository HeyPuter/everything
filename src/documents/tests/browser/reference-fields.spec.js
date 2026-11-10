import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { unzipSync } from 'fflate';
import { downloadDocx } from './helpers/editor-tools.js';

test('REF refresh matches expected cached pixels and geometry at two zoom levels', async ({ page }) => {
  test.setTimeout(90000);
  await page.goto('/playground.html', { waitUntil: 'domcontentloaded' });
  const source = [...readFileSync('tests/fixtures/reference-fields/source.docx')];
  const expected = [...readFileSync('tests/fixtures/reference-fields/expected.docx')];
  const results = await page.evaluate(async ({ source, expected }) => {
    const { openCanvasDocument } = await import('/src/engine/open-document.js');
    const { CanvasEditor } = await import('/src/engine/canvas-editor.js');
    const { updateSequenceFields } = await import('/src/engine/field-update.js');
    const rendered = [];
    for (const [bytes, update] of [[source, true], [expected, false]]) {
      const { pkg, images } = await openCanvasDocument(new Uint8Array(bytes));
      const host = document.createElement('div'); document.body.append(host);
      const editor = new CanvasEditor(host, { ...pkg, images });
      const issues = [];
      if (update) editor.execute(() => updateSequenceFields(editor.model, { onIssue: issue => issues.push(issue) }));
      editor.model.select(0);
      const snapshots = [];
      for (const zoom of [1, .75]) {
        editor.setZoom(zoom);
        snapshots.push({ pixels: editor.canvases.map(c => c.toDataURL()),
          geometry: editor.layout.lines.map(l => ({ page: l.page, y: l.y, height: l.height, fragments: l.fragments.map(f => ({ text: f.text, x: f.x, width: f.width })) })) });
      }
      rendered.push({ text: editor.model.text, snapshots, issues: issues.map(i => i.message) });
      editor.destroy(); host.remove();
    }
    return rendered;
  }, { source, expected });
  expect(results[0].text).toBe('below\n  source text  \n  source text  \nabove\ncache');
  expect(results[0].snapshots).toEqual(results[1].snapshots);
  expect(results[0].issues).toHaveLength(1);
});

test('F9 updates supported REF fields, reports retained cache, and preserves undo/reopen', async ({ page }, info) => {
  test.setTimeout(90000);
  page.on('dialog', async dialog => { expect(dialog.type()).toBe('confirm'); await dialog.accept(); });
  const file = 'tests/fixtures/reference-fields/source.docx';
  await page.goto('/playground.html', { waitUntil: 'domcontentloaded' });
  const input = page.getByRole('textbox', { name: 'Document text' });
  const old = await input.elementHandle(); await page.getByLabel('Open DOCX file').setInputFiles(file);
  await expect.poll(() => old.evaluate(el => el.isConnected)).toBe(false);
  const original = await input.inputValue();
  await input.press('F9');
  const expected = 'below\n  source text  \n  source text  \nabove\ncache';
  await expect(input).toHaveValue(expected);
  await expect(page.getByText('This REF uses number switches for a paragraph whose number cannot be worked out here; its cached result is retained.', { exact: true })).toBeVisible();
  const event = page.waitForEvent('download'); await downloadDocx(page);
  const saved = info.outputPath('updated-ref.docx'); await (await event).saveAs(saved);
  await input.press('ControlOrMeta+z'); await expect(input).toHaveValue(original);
  const undoneEvent = page.waitForEvent('download'); await downloadDocx(page);
  expect(unzipSync(readFileSync(await (await undoneEvent).path()))).toEqual(unzipSync(readFileSync(file)));
  const previous = await input.elementHandle(); await page.getByLabel('Open DOCX file').setInputFiles(saved);
  await expect.poll(() => previous.evaluate(el => el.isConnected)).toBe(false);
  await expect(input).toHaveValue(expected);
  await expect(input).toHaveJSProperty('readOnly', false);
});
