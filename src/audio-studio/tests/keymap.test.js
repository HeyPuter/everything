import { describe, it, expect } from 'vitest';
import { CommandRegistry, normalizeShortcut, browserReserved, formatShortcut } from '../src/commands/registry.js';
import { installKeymap, DEFAULT_KEYS } from '../src/commands/keymap.js';
import { TIME_FORMATS } from '../src/lib/time.js';
import { moveEdge, stepFrames, cycleDocument, nextFftSize, latestRecent } from '../src/commands/keymap-commands.js';

function fakeApp() {
  const store = {};
  const app = { prefs: { get: (k) => store[k], set: (k, v) => (store[k] = v) }, active: null };
  app.commands = new CommandRegistry(app);
  return app;
}

describe('keymap', () => {
  it('rebinds existing commands and adds navigation commands', () => {
    const app = fakeApp();
    app.commands.register([
      { id: 'transport.previous', label: 'Previous', shortcut: 'Home', run: () => {} },
      { id: 'transport.toStart', label: 'Start', shortcut: 'Mod+ArrowLeft', run: () => {} },
      { id: 'view.zoomFull', label: 'Full', shortcut: '\\', run: () => {} },
      { id: 'view.zoomResetTime', label: 'Reset', run: () => {} },
    ]);
    installKeymap(app);
    const C = app.commands;
    expect(C.commandFor('Home')).toBe('transport.toStart');
    expect(C.commandFor('Mod+ArrowLeft')).toBe('view.scrollLeft');
    expect(C.commandFor('ArrowLeft')).toBe('transport.left');
    expect(C.commandFor('Alt+ArrowLeft')).toBe('transport.previous');
    expect(C.commandFor('\\')).toBe('view.zoomResetTime');
    expect(C.commandFor('Mod+\\')).toBe('view.zoomFull');
    expect(C.commandFor('Q')).toBe('transport.toInPoint');
    expect(C.commandFor('O')).toBe('edit.setOutPoint');
  });

  it('keeps user remappings over the defaults', () => {
    const app = fakeApp();
    app.prefs.set('shortcuts', { 'transport.toStart': ['Mod+Home'] });
    app.commands = new CommandRegistry(app);
    app.commands.register({ id: 'transport.toStart', label: 'Start', run: () => {} });
    installKeymap(app);
    expect(app.commands.commandFor('Mod+Home')).toBe('transport.toStart');
    expect(app.commands.commandFor('Home')).toBe(null);
  });

  it('gives every key to one command only', () => {
    const keys = Object.values(DEFAULT_KEYS).flat();
    expect(new Set(keys).size).toBe(keys.length);
  });
});

// ------------------------------------------------------------- whole app

async function fullApp() {
  HTMLCanvasElement.prototype.getContext = () => null;
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
  };
  localStorage.clear();
  const { App } = await import('../src/app.js');
  const { FEATURES } = await import('../src/features.js');
  const app = new App();
  for (const install of FEATURES) install(app);
  app.syncGraph = () => {};
  return app;
}

