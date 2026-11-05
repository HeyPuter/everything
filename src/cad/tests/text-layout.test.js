import { describe, expect, it } from 'vitest';
import { ADVANCES, MONO_ADVANCE, glyphIndex } from '../src/core/text/font.js';
import { decodeSpecial, layoutText, measureText, textBounds } from '../src/core/text/layout.js';

const adv = (ch) => ADVANCES[glyphIndex(ch.codePointAt(0))];

function text(props) {
  return { type: 'text', x: 0, y: 0, h: 2, rot: 0, value: 'HELLO', halign: 'left', valign: 'baseline', widthFactor: 1, oblique: 0, ...props };
}

function strokeBounds(strokes) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const s of strokes) {
    for (let i = 0; i < s.length; i += 2) {
      b[0] = Math.min(b[0], s[i]);
      b[1] = Math.min(b[1], s[i + 1]);
      b[2] = Math.max(b[2], s[i]);
      b[3] = Math.max(b[3], s[i + 1]);
    }
  }
  return b;
}

describe('decodeSpecial', () => {
  it('decodes control codes', () => {
    expect(decodeSpecial('45%%d')).toBe('45\u00b0');
    expect(decodeSpecial('%%p0.05')).toBe('\u00b10.05');
    expect(decodeSpecial('%%c20')).toBe('\u230020');
    expect(decodeSpecial('%%C20 %%D %%P')).toBe('\u230020 \u00b0 \u00b1');
    expect(decodeSpecial('50%%%')).toBe('50%');
    expect(decodeSpecial('%%176')).toBe('\u00b0');
  });

  it('decodes unicode escapes', () => {
    expect(decodeSpecial('\\U+00B0')).toBe('\u00b0');
    expect(decodeSpecial('a\\u+2300b')).toBe('a\u2300b');
  });

  it('draws %%u, %%o and %%k as lines instead of showing the codes', () => {
    expect(decodeSpecial('%%uAB%%u %%oC %%kD 50%%%u')).toBe('AB C D 50%u');
    const plain = layoutText({ type: 'text', x: 0, y: 0, h: 2, value: 'AB x CD' });
    const t = layoutText({ type: 'text', x: 0, y: 0, h: 2, value: '%%uAB%%u x %%oCD' });
    expect(t.strokes.length).toBe(plain.strokes.length + 2);
    const [under, over] = t.strokes.slice(-2);
    const ab = measureText('AB', 2);
    expect([...under]).toEqual([0, expect.closeTo(-0.3), expect.closeTo(ab), expect.closeTo(-0.3)]);
    expect(over[1]).toBeGreaterThan(2);
    expect(over[2]).toBeCloseTo(measureText('AB x CD', 2));
  });

  it('leaves plain text alone', () => {
    expect(decodeSpecial('50% off')).toBe('50% off');
    expect(decodeSpecial('')).toBe('');
    expect(decodeSpecial(null)).toBe('');
  });
});

describe('measureText', () => {
  it('sums advances scaled by height and width factor', () => {
    expect(measureText('AB', 2)).toBeCloseTo(2 * (adv('A') + adv('B')), 6);
    expect(measureText('AB', 2, 0.5)).toBeCloseTo(adv('A') + adv('B'), 6);
    expect(measureText('', 2)).toBe(0);
  });

  it('measures decoded text', () => {
    expect(measureText('%%d', 1)).toBeCloseTo(adv('\u00b0'), 6);
  });

  it('uses fixed advances for mono', () => {
    expect(measureText('iW', 3, 1, 'mono')).toBeCloseTo(2 * 3 * MONO_ADVANCE, 6);
  });
});

