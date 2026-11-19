import { describe, expect, it } from 'vitest';
import {
  blendChannel,
  blendColor,
  blendGlsl,
  blendModeIndex,
  blendModes,
  blendPixel,
  blendWgsl,
  compositeRGBA8,
  compositeRGBA8KeepAlpha,
  effectiveOpacities,
  isSeparable,
  knockoutAlpha,
  lum,
  sat,
  separableFromSnippet,
} from '../src/imaging/blend';
import { mask8, rgba8 } from '../src/imaging/types';

const near = (a: number, b: number, eps = 1e-9) => expect(Math.abs(a - b)).toBeLessThanOrEqual(eps);

describe('blend mode list', () => {
  it('has 27 unique modes in menu order with six separator groups', () => {
    expect(blendModes).toHaveLength(27);
    expect(new Set(blendModes.map((m) => m.id)).size).toBe(27);
    const groups = blendModes.map((m) => m.group);
    expect([...new Set(groups)]).toEqual([0, 1, 2, 3, 4, 5]);
    for (let i = 1; i < groups.length; i++) expect(groups[i]).toBeGreaterThanOrEqual(groups[i - 1]);
    expect(blendModes.filter((m) => m.group === 1).map((m) => m.id)).toEqual([
      'darken', 'multiply', 'color-burn', 'linear-burn', 'darker-color',
    ]);
    expect(blendModes.filter((m) => m.group === 3)).toHaveLength(7);
    expect(blendModes.find((m) => m.id === 'linear-dodge')!.label).toBe('Linear Dodge (Add)');
    expect(blendModeIndex('luminosity')).toBe(26);
    expect(() => blendModeIndex('nope' as never)).toThrow();
  });
});

