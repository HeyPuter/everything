// Frame-by-frame renders (GIF export) load what the picture needs first.
import { describe, it, expect, vi } from 'vitest';

const seen = [];
vi.mock('../src/engine/compositor.js', async () => {
  const { getLut } = await import('../src/engine/luts.js');
  return {
    Compositor: class {
      resize() {}
      render() {
        seen.push(Boolean(getLut('lut1')));
        return true;
      }
      dispose() {}
    },
  };
});

import { renderFrames } from '../src/engine/exporter.js';
import { addClip } from '../src/model/timeline.js';
import { fixture, clip } from './helpers.js';

const CUBE = ['LUT_3D_SIZE 2', '0 0 0', '1 0 0', '0 1 0', '1 1 0', '0 0 1', '1 0 1', '0 1 1', '1 1 1'].join('\n');

describe('renderFrames', () => {
  it('loads the LUTs the project uses before the first frame', async () => {
    const p = fixture();
    addClip(p, clip('adjust', 0, 1, { grade: { lut: { id: 'lut1', amount: 100 } } }), { ripple: true, linkOverlays: true });
    const library = { readLut: vi.fn(async () => ({ text: CUBE, name: 'Teal' })) };
    for await (const f of renderFrames(p, library, { width: 64, height: 36, fps: 4 })) expect(f.canvas).toBeTruthy();
    expect(library.readLut).toHaveBeenCalledWith('lut1');
    expect(seen.length).toBe(4);
    expect(seen.every(Boolean)).toBe(true);
  });
});
