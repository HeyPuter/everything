// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appOptions, appOption, setAppOptions, resetAppOptions, onAppOptions, reloadAppOptions, normalizeOption, normalizeOptions, OPTION_DEFAULTS, displayUserName } from '../src/lib/app-options.js';
import { installAppOptions } from '../src/lib/apply-options.js';
import { parseInput, twoDigitYearCutoff, expandTwoDigitYear, setTwoDigitYearCutoff } from '../src/core/format.js';
import { canAI } from '../src/lib/puter.js';
import { autoSaveEnabled } from '../src/lib/doc.js';

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear(), key: (i) => [...m.keys()][i], get length() { return m.size; } };
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  reloadAppOptions();
});
afterEach(() => { resetAppOptions(); vi.unstubAllGlobals(); });

describe('app options', () => {
  it('start from the defaults', () => {
    expect(appOptions()).toEqual({ ...OPTION_DEFAULTS });
    expect(appOption('enterDirection')).toBe('down');
  });

  it('keep values of the right kind only, within their ranges', () => {
    expect(normalizeOption('enterDirection', 'sideways')).toBe('down');
    expect(normalizeOption('enterDirection', 'left')).toBe('left');
    expect(normalizeOption('fixedDecimalPlaces', '3')).toBe(3);
    expect(normalizeOption('fixedDecimalPlaces', 99)).toBe(15);
    expect(normalizeOption('fontSize', 10.7)).toBe(10.5);
    expect(normalizeOption('fillHandle', 'yes')).toBe(true);
    expect(normalizeOption('draftDelay', '30')).toBe(30);
    expect(normalizeOption('draftDelay', 7)).toBe(1);
    expect(normalizeOption('fontName', '   ')).toBe('Calibri');
    expect(normalizeOptions({ bogus: 1 }).bogus).toBeUndefined();
  });

  it('are kept for the person, only where they differ from the defaults, and read back', () => {
    setAppOptions({ enterDirection: 'right', fillHandle: false });
    const stored = [...Array(localStorage.length).keys()].map((i) => localStorage.key(i)).find((k) => k.includes('pref-options'));
    expect(JSON.parse(localStorage.getItem(stored)).value).toEqual({ enterDirection: 'right', fillHandle: false });
    reloadAppOptions();
    expect(appOption('enterDirection')).toBe('right');
    expect(appOption('fillHandle')).toBe(false);
  });

  it('tell listeners which options changed', () => {
    const seen = [];
    const off = onAppOptions((options, keys) => seen.push(keys));
    setAppOptions({ showStatusBar: false, showSheetTabs: true });
    setAppOptions({ showStatusBar: false });
    off();
    setAppOptions({ showStatusBar: true });
    expect(seen).toEqual([['showStatusBar']]);
  });

  it('reset some options or all of them', () => {
    setAppOptions({ autoComplete: false, editInCell: false });
    resetAppOptions(['autoComplete']);
    expect(appOption('autoComplete')).toBe(true);
    expect(appOption('editInCell')).toBe(false);
    resetAppOptions();
    expect(appOption('editInCell')).toBe(true);
  });

  it('name the person by the chosen name, else the account’s', () => {
    expect(displayUserName('ada')).toBe('ada');
    setAppOptions({ userName: '  Ada Lovelace ' });
    expect(displayUserName('ada')).toBe('Ada Lovelace');
  });
});

describe('options that reach past the editor', () => {
  it('two-digit years follow the cutoff', () => {
    installAppOptions();
    expect(twoDigitYearCutoff()).toBe(2029);
    expect(expandTwoDigitYear(29)).toBe(2029);
    expect(expandTwoDigitYear(30)).toBe(1930);
    setAppOptions({ yearCutoff: 2049 });
    expect(twoDigitYearCutoff()).toBe(2049);
    // 1/2/45 is a date in 2045 now, and 1/2/50 one in 1950.
    const y45 = parseInput('1/2/45'), y50 = parseInput('1/2/50');
    expect(y45.v).toBeGreaterThan(parseInput('1/1/2045').v - 1);
    expect(y45.v).toBeLessThan(parseInput('1/1/2046').v);
    expect(y50.v).toBeLessThan(parseInput('1/1/1951').v);
    setTwoDigitYearCutoff(2029);
  });

  it('turning AI features off makes AI unavailable', () => {
    installAppOptions();
    vi.stubGlobal('puter', { ai: { chat: () => {} } });
    globalThis.window.puter = globalThis.puter;
    expect(canAI()).toBe(true);
    setAppOptions({ aiFeatures: false });
    expect(canAI()).toBe(false);
    setAppOptions({ aiFeatures: true });
    expect(canAI()).toBe(true);
    delete globalThis.window.puter;
  });

  it('AutoSave by default applies where the device never chose', () => {
    installAppOptions();
    expect(autoSaveEnabled()).toBe(true);
    setAppOptions({ autoSave: false });
    expect(autoSaveEnabled()).toBe(false);
    localStorage.setItem('spreadsheet:autosave', 'on');
    expect(autoSaveEnabled()).toBe(true);
  });

  it('accessibility choices mark the page', () => {
    installAppOptions();
    setAppOptions({ reduceMotion: true, highContrastSelection: true });
    expect(document.documentElement.classList.contains('reduce-motion')).toBe(true);
    expect(document.documentElement.classList.contains('strong-selection')).toBe(true);
    setAppOptions({ reduceMotion: false, highContrastSelection: false });
    expect(document.documentElement.classList.contains('reduce-motion')).toBe(false);
  });
});
