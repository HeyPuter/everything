// Layout of tabs, lists, forced and discretionary breaks, optical margins,
// text wrap, threaded frames and vertical type on a path.
import { describe, it, expect, afterEach } from 'vitest';
import { createText } from '../src/model/nodes.js';
import { layoutText, editLayout, glyphPlacements, extraPlacements, caretPosition, hitTestText, selectionPolygons, textHooks, formatListNumber, LINE_SEP, SHY, TAB_WIDTH } from '../src/model/text-layout.js';

// An unregistered family measures with the built-in approximation: at 10px
// lower case letters and digits are 5.5 wide, spaces 2.7, '.' 2.8.
const CHAR = { fontFamily: 'Approx Sans', fontWeight: 400, fontStyle: 'normal', fontSize: 10 };
const area = (t, extra = {}) => createText(t, 0, 0, { kind: 'area', width: 200, height: 200, char: { ...CHAR }, ...extra });
const point = (t, extra = {}) => createText(t, 0, 50, { char: { ...CHAR }, ...extra });
const xOf = (lay, i) => {
  const l = lay.lines.find((ln) => i >= ln.start && i <= ln.end);
  return l.xs[i - l.start];
};

afterEach(() => {
  textHooks.story = null;
  textHooks.wraps = null;
});

describe('tabs', () => {
  it('uses default stops every half inch without custom stops', () => {
    const lay = layoutText(point('ab\tc'));
    expect(xOf(lay, 3)).toBeCloseTo(TAB_WIDTH);
  });

  it('aligns text at left, right, center and decimal stops', () => {
    const stops = (align) => ({ para: { align: 'left', tabs: [{ pos: 100, align }] } });
    expect(xOf(layoutText(area('a\tbcd', stops('left'))), 2)).toBeCloseTo(100);
    // Right: the text after the tab ends at the stop.
    const r = layoutText(area('a\tbcd', stops('right')));
    expect(xOf(r, 5)).toBeCloseTo(100);
    const c = layoutText(area('a\tbcd', stops('center')));
    expect((xOf(c, 2) + xOf(c, 5)) / 2).toBeCloseTo(100);
    // Decimal: the decimal point sits at the stop.
    const d = layoutText(area('a\t12.50', stops('decimal')));
    expect(xOf(d, 4)).toBeCloseTo(100);
  });

  it('counts stops from the frame edge, not from the indent', () => {
    const lay = layoutText(area('\tx', { para: { align: 'left', indentLeft: 20, tabs: [{ pos: 50, align: 'left' }] } }));
    expect(xOf(lay, 1)).toBeCloseTo(50);
  });

  it('falls back to default stops after the last custom stop', () => {
    const lay = layoutText(area('\ta\tb', { para: { align: 'left', tabs: [{ pos: 10, align: 'left' }] } }));
    expect(xOf(lay, 1)).toBeCloseTo(10);
    expect(xOf(lay, 3)).toBeCloseTo(TAB_WIDTH);
  });

  it('fills the tab with a leader aligned to a grid', () => {
    const lay = layoutText(area('a\tb', { para: { align: 'left', tabs: [{ pos: 60, align: 'left', leader: '.' }] } }));
    const dots = extraPlacements(lay);
    expect(dots.length).toBeGreaterThan(10);
    for (const g of dots) {
      expect(g.ch).toBe('.');
      expect(g.m[4]).toBeGreaterThanOrEqual(5.5 - 1e-6);
      expect(g.m[4] + 2.8).toBeLessThanOrEqual(60 + 0.02);
      const k = g.m[4] / 2.8;
      expect(Math.abs(k - Math.round(k))).toBeLessThan(1e-6);
    }
    // Leaders are part of the outlines and drawing.
    expect(glyphPlacements(lay).filter((g) => g.extra)).toHaveLength(dots.length);
  });
});

