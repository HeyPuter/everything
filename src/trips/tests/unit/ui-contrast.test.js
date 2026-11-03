import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const css = readFileSync('src/styles/tokens.css', 'utf8');
function palette(block) { return Object.fromEntries([...block.matchAll(/(--[\w-]+):\s*(#[\da-f]{6})/gi)].map((match) => [match[1], match[2]])); }
const light = palette(css.split('@media')[0]); const dark = palette(css.split(':root[data-theme="dark"]')[1].split('}')[0]);
function luminance(hex) { const c = hex.slice(1).match(/../g).map((p) => parseInt(p, 16) / 255).map((v) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4); return c[0] * .2126 + c[1] * .7152 + c[2] * .0722; }
function contrast(a, b) { const c = [luminance(a), luminance(b)].sort((x, y) => y - x); return (c[0] + .05) / (c[1] + .05); }
for (const [theme, colors] of [['light', light], ['dark', dark]]) describe(`${theme} tokens`, () => {
  it('keeps accents and body text readable', () => {
    expect(contrast(colors['--accent'], colors['--accent-ink'])).toBeGreaterThanOrEqual(4.5);
    for (const ink of ['--ink', '--ink-2', '--ink-3']) for (const bg of ['--page', '--surface']) expect(contrast(colors[ink], colors[bg])).toBeGreaterThanOrEqual(4.5);
  });
  it('keeps day markers visible and avatar initials readable', () => {
    for (let i = 1; i <= 8; i++) { expect(contrast(colors[`--day-${i}`], colors['--surface'])).toBeGreaterThanOrEqual(3); expect(contrast(colors[`--av-${i}`], colors[`--av-${i}-ink`])).toBeGreaterThanOrEqual(4.5); }
  });
});

describe('accent choices', () => {
  const blocks = (selector) => Object.fromEntries([...css.matchAll(new RegExp(`${selector}\\[data-accent="(\\w+)"\\]\\)? \\{([^}]*)\\}`, 'g'))].map((match) => [match[1], palette(match[2])]));
  it('keep text on and in the accent readable in both themes', () => {
    const lights = blocks(':root:where\\(');
    const darks = blocks(':root:where\\(\\[data-theme="dark"\\]\\)');
    expect(Object.keys(lights).sort()).toEqual(['green', 'orange', 'purple', 'rose', 'teal']);
    expect(Object.keys(darks).sort()).toEqual(Object.keys(lights).sort());
    for (const [name, colors] of Object.entries(lights)) {
      expect(contrast(colors['--accent'], light['--accent-ink']), name).toBeGreaterThanOrEqual(4.5);
      for (const bg of ['--page', '--surface']) expect(contrast(colors['--accent-strong'], light[bg]), name).toBeGreaterThanOrEqual(4.5);
    }
    for (const [name, colors] of Object.entries(darks)) {
      expect(contrast(colors['--accent'], dark['--accent-ink']), name).toBeGreaterThanOrEqual(4.5);
      for (const bg of ['--page', '--surface']) expect(contrast(colors['--accent-strong'], dark[bg]), name).toBeGreaterThanOrEqual(4.5);
    }
  });
});
