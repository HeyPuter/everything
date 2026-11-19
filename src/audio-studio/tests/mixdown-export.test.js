import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/app.js';
import { Session } from '../src/model/session.js';
import { Channel } from '../src/audio/channel.js';
import { installCoreCommands } from '../src/commands/core.js';
import { installMultitrackCommands } from '../src/multitrack/commands.js';
import { parseWav } from '../src/audio/wav.js';
import { addClips, createClip } from '../src/model/session-edits.js';
import { ChunkStore, renderBlock, createScratch } from '../src/engine/mixcore.js';
import { exportFileDialog, describeMixdown } from '../src/export/dialog.js';
import { mixdownTargets, mixdownTracks } from '../src/export/mixdown.js';
import { Prefs } from '../src/lib/prefs.js';

vi.mock('../src/engine/offline.js', () => ({
  renderGraph: async (graph, sources, { start, end }) => {
    const store = new ChunkStore();
    for (const [id, channels] of sources) store.put(id, 0, channels.map((c) => c.toArray()));
    const out = [new Float32Array(end - start), new Float32Array(end - start)];
    renderBlock(graph, store, start, end - start, out, createScratch(128));
    return out;
  },
}));
vi.mock('../src/export/export-worker.js?worker', async () => {
  const { WavWriter } = await import('../src/export/pcm.js');
  return {
    default: class {
      postMessage(message) {
        if (message.type === 'start') {
          this.job = message.job;
          queueMicrotask(() => this.onmessage({ data: { type: 'need', at: 0, n: this.job.frames } }));
        } else if (message.type === 'chunk') {
          const writer = new WavWriter({ ...this.job.options, frames: this.job.frames, markers: this.job.markers });
          writer.write(message.channels, this.job.frames);
          queueMicrotask(() => this.onmessage({ data: { type: 'done', blob: writer.finish() } }));
        }
      }
      terminate() {}
    },
  };
});

