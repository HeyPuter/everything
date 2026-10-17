import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
import { requireNativeWordFonts } from './helpers/native-fonts.js';

const root = 'tests/fixtures/run-background-height/';
const reference = JSON.parse(readFileSync(root + 'reference.json', 'utf8'));

test('matches native run-background heights across spacing, direction and mixed sizes', async ({ page }, info) => {
  for (const [file, key] of [['control.docx', 'sourceSha256'], ['native.pdf', 'pdfSha256'], ['cases.json', 'casesSha256']]) {
    expect(createHash('sha256').update(readFileSync(root + file)).digest('hex')).toBe(reference[key]);
  }
  await page.goto('/playground.html'); await requireNativeWordFonts(page, ['Arial']);
  const actual = await page.evaluate(async bytes => {
    const { openCanvasDocument } = await import('/src/engine/open-document.js');
    const { CanvasEditor } = await import('/src/engine/canvas-editor.js');
    const { runBackgroundRect } = await import('/src/engine/backgrounds.js');
    const { pkg, images } = await openCanvasDocument(Uint8Array.from(atob(bytes), c => c.charCodeAt(0)));
    const host = document.createElement('div'); document.body.append(host);
    const editor = new CanvasEditor(host, { ...pkg, images });
    try {
      const samples = editor.layout.lines.filter(l => l.backgrounds.length).map((line, index) => {
        const band = runBackgroundRect(line, line.backgrounds[0]);
        const canvas = editor.canvases[line.page], ctx = canvas.getContext('2d');
        const ys = [];
        for (let y = Math.floor(band.y)-2; y <= Math.ceil(band.y+band.height)+2; y++) {
          const pixels = ctx.getImageData(Math.ceil(band.x)+1, y, Math.max(1, Math.floor(band.width)-2), 1).data;
          for (let x = 0; x < pixels.length; x += 4) if (pixels[x]>250 && pixels[x+1]>250 && pixels[x+2]<5) { ys.push(y); break; }
        }
        return { index, page: line.page, y: band.y*.75, height: band.height*.75,
          pixelTop: Math.min(...ys)*.75, pixelBottom: (Math.max(...ys)+1)*.75 };
      });
      return { samples, pages: editor.canvases.map(c => c.toDataURL().split(',')[1]) };
    } finally { editor.destroy(); host.remove(); }
  }, readFileSync(root + 'control.docx').toString('base64'));
  writeFileSync(info.outputPath('actual.json'), JSON.stringify(actual.samples, null, 2));
  for (const [i, png] of actual.pages.entries()) writeFileSync(info.outputPath(`page-${i+1}.png`), Buffer.from(png, 'base64'));
  expect(actual.pages).toHaveLength(5); expect(actual.samples).toHaveLength(28);
  for (const sample of actual.samples) {
    const native = reference.cases[sample.index];
    expect(sample.page).toBe(native.page);
    expect(Math.abs(sample.y-native.rect.y), `case ${sample.index+1} top`).toBeLessThan(.25);
    expect(Math.abs(sample.height-native.rect.height), `case ${sample.index+1} height`).toBeLessThan(.25);
    expect(Math.abs(sample.pixelTop-native.rect.y), `case ${sample.index+1} painted top`).toBeLessThan(1);
    expect(Math.abs(sample.pixelBottom-native.rect.y-native.rect.height), `case ${sample.index+1} painted bottom`).toBeLessThan(1);
  }
  await page.getByLabel('Open DOCX file').setInputFiles(root + 'control.docx');
  // Run-level RTL (w:rtl) is editable, so the control opens for editing; an untouched download keeps every part.
  await expect(page.getByRole('textbox', { name: 'Document text' })).toHaveJSProperty('readOnly', false);
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download .docx', exact: true }).click();
  const output = info.outputPath('noedit.docx'); await (await pending).saveAs(output);
  expect(unzipSync(readFileSync(output))).toEqual(unzipSync(readFileSync(root + 'control.docx')));
});
