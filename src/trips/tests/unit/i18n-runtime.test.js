import { afterAll, describe, expect, it, vi } from 'vitest';
import * as i18n from '../../src/lib/i18n/index.js';
import { bindPrefs } from '../../src/lib/prefs.js';

// Switching imports a locale's ~50 module files, which a loaded machine slows past the default timeouts.
const SLOW = 30_000;
const WAIT = { timeout: 10_000 };

describe('t()', () => {
  afterAll(() => i18n.setLocale('auto', { persist: false }));
  it('sends a "one" key used for another number to its counted sibling', () => {
    expect(i18n.t('atlas.results.one', { count: '21' })).toBe('21 countries');
    expect(i18n.t('atlas.results.one', { count: '1' })).toBe('1 country');
    expect(i18n.t('week.untimedOne', { count: 3 })).toBe(i18n.t('week.untimed', { count: 3 }));
  });
  it('switches locale, direction and falls back to English per key', async () => {
    await i18n.setLocale('ar', { persist: false });
    expect(i18n.locale).toBe('ar');
    expect(document.documentElement.dir).toBe('rtl');
    expect(document.documentElement.lang).toBe('ar');
    expect(i18n.t('app.settings')).not.toBe(i18n.english['app.settings']);
    expect(i18n.t('kit.system')).toBe(i18n.english['kit.system']);
    await i18n.setLocale('de', { persist: false });
    expect(document.documentElement.dir).toBe('ltr');
    expect(i18n.t('app.accountName', { name: 'Ada' })).toContain('Ada');
    await i18n.setLocale('auto', { persist: false });
    expect(i18n.locale).toBe('en');
  }, SLOW);
  it('builds the pseudo-locale in tests and dev', async () => {
    await i18n.setLocale('en-XA', { persist: false });
    expect(i18n.t('app.accountName', { name: 'Ada' })).toMatch(/^\[.*Ada.*·+\]$/);
    await i18n.setLocale('auto', { persist: false });
  });
});

describe('account language', () => {
  const personal = (cloud) => ({ get: async () => ({ ...cloud }), patchPreferences: async (patch) => Object.assign(cloud, patch) });
  const win = () => Object.assign(new EventTarget(), { navigator: { onLine: true } });
  afterAll(() => i18n.setLocale('auto', { persist: false }));
  it('applies a saved account language once read, and keeps the device choice when none is saved', async () => {
    await i18n.setLocale('fr', { persist: false });
    const empty = bindPrefs({ personal: personal({}), account: 'u1', window: win(), debounce: 0 });
    await empty.ready;
    expect(i18n.requestedLocale()).toBe('fr');
    empty.close();
    const saved = bindPrefs({ personal: personal({ lang: 'de' }), account: 'u1', window: win(), debounce: 0 });
    await saved.ready;
    await vi.waitFor(() => expect(i18n.locale).toBe('de'), WAIT);
    saved.set({ lang: 'ar' });
    await vi.waitFor(() => expect(document.documentElement.dir).toBe('rtl'), WAIT);
    saved.close();
  }, SLOW);
});
