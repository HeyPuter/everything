import { describe, it, expect } from 'vitest';
import { srgbEncode, srgbDecode, displayPixel, fastDisplay, toneMap, toDisplayRGBA8, type ViewSettings } from '../../src/render/final/colormanage';
import { lightIntensity, areaLightArea, renderSize, frameList, halton, jitter, shutterOffset, mistFactor, bounceSettings, formatTime, frameFileName } from '../../src/render/final/units';
import { crc32, ZipWriter, concatBytes } from '../../src/render/final/zip';
import { ebmlSize, muxWebM } from '../../src/render/final/webm';
import { texelDirection, zUpEquirectUV } from '../../src/render/final/environment';
import { passesFromGuide } from '../../src/render/final/passes';
import { depthRange, passToRGBA8, samplePixel, toBW, type RenderResult } from '../../src/render/final/result';
import { ATROUS_TAPS, denoiseSchedule } from '../../src/render/final/denoise';
import { frustumHalfExtents } from '../../src/render/final/camera';
import { bloomParams } from '../../src/render/final/raster';

const std: ViewSettings = { view_transform: 'STANDARD', exposure: 0, gamma: 1 };

describe('colour management', () => {
  it('sRGB encode/decode round-trips', () => {
    for (const v of [0, 0.001, 0.0031308, 0.18, 0.5, 1]) expect(srgbDecode(srgbEncode(v))).toBeCloseTo(v, 6);
    expect(srgbEncode(0.18)).toBeCloseTo(0.4613, 3);
  });
  it('Standard maps linear to sRGB and clips', () => {
    const o = [0, 0, 0, 0];
    displayPixel(0.18, 0.5, 4, 1, std, o);
    expect(o[0]).toBeCloseTo(0.4613, 3);
    expect(o[1]).toBeCloseTo(srgbEncode(0.5), 5);
    expect(o[2]).toBeCloseTo(1, 9);
    expect(o[3]).toBe(1);
  });
  it('exposure doubles linear values per stop', () => {
    const a = [0, 0, 0, 0],
      b = [0, 0, 0, 0];
    displayPixel(0.1, 0.1, 0.1, 1, { ...std, exposure: 1 }, a);
    displayPixel(0.2, 0.2, 0.2, 1, std, b);
    expect(a[0]).toBeCloseTo(b[0], 6);
  });
  it('gamma is applied after the view transform', () => {
    const o = [0, 0, 0, 0];
    displayPixel(0.18, 0.18, 0.18, 1, { ...std, gamma: 2 }, o);
    expect(o[0]).toBeCloseTo(Math.sqrt(srgbEncode(0.18)), 5);
  });
  it('AgX, Filmic and Neutral are monotonic, black stays near black and highlights compress', () => {
    for (const view of ['AGX', 'FILMIC', 'KHRONOS_PBR_NEUTRAL'] as const) {
      let prev = -1;
      for (const x of [0, 0.01, 0.05, 0.18, 0.5, 1, 2, 8, 64]) {
        const c = [x, x, x];
        toneMap(c, view);
        expect(c[0]).toBeGreaterThanOrEqual(prev - 1e-6);
        expect(c[0]).toBeLessThanOrEqual(1);
        prev = c[0];
      }
      const z = [0, 0, 0];
      toneMap(z, view);
      expect(z[0]).toBeLessThan(0.01);
      const hi = [16, 16, 16];
      toneMap(hi, view);
      expect(hi[0]).toBeGreaterThan(0.85);
    }
  });
  it('AgX keeps mid grey in the expected display range', () => {
    const o = [0, 0, 0, 0];
    displayPixel(0.18, 0.18, 0.18, 1, { view_transform: 'AGX', exposure: 0, gamma: 1 }, o);
    // the AgX base view shows 18% grey around 0.46–0.52 display value
    expect(o[0]).toBeGreaterThan(0.4);
    expect(o[0]).toBeLessThan(0.56);
  });
  it('matches the expected display values (grey ramp and primaries)', () => {
    // [linear input, expected display value]
    const cases: [ViewSettings['view_transform'], number, number, number][] = [
      ['AGX', 0.0625, 0.259, 0.01],
      ['AGX', 0.25, 0.532, 0.01],
      ['AGX', 1, 0.771, 0.015],
      ['AGX', 4, 0.914, 0.02],
      ['FILMIC', 0.0625, 0.308, 0.01],
      ['FILMIC', 0.25, 0.564, 0.01],
      ['FILMIC', 1, 0.807, 0.01],
      ['KHRONOS_PBR_NEUTRAL', 0.25, 0.497, 0.005],
      ['KHRONOS_PBR_NEUTRAL', 1, 0.936, 0.006],
    ];
    for (const [view, x, ref, tol] of cases) {
      const o = [0, 0, 0, 0];
      displayPixel(x, x, x, 1, { view_transform: view, exposure: 0, gamma: 1 }, o);
      expect(Math.abs(o[0] - ref)).toBeLessThanOrEqual(tol);
    }
    const red = [0, 0, 0, 0];
    displayPixel(1, 0, 0, 1, { view_transform: 'FILMIC', exposure: 0, gamma: 1 }, red);
    expect(red[0]).toBeCloseTo(0.81, 2);
    expect(red[1]).toBeLessThan(0.01);
    displayPixel(1, 0, 0, 1, { view_transform: 'AGX', exposure: 0, gamma: 1 }, red);
    expect(Math.abs(red[0] - 0.86)).toBeLessThan(0.02);
    expect(Math.abs(red[1] - 0.22)).toBeLessThan(0.05);
  });
  it('table-based conversion matches the exact transform within half an 8-bit step', () => {
    for (const view of ['STANDARD', 'AGX', 'FILMIC', 'KHRONOS_PBR_NEUTRAL', 'RAW'] as const)
      for (const gamma of [1, 2.2]) {
        const s: ViewSettings = { view_transform: view, exposure: 0.5, gamma };
        const fast = fastDisplay(s);
        const a = [0, 0, 0, 0],
          b = [0, 0, 0, 0];
        let worst = 0;
        for (let i = 0; i < 2000; i++) {
          const x = Math.pow(2, (i % 40) / 2 - 12),
            y = Math.pow(2, ((i * 7) % 40) / 2 - 12),
            z = Math.pow(2, ((i * 13) % 40) / 2 - 12);
          displayPixel(x, y, z, 1, s, a);
          fast(x, y, z, 1, b);
          for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(a[k] - b[k]));
        }
        expect(worst, `${view} gamma ${gamma}`).toBeLessThan(0.5 / 255);
      }
  });
  it('Raw does not encode', () => {
    const o = [0, 0, 0, 0];
    displayPixel(0.25, 0.5, 0.75, 1, { view_transform: 'RAW', exposure: 0, gamma: 1 }, o);
    expect(o.slice(0, 3)).toEqual([0.25, 0.5, 0.75]);
  });
  it('converts premultiplied buffers to straight 8-bit RGBA and composites when alpha is dropped', () => {
    const src = new Float32Array([0.5, 0.5, 0.5, 0.5, 0, 0, 0, 0]);
    const keep = toDisplayRGBA8(src, 2, 1, std, { keepAlpha: true });
    expect(keep[0]).toBe(Math.round(srgbEncode(1) * 255));
    expect(keep[3]).toBe(128);
    expect(keep[7]).toBe(0);
    const flat = toDisplayRGBA8(src, 2, 1, std, { keepAlpha: false, background: [1, 1, 1] });
    expect(flat[3]).toBe(255);
    expect(flat[4]).toBe(255); // transparent pixel shows the white background
  });
});

