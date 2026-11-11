import { describe, expect, it, afterEach } from 'vitest';
import { prefs, defaultPreferences, formatDate, tabletPressure, mergeStoredPrefs } from '../../src/app/prefs';
import { animSettings, formatSeconds } from '../../src/animation/view2d';
import { keyframeDefaults, newKeyframe, insertKeyframe } from '../../src/anim/fcurve';
import type { FCurve } from '../../src/data/types';

afterEach(() => {
  Object.assign(prefs, defaultPreferences());
  animSettings.timecode = 'MINIMAL';
  Object.assign(keyframeDefaults, { interpolation: 'BEZIER', handle: 'AUTO_CLAMPED', insertNeeded: false, xyzToRgb: true });
});

describe('preference value helpers', () => {
  it('formats dates in the chosen style', () => {
    const d = new Date(2026, 2, 7, 15, 4);
    prefs.date_format = 'BE_DASH';
    prefs.time_format = 'H24';
    expect(formatDate(d)).toBe('2026-03-07 15:04');
    prefs.date_format = 'LE_DOT';
    prefs.time_format = 'H12';
    expect(formatDate(d)).toBe('07.03.2026 3:04 PM');
    prefs.date_format = 'ME_SLASH';
    expect(formatDate(d, false)).toBe('03/07/2026');
  });

  it('maps pen pressure through threshold and softness', () => {
    expect(tabletPressure(0.5)).toBeCloseTo(0.5);
    prefs.pressure_threshold_max = 0.5;
    expect(tabletPressure(0.5)).toBe(1);
    expect(tabletPressure(0.25)).toBeCloseTo(0.5);
    prefs.pressure_threshold_max = 1;
    prefs.pressure_softness = 0.5;
    expect(tabletPressure(0.25)).toBeCloseTo(0.5);
    prefs.pressure_softness = -0.5;
    expect(tabletPressure(0.5)).toBeCloseTo(0.25);
  });

  it('formats timecodes in every style', () => {
    expect(formatSeconds(84, 24)).toBe('3+12');
    animSettings.timecode = 'SMPTE';
    expect(formatSeconds(84, 24)).toBe('00:00:03:12');
    animSettings.timecode = 'SMPTE_COMPACT';
    expect(formatSeconds(84, 24)).toBe('3:12');
    expect(formatSeconds(24 * 75, 24)).toBe('1:15:00');
    animSettings.timecode = 'MILLISECONDS';
    expect(formatSeconds(84, 24)).toBe('00:03.500');
    animSettings.timecode = 'SECONDS_ONLY';
    expect(formatSeconds(84, 24)).toBe('3.5');
  });

  it('uses the keyframe defaults for new keys', () => {
    keyframeDefaults.interpolation = 'LINEAR';
    keyframeDefaults.handle = 'VECTOR';
    const k = newKeyframe(1, 2);
    expect(k.interpolation).toBe('LINEAR');
    expect(k.handle_left_type).toBe('VECTOR');
    const fc: FCurve = { data_path: 'location', array_index: 0, keyframe_points: [], extrapolation: 'CONSTANT', modifiers: [] } as unknown as FCurve;
    expect(insertKeyframe(fc, 5, 1).interpolation).toBe('LINEAR');
  });
});

describe('stored preferences', () => {
  it('keep the defaults for damaged values and keep keys of newer builds', () => {
    const d = defaultPreferences();
    const p = mergeStoredPrefs(d, { font_size: null, font_ui: null, undo_steps: 'x', resolution_scale: 1.5, theme: 'LIGHT', duplicate: null, autoexec_paths: {}, future_pref: 3 }) as unknown as Record<string, unknown>;
    expect(p.font_size).toBe(d.font_size);
    expect(p.font_ui).toBe(d.font_ui);
    expect(p.undo_steps).toBe(d.undo_steps);
    expect(p.autoexec_paths).toEqual([]);
    expect(p.duplicate).toEqual(d.duplicate);
    expect(p.resolution_scale).toBe(1.5);
    expect(p.theme).toBe('LIGHT');
    expect(p.future_pref).toBe(3);
  });

  it('ignore storage that is not an object', () => {
    const d = defaultPreferences();
    expect(mergeStoredPrefs(d, [1, 2])).toEqual(d);
    expect(mergeStoredPrefs(d, 'Layout')).toEqual(d);
    expect(mergeStoredPrefs(d, null)).toEqual(d);
    expect(mergeStoredPrefs(d, { duplicate: { MESH: false } }).duplicate.MESH).toBe(false);
  });
});