describe('separable formulas', () => {
  const B = (mode: Parameters<typeof blendModeIndex>[0], b: number, s: number) =>
    blendChannel(blendModeIndex(mode), b, s);
  it('matches known values', () => {
    near(B('multiply', 0.5, 0.5), 0.25);
    near(B('screen', 0.5, 0.5), 0.75);
    near(B('darken', 0.3, 0.7), 0.3);
    near(B('lighten', 0.3, 0.7), 0.7);
    near(B('difference', 0.2, 0.9), 0.7);
    near(B('exclusion', 0.5, 0.5), 0.5);
    near(B('linear-burn', 0.6, 0.6), 0.2);
    near(B('linear-burn', 0.3, 0.3), 0);
    near(B('linear-dodge', 0.6, 0.6), 1);
    near(B('subtract', 0.6, 0.25), 0.35);
    near(B('divide', 0.25, 0.5), 0.5);
    near(B('divide', 0.25, 0), 1);
    near(B('divide', 0, 0), 0);
    near(B('linear-light', 0.5, 0.75), 1);
    near(B('linear-light', 0.5, 0.25), 0);
    near(B('pin-light', 0.8, 0.2), 0.4);
    near(B('pin-light', 0.2, 0.8), 0.6);
    near(B('hard-mix', 0.4, 0.6), 1);
    near(B('hard-mix', 0.4, 0.59), 0);
    // W3C soft light, both branches of D(b).
    near(B('soft-light', 0.25, 0.75), 0.375);
    near(B('soft-light', 0.64, 1), 0.8);
    near(B('soft-light', 0.5, 0.25), 0.375);
  });
  it('follows the W3C color-dodge and color-burn edge cases', () => {
    near(B('color-dodge', 0, 1), 0);
    near(B('color-dodge', 0.2, 1), 1);
    near(B('color-dodge', 0.25, 0.5), 0.5);
    near(B('color-dodge', 0.8, 0.5), 1);
    near(B('color-burn', 1, 0), 1);
    near(B('color-burn', 0.5, 0), 0);
    near(B('color-burn', 0.75, 0.5), 0.5);
    near(B('vivid-light', 0.75, 0.25), 0.5);
    near(B('vivid-light', 0.25, 0.75), 0.5);
  });
  it('overlay is hard light with the arguments swapped, and normal/neutral identities hold', () => {
    for (let b = 0; b <= 1; b += 0.05)
      for (let s = 0; s <= 1; s += 0.05) {
        near(B('overlay', b, s), B('hard-light', s, b));
        near(B('multiply', b, s), B('multiply', s, b));
        near(B('screen', b, s), B('screen', s, b));
      }
    for (let b = 0; b <= 1; b += 0.1) {
      near(B('multiply', b, 1), b);
      near(B('screen', b, 0), b);
      near(B('overlay', b, 0.5), b, 1e-12); // hard light with 0.5 source is identity
      near(B('soft-light', b, 0.5), b);
      near(B('linear-light', b, 0.5), b);
      near(B('difference', b, 0), b);
    }
  });
  it('the shader snippet expressions agree with the reference for every separable mode', () => {
    const js = separableFromSnippet();
    const ids = Object.keys(js).map(Number);
    expect(ids.sort((a, b) => a - b)).toEqual(
      blendModes.map((_, i) => i).filter((i) => isSeparable(i) && i > 1),
    );
    for (const i of ids)
      for (let b = 0; b <= 1.0001; b += 1 / 32)
        for (let s = 0; s <= 1.0001; s += 1 / 32) {
          const bb = Math.min(1, b), ss = Math.min(1, s);
          near(js[i](bb, ss), blendChannel(i, bb, ss), 1e-6);
        }
  });
  it('the GLSL and WGSL snippets name a branch for every mode id', () => {
    for (let i = 2; i < blendModes.length; i++) {
      const tag = `// ${i} ${blendModes[i].id}`;
      expect(blendGlsl).toContain(`if(mode==${i})`);
      expect(blendGlsl).toContain(tag);
      expect(blendWgsl).toContain(`if(mode==${i}){`);
      expect(blendWgsl).toContain(tag);
    }
    expect(blendGlsl).toContain('vec3 blendMode(int mode,vec3 b,vec3 s)');
    expect(blendWgsl).toContain('fn blendMode(mode:i32,b:vec3f,s:vec3f)->vec3f');
    // GLSL ES rejects int literals in float math; every literal in an expression has a point.
    expect(blendGlsl).not.toMatch(/[^\w.](\d+)[^\w.]*[*+/-]\s*[bs]\b(?![\w(])/);
  });
});

describe('non-separable formulas (W3C)', () => {
  const colors: number[][] = [];
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 300; i++) colors.push([rnd(), rnd(), rnd()]);
  it('color puts the source hue and saturation at the backdrop luminosity', () => {
    const out = blendColor('color', [0.5, 0.5, 0.5], [1, 0, 0]);
    near(out[0], 1, 1e-9);
    near(out[1], 0.2 / 0.7, 1e-9);
    near(out[2], 0.2 / 0.7, 1e-9);
    for (let i = 0; i + 1 < colors.length; i += 2) {
      const b = colors[i], s = colors[i + 1];
      const c = blendColor('color', b, s);
      near(lum(c[0], c[1], c[2]), lum(b[0], b[1], b[2]), 1e-9);
      const l = blendColor('luminosity', b, s);
      near(lum(l[0], l[1], l[2]), lum(s[0], s[1], s[2]), 1e-9);
      for (const v of [...c, ...l]) {
        expect(v).toBeGreaterThanOrEqual(-1e-9);
        expect(v).toBeLessThanOrEqual(1 + 1e-9);
      }
      const h = blendColor('hue', b, s);
      near(lum(h[0], h[1], h[2]), lum(b[0], b[1], b[2]), 1e-9);
    }
  });
  it('saturation keeps the backdrop hue order and takes the source saturation when unclipped', () => {
    const out = blendColor('saturation', [0.6, 0.5, 0.4], [0.5, 0.45, 0.4]);
    near(sat(out[0], out[1], out[2]), 0.1, 1e-9);
    near(lum(out[0], out[1], out[2]), lum(0.6, 0.5, 0.4), 1e-9);
    expect(out[0]).toBeGreaterThan(out[1]);
    expect(out[1]).toBeGreaterThan(out[2]);
  });
  it('hue onto a gray backdrop gives gray; saturation of gray source gives gray', () => {
    const h = blendColor('hue', [0.4, 0.4, 0.4], [0.9, 0.1, 0.3]);
    near(h[0], 0.4); near(h[1], 0.4); near(h[2], 0.4);
    const s = blendColor('saturation', [0.9, 0.1, 0.3], [0.5, 0.5, 0.5]);
    const l = lum(0.9, 0.1, 0.3);
    near(s[0], l); near(s[1], l); near(s[2], l);
  });
  it('darker and lighter color pick whole colors by luma', () => {
    expect(blendColor('darker-color', [0, 0, 1], [0.5, 0.5, 0.5])).toEqual([0, 0, 1]);
    expect(blendColor('lighter-color', [0, 0, 1], [0.5, 0.5, 0.5])).toEqual([0.5, 0.5, 0.5]);
  });
});

