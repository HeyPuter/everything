import { describe, expect, it } from 'vitest';
import { layoutText, type Measure } from '../src/imaging/text/layout';
import { applyCharStyle, defaultCharStyle, fromPlainText, plainText, type TextLayerData } from '../src/imaging/text/model';
import { blockFor } from '../src/imaging/text/block-text';
import { blockTextData } from '../src/features/type/path-type';
import { scaleTextData, validateTextData } from '../src/model/text-layer';

// Monospace stand-in: every character is half an em wide; ascent 0.8 em, descent 0.2 em.
const sizeOf = (font: string) => Number(/([\d.]+)px/.exec(font)![1]);
const mono: Measure = (text, font) => {
  const s = sizeOf(font);
  return { width: [...text].length * s * 0.5, ascent: s * 0.8, descent: s * 0.2 };
};
const style = { ...defaultCharStyle(), size: 20 }; // 20 px at 72 ppi: 10 px per character

function point(text: string, extra: Partial<TextLayerData> = {}): TextLayerData {
  return { content: fromPlainText(text, style), mode: 'point', origin: { x: 10, y: 50 }, orientation: 'horizontal', antiAlias: 'smooth', ...extra };
}

describe('block text', () => {
  it('scales every line to the block width and stacks the lines', () => {
    const d = point('BIG\nTITLE TEXT\nOK', { block: { width: 200, gap: 4 } });
    const lay = layoutText(d, { measure: mono });
    expect(lay.lines.map((l) => Math.round(l.width))).toEqual([200, 200, 200]);
    expect(lay.lines.every((l) => l.x === 10)).toBe(true);
    // Scales: 200/30, 200/100 and 200/20; runs grow with their lines.
    const sizes = lay.runs.map((r) => Math.round(r.sizePx * 100) / 100);
    expect(sizes).toEqual([133.33, 40, 200]);
    expect(lay.runs[0].font).toContain('133.333px');
    // Baselines: the first stays; the next sit a gap below the previous line,
    // measured by capital height (0.7 em of the scaled size).
    const ys = lay.lines.map((l) => Math.round(l.y * 100) / 100);
    expect(ys[0]).toBe(50);
    expect(ys[1]).toBeCloseTo(50 + 4 + 0.7 * 40, 5);
    expect(ys[2]).toBeCloseTo(ys[1] + 4 + 0.7 * 200, 5);
    // Carets follow the scaled lines.
    expect(lay.caretRect(1).x).toBeCloseTo(10 + 200 / 3, 5);
    expect(lay.hitTest(10 + 155, ys[1])).toBe(4 + 8);
  });

  it('leaves room for descenders', () => {
    const lay = layoutText(point('gyp\nAB', { block: { width: 100, gap: 0 } }), { measure: mono });
    const first = lay.runs[0].sizePx;
    expect(lay.lines[1].y - lay.lines[0].y).toBeCloseTo(0.22 * first + 0.7 * lay.runs[1].sizePx, 5);
  });

  it('keeps each underline and strikethrough on its own line', () => {
    for (const leading of ['auto', 12, 4] as const) {
      for (const kind of ['underline', 'strikethrough'] as const) {
        const text = 'ABCD\nABCDEFGH';
        const content = applyCharStyle(fromPlainText(text, { ...style, leading }), 0, text.length, { [kind]: true });
        const lay = layoutText(point('', { content, block: { width: 160, gap: 4 } }), { measure: mono });
        expect(lay.decorations.length).toBe(2);
        // Each spans its own line's full (scaled) width and sits near its baseline.
        lay.decorations.forEach((d, i) => {
          expect(d.width).toBeCloseTo(160, 5);
          expect(Math.abs(d.y - lay.lines[i].y)).toBeLessThan(lay.lines[i].ascent);
        });
      }
    }
  });

  it('places the block by its alignment', () => {
    const centered = point('AB\nABCD', { block: { width: 80, gap: 0 } });
    centered.content.paragraphs.forEach((p) => (p.style.align = 'center'));
    expect(layoutText(centered, { measure: mono }).lines.map((l) => l.x)).toEqual([-30, -30]);
  });

  it('converts point text to block text at the widest line and scales with the layer', () => {
    const d = point('ONE\nLONGER LINE');
    const b = blockTextData(d, layoutText(d, { measure: mono }));
    expect(b.block).toEqual(blockFor(110));
    expect(b.block!.width).toBe(110);
    expect(b.origin).toEqual({ x: 10, y: 50 });
    validateTextData(b);
    expect(scaleTextData(b, 2).block).toEqual({ width: 220, gap: b.block!.gap * 2 });
    expect(() => validateTextData({ ...b, orientation: 'vertical' })).toThrow(/block/);
  });
});

describe('vertical text forms', () => {
  const vertical = (text: string, form: '' | 'rotate' | 'combine', from = 0, to = text.length): TextLayerData => ({
    content: applyCharStyle(fromPlainText(text, style), from, to, { vertical: form }),
    mode: 'point',
    origin: { x: 100, y: 0 },
    orientation: 'vertical',
    antiAlias: 'smooth',
  });

  it('stacks Latin upright by default, one em per character', () => {
    const lay = layoutText(vertical('AB12', ''), { measure: mono });
    expect(lay.runs.map((r) => r.text)).toEqual(['A', 'B', '1', '2']);
    expect(lay.runs.every((r) => !r.angle)).toBe(true);
    expect(lay.lines[0].stopPos.at(-1)).toBe(80);
  });

  it('turns Latin sideways as one run that advances by its width', () => {
    const lay = layoutText(vertical('日本Hello', 'rotate'), { measure: mono });
    expect(lay.runs.map((r) => [r.text, r.angle ?? 0])).toEqual([['日', 0], ['本', 0], ['Hello', Math.PI / 2]]);
    // Two upright cells of 20 px, then five rotated characters of 10 px.
    expect(lay.lines[0].stopPos.at(-1)).toBe(40 + 50);
    const run = lay.runs[2];
    expect(run.y).toBe(40);
    // Centered on the column: (ascent - descent) / 2 to the left of its center.
    expect(run.x).toBeCloseTo(lay.lines[0].x - (16 - 4) / 2, 5);
  });

  it('sets short runs horizontally in one cell and turns longer ones sideways', () => {
    const lay = layoutText(vertical('令和12年2026', 'combine'), { measure: mono });
    const texts = lay.runs.map((r) => r.text);
    expect(texts).toEqual(['令', '和', '12', '年', '2026']);
    const cell = lay.runs[2];
    expect(cell.angle).toBeUndefined();
    // Two digits are 20 px wide: they fit the 20 px cell without condensing.
    expect(cell.scaleX).toBe(1);
    expect(cell.x).toBeCloseTo(lay.lines[0].x - 10, 5);
    expect(lay.runs[4].angle).toBe(Math.PI / 2);
    // Cells: 令 和 [12] 年 then 2026 sideways (40 px).
    expect(lay.lines[0].stopPos.at(-1)).toBe(4 * 20 + 40);
    // Three characters condense to fit one cell.
    const three = layoutText(vertical('123', 'combine'), { measure: mono }).runs[0];
    expect(three.scaleX).toBeCloseTo(20 / 30, 5);
  });

  it('applies the form only where the style asks for it', () => {
    const lay = layoutText(vertical('ABCD', 'rotate', 2, 4), { measure: mono });
    expect(lay.runs.map((r) => r.text)).toEqual(['A', 'B', 'CD']);
    expect(plainText(vertical('ABCD', 'rotate').content)).toBe('ABCD');
  });
});
