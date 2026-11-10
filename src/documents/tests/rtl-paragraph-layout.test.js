import { it, expect } from 'vitest';
import { paragraph } from '../src/engine/model.js';
import { RUN_FORMAT } from '../src/engine/formatting.js';
import { directedRuns } from '../src/engine/script-input.js';
import { layoutDocument, caretRect, hitTest, selectionRects } from '../src/engine/layout.js';
import { formattingMarks } from '../src/engine/formatting-marks.js';

// Every character is 10px wide: positions below are exact. The text area runs from x=20 to x=980.
// Justified lines widen their spaces by `justificationSpacing`, as the canvas does with word spacing.
const measure = (text, style = {}) => ({ width: [...text].length * 10 + [...text].filter(c => c === ' ').length * (style.justificationSpacing || 0), ascent: 12, descent: 3 });
const page = { width: 1000, height: 400, margin: 20 };
// A right-to-left paragraph whose runs carry the direction of their text, as text typed in one does
// (directedRuns): Hebrew and the spaces and punctuation that read with it are w:rtl runs, Latin is not.
const rtl = (text, format = {}) => { const p = paragraph(text, { format: { bidi: true, ...format } }); p.runs = directedRuns(p.runs, 0, text.length); return p; };
// One with the given runs: [text, rtl] pairs.
const rtlRuns = (pairs, format = {}) => ({ ...paragraph('', { format: { bidi: true, ...format } }), runs: pairs.map(([text, flag]) => ({ ...RUN_FORMAT, text, rtl: !!flag, properties: '', overrides: {} })) });
const layout = (...paragraphs) => layoutDocument(paragraphs, measure, page);
const boxes = line => line.fragments.map(f => [f.text, f.x, f.width]);

// ECMA-376 Part 1 §17.3.1.6: a bidi paragraph starts at the right margin and is ordered from a right-to-left base.
it('starts a right-to-left paragraph at the right margin and orders mixed text from a right-to-left base', () => {
  const result = layout(rtl('abc שלום def')), line = result.lines[0];
  // Logical order abc, Hebrew, def reads from the right: abc is rightmost, each Latin word left to right.
  expect(boxes(line)).toEqual([['def', 860, 30], [' שלום ', 890, 60], ['abc', 950, 30]]);
  expect(line.rtl).toBe(true);
  expect(caretRect(result, 0).x).toBe(950);
  // The Hebrew word advances leftwards: after its first letter the caret is 10px further left.
  expect(caretRect(result, 4).x).toBe(940);
  expect(caretRect(result, 5).x).toBe(930);
  expect(hitTest(result, 0, 931, line.y + 5)).toBe(5);
  // A click beyond the right margin lands at the line's start; one in the empty space left of the
  // text at the nearest caret, which is the line's end when the line ends in right-to-left text.
  const hebrew = layout(rtl('שלום abc שלום'));
  expect(hitTest(hebrew, 0, 995, hebrew.lines[0].y + 5)).toBe(0);
  expect(hitTest(hebrew, 0, 100, hebrew.lines[0].y + 5)).toBe(13);
  // The paragraph mark's selection follows the whole line, on its left.
  const mark = selectionRects(result, 0, 13).at(-1);
  expect(mark.x + mark.width).toBe(860);
});

// Verified in the reference application (tests/fixtures/rtl-paragraphs/README.md): a run without w:rtl is
// a left-to-right island in a right-to-left paragraph, and consecutive ones form a single island.
it('keeps runs without w:rtl as left-to-right islands, and resolves rtl runs at the paragraph level', () => {
  // "Hello." in an ordinary run stays as written, at the right margin.
  expect(boxes(layout(rtlRuns([['Hello.', false]])).lines[0])).toEqual([['Hello.', 920, 60]]);
  // In an rtl run its period is right-to-left punctuation and ends the sentence on the left.
  expect(boxes(layout(rtlRuns([['Hello.', true]])).lines[0])).toEqual([['.', 920, 10], ['Hello', 930, 50]]);
  // Hebrew in an ordinary run reads right to left inside its island; the island's period stays on its right.
  const island = layout(rtlRuns([['אב גד.', false]])).lines[0];
  expect(boxes(island)).toEqual([['אב גד', 920, 50], ['.', 970, 10]]);
  // Three runs, ordinary, rtl, ordinary: each island keeps its own spaces, and the units run from the right.
  const mixed = layout(rtlRuns([['5 abc ', false], ['אב', true], [' def.', false]])).lines[0];
  expect(boxes(mixed)).toEqual([[' def.', 850, 50], ['אב', 900, 20], ['5 abc ', 920, 60]]);
  // Consecutive ordinary runs are one island, however they are split.
  const split = layout(rtlRuns([['9 אב', false], [' ', false], ['גד', false], ['.', false]])).lines[0];
  expect(Math.min(...split.fragments.filter(f => f.text.includes('9')).map(f => f.x))).toBe(900);
  expect(split.fragments.find(f => f.text === '.').x).toBe(970);
});

