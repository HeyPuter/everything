// Regression tests for multitrack fixes from the third review.
import { describe, it, expect, vi } from 'vitest';
import { Session } from '../src/model/session.js';
import * as S from '../src/model/session-edits.js';
import { Channel } from '../src/audio/channel.js';
import { parseWav } from '../src/audio/wav.js';

const puterFiles = vi.hoisted(() => new Map());
vi.mock('../src/storage/puter.js', async (orig) => ({
  ...(await orig()),
  sdk: () => ({}),
  isSignedIn: () => true,
  writeFile: async (path, blob) => puterFiles.set(path, new Uint8Array(await blob.arrayBuffer())),
}));

const { saveSession } = await import('../src/multitrack/storage.js');

describe('saving sessions to Puter', () => {
  it('rewrites a media file that came to hold another source after an undo', async () => {
    puterFiles.clear();
    const app = { setStatus() {}, prefs: { get: () => [], set() {} } };
    const doc = new Session({
      name: 'Song.asesx',
      sampleRate: 8000,
      tracks: 2,
      source: { type: 'puter', path: '/u/Song.asesx' },
    });
    // Two sources with one name: their media files are "Take.wav" and "Take 2.wav".
    const a = doc.addSource({
      name: 'Take.wav',
      channels: [Channel.fromSamples(new Float32Array(100).fill(0.25))],
    });
    const b = doc.addSource({
      name: 'Take.wav',
      channels: [Channel.fromSamples(new Float32Array(100).fill(-0.5))],
    });
    const t = doc.state.tracks;
    const ca = S.createClip({ trackId: t[0].id, sourceId: a, start: 0, length: 100 });
    const cb = S.createClip({ trackId: t[1].id, sourceId: b, start: 0, length: 100 });
    doc.apply('Insert', S.addClips(doc.state, [ca, cb]));
    await saveSession(app, doc);
    // Without A's clip, B is saved as "Take.wav", over A's audio.
    doc.apply('Delete', S.removeClips(doc.state, [ca.id]));
    await saveSession(app, doc);
    // A comes back: its file must hold its own audio again.
    doc.history.undo();
    await saveSession(app, doc);
    const saved = JSON.parse(new TextDecoder().decode(puterFiles.get('/u/Song.asesx')));
    const first = (id) =>
      parseWav(puterFiles.get(`/u/${saved.sources.find((s) => s.id === id).file}`).buffer)
        .channels[0][0];
    expect(first(a)).toBeCloseTo(0.25);
    expect(first(b)).toBeCloseTo(-0.5);
    // Nothing changed since: the next save writes no media.
    const writes = puterFiles.size;
    puterFiles.clear();
    await saveSession(app, doc);
    expect([...puterFiles.keys()]).toEqual(['/u/Song.asesx']);
    expect(writes).toBe(3);
  });
});
