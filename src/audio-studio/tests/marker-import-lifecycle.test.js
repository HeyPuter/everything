import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from '../src/app.js';
import { AudioFile } from '../src/model/audio-file.js';
import { Channel } from '../src/audio/channel.js';
import { createMarker } from '../src/model/markers.js';
import { installCoreCommands } from '../src/commands/core.js';
import { installIo } from '../src/features/io.js';

beforeEach(() => { localStorage.clear(); vi.stubGlobal('Blob', NodeBlob); });
afterEach(() => { delete window.puter; vi.unstubAllGlobals(); vi.restoreAllMocks(); document.body.replaceChildren(); });

const cases = [
  ...[['picker', 'closed'], ['read', 'closed'], ['text', 'closed'],
    ['picker', 'switched'], ['text', 'switched'],
    ['picker', 'edited'], ['text', 'edited']].map((c) => ['Puter', ...c]),
  ...[['picker', 'closed'], ['text', 'closed'], ['text', 'switched'], ['text', 'edited']].map((c) => ['local', ...c]),
];
it.each(cases)('handles a %s marker import paused at %s when its destination is %s', async (provider, stage, action) => {
  const app = new App();
  app.syncGraph = vi.fn();
  app.notify = vi.fn();
  app.prefs.set('autosave', false);
  installCoreCommands(app);
  installIo(app);
  const make = (name) => app.addDocument(new AudioFile({ name, sampleRate: 8000, channels: [Channel.fromSamples(new Float32Array(32).fill(0.25))] }));
  const target = make('Target.wav');
  const other = make('Other.wav');
  app.activate(target);
  app.dock = { openPanel: vi.fn(), isVisible: () => true };
  const original = target.state;
  const otherState = other.state;
  let release;
  let waiting = false;
  const gate = new Promise((resolve) => { release = resolve; });
  const wait = async (at) => { if (stage === at) { waiting = true; await gate; } };
  const file = new Blob(['Name\tStart\tDuration\nImported\t0.001\t0.002\n'], { type: 'text/plain' });
  const text = file.text.bind(file);
  vi.spyOn(file, 'text').mockImplementation(async () => { await wait('text'); return text(); });
  const item = { name: 'markers.txt', read: vi.fn(async () => { await wait('read'); return file; }) };
  if (provider === 'Puter') window.puter = { auth: { isSignedIn: () => true }, ui: { showOpenFilePicker: vi.fn(async () => { await wait('picker'); return item; }) } };
  const pending = app.commands.run('file.importMarkers');
  const input = document.querySelector('input[type=file]');
  const selectLocal = () => {
    if (!input?.isConnected) return;
    Object.defineProperty(input, 'files', { value: [file] });
    input.dispatchEvent(new Event('change'));
  };
  if (provider === 'local') {
    if (stage === 'picker') waiting = true;
    else selectLocal();
  }
  try {
    await vi.waitFor(() => expect(waiting).toBe(true), { interval: 1 });
    if (action === 'closed') expect(await app.commands.run('file.close')).toBe(true);
    else {
      if (action === 'edited') target.apply('Add Marker', { ...target.state, markers: [createMarker({ name: 'Newer', start: 2 })] });
      app.activate(other);
    }
    const beforeImport = target.state;
    release();
    selectLocal();
    const result = await pending;
    expect(app.active).toBe(other);
    expect(other.state).toBe(otherState);
    if (action === 'closed') {
      expect(target.state).toBe(original);
      expect(target.dirty).toBe(false);
      expect(target.history.entries).toHaveLength(1);
      expect(app.documents).not.toContain(target);
      expect(result).toBe(false);
      expect(app.notify).toHaveBeenCalledOnce();
      expect(app.notify).toHaveBeenCalledWith(expect.stringContaining('closed'), { error: true });
      expect(app.dock.openPanel).not.toHaveBeenCalled();
      if (provider === 'Puter' && stage === 'picker') expect(item.read).not.toHaveBeenCalled();
    } else {
      expect(app.documents).toContain(target);
      expect(target.state.channels).toBe(original.channels);
      expect(target.state.markers.map((m) => [m.name, m.start, m.duration])).toEqual([
        ...(action === 'edited' ? [['Newer', 2, 0]] : []), ['Imported', 8, 16],
      ]);
      expect(app.notify).toHaveBeenCalledWith('Imported 1 marker.');
      expect(app.dock.openPanel).toHaveBeenCalledWith('markers', { focus: false });
      app.activate(target);
      await app.commands.run('edit.undo');
      expect(target.state).toBe(beforeImport);
      await app.commands.run('edit.redo');
      expect(target.state.markers.at(-1).name).toBe('Imported');
    }
  } finally {
    release();
    selectLocal();
    await pending;
  }
});
