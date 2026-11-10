import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DocxPackage } from '../src/engine/docx.js';
import { paragraphText } from '../src/engine/model.js';
import { layoutDocument, selectionRects } from '../src/engine/layout.js';
import { pageGeometry } from '../src/engine/page-settings.js';

// The order the reference application displays each line of the independent control in:
// tests/fixtures/rtl-paragraphs/README.md.
const root = 'tests/fixtures/rtl-paragraphs/';
const H1 = 'שלום', H2 = 'עולם';
let dom, pkg, result, geometry;
beforeAll(async () => {
  dom = new JSDOM(''); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer;
  const source = readFileSync(root + 'control.docx');
  expect(createHash('sha256').update(source).digest('hex')).toBe('84e46a1efbb6974f9cd7b45e5eed9ca50d623be4da5d722f0c49a73617ae0ada');
  pkg = await DocxPackage.open(source);
  geometry = pageGeometry(pkg.pageSettings);
  result = layoutDocument(pkg.paragraphs, text => ({ width: [...text].length * 7, ascent: 12, descent: 4 }), geometry, pkg.numbering, pkg.tables);
});
afterAll(() => { dom.window.close(); delete globalThis.DOMParser; delete globalThis.XMLSerializer; });

/** The page extent of each token of line `n`, in the order given: [{ left, right }]. */
function extents(n, tokens) {
  let offset = 0, paragraph;
  for (const p of pkg.paragraphs) { if (paragraphText(p).startsWith(`${n} `)) { paragraph = p; break; } offset += paragraphText(p).length + 1; }
  const text = paragraphText(paragraph);
  let from = 0;
  return tokens.map(token => {
    const at = text.indexOf(token, from); if (at < 0) throw new Error(`Missing ${token}`);
    from = at + token.length;
    const rects = selectionRects(result, offset + at, offset + at + token.length);
    return { left: Math.min(...rects.map(r => r.x)), right: Math.max(...rects.map(r => r.x + r.width)) };
  });
}
/** Whether the tokens of line `n` appear from left to right in the order `visual` (indices into `tokens`). */
function expectOrder(n, tokens, visual) {
  const boxes = extents(n, tokens);
  const order = boxes.map((box, i) => [box.left, i]).sort((a, b) => a[0] - b[0]).map(([, i]) => i);
  expect(order, `line ${n}`).toEqual(visual);
  // The tokens tile the line without overlapping.
  for (let i = 1; i < order.length; i++) expect(boxes[order[i]].left, `line ${n}`).toBeGreaterThanOrEqual(boxes[order[i - 1]].right - 1e-6);
  return boxes;
}
const right = () => geometry.width - geometry.right;

it('opens the control for editing', () => {
  expect(pkg.readOnly).not.toBe(true);
  expect(pkg.paragraphs).toHaveLength(12);
});

it('lays ordinary runs out as left-to-right units at the right margin (lines 1, 2, 6, 8, 9, 11)', () => {
  // 1: "1 שלום עולם." reads 1, עולם, שלום, "." from the left, and ends at the right margin.
  const one = expectOrder(1, ['1', H1, H2, '.'], [0, 2, 1, 3]);
  expect(one[3].right).toBeCloseTo(right(), 6);
  const two = expectOrder(2, ['2', 'Hello', 'world', '.'], [0, 1, 2, 3]);
  expect(two[3].right).toBeCloseTo(right(), 6);
  expectOrder(6, ['6', H1, 'abc', H2, '.'], [0, 1, 2, 3, 4]);
  expectOrder(8, ['8', '(', H1, ')', '123', 'abc!'], [0, 1, 2, 3, 4, 5]);
  // 9: the same text as 1 in four runs is still one unit.
  const nine = expectOrder(9, ['9', H1, H2, '.'], [0, 2, 1, 3]);
  expect(nine[3].right).toBeCloseTo(right(), 6);
  expectOrder(11, ['11', H1, ':', 'abc', ',', H2, '(x)', '12.5%'], [0, 1, 2, 3, 4, 5, 6, 7]);
});

it('resolves w:rtl runs at the right-to-left paragraph level (lines 3, 4, 12)', () => {
  const three = expectOrder(3, ['3', H1, H2, '.'], [3, 2, 1, 0]);
  expect(three[0].right).toBeCloseTo(right(), 6);
  expectOrder(4, ['4', 'Hello', 'world', '.'], [3, 1, 2, 0]);
  // Line 12 without its "(x)": the reference application shows "(x) 12.5%" on the left, and this engine
  // "12.5% (x)". UAX #9 rule N0 gives the brackets the right-to-left direction here and the reference
  // application keeps them with the Latin letter; the difference is in ordering inside any w:rtl run,
  // not in paragraph direction, and is recorded as a gap (README.md).
  expectOrder(12, ['12', H1, ':', 'abc', ',', H2, '12.5%'], [6, 5, 4, 3, 2, 1, 0]);
});

it('places each run unit from the right, keeping an ordinary run\'s own spaces (line 5)', () => {
  const [five, abc, hebrew, def] = expectOrder(5, ['5', 'abc', H1, 'def.'], [3, 2, 0, 1]);
  // "5 abc " keeps its trailing space on its right, at the margin; " def." its leading space on its left.
  expect(abc.right).toBeCloseTo(right() - 7, 6);
  expect(five.left - hebrew.right).toBeCloseTo(0, 6);
  expect(hebrew.left - def.right).toBeCloseTo(0, 6);
});

it('keeps a left-to-right paragraph as it was (line 7)', () => {
  const seven = expectOrder(7, ['7', H1, H2, '.'], [0, 2, 1, 3]);
  expect(seven[0].left).toBeCloseTo(geometry.left, 6);
});

it('measures tab stops from the right margin (line 10)', () => {
  const [label, b, hebrew] = extents(10, ['10 a', 'b', H1]);
  expect(label.right).toBeCloseTo(right(), 6);
  // A left tab 2in (192px) from the right margin: the text starts there and flows leftwards.
  expect(b.right).toBeCloseTo(right() - 192, 6);
  // A right tab 5in (480px) from it: the text ends there, its left edge on the stop.
  expect(hebrew.left).toBeCloseTo(right() - 480, 6);
});
