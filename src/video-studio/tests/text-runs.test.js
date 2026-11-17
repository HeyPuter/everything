// What a text clip is laid out as: its letters, where they go and which are shown.
// Measured with a stand-in context where every letter is half an em wide.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { DEFAULT_TEXT_STYLE } from '../src/model/project.js';
import { wrapLines, lineGlyphs, indexGlyphs, graphemes, lineOffsets } from '../src/engine/text-layout.js';

let layoutText;
let rasterizeText;
let charW = 0.5;
const drawn = [];

function fakeContext() {
  let tx = 0;
  let ty = 0;
  const ctx = {
    font: '10px x', letterSpacing: '0px', filter: 'none', globalAlpha: 1, fillStyle: '#000',
    measureText(str) {
      const size = parseFloat(/([\d.]+)px/.exec(ctx.font)[1]);
      const n = graphemes(String(str)).length;
      return { width: n * size * charW + n * parseFloat(ctx.letterSpacing) };
    },
    setTransform(a, b, c, d, e, f) { tx = e; ty = f; },
    translate(x, y) { tx += x; ty += y; },
    fillText(t, x, y) { drawn.push(['text', t, Math.round(tx + x), Math.round(ty + y)]); },
    fillRect(x, y, w) { drawn.push(['rect', Math.round(tx + x), Math.round(w)]); },
    createLinearGradient: () => ({ addColorStop() {} }),
  };
  return new Proxy(ctx, { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => ((t[k] = v), true) });
}

beforeAll(async () => {
  vi.stubGlobal('OffscreenCanvas', class {
    constructor(w, h) {
      Object.assign(this, { width: w, height: h, ctx: fakeContext() });
    }
    getContext() {
      return this.ctx;
    }
  });
  vi.resetModules();
  ({ layoutText, rasterizeText } = await import('../src/engine/text.js'));
});
afterAll(() => vi.unstubAllGlobals());

const style = (o = {}) => ({ ...DEFAULT_TEXT_STYLE, font: 'Inter', size: 100, ...o });
const measure = (s) => graphemes(s).length * 50;
const shown = (L) => L.runs.filter((r) => !r.space).map((r) => r.text).join('');

describe('letters', () => {
  it('keeps an emoji with its skin tone, a flag, a family and an accented letter whole', () => {
    const line = 'a👍🏽🇺🇸👨‍👩‍👧é';
    expect(graphemes(line)).toEqual(['a', '👍🏽', '🇺🇸', '👨‍👩‍👧', 'é']);
    const glyphs = lineGlyphs(line, measure, measure);
    expect(glyphs.map((g) => g.ch)).toEqual(['a', '👍🏽', '🇺🇸', '👨‍👩‍👧', 'é']);
    // Drawn letter by letter (a highlighted word), each is one drawing.
    const L = layoutText({ text: 'ok 👍🏽 🇺🇸', style: style(), marks: [0] }, 1);
    expect(L.runs.filter((r) => !r.space).map((r) => r.text)).toEqual(['o', 'k', '👍🏽', '🇺🇸']);
  });

  it('breaks a word that is wider than the box between letters, never inside one', () => {
    expect([...wrapLines('👍🏽👍🏽👍🏽', 100, measure)]).toEqual(['👍🏽👍🏽', '👍🏽']);
  });
});

describe('a long word broken by wrapping', () => {
  it('is still one word, so highlights and word animations keep their count', () => {
    const lines = wrapLines('Supercalifragilistic is cool', 600, measure);
    expect([...lines]).toEqual(['Supercalifra', 'gilistic is', 'cool']);
    expect([...lines.joins]).toEqual([1]);
    const L = layoutText({ text: 'Supercalifragilistic is cool', style: style({ boxWidth: 600 }), marks: [1] }, 1);
    expect(L.totals.words).toBe(3);
    expect(L.totals.wordLens).toEqual([20, 2, 4]);
    const highlighted = L.runs.filter((r) => r.color).map((r) => r.text).join('');
    expect(highlighted).toBe('is');
  });

  it('counts words across lines as before when nothing is broken', () => {
    const glyphs = (line) => ({ glyphs: lineGlyphs(line, measure, measure) });
    expect(indexGlyphs([glyphs('one two'), glyphs('three')]).words).toBe(3);
  });
});

describe('typewriter reveal on wrapped text', () => {
  const text = 'aa bb cc dd ee ff';
  const clip = { text, style: style({ boxWidth: 130 }) };

  it('knows where each line starts in the text, spaces swallowed by wrapping included', () => {
    const lines = wrapLines(text, 130, measure);
    expect([...lines]).toEqual(['aa', 'bb', 'cc', 'dd', 'ee', 'ff']);
    expect(lineOffsets(text, lines)).toEqual([0, 3, 6, 9, 12, 15]);
    expect(lineOffsets('a\n\n  b c', ['a', '', 'b c'])).toEqual([0, 1, 3]);
  });

  it('shows as much of the text as the reveal says, drawn whole or letter by letter', () => {
    for (const marks of [undefined, [0]]) {
      const at = (reveal) => shown(layoutText({ ...clip, marks }, 1, { reveal })).length || layoutText({ ...clip, marks }, 1, { reveal }).runs.map((r) => r.text).join('').length;
      // 17 letters and spaces in all: half way is 8 of them, "aa bb cc" less its two spaces.
      expect(at(0.5)).toBe(6);
      // Three quarters is not yet everything (it used to be, the reveal then sat idle).
      expect(at(0.75)).toBe(8);
      expect(at(0.99)).toBe(11);
    }
  });
});

describe('curved text in a box', () => {
  it('bends around its own middle whichever side of the box it is aligned to', () => {
    const spread = (align) => {
      const L = layoutText({ text: 'HELLO', style: style({ arc: 50, boxWidth: 1200, align }) }, 1);
      return L.runs.map((r) => Math.round((r.rot * 180) / Math.PI));
    };
    const centered = spread('center');
    expect(centered[0]).toBeLessThan(0);
    expect(centered.at(-1)).toBe(-centered[0]);
    expect(Math.abs(centered[0])).toBeLessThan(60);
    expect(spread('left')).toEqual(centered);
    expect(spread('right')).toEqual(centered);
  });
});

describe('letter positions and fonts', () => {
  it('measures the letters again once a font has loaded', async () => {
    const clip = { text: 'ab cd', style: style(), marks: [1] };
    const gap = () => {
      const [a, b] = layoutText(clip, 1).runs;
      return Math.round(b.cx - a.cx);
    };
    charW = 0.5;
    expect(gap()).toBe(50);
    try {
      // The real font arrives, twice as wide as the fallback the first frame was laid out with.
      charW = 1;
      vi.stubGlobal('FontFace', class {
        async load() {}
      });
      const fonts = document.fonts;
      if (!fonts) Object.defineProperty(document, 'fonts', { value: { add() {} }, configurable: true });
      else if (!fonts.add) fonts.add = () => {};
      const { registerFont } = await import('../src/engine/font-registry.js');
      await registerFont('Uploaded Face', new ArrayBuffer(4));
      expect(gap()).toBe(100);
    } finally {
      charW = 0.5;
    }
  });
});

describe('underline', () => {
  it('runs on under the spaces between words drawn letter by letter', () => {
    drawn.length = 0;
    rasterizeText({ text: 'a b', style: style({ underline: true }), marks: [0] }, 1, 1);
    const rects = drawn.filter((d) => d[0] === 'rect');
    // One stretch per letter and one under the space: no hole between the words.
    expect(rects.length).toBeGreaterThanOrEqual(3);
  });
});
