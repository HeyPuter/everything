import { describe, it, expect } from 'vitest';
import { memoryPrefs } from './fx-helpers.js';
import { allPresets, savePreset, deletePreset, matchPreset, lastValues, rememberValues, userPresets } from '../src/effects/presets.js';
import { getEffect } from '../src/effects/index.js';

describe('effect presets', () => {
  const def = getEffect('amplify');
  it('lists built-in presets then user presets', () => {
    const prefs = memoryPrefs();
    savePreset(prefs, def, 'Zed', { left: 1, right: 1, linked: true });
    savePreset(prefs, def, 'Alpha', { left: 2, right: 2, linked: true });
    const list = allPresets(prefs, def);
    expect(list.slice(0, def.presets.length).every((p) => !p.user)).toBe(true);
    expect(list.filter((p) => p.user).map((p) => p.name)).toEqual(['Alpha', 'Zed']);
  });
  it('replaces by name, refuses built-in names and empty names', () => {
    const prefs = memoryPrefs();
    savePreset(prefs, def, 'Mine', { left: 1, right: 1 });
    savePreset(prefs, def, 'Mine', { left: 5, right: 5 });
    expect(userPresets(prefs, 'amplify')).toEqual([{ name: 'Mine', values: { left: 5, right: 5, linked: true } }]);
    expect(() => savePreset(prefs, def, 'Default', {})).toThrow(/built-in/);
    expect(() => savePreset(prefs, def, '  ', {})).toThrow(/name/);
  });
  it('deletes user presets and matches values to preset names', () => {
    const prefs = memoryPrefs();
    savePreset(prefs, def, 'Mine', { left: 7, right: 7, linked: true });
    expect(matchPreset(prefs, def, { left: 3, right: 3, linked: true })).toBe('+3 dB Boost');
    expect(matchPreset(prefs, def, { left: 7, right: 7, linked: true })).toBe('Mine');
    expect(matchPreset(prefs, def, { left: 7.5, right: 7, linked: true })).toBe('');
    deletePreset(prefs, 'amplify', 'Mine');
    expect(userPresets(prefs, 'amplify')).toEqual([]);
    expect(prefs.get('fxPresets')).toEqual({});
  });
  it('persists through localStorage-style storage', () => {
    const prefs = memoryPrefs();
    savePreset(prefs, def, 'Kept', { left: 1 });
    const raw = prefs.storage.getItem('audio-studio:prefs');
    expect(JSON.parse(raw).fxPresets.amplify[0].name).toBe('Kept');
  });
  it('remembers the last applied values, defaulting to the defaults', () => {
    const prefs = memoryPrefs();
    expect(lastValues(prefs, def)).toEqual({ left: 0, right: 0, linked: true });
    rememberValues(prefs, def, { left: -4, right: -4, linked: false, extra: 1 });
    expect(lastValues(prefs, def)).toEqual({ left: -4, right: -4, linked: false });
  });
});