describe('bullets and numbering', () => {
  it('formats numbers', () => {
    expect(formatListNumber(4, '1')).toBe('4');
    expect(formatListNumber(4, 'i')).toBe('iv');
    expect(formatListNumber(1994, 'I')).toBe('MCMXCIV');
    expect(formatListNumber(28, 'a')).toBe('ab');
    expect(formatListNumber(3, 'A')).toBe('C');
    expect(formatListNumber(7, '01')).toBe('07');
  });

  it('numbers consecutive paragraphs and restarts after a plain one', () => {
    const list = { kind: 'number', format: '1', suffix: '.' };
    const n = area('one\ntwo\nplain\nthree', { paras: [{ list }, { list }, null, { list: { ...list, start: 5 } }] });
    const marks = extraPlacements(layoutText(n)).map((g) => g.ch);
    expect(marks).toEqual(['1.', '2.', '5.']);
  });

  it('hangs the marker in the first-line indent and aligns text to the left indent', () => {
    const n = area('item one wraps onto the next line of the frame', { width: 120, para: { align: 'left', indentLeft: 18, indentFirst: -18, list: { kind: 'bullet', bullet: '•' } } });
    const lay = layoutText(n);
    const [mark] = extraPlacements(lay);
    expect(mark.ch).toBe('•');
    expect(mark.m[4]).toBeCloseTo(0);
    expect(lay.lines[0].x).toBeCloseTo(18);
    expect(lay.lines[1].x).toBeCloseTo(18);
  });

  it('pushes text past a wide marker without indents', () => {
    const n = area('text', { para: { align: 'left', list: { kind: 'number', format: '1', suffix: '.' } } });
    const lay = layoutText(n);
    expect(lay.lines[0].x).toBeCloseTo(5.5 + 2.8 + 5);
  });

  it('draws markers on point type too', () => {
    const lay = layoutText(point('a\nb', { para: { align: 'left', list: { kind: 'bullet' } } }));
    expect(extraPlacements(lay)).toHaveLength(2);
  });
});

describe('breaks and margins', () => {
  it('a forced line break starts a new line in the same paragraph', () => {
    const lay = layoutText(area(`one${LINE_SEP}two`, { para: { align: 'left', spaceBefore: 30 } }));
    expect(lay.lines).toHaveLength(2);
    expect(lay.lines[0].para).toBe(lay.lines[1].para);
    expect(lay.lines[1].y - lay.lines[0].y).toBeCloseTo(12);
    expect(lay.lines[1].start).toBe(4);
    const pl = layoutText(point(`one${LINE_SEP}two`));
    expect(pl.lines).toHaveLength(2);
    expect(glyphPlacements(pl).map((g) => g.ch).join('')).toBe('onetwo');
  });

  it('a discretionary hyphen is invisible unless the line breaks there', () => {
    const word = `aaaa${SHY}bbbb`;
    const wide = layoutText(area(word));
    expect(wide.lines).toHaveLength(1);
    expect(extraPlacements(wide)).toHaveLength(0);
    expect(xOf(wide, 5)).toBeCloseTo(4 * 5.5);
    const narrow = layoutText(area(word, { width: 30 }));
    expect(narrow.lines).toHaveLength(2);
    expect(narrow.lines[1].start).toBe(5);
    expect(extraPlacements(narrow).map((g) => g.ch)).toEqual(['-']);
  });

  it('optical margin alignment hangs punctuation outside the edge', () => {
    const plain = layoutText(area('"quote"', { para: { align: 'left' } }));
    const hung = layoutText(area('"quote"', { para: { align: 'left', opticalMargin: true } }));
    expect(plain.lines[0].x).toBeCloseTo(0);
    expect(hung.lines[0].x).toBeLessThan(-1);
  });
});

