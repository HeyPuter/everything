import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { unzipSync } from 'fflate';

test('opens original rotated DOCX for editing and preserves its download after undo', async ({ page }, info) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/playground.html');
  await page.getByLabel('Open DOCX file').setInputFiles('tests/fixtures/cell-text-direction/control.docx');
  const input = page.getByRole('textbox', { name: 'Document text' });
  await expect(input).toHaveValue(/top-exact/);
  await expect(input).toHaveJSProperty('readOnly', false);
  await expect(page.locator('canvas.canvas-page')).toHaveCount(8);
  const before = await input.inputValue();
  await input.focus(); await page.keyboard.insertText('Editable');
  expect(await input.inputValue()).not.toBe(before);
  await input.press('Control+z');
  await expect(input).toHaveValue(before);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download .docx', exact: true }).click();
  const output = info.outputPath('original.docx'); await (await download).saveAs(output);
  expect(unzipSync(readFileSync(output))).toEqual(unzipSync(readFileSync('tests/fixtures/cell-text-direction/control.docx')));
  expect(errors).toEqual([]);
});

for (const name of ['control', 'automatic', 'mode15']) test(`paints and edits rotated model cells: ${name}`, async ({ page }, info) => {
  const bytes = readFileSync(`tests/fixtures/cell-text-direction/${name}.docx`).toString('base64');
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/playground.html');
  const before = await page.evaluate(async bytes => {
    const { DocxPackage } = await import('/src/engine/docx.js');
    const { CanvasEditor } = await import('/src/engine/canvas-editor.js');
    const { loadCanvasFonts } = await import('/src/engine/canvas-text.js');
    const { hitTest, caretRect, selectionRects } = await import('/src/engine/layout.js');
    const { cellTextPoint } = await import('/src/engine/cell-text-direction.js');
    const pkg = await DocxPackage.open(Uint8Array.from(atob(bytes), c => c.charCodeAt(0)));
    window.rotationPackage = pkg;
    await loadCanvasFonts(pkg);
    const host = document.createElement('div'); host.id = 'rotation-test'; document.body.append(host);
    window.rotationErrors = [];
    const editor = window.rotationEditor = new CanvasEditor(host, { ...pkg, onError: error => window.rotationErrors.push(String(error?.message || error)) });
    const checks = [];
    for (const physical of editor.layout.lines.filter(line => line.cellText)) {
      const { line, matrix } = physical.cellText, clip = physical.cellClip;
      for (const stop of line.stops.filter(stop => stop.offset > line.start && stop.offset < line.end)) {
        const point = cellTextPoint(matrix, stop.x, line.y + line.height / 2);
        if (point.x <= clip.left || point.x >= clip.right || point.y <= clip.top || point.y >= clip.bottom) continue;
        const caret = caretRect(editor.layout, stop.offset, 'forward', physical.page);
        const selection = selectionRects(editor.layout, stop.offset, stop.offset + 1);
        checks.push({ expected: stop.offset, actual: hitTest(editor.layout, physical.page, point.x, point.y), page: physical.page, point, caret, selection, clip });
      }
    }
    const rotatedIds = new Set(editor.layout.lines.filter(line => line.cellText).map(line => line.cellId));
    const ink = editor.layout.cells.filter(cell => rotatedIds.has(cell.id)).map(cell => {
      const canvas = editor.canvases[cell.page], scale = canvas.width / editor.layout.pages[cell.page].width;
      const pixels = canvas.getContext('2d').getImageData(Math.ceil((cell.x + 1) * scale), Math.ceil((cell.y + 1) * scale), Math.floor((cell.width - 2) * scale), Math.floor((cell.height - 2) * scale)).data;
      let dark = 0; for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 100 && pixels[i + 1] < 100 && pixels[i + 2] < 100) dark++;
      return dark;
    });
    // The ink readback can move Chrome to a different canvas raster path, which changes antialiasing
    // by a level on a few pixels. Capture the reference after it so the restored repaint uses the same path.
    editor.paint();
    const images = editor.canvases.map(canvas => canvas.toDataURL().split(',')[1]);
    const position = editor.layout.lines.find(line => line.cellText).start;
    const text = editor.model.text;
    editor.model.select(position, position); editor.focus();
    return { checks, images, ink, text, position };
  }, bytes);
  expect(before.checks.length).toBeGreaterThan(15);
  expect(before.ink.length).toBeGreaterThan(4);
  for (const count of before.ink) expect(count).toBeGreaterThan(5);
  for (const check of before.checks) {
    expect(check.actual).toBe(check.expected);
    expect(check.caret.width).toBeGreaterThan(check.caret.height);
    expect(check.caret.x).toBeGreaterThanOrEqual(check.clip.left);
    expect(check.caret.x + check.caret.width).toBeLessThanOrEqual(check.clip.right + 1e-6);
    expect(check.selection.length).toBeGreaterThan(0);
    for (const rect of check.selection) {
      expect(rect.x).toBeGreaterThanOrEqual(check.clip.left);
      expect(rect.y).toBeGreaterThanOrEqual(check.clip.top);
      expect(rect.x + rect.width).toBeLessThanOrEqual(check.clip.right + 1e-6);
      expect(rect.y + rect.height).toBeLessThanOrEqual(check.clip.bottom + 1e-6);
    }
  }
  before.images.forEach((png, index) => writeFileSync(info.outputPath(`page-${index + 1}.png`), Buffer.from(png, 'base64')));
  const clicked = before.checks[0];
  await page.locator('#rotation-test canvas.canvas-page').nth(clicked.page).click({ position: clicked.point });
  expect(await page.evaluate(() => window.rotationEditor.model.selection.focus)).toBe(clicked.expected);
  await page.locator('#rotation-test textarea').focus();
  await page.keyboard.insertText('X');
  expect(await page.evaluate(() => window.rotationErrors)).toEqual([]);
  expect(await page.evaluate(() => window.rotationEditor.model.text)).toBe(before.text.slice(0, clicked.expected) + 'X' + before.text.slice(clicked.expected));
  if (name === 'mode15') {
    const edited = await page.evaluate(async () => {
      const p = window.rotationPackage, d = window.rotationEditor.model;
      const bytes = new Uint8Array(await p.export(d.paragraphs, d.pageSettings, d.numbering, d.styles, d.tables, d.assets).arrayBuffer());
      const { DocxPackage } = await import('/src/engine/docx.js');
      const { TextDocument } = await import('/src/engine/model.js');
      const reopened = await DocxPackage.open(bytes);
      return { bytes: [...bytes], text: new TextDocument(reopened.paragraphs, reopened.pageSettings, reopened.numbering, reopened.styles, reopened.tables).text };
    });
    expect(edited.text).toBe(before.text.slice(0, clicked.expected) + 'X' + before.text.slice(clicked.expected));
    writeFileSync(info.outputPath('edited.docx'), Buffer.from(edited.bytes));
    const original = unzipSync(Buffer.from(bytes, 'base64')), parts = unzipSync(new Uint8Array(edited.bytes));
    expect(Object.keys(parts).sort()).toEqual(Object.keys(original).sort());
    for (const part of Object.keys(original)) if (part !== 'word/document.xml') expect(parts[part], part).toEqual(original[part]);
  }
  await page.locator('#rotation-test textarea').press('Control+z');
  expect(await page.evaluate(() => window.rotationEditor.model.text)).toBe(before.text);
  if (name === 'mode15') {
    const restored = await page.evaluate(async () => {
      const p = window.rotationPackage, d = window.rotationEditor.model;
      return [...new Uint8Array(await p.export(d.paragraphs, d.pageSettings, d.numbering, d.styles, d.tables, d.assets).arrayBuffer())];
    });
    writeFileSync(info.outputPath('undo.docx'), Buffer.from(restored));
    expect(unzipSync(new Uint8Array(restored))).toEqual(unzipSync(Buffer.from(bytes, 'base64')));
  }
  const restored = await page.evaluate(() => { const e = window.rotationEditor; e.input.blur(); e.paint(); return e.canvases.map(canvas => canvas.toDataURL().split(',')[1]); });
  expect(restored).toEqual(before.images);
  // Native reference keyboard checks: Up advances btLr; Down advances tbRl.
  // Exercise actual key dispatch, extension and selection collapse in
  // both rotations, without mistaking reference automation API selection calls for key input.
  for (const sign of [-1, 1]) {
    const sample = await page.evaluate(sign => {
      const e = window.rotationEditor;
      const line = e.layout.lines.find(line => line.cellText?.matrix[1] === sign);
      const position = line.start + 2;
      e.model.select(position, position); e.caretPage = line.page; e.caretAffinity = 'forward'; e.focus();
      return { position, text: e.model.text };
    }, sign);
    const forward = sign === -1 ? 'ArrowUp' : 'ArrowDown', backward = sign === -1 ? 'ArrowDown' : 'ArrowUp';
    const input = page.locator('#rotation-test textarea');
    await input.press(forward);
    expect(await page.evaluate(() => window.rotationEditor.model.selection.focus)).toBe(sample.position + 1);
    await input.press(`Shift+${forward}`);
    expect(await page.evaluate(() => window.rotationEditor.model.range)).toEqual([sample.position + 1, sample.position + 2]);
    await input.press(backward);
    expect(await page.evaluate(() => window.rotationEditor.model.range)).toEqual([sample.position + 1, sample.position + 1]);
    await input.press(backward);
    expect(await page.evaluate(() => window.rotationEditor.model.selection.focus)).toBe(sample.position);
    expect(await page.evaluate(() => window.rotationEditor.model.text)).toBe(sample.text);
  }
  expect(errors).toEqual([]);
  if (name === 'control') for (const sign of [-1, 1]) {
    const sample = await page.evaluate(sign => {
      const e = window.rotationEditor;
      const line = e.layout.lines.find(line => line.page === 3 && line.cellText?.matrix[1] === sign);
      e.model.select(line.start, line.start); e.caretAffinity = 'forward'; e.caretPage = line.page; e.preferredX = null; e.focus();
      return { start: line.start, cellId: line.cellId, text: e.model.text };
    }, sign);
    const forward = sign === -1 ? 'ArrowRight' : 'ArrowLeft', backward = sign === -1 ? 'ArrowLeft' : 'ArrowRight';
    const input = page.locator('#rotation-test textarea');
    await input.press(`Shift+${forward}`);
    const selected = await page.evaluate(() => { const e = window.rotationEditor; return e.model.text.slice(...e.model.range); });
    expect(selected).toBe('One two three four ');
    await input.press(`Shift+${backward}`);
    expect(await page.evaluate(() => window.rotationEditor.model.range)).toEqual([sample.start, sample.start]);
    await input.press(forward);
    await input.press(forward);
    await input.press(forward);
    await input.press(backward);
    await input.press(backward);
    await input.press(backward);
    expect(await page.evaluate(() => window.rotationEditor.model.selection.focus)).toBe(sample.start);
    expect(await page.evaluate(() => window.rotationEditor.model.text)).toBe(sample.text);
  }
});
