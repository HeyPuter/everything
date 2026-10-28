import { openReadOnlyPreview } from './helpers/preview.js';
import { showAllTools } from './helpers/editor-tools.js';
import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { reopenDocx } from './helpers/reopen-docx.js';

async function choose(input, text, end) {
  await input.evaluate((el, { text, end }) => { const at = el.value.indexOf(text); if (at < 0) throw new Error('Missing text'); el.setSelectionRange(at, end ? el.value.indexOf(end) + end.length : at); el.dispatchEvent(new Event('select', { bubbles: true })); }, { text, end });
}
async function fixture(page, soft = false) {
  await page.goto('/playground.html'); await showAllTools(page); await page.getByLabel('Open DOCX file').setInputFiles(`public/fixtures/justification${soft ? '-soft-breaks' : ''}.docx`);
  const input = page.getByRole('textbox', { name: 'Document text' }); await expect(input).toHaveValue(/^Justified paragraphs/); return input;
}
async function download(page, info, name) {
  const event = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download .docx', exact: true }).click(); const path = info.outputPath(name); await (await event).saveAs(path); return path;
}
async function screenshotCanvas(page, info, index, name) {
  const png = await page.locator('canvas.canvas-page').nth(index).evaluate(c => c.toDataURL().split(',')[1]); writeFileSync(info.outputPath(name), Buffer.from(png, 'base64'));
}

test('edits justified paragraphs with keyboard and toolbar, preserves styles, and reopens the independent fixture', async ({ page }, info) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const input = await fixture(page), original = await input.inputValue(), button = page.getByRole('button', { name: 'Justify', exact: true }), undo = page.getByRole('button', { name: 'Undo', exact: true });
  await expect(button.locator('svg')).toHaveAttribute('aria-hidden', 'true');
  await choose(input, 'Inherited words'); await expect(button).toHaveAttribute('aria-pressed', 'true');
  await choose(input, 'Direct left'); await expect(button).toHaveAttribute('aria-pressed', 'false'); await button.focus(); await button.press('Enter'); await expect(input).toBeFocused(); await expect(button).toHaveAttribute('aria-pressed', 'true');
  await undo.click(); await expect(button).toHaveAttribute('aria-pressed', 'false'); await input.press('ControlOrMeta+j'); await expect(button).toHaveAttribute('aria-pressed', 'true');
  await choose(input, 'Direct both'); await page.getByRole('button', { name: 'Align right', exact: true }).click();
  await choose(input, 'Inherited words'); await page.getByRole('button', { name: 'Edit paragraph style', exact: true }).click();
  const alignment = page.getByRole('combobox', { name: 'Style alignment', exact: true }); await expect(alignment).toHaveValue(''); await alignment.selectOption('left'); await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(button).toHaveAttribute('aria-pressed', 'false'); await undo.click(); await expect(button).toHaveAttribute('aria-pressed', 'true');
  await choose(input, 'Inherited words', 'Direct both'); await expect(button).toHaveAttribute('aria-pressed', 'mixed');
  await choose(input, 'Justified paragraphs'); await screenshotCanvas(page, info, 0, 'justification-page.png'); await screenshotCanvas(page, info, 1, 'justification-rich.png');
  await screenshotCanvas(page, info, await page.locator('canvas.canvas-page').count() - 2, 'justification-table.png');
  const saved = await download(page, info, 'justification.docx'); await reopenDocx(page, input, saved, original); await expect(undo).toBeDisabled();
  await choose(input, 'Direct left'); await expect(button).toHaveAttribute('aria-pressed', 'true'); await choose(input, 'Direct both'); await expect(page.getByRole('button', { name: 'Align right', exact: true })).toHaveAttribute('aria-pressed', 'true'); expect(errors).toEqual([]);
});