it('marks typed text with the direction of its letters, as plain right-to-left ordering shows it', () => {
  const directions = text => directedRuns([{ ...RUN_FORMAT, text, properties: '', overrides: {} }], 0, text.length).map(r => [r.text, !!r.rtl]);
  expect(directions('שלום עולם.')).toEqual([['שלום עולם.', true]]);
  // A Latin phrase keeps its inner space; the spaces beside Hebrew and the final period are right-to-left.
  expect(directions('אב abc def גד.')).toEqual([['אב ', true], ['abc def', false], [' גד.', true]]);
  expect(directions('Hello world.')).toEqual([['Hello world', false], ['.', true]]);
  // A number after a Latin word reads with it; one in Hebrew text stays with the Hebrew, signs included.
  expect(directions('abc 123')).toEqual([['abc 123', false]]);
  expect(directions('אב 12.5% abc, 12 גד')).toEqual([['אב 12.5% ', true], ['abc, 12', false], [' גד', true]]);
  expect(directions('12/05/2024')).toEqual([['12/05/2024', true]]);
  // An untouched run comes back as it was.
  const runs = [{ ...RUN_FORMAT, text: 'abc', properties: '', overrides: {} }];
  expect(directedRuns(runs, 0, 3)).toBe(runs);
  // Only the inserted text and the neutrals beside it are looked at: "גד" inserted after "abc ".
  const typed = directedRuns([{ ...RUN_FORMAT, text: 'אב. abc גד', properties: '', overrides: {} }], 8, 10).map(r => [r.text, !!r.rtl]);
  expect(typed).toEqual([['אב. abc', false], [' גד', true]]);
  // Text that becomes right-to-left keeps its visible size and weight in the complex-script properties.
  const heading = directedRuns([{ ...RUN_FORMAT, text: 'אב ab', fontSize: 20, bold: true, properties: '', overrides: {} }], 0, 5);
  expect(heading.map(r => [r.text, !!r.rtl, r.fontSizeCs, r.boldCs, r.overrides.fontSizeCs, r.overrides.boldCs])).toEqual([['אב ', true, 20, true, 20, true], ['ab', false, 12, false, undefined, undefined]]);
  // A deletion point re-reads the neutrals around it: a right-to-left space left between two Latin words.
  const joined = directedRuns([{ ...RUN_FORMAT, text: 'abc', properties: '', overrides: {} }, { ...RUN_FORMAT, text: ' ', rtl: true, properties: '', overrides: { rtl: true } }, { ...RUN_FORMAT, text: 'def', properties: '', overrides: {} }], 4, 4);
  expect(joined.map(r => [r.text, !!r.rtl, r.overrides.rtl])).toEqual([['abc', false, undefined], [' ', false, false], ['def', false, undefined]]);
  expect(joined[1].overrides).toEqual({ rtl: false, cs: false });
});

it('gives an empty right-to-left paragraph its caret and paragraph mark at the right margin', () => {
  const result = layout(rtl(''), paragraph('next'));
  expect(caretRect(result, 0).x).toBe(980);
  const [mark] = selectionRects(result, 0, 1);
  expect(mark.x + mark.width).toBe(980);
  expect(mark.x).toBeLessThan(980);
});

// §17.3.1.13 jc and §17.3.1.12 ind are read from the leading edge, which is the right one here.
it('reads alignment and indents from the leading (right) edge', () => {
  const at = format => layout(rtl('abc', format)).lines[0].fragments[0].x;
  expect(at({ alignment: 'left' })).toBe(950);   // the leading edge
  expect(at({ alignment: 'right' })).toBe(20);   // the trailing edge
  expect(at({ alignment: 'center' })).toBe(485);
  expect(at({ indentLeft: 300 })).toBe(930);     // 20px in from the right
  expect(at({ indentRight: 300, alignment: 'right' })).toBe(40);
  expect(at({ indentLeft: 300, firstLine: 150 })).toBe(920);
  expect(at({ indentLeft: 300, firstLine: -150 })).toBe(940);
});

