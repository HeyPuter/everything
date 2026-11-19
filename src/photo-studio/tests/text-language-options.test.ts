import { describe, expect, it } from 'vitest';
import {
  baselineStep,
  kashidaPoints,
  layoutText,
  TATWEEL,
  type Measure,
} from '../src/imaging/text/layout';
import {
  applyCharStyle,
  defaultCharStyle,
  defaultParagraphStyle,
  fromPlainText,
  type ParagraphStyle,
  type TextLayerData,
} from '../src/imaging/text/model';
import { validateTextData } from '../src/model/text-layer';
import { exportPsdText, importPsdText } from '../src/model/psd-text';

// Monospace stand-in: every character is half an em wide; ascent 0.8 em, descent 0.2 em.
const sizeOf = (font: string) => Number(/([\d.]+)px/.exec(font)![1]);
const mono: Measure = (text, font) => {
  const s = sizeOf(font);
  return { width: [...text].length * s * 0.5, ascent: s * 0.8, descent: s * 0.2 };
};
const style = { ...defaultCharStyle(), size: 20 }; // 10 px per character at 72 ppi
const opts = { measure: mono };

function para(
  text: string,
  width: number,
  ps: Partial<ParagraphStyle> = {},
  extra: Partial<TextLayerData> = {},
): TextLayerData {
  return {
    content: fromPlainText(text, style, { ...defaultParagraphStyle(), ...ps }),
    mode: 'paragraph',
    box: { width, height: 2000 },
    origin: { x: 0, y: 0 },
    orientation: 'horizontal',
    antiAlias: 'smooth',
    ...extra,
  };
}
const linesOf = (d: TextLayerData) => {
  const t = d.content.paragraphs.map((p) => p.runs.map((r) => r.text).join('')).join('\n');
  return layoutText(d, opts).lines.map((l) => t.slice(l.start, l.end).trimEnd());
};

describe('leading models', () => {
  it('match baseline-to-baseline when sizes agree', () => {
    for (const model of ['top', 'bottom', ''] as const)
      expect(baselineStep(model, { leading: 24, em: 20 }, { leading: 24, em: 20 })).toBe(24);
  });

  it('measure from em-box tops or bottoms when sizes differ', () => {
    // Line 1: 20 px type, 24 px leading. Line 2: 40 px type, 48 px leading.
    const text = 'aaa\nbbb';
    const mixed = (model: ParagraphStyle['leadingModel']) => {
      let c = fromPlainText(text, style, { ...defaultParagraphStyle(), leadingModel: model });
      c = applyCharStyle(c, 4, 7, { size: 40 });
      const lay = layoutText(
        {
          content: c,
          mode: 'point',
          origin: { x: 0, y: 100 },
          orientation: 'horizontal',
          antiAlias: 'smooth',
        },
        opts,
      );
      return lay.lines[1].y - lay.lines[0].y;
    };
    expect(mixed('')).toBeCloseTo(48, 9);
    // Top to top: line 1's leading (24) between em-box tops (0.88 em).
    expect(mixed('top')).toBeCloseTo(24 + 0.88 * 20, 9);
    // Bottom to bottom: line 2's leading between em-box bottoms (0.12 em).
    expect(mixed('bottom')).toBeCloseTo(48 - 0.12 * 20, 9);
  });

  it('uses the paragraph auto leading percentage', () => {
    const lay = layoutText(para('aaa\nbbb', 200, { autoLeading: 150 }), opts);
    expect(lay.lines[1].y - lay.lines[0].y).toBeCloseTo(30, 9);
  });
});

describe('kashida justification', () => {
  it('finds joins between Arabic letters, last join of each word first', () => {
    // كتب: kaf, teh, beh join on both sides; دار: dal and alef never join forward.
    expect(kashidaPoints([...'كتب سلم'])).toEqual([1, 5, 0, 4]);
    expect(kashidaPoints([...'دار'])).toEqual([]);
    expect(kashidaPoints([...'abc'])).toEqual([]);
  });

  it('stretches Arabic joins with tatweels before widening spaces', () => {
    const text = 'كتب كتب كتب كتب كتب';
    const d = para(text, 100, { align: 'justify-right', direction: 'rtl', kashida: true });
    const plain = layoutText(para(text, 100, { align: 'justify-right', direction: 'rtl' }), opts);
    const lay = layoutText(d, opts);
    const first = lay.lines[0];
    expect(first.width).toBeCloseTo(100, 6);
    const drawn = lay.runs
      .filter((r) => r.y === first.y)
      .map((r) => r.text)
      .join('');
    expect(drawn).toContain(TATWEEL);
    // Whole tatweels (10 px) take the extra; spaces keep their width when it divides evenly.
    const tatweels = [...drawn].filter((c) => c === TATWEEL).length;
    expect(tatweels).toBeGreaterThan(0);
    // Without kashidas the same line stretches its spaces and draws no tatweel.
    expect(plain.runs.map((r) => r.text).join('')).not.toContain(TATWEEL);
    // Carets still address the source text.
    expect(lay.length).toBe(text.length);
  });
});