describe('blendPixel source-over', () => {
  it('uses B fully over an opaque backdrop and the source over a transparent one', () => {
    const p = blendPixel('multiply', [0.5, 0.5, 0.5, 1], [0.5, 1, 0, 1]);
    expect(p).toEqual([0.25, 0.5, 0, 1]);
    const q = blendPixel('multiply', [0.5, 0.5, 0.5, 0], [0.5, 1, 0, 1]);
    expect(q).toEqual([0.5, 1, 0, 1]);
  });
  it('applies the W3C alpha and color equations at partial coverage', () => {
    const [r, , , a] = blendPixel('screen', [0.2, 0, 0, 0.5], [0.6, 0, 0, 0.8], 0.5);
    const as = 0.4, ab = 0.5, ao = as + ab * (1 - as);
    near(a, ao);
    const cs = (1 - ab) * 0.6 + ab * (0.2 + 0.6 - 0.12);
    near(r, (as * cs + (1 - as) * ab * 0.2) / ao);
  });
  it('dissolve is all-or-nothing by the random threshold', () => {
    expect(blendPixel('dissolve', [0, 0, 0, 1], [1, 1, 1, 0.3], 1, 0.2)).toEqual([1, 1, 1, 1]);
    expect(blendPixel('dissolve', [0, 0, 0, 1], [1, 1, 1, 0.3], 1, 0.5)).toEqual([0, 0, 0, 1]);
  });
});

describe('compositeRGBA8', () => {
  it('agrees with blendPixel for every mode within one level', () => {
    const w = 16, h = 16;
    const back = rgba8(w, h), src = rgba8(w, h);
    let seed = 3;
    const rnd = () => ((seed = (seed * 48271) % 2147483647) % 256);
    for (let i = 0; i < back.data.length; i++) {
      back.data[i] = rnd();
      src.data[i] = rnd();
    }
    for (let m = 0; m < blendModes.length; m++) {
      if (m === 1) continue;
      const out = rgba8(w, h);
      out.data.set(back.data);
      compositeRGBA8(out, src, m, 0.7);
      for (let i = 0; i < w * h * 4; i += 4) {
        const bpx = [...back.data.slice(i, i + 4)].map((v) => v / 255);
        const spx = [...src.data.slice(i, i + 4)].map((v) => v / 255);
        const ref = blendPixel(m, bpx, spx, 0.7);
        if (ref[3] * 255 < 1) continue;
        for (let c = 0; c < 4; c++)
          expect(Math.abs(out.data[i + c] - ref[c] * 255), `${blendModes[m].id} ch${c}`).toBeLessThanOrEqual(1.01);
      }
    }
  });
  it('honors offset, clipping and mask', () => {
    const back = rgba8(4, 4, [0, 0, 0, 255]);
    const src = rgba8(3, 3, [255, 255, 255, 255]);
    const m = mask8(3, 3, 255);
    m.data[0] = 0;
    m.data[4] = 128;
    compositeRGBA8(back, src, 'normal', 1, m, { x: 2, y: 1 });
    const at = (x: number, y: number) => back.data[(y * 4 + x) * 4];
    expect(at(2, 1)).toBe(0); // masked out
    expect(at(3, 1)).toBe(255);
    expect(at(3, 2)).toBe(128);
    expect(at(2, 2)).toBe(255);
    expect(at(1, 2)).toBe(0); // left of the offset
    expect(at(2, 0)).toBe(0); // above the offset
  });
  it('dissolve is deterministic and keeps roughly the opacity fraction', () => {
    const run = () => {
      const back = rgba8(64, 64, [0, 0, 0, 255]);
      compositeRGBA8(back, rgba8(64, 64, [255, 255, 255, 255]), 'dissolve', 0.25, undefined, undefined, 9);
      return back;
    };
    const a = run(), b = run();
    expect(a.data).toEqual(b.data);
    let white = 0;
    for (let i = 0; i < a.data.length; i += 4) {
      expect([0, 255]).toContain(a.data[i]);
      if (a.data[i] === 255) white++;
    }
    expect(white / 4096).toBeGreaterThan(0.2);
    expect(white / 4096).toBeLessThan(0.3);
  });
  it('leaves the backdrop untouched where the source is transparent, including 1x1', () => {
    const back = rgba8(1, 1, [10, 20, 30, 40]);
    compositeRGBA8(back, rgba8(1, 1), 'multiply', 1);
    expect([...back.data]).toEqual([10, 20, 30, 40]);
  });
});

