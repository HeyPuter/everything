import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { openReadOnlyPreview } from './helpers/preview.js';
const folder = 'tests/fixtures/hyperlink-child-recovery/';
// Permission markers inside a hyperlink remain unsupported there and keep the read-only preview. A tracked
// deletion inside a hyperlink is an editable revision since Track Changes support (docs/conformance.md,
// "Tracked changes"; tests/hyperlink-child-recovery.test.js), so it opens for editing with its markup shown.
const variants = ['leading', 'trailing', 'multiple'];

for (const zoom of [1, 0.75]) test(`unsupported hyperlink children preserve healthy rendering at ${zoom}`, async ({ page }, info) => {
  test.setTimeout(180000);
  await page.goto('/playground.html', { waitUntil: 'domcontentloaded' });
  const inputs = Object.fromEntries(['healthy', ...variants, 'deleted'].map(name => [name, [...readFileSync(`${folder}${name}.docx`)]]));
  const results = await page.evaluate(async ({ inputs, zoom }) => {
    const { openCanvasDocument } = await import('/src/engine/open-document.js');
    const { CanvasEditor } = await import('/src/engine/canvas-editor.js');
    const rendered = {};
    for (const [name, bytes] of Object.entries(inputs)) {
      const { pkg, images } = await openCanvasDocument(new Uint8Array(bytes));
      const host = document.createElement('div'); document.body.append(host);
      const errors = [];
      const editor = new CanvasEditor(host, { ...pkg, images, onError: error => errors.push(error.message) });
      editor.setZoom(zoom);
      rendered[name] = { readOnly: !!pkg.readOnly, tables: pkg.tables.length, errors,
        pictures: [...editor.model.paragraphs, ...Object.values(pkg.pageStories.stories).flatMap(s => s.paragraphs)].flatMap(p => p.runs).filter(r => r.image).length,
        pixels: editor.canvases.map(c => c.toDataURL()),
        geometry: [...editor.layout.lines, ...editor.storyLayout.lines].map(l => ({ page: l.page, y: l.y, baseline: l.baseline, height: l.height,
          fragments: l.fragments.map(f => ({ text: f.text, x: f.x, width: f.width, bold: f.bold })) })) };
      editor.destroy(); host.remove();
    }
    return Object.keys(inputs).filter(name => name !== 'healthy').map(name => ({ name, editable: !rendered[name].readOnly,
      editableControl: !rendered.healthy.readOnly, readOnly: rendered[name].readOnly,
      tables: rendered[name].tables, pictures: rendered[name].pictures, errors: rendered[name].errors,
      samePixels: JSON.stringify(rendered[name].pixels) === JSON.stringify(rendered.healthy.pixels),
      sameGeometry: JSON.stringify(rendered[name].geometry) === JSON.stringify(rendered.healthy.geometry) }));
  }, { inputs, zoom });
  for (const result of results) {
    expect(result.editableControl).toBe(true);
    if (result.name === 'deleted') {
      expect(result.editable).toBe(true); expect(result.tables).toBe(1); expect(result.pictures).toBe(4); expect(result.errors).toEqual([]);
      continue;
    }
    expect(result.readOnly).toBe(true);
    expect(result.tables).toBe(1); expect(result.pictures).toBe(4); expect(result.errors).toEqual([]);
    expect(result.samePixels, result.name).toBe(true); expect(result.sameGeometry, result.name).toBe(true);
  }
  await openReadOnlyPreview(page, `${folder}multiple.docx`);
  const input = page.getByRole('textbox', { name: 'Document text' });
  const original = await input.inputValue();
  await input.focus(); await input.press('ControlOrMeta+End'); await input.press('x');
  expect(await input.inputValue()).toBe(original);
  await page.getByRole('combobox', { name: 'Zoom' }).selectOption(String(zoom));
  await page.screenshot({ path: info.outputPath('hyperlink-child-recovery.png'), fullPage: true });
  for (const name of variants) {
    await openReadOnlyPreview(page, `${folder}${name}.docx`);
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download .docx', exact: true }).click();
    const bytes = readFileSync(await (await download).path());
    expect(bytes).toEqual(readFileSync(`${folder}${name}.docx`));
    writeFileSync(info.outputPath(`${name}-original.docx`), bytes);
  }
});