describe('justification settings', () => {
  it('closes spaces to the minimum word spacing to fit more words', () => {
    // "aaaa bbbb cccc" is 140 px; at 50% spaces it is 130 px and fits 130.
    const text = 'aaaa bbbb cccc dd';
    expect(linesOf(para(text, 130, { align: 'justify-left' }))[0]).toBe('aaaa bbbb');
    const tight = para(text, 130, { align: 'justify-left', wordSpacing: [50, 100, 133] });
    expect(linesOf(tight)[0]).toBe('aaaa bbbb cccc');
    expect(layoutText(tight, opts).lines[0].width).toBeCloseTo(130, 6);
  });

  it('spreads letters once spaces reach their maximum', () => {
    // 'aaaa bbbb' is 90 px in a 120 px frame: spaces may grow to 133% (3.3 px),
    // then letters up to 50% of a space each (7 gaps × 5 px = 35 px).
    const d = para('aaaa bbbb cccccccc', 120, {
      align: 'justify-left',
      wordSpacing: [100, 100, 133],
      letterSpacing: [0, 0, 50],
    });
    const lay = layoutText(d, opts);
    expect(lay.lines[0].width).toBeCloseTo(120, 6);
    const run = lay.runs.find((r) => r.text === 'aaaa')!;
    expect(run.letterSpacing).toBeCloseTo((30 - 3.3) / 7, 1);
  });

  it('scales glyphs within the limits', () => {
    const lay = layoutText(
      para('aaaa bbbb cccccccccc', 100, {
        align: 'justify-left',
        wordSpacing: [100, 100, 100],
        glyphScaling: [100, 100, 110],
      }),
      opts,
    );
    expect(lay.lines[0].width).toBeCloseTo(100, 6);
    expect(lay.runs.find((r) => r.text === 'aaaa')!.scaleX).toBeCloseTo(1.1, 6);
  });

  it('applies desired word spacing to every line', () => {
    const lay = layoutText(para('aa bb', 500, { wordSpacing: [50, 50, 100] }), opts);
    expect(lay.lines[0].width).toBeCloseTo(45, 6);
  });
});

describe('hyphenation settings', () => {
  const text = 'the information superhighway';
  it('respects the shortest word and the letters around a hyphen', () => {
    const lay = layoutText(para(text, 110, { hyphenate: true }), opts);
    expect(lay.lines.some((l) => l.hyphen)).toBe(true);
    const never = layoutText(para(text, 110, { hyphenate: true, hyphenMinWord: 20 }), opts);
    expect(never.lines.some((l) => l.hyphen)).toBe(false);
  });

  it('limits consecutive hyphenated lines', () => {
    const long =
      'internationalization internationalization internationalization internationalization';
    const free = layoutText(
      para(long, 150, { hyphenate: true, hyphenBefore: 2, hyphenAfter: 2 }),
      opts,
    ).lines.map((l) => l.hyphen);
    const limited = layoutText(
      para(long, 150, { hyphenate: true, hyphenBefore: 2, hyphenAfter: 2, hyphenLimit: 1 }),
      opts,
    ).lines.map((l) => l.hyphen);
    const maxRun = (h: boolean[]) =>
      h.reduce((a, v) => ({ cur: v ? a.cur + 1 : 0, max: Math.max(a.max, v ? a.cur + 1 : 0) }), {
        cur: 0,
        max: 0,
      }).max;
    expect(maxRun(free)).toBeGreaterThan(1);
    expect(maxRun(limited)).toBeLessThanOrEqual(1);
  });

  it('hyphenates capitalized words only when asked', () => {
    const t = 'Internationalization';
    expect(layoutText(para(t, 120, { hyphenate: true }), opts).lines.some((l) => l.hyphen)).toBe(
      false,
    );
    expect(
      layoutText(para(t, 120, { hyphenate: true, hyphenCapitalized: true }), opts).lines.some(
        (l) => l.hyphen,
      ),
    ).toBe(true);
  });

  it('moves a word whole inside the hyphenation zone', () => {
    // After "aaaaaaaaaaa " (120 px) 30 px remain in 150: a 36 pt (36 px) zone keeps "information" whole.
    const t = 'aaaaaaaaaaa information';
    expect(layoutText(para(t, 150, { hyphenate: true }), opts).lines[0].hyphen).toBe(true);
    expect(
      layoutText(para(t, 150, { hyphenate: true, hyphenZone: 36 }), opts).lines[0].hyphen,
    ).toBe(false);
  });
});