describe('render units', () => {
  const base = { shape: 'SQUARE' as const, size: 1, size_y: 1 };
  it('converts light power', () => {
    expect(lightIntensity({ ...base, type: 'POINT', energy: 1000 })).toBeCloseTo(1000 / (4 * Math.PI), 6);
    expect(lightIntensity({ ...base, type: 'SPOT', energy: 1000 })).toBeCloseTo(1000 / (4 * Math.PI), 6);
    expect(lightIntensity({ ...base, type: 'SUN', energy: 3 })).toBe(3);
    expect(lightIntensity({ ...base, type: 'AREA', energy: 1000 })).toBeCloseTo(1000 / Math.PI, 6);
    expect(areaLightArea({ shape: 'DISK', size: 2, size_y: 5 })).toBeCloseTo(Math.PI, 6);
    expect(areaLightArea({ shape: 'RECTANGLE', size: 2, size_y: 3 })).toBe(6);
  });
  it('computes render size, frame lists and file names', () => {
    expect(renderSize({ resolution_x: 1920, resolution_y: 1080, resolution_percentage: 50 })).toEqual([960, 540]);
    expect(frameList({ frame_start: 1, frame_end: 10, frame_step: 3 })).toEqual([1, 4, 7, 10]);
    expect(frameList({ frame_start: 5, frame_end: 4, frame_step: 1 })).toEqual([]);
    expect(frameFileName('//render/', 7, 'png')).toBe('0007.png');
    expect(frameFileName('//out/shot_', 12, 'jpg')).toBe('shot_0012.jpg');
    expect(frameFileName('//out/f_###', 5, 'png')).toBe('f_005.png');
    expect(formatTime(75.5)).toBe('01:15.50');
  });
  it('produces well distributed jitter and shutter offsets', () => {
    expect(halton(1, 2)).toBe(0.5);
    expect(halton(2, 2)).toBe(0.25);
    expect(halton(1, 3)).toBeCloseTo(1 / 3, 9);
    expect(jitter(0)).toEqual([0, 0]);
    let sx = 0;
    for (let i = 1; i < 64; i++) {
      const [x, y] = jitter(i);
      expect(Math.abs(x)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(y)).toBeLessThanOrEqual(0.5);
      sx += x;
    }
    expect(Math.abs(sx / 63)).toBeLessThan(0.05);
    const offs = [0, 1, 2, 3].map((i) => shutterOffset(i, 4, 0.5));
    expect(offs[0]).toBeCloseTo(-0.1875, 6);
    expect(offs[3]).toBeCloseTo(0.1875, 6);
    expect(offs.reduce((a, b) => a + b)).toBeCloseTo(0, 9);
    expect(shutterOffset(0, 1, 0.5)).toBe(0);
  });
  it('maps mist and light path settings', () => {
    expect(mistFactor(5, 5, 25)).toBe(0);
    expect(mistFactor(17.5, 5, 25)).toBeCloseTo(0.25, 6);
    expect(mistFactor(100, 5, 25)).toBe(1);
    expect(bounceSettings({ max_bounces: 8, diffuse_bounces: 4, glossy_bounces: 4, transmission_bounces: 12 })).toEqual({ bounces: 4, transmissive: 8 });
    expect(bounceSettings({ max_bounces: 2, diffuse_bounces: 4, glossy_bounces: 6, transmission_bounces: 1 })).toEqual({ bounces: 2, transmissive: 1 });
  });
  it('maps bloom settings', () => {
    expect(bloomParams(0.05, 6.5)).toEqual({ strength: 0.6000000000000001, radius: 0.65 });
    expect(bloomParams(0, 50).radius).toBe(1);
  });
  it('fits the camera sensor to the larger dimension', () => {
    const ca = { sensor_fit: 'AUTO' as const, sensor_width: 36, sensor_height: 24, lens: 50 };
    const [hx, hy] = frustumHalfExtents(ca, 16 / 9);
    expect(hx).toBeCloseTo(0.36, 6);
    expect(hy).toBeCloseTo(0.36 / (16 / 9), 6);
    const [px, py] = frustumHalfExtents(ca, 0.5);
    expect(py).toBeCloseTo(0.36, 6);
    expect(px).toBeCloseTo(0.18, 6);
  });
});

