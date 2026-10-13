// Paragraph and character layout options: hyphenation, no break, kerning
// modes, whole-point widths, justification spacing, the every-line
// composer, hanging punctuation, vertical alignment and auto-sized frames.
import { describe, it, expect } from 'vitest';
import { createText } from '../src/model/nodes.js';
import { layoutText, glyphPlacements, extraPlacements, drawsAsSegments } from '../src/model/text-layout.js';
import { hyphenateWord, hyphenPoints } from '../src/model/hyphenate.js';

// No canvas and no registered font: the layout's width approximation
// (lower case 5.5, narrow letters 2.8, spaces 2.7 at 10pt).
const CHAR = { fontFamily: 'Approx Sans', fontWeight: 400, fontStyle: 'normal', fontSize: 10 };
const area = (t, width, para = {}, char = {}, extra = {}) => createText(t, 0, 0, { kind: 'area', width, height: 500, char: { ...createText('', 0, 0).char, ...CHAR, ...char }, para: { ...createText('', 0, 0).para, ...para }, ...extra });
const lineTexts = (lay) => lay.lines.map((l) => l.text.trimEnd());

describe('hyphenation rules', () => {
  it('breaks words between syllables', () => {
    expect(hyphenateWord('hyphenation')).toBe('hy-phe-na-tion');
    expect(hyphenateWord('computer')).toBe('com-pu-ter');
    expect(hyphenateWord('letter')).toBe('let-ter');
    expect(hyphenateWord('remarkable')).toBe('re-mark-a-ble');
    expect(hyphenateWord('athlete')).toBe('ath-lete');
    expect(hyphenateWord('readable')).toBe('read-a-ble');
    expect(hyphenateWord('overall')).toBe('over-all');
  });

  it('respects word length, fragment lengths, capitals and acronyms', () => {
    expect(hyphenPoints('table')).toEqual([]);
    expect(hyphenPoints('hyphenation', { minBefore: 3, minAfter: 4 })).toEqual([5, 7]);
    expect(hyphenPoints('Washington', { capitalized: false })).toEqual([]);
    expect(hyphenPoints('Washington').length).toBeGreaterThan(0);
    expect(hyphenPoints('UNESCOHQ')).toEqual([]);
    expect(hyphenPoints('high-end')).toEqual([]);
  });
});

describe('automatic hyphenation in area type', () => {
  it('ends a line with a hyphen inside a long word', () => {
    const off = layoutText(area('xx hyphenation', 60));
    expect(lineTexts(off)).toEqual(['xx', 'hyphenation']);
    const on = layoutText(area('xx hyphenation', 60, { hyphenate: true }));
    expect(lineTexts(on)).toEqual(['xx hyphena', 'tion']);
    expect(on.lines[0].hyphen).toBe(true);
    const ex = extraPlacements(on);
    expect(ex.map((g) => g.ch)).toEqual(['-']);
    expect(ex[0].m[4]).toBeCloseTo(on.lines[0].xs[on.lines[0].contentEnd - on.lines[0].start]);
  });

  it('keeps short ends unhyphenated inside the hyphenation zone', () => {
    // The line could end 49pt from the margin; a 50pt zone keeps it whole.
    const lay = layoutText(area('xx hyphenation', 60, { hyphenate: true, hyphenation: { zone: 50 } }));
    expect(lineTexts(lay)).toEqual(['xx', 'hyphenation']);
  });

  it('limits hyphens in a row', () => {
    const t = 'hyphenation hyphenation hyphenation hyphenation';
    const free = layoutText(area(t, 45, { hyphenate: true, hyphenation: { zone: 0, limit: 0 } }));
    const limited = layoutText(area(t, 45, { hyphenate: true, hyphenation: { zone: 0, limit: 1 } }));
    const run = (lay) => {
      let best = 0;
      let cur = 0;
      for (const l of lay.lines) {
        cur = l.hyphen ? cur + 1 : 0;
        best = Math.max(best, cur);
      }
      return best;
    };
    expect(run(free)).toBeGreaterThan(1);
    expect(run(limited)).toBe(1);
  });
});

describe('character options', () => {
  it('No Break keeps characters on one line', () => {
    const plain = layoutText(area('aaa bbb ccc', 40));
    expect(lineTexts(plain)).toEqual(['aaa bbb', 'ccc']);
    // "bbb ccc" may not break.
    const t = area('aaa bbb ccc', 40, {}, {}, { runs: [{ len: 4 }, { len: 7, noBreak: true }] });
    expect(lineTexts(layoutText(t))).toEqual(['aaa', 'bbb ccc']);
  });

  it('whole-point widths round each advance and draw glyph by glyph', () => {
    const lay = layoutText(area('aaaa', 200, {}, { fractionalWidths: false, fontSize: 11 }));
    expect(lay.chars.adv.slice(0, 4)).toEqual([6, 6, 6, 6]);
    expect(drawsAsSegments(lay)).toBe(false);
    expect(drawsAsSegments(layoutText(area('aaaa', 200)))).toBe(true);
  });

  it('kerning off drops kerning pairs', () => {
    const lay = layoutText(area('AV', 200, {}, { kernMode: 'none' }));
    expect(lay.chars.kern[1]).toBe(0);
  });
});

