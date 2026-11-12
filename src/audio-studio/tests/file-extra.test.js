import { describe, it, expect, vi, afterEach } from 'vitest';

// Encoding runs in a worker in the app; here it resolves at once.
vi.mock('../src/export/export.js', () => ({
  exportAudio: async () => new Blob([new Uint8Array(64)]),
  isCancelled: (err) => err?.name === 'AbortError' || err?.message === 'Cancelled',
  cancelledError: () => Object.assign(new Error('Cancelled'), { name: 'AbortError' }),
}));
import { decodeRaw, rangeExportNames, unusedAudioDocs, sessionOnlyMedia } from '../src/commands/file-extra.js';

describe('raw data import', () => {
  it('decodes interleaved 16-bit little- and big-endian samples', () => {
    const le = new Uint8Array([0x00, 0x40, 0x00, 0xc0, 0xff, 0x7f, 0x00, 0x80]);
    const [l, r] = decodeRaw(le, { encoding: 's16', channels: 2 });
    expect(Array.from(l)).toEqual([0.5, 32767 / 32768]);
    expect(Array.from(r)).toEqual([-0.5, -1]);
    const be = new Uint8Array([0x40, 0x00, 0xc0, 0x00]);
    expect(Array.from(decodeRaw(be, { encoding: 's16', channels: 1, bigEndian: true })[0])).toEqual([0.5, -0.5]);
  });

  it('decodes 24-bit, unsigned 8-bit and float, honoring the byte offset', () => {
    expect(Array.from(decodeRaw(new Uint8Array([0, 0, 0x40, 0, 0, 0xc0]), { encoding: 's24', channels: 1 })[0])).toEqual([0.5, -0.5]);
    expect(Array.from(decodeRaw(new Uint8Array([9, 9, 192, 64]), { encoding: 'u8', channels: 1, offset: 2 })[0])).toEqual([0.5, -0.5]);
    const f = new Float32Array([0.25, -0.75]);
    expect(Array.from(decodeRaw(new Uint8Array(f.buffer), { encoding: 'f32', channels: 1 })[0])).toEqual([0.25, -0.75]);
  });

  it('decodes companded samples symmetrically and drops partial frames', () => {
    const [mu] = decodeRaw(new Uint8Array([0x00, 0x80, 0xff, 0x7f]), { encoding: 'ulaw', channels: 1 });
    expect(mu[0]).toBeCloseTo(-mu[1], 6);
    expect(mu[0]).toBeLessThan(-0.95);
    expect(Math.abs(mu[2])).toBeLessThan(0.001);
    const [a] = decodeRaw(new Uint8Array([0xd5, 0x55]), { encoding: 'alaw', channels: 1 });
    expect(a[0]).toBeCloseTo(-a[1], 6);
    expect(decodeRaw(new Uint8Array(5), { encoding: 's16', channels: 2 })[0]).toHaveLength(1);
  });
});

describe('range marker export names', () => {
  const markers = [{ name: 'Intro' }, { name: 'Intro' }, { name: 'a/b' }, { name: '' }];
  it('uses marker names, kept unique and safe', () => {
    const names = rangeExportNames(markers, { naming: 'name', format: 'wav' });
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(4);
    expect(names[0]).toBe('Intro.wav');
    expect(names[1]).toBe('Intro 2.wav');
    expect(names[2]).not.toContain('/');
    expect(names[3]).toBe('Range 4.wav');
  });
  it('numbers files after a prefix', () => {
    expect(rangeExportNames(markers.slice(0, 2), { naming: 'prefix', prefix: 'Take', format: 'flac' })).toEqual(['Take 01.flac', 'Take 02.flac']);
  });
});

describe('media usage', () => {
  const a = { id: 'a', kind: 'audio' };
  const b = { id: 'b', kind: 'audio' };
  const c = { id: 'c', kind: 'audio' };
  const session = (id, used) => ({
    id,
    kind: 'session',
    state: { clips: used.map((d) => ({ sourceId: `src-${d}` })) },
    pool: new Map([a, b, c].map((d) => [`src-${d.id}`, { id: `src-${d.id}`, docId: d.id }])),
  });
  it('finds audio files no session uses', () => {
    const s1 = session('s1', ['a']);
    expect(unusedAudioDocs([a, b, c, s1])).toEqual([b, c]);
  });
  it('finds media only one session uses', () => {
    const s1 = session('s1', ['a', 'b']);
    const s2 = session('s2', ['b']);
    expect(sessionOnlyMedia([a, b, c, s1, s2], s1)).toEqual([a]);
  });
});

describe('export audio within range markers', () => {
  afterEach(() => {
    delete window.puter;
    document.querySelectorAll('.dialog-backdrop').forEach((d) => d.remove());
  });

  it('does not overwrite a file of the same name in the Puter folder', async () => {
    HTMLCanvasElement.prototype.getContext = () => null;
    globalThis.ResizeObserver ??= class {
      observe() {}
      disconnect() {}
    };
    localStorage.clear();
    const { App } = await import('../src/app.js');
    const { FEATURES } = await import('../src/features.js');
    const { AudioFile } = await import('../src/model/audio-file.js');
    const { createMarker } = await import('../src/model/markers.js');
    const app = new App();
    for (const install of FEATURES) install(app);
    app.syncGraph = () => {};
    const existing = new Set(['/u/AudioStudio/Verse.wav']);
    const write = vi.fn(async () => ({}));
    const notFound = Object.assign(new Error('missing'), { code: 'subject_does_not_exist' });
    window.puter = {
      auth: { isSignedIn: () => true, getUser: async () => ({ username: 'u' }) },
      fs: { write, stat: async (p) => (existing.has(p) ? {} : Promise.reject(notFound)) },
    };
    const doc = AudioFile.blank({ name: 'Song.wav', sampleRate: 8000, channels: 1, seconds: 1 });
    const verse = createMarker({ start: 0, duration: 4000, name: 'Verse', type: 'range' });
    doc.apply('Markers', { ...doc.state, markers: [verse] });
    app.addDocument(doc);
    const running = app.commands.run('file.exportRanges');
    await new Promise((r) => setTimeout(r, 20));
    const dialog = [...document.querySelectorAll('.dialog')].pop();
    const loc = dialog.querySelector('select[aria-label="Location"]');
    loc.value = 'puter';
    [...dialog.querySelectorAll('.dialog-foot .btn')].find((b) => b.textContent === 'Export').click();
    await running;
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).toBe('/u/AudioStudio/Verse 2.wav');
  });
});