describe('layoutText', () => {
  it('anchors baseline-left by default', () => {
    const w = measureText('HELLO', 2);
    const { box, strokes } = layoutText(text({ x: 10, y: 5 }));
    expect(box[0]).toBeCloseTo(10, 6);
    expect(box[1]).toBeCloseTo(5 - 0.6, 6);
    expect(box[4]).toBeCloseTo(10 + w, 6);
    expect(box[5]).toBeCloseTo(7, 6);
    expect(strokes.length).toBeGreaterThan(0);
    const b = strokeBounds(strokes);
    expect(b[1]).toBeCloseTo(5, 4);
    expect(b[3]).toBeCloseTo(7, 4);
  });

  it('centers and right-aligns', () => {
    const w = measureText('HELLO', 2);
    const c = layoutText(text({ halign: 'center' })).box;
    expect((c[0] + c[2]) / 2).toBeCloseTo(0, 6);
    expect(c[2] - c[0]).toBeCloseTo(w, 6);
    const r = layoutText(text({ halign: 'right' })).box;
    expect(r[2]).toBeCloseTo(0, 6);
    expect(r[0]).toBeCloseTo(-w, 6);
  });

  it('aligns vertically', () => {
    expect(layoutText(text({ valign: 'top' })).box[5]).toBeCloseTo(0, 6);
    const m = layoutText(text({ valign: 'middle' })).box;
    expect(m[5]).toBeCloseTo(1, 6);
    expect(m[1]).toBeCloseTo(-1 - 0.6, 6);
    expect(layoutText(text({ valign: 'bottom' })).box[1]).toBeCloseTo(0, 6);
    // Middle-center ink is centred on the point for capitals.
    const b = strokeBounds(layoutText(text({ halign: 'center', valign: 'middle' })).strokes);
    expect((b[1] + b[3]) / 2).toBeCloseTo(0, 4);
  });

  it('rotates about the alignment point', () => {
    const w = measureText('HELLO', 2);
    const { box, strokes } = layoutText(text({ x: 1, y: 1, rot: Math.PI / 2 }));
    // Baseline runs up the +Y axis; the cap line is to the left.
    expect(box[0]).toBeCloseTo(1 + 0.6, 6);
    expect(box[1]).toBeCloseTo(1, 6);
    expect(box[2]).toBeCloseTo(1 + 0.6, 6);
    expect(box[3]).toBeCloseTo(1 + w, 6);
    expect(box[4]).toBeCloseTo(1 - 2, 6);
    const b = strokeBounds(strokes);
    expect(b[0]).toBeCloseTo(-1, 4);
    expect(b[2]).toBeCloseTo(1, 4);
  });

  it('keeps strokes inside the box', () => {
    for (const value of ['Hello, World!', 'gjpqy|[]{}', '%%c12.5 %%p0.1 45%%d']) {
      const { box, strokes } = layoutText(text({ value, x: 3, y: -2 }));
      const b = strokeBounds(strokes);
      expect(b[0]).toBeGreaterThanOrEqual(box[0] - 1e-6);
      expect(b[1]).toBeGreaterThanOrEqual(box[1] - 1e-6);
      expect(b[2]).toBeLessThanOrEqual(box[4] + 1e-6);
      expect(b[3]).toBeLessThanOrEqual(box[5] + 1e-6);
    }
  });

  it('slants glyphs with the oblique angle', () => {
    const straight = strokeBounds(layoutText(text({ value: 'I' })).strokes);
    const slanted = layoutText(text({ value: 'I', oblique: Math.PI / 12 })).strokes;
    const s = slanted[0];
    // The stem goes from baseline to cap height; its top moves right by h * tan(15 deg).
    const topX = s[1] > s[3] ? s[0] : s[2];
    expect(topX - straight[0]).toBeCloseTo(2 * Math.tan(Math.PI / 12), 5);
  });

  it('applies the width factor', () => {
    const a = strokeBounds(layoutText(text({ value: 'W' })).strokes);
    const b = strokeBounds(layoutText(text({ value: 'W', widthFactor: 0.5 })).strokes);
    expect(b[2] - b[0]).toBeCloseTo((a[2] - a[0]) / 2, 5);
    expect(b[3] - b[1]).toBeCloseTo(a[3] - a[1], 5);
  });

  it('takes the font from the style', () => {
    const box = layoutText(text({ value: 'ii' }), { font: 'mono' }).box;
    expect(box[2] - box[0]).toBeCloseTo(2 * 2 * MONO_ADVANCE, 6);
  });

  it('returns no strokes for empty text', () => {
    expect(layoutText(text({ value: '' })).strokes).toEqual([]);
  });
});

describe('textBounds', () => {
  it('matches the layout box', () => {
    const ent = text({ x: 4, y: 2, rot: 0.3, halign: 'center', valign: 'middle' });
    const { box, strokes } = layoutText(ent);
    const b = textBounds(ent);
    const xs = [box[0], box[2], box[4], box[6]];
    const ys = [box[1], box[3], box[5], box[7]];
    expect(b).toEqual([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
    const s = strokeBounds(strokes);
    expect(s[0]).toBeGreaterThanOrEqual(b[0] - 1e-6);
    expect(s[3]).toBeLessThanOrEqual(b[3] + 1e-6);
  });
});