describe('justification settings', () => {
  it('desired word spacing, letter spacing and glyph scaling change the advances', () => {
    const base = layoutText(area('aa aa', 500)).chars;
    const lay = layoutText(area('aa aa', 500, { justification: { wordDesired: 200, wordMax: 200, letterDesired: 10, letterMax: 10, glyphDesired: 110, glyphMax: 110 } }));
    expect(lay.chars.adv[2]).toBeCloseTo(base.adv[2] * 2);
    // Glyph 5.5 * 1.1 plus 10% of a 2.7 space.
    expect(lay.chars.adv[0]).toBeCloseTo(5.5 * 1.1 + 0.27);
    const g = glyphPlacements(lay)[0];
    expect(g.m[0]).toBeCloseTo(1.1);
  });

  it('auto leading follows the paragraph setting', () => {
    const lay = layoutText(area('a\nb', 500, { justification: { autoLeading: 150 } }));
    expect(lay.lines[1].y - lay.lines[0].y).toBeCloseTo(15);
  });

  it('justified lines stretch word spaces, then letters and glyphs within limits', () => {
    const para = { align: 'justify', justification: { wordMax: 150, letterMax: 20, glyphMax: 105 } };
    const lay = layoutText(area('aaaa aaaa aaaa', 60, para));
    const l = lay.lines[0];
    expect(l.text.trimEnd()).toBe('aaaa aaaa');
    // The line fills the frame.
    expect(l.xs[l.contentEnd - l.start]).toBeCloseTo(60);
    expect(l.spread).toBe(true);
    expect(l.gscale).toBeGreaterThan(1);
    expect(l.gscale).toBeLessThanOrEqual(1.05 + 1e-9);
  });

  it('justified lines squeeze word spaces down to the minimum to fit one more word', () => {
    // "aaa aaa aaa" is 54.9pt wide; 54pt fits it only with tighter spaces.
    const loose = layoutText(area('aaa aaa aaa', 54, { align: 'justify', justification: { wordMin: 100 } }));
    expect(loose.lines).toHaveLength(2);
    const tight = layoutText(area('aaa aaa aaa\nx', 54, { align: 'justify' }));
    const l = tight.lines[0];
    expect(l.text.trimEnd()).toBe('aaa aaa aaa');
    expect(l.xs[l.contentEnd - l.start]).toBeCloseTo(54);
  });

  it('single-word lines follow the single word setting', () => {
    const t = 'aaaaaaaa bbbbbbbb';
    const spread = layoutText(area(t, 60, { align: 'justify' })).lines[0];
    expect(spread.xs[spread.contentEnd - spread.start]).toBeCloseTo(60);
    const left = layoutText(area(t, 60, { align: 'justify', justification: { singleWord: 'left' } })).lines[0];
    expect(left.xs[left.contentEnd - left.start]).toBeCloseTo(44);
    const right = layoutText(area(t, 60, { align: 'justify', justification: { singleWord: 'right' } })).lines[0];
    expect(right.xs[0]).toBeCloseTo(16);
  });
});

describe('every-line composer', () => {
  const words = 'aaa aa aaaa aaaaaa aa aaaaaaa aaa aaaaa a aaaa';
  it('evens out the rag where filling line by line leaves one line short', () => {
    const single = layoutText(area(words, 60, { composer: 'single' }));
    const every = layoutText(area(words, 60, { composer: 'every' }));
    const rag = (lay) => {
      const ws = lay.lines.slice(0, -1).map((l) => l.width);
      return Math.max(...ws) - Math.min(...ws);
    };
    expect(every.lines.length).toBe(single.lines.length);
    expect(rag(every)).toBeLessThan(rag(single));
    for (const l of every.lines) expect(l.width).toBeLessThanOrEqual(60 + 1e-6);
    expect(every.lines.map((l) => l.text).join('')).toBe(words);
  });

  it('falls back to line-by-line filling when a word is wider than the frame', () => {
    const lay = layoutText(area('aaaaaaaaaaaaaaaa bb', 30, { composer: 'every' }));
    expect(lay.lines.map((l) => l.text).join('')).toBe('aaaaaaaaaaaaaaaa bb');
  });
});

describe('hanging punctuation and vertical alignment', () => {
  it('hangs punctuation fully outside the margins of its paragraph', () => {
    const lay = layoutText(area('"aa."', 100, { hangingPunctuation: true }));
    const l = lay.lines[0];
    expect(l.xs[1]).toBeCloseTo(0);
    const right = layoutText(area('aa.', 100, { align: 'right', hangingPunctuation: true })).lines[0];
    expect(right.xs[2]).toBeCloseTo(100);
  });

  it('aligns lines to the bottom, center or spreads them in the frame', () => {
    const mk = (va) => layoutText(createText('a\nb', 0, 0, { kind: 'area', width: 100, height: 100, char: { ...createText('', 0, 0).char, ...CHAR }, areaOptions: { verticalAlign: va } }));
    const top = mk('top');
    const bottom = mk('bottom');
    const last = bottom.lines[1];
    expect(last.y + last.desc).toBeCloseTo(100);
    const center = mk('center');
    expect(center.lines[0].y - top.lines[0].y).toBeCloseTo((bottom.lines[0].y - top.lines[0].y) / 2);
    const just = mk('justify');
    expect(just.lines[0].y).toBeCloseTo(top.lines[0].y);
    expect(just.lines[1].y + just.lines[1].desc).toBeCloseTo(100);
  });

  it('auto-sized frames lay out all their text', () => {
    const t = createText('a\nb\nc\nd\ne', 0, 0, { kind: 'area', width: 100, height: 10, char: { ...createText('', 0, 0).char, ...CHAR }, areaOptions: { autoSize: true } });
    const lay = layoutText(t);
    expect(lay.overflow).toBe(false);
    expect(lay.lines).toHaveLength(5);
  });
});
