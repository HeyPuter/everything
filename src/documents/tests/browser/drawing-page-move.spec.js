import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

// A floating picture dragged onto the next page lands there: its anchor moves to a paragraph that starts on
// that page, as Word moves an object's anchor with it. Kept on its old paragraph, the picture was placed past
// the bottom of the old page and disappeared.
const png = readFileSync('icon-128.png');
test.setTimeout(120000);

async function open(page, anchor = {}) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/playground.html');
  await page.addStyleTag({ content: readFileSync('src/styles/drawing-handles.css', 'utf8') });
  await page.evaluate(async ({ png, anchor }) => {
    const { createDocx } = await import('/src/engine/docx.js'), { paragraph } = await import('/src/engine/model.js'), { CanvasEditor } = await import('/src/engine/canvas-editor.js');
    const pkg = window.pkg = createDocx([paragraph()]);
    const host = document.createElement('div'); host.id = 'move-host'; host.style.cssText = 'position:fixed;inset:0;z-index:100;overflow:auto;background:#e8eaee';
    document.body.append(host);
    window.errors = [];
    const editor = window.e = new CanvasEditor(host, { ...pkg, onError: e => window.errors.push(e.message) });
    editor.execute(() => editor.model.replace(Array.from({ length: 80 }, (_, i) => `Line ${i}`).join('\n')));
    const bytes = Uint8Array.from(png);
    editor.model.assets.a = { bytes, mime: 'image/png' };
    editor.images.set('a', await createImageBitmap(new Blob([bytes], { type: 'image/png' })));
    // Near the bottom of the page its paragraph is on.
    editor.model.select(editor.model.paragraphOffset(30));
    editor.execute(() => editor.model.insertImage('a', { width: 914400, height: 914400, alt: 'Pic', anchor: { horizontal: 'column', vertical: 'paragraph', x: 0, y: 5486400, wrap: 'none', behind: false, order: 1, ...anchor } }));
    const f = editor.layout.floatingObjects[0];
    editor.model.select(f.start, f.end); editor.focus(); editor.paint(); editor.onSelection();
    host.scrollTop = editor.canvases[f.page].offsetTop + 500;
  }, { png: [...png], anchor });
  await page.waitForTimeout(200);
}
const state = page => page.evaluate(() => {
  const e = window.e, f = e.layout.floatingObjects[0];
  return { page: f.page, x: f.x, y: f.y, paragraph: e.model.paragraphs.findIndex(p => p.runs.some(r => r.image)), anchor: f.image.anchor, pageHeight: e.layout.pages[f.page].height };
});
/** Drag the picture by its center down to `y` px below the top of the next page. */
async function dragToNextPage(page, before, y) {
  const canvases = page.locator('#move-host canvas.canvas-page');
  const from = await canvases.nth(before.page).boundingBox(), to = await canvases.nth(before.page + 1).boundingBox();
  const start = { x: from.x + before.x + 48, y: from.y + before.y + 48 };
  await page.mouse.move(start.x, start.y); await page.mouse.down();
  await page.mouse.move(start.x, to.y + y + 48, { steps: 10 }); await page.mouse.up();
}

test('a floating picture dragged onto the next page is anchored there and stays visible', async ({ page }) => {
  await open(page);
  const before = await state(page);
  expect(before.paragraph).toBe(30);
  await dragToNextPage(page, before, 200);
  const after = await state(page);
  expect(after.page).toBe(before.page + 1);
  expect(after.y).toBeGreaterThan(0);
  expect(after.y + 96).toBeLessThan(after.pageHeight);
  expect(after.y).toBeCloseTo(200, -1);
  expect(after.x).toBeCloseTo(before.x, 1);
  // Its anchor is a paragraph on the new page, measured from that paragraph.
  expect(after.paragraph).toBeGreaterThan(before.paragraph);
  expect(after.anchor.vertical).toBe('paragraph');
  expect(await page.evaluate(i => window.e.layout.lines.find(l => l.paragraphId === window.e.model.paragraphs[i].id).page, after.paragraph)).toBe(after.page);
  expect(await page.evaluate(() => window.e.model.text.split('\n').length)).toBe(80);
  // It saves where it is shown.
  const reopened = await page.evaluate(async () => {
    const { DocxPackage } = await import('/src/engine/docx.js'), e = window.e;
    const blob = await window.pkg.export(e.model.paragraphs, e.model.pageSettings, e.model.numbering, e.model.styles, e.model.tables, e.model.assets);
    const pkg = await DocxPackage.open(new Uint8Array(await blob.arrayBuffer()));
    const index = pkg.paragraphs.findIndex(p => p.runs.some(r => r.image));
    return { index, anchor: pkg.paragraphs[index].runs.find(r => r.image).image.anchor };
  });
  expect(reopened.index).toBe(after.paragraph);
  expect(reopened.anchor).toMatchObject({ vertical: 'paragraph', y: after.anchor.y, x: after.anchor.x });
  // One undo step puts it back.
  await page.evaluate(() => window.e.undo());
  expect(await state(page)).toEqual(before);
  expect(await page.evaluate(() => window.errors)).toEqual([]);
});

test('a picture whose anchor is locked keeps its paragraph', async ({ page }) => {
  await open(page, { locked: true });
  const before = await state(page);
  await dragToNextPage(page, before, 200);
  const after = await state(page);
  expect(after.paragraph).toBe(before.paragraph);
  expect(await page.evaluate(() => window.errors)).toEqual([]);
});
