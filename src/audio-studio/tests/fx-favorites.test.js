import { describe, it, expect, vi } from 'vitest';
import { Channel } from '../src/audio/channel.js';
import { AudioFile } from '../src/model/audio-file.js';
import { registerEffect } from '../src/effects/registry.js';
import { seedFavorites, loadFavorites, addFavorite, removeFavorite, moveFavorite, updateFavorite, favoriteProblem, applyFavorite, installFavorites, favoritesPanel } from '../src/effects/favorites.js';
import { installEffectCommands } from '../src/effects/commands.js';
import { fakeApp, filled } from './fx-helpers.js';

registerEffect({ id: 'favFx', name: 'Fav Effect', group: 'Special', kind: null, params: [{ id: 'gain', min: 0, max: 4, step: 0.5, default: 1 }], process: async ({ channels, values }) => channels.map((c) => c.map((v) => v * values.gain)) });

const tick = () => new Promise((r) => setTimeout(r, 0));

function setup() {
  const app = fakeApp();
  installEffectCommands(app);
  installFavorites(app);
  const doc = new AudioFile({ name: 'a.wav', sampleRate: 1000, channels: [Channel.fromSamples(filled(100, 0.5))] });
  app.active = doc;
  return { app, doc };
}

describe('favorites model', () => {
  it('seeds a default set with original names on first use', () => {
    const { app } = setup();
    const names = loadFavorites(app.prefs).map((f) => f.name);
    expect(names).toEqual(seedFavorites().map((f) => f.name));
    for (const n of ['Fade In', 'Fade Out', 'Normalize to -0.1 dB', 'Normalize to -3 dB', 'Hard Limit to -0.1 dB', 'Convert to Mono', 'Convert to Stereo', 'Telephone Voice']) expect(names).toContain(n);
    expect(new Set(seedFavorites().map((f) => f.id)).size).toBe(names.length);
  });
  it('adds, updates, reorders and removes', () => {
    const { app } = setup();
    const f = addFavorite(app.prefs, { name: 'Mine', action: { type: 'command', command: 'fx.reverse' } });
    expect(loadFavorites(app.prefs).at(-1).id).toBe(f.id);
    updateFavorite(app.prefs, f.id, { name: 'Renamed' });
    moveFavorite(app.prefs, f.id, -1);
    const list = loadFavorites(app.prefs);
    expect(list.at(-2).name).toBe('Renamed');
    removeFavorite(app.prefs, f.id);
    expect(loadFavorites(app.prefs).some((x) => x.id === f.id)).toBe(false);
  });
  it('explains why a favorite cannot run', () => {
    const { app } = setup();
    expect(favoriteProblem(app, { action: { type: 'effect', effect: 'nope' } })).toMatch(/not available/);
    expect(favoriteProblem(app, { action: { type: 'command', command: 'fx.toStereo' } })).toBe('');
    expect(favoriteProblem(app, { action: { type: 'command', command: 'fx.toMono' } })).toMatch(/Not available/);
    expect(favoriteProblem(app, {})).toMatch(/damaged/);
    app.active = null;
    expect(favoriteProblem(app, { action: { type: 'effect', effect: 'favFx' } })).toMatch(/Open an audio file/);
  });
});

describe('applying favorites', () => {
  it('applies an effect favorite without a dialog', async () => {
    const { app, doc } = setup();
    await applyFavorite(app, { name: 'Double', action: { type: 'effect', effect: 'favFx', values: { gain: 2 } } });
    expect(doc.state.channels[0].toArray(0, 1)[0]).toBe(1);
    expect(document.querySelector('.fx-dialog')).toBeNull();
  });
  it('applies a command favorite with arguments', async () => {
    const { app, doc } = setup();
    const fav = loadFavorites(app.prefs).find((f) => f.name === 'Normalize to -3 dB');
    await applyFavorite(app, fav);
    expect(doc.state.channels[0].toArray(0, 1)[0]).toBeCloseTo(Math.pow(10, -3 / 20), 5);
  });
  it('makes an applied effect favorite the command Repeat runs, as from its menu item', async () => {
    const { app, doc } = setup();
    // Edit > Repeat (dialog) and Repeat Without Dialog run the last command like this (core.js).
    const repeat = (noDialog) => app.commands.run(app.lastCommand.id, { ...app.lastCommand.args, repeat: noDialog });
    await app.commands.run('fx.normalizePeak', { peak: -3 });
    await applyFavorite(app, { name: 'Double', action: { type: 'effect', effect: 'favFx', values: { gain: 2 } } });
    expect(app.lastCommand).toEqual({ id: 'fx.favFx', args: {} });
    const level = doc.state.channels[0].toArray(0, 1)[0];
    // Repeat opens the effect's dialog, holding the favorite's settings.
    const pending = repeat(false);
    await tick();
    const dlg = document.querySelector('.fx-dialog');
    expect(dlg).not.toBeNull();
    expect(dlg.querySelector('.hot[role="spinbutton"]').getAttribute('aria-valuenow')).toBe('2');
    [...dlg.querySelectorAll('button')].find((b) => b.textContent === 'Cancel' || b.textContent === 'Close').click();
    await pending;
    expect(doc.state.channels[0].toArray(0, 1)[0]).toBe(level);
    // Repeat Without Dialog applies the favorite's settings again.
    await repeat(true);
    expect(doc.state.channels[0].toArray(0, 1)[0]).toBeCloseTo(level * 2, 5);
    expect(document.querySelector('.fx-dialog')).toBeNull();
  });
  it('leaves Repeat alone when an effect favorite does not apply', async () => {
    const { app } = setup();
    await app.commands.run('fx.normalizePeak', { peak: -3 });
    expect(await applyFavorite(app, { name: 'X', action: { type: 'effect', effect: 'missingFx' } })).toBe(false);
    expect(app.lastCommand).toEqual({ id: 'fx.normalizePeak', args: { peak: -3 } });
  });
  it('notifies instead of running when unavailable', async () => {
    const { app } = setup();
    expect(await applyFavorite(app, { name: 'X', action: { type: 'effect', effect: 'missingFx' } })).toBe(false);
    expect(app.notes.at(-1).error).toBe(true);
  });
  it('fills the Favorites menu', () => {
    const { app } = setup();
    addFavorite(app.prefs, { name: 'Missing Effect', action: { type: 'effect', effect: 'missingFx' } });
    const items = app.favoriteMenuItems();
    expect(items.find((i) => i.label === 'Fade In').enabled).toBe(true);
    expect(items.find((i) => i.label === 'Missing Effect').enabled).toBe(false);
  });
});

