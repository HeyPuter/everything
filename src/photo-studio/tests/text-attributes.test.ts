import { describe, expect, it } from 'vitest';
import {
  applyCharStyle,
  applyParagraphStyle,
  applyTextAttributes,
  charStyleOfRange,
  defaultCharStyle,
  defaultParagraphStyle,
  fromPlainText,
  plainText,
  type CharStyle,
  type ParagraphStyle,
} from '../src/imaging/text/model';
import { copiedTextAttributes, rememberTextAttributes } from '../src/features/type/text-attributes';

const source: CharStyle = {
  ...defaultCharStyle(),
  family: 'Georgia',
  size: 40,
  weight: 700,
  color: [200, 10, 10],
  tracking: 50,
  underline: true,
  digits: 'arabic',
};
const sourcePara: ParagraphStyle = {
  ...defaultParagraphStyle(),
  align: 'center',
  spaceBefore: 6,
  kashida: true,
  leadingModel: 'top',
};

describe('Paste Text Attributes', () => {
  it('restyles a range and its paragraphs without changing the text', () => {
    let c = fromPlainText('one two\nthree four\nfive');
    c = applyCharStyle(c, 0, 3, { features: 'dlig', noBreak: true });
    const out = applyTextAttributes(c, 4, 13, source, sourcePara);
    expect(plainText(out)).toBe(plainText(c));
    // The range takes every character attribute; the rest is unchanged.
    expect(charStyleOfRange(out, 4, 13)).toMatchObject({
      family: 'Georgia',
      size: 40,
      weight: 700,
      color: [200, 10, 10],
      tracking: 50,
      underline: true,
      digits: 'arabic',
    });
    expect(charStyleOfRange(out, 0, 3)).toMatchObject({
      family: 'Inter',
      features: 'dlig',
      noBreak: true,
    });
    expect(charStyleOfRange(out, 13, 18).family).toBe('Inter');
    // Paragraphs the range touches take the paragraph attributes.
    expect(out.paragraphs.map((p) => p.style.align)).toEqual(['center', 'center', 'left']);
    expect(out.paragraphs[1].style).toEqual(sourcePara);
    // The input is untouched.
    expect(c.paragraphs[0].style.align).toBe('left');
  });

  it('clears optional attributes the copied text does not have', () => {
    const c = applyCharStyle(fromPlainText('abc'), 0, 3, {
      features: 'onum',
      vertical: 'rotate',
      wholeWidths: true,
    });
    const p = applyParagraphStyle(c, 0, 3, { hyphenLimit: 2, composer: 'every-line' });
    const out = applyTextAttributes(p, 0, 3, defaultCharStyle(), defaultParagraphStyle());
    const st = out.paragraphs[0].runs[0].style;
    expect(st.features || undefined).toBeUndefined();
    expect(st.vertical || undefined).toBeUndefined();
    expect(st.wholeWidths || undefined).toBeUndefined();
    expect(out.paragraphs[0].style.hyphenLimit).toBeUndefined();
    expect(out.paragraphs[0].style.composer).toBeUndefined();
    expect(out.paragraphs[0].runs.length).toBe(1);
  });

  it('remembers the first character and paragraph of copied text', () => {
    let c = fromPlainText('\nbold rest');
    c = applyCharStyle(c, 1, 5, { weight: 800 });
    c = applyParagraphStyle(c, 1, 2, { align: 'right' });
    rememberTextAttributes(c);
    const a = copiedTextAttributes()!;
    expect(a.char.weight).toBe(800);
    expect(a.paragraph.align).toBe('right');
    // A copy is kept, not the live object.
    c.paragraphs[1].runs[0].style.weight = 100;
    expect(copiedTextAttributes()!.char.weight).toBe(800);
  });
});
