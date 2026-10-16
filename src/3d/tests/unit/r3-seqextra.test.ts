// @vitest-environment happy-dom
// Sequencer helpers: deinterlacing, text style presets, proxy settings and the scene adapter.
import { describe, it, expect } from 'vitest';
import { deinterlaceRows } from '../../src/sequencer/deinterlace';
import { applyStyle, styleOf, BUILTIN_STYLES } from '../../src/sequencer/textpresets';
import { defaultProxy, wantedSizes, contentFrames } from '../../src/sequencer/proxy';
import type { Strip } from '../../src/sequencer/types';

describe('deinterlace', () => {
  it('blends each line with its neighbours', () => {
    // 1×4 image, alternating black and white lines
    const src = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 255]);
    const out = deinterlaceRows(src, 1, 4);
    expect(out[4]).toBe(128);
    expect(out[8]).toBe(128);
    expect(out[3]).toBe(255);
  });
});

describe('text style presets', () => {
  it('copy the style but not the text', () => {
    const s = { type: 'TEXT', text: 'Hello', font_size: 20, color: [1, 0, 0, 1], location: [0.5, 0.1] } as unknown as Strip;
    applyStyle(s, BUILTIN_STYLES[0][1]);
    expect(s.text).toBe('Hello');
    expect(s.font_size).toBe(48);
    expect(s.location).toEqual([0.5, 0.1]);
    const st = styleOf(s);
    expect(st.use_outline).toBe(true);
    expect('text' in st).toBe(false);
    (st.color as number[])[0] = 0;
    expect((s.color as number[])[0]).toBe(1);
  });
});

describe('proxies', () => {
  it('build the sizes asked for, over the content frames', () => {
    const p = defaultProxy();
    expect(wantedSizes(p)).toEqual([25]);
    p.build_75 = true;
    expect(wantedSizes(p)).toEqual([25, 75]);
    expect(contentFrames({ frame_duration: 100, animation_offset_start: 5, animation_offset_end: 3 } as Strip)).toBe(108);
  });
});
