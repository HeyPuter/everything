// OpenEXR output: files written here read back with an independent EXR reader.
import { describe, expect, it } from 'vitest';
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js';
import { FloatType } from 'three';
import { writeExr, planes, toHalf } from '../../src/render/final/exr';

const W = 5,
  H = 3;
function rgba(): Float32Array {
  const d = new Float32Array(W * H * 4);
  for (let i = 0; i < W * H; i++) d.set([i / 4, 1 - i / 20, 2.5 * (i % 3), i % 2 ? 1 : 0.5], i * 4);
  return d;
}

function read(bytes: Uint8Array) {
  const l = new EXRLoader();
  l.setDataType(FloatType);
  return l.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer) as { width: number; height: number; data: Float32Array };
}

describe('OpenEXR writer', () => {
  it('converts floats to halves', () => {
    expect(toHalf(1)).toBe(0x3c00);
    expect(toHalf(-2)).toBe(0xc000);
    expect(toHalf(0.5)).toBe(0x3800);
    expect(toHalf(65504)).toBe(0x7bff);
    expect(toHalf(1e6)).toBe(0x7c00);
    expect(toHalf(0)).toBe(0);
  });

  for (const compression of ['NONE', 'ZIPS', 'ZIP'] as const)
    for (const half of [true, false])
      it(`round-trips RGBA (${compression}, ${half ? 'half' : 'float'})`, () => {
        const src = rgba();
        const bytes = writeExr(planes(src, 4, ['R', 'G', 'B', 'A']), W, H, { half, compression });
        const img = read(bytes);
        expect([img.width, img.height]).toEqual([W, H]);
        // the reader returns rows bottom-up
        for (let y = 0; y < H; y++)
          for (let x = 0; x < W; x++)
            for (let c = 0; c < 4; c++) {
              const a = src[(y * W + x) * 4 + c];
              const b = img.data[((H - 1 - y) * W + x) * 4 + c];
              expect(b).toBeCloseTo(a, half ? 2 : 5);
            }
      });
});

describe('render results as OpenEXR', () => {
  it('writes the Combined pass, or every pass with layer-prefixed channels', async () => {
    const { resultExr } = await import('../../src/render/final/renderexr');
    const { defaultRender } = await import('../../src/data/defaults');
    const r = defaultRender();
    const combined = rgba();
    const depth = new Float32Array(W * H).map((_, i) => 1 + i);
    const result = { width: W, height: H, passes: { Combined: combined, Depth: depth } } as never;
    const single = read(resultExr(result, r, 'OPEN_EXR'));
    expect(single.data[3]).toBeCloseTo(combined[((H - 1) * W) * 4 + 3], 2);
    const multi = resultExr(result, r, 'OPEN_EXR_MULTILAYER', 'Layer');
    const text = new TextDecoder('latin1').decode(multi.slice(0, 600));
    for (const ch of ['Layer.Combined.R', 'Layer.Combined.A', 'Layer.Depth.Z']) expect(text).toContain(ch);
  });
});
