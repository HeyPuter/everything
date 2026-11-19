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

describe('saved looks', () => {
  it('saves the current mix, matches it, replaces by name and deletes', async () => {
    const { saveLook, deleteLook, userLooks, allLooks } = await import('../src/ui/looks.js');
    const p = prefsOf({ theme: 'dark', uiBrightness: -30, accentColor: 'rose', waveColors: { wave: '#ABCDEF' } });
    expect(lookOf(p)).toBe(null);
    const mine = saveLook(p, ' Night Edit ');
    expect(mine).toMatchObject({ label: 'Night Edit', theme: 'dark', brightness: -30, accent: 'rose', colors: { wave: '#abcdef' } });
    expect(lookOf(p)?.label).toBe('Night Edit');
    expect(allLooks(p)).toHaveLength(LOOKS.length + 1);
    // Same name again replaces it.
    p.set('uiBrightness', -10);
    saveLook(p, 'night edit');
    expect(userLooks(p).map((l) => [l.label, l.brightness])).toEqual([['night edit', -10]]);
    applyLook(p, 'studio');
    applyLook(p, userLooks(p)[0].id);
    expect(p.values.uiBrightness).toBe(-10);
    deleteLook(p, userLooks(p)[0].id);
    expect(userLooks(p)).toEqual([]);
    // Damaged stored entries are ignored.
    p.set('userLooks', [null, { label: 'x', theme: 'neon', accent: 'blue' }, 'nope']);
    expect(userLooks(p)).toEqual([]);
  });
});