describe('default keymap of the whole app', () => {
  it('binds each key to one command only', async () => {
    const app = await fullApp();
    const C = app.commands;
    const seen = new Map();
    const clashes = [];
    for (const id of C.commands.keys()) {
      for (const k of C.keysFor(id)) {
        const n = normalizeShortcut(k);
        if (seen.has(n)) clashes.push(`${k}: ${seen.get(n)} / ${id}`);
        seen.set(n, id);
      }
    }
    expect(clashes).toEqual([]);
  });

  it('gives every bound command a key the browser lets through, on every platform', async () => {
    const app = await fullApp();
    const C = app.commands;
    const stuck = [];
    for (const id of C.commands.keys()) {
      const keys = C.keysFor(id);
      for (const mac of [true, false]) if (keys.length && keys.every((k) => browserReserved(k, mac))) stuck.push(`${id} (${mac ? 'macOS' : 'other'})`);
    }
    expect(stuck).toEqual([]);
  });

  it('every default key names a registered command', async () => {
    const app = await fullApp();
    const missing = Object.keys(DEFAULT_KEYS).filter((id) => !app.commands.commands.has(id));
    expect(missing).toEqual([]);
  });

  it('uses the common audio-editor layout', async () => {
    const app = await fullApp();
    const C = app.commands;
    const expected = {
      ArrowLeft: 'transport.left',
      ArrowRight: 'transport.right',
      ArrowUp: 'mt.selectPreviousTrack',
      ArrowDown: 'mt.selectNextTrack',
      'Shift+ArrowLeft': 'edit.inPointLeft',
      'Mod+Shift+End': 'edit.outPointToEnd',
      'Shift+I': 'zero.inward',
      'Shift+L': 'zero.rightToRight',
      'Mod+B': 'channel.all',
      'Mod+Shift+B': 'channel.all',
      'Alt+Shift+R': 'channel.rightSurround',
      'Shift+1': 'mt.loadVisibility1',
      'Alt+Shift+5': 'mt.saveVisibility5',
      'Mod+J': 'transport.jumpToTime',
      'Alt+Shift+Space': 'transport.punchRoll',
      'Shift+Z': 'prefs.toggleSpectralPlaySelected',
      'Shift+X': 'prefs.toggleReturnToStart',
      'Shift+V': 'prefs.toggleStopAtSelectionEnd',
      'Mod+Shift+Y': 'prefs.toggleSyncFiles',
      'Mod+ArrowRight': 'view.scrollRight',
      'Mod+PageUp': 'view.scrollPageLeft',
      'Mod+Shift+ArrowUp': 'view.specResolutionUp',
      'Mod+Alt+ArrowDown': 'view.specMoreLinear',
      'Mod+Alt+PageUp': 'view.specLog',
      'Alt+\\': 'view.zoomResetAmp',
      'Mod+Alt+\\': 'view.zoomFullFreq',
      'Shift+\\': 'view.zoomOutTrack',
      'Alt+Shift+Home': 'view.zoomWayInPoint',
      'Alt+Shift+,': 'clip.nudgeLeft5',
      'Alt+T': 'clip.trimToSelection',
      'Mod+Alt+Shift+K': 'clip.splitAll',
      'Mod+Shift+G': 'clip.suspendGroups',
      'Alt+Shift+C': 'edit.copyToNew',
      'Mod+D': 'edit.deselect',
      'Mod+0': 'marker.deleteSelected',
      'Mod+Alt+0': 'marker.deleteAll',
      'Mod+Shift+I': 'edit.insertIntoSession',
      F2: 'edit.repeat',
      'Mod+R': 'edit.repeat',
      F3: 'edit.repeatNoDialog',
      'Shift+R': 'edit.repeatNoDialog',
      'Ctrl+Tab': 'file.nextDocument',
      'Mod+Alt+O': 'file.openRecentSession',
      'Mod+Alt+Shift+O': 'file.openRecentFile',
      'Alt+5': 'window.loudness',
      'Alt+6': 'window.selection',
      'Alt+X': 'window.phase',
      'Mod+P': 'window.metadata',
      'Shift+G': 'clip.gain',
      'Mod+Alt+A': 'analysis.scanAmplitude',
      'Mod+Alt+F': 'analysis.scanFrequency',
      'Alt+[': 'spectral.opacityDown',
      'Mod+,': 'prefs.general',
      F4: 'edit.preferences',
      'Mod+E': 'edit.editOriginal',
      'Shift+8': 'marker.add',
      'Mod+F8': 'marker.addPoint',
      'Mod+Shift+M': 'marker.addRange',
    };
    const wrong = Object.entries(expected).filter(([k, id]) => C.commandFor(k) !== id).map(([k, id]) => `${k}: ${C.commandFor(k)} (want ${id})`);
    expect(wrong).toEqual([]);
  });

  it('shows menus a key the browser lets the page use', async () => {
    const app = await fullApp();
    const C = app.commands;
    expect(browserReserved('Mod+W')).toBe(true);
    expect(browserReserved('Ctrl+Tab', false)).toBe(true);
    expect(browserReserved('Mod+M', true)).toBe(true);
    expect(browserReserved('Mod+M', false)).toBe(false);
    expect(browserReserved('Mod+PageUp', false)).toBe(true);
    expect(browserReserved('Mod+PageUp', true)).toBe(false);
    expect(browserReserved('Mod+S')).toBe(false);
    expect(C.shortcutLabel('file.close')).toBe(formatShortcut('Alt+W'));
    expect(C.shortcutLabel('file.newSession')).toBe(formatShortcut('Alt+N'));
    expect(C.shortcutLabel('file.save')).toBe(formatShortcut('Mod+S'));
  });
});

