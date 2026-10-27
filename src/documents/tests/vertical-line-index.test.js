import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { TextDocument } from '../src/engine/model.js';
import { layoutDocument, verticalLine } from '../src/engine/layout.js';
import { pageGeometry } from '../src/engine/page-settings.js';

let dom;
beforeAll(() => { dom = new JSDOM(''); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => { dom.window.close(); delete globalThis.DOMParser; delete globalThis.XMLSerializer; });

// verticalLine as it was before its lines and cell boxes were indexed per layout: every step copied all
// lines, indexed every cell box and sorted the candidates. The indexed one must choose the same line.
const physicalWidth = (layout, page) => (layout.pages?.[page] || layout.page).width;
const visibleCellLine = line => !line.cellClip || line.y < line.cellClip.bottom && line.y + Math.max(line.height, 1) > line.cellClip.top && (line.cellClip.left === undefined || (line.cellText ? line.x + line.width > line.cellClip.left && line.x < line.cellClip.right : line.stops.at(-1).x >= line.cellClip.left && line.stops[0].x < line.cellClip.right));
const visiblePageLine = (layout, line) => visibleCellLine(line) && (line.cellText ? line.x + line.width >= 0 && line.x < physicalWidth(layout, line.page) : line.stops.at(-1).x >= 0 && line.stops[0].x < physicalWidth(layout, line.page));
const pageStart = (layout, page) => layout.pageOffsets?.[page] ?? page * layout.page.height;
function referenceVerticalLine(layout, line, direction, x) {
  if (line.cellText) {
    const localY = line.cellText.line.y;
    return [...layout.lines, ...(layout.repeatedLines || [])]
      .filter(candidate => candidate.cellText && candidate.cellId === line.cellId && candidate.page === line.page
        && candidate.column === line.column && visiblePageLine(layout, candidate)
        && direction * (candidate.cellText.line.y - localY) > 1e-6)
      .sort((a, b) => Math.abs(a.cellText.line.y - localY) - Math.abs(b.cellText.line.y - localY))[0];
  }
  let flowHeight = 0;
  const flowOffsets = layout.pages?.some(p => p.columns && !p.storyKind) ? layout.pages.map(p => { const start = flowHeight; flowHeight += p.height * (p.columns?.count || 1); return start; }) : null;
  let regionOffset = 0;
  const regionFlows = layout.pageRegions?.some(regions => regions?.length > 1) ? layout.pageRegions.map(regions => (regions || []).map(region => {
    const offset = regionOffset, height = Math.max(1, region.bottom - region.top);
    regionOffset += height * (region.geometry.columns?.count || 1);
    return { offset, height, top: region.top };
  })) : null;
  const flowStart = l => {
    const region = regionFlows?.[l.page]?.[l.region];
    return region ? region.offset + (l.column || 0) * region.height - region.top
      : flowOffsets ? flowOffsets[l.page] + (l.column || 0) * layout.pages[l.page].height : pageStart(layout, l.page);
  };
  const y = l => flowStart(l) + (l.cellClip ? Math.max(l.cellClip.top, Math.min(l.y + l.height / 2, l.cellClip.bottom)) : l.y + l.height / 2);
  const rowId = layout.cells?.find(c => c.id === line.cellId)?.rowId;
  const rowCells = new Set(rowId ? layout.cells.filter(c => c.rowId === rowId).map(c => c.id) : []);
  const boxes = new Map((layout.cells || []).map(c => [`${c.id}/${c.page}/${c.column ?? 0}`, c]));
  const current = (layout.cells || []).filter(c => c.id === line.cellId && (!line.header || c.page === line.page));
  const candidates = [...layout.lines, ...(layout.repeatedLines || [])].filter(l => {
    if (!visiblePageLine(layout, l)) return false;
    if (direction * (y(l) - y(line)) <= 1e-6) return false;
    if (l.cellId === line.cellId) return !line.header || l.page === line.page;
    const box = boxes.get(`${l.cellId}/${l.page}/${l.column ?? 0}`);
    return !rowCells.has(l.cellId) && !current.some(c => box && box.page === c.page && box.column === c.column && box.y < c.y + c.height - 1e-6 && box.y + box.height > c.y + 1e-6);
  });
  const inCell = line.cellId ? candidates.filter(l => l.cellId === line.cellId) : [];
  const distance = l => {
    const cell = boxes.get(`${l.cellId}/${l.page}/${l.column ?? 0}`);
    const targetX = x + (l.columnOffset || 0) - (line.columnOffset || 0);
    return cell ? Math.max(cell.x - targetX, 0, targetX - cell.x - cell.width) : Math.max(l.stops[0].x - targetX, 0, targetX - l.stops.at(-1).x);
  };
  const verticalDistance = l => {
    const cell = boxes.get(`${l.cellId}/${l.page}/${l.column ?? 0}`);
    return cell ? Math.max(0, direction * (flowStart(cell) + cell.y + (direction < 0 ? cell.height : 0) - y(line))) : Math.abs(y(l) - y(line));
  };
  if (inCell.length) return inCell.sort((a,b) => Math.abs(y(a) - y(line)) - Math.abs(y(b) - y(line)))[0];
  return candidates.sort((a,b) => verticalDistance(a) - verticalDistance(b) || distance(a) - distance(b) || Math.abs(y(a) - y(line)) - Math.abs(y(b) - y(line)))[0];
}

const measure = (text, style) => ({ width: [...text].length * style.fontSize * 2 / 3, ascent: style.fontSize * 1.25, descent: style.fontSize * 5 / 12 });
const open = async bytes => {
  const pkg = await DocxPackage.open(bytes);
  return new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
};
const layout = doc => layoutDocument(doc.paragraphs, measure, pageGeometry(doc.pageSettings), doc.numbering, doc.tables);
// table-headers.docx with its first table's last row copied: a table over many pages with header rows repeated on each.
function longTable(rows) {
  const parts = unzipSync(readFileSync('public/fixtures/table-headers.docx'));
  const xml = new DOMParser().parseFromString(strFromU8(parts['word/document.xml']), 'application/xml');
  const table = xml.getElementsByTagNameNS('*', 'tbl')[0], last = [...table.childNodes].filter(n => n.localName === 'tr').at(-1);
  for (let i = 0; i < rows; i++) table.insertBefore(last.cloneNode(true), last);
  parts['word/document.xml'] = strToU8(new XMLSerializer().serializeToString(xml));
  return zipSync(parts);
}
// Each line, up and down, from where its caret stops are, from both page edges and from beside the line.
function expectSameSteps(result, every = 1) {
  const lines = [...result.lines, ...(result.repeatedLines || [])];
  let steps = 0, found = 0;
  lines.forEach((line, i) => {
    if (i % every) return;
    const stops = line.stops || [];
    const xs = [stops[0]?.x ?? 0, stops[stops.length >> 1]?.x ?? 0, stops.at(-1)?.x ?? 0, 0, -40, (result.pages?.[line.page] || result.page).width + 40, (stops[0]?.x ?? 0) + 0.25];
    for (const direction of [-1, 1]) for (const x of xs) {
      const expected = referenceVerticalLine(result, line, direction, x);
      expect(verticalLine(result, line, direction, x), `line ${i} direction ${direction} x ${x}`).toBe(expected);
      steps++; if (expected) found++;
    }
  });
  return { steps, found };
}

const fixtures = [
  'public/fixtures/table-headers.docx', // header rows repeated on every page of a table
  'public/fixtures/merged-cells.docx', // merged cells across columns and rows
  'public/fixtures/vertical-cells.docx', // vertically merged cells
  'tests/fixtures/cell-text-direction/control.docx', // rotated cell text
  'tests/fixtures/cell-text-direction/links.docx',
  'public/fixtures/tables.docx',
  'public/fixtures/square-wrap-flow.docx', // text wrapped around square pictures
  'public/fixtures/mixed-page-sizes.docx',
  'public/fixtures/vertical-pages.docx',
  'tests/fixtures/column-flow/unequal.docx', // newspaper columns
  'tests/fixtures/column-flow/table-flow.docx',
  'tests/fixtures/continuous-sections/overflow.docx', // regions with different columns on one page
  'tests/fixtures/continuous-sections/table.docx',
  'tests/fixtures/rtl-runs/control.docx', // right-to-left text
  'tests/fixtures/bidi-layout/control.docx',
];
// What each fixture brings to the comparison is there in its layout.
const features = {
  'public/fixtures/table-headers.docx': r => r.repeatedLines.length > 0,
  // A vertically merged cell beside rows of its own.
  'public/fixtures/vertical-cells.docx': r => r.cells.some(c => r.cells.some(o => o.rowId !== c.rowId && o.page === c.page && o.y > c.y + 1 && o.y < c.y + c.height - 1)),
  'tests/fixtures/cell-text-direction/control.docx': r => r.lines.some(l => l.cellText),
  'tests/fixtures/cell-text-direction/links.docx': r => r.lines.some(l => l.cellText),
  'public/fixtures/square-wrap-flow.docx': r => r.lines.some(l => l.wrapSegments),
  'tests/fixtures/column-flow/unequal.docx': r => r.pages.some(p => p.columns?.count > 1),
  'tests/fixtures/continuous-sections/overflow.docx': r => r.pageRegions.some(regions => regions?.length > 1),
  'tests/fixtures/rtl-runs/control.docx': r => r.lines.some(l => l.bidi),
  'tests/fixtures/bidi-layout/control.docx': r => r.lines.some(l => l.bidi),
};
for (const file of fixtures) it(`steps to the same line up and down as before in ${file}`, async () => {
  const result = layout(await open(readFileSync(file)));
  const feature = features[file];
  if (feature) expect(feature(result)).toBe(true);
  const { steps, found } = expectSameSteps(result);
  expect(found).toBeGreaterThan(0); expect(steps).toBeGreaterThan(found);
});

it('steps to the same lines through a table with repeated header rows over many pages', async () => {
  const result = layout(await open(longTable(90)));
  expect(result.pageCount).toBeGreaterThan(4); expect(result.repeatedLines.length).toBeGreaterThan(0);
  expectSameSteps(result, 3);
});

it('reads a long table\'s lines once for many steps and follows a later layout', async () => {
  const doc = await open(longTable(300)), result = layout(doc);
  let reads = 0;
  const counted = Array.prototype[Symbol.iterator];
  Object.defineProperty(result.lines, Symbol.iterator, { value() { reads++; return counted.call(this); } });
  // PageDown takes one step per line on screen, all from one layout.
  let line = result.lines.find(l => l.cellId), steps = 0;
  const x = line.stops[0].x;
  for (let next; steps < 120 && (next = verticalLine(result, line, 1, x)); steps++) { expect(next).toBe(referenceVerticalLine(result, line, 1, x)); line = next; }
  expect(steps).toBe(120);
  reads = 0;
  for (let i = 0; i < 40; i++) verticalLine(result, line, i % 2 ? 1 : -1, x);
  expect(reads).toBe(0);
  // An edit lays the document out anew: steps read that layout, not the old one.
  doc.select(line.start); doc.replace('Inserted words that wrap the cell onto more lines than before. '.repeat(3));
  const edited = layout(doc), at = edited.lines.find(l => l.cellId === line.cellId);
  for (const direction of [-1, 1]) expect(verticalLine(edited, at, direction, x)).toBe(referenceVerticalLine(edited, at, direction, x));
  // The same layout with its lines replaced is indexed again.
  const replaced = { ...result, lines: result.lines.slice(0, Math.floor(result.lines.length / 2)) };
  const half = replaced.lines.at(-1);
  expect(verticalLine(replaced, half, 1, x)).toBe(referenceVerticalLine(replaced, half, 1, x));
  result.lines = replaced.lines;
  expect(verticalLine(result, half, 1, x)).toBe(referenceVerticalLine(result, half, 1, x));
  expect(verticalLine(result, half, -1, x)).toBe(referenceVerticalLine(result, half, -1, x));
});

it('chooses as before when the preferred place is not a number', async () => {
  const result = layout(await open(readFileSync('public/fixtures/table-headers.docx')));
  for (const line of [...result.lines, ...result.repeatedLines].filter((l, i) => i % 3 === 0)) for (const direction of [-1, 1])
    for (const x of [undefined, NaN]) expect(verticalLine(result, line, direction, x)).toBe(referenceVerticalLine(result, line, direction, x));
});