describe('text wrap', () => {
  it('flows lines around an obstacle and inside it when inverted', () => {
    const n = area('word '.repeat(80), { width: 200, height: 300 });
    const square = [{ x: 60, y: 0 }, { x: 140, y: 0 }, { x: 140, y: 60 }, { x: 60, y: 60 }];
    textHooks.wraps = (node) => (node.id === n.id ? { deps: [square], list: [{ polys: [square], offset: 5, invert: false }] } : null);
    const lay = layoutText(n);
    const top = lay.lines.filter((l) => l.y - l.asc < 65);
    // Two slots per row beside the obstacle: nothing between x 55 and 145.
    for (const l of top) {
      expect(l.x + l.width <= 55 + 0.01 || l.x >= 145 - 0.01).toBe(true);
    }
    expect(new Set(top.map((l) => l.y)).size).toBeLessThan(top.length);
    const below = lay.lines.find((l) => l.y - l.asc > 70);
    expect(below.width).toBeGreaterThan(150);
    textHooks.wraps = (node) => (node.id === n.id ? { deps: [square, 1], list: [{ polys: [square], offset: 5, invert: true }] } : null);
    const inv = layoutText(n);
    for (const l of inv.lines) {
      expect(l.x).toBeGreaterThanOrEqual(65 - 0.01);
      expect(l.x + l.width).toBeLessThanOrEqual(135 + 0.01);
    }
  });

  it('relayouts when the wrap object changes and caches otherwise', () => {
    const n = area('word '.repeat(40));
    let poly = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 40 }, { x: 0, y: 40 }];
    textHooks.wraps = () => ({ deps: [poly], list: [{ polys: [poly], offset: 0 }] });
    const a = layoutText(n);
    expect(layoutText(n)).toBe(a);
    poly = [{ x: 0, y: 0 }, { x: 150, y: 0 }, { x: 150, y: 40 }, { x: 0, y: 40 }];
    const b = layoutText(n);
    expect(b).not.toBe(a);
    expect(b.lines[0].x).toBeGreaterThanOrEqual(150);
  });
});

describe('threaded frames', () => {
  const story = () => {
    const a = area('word '.repeat(60), { width: 100, height: 40, threadNext: 'f2' });
    const b = createText('', 300, 0, { id: 'f2', kind: 'area', width: 100, height: 40, char: { ...CHAR }, threadPrev: a.id, threadNext: 'f3' });
    const c = createText('', 300, 300, { id: 'f3', kind: 'area', width: 100, height: 40, char: { ...CHAR }, threadPrev: 'f2', transform: [1, 0, 0, 1, 50, 0] });
    const frames = [a, b, c];
    textHooks.story = (node) => frames.map((f) => (f.id === node.id ? node : f));
    return frames;
  };

  it('flows the story through the frames in order', () => {
    const [a, b, c] = story();
    const la = layoutText(a);
    const lb = layoutText(b);
    const lc = layoutText(c);
    expect(la.lines.length).toBeGreaterThan(0);
    expect(lb.lines[0].start).toBe(la.lines[la.lines.length - 1].end);
    expect(lc.lines[0].start).toBe(lb.lines[lb.lines.length - 1].end);
    // Each frame lays out in its own box.
    expect(lb.lines[0].x).toBeGreaterThanOrEqual(300);
    expect(lc.lines[0].y).toBeGreaterThan(300);
    // Only the last frame reports overflow.
    expect(la.overflow).toBe(false);
    expect(lc.overflow).toBe(true);
    expect(lb.text).toBe(a.text);
    expect(glyphPlacements(lb).length).toBeGreaterThan(0);
  });

  it('edits through every frame with one caret mapping', () => {
    const [a, b, c] = story();
    const ed = editLayout(a);
    const lc = layoutText(c);
    const i = lc.lines[0].start + 1;
    const p = caretPosition(ed, i);
    // Frame 3 is offset by its transform; the caret maps into the first frame's space.
    expect(p.x).toBeCloseTo(lc.lines[0].xs[1] + 50);
    expect(hitTestText(ed, p.x, p.y)).toBe(i);
    const lb = layoutText(b);
    const polys = selectionPolygons(ed, lb.lines[0].start, lc.lines[0].start + 2);
    expect(polys.length).toBe(lb.lines.length + 1);
  });

  it('re-flows when a frame changes', () => {
    const frames = story();
    const before = layoutText(frames[1]);
    frames[0] = { ...frames[0], width: 200 };
    const after = layoutText(frames[1]);
    expect(after).not.toBe(before);
    expect(after.lines[0].start).toBeGreaterThan(before.lines[0].start);
  });
});

