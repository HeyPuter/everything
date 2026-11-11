import { describe, expect, it } from 'vitest';
import { layoutText, type Measure } from '../src/imaging/text/layout';
import { applyCharStyle, applyParagraphStyle, defaultCharStyle, fromPlainText, type TextLayerData } from '../src/imaging/text/model';

// Monospace stand-in: 10 px per character at 20 px.
const mono: Measure = (text, font) => {
  const s = Number(/([\d.]+)px/.exec(font)![1]);
  return { width: [...text.replace(/‌/g, '')].length * s * 0.5, ascent: s * 0.8, descent: s * 0.2 };
};
const style = { ...defaultCharStyle(), size: 20 };
const point = (text: string, rtl = false): TextLayerData => {
  let content = fromPlainText(text, style);
  if (rtl) content = applyParagraphStyle(content, 0, text.length, { direction: 'rtl', align: 'right' });
  return { content, mode: 'point', origin: { x: 100, y: 50 }, orientation: 'horizontal', antiAlias: 'smooth' };
};

describe('bidirectional layout', () => {
  it('keeps left-to-right text in logical order', () => {
    const l = layoutText(point('abc'), { measure: mono });
    expect(l.runs.map((r) => [r.text, r.x, !!r.rtl])).toEqual([['abc', 100, false]]);
    expect(l.lines[0].boxes).toBeUndefined();
  });
  it('places a Hebrew word right to left inside English', () => {
    // "ab " then Hebrew alef-bet-gimel, then " cd": the Hebrew run is drawn as one RTL run.
    const text = 'ab אבג cd';
    const l = layoutText(point(text), { measure: mono });
    const heb = l.runs.find((r) => r.rtl)!;
    expect(heb.text).toBe('אבג');
    expect(heb.x).toBe(130);
    // The first Hebrew letter (logical index 3) sits at the right end of its run.
    const box = l.lines[0].boxes!.find((b) => b.start === 3)!;
    expect(box.x0).toBe(150);
    // Caret before the first Hebrew letter is on its right edge.
    expect(l.caretRect(3).x).toBe(160);
    // A selection of the Hebrew letters is one rectangle across the run.
    expect(l.selectionRects(3, 6)).toEqual([{ x: 130, y: 50 - 16, width: 30, height: 20 }]);
  });
  it('right-to-left paragraphs order runs from the right', () => {
    // An RTL paragraph with an English word: the English run is visually
    // left of the preceding Hebrew word.
    const text = 'אב cd';
    const l = layoutText(point(text, true), { measure: mono });
    const line = l.lines[0];
    // Right aligned at the origin: the line extends left from x = 100.
    expect(line.x).toBe(50);
    const he = line.boxes!.find((b) => b.start === 0)!;
    const en = line.boxes!.find((b) => b.start === 3)!;
    expect(he.x0).toBeGreaterThan(en.x0);
  });
  it('turns slashes between digits into fraction slashes when Fractions is on', () => {
    const content = applyCharStyle(fromPlainText('1/2 and/or', style), 0, 10, { features: 'frac' });
    const l = layoutText({ ...point(''), content }, { measure: mono });
    expect(l.runs.map((r) => r.text).join('')).toBe('1\u20442 and/or');
  });
  it('shapes digits when the style asks for Arabic-Indic digits', () => {
    let content = fromPlainText('12', style);
    content = applyCharStyle(content, 0, 2, { digits: 'arabic' });
    const l = layoutText({ ...point(''), content }, { measure: mono });
    expect(l.runs[0].text).toBe('١٢');
  });
});

describe('visual caret movement', () => {
  // Steps right (or left) from `from` until the line's end; returns the caret x positions.
  const walk = (data: TextLayerData, from: number, dir: -1 | 1) => {
    const l = layoutText(data, { measure: mono });
    const xs = [l.caretRect(from).x];
    let i = from;
    for (let n = 0; n < 20; n++) {
      const v = l.moveVisual(i, dir);
      if (!('index' in v)) break;
      i = v.index;
      xs.push(l.caretRect(i).x);
    }
    return xs;
  };
  it('moves the caret rightwards on screen through a right-to-left paragraph', () => {
    // Right arrow from the logical start (the right end) cannot go further right,
    // and Left walks every caret position leftwards.
    const data = point('אבגד', true);
    const l = layoutText(data, { measure: mono });
    expect(l.moveVisual(0, 1)).toEqual({ logical: -1 });
    expect(walk(data, 0, -1)).toEqual([100, 90, 80, 70, 60]);
    expect(walk(data, 4, 1)).toEqual([60, 70, 80, 90, 100]);
  });
  it('steps across a Hebrew word inside English in screen order', () => {
    const data = point('ab אבג cd');
    const xs = walk(data, 0, 1);
    // Strictly increasing positions from the left end to the right end.
    expect(xs[0]).toBe(100);
    expect(xs.at(-1)).toBe(190);
    for (let k = 1; k < xs.length; k++) expect(xs[k]).toBeGreaterThan(xs[k - 1]);
    const back = walk(data, 9, -1);
    expect(back.at(-1)).toBe(100);
    for (let k = 1; k < back.length; k++) expect(back[k]).toBeLessThan(back[k - 1]);
  });
  it('leaves left-to-right lines to logical movement', () => {
    const l = layoutText(point('abc'), { measure: mono });
    expect(l.moveVisual(1, 1)).toEqual({ logical: 1 });
    expect(l.moveVisual(1, -1)).toEqual({ logical: -1 });
  });
});
