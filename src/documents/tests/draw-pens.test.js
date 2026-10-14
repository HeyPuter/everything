import { describe, it, expect } from 'vitest';
import { loadPens, savePens, newPen, penLabel, penWidthPx, DEFAULT_PENS, penIconSvg } from '../src/views/draw-pens.js';

const memory = () => { const map = new Map(); return { getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v)) }; };

describe('pen gallery storage', () => {
  it('starts from the default pens and keeps changes', () => {
    const storage = memory();
    const state = loadPens(storage);
    expect(state.pens.map(p => p.tool)).toEqual(DEFAULT_PENS.map(p => p.tool));
    state.pens[0].color = '00B050'; state.pens.push(newPen('highlighter')); state.active = state.pens.at(-1).id;
    savePens(state, storage);
    const again = loadPens(storage);
    expect(again.pens[0].color).toBe('00B050');
    expect(again.pens).toHaveLength(DEFAULT_PENS.length + 1);
    expect(again.active).toBe(state.active);
  });
  it('falls back to the defaults when storage is unusable or invalid', () => {
    expect(loadPens({ getItem: () => { throw new Error('blocked'); } }).pens).toHaveLength(DEFAULT_PENS.length);
    const storage = memory(); storage.setItem('documents.draw.pens.v1', JSON.stringify({ pens: [{ id: 'x', tool: 'brush', color: '000000', width: 1 }] }));
    expect(loadPens(storage).pens).toHaveLength(DEFAULT_PENS.length);
    expect(() => savePens({ pens: [], active: null }, { setItem: () => { throw new Error('full'); } })).not.toThrow();
  });
  it('names pens and sizes their ink', () => {
    expect(penLabel({ tool: 'highlighter', color: 'FFFF00', width: 6 })).toBe('Highlighter: Yellow, 6 mm');
    expect(penWidthPx({ width: 25.4 })).toBeCloseTo(96, 6);
    expect(penIconSvg({ tool: 'pencil', color: 'C00000', width: 1 })).toContain('#C00000');
  });
});