test('retains the soft-return compatibility setting through editing and export', async ({ page }, info) => {
  const input = await fixture(page, true), original = await input.inputValue(); await choose(input, 'Direct left');
  await input.evaluate(el => el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'formatJustifyFull', bubbles: true, cancelable: true }))); await expect(page.getByRole('button', { name: 'Justify', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const saved = await download(page, info, 'justification-soft-breaks.docx'); await reopenDocx(page, input, saved, original); await screenshotCanvas(page, info, 0, 'justification-soft-breaks.png');
});

test('authors fresh justified and left paragraphs and preserves text, alignment and Unicode edits through undo', async ({ page }, info) => {
  await page.goto('/playground.html'); await showAllTools(page); await page.getByRole('button', { name: 'New', exact: true }).click(); const input = page.getByRole('textbox', { name: 'Document text' }); await expect(input).toHaveValue('');
  const text = 'New justified words '.repeat(15) + '\nFinal left paragraph'; await input.fill(text); await choose(input, 'New justified'); await input.press('ControlOrMeta+j');
  await choose(input, 'Final left'); await page.getByRole('button', { name: 'Align center', exact: true }).click(); await page.getByRole('button', { name: 'Align left', exact: true }).click();
  await choose(input, 'New justified'); await page.keyboard.insertText('Á😀 '); await expect(input).toHaveValue('Á😀 ' + text); await page.getByRole('button', { name: 'Undo', exact: true }).click(); await expect(input).toHaveValue(text);
  const saved = await download(page, info, 'new-justification.docx'); await reopenDocx(page, input, saved, text); await expect(page.getByRole('button', { name: 'Justify', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('uses native shaping for expanded spaces, matches paint widths and keeps zoomed caret hits aligned', async ({ page }) => {
  await page.addInitScript(() => {
    window.justifyPaint = [];
    // Chromium may serialize spacing as an empty string inside a saved canvas
    // state. Capture the native assignments without replacing their behavior.
    const spacing = new WeakMap(), letters = new WeakMap();
    for (const [key, values] of [['wordSpacing', spacing], ['letterSpacing', letters]]) {
      const descriptor = Object.getOwnPropertyDescriptor(CanvasRenderingContext2D.prototype, key);
      Object.defineProperty(CanvasRenderingContext2D.prototype, key, { ...descriptor, set(value) { descriptor.set.call(this, value); values.set(this, value); } });
    }
    const fill = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function(text, ...args) { if (parseFloat(spacing.get(this))) window.justifyPaint.push({ text, spacing: spacing.get(this), width: this.measureText(text).width, font: this.font, kerning: this.fontKerning, letterSpacing: letters.get(this) }); return fill.call(this, text, ...args); };
  });
  const input = await fixture(page); await expect.poll(() => page.evaluate(() => window.justifyPaint.length)).toBeGreaterThan(0);
  const result = await page.evaluate(async () => {
    const { layoutDocument, caretRect, hitTest, selectionRects } = await import('/src/engine/layout.js'), { paragraph } = await import('/src/engine/model.js'), { fontMetrics } = await import('/src/engine/font-metrics.js'), { setCanvasTextStyle } = await import('/src/engine/canvas-text.js');
    const c = document.createElement('canvas').getContext('2d'); const measure = (text, style) => { setCanvasTextStyle(c, style); return { width: c.measureText(text).width, ...fontMetrics(style) }; };
    const page = { width: 400, height: 500, margin: 40, gap: 24 }, text = 'Alpha beta gamma delta epsilon zeta eta theta iota';
    const layout = alignment => layoutDocument([paragraph(text, { format: { alignment } })], measure, page), both = layout('both'), left = layout('left'), first = both.lines[0];
    const caret = caretRect(both, 6), x = (l, offset) => l.stops.find(s => s.offset === offset).x;
    const native = window.justifyPaint.map(p => { c.font = p.font; c.fontKerning = p.kerning; c.letterSpacing = p.letterSpacing; c.wordSpacing = p.spacing; const span = document.createElement('span'); span.style.cssText = `position:absolute;white-space:pre;font:${p.font};font-kerning:${p.kerning};letter-spacing:${p.letterSpacing};word-spacing:${p.spacing}`; span.textContent = p.text; document.body.append(span); const cssWidth = span.getBoundingClientRect().width; span.remove(); return { ...p, measured: c.measureText(p.text).width, cssWidth }; });
    const soft = flag => layoutDocument([paragraph('Alpha beta\vFinal', { format: { alignment: 'both' } })], measure, { ...page, doNotExpandShiftReturn: flag }).lines[0];
    const fixed = layoutDocument([paragraph('A\u00a0B C\u202fD\vFinal', { format: { alignment: 'both' } })], measure, page).lines[0];
    return { native, first: first.stops.at(-1).x, last: both.lines.at(-1).justificationSpacing, word: x(first, 2) - x(first, 1), naturalWord: x(left.lines[0], 2) - x(left.lines[0], 1), gap: x(first, 6) - x(first, 5), naturalGap: x(left.lines[0], 6) - x(left.lines[0], 5), selection: selectionRects(both, 5, 6)[0].width, hit: hitTest(both, caret.page, caret.x, caret.y + caret.height / 2), soft: soft(false).stops.at(-1).x, exempt: soft(true).stops.at(-1).x, fixed: fixed.stops.at(-1).x };
  });
  expect(result.first).toBeCloseTo(360, 2); expect(result.fixed).toBeCloseTo(360, 2); expect(result.last).toBeUndefined(); expect(result.word).toBeCloseTo(result.naturalWord, 4); expect(result.gap).toBeGreaterThan(result.naturalGap); expect(result.selection).toBeCloseTo(result.gap, 4); expect(result.hit).toBe(6); expect(result.soft).toBeCloseTo(360, 2); expect(result.exempt).toBeLessThan(200);
  expect(result.native.length).toBeGreaterThan(10); for (const p of result.native) { expect(p.width, JSON.stringify(p)).toBeCloseTo(p.measured, 4); expect(p.width, p.text + ' CSS reference').toBeCloseTo(p.cssWidth, 1); }
  await page.getByRole('combobox', { name: 'Zoom', exact: true }).selectOption('1.5'); await choose(input, 'Inherited words');
  const caret = await input.evaluate(el => ({ left: parseFloat(el.style.left), top: parseFloat(el.style.top), height: parseFloat(el.style.height), at: el.selectionStart }));
  const surface = await page.locator('.canvas-pages').boundingBox(); await page.mouse.click(surface.x + caret.left + 1, surface.y + caret.top + caret.height / 2); expect(await input.evaluate(el => el.selectionStart)).toBe(caret.at);
});

test('previews unsupported justification as read-only with the original available', async ({ page }) => {
  const input = await fixture(page), text = await input.inputValue();
  for (const [from, to, error] of [['<w:jc w:val="both"/>', '<w:jc w:val="thaiDistribute"/>', /thaiDistribute paragraph alignment/]]) {
    const parts = unzipSync(readFileSync('public/fixtures/justification.docx')), xml = strFromU8(parts['word/document.xml']); expect(xml).toContain(from); parts['word/document.xml'] = strToU8(xml.replace(from, to));
    await openReadOnlyPreview(page, { name: 'unsupported-justification.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from(zipSync(parts)) });   await expect(page.getByRole('button', { name: 'Download .docx', exact: true })).toBeEnabled();
  }
  await fixture(page);
});

// A justified line whose last tab is a center, right or decimal stop keeps its natural spacing, and the
// document opens for editing (before, it opened read-only).
test('opens justified paragraphs with a center tab for editing', async ({ page }) => {
  await page.goto('/playground.html'); await showAllTools(page);
  const input = page.getByRole('textbox', { name: 'Document text' }); await expect(input).toHaveValue(/^A small beginning/);
  const parts = unzipSync(readFileSync('public/fixtures/justification.docx')), xml = strFromU8(parts['word/document.xml']);
  expect(xml).toContain('w:pos="1800" w:val="left"'); parts['word/document.xml'] = strToU8(xml.replace('w:pos="1800" w:val="left"', 'w:pos="1800" w:val="center"'));
  await page.getByLabel('Open DOCX file').setInputFiles({ name: 'center-tab.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from(zipSync(parts)) });
  await expect(input).toHaveValue(/^Justified paragraphs/); await expect(input).toHaveJSProperty('readOnly', false);
  await expect(page.locator('#playground-error')).toBeEmpty();
});

// Arabic typed into a justified paragraph is accepted and justified by its word spaces (no kashida).
test('justifies typed Arabic by its word spaces with native canvas metrics', async ({ page }) => {
  const input = await fixture(page), text = await input.inputValue();
  await choose(input, 'Direct both'); await page.keyboard.insertText('العربية '); await expect(input).toHaveValue(text.replace('Direct both', 'العربية Direct both'));
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled(); await expect(page.getByText(/kashida/)).toHaveCount(0);
  const edges = await page.evaluate(async () => {
    const { measureCanvasText } = await import('/src/engine/canvas-text.js'), { layoutDocument } = await import('/src/engine/layout.js'), { paragraph } = await import('/src/engine/model.js');
    const ctx = document.createElement('canvas').getContext('2d'), measure = (t, s) => measureCanvasText(ctx, t, s);
    const arabic = 'هذا نص عربي طويل يلتف عبر عدة أسطر للتأكد من أن التخطيط يعمل بشكل صحيح في المحرر مع English words أيضا';
    const layout = layoutDocument([paragraph(arabic, { format: { spaceAfter: 0, alignment: 'both' } })], measure, { width: 300, height: 4000, margin: 20 });
    // Ink extents: the reordered right-to-left text spans the whole measure; the hanging space is clipped at its edge.
    return layout.lines.map(l => ({ last: l.paragraphEnd, spacing: l.justificationSpacing, left: Math.min(...l.fragments.filter(f => f.text.trim()).map(f => f.x)), right: Math.max(...l.fragments.filter(f => f.text.trim()).map(f => f.x + f.width)) }));
  });
  expect(edges.length).toBeGreaterThan(2);
  for (const line of edges.filter(l => !l.last)) { expect(line.spacing).toBeGreaterThan(0); expect(Math.abs(line.left - 20)).toBeLessThan(0.5); expect(Math.abs(line.right - 280)).toBeLessThan(0.5); }
});

test('previews justified documents when Canvas word spacing is unavailable', async ({ page }) => {
  await page.addInitScript(() => { delete CanvasRenderingContext2D.prototype.wordSpacing; }); await page.goto('/playground.html'); await showAllTools(page); const input = page.getByRole('textbox', { name: 'Document text' }); await expect(input).toHaveValue(/^A small beginning/); const before = await input.inputValue();
  await openReadOnlyPreview(page, 'public/fixtures/justification.docx');
});

test('fits justified rich text into fractional-width table cells using native font advances', async ({ page }) => {
  await page.goto('/playground.html'); await showAllTools(page); await expect(page.getByRole('textbox', { name: 'Document text' })).toHaveValue(/^A small beginning/);
  const failures = await page.evaluate(async () => {
    const { TextDocument, paragraph } = await import('/src/engine/model.js'), { layoutDocument } = await import('/src/engine/layout.js'), { pageGeometry } = await import('/src/engine/page-settings.js'), { fontMetrics } = await import('/src/engine/font-metrics.js'), { setCanvasTextStyle } = await import('/src/engine/canvas-text.js');
    const c = document.createElement('canvas').getContext('2d'), failures = [];
    const measure = (text, style) => { setCanvasTextStyle(c, style); return { width: c.measureText(text).width, ...fontMetrics(style) }; };
    for (const format of [{}, { textScale: 115, characterSpacing: .5 }, { verticalAlign: 'superscript', capitalization: 'smallCaps' }]) for (let i = 0; i < 24; i++) {
      const doc = new TextDocument([paragraph()], { width: 5000 + i * 17, left: 720, right: 720 }); doc.insertTable(1, 1); doc.replace('Alpha beta gamma delta epsilon zeta eta theta iota '.repeat(2)); doc.select(0, doc.text.length); doc.setRunFormat(format); doc.setParagraphFormat({ alignment: 'both' });
      try {
        const result = layoutDocument(doc.paragraphs, measure, pageGeometry(doc.pageSettings), doc.numbering, doc.tables);
        for (const line of result.lines.filter(l => l.cellId && l.justificationSpacing)) {
          const box = result.cells.find(c => c.id === line.cellId && c.page === line.page), right = box.x + box.width - 7.2, end = line.stops.at(-1).x - (line.hangingRight ? 0 : line.ignoredTrailingWidth);
          if (Math.abs(end - right) > .001) failures.push({ i, format, end, right });
        }
      } catch (error) { failures.push({ i, format, error: error.message }); }
    }
    return failures;
  });
  expect(failures).toEqual([]);
});

// Distributed alignment (§17.18.44 distribute): every line, the last one included, spans the measure,
// by equal gaps between all characters, measured and painted with native letter spacing.
test('opens distributed paragraphs for editing and spreads every line with native canvas metrics', async ({ page }) => {
  await page.goto('/playground.html'); await showAllTools(page);
  const input = page.getByRole('textbox', { name: 'Document text' }); await expect(input).toHaveValue(/^A small beginning/);
  const parts = unzipSync(readFileSync('public/fixtures/justification.docx')), xml = strFromU8(parts['word/document.xml']);
  parts['word/document.xml'] = strToU8(xml.replaceAll('<w:jc w:val="both"/>', '<w:jc w:val="distribute"/>'));
  await page.getByLabel('Open DOCX file').setInputFiles({ name: 'distributed.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from(zipSync(parts)) });
  await expect(input).toHaveValue(/^Justified paragraphs/); await expect(input).toHaveJSProperty('readOnly', false);
  await choose(input, 'Direct both'); await page.keyboard.insertText('Typed '); await expect(input).toHaveValue(/Typed Direct both/);
  const lines = await page.evaluate(async () => {
    const { measureCanvasText } = await import('/src/engine/canvas-text.js'), { layoutDocument } = await import('/src/engine/layout.js'), { paragraph } = await import('/src/engine/model.js');
    const ctx = document.createElement('canvas').getContext('2d'), measure = (t, s) => measureCanvasText(ctx, t, s);
    const layout = layoutDocument(['Distributed title', 'Alpha beta gamma delta epsilon zeta eta theta iota kappa', '分散对齐的中文段落最后一行也要对齐'].map(t => paragraph(t, { format: { spaceAfter: 0, alignment: 'distribute' } })), measure, { width: 300, height: 4000, margin: 20 });
    // A line of one character has no gap to widen.
    return layout.lines.filter(l => l.end - l.start > 1).map(l => ({ left: Math.min(...l.stops.map(s => s.x)), right: Math.max(...l.stops.map(s => s.x)) - (l.hangingRight ? 0 : l.ignoredTrailingWidth) }));
  });
  expect(lines.length).toBeGreaterThan(3);
  for (const line of lines) { expect(Math.abs(line.left - 20)).toBeLessThan(0.5); expect(Math.abs(line.right - 280)).toBeLessThan(0.5); }
});
