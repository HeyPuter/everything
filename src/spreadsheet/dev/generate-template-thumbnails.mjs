// Regenerate the shipped previews from the real templates and print renderer.
// No workbooks are constructed when the home screen loads.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { TEMPLATES } from '../src/core/templates.js';
import { buildPrintSheet } from '../src/ui/print.js';

process.env.TZ = 'UTC';
const NativeDate = Date;
// Stable example dates and drawing IDs keep regeneration reproducible.
globalThis.Date = class extends NativeDate {
  constructor(...args) { super(...(args.length ? args : [NativeDate.UTC(2026, 0, 15)])); }
  static now() { return NativeDate.UTC(2026, 0, 15); }
};
let nextId = 0;
crypto.randomUUID = () => `00000000-0000-4000-8000-${(++nextId).toString(16).padStart(12, '0')}`;

const dom = new JSDOM();
for (const key of ['document', 'Node', 'XMLSerializer']) globalThis[key] = dom.window[key];
const stylesheet = await readFile(new URL('../src/styles/editor.css', import.meta.url), 'utf8');
const printCss = stylesheet.slice(stylesheet.indexOf('.print-table {'), stylesheet.indexOf('/* Named ranges manager */'));
const output = new URL('../src/assets/template-thumbnails/', import.meta.url);
await mkdir(output, { recursive: true });

for (const template of TEMPLATES.filter(t => t.id !== 'blank')) {
  const wb = template.build(), sheet = wb.activeSheet;
  const used = wb.usedRange(sheet.id);
  // A thumbnail shows the beginning of the first sheet, like a first-page preview.
  const range = { ...used, r2: Math.min(used.r2, used.r1 + 29) };
  let width = 0, height = 0;
  for (let c = range.c1; c <= range.c2; c++) width += wb.colWidth(sheet.id, c);
  for (let r = range.r1; r <= range.r2; r++) height += wb.rowHeight(sheet.id, r);
  const content = buildPrintSheet(wb, sheet.id, { range, area: 'selection', fit: 'actual', gridlines: false });
  // Include the portion of charts on that first page, without shrinking a long schedule to a speck.
  for (const chart of content.querySelectorAll('.print-object')) {
    width = Math.max(width, parseFloat(chart.style.left) + parseFloat(chart.style.width));
    height = Math.max(height, Math.min(840, parseFloat(chart.style.top) + parseFloat(chart.style.height)));
  }
  const padding = 28;
  const pageWidth = Math.max(width + padding * 2, (height + padding * 2) * 4 / 3);
  const pageHeight = pageWidth * 3 / 4;
  const page = document.createElement('div');
  page.setAttribute('style', `width:${width}px;font-family:Arial,sans-serif;color:#252a32;--font:Arial,sans-serif;--ink:#252a32;--hairline:#e5e7eb;`);
  const style = document.createElement('style');
  style.textContent = printCss;
  page.append(style, content);
  const markup = new XMLSerializer().serializeToString(page);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 ${pageWidth} ${pageHeight}"><rect width="100%" height="100%" fill="#fff"/><foreignObject x="${(pageWidth - width) / 2}" y="${padding}" width="${width}" height="${pageHeight - padding}">${markup}</foreignObject></svg>\n`;
  await writeFile(new URL(`${template.id}.svg`, output), svg);
}
dom.window.close();