describe('zip writer', () => {
  it('computes the standard CRC-32', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
  it('writes a valid store-only archive', () => {
    const z = new ZipWriter();
    const a = new TextEncoder().encode('hello');
    const b = new Uint8Array([1, 2, 3, 4, 5, 6]);
    z.add('0001.png', a, new Date(2026, 0, 2, 3, 4, 6));
    z.add('0002.png', b);
    const bytes = concatBytes(z.finish());
    const dv = new DataView(bytes.buffer);
    expect(dv.getUint32(0, true)).toBe(0x04034b50);
    // end of central directory
    const eocd = bytes.length - 22;
    expect(dv.getUint32(eocd, true)).toBe(0x06054b50);
    expect(dv.getUint16(eocd + 10, true)).toBe(2);
    const cdOffset = dv.getUint32(eocd + 16, true);
    expect(dv.getUint32(cdOffset, true)).toBe(0x02014b50);
    // first entry data follows its 30-byte header + name
    const nameLen = dv.getUint16(26, true);
    expect(new TextDecoder().decode(bytes.subarray(30, 30 + nameLen))).toBe('0001.png');
    expect(new TextDecoder().decode(bytes.subarray(30 + nameLen, 30 + nameLen + 5))).toBe('hello');
    expect(dv.getUint32(14, true)).toBe(crc32(a));
  });
});

describe('webm muxer', () => {
  it('encodes EBML sizes', () => {
    expect([...ebmlSize(0)]).toEqual([0x80]);
    expect([...ebmlSize(126)]).toEqual([0xfe]);
    expect([...ebmlSize(127)]).toEqual([0x40, 0x7f]);
    expect([...ebmlSize(1000)]).toEqual([0x43, 0xe8]);
  });
  it('writes the EBML header, segment and key-frame clusters', () => {
    const frames = [0, 1, 2].map((i) => ({ data: new Uint8Array([i, i, i]), time: i * 40, key: i === 0 }));
    const out = concatBytes(muxWebM(frames, { width: 64, height: 32, codec: 'V_VP9', duration: 120 }));
    expect([...out.subarray(0, 4)]).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
    const text = new TextDecoder('latin1').decode(out);
    expect(text).toContain('webm');
    expect(text).toContain('V_VP9');
    // one cluster (single key frame) holding three simple blocks
    let clusters = 0,
      blocks = 0;
    for (let i = 0; i < out.length - 3; i++) {
      if (out[i] === 0x1f && out[i + 1] === 0x43 && out[i + 2] === 0xb6 && out[i + 3] === 0x75) clusters++;
      if (out[i] === 0xa3 && out[i + 2] === 0x81) blocks++;
    }
    expect(clusters).toBe(1);
    expect(blocks).toBe(3);
  });
});

describe('environment mapping', () => {
  it('bakes Z-up directions into the equirect convention', () => {
    const up = texelDirection(0.5, 1);
    expect(up[1]).toBeCloseTo(1, 6);
    const d = texelDirection(0.3, 0.7);
    expect(Math.hypot(...d)).toBeCloseTo(1, 9);
  });
  it('uses the expected orientation for image backgrounds', () => {
    expect(zUpEquirectUV([0, 0, 1])[1]).toBeCloseTo(1, 6);
    expect(zUpEquirectUV([0, 0, -1])[1]).toBeCloseTo(0, 6);
    // looking along -X hits the image centre
    expect(zUpEquirectUV([-1, 0, 0])[0]).toBeCloseTo(0.5, 6);
    expect(zUpEquirectUV([-1, 0, 0])[1]).toBeCloseTo(0.5, 6);
  });
});

describe('render passes', () => {
  it('derives depth, normal and mist from the guide buffer', () => {
    // 2x1: foreground (normal +Z, depth 10) and background
    const guide = new Float32Array([0, 0, 1, 10, 0, 0, 0, 0]);
    // orthographic inverse projection (identity is enough for ortho mist)
    const inv = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const p = passesFromGuide(guide, 2, 1, inv, true, { start: 5, depth: 10 }, { z: true, normal: true, mist: true });
    expect(p.Depth![0]).toBe(10);
    expect(p.Depth![1]).toBe(1e10);
    expect([...p.Normal!.subarray(0, 4)]).toEqual([0, 0, 1, 1]);
    expect(p.Mist![0]).toBeCloseTo(0.25, 6);
    expect(p.Mist![1]).toBe(1);
    expect(depthRange(p.Depth!)).toEqual([10, 10 + 1e-6]);
  });
  it('converts results for display and sampling', () => {
    const r: RenderResult = {
      width: 1,
      height: 1,
      passes: { Combined: new Float32Array([0.18, 0.18, 0.18, 1]), Depth: new Float32Array([3]) },
      filmTransparent: false,
      info: { frame: 1, time: 0, engine: 'x', camera: '', scene: '' },
      version: 0,
      rendering: false,
    };
    const px = passToRGBA8(r, 'Combined', 'COLOR_ALPHA', std);
    expect(px[0]).toBe(Math.round(srgbEncode(0.18) * 255));
    const a = passToRGBA8(r, 'Combined', 'ALPHA', std);
    expect(a[0]).toBe(255);
    const s = samplePixel(r, 'Combined', 0, 0, std)!;
    expect(s.raw[0]).toBeCloseTo(0.18, 6);
    expect(s.depth).toBe(3);
    expect(samplePixel(r, 'Combined', 2, 0, std)).toBeNull();
    const bw = toBW(new Uint8ClampedArray([255, 0, 0, 255]));
    expect(bw[0]).toBe(bw[1]);
  });
});

describe('denoiser', () => {
  it('uses a normalised B3-spline kernel and adapts to sample count', () => {
    expect(ATROUS_TAPS.reduce((a, b) => a + b)).toBeCloseTo(1, 9);
    const lo = denoiseSchedule(1),
      hi = denoiseSchedule(1024);
    expect(lo.iterations).toBeGreaterThan(hi.iterations);
    expect(lo.colorSigma).toBeGreaterThan(hi.colorSigma);
  });
});
