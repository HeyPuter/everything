import { describe, expect, it } from 'vitest';
import { parseHex, toHex, cssColor, ramp, SURFACE_REFS, TEXT_REFS } from '../../src/prefs/theme_core';

// key colours of the default theme (the style sheets' own values)
const DEFAULTS: Record<string, string> = { border: '#161616', topbar: '#181818', field: '#1d1d1d', outliner: '#282828', region: '#303030', panel: '#3d3d3d', button: '#545454', button_hover: '#656565', text_hi: '#ffffff', text_dim: '#999999', text: '#e6e6e6' };

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

  it('maps every grey of the style sheets to itself under the default theme', () => {
    const get = (id: string) => DEFAULTS[id];
    for (let l = 0x16; l <= 0xff; l++) {
      const x = l.toString(16).padStart(2, '0');
      expect(ramp(l, SURFACE_REFS, get)).toBe(`#${x}${x}${x}`);
    }
    for (let l = 0x30; l <= 0xff; l++) {
      const x = l.toString(16).padStart(2, '0');
      expect(ramp(l, TEXT_REFS, get)).toBe(`#${x}${x}${x}`);
    }
  });

  it('remaps greys between a light theme key colours', () => {
    const light = { ...DEFAULTS, border: '#b0b0b0', region: '#f0f0f0', outliner: '#f4f4f4', field: '#ffffff', text: '#202020', text_dim: '#606060', text_hi: '#000000' };
    const get = (id: string) => (light as Record<string, string>)[id];
    expect(ramp(0x30, SURFACE_REFS, get)).toBe('#f0f0f0');
    expect(ramp(0xe6, TEXT_REFS, get)).toBe('#202020');
    // halfway between outliner and region
    expect(ramp(0x2c, SURFACE_REFS, get)).toBe('#f2f2f2');
  });
});
