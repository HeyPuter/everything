import { it, expect } from 'vitest';
import { buildPdf, pageFragments, pageLinks, textLayer, utf16Hex } from '../src/lib/pdf-export.js';

// A 1×1 baseline JPEG (independently written bytes).
const JPEG = Uint8Array.from(atob('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/yQALCAABAAEBAREA/8wABgAQEAX/2gAIAQEAAD8A0s8g/9k='), c => c.charCodeAt(0));

it('writes a PDF whose cross-reference offsets point at their objects', () => {
  const page = { widthPx: 816, heightPx: 1056, jpeg: JPEG, imageWidth: 1, imageHeight: 1, fragments: [{ text: 'Hello café 漢字', x: 96, baseline: 120, width: 120, fontSize: 12 }] };
  const bytes = buildPdf([page, { ...page, fragments: [] }], { title: 'Report (draft)' });
  const text = new TextDecoder('latin1').decode(bytes);
  expect(text.startsWith('%PDF-1.7')).toBe(true);
  const xref = Number(/startxref\n(\d+)/.exec(text)[1]);
  expect(text.slice(xref, xref + 4)).toBe('xref');
  const offsets = [...text.slice(xref).matchAll(/^(\d{10}) 00000 n $/gm)].map(m => Number(m[1]));
  offsets.forEach((offset, i) => expect(text.slice(offset, offset + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`));
  expect(text.match(/\/Type \/Page /g)).toHaveLength(2);
  expect(text).toContain(`<${utf16Hex('Hello café 漢字')}> Tj`);
  expect(text).toContain('/Title (Report \\(draft\\))');
});

it('places invisible text at the run\'s baseline, scaled to its painted width', () => {
  const ops = textLayer([{ text: 'Abc', x: 100, baseline: 200, width: 40, fontSize: 10 }], 1056);
  expect(ops).toContain('3 Tr');
  expect(ops).toContain('1 0 0 1 75.00 642.00 Tm');
  expect(ops).toContain('/F1 10.00 Tf 200.00 Tz');
});

it('collects page text from body and story lines, skipping pictures and rotated cells', () => {
  const lines = [
    { page: 0, baseline: 50, fragments: [{ text: 'Body', x: 10, width: 30, fontSize: 12 }, { image: {}, text: '', x: 50 }] },
    { page: 0, baseline: 900, pageStory: 'word/footer1.xml', fragments: [{ text: 'Footer', x: 10, width: 40, fontSize: 10 }] },
    { page: 0, baseline: 60, cellText: { matrix: [0, 1, -1, 0] }, fragments: [{ text: 'Rotated', x: 0, width: 1, fontSize: 9 }] },
    { page: 1, baseline: 50, fragments: [{ text: 'Next', x: 0, width: 1, fontSize: 9 }] },
  ];
  expect(pageFragments(lines, 0).map(f => f.text)).toEqual(['Body', 'Footer']);
});

it('gives emoji and characters beyond the BMP back when text is copied, and keeps a non-ASCII title', async () => {
  const { execFileSync } = await import('node:child_process');
  const { writeFileSync, mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const page = { widthPx: 816, heightPx: 1056, jpeg: JPEG, imageWidth: 1, imageHeight: 1, fragments: [{ text: 'Smile 😀 and 𠀋 here', x: 96, baseline: 120, width: 200, fontSize: 12 }] };
  const bytes = buildPdf([page], { title: 'Café Q3 – 報告' });
  const text = new TextDecoder('latin1').decode(bytes);
  // Each character beyond the BMP has its own code, mapped back by the ToUnicode map.
  expect(text).toContain('<D800> <D83DDE00>');
  expect(text).toContain('<D801> <D840DC0B>');
  expect(text).not.toContain('<0000> <FFFF> <0000>');
  expect(text).toContain(`/Title <FEFF${utf16Hex('Café Q3 – 報告')}>`);
  let tools = true;
  try { execFileSync('pdftotext', ['-v'], { stdio: 'ignore' }); } catch { tools = false; }
  if (!tools) return;
  const file = join(mkdtempSync(join(tmpdir(), 'pdf-')), 'out.pdf');
  writeFileSync(file, bytes);
  expect(execFileSync('pdftotext', [file, '-'], { encoding: 'utf8' })).toContain('Smile 😀 and 𠀋 here');
  expect(execFileSync('pdfinfo', [file], { encoding: 'utf8' })).toContain('Café Q3 – 報告');
});

it('puts list numbers and bullets in the searchable text, before their item\'s text', async () => {
  const { TextDocument, paragraph } = await import('../src/engine/model.js');
  const { layoutDocument } = await import('../src/engine/layout.js');
  const measure = text => ({ width: [...text].length * 8, ascent: 12, descent: 3 });
  const doc = new TextDocument([paragraph()]);
  doc.replace('First step'); doc.toggleList('number');
  doc.insertParagraph(); doc.replace('Second step');
  doc.insertParagraph(); doc.replace('Point'); doc.toggleList('bullet');
  const { lines } = layoutDocument(doc.paragraphs, measure, undefined, doc.numbering, doc.tables);
  const fragments = pageFragments(lines, 0);
  expect(fragments.map(f => f.text)).toEqual(['1.', 'First step', '2.', 'Second step', '•', 'Point']);
  // The number sits where it is painted, left of the text, on the same baseline.
  const [number, text] = fragments;
  expect(number.x).toBe(lines[0].marker.x);
  expect(number.x).toBeLessThan(text.x);
  expect(number.baseline).toBe(text.baseline);
  expect(number.width).toBeGreaterThan(0);
  expect(number.fontSize).toBeGreaterThan(0);
});

it('makes web, mail and phone links clickable where their text is on the page', async () => {
  const { TextDocument, paragraph } = await import('../src/engine/model.js');
  const { layoutDocument } = await import('../src/engine/layout.js');
  const measure = text => ({ width: [...text].length * 8, ascent: 12, descent: 3 });
  const doc = new TextDocument([paragraph()]);
  doc.replace('Read the guide now. ');
  doc.select(9, 14); doc.setHyperlink('https://example.com/a(b)?q=ü%20x');
  doc.select(doc.text.length); doc.replace('Mail us');
  doc.select(doc.text.length - 7, doc.text.length); doc.setHyperlink('mailto:team@example.com');
  doc.select(doc.text.length); doc.insertParagraph(); doc.replace('Unsafe');
  doc.select(doc.text.length - 6, doc.text.length);
  try { doc.setHyperlink('javascript:alert(1)'); } catch { /* refused */ }
  const layout = layoutDocument(doc.paragraphs, measure, undefined, doc.numbering, doc.tables);
  const links = pageLinks(doc.paragraphs, layout);
  expect(links.map(l => [l.page, l.target])).toEqual([[0, 'https://example.com/a(b)?q=ü%20x'], [0, 'mailto:team@example.com']]);
  const [guide] = links, fragment = layout.lines[0].fragments.find(f => f.text.includes('guide'));
  // The area covers the linked word on its line: "guide" starts 9 characters (72 px) into the line.
  expect(guide.x).toBeCloseTo(layout.lines[0].fragments[0].x + 72, 0);
  expect(guide.width).toBeCloseTo(40, 0);
  expect(guide.y).toBeLessThanOrEqual(layout.lines[0].baseline - 12);
  expect(guide.y + guide.height).toBeGreaterThanOrEqual(layout.lines[0].baseline);
  expect(fragment).toBeTruthy();
  const page = { widthPx: 816, heightPx: 1056, jpeg: JPEG, imageWidth: 1, imageHeight: 1, fragments: [], links: links.filter(l => l.page === 0) };
  const text = new TextDecoder('latin1').decode(buildPdf([page]));
  expect(text.match(/\/Subtype \/Link/g)).toHaveLength(2);
  // An address is written as ASCII, with its brackets escaped, and points at its text (PDF points from the bottom).
  expect(text).toContain('/URI (https://example.com/a\\(b\\)?q=%C3%BC%20x)');
  expect(text).toContain('/URI (mailto:team@example.com)');
  const rect = /\/Rect \[([\d. ]+)\][^]*?https:\/\/example/.exec(text)[1].split(' ').map(Number);
  expect(rect[0]).toBeCloseTo(guide.x * 0.75, 1);
  expect(rect[3]).toBeCloseTo((1056 - guide.y) * 0.75, 1);
  expect(text).toMatch(/\/Annots \[\d+ 0 R \d+ 0 R\]/);
  // The cross-reference table still finds every object.
  const xref = Number(/startxref\n(\d+)/.exec(text)[1]);
  [...text.slice(xref).matchAll(/^(\d{10}) 00000 n $/gm)].map(m => Number(m[1])).forEach((offset, i) => expect(text.slice(offset, offset + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`));
});

it('writes right-to-left text in the order it is painted, so readers copy and search it in reading order', async () => {
  const { paragraph } = await import('../src/engine/model.js');
  const { RUN_FORMAT } = await import('../src/engine/formatting.js');
  const { layoutDocument } = await import('../src/engine/layout.js');
  const measure = text => ({ width: [...text].length * 8, ascent: 12, descent: 3 });
  const p = paragraph('');
  p.runs = [{ ...RUN_FORMAT, text: 'שָׁלוֹם', rtl: true }];
  const line = layoutDocument([p], measure).lines[0];
  const fragments = pageFragments([line], 0);
  expect(fragments.map(f => [f.text, f.rtl])).toEqual([['שָׁלוֹם', true]]);
  // A PDF holds glyphs left to right as they stand on the page: the last letter first, each with its marks.
  const ops = textLayer(fragments, 1056);
  const visual = ['ם', 'וֹ', 'ל', 'שָׁ'].join('');
  expect(ops).toContain(`<${utf16Hex(visual)}> Tj`);
  expect(textLayer([{ text: 'abc', x: 0, baseline: 10, width: 24, fontSize: 12 }], 1056)).toContain(`<${utf16Hex('abc')}> Tj`);
});

it('writes right-to-left words inside left-to-right text in the order they are painted', async () => {
  const { visualText } = await import('../src/lib/pdf-export.js');
  expect(visualText('Hello world')).toBe('Hello world');
  expect(visualText('שלום עולם 2024 and Word')).toBe('2024 םלוע םולש and Word');
  // Brackets in right-to-left text are painted mirrored; numbers after it keep their own order.
  expect(visualText('ראה (כאן) 12')).toBe('12 (ןאכ) האר');
});