// Starting a recording first explains it; OK goes ahead.
async function startRecording(app, { never = false } = {}) {
  const run = app.commands.run('fav.recordStart');
  await tick();
  const dialog = [...document.querySelectorAll('.dialog')].pop();
  if (never) dialog.querySelector('input[type="checkbox"]').checked = true;
  dialog.querySelector('.btn.primary').click();
  await run;
}

describe('recording favorites', () => {
  it('explains recording once the notice is turned off, until warnings are reset', async () => {
    const { app } = setup();
    await startRecording(app, { never: true });
    expect(app.favorites.recording).toBe(true);
    await app.commands.run('fav.recordStop');
    await app.commands.run('fav.recordStart');
    expect(app.favorites.recording).toBe(true);
    expect(document.querySelector('.dialog')).toBeNull();
    await app.commands.run('fav.recordStop');
    app.prefs.reset(['dismissedNotices']);
    const run = app.commands.run('fav.recordStart');
    await tick();
    expect(document.querySelector('.dialog').textContent).toContain("Don't show this again");
    [...document.querySelectorAll('.dialog .btn')].find((b) => b.textContent === 'Cancel').click();
    await run;
    expect(app.favorites.recording).toBe(false);
  });
  it('captures the next applied effect with its values', async () => {
    const { app } = setup();
    await startRecording(app);
    expect(app.favorites.recording).toBe(true);
    expect(app.commands.isEnabled('fav.recordStart')).toBe(false);
    await app.runEffect('favFx', { values: { gain: 1.5 } });
    expect(app.favorites.recordedSteps()).toHaveLength(1);
    app.commands.run('fav.recordStop');
    await tick();
    const input = document.querySelector('.dialog input');
    expect(input.value).toBe('Fav Effect');
    input.value = 'One and a half';
    document.querySelector('.dialog .btn.primary').click();
    await tick();
    await tick();
    const fav = loadFavorites(app.prefs).at(-1);
    expect(fav).toMatchObject({ name: 'One and a half', action: { type: 'effect', effect: 'favFx', values: { gain: 1.5 } } });
    expect(app.favorites.recording).toBe(false);
  });
  it('stops recording without saving', async () => {
    const { app } = setup();
    await startRecording(app);
    await app.commands.run('fav.recordStop');
    expect(app.favorites.recording).toBe(false);
  });
  it('registers favorite shortcuts as commands, never stealing existing ones', () => {
    const { app } = setup();
    app.commands.register({ id: 'taken', label: 'Taken', shortcut: 'Mod+K', run: () => {} });
    const a = addFavorite(app.prefs, { name: 'A', shortcut: 'Alt+Shift+1', action: { type: 'command', command: 'fx.fadeIn' } });
    addFavorite(app.prefs, { name: 'B', shortcut: 'Mod+K', action: { type: 'command', command: 'fx.fadeOut' } });
    expect(app.commands.get(`fav.run.${a.id}`).label).toBe('Favorite: A');
    expect(app.commands.byShortcut.get('mod+k')).toBe('taken');
    removeFavorite(app.prefs, a.id);
    expect(app.commands.get(`fav.run.${a.id}`)).toBeUndefined();
  });
});

describe('favorites panel', () => {
  it('lists favorites with shortcuts and applies on Enter', async () => {
    const { app, doc } = setup();
    addFavorite(app.prefs, { name: 'Quiet', shortcut: 'Alt+Q', action: { type: 'effect', effect: 'favFx', values: { gain: 0.5 } } });
    addFavorite(app.prefs, { name: 'Missing Effect', action: { type: 'effect', effect: 'missingFx' } });
    const panel = favoritesPanel(app);
    document.body.append(panel.el);
    const rows = [...panel.el.querySelectorAll('tbody tr')];
    expect(panel.el.querySelectorAll('th')[0].textContent).toBe('Favorite Name');
    const row = rows.find((r) => r.textContent.includes('Quiet'));
    expect(row.querySelector('kbd').textContent).not.toBe('');
    expect(rows.find((r) => r.textContent.includes('Missing Effect')).classList.contains('unavailable')).toBe(true);
    row.click();
    panel.el.querySelector('tr[aria-selected="true"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await tick();
    await tick();
    expect(doc.state.channels[0].toArray(0, 1)[0]).toBe(0.25);
    panel.el.remove();
  });
  it('leaves the focus in the Edit Favorite dialog that F2 opens', async () => {
    const { app } = setup();
    const panel = favoritesPanel(app);
    document.body.append(panel.el);
    const row = panel.el.querySelector('tr[aria-selected="true"]');
    row.focus();
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true }));
    await new Promise((r) => requestAnimationFrame(r));
    await tick();
    const dlg = document.querySelector('.dialog');
    expect(dlg).not.toBeNull();
    expect(dlg.contains(document.activeElement)).toBe(true);
    dlg.querySelector('[aria-label="Close"]').click();
    await tick();
    panel.el.remove();
  });
});