describe('type on a path', () => {
  const anchors = [
    { x: 0, y: 100, ix: 0, iy: 100, ox: 0, oy: 100 },
    { x: 400, y: 100, ix: 400, iy: 100, ox: 400, oy: 100 },
  ];
  it('stacks vertical type along the path', () => {
    const n = createText('abc', 0, 0, { kind: 'path', pathAnchors: anchors, pathOptions: {}, vertical: true, char: { ...CHAR } });
    const g = glyphPlacements(layoutText(n));
    expect(g).toHaveLength(3);
    // Each character takes one em along the path; the glyph's down axis follows it.
    expect(g[1].m[4] - g[0].m[4]).toBeCloseTo(10);
    expect(g[0].m[2]).toBeCloseTo(1);
    expect(g[0].m[1]).toBeCloseTo(-1);
  });

  it('spacing tightens characters around the outside of a bend', () => {
    const bend = [
      { x: 0, y: 100, ix: 0, iy: 100, ox: 60, oy: 100 },
      { x: 100, y: 0, ix: 100, iy: 60, ox: 100, oy: 0 },
    ];
    const n = (spacing) => createText('aaaaaaaaaaaa', 0, 0, { kind: 'path', pathAnchors: bend, pathOptions: { spacing }, char: { ...CHAR } });
    const w0 = layoutText(n(0)).lines[0].width;
    const w1 = layoutText(n(8)).lines[0].width;
    expect(w1).not.toBeCloseTo(w0);
  });

  it('centered or right-aligned text too long for its path overflows at the end instead of running off the start', () => {
    for (const align of ['center', 'right']) {
      const n = createText('a'.repeat(100), 0, 0, { kind: 'path', pathAnchors: anchors, pathOptions: {}, para: { align }, char: { ...CHAR } });
      const lay = layoutText(n);
      expect(lay.overflow).toBe(true);
      const g = glyphPlacements(lay);
      expect(g[0].m[4]).toBeCloseTo(0);
      expect(g[g.length - 1].m[4]).toBeLessThan(400);
    }
    // Text that fits still aligns.
    const short = layoutText(createText('aaaa', 0, 0, { kind: 'path', pathAnchors: anchors, pathOptions: {}, para: { align: 'right' }, char: { ...CHAR } }));
    expect(glyphPlacements(short)[0].m[4]).toBeCloseTo(400 - 22);
  });

  it('type on a closed path runs on past the seam instead of overflowing there', () => {
    // A 400 x 400 square starting at its top-left corner: 1600 long.
    const sq = [
      [0, 0],
      [400, 0],
      [400, 400],
      [0, 400],
    ].map(([x, y]) => ({ x, y, ix: x, iy: y, ox: x, oy: y }));
    // 20 letters, 110 wide, starting 50 before the seam.
    const n = createText('aaaaaaaaaaaaaaaaaaaa', 0, 0, { kind: 'path', pathAnchors: sq, pathClosed: true, pathOptions: { start: 1550 }, char: { ...CHAR } });
    const lay = layoutText(n);
    expect(lay.overflow).toBe(false);
    const g = glyphPlacements(lay);
    expect(g).toHaveLength(20);
    // The last letters sit along the top edge, just past the corner where the path starts.
    expect(g[19].m[5]).toBeCloseTo(0);
    expect(g[19].m[4]).toBeGreaterThan(40);
    expect(g[19].m[4]).toBeLessThan(70);
    // Clicking there puts the caret among those letters, and the caret draws there.
    const i = hitTestText(lay, 55, 0);
    expect(i).toBeGreaterThan(15);
    expect(caretPosition(lay, i).y).toBeCloseTo(0);
    // Text longer than the loop still overflows.
    expect(layoutText({ ...n, text: 'a'.repeat(400) }).overflow).toBe(true);
  });
});