afterEach(() => {
  delete window.puter;
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const $ = (sel) => document.querySelector(sel);
const pageButton = (text) => [...document.querySelectorAll('.io-mix-page button')].find((b) => b.textContent === text);

describe('mixdown file names', () => {
  it('names track files after the master file and keeps them unique', () => {
    const tracks = [
      { id: 'a', name: 'Vocals' },
      { id: 'b', name: 'vocals' },
      { id: 'c', name: 'Drums / Loop' },
      { id: 'd', name: '' },
    ];
    expect(mixdownTargets('Song.flac', 'flac', true, tracks).map((t) => t.fileName)).toEqual(['Song.flac', 'Song_Vocals.flac', 'Song_vocals 2.flac', 'Song_Drums _ Loop.flac', 'Song_Track.flac']);
    expect(mixdownTargets('Song.wav', 'wav', false, tracks.slice(0, 1))).toEqual([{ kind: 'track', trackId: 'a', name: 'Vocals', fileName: 'Song_Vocals.wav' }]);
  });

  it('describes the choice', () => {
    expect(describeMixdown({ master: true, tracks: new Set() })).toBe('Master only');
    expect(describeMixdown({ master: true, tracks: new Set(['a', 'b']) })).toBe('Master and 2 tracks, each as its own file');
    expect(describeMixdown({ master: false, tracks: new Set(['a']) })).toBe('1 track, each as its own file');
    expect(describeMixdown({ master: false, tracks: new Set() })).toBe('Nothing selected');
  });
});

describe('Mixdown Options page', () => {
  it('chooses the master and tracks, and refuses an empty choice', async () => {
    const app = { prefs: new Prefs(null) };
    const source = { name: 'Session_mixdown.wav', sampleRate: 48000, channelCount: 2, length: 48000, info: { bitDepth: 32 }, state: { markers: [] } };
    const tracks = [
      { id: 't1', name: 'Voice', type: 'audio', channels: 1 },
      { id: 't2', name: 'Music', type: 'audio', channels: 2 },
      { id: 'b1', name: 'FX Bus', type: 'bus', channels: 2 },
    ];
    const pending = exportFileDialog(app, source, { mode: 'mixdown', frames: 48000, mixdown: { tracks } });
    await tick(10);
    expect($('.dialog-title').textContent).toBe('Export Multitrack Mixdown');
    expect($('.io-export').textContent).toContain('Master only');
    $('[aria-label="Change mixdown options"]').click();
    expect($('.io-mix-page').hidden).toBe(false);
    expect($('.io-export').hidden).toBe(true);
    expect($('.dialog-title').textContent).toBe('Mixdown Options');
    expect($('.io-mix-page').textContent).toContain('Bus, Stereo');
    pageButton('All').click();
    $('.io-mix-page input[aria-label="Master"]').click();
    pageButton('OK').click();
    expect($('.io-export').textContent).toContain('3 tracks, each as its own file');
    // The size estimate covers every file.
    expect($('.io-size').textContent).toContain('in 3 files');
    // Nothing chosen: the dialog stays open with an explanation.
    $('[aria-label="Change mixdown options"]').click();
    pageButton('None').click();
    pageButton('OK').click();
    $('.dialog-foot .btn.primary').click();
    await tick();
    expect($('.io-error').textContent).toContain('at least one track');
    $('[aria-label="Change mixdown options"]').click();
    $('.io-mix-page input[aria-label="Music"]').click();
    $('.io-mix-page input[aria-label="Voice"]').click();
    pageButton('OK').click();
    $('.dialog-foot .btn.primary').click();
    const r = await pending;
    // Tracks come back in session order.
    expect(r.mixdown).toEqual({ master: false, tracks: ['t1', 't2'] });
  });

  it('Escape on the page goes back to the form', async () => {
    const app = { prefs: new Prefs(null) };
    const source = { name: 'S_mixdown.wav', sampleRate: 44100, channelCount: 2, length: 100, info: { bitDepth: 32 }, state: { markers: [] } };
    const pending = exportFileDialog(app, source, { mode: 'mixdown', frames: 100, mixdown: { tracks: [{ id: 'x', name: 'X', type: 'audio', channels: 2 }] } });
    await tick(10);
    $('[aria-label="Change mixdown options"]').click();
    $('.io-mix-page input[aria-label="X"]').click();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect($('.io-mix-page').hidden).toBe(true);
    expect($('.io-export').textContent).toContain('Master only');
    $('.dialog-foot .btn.primary').click();
    expect((await pending).mixdown).toEqual({ master: true, tracks: [] });
  });
});

describe('File > Export > Multitrack Mixdown', () => {
  it('writes the master and each chosen track as its own file', async () => {
    localStorage.clear();
    vi.stubGlobal('Blob', NodeBlob);
    const app = new App();
    app.syncGraph = vi.fn();
    app.notify = vi.fn();
    installCoreCommands(app);
    app.registerDocumentKind('session', { commands: installMultitrackCommands(app) });
    app.prefs.set('panLaw', 'balance');
    const stored = new Map();
    window.puter = {
      ui: { showDirectoryPicker: async () => ({ path: '/u' }) },
      auth: { isSignedIn: () => true },
      fs: {
        stat: async (path) => {
          if (stored.has(path)) return { path };
          throw { code: 'subject_does_not_exist' };
        },
        write: async (path, blob) => {
          stored.set(path, blob);
          return { path };
        },
      },
    };
    const doc = app.addDocument(new Session({ name: 'Band.asesx', sampleRate: 8000, masterChannels: 2, tracks: 2 }));
    const [t1, t2] = doc.state.tracks;
    expect(mixdownTracks(doc.state).map((t) => t.id)).toEqual([t1.id, t2.id]);
    const a = doc.addSource({ name: 'A.wav', channels: [Channel.fromSamples(new Float32Array(16).fill(0.25))] });
    const b = doc.addSource({ name: 'B.wav', channels: [Channel.fromSamples(new Float32Array(16).fill(0.5))] });
    doc.apply('Audio', addClips(doc.state, [createClip({ sourceId: a, trackId: t1.id, length: 16 }), createClip({ sourceId: b, trackId: t2.id, length: 16 })]));
    const running = app.commands.run('export.mixdownSession');
    await vi.waitFor(() => expect($('.io-export-dialog')).not.toBeNull(), { interval: 1 });
    const name = $('[aria-label="File name"]');
    name.value = 'Band.wav';
    [...document.querySelectorAll('.io-export-dialog button')].find((x) => x.textContent === 'Browse...').click();
    await vi.waitFor(() => expect($('.io-path').textContent).toBe('/u'), { interval: 1 });
    $('[aria-label="Change mixdown options"]').click();
    $(`.io-mix-page input[value="${t2.id}"]`).click();
    pageButton('OK').click();
    $('.dialog-foot button[data-value="ok"]').click();
    expect(await running).toBe(true);
    expect([...stored.keys()].sort()).toEqual(['/u/Band.wav', `/u/Band_${t2.name}.wav`]);
    const master = parseWav(await stored.get('/u/Band.wav').arrayBuffer());
    const stem = parseWav(await stored.get(`/u/Band_${t2.name}.wav`).arrayBuffer());
    // The master holds both tracks, the track file only its own audio.
    expect(master.channels[0][4]).toBeCloseTo(0.75, 3);
    expect(stem.channels[0][4]).toBeCloseTo(0.5, 3);
    expect(stem.channels[0].length).toBe(16);
  });
});
