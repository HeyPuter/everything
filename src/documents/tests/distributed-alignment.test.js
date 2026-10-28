import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { TextDocument, paragraph, paragraphText } from '../src/engine/model.js';
import { layoutDocument, caretRect, hitTest } from '../src/engine/layout.js';
import { pageGeometry } from '../src/engine/page-settings.js';
import { canvasWordSpacing, canvasLetterSpacing } from '../src/engine/canvas-text.js';

let dom;
beforeAll(() => { dom = new JSDOM(''); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => { dom.window.close(); delete globalThis.DOMParser; delete globalThis.XMLSerializer; });
// Canvas metrics: letter spacing follows every character, word spacing every space.
const measure = (text, style) => ({ width: [...text].length * (8 + canvasLetterSpacing(style)) + (text.match(/[  ]/g)?.length || 0) * canvasWordSpacing(style), ascent: 12, descent: 4 });
// A 200 px writing width.
const layout = (text, format = {}) => layoutDocument([paragraph(text, { format: { spaceAfter: 0, alignment: 'distribute', ...format } })], measure, { width: 220, height: 2000, margin: 10 });
const edge = line => Math.max(...line.stops.map(s => s.x)) - (line.hangingRight ? 0 : line.ignoredTrailingWidth);

it('distributes every line, the last one too, by equal gaps between all characters (§17.18.44 distribute)', () => {
  const text = 'Alpha beta gamma delta epsilon zeta eta theta', result = layout(text);
  expect(result.lines.length).toBeGreaterThan(1);
  for (const line of result.lines) expect(edge(line)).toBeCloseTo(210, 5);
  // The last line, "epsilon zeta eta theta" (22 characters, 21 gaps), spreads across the whole measure.
  const last = result.lines.at(-1), xs = last.stops.map(s => s.x).sort((a, b) => a - b);
  expect(text.slice(last.start, last.end)).toBe('epsilon zeta eta theta');
  const steps = xs.slice(1).map((x, i) => x - xs[i]);
  for (const step of steps.slice(0, -1)) expect(step).toBeCloseTo(steps[0], 5);
  expect(steps[0]).toBeCloseTo(8 + (200 - 22 * 8) / 21, 5);
  // Carets and pointer hits follow the spread characters.
  const caret = caretRect(result, last.start + 2);
  expect(hitTest(result, caret.page, caret.x + 1, caret.y + caret.height / 2)).toBe(last.start + 2);
  // A single word of one paragraph is spread as well; an empty paragraph keeps its caret.
  expect(edge(layout('Title').lines[0])).toBeCloseTo(210, 5);
  expect(layout('').lines).toHaveLength(1);
});

it('opens and keeps distributed paragraphs editable, and sets distributed alignment', async () => {
  const source = readFileSync('public/fixtures/justification.docx'), parts = unzipSync(source);
  parts['word/document.xml'] = strToU8(strFromU8(parts['word/document.xml']).replace('<w:jc w:val="both"/>', '<w:jc w:val="distribute"/>'));
  const pkg = await DocxPackage.open(zipSync(parts));
  const doc = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables);
  expect(doc.paragraphs.some(p => p.format.alignment === 'distribute')).toBe(true);
  expect(() => layoutDocument(doc.paragraphs, measure, pageGeometry(doc.pageSettings), doc.numbering, doc.tables)).not.toThrow();
  const fresh = new TextDocument([paragraph('One two')], { width: 5400, left: 720, right: 720 });
  fresh.setParagraphFormat({ alignment: 'distribute' });
  expect(fresh.paragraphs[0].format.alignment).toBe('distribute');
  expect(paragraphText(fresh.paragraphs[0])).toBe('One two');
});
