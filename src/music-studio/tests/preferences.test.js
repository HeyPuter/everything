import { it, expect } from 'vitest';
import { Prefs, DEFAULTS } from '../src/lib/prefs.js';

it.each(['true', '42', '"old preferences"', '[]'])('recovers from a non-object preferences payload: %s', (raw) => {
  let saved = raw;
  const storage = { getItem: () => saved, setItem: (_key, value) => { saved = value; } };
  const prefs = new Prefs(storage);
  expect(prefs.get('theme')).toBe(DEFAULTS.theme);
  prefs.set('theme', 'dark');
  expect(new Prefs(storage).get('theme')).toBe('dark');
});

it('preserves valid stored preferences and merges newly added default fields', () => {
  const prefs = new Prefs({ getItem: () => JSON.stringify({ theme: 'dark', layout: { browser: 300 }, customSetting: 7 }) });
  expect(prefs.get('theme')).toBe('dark');
  expect(prefs.get('layout')).toEqual({ ...DEFAULTS.layout, browser: 300 });
  expect(prefs.get('customSetting')).toBe(7);
});
