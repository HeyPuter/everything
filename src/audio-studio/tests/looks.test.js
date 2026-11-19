// Looks: bundles of theme, brightness, accent and editor colors.
import { describe, it, expect } from 'vitest';
import { LOOKS, lookOf, applyLook, lookSwatch } from '../src/ui/looks.js';
import { ACCENTS, cleanColor } from '../src/ui/appearance.js';

const prefsOf = (values = {}) => {
  const v = { ...values };
  return { values: v, get: (k) => v[k], set: (k, x) => (v[k] = x) };
};

describe('looks', () => {
  it('are complete and distinct', () => {
    expect(new Set(LOOKS.map((l) => l.id)).size).toBe(LOOKS.length);
    for (const l of LOOKS) {
      expect(['system', 'dark', 'light']).toContain(l.theme);
      expect(Math.abs(l.brightness)).toBeLessThanOrEqual(100);
      expect(ACCENTS.some((a) => a.id === l.accent)).toBe(true);
      for (const c of Object.values(l.colors || {})) expect(cleanColor(c)).not.toBe(null);
    }
    // No two looks would show as the same one.
    for (const l of LOOKS) {
      const p = prefsOf();
      applyLook(p, l);
      expect(lookOf(p)).toBe(l);
    }
  });

  it('default preferences are the Studio look, and any change makes a custom mix', () => {
    const p = prefsOf();
    expect(lookOf(p)?.id).toBe('studio');
    applyLook(p, 'low-light');
    expect(p.values).toMatchObject({ theme: 'dark', uiBrightness: -45, accentColor: 'amber' });
    expect(p.values.waveColors.wave).toBeTruthy();
    p.set('uiBrightness', -40);
    expect(lookOf(p)).toBe(null);
    applyLook(p, 'studio');
    expect(p.values.waveColors).toBe(null);
    expect(lookOf(p)?.id).toBe('studio');
  });

  it('previews follow the look’s theme, brightness and colors', () => {
    const paper = lookSwatch(LOOKS.find((l) => l.id === 'paper'));
    expect(paper.editor).toBe('#fbfaf5');
    const hc = lookSwatch(LOOKS.find((l) => l.id === 'high-contrast'));
    expect(hc.panel < '#232323').toBe(true);
    expect(lookSwatch(LOOKS[0], 'light').panel).toBe('#ececec');
  });
});
