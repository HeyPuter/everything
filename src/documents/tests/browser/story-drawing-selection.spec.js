import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { unzipSync } from 'fflate';
import { downloadDocx } from './helpers/editor-tools.js';
import { reopenDocx } from './helpers/reopen-docx.js';

test('double-click selects the header drawing outside its anchor line, with delete, undo and export', async ({ page }, info) => {
  const source = 'public/fixtures/header-drawings.docx';
  await page.goto('/playground.html'); await page.getByLabel('Open DOCX file').setInputFiles(source);
  await expect(page.getByRole('textbox', { name: 'Document text', exact: true })).toHaveValue('Body page 1\ufffc\nBody page 2\nBody page 3');
  const target = await page.evaluate(async bytes => {
    const { DocxPackage } = await import('/src/engine/docx.js');
    const { layoutDocument, imageAtPoint } = await import('/src/engine/layout.js');
    const { layoutPageStories } = await import('/src/engine/page-story-layout.js');
    const { pageGeometry } = await import('/src/engine/page-settings.js');
    const { measureCanvasText } = await import('/src/engine/canvas-text.js');
    const pkg = await DocxPackage.open(new Uint8Array(bytes)), context = document.createElement('canvas').getContext('2d');
    const measure = (text, style) => measureCanvasText(context, text, style);
    const body = layoutDocument(pkg.paragraphs, measure, pageGeometry(pkg.pageSettings), pkg.numbering, pkg.tables, pkg.pageStories);
    const stories = layoutPageStories(body, pkg.pageStories, [pkg.pageSettings], measure, pkg.numbering, { styles: pkg.styles });
    for (const f of stories.floatingObjects.filter(f => f.page === 0 && pkg.pageStories.stories[f.pageStory].kind === 'header')) {
      for (const ry of [.2, .5, .8]) for (const rx of [.2, .5, .8]) {
        const x = f.x + f.width * rx, y = f.y + f.height * ry;
        if (stories.lines.some(l => l.page === 0 && y >= l.y && y <= l.y + l.height)) continue;
        if (body.lines.some(l => l.page === 0 && y >= l.y && y <= l.y + l.height)) continue;
        if (imageAtPoint({ ...body, ...stories }, 0, x, y)?.image.id !== f.image.id) continue;
        const firstBody = body.lines.find(line => line.page === 0);
        return { x, y, start: f.start, end: f.end, path: f.pageStory, bodyPoint: { x: firstBody.stops[0].x + 4, y: firstBody.y + firstBody.height / 2 }, text: pkg.pageStories.stories[f.pageStory].paragraphs.map(p => p.runs.map(r => r.text).join('')).join('\n') };
      }
    }
    throw new Error('The original control has no isolated header drawing target.');
  }, [...readFileSync(source)]);
  await page.locator('canvas.canvas-page').first().dblclick({ position: { x: target.x, y: target.y } });
  const input = page.getByRole('textbox', { name: 'Header text', exact: true });
  await expect(input).toHaveValue(target.text);
  expect(await input.evaluate(el => [el.selectionStart, el.selectionEnd])).toEqual([target.start, target.end]);
  await input.press('Delete'); await expect(input).toHaveValue(target.text.slice(0, target.start) + target.text.slice(target.end));
  const download = async name => {
    const pending = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download .docx', exact: true }).click();
    const path = info.outputPath(name + '.docx'); await (await pending).saveAs(path); return unzipSync(readFileSync(path));
  };
  const original = unzipSync(readFileSync(source)), edited = await download('deleted');
  expect(edited[target.path]).not.toEqual(original[target.path]);
  for (const name of Object.keys(original)) if (name !== target.path) expect(edited[name], name).toEqual(original[name]);
  await input.press('ControlOrMeta+z'); await expect(input).toHaveValue(target.text);
  expect(await download('undo')).toEqual(original);
  await page.locator('canvas.canvas-page').first().dblclick({ position: target.bodyPoint });
  await expect(page.getByRole('textbox', { name: 'Document text', exact: true })).toHaveValue('Body page 1\ufffc\nBody page 2\nBody page 3');
});

test('the arrow keys nudge a floating drawing in a header, as in the body, with undo and saving', async ({ page }, info) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  page.once('dialog', dialog => dialog.accept());
  await page.getByLabel('Open DOCX file').setInputFiles('public/fixtures/header-drawings-footer-text.docx');
  await expect(page.getByRole('textbox', { name: 'Document text', exact: true })).toHaveValue('Body page 1\ufffc\nBody page 2\nBody page 3');
  await expect.poll(() => page.evaluate(() => !!window.__docs?.current?.view?.engine?.pageStories)).toBe(true);
  const header = await page.evaluate(() => Object.entries(window.__docs.current.view.engine.pageStories.stories).find(([, s]) => s.kind === 'header')[0]);
  const select = () => page.evaluate(path => {
    const e = window.__docs.current.view.engine; e.editStory(path);
    const at = e.model.text.indexOf('￼'); e.model.select(at, at + 1); e.syncInput(); e.paint(); e.onSelection(); e.focus();
  }, header);
  const state = () => page.evaluate(() => {
    const e = window.__docs.current.view.engine, image = e.model.selectedImage, frame = (e.selectionLayout.floatingObjects || []).find(f => f.image.id === image?.id);
    return { path: e.session.path, x: image?.anchor.x, y: image?.anchor.y, frame: frame && { x: frame.x, y: frame.y } };
  });
  await select();
  const before = await state();
  expect(before.path).toBe(header);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowDown');
  const after = await state();
  expect(after).toMatchObject({ path: header, x: before.x + 9525, y: before.y + 95250 });
  expect(after.frame.x - before.frame.x).toBeCloseTo(1, 3);
  expect(after.frame.y - before.frame.y).toBeCloseTo(10, 3);
  // Each nudge is one undo step.
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await state()).y).toBe(before.y);
  await page.keyboard.press('ControlOrMeta+y');
  await expect.poll(async () => (await state()).y).toBe(after.y);
  await page.evaluate(() => window.__docs.current.view.engine.editStory(null));
  const path = info.outputPath('nudged-header.docx');
  const download = page.waitForEvent('download'); await downloadDocx(page); await (await download).saveAs(path);
  const parts = unzipSync(readFileSync(path)), xml = new TextDecoder().decode(parts[header]);
  expect(xml).toContain(`<wp:posOffset>${after.x}</wp:posOffset>`);
  expect(xml).toContain(`<wp:posOffset>${after.y}</wp:posOffset>`);
  const input = page.getByRole('textbox', { name: 'Document text', exact: true });
  await reopenDocx(page, input, path, await input.inputValue());
  await select();
  expect(await state()).toMatchObject({ path: header, x: after.x, y: after.y });
  expect(errors).toEqual([]);
});
