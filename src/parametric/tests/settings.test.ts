import { expect, it } from 'vitest';
import { DEFAULT_SETTINGS, normalizeSettings } from '../src/app/settings';

it('ignores malformed top-level settings and inherited values', () => {
  for (const value of [null, undefined, false, 42, 'IPS', [], Object.create({ defaultUnits: 'IPS', quality: 2, showPlanes: true })]) {
    expect(normalizeSettings(value)).toEqual(DEFAULT_SETTINGS);
  }
});

it('retains valid preferences while ignoring unknown and wrongly typed values', () => {
  expect(normalizeSettings({ defaultUnits: 'IPS', quality: 0, showPlanes: true, showSketches: false, invertZoom: 'false', showOrigin: 1, obsolete: true }))
    .toEqual({ ...DEFAULT_SETTINGS, defaultUnits: 'IPS', quality: 0, showPlanes: true, showSketches: false });
});

it('accepts every supported unit system and image quality', () => {
  for (const defaultUnits of ['MMGS', 'CGS', 'MKS', 'IPS']) {
    for (const quality of [0, 1, 2]) expect(normalizeSettings({ defaultUnits, quality })).toMatchObject({ defaultUnits, quality });
  }
});

it('rejects nonnumeric, nonfinite, fractional and out-of-range image quality', () => {
  for (const quality of [null, '2', NaN, Infinity, -1, 0.5, 1.5, 3, {}]) {
    expect(normalizeSettings({ quality }).quality).toBe(1);
  }
});

it('rejects unknown and prototype unit names', () => {
  for (const defaultUnits of [null, 1, {}, 'unknown', 'toString', '__proto__']) {
    expect(normalizeSettings({ defaultUnits }).defaultUnits).toBe('MMGS');
  }
});

it('preserves local choices when account preferences are missing or invalid', () => {
  const local = normalizeSettings({ defaultUnits: 'IPS', quality: 2, invertZoom: true });
  const before = { ...local };
  expect(normalizeSettings({ defaultUnits: null, quality: 'bad', showPlanes: true }, local))
    .toEqual({ ...local, showPlanes: true });
  expect(normalizeSettings(undefined, local)).toEqual(local);
  expect(local).toEqual(before);
  expect(DEFAULT_SETTINGS.defaultUnits).toBe('MMGS');
});