describe('keyboard commands', () => {
  async function withFile(seconds = 4) {
    const app = await fullApp();
    const { AudioFile } = await import('../src/model/audio-file.js');
    const { Channel } = await import('../src/audio/channel.js');
    const n = 1000 * seconds;
    const doc = new AudioFile({ name: 'k.wav', sampleRate: 1000, channels: [Channel.fromSamples(new Float32Array(n)), Channel.fromSamples(new Float32Array(n))] });
    app.addDocument(doc);
    doc.setView(0, n);
    return { app, doc };
  }

  it('moves the in and out points, starting from the playhead', async () => {
    const { app, doc } = await withFile();
    doc.setCursor(1000);
    await app.commands.run('edit.inPointToStart');
    expect([doc.selection.start, doc.selection.end]).toEqual([0, 1000]);
    await app.commands.run('edit.outPointToEnd');
    expect([doc.selection.start, doc.selection.end]).toEqual([0, 4000]);
    const step = stepFrames(app);
    await app.commands.run('edit.inPointRight');
    expect(doc.selection.start).toBe(step);
    await app.commands.run('edit.outPointLeft');
    expect(doc.selection.end).toBe(4000 - step);
    // Edges that cross swap.
    moveEdge(app, 'in', 4000);
    expect([doc.selection.start, doc.selection.end]).toEqual([4000 - step, 4000]);
  });

  it('moves the playhead in small steps and scrolls the view', async () => {
    const { app, doc } = await withFile();
    doc.setView(0, 1000);
    doc.setCursor(500);
    await app.commands.run('transport.right');
    expect(doc.cursor).toBe(500 + stepFrames(app));
    await app.commands.run('view.scrollPageRight');
    expect(doc.view.start).toBe(1000);
    await app.commands.run('view.scrollToStart');
    expect(doc.view.start).toBe(0);
  });

  it('toggles channels and enables them all again', async () => {
    const { app, doc } = await withFile();
    await app.commands.run('channel.left');
    expect(doc.selection.channels).toEqual([false, true]);
    expect(app.commands.isEnabled('channel.center')).toBe(false);
    await app.commands.run('channel.all');
    expect(doc.selection.channels).toEqual([true, true]);
  });

  it('toggles playback preferences', async () => {
    const { app } = await withFile();
    const before = app.prefs.get('returnToStart');
    await app.commands.run('prefs.toggleReturnToStart');
    expect(app.prefs.get('returnToStart')).toBe(!before);
    await app.commands.run('prefs.toggleScrollWave');
    expect(app.prefs.get('scrollWave')).toBe('center');
  });

  it('cycles the time display format', async () => {
    const { app } = await withFile();
    app.prefs.set('timeFormat', 'decimal');
    await app.commands.run('view.nextTimeFormat');
    expect(app.prefs.get('timeFormat')).toBe('compact');
    await app.commands.run('view.previousTimeFormat');
    await app.commands.run('view.previousTimeFormat');
    expect(app.prefs.get('timeFormat')).toBe(TIME_FORMATS[TIME_FORMATS.length - 1].id);
  });

  it('repeats the last command with or without its dialog', async () => {
    const app = await fullApp();
    const seen = [];
    app.commands.register({ id: 'x.fx', label: 'Fx', repeatable: true, run: (a, args) => seen.push(Boolean(args?.repeat)) });
    await app.commands.run('x.fx');
    await app.commands.run('edit.repeat');
    await app.commands.run('edit.repeatNoDialog');
    expect(seen).toEqual([false, false, true]);
  });

  it('names the repeated effect without a dialog ellipsis in Repeat Last Effect', async () => {
    const app = await fullApp();
    app.commands.register({ id: 'x.dlg', label: 'Amplify...', repeatable: true, run: () => {} });
    await app.commands.run('x.dlg');
    expect(app.commands.label('fx.applyLast')).toBe('Repeat Amplify');
  });

  it('helpers: documents, FFT sizes and recent entries', () => {
    expect(cycleDocument(['a', 'b', 'c'], 'c', 1)).toBe('a');
    expect(cycleDocument(['a', 'b', 'c'], 'a', -1)).toBe('c');
    expect(cycleDocument(['a'], 'a', 1)).toBe(null);
    expect(nextFftSize(2048, 1)).toBe(4096);
    expect(nextFftSize(256, -1)).toBe(null);
    const list = [{ name: 'take.wav' }, { name: 'Mix.asesx' }, { name: 'old.wav' }];
    expect(latestRecent(list, true).name).toBe('Mix.asesx');
    expect(latestRecent(list, false).name).toBe('take.wav');
  });
});
