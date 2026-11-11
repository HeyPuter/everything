import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EditorStore } from '../src/model/store.js';
import { createCommands } from '../src/ui/commands.js';
import { createActions } from '../src/ui/actions.js';
import { specFromEvent } from '../src/ui/shortcuts-dialog.js';
import { isMac } from '../src/lib/platform.js';
import { fixture, clip, onMain } from './helpers.js';

function setup() {
  const p = fixture();
  onMain(p, clip('video', 0, 2), clip('video', 2, 2));
  const store = new EditorStore(p);
  const ctx = { store, player: { toggle: vi.fn(), play: vi.fn(), pause: vi.fn() }, timeline: null };
  ctx.actions = createActions(ctx);
  return { store, ctx, commands: createCommands(ctx) };
}

const mod = isMac ? { metaKey: true } : { ctrlKey: true };

describe('customizable shortcuts', () => {
  beforeEach(() => localStorage.clear());

  it('rebinds, persists and restores a command', () => {
    const { commands } = setup();
    expect(commands.keyFor('shuttleBack')).toBe('J');
    commands.setKeys('shuttleBack', ['Shift+J']);
    expect(commands.get('shuttleBack').keys).toEqual(['Shift+J']);
    expect(commands.isCustom('shuttleBack')).toBe(true);
    // A new editor session picks the saved binding up.
    expect(setup().commands.keyFor('shuttleBack')).toBe('Shift+J');
    commands.setKeys('shuttleBack', null);
    expect(commands.keyFor('shuttleBack')).toBe('J');
    expect(commands.isCustom('shuttleBack')).toBe(false);
  });

  it('reports conflicts and resets everything', () => {
    const { commands } = setup();
    expect(commands.conflicts('Mod+B', 'markIn').map((c) => c.id)).toEqual(['split']);
    commands.setKeys('markIn', []);
    expect(commands.keyFor('markIn')).toBe('');
    commands.resetKeys();
    expect(commands.keyFor('markIn')).toBe('I');
  });

  it('runs a rebound command from its new key', () => {
    const { commands, store } = setup();
    commands.setKeys('selectAll', ['Shift+A']);
    expect(commands.handleKey(new KeyboardEvent('keydown', { code: 'KeyA', key: 'A', shiftKey: true }))).toBe(true);
    expect(store.selection.size).toBe(2);
  });

  it('turns key events into specs', () => {
    expect(specFromEvent(new KeyboardEvent('keydown', { code: 'KeyK', key: 'k', ...mod, shiftKey: true }))).toBe('Mod+Shift+K');
    expect(specFromEvent(new KeyboardEvent('keydown', { code: 'BracketLeft', key: '[' }))).toBe('BracketLeft');
    expect(specFromEvent(new KeyboardEvent('keydown', { code: 'ArrowUp', key: 'ArrowUp', altKey: true }))).toBe('Alt+ArrowUp');
    expect(specFromEvent(new KeyboardEvent('keydown', { code: 'Digit3', key: '3' }))).toBe('3');
    expect(specFromEvent(new KeyboardEvent('keydown', { code: 'ShiftLeft', key: 'Shift', shiftKey: true }))).toBeNull();
  });
});

describe('organize commands', () => {
  beforeEach(() => localStorage.clear());

  it('disables, groups and marks a range through commands', () => {
    const { commands, store } = setup();
    const ids = store.project.tracks[0].clips.map((c) => c.id);
    store.select(ids);
    expect(commands.run('group')).toBe(true);
    expect(store.project.tracks[0].clips.every((c) => c.group)).toBe(true);
    commands.run('toggleDisabled');
    expect(store.project.tracks[0].clips.every((c) => c.disabled)).toBe(true);
    commands.run('toggleDisabled');
    expect(store.project.tracks[0].clips.some((c) => c.disabled)).toBe(false);
    commands.run('markClip');
    expect(store.project.range).toEqual({ in: 0, out: 4_000_000 });
    commands.run('clearRange');
    expect(store.project.range).toBeUndefined();
    commands.run('ungroup');
    expect(store.project.tracks[0].clips.some((c) => c.group)).toBe(false);
  });

  it('copies attributes from one clip to another', () => {
    const { ctx, store } = setup();
    const [a, b] = store.project.tracks[0].clips;
    a.opacity = 0.4;
    a.blend = 'screen';
    a.transform.scale = 2;
    store.select([a.id]);
    ctx.actions.copyAttributes();
    store.select([b.id]);
    ctx.actions.applyAttributes(['opacity']);
    const nb = store.project.tracks[0].clips[1];
    expect(nb.opacity).toBe(0.4);
    expect(nb.blend).toBe('screen');
    expect(nb.transform.scale).toBe(1);
    ctx.actions.applyAttributes(['transform']);
    expect(store.project.tracks[0].clips[1].transform.scale).toBe(2);
  });
});

describe('shortcuts on other keyboard layouts', () => {
  // Earlier tests rebind keys; start from the defaults.
  beforeEach(() => setup().commands.resetKeys());
  const ran = (commands, init) => {
    const hit = [];
    for (const c of commands.list) vi.spyOn(c, 'run').mockImplementation(() => hit.push(c.id));
    commands.handleKey(new KeyboardEvent('keydown', init));
    return hit;
  };

  it('undoes with Cmd/Ctrl+Z on a German keyboard, where Z sits on the US Y key', () => {
    const { commands } = setup();
    commands.get('undo').enabled = () => true;
    commands.get('redo').enabled = () => true;
    expect(ran(commands, { key: 'z', code: 'KeyY', ...mod })).toEqual(['undo']);
    expect(ran(setup().commands, { key: 'y', code: 'KeyZ', ...mod })).not.toContain('undo');
  });

  it('selects all with Cmd/Ctrl+A on a French keyboard, where A sits on the US Q key', () => {
    const { commands } = setup();
    expect(ran(commands, { key: 'a', code: 'KeyQ', ...mod })).toEqual(['selectAll']);
  });

  it('falls back to the physical key when the layout types no Latin letter', () => {
    const { commands } = setup();
    // Russian layout: the B key types и.
    expect(ran(commands, { key: 'и', code: 'KeyB', ...mod })).toEqual(['split']);
  });

  it('records the letter typed when rebinding', () => {
    expect(specFromEvent(new KeyboardEvent('keydown', { key: 'z', code: 'KeyY', ...mod }))).toBe('Mod+Z');
    expect(specFromEvent(new KeyboardEvent('keydown', { key: 'ф', code: 'KeyA' }))).toBe('A');
  });
});
