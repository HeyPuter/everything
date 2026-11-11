import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EditorStore } from '../src/model/store.js';
import { createActions } from '../src/ui/actions.js';
import { pref, defaultLength, openPreferences, PREF_DEFAULTS } from '../src/ui/preferences-dialog.js';
import { setPref } from '../src/ui/prefs.js';
import { mainTrack } from '../src/model/timeline.js';
import { fixture, clip, onMain, s } from './helpers.js';

function setup() {
  const p = fixture();
  onMain(p, clip('video', 0, 4), clip('video', 4, 4));
  const store = new EditorStore(p);
  const ctx = { store, player: { pause: vi.fn() } };
  ctx.actions = createActions(ctx);
  return { store, ctx };
}

describe('preferences', () => {
  beforeEach(() => {
    for (const k of Object.keys(PREF_DEFAULTS)) setPref(k, undefined);
  });

  it('falls back to defaults and converts lengths', () => {
    expect(pref('imageDuration')).toBe(5);
    expect(defaultLength.transition()).toBe(s(0.5));
    setPref('imageDuration', 2.5);
    expect(defaultLength.image()).toBe(s(2.5));
  });

  it('new clips use the preferred lengths', () => {
    const { ctx, store } = setup();
    setPref('imageDuration', 2);
    setPref('textDuration', 7);
    setPref('transitionDuration', 1);
    ctx.actions.addAsset(store.project.assets.img, { start: s(20) });
    const img = store.project.tracks.flatMap((t) => t.clips).find((c) => c.type === 'image');
    expect(img.duration).toBe(s(2));
    const text = ctx.actions.addText('plain', { start: 0 });
    expect(text.duration).toBe(s(7));
    const first = mainTrack(store.project).clips[0];
    ctx.actions.applyTransition('mix', { clipId: first.id });
    expect(mainTrack(store.project).clips[0].transition.duration).toBe(s(1));
  });

  it('opens a dialog that writes settings as they change', () => {
    const { ctx } = setup();
    const d = openPreferences(ctx);
    const input = d.el.querySelector('#pref-imageDuration');
    input.value = '9';
    input.dispatchEvent(new Event('change'));
    expect(pref('imageDuration')).toBe(9);
    const loop = d.el.querySelector('#pref-loopPlayback');
    loop.click();
    expect(pref('loopPlayback')).toBe(true);
    // Values outside the range are clamped.
    input.value = '1000';
    input.dispatchEvent(new Event('change'));
    expect(pref('imageDuration')).toBe(60);
    d.close();
  });
});

describe('preferences in two tabs', () => {
  it("don't put back another tab's older settings when this tab changes one", async () => {
    const { prefs } = await import('../src/ui/prefs.js');
    setPref('leftW', 400);
    expect(prefs().leftW).toBe(400);
    // Another tab customizes a shortcut and a preference meanwhile.
    const KEY = 'video-studio:prefs';
    const other = { ...JSON.parse(localStorage.getItem(KEY)), shortcuts: { split: ['S'] }, imageDuration: 7 };
    localStorage.setItem(KEY, JSON.stringify(other));
    // This tab then resizes a panel.
    setPref('leftW', 420);
    const saved = JSON.parse(localStorage.getItem(KEY));
    expect(saved.leftW).toBe(420);
    expect(saved.shortcuts).toEqual({ split: ['S'] });
    expect(saved.imageDuration).toBe(7);
    // Told about the other tab's change, this tab reads it.
    window.dispatchEvent(new StorageEvent('storage', { key: KEY }));
    expect(prefs().imageDuration).toBe(7);
    expect(pref('imageDuration')).toBe(7);
    setPref('imageDuration', undefined);
    setPref('shortcuts', {});
  });
});
