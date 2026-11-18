import { describe, expect, it } from 'vitest';
import type { Editor } from '../src/editor';
import { applyBrushPreset, currentBrushPreset } from '../src/features/brushes';
import { brushFor } from '../src/features/paint';

const editor = () => ({ tool: 'brush', options() {}, dock: { update() {} } }) as unknown as Editor;

describe('brush presets from files and libraries', () => {
  it('keeps settings in range and leaves out damaged parts', () => {
    const e = editor();
    applyBrushPreset(e, { name: 'Hostile', tip: { size: 1e9, spacing: 0, hardness: -3, roundness: Number.NaN, angle: 'up', mode: 'not-a-mode', airbrush: 'yes', dynamics: { count: 1e6, scatter: -1, pressureSize: 1, unknown: 5 } } as never, sample: { width: 4, height: 4, data: '%%%' } });
    const s = brushFor('brush');
    expect(s).toMatchObject({ size: 5000, spacing: 0.01, hardness: 0, roundness: 1, angle: 0, mode: 'normal', airbrush: false, dynamics: { count: 16, scatter: 0, pressureSize: false } });
    expect(s.sample).toBeUndefined();
    expect('unknown' in s.dynamics).toBe(false);
    // A preset without a tip, or a sample of the wrong size, is still usable.
    expect(() => applyBrushPreset(e, {} as never)).not.toThrow();
    applyBrushPreset(e, { name: 'Sampled', tip: { size: 20 }, sample: { width: 2, height: 2, data: btoa('\x00\xff\x80') } });
    expect(brushFor('brush').sample).toBeUndefined();
    applyBrushPreset(e, { name: 'Sampled', tip: { size: 20 }, sample: { width: 2, height: 2, data: btoa('\x00\xff\x80\x10') } });
    expect(Array.from(brushFor('brush').sample!.data)).toEqual([0, 255, 128, 16]);
    expect(brushFor('brush').size).toBe(20);
  });
  it('saves the largest sampled tip a preset can hold as a library preset', () => {
    const e = editor();
    const data = new Uint8Array(1024 * 1024);
    for (let i = 0; i < data.length; i++) data[i] = (i * 7) & 255;
    let binary = '';
    for (let i = 0; i < data.length; i += 4096)
      binary += String.fromCharCode(...data.subarray(i, i + 4096));
    const sample = { width: 1024, height: 1024, data: btoa(binary) };
    applyBrushPreset(e, { name: 'Big', tip: { size: 100 }, sample });
    expect(brushFor('brush').sample?.width).toBe(1024);
    const saved = currentBrushPreset(e, 'Big copy');
    expect(saved.sample?.data).toBe(btoa(binary));
  });
});
