import { describe, it, expect } from 'vitest';
import { CommandRegistry, normalizeShortcut, eventKey, eventShortcut } from '../src/commands/registry.js';
import { Prefs } from '../src/lib/prefs.js';

const memory = () => {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) };
};

describe('CommandRegistry shortcuts', () => {
  it('matches, remaps, moves conflicts and persists', () => {
    const app = { prefs: new Prefs(memory()), documentKinds: new Map() };
    const C = new CommandRegistry(app);
    C.register([
      { id: 'a', label: 'A', shortcut: 'Mod+K', run: () => 'a' },
      { id: 'b', label: 'B', shortcut: 'B', run: () => 'b' },
    ]);
    expect(C.commandFor('Mod+K')).toBe('a');
    C.setShortcuts('b', [normalizeShortcut('Mod+K')]);
    expect(C.commandFor('Mod+K')).toBe('b');
    expect(C.keysFor('a')).toEqual([]);
    expect(app.prefs.get('shortcuts').b).toEqual(['mod+k']);
    const again = new CommandRegistry(app);
    again.register({ id: 'b', label: 'B', shortcut: 'B', run() {} });
    expect(again.commandFor('Mod+K')).toBe('b');
    again.resetShortcuts('b');
    expect(again.commandFor('B')).toBe('b');
  });

  it('lets a document kind override a shared command', async () => {
    const app = { active: { kind: 'session' }, documentKinds: new Map([['session', { commands: { a: { run: () => 'session' } } }]]) };
    const C = new CommandRegistry(app);
    C.register({ id: 'a', label: 'A', run: () => 'audio' });
    expect(await C.run('a')).toBe('session');
    app.active = { kind: 'audio' };
    expect(await C.run('a')).toBe('audio');
  });
});

describe('Prefs', () => {
  it('renames keys, shortcuts and panels saved by earlier versions', () => {
    const storage = memory();
    const saved = {
      essentialPresets: { music: { Soft: {} } },
      essentialCollapsed: { repair: true },
      shortcuts: { 'window.essential': 'Alt+5' },
      layouts: { Default: { t: 'row', c: [{ t: 'group', tabs: ['editor'], a: 'editor' }, { t: 'group', tabs: ['properties', 'essential'], a: 'essential' }], s: [1, 1] } },
    };
    storage.setItem('audio-studio:prefs', JSON.stringify(saved));
    const prefs = new Prefs(storage);
    expect(prefs.get('soundAssistantPresets')).toEqual({ music: { Soft: {} } });
    expect(prefs.get('soundAssistantCollapsed')).toEqual({ repair: true });
    expect(prefs.get('shortcuts')).toEqual({ 'window.assistant': 'Alt+5' });
    expect(prefs.get('layouts').Default.c[1]).toEqual({ t: 'group', tabs: ['properties', 'assistant'], a: 'assistant' });
    expect('essentialPresets' in prefs.values).toBe(false);
  });
});

describe('shortcut keys from keyboard events', () => {
  const ev = (o) => new KeyboardEvent('keydown', o);

  it('follows the keyboard layout for letters', () => {
    // AZERTY: the key labelled Z sits where QWERTY has W, and A where QWERTY has Q.
    expect(eventKey(ev({ key: 'z', code: 'KeyW' }))).toBe('z');
    expect(eventKey(ev({ key: 'a', code: 'KeyQ' }))).toBe('a');
    expect(eventKey(ev({ key: 'm', code: 'Semicolon' }))).toBe('m');
    expect(eventShortcut(ev({ key: 'z', code: 'KeyW', metaKey: true, ctrlKey: true }))).toMatch(/\+z$/);
    expect(eventKey(ev({ key: 'Z', code: 'KeyW', shiftKey: true }))).toBe('z');
  });

  it('uses the physical key when the layout gives no Latin letter', () => {
    // Option+K on macOS types "˚"; a Cyrillic layout types "л".
    expect(eventKey(ev({ key: '˚', code: 'KeyK', altKey: true }))).toBe('k');
    expect(eventKey(ev({ key: 'л', code: 'KeyK' }))).toBe('k');
    // Digits and punctuation keep their physical key (Shift changes the character).
    expect(eventKey(ev({ key: '!', code: 'Digit1', shiftKey: true }))).toBe('1');
    expect(eventKey(ev({ key: '?', code: 'Slash', shiftKey: true }))).toBe('/');
  });
});