it('wraps to the next line at the left edge and hangs trailing spaces past it', () => {
  const words = Array.from({ length: 15 }, () => 'abcd').join(' ');
  const result = layout(rtl(`${words} ${words}`)), [first, second] = result.lines;
  expect(result.lines).toHaveLength(2);
  // 19 words and 18 spaces (940px) fit; the 20th would end at 990. The line's trailing space hangs left of x=40.
  expect(Math.min(...first.fragments.filter(f => f.text.trim()).map(f => f.x))).toBe(40);
  expect(Math.max(...first.fragments.map(f => f.x + f.width))).toBe(980);
  expect(first.stops.at(-1).x).toBe(30);
  expect(Math.max(...second.fragments.map(f => f.x + f.width))).toBe(980);
});

it('clips spaces hanging past the left edge to that edge for carets and selection', () => {
  const text = `${'a'.repeat(95)}${' '.repeat(5)}b`;
  const result = layout(rtl(text)), line = result.lines[0];
  expect(line.end).toBe(100);
  expect(line.hangingLeft).toBe(20);
  expect(caretRect(result, 99, 'backward').x).toBe(20);
  expect(Math.min(...selectionRects(result, 95, 100).map(r => r.x))).toBe(20);
});

it('justifies a wrapped line between both edges', () => {
  const words = Array.from({ length: 15 }, () => 'abcd').join(' ');
  const [first, last] = layout(rtl(`${words} ${words}`, { alignment: 'both' })).lines;
  const ink = first.fragments.filter(f => f.text.trim());
  expect(Math.min(...ink.map(f => f.x))).toBeCloseTo(20, 6);
  expect(Math.max(...ink.map(f => f.x + f.width))).toBeCloseTo(980, 6);
  expect(first.justificationSpacing).toBeGreaterThan(0);
  // The last line keeps its natural spacing, from the right.
  expect(last.justificationSpacing).toBeUndefined();
  expect(Math.max(...last.fragments.map(f => f.x + f.width))).toBe(980);
});

// Tab positions are measured from the leading edge, and a field's text is still ordered inside it.
it('advances tab fields leftwards from the right margin', () => {
  const result = layout(rtl('a\tb', { tabs: [{ position: 1500, alignment: 'left', leader: 'none' }] })), line = result.lines[0];
  expect(boxes(line)).toEqual([['a', 970, 10], ['b', 870, 10]]); // the stop is 100px from the right margin
  const centered = layout(rtl('a\tbcd', { tabs: [{ position: 1500, alignment: 'center', leader: 'none' }] })).lines[0];
  expect(centered.fragments[1].x + 15).toBe(880);
  const marks = formattingMarks(result.lines, 'a\tb', [rtl('a\tb')], {}, { width: 1000, left: 20, right: 20 });
  const tab = marks.find(m => m.kind === 'tab');
  expect([tab.x, tab.width, tab.rtl]).toEqual([880, 90, true]);
  // The paragraph mark sits left of the whole line, though the line's last letter reads left to right.
  expect(marks.find(m => m.kind === 'paragraph')).toMatchObject({ x: 870, rtl: true });
});

it('draws a tab leader in the gap to the left of the preceding field', () => {
  const line = layout(rtl('a\tb', { tabs: [{ position: 1500, alignment: 'left', leader: 'dot' }] })).lines[0];
  expect(line.leaders).toHaveLength(1);
  expect(line.leaders[0].x).toBe(880);
  expect(line.leaders[0].width).toBe(90);
});

it('keeps left-to-right paragraphs beside right-to-left ones unchanged', () => {
  const result = layout(paragraph('abc'), rtl('abc'), paragraph('abc'));
  expect(result.lines.map(l => l.fragments[0].x)).toEqual([20, 950, 20]);
  expect(result.lines.map(l => l.rtl)).toEqual([undefined, true, undefined]);
  expect(result.lines[0].bidi).toBeUndefined();
});

it('paints paragraph shading across the paragraph, hanging first line included', () => {
  const band = format => layout(rtl('abc', { paragraphShading: 'FFFF00', ...format })).lines[0].paragraphBackground;
  // Indented 20px on the leading (right) side: the band ends there, 2px wider on each side.
  expect(band({ indentLeft: 300 })).toMatchObject({ x: 18, width: 944 });
  expect(band({ indentLeft: 300, firstLine: -150 })).toMatchObject({ x: 18, width: 954 });
  expect(band({ indentRight: 300 })).toMatchObject({ x: 38, width: 944 });
});

it('measures bar tabs from the right margin', () => {
  const line = layout(rtl('abc', { tabs: [{ position: 1500, alignment: 'bar', leader: 'none' }] })).lines[0];
  expect(line.bars).toEqual([{ x: 880 }]);
});
