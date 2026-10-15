import { describe, expect, it } from 'vitest';
import { parseHex, toHex, cssColor, ramp, SURFACE_REFS, TEXT_REFS } from '../../src/prefs/theme_core';
import { paletteGrey } from '../../src/ui/canvastheme';

// key colours of the default theme (the style sheets' own values)
const DEFAULTS: Record<string, string> = { border: '#121315', topbar: '#141517', field: '#1a1b1c', outliner: '#252627', region: '#2d2e30', panel: '#3a3b3d', button: '#525354', button_hover: '#636466', text_hi: '#ffffff', text_dim: '#999a9b', text: '#e8e9ea' };

const near = (a: string, b: string) => parseHex(a).every((x, i) => Math.abs(x - parseHex(b)[i]) <= 6 / 255);

describe('theme colours', () => {
  it('parses and formats hex colours with and without alpha', () => {
    expect(parseHex('#fff')).toEqual([1, 1, 1, 1]);
    expect(parseHex('#00000080')[3]).toBeCloseTo(128 / 255);
    expect(parseHex('nonsense')).toEqual([0, 0, 0, 1]);
    expect(toHex(1, 0.5, 0)).toBe('#ff8000');
    expect(toHex(0, 0, 0, 0.5)).toBe('#00000080');
    expect(cssColor('#ff000080')).toBe('rgba(255, 0, 0, 0.502)');
    expect(cssColor('#ABCDEF')).toBe('#abcdef');
  });

  it('maps every grey of the style sheets onto the default palette under the default theme', () => {
    const get = (id: string) => DEFAULTS[id];
    for (const [l, id] of SURFACE_REFS) expect(ramp(l, SURFACE_REFS, get)).toBe(DEFAULTS[id]);
    for (const [l, id] of TEXT_REFS) expect(ramp(l, TEXT_REFS, get)).toBe(DEFAULTS[id]);
    for (let l = 0x16; l <= 0xff; l++) expect(near(ramp(l, SURFACE_REFS, get), paletteGrey(l)), `surface ${l}`).toBe(true);
    for (let l = 0x30; l <= 0xff; l++) expect(near(ramp(l, TEXT_REFS, get), paletteGrey(l)), `text ${l}`).toBe(true);
  });

  it('keeps the palette greys ordered, faintly cool, with pure black and white', () => {
    expect(paletteGrey(0)).toBe('#000000');
    expect(paletteGrey(255)).toBe('#ffffff');
    let prev = -1;
    for (let l = 2; l < 254; l++) {
      const [r, g, b] = parseHex(paletteGrey(l));
      expect(g).toBeGreaterThanOrEqual(prev);
      prev = g;
      expect(b).toBeGreaterThanOrEqual(r);
      expect(b - r).toBeLessThanOrEqual(3.5 / 255);
    }
    // dark greys get a touch darker and light greys a touch lighter, so text contrast only grows
    expect(parseHex(paletteGrey(0x30))[1]).toBeLessThan(0x30 / 255);
    expect(parseHex(paletteGrey(0xe6))[1]).toBeGreaterThan(0xe6 / 255);
  });

  it('remaps greys between a light theme key colours', () => {
    const light = { ...DEFAULTS, border: '#afb1b4', region: '#eff0f2', outliner: '#f3f4f6', field: '#ffffff', text: '#1f2124', text_dim: '#5f6164', text_hi: '#000000' };
    const get = (id: string) => (light as Record<string, string>)[id];
    expect(ramp(0x30, SURFACE_REFS, get)).toBe('#eff0f2');
    expect(ramp(0xe6, TEXT_REFS, get)).toBe('#1f2124');
    // halfway between outliner and region
    expect(ramp(0x2c, SURFACE_REFS, get)).toBe('#f1f2f4');
  });
});