describe('character options', () => {
  it('keeps No Break text on one line', () => {
    const t = 'aaaa bbbb cccc';
    let c = fromPlainText(t, style);
    expect(linesOf({ ...para(t, 100), content: c })).toEqual(['aaaa bbbb', 'cccc']);
    c = applyCharStyle(c, 5, 14, { noBreak: true });
    expect(linesOf({ ...para(t, 100), content: c })).toEqual(['aaaa', 'bbbb cccc']);
  });

  it('snaps advances to whole pixels with Fractional Widths off', () => {
    const odd = { ...style, size: 15 }; // 7.5 px per character
    const frac = layoutText({ ...para('abcd', 500), content: fromPlainText('abcd', odd) }, opts);
    const whole = layoutText(
      { ...para('abcd', 500), content: fromPlainText('abcd', { ...odd, wholeWidths: true }) },
      opts,
    );
    expect(frac.runs[0].advances).toEqual([7.5, 7.5, 7.5, 7.5]);
    expect(whole.runs[0].advances.every((a) => Number.isInteger(a))).toBe(true);
  });
});

describe('composers and hanging punctuation', () => {
  it('evens out lines with the every-line composer', () => {
    // Greedy fills the first line and leaves a ragged second; the every-line
    // composer moves a word down so both lines have similar slack.
    const t = 'aaa bbb ccc ddd eeeeeeeeee';
    const greedy = linesOf(para(t, 160));
    const even = linesOf(para(t, 160, { composer: 'every-line' }));
    expect(greedy).toEqual(['aaa bbb ccc ddd', 'eeeeeeeeee']);
    const slack = (ls: string[]) =>
      ls.slice(0, -1).reduce((a, l) => a + (160 - l.length * 10) ** 2, 0);
    expect(even.join(' ')).toBe(greedy.join(' '));
    expect(slack(even)).toBeLessThanOrEqual(slack(greedy));
    // Forced breaks stay.
    expect(linesOf(para('aaa\nbbb ccc', 160, { composer: 'every-line' }))).toEqual([
      'aaa',
      'bbb ccc',
    ]);
  });

  it('hangs punctuation outside the margins', () => {
    const d = para('"quoted text."', 200, { align: 'right', hanging: true });
    const lay = layoutText(d, opts);
    // The closing period hangs past the right edge; the line's letters end there.
    const l = lay.lines[0];
    expect(l.x + l.width).toBeCloseTo(210, 6);
    const left = layoutText(para('"quoted"', 200, { hanging: true }), opts).lines[0];
    expect(left.x).toBeCloseTo(-10, 6);
  });
});

describe('validation', () => {
  it('accepts the new paragraph and character options and rejects bad values', () => {
    const ok = para('x', 100, {
      kashida: true,
      leadingModel: 'top',
      autoLeading: 140,
      wordSpacing: [80, 100, 133],
      letterSpacing: [-5, 0, 10],
      glyphScaling: [95, 100, 105],
      hyphenMinWord: 5,
      hyphenLimit: 2,
      hyphenZone: 12,
      hyphenCapitalized: true,
      composer: 'every-line',
      hanging: true,
    });
    ok.content = applyCharStyle(ok.content, 0, 1, { noBreak: true, wholeWidths: true });
    validateTextData(ok);
    expect(() => validateTextData(para('x', 100, { wordSpacing: [120, 100, 133] }))).toThrow();
    expect(() => validateTextData(para('x', 100, { leadingModel: 'middle' as never }))).toThrow();
    expect(() => validateTextData(para('x', 100, { composer: 'paragraph' as never }))).toThrow();
  });
});

describe('PSD', () => {
  it('round-trips the paragraph and character options', () => {
    const ps: Partial<ParagraphStyle> = {
      align: 'justify-left',
      hyphenate: true,
      wordSpacing: [80, 100, 133],
      letterSpacing: [-5, 0, 10],
      glyphScaling: [95, 100, 105],
      autoLeading: 140,
      leadingModel: 'top',
      hanging: true,
      composer: 'every-line',
      hyphenMinWord: 5,
      hyphenBefore: 3,
      hyphenAfter: 2,
      hyphenLimit: 2,
      hyphenZone: 18,
    };
    const d = para('some words', 200, ps);
    d.content = applyCharStyle(d.content, 0, 4, { noBreak: true });
    const back = importPsdText(exportPsdText(d, [1, 0, 0, 1, 0, 0], 72), 72)!.data;
    expect(back.content.paragraphs[0].style).toMatchObject(ps);
    expect(back.content.paragraphs[0].runs[0].style.noBreak).toBe(true);
    validateTextData(back);
  });
});