describe('compositeRGBA8KeepAlpha (locked transparency)', () => {
  it('moves each color toward the blend by coverage and keeps alpha, for every mode', () => {
    const w = 16, h = 16;
    const back = rgba8(w, h), src = rgba8(w, h);
    let seed = 5;
    const rnd = () => ((seed = (seed * 48271) % 2147483647) % 256);
    for (let i = 0; i < back.data.length; i++) {
      back.data[i] = rnd();
      src.data[i] = rnd();
    }
    for (let m = 0; m < blendModes.length; m++) {
      if (m === 1) continue;
      const out = rgba8(w, h);
      out.data.set(back.data);
      compositeRGBA8KeepAlpha(out, src, m, 0.7);
      for (let i = 0; i < w * h * 4; i += 4) {
        const cb = [...back.data.slice(i, i + 3)].map((v) => v / 255);
        const cs = [...src.data.slice(i, i + 3)].map((v) => v / 255);
        const ab = back.data[i + 3] / 255, a = (src.data[i + 3] / 255) * 0.7;
        const b = blendColor(m, cb, cs);
        expect(out.data[i + 3]).toBe(back.data[i + 3]);
        for (let c = 0; c < 3; c++) {
          const mixed = m === 0 || ab === 0 ? cs[c] : cs[c] + (b[c] - cs[c]) * ab;
          const ref = (cb[c] + (mixed - cb[c]) * a) * 255;
          const label = `${blendModes[m].id} ch${c}`;
          expect(Math.abs(out.data[i + c] - ref), label).toBeLessThanOrEqual(1.01);
        }
      }
    }
  });
  it('does not weight the change by the backdrop alpha', () => {
    const back = rgba8(1, 1, [200, 200, 200, 128]);
    const m = mask8(1, 1, 255);
    compositeRGBA8KeepAlpha(back, rgba8(1, 1, [0, 0, 0, 255]), 'normal', 0.5, m);
    expect([...back.data]).toEqual([100, 100, 100, 128]);
    m.data[0] = 0;
    compositeRGBA8KeepAlpha(back, rgba8(1, 1, [0, 0, 0, 255]), 'normal', 1, m);
    expect([...back.data]).toEqual([100, 100, 100, 128]);
  });
});

describe('opacity helpers', () => {
  it('fill opacity scales content but not effects', () => {
    expect(effectiveOpacities({ layerOpacity: 0.5, fillOpacity: 0 })).toEqual({ content: 0, effects: 0.5, fill: 0, layer: 0.5 });
  });
  it('knockout removes coverage under the knocking shape', () => {
    const t = rgba8(2, 1, [0, 0, 0, 200]);
    const k = rgba8(2, 1);
    k.data[3] = 255;
    knockoutAlpha(t, k);
    expect(t.data[3]).toBe(0);
    expect(t.data[7]).toBe(200);
  });
});
