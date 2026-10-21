import { describe, it, expect, vi, afterAll } from 'vitest';
import { EditorStore } from '../src/model/store.js';
import { mainTrack } from '../src/model/timeline.js';
import { fixture, clip, onMain, s } from './helpers.js';

// load() shadows navigator.platform with an own property; drop it afterwards.
afterAll(() => delete navigator.platform);

/** Fresh copies of the platform-dependent modules, as on a Mac or not. */
async function load(mac) {
  Object.defineProperty(navigator, 'platform', { value: mac ? 'MacIntel' : 'Win32', configurable: true });
  vi.resetModules();
  const platform = await import('../src/lib/platform.js');
  const { createCommands } = await import('../src/ui/commands.js');
  const { createActions } = await import('../src/ui/actions.js');
  expect(platform.isMac).toBe(mac);
  const p = fixture();
  onMain(p, clip('video', 0, 2), clip('video', 2, 2));
  const store = new EditorStore(p);
  const ctx = { store, player: { toggle: vi.fn(), play: vi.fn(), pause: vi.fn() }, timeline: null, openShortcuts: vi.fn() };
  ctx.actions = createActions(ctx);
  const commands = createCommands(ctx);
  return { platform, commands, store, ctx };
}

const NAMED_CODES = { Space: ['Space', ' '], Equal: ['Equal', '='], Minus: ['Minus', '-'], Slash: ['Slash', '/'], Period: ['Period', '.'], Comma: ['Comma', ','] };

/** The keydown a person makes for a spec. On a Mac, Option changes e.key, so it is scrambled. */
function eventFor(spec, mac) {
  const parts = spec.split('+');
  const key = parts.pop();
  const init = { altKey: parts.includes('Alt'), shiftKey: parts.includes('Shift'), bubbles: true };
  if (parts.includes('Mod')) init[mac ? 'metaKey' : 'ctrlKey'] = true;
  if (parts.includes('Ctrl')) init.ctrlKey = true;
  if (/^[A-Z]$/.test(key)) Object.assign(init, { code: `Key${key}`, key: init.altKey && mac ? '˜' : init.shiftKey ? key : key.toLowerCase() });
  else if (/^[0-9]$/.test(key)) Object.assign(init, { code: `Digit${key}`, key });
  else if (NAMED_CODES[key]) Object.assign(init, { code: NAMED_CODES[key][0], key: NAMED_CODES[key][1] });
  else Object.assign(init, { code: key, key });
  return new KeyboardEvent('keydown', init);
}

describe.each([['Mac', true], ['Windows and Linux', false]])('keyboard shortcuts on %s', (_, mac) => {
  it('never give two commands the same key', async () => {
    const { commands } = await load(mac);
    const specs = commands.list.flatMap((c) => c.keys);
    expect(specs.filter((k, i) => specs.indexOf(k) !== i)).toEqual([]);
  });

  it('match exactly the command they belong to', async () => {
    const { platform, commands } = await load(mac);
    for (const c of commands.list) {
      for (const spec of c.keys) {
        const e = eventFor(spec, mac);
        const owners = commands.list.filter((o) => o.keys.some((k) => platform.matchShortcut(e, k))).map((o) => o.id);
        expect(owners, spec).toEqual([c.id]);
      }
    }
  });

  it('ignore the other platform\'s command key', async () => {
    const { platform } = await load(mac);
    const other = new KeyboardEvent('keydown', { code: 'KeyZ', key: 'z', [mac ? 'ctrlKey' : 'metaKey']: true });
    expect(platform.matchShortcut(other, 'Mod+Z')).toBe(false);
    if (mac) expect(platform.matchShortcut(other, 'Z')).toBe(false);
  });

  it('label shortcuts in the platform style', async () => {
    const { platform } = await load(mac);
    expect(platform.shortcutLabel('Mod+Shift+Z')).toBe(mac ? '⌘⇧Z' : 'Ctrl+Shift+Z');
    expect(platform.shortcutLabel('ArrowLeft')).toBe('←');
  });

  it('run the matching command from a keydown', async () => {
    const { commands, store, ctx } = await load(mac);
    expect(commands.handleKey(eventFor('Space', mac))).toBe(true);
    expect(ctx.player.toggle).toHaveBeenCalledTimes(1);
    store.seek(s(1));
    commands.handleKey(eventFor('Mod+B', mac));
    expect(mainTrack(store.project).clips).toHaveLength(3);
    commands.handleKey(eventFor('Mod+Z', mac));
    expect(mainTrack(store.project).clips).toHaveLength(2);
    commands.handleKey(eventFor('Mod+Shift+Z', mac));
    expect(mainTrack(store.project).clips).toHaveLength(3);
    expect(commands.handleKey(new KeyboardEvent('keydown', { code: 'F13', key: 'F13' }))).toBe(false);
  });
});

describe('commands', () => {
  it('swallow but do not run disabled commands', async () => {
    const { commands, store } = await load(false);
    expect(commands.run('delete')).toBe(false);
    expect(commands.handleKey(eventFor('Delete', false))).toBe(true);
    expect(mainTrack(store.project).clips).toHaveLength(2);
    store.select(mainTrack(store.project).clips[0].id);
    expect(commands.run('delete')).toBe(true);
    expect(mainTrack(store.project).clips).toHaveLength(1);
  });

  it('step the playhead by frames and jump between edit points', async () => {
    const { commands, store } = await load(false);
    commands.run('frameForward');
    expect(store.time).toBe(Math.round(s(1) / 30));
    // Frame starts as the export rounds them, not a sum of rounded steps (66,666 shows frame 1).
    commands.run('frameForward');
    expect(store.time).toBe(66_667);
    commands.run('frameForward');
    commands.run('framesBack');
    expect(store.time).toBe(0);
    store.seek(50_000); // between frames 1 and 2, the timecode shows frame 2
    commands.run('frameForward');
    expect(store.time).toBe(100_000);
    commands.run('toEnd');
    expect(store.time).toBe(s(4));
    commands.run('prevEdit');
    expect(store.time).toBe(s(2));
    commands.run('toStart');
    commands.run('nextEdit');
    expect(store.time).toBe(s(2));
  });

  it('toggle the timeline switches', async () => {
    const { commands, store } = await load(false);
    commands.run('toggleRipple');
    expect(store.toggles.ripple).toBe(false);
    expect(commands.get('toggleRipple').checked()).toBe(false);
  });

  it('offer remove flicker for video clips and extract audio only when the video has sound', async () => {
    const { commands, store } = await load(false);
    const [a, b] = mainTrack(store.project).clips;
    expect(commands.get('removeFlicker').enabled()).toBe(false);
    store.select(a.id);
    expect(commands.get('removeFlicker').enabled()).toBe(true);
    expect(commands.get('extractAudio').enabled()).toBe(true);
    store.update('Use silent media', (p) => {
      mainTrack(p).clips[1].assetId = 'silent';
    });
    store.select(b.id);
    expect(commands.get('extractAudio').enabled()).toBe(false);
  });

  it('report the first key for menus and an empty string for keyless commands', async () => {
    const { commands } = await load(false);
    expect(commands.keyFor('redo')).toBe('Mod+Shift+Z');
    expect(commands.keyFor('mirror')).toBe('');
    expect(commands.keyFor('missing')).toBe('');
  });
});
