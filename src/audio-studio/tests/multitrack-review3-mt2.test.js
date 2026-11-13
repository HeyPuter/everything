// Regression tests for multitrack fixes from the third review's second pass.
import { describe, it, expect } from 'vitest';
import { Session } from '../src/model/session.js';
import * as S from '../src/model/session-edits.js';
import { Channel } from '../src/audio/channel.js';

async function appWithSession() {
  HTMLCanvasElement.prototype.getContext = () => null;
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
  };
  localStorage.clear();
  const { App } = await import('../src/app.js');
  const { installCore } = await import('../src/features/core.js');
  const { installMultitrack } = await import('../src/features/multitrack.js');
  const app = new App();
  installCore(app);
  installMultitrack(app);
  app.syncGraph = () => {};
  const doc = new Session({ name: 'Test.asesx', sampleRate: 8000, tracks: 2 });
  app.addDocument(doc);
  return { app, doc };
}

const dc = (doc, v, n = 8000) =>
  doc.addSource({
    name: `dc${v}.wav`,
    channels: [Channel.fromSamples(new Float32Array(n).fill(v))],
  });

// What the Track Visibility commands do.
const hide = (doc, id, hidden) => doc.amendView((st) => S.updateTrack(st, id, { hidden }));

describe('clips on hidden tracks', () => {
  async function setup() {
    const { app, doc } = await appWithSession();
    const [t1, t2] = doc.state.tracks.map((t) => t.id);
    const src = dc(doc, 0.5);
    const a = S.createClip({ trackId: t1, sourceId: src, start: 0, length: 4000, name: 'A' });
    const b = S.createClip({ trackId: t2, sourceId: src, start: 2000, length: 4000, name: 'B' });
    doc.apply('Setup', S.addClips(doc.state, [a, b]));
    return { app, doc, t1, t2, a, b };
  }

  it('are left out of Select All, so Delete keeps them', async () => {
    const { app, doc, t2, a, b } = await setup();
    hide(doc, t2, true);
    await app.commands.run('edit.selectAll');
    expect([...doc.selectedClips]).toEqual([a.id]);
    await app.commands.run('edit.delete');
    expect(doc.state.clips.map((c) => c.id)).toEqual([b.id]);
  });

  it('are left out of the selection commands that pick clips by time or type', async () => {
    const { app, doc, t2, a } = await setup();
    hide(doc, t2, true);
    doc.setCursor(3000);
    await app.commands.run('edit.selectClipsToStart');
    expect([...doc.selectedClips]).toEqual([a.id]);
    await app.commands.run('edit.selectClipsToEnd');
    expect([...doc.selectedClips]).toEqual([a.id]);
    // The hidden track's own clip commands do nothing while it is selected.
    doc.selectClips([]);
    doc.selectTrack(t2);
    expect(app.commands.isEnabled('edit.selectAllClipsTrack')).toBe(false);
    await app.commands.run('clip.split');
    expect(doc.state.clips.length).toBe(2);
  });

  it('leave the selection when their track is hidden, unless a shown clip groups them', async () => {
    const { app, doc, t1, t2, a, b } = await setup();
    doc.selectClips([a.id, b.id]);
    hide(doc, t2, true);
    expect([...doc.selectedClips]).toEqual([a.id]);
    await app.commands.run('edit.delete');
    expect(doc.state.clips.map((c) => c.id)).toEqual([b.id]);
    // A group spanning a hidden track still selects (and moves) as a whole.
    doc.history.undo();
    hide(doc, t2, false);
    doc.apply('Group', S.groupClips(doc.state, [a.id, b.id]));
    hide(doc, t2, true);
    doc.selectClips([a.id]);
    expect(new Set(doc.selectedClips)).toEqual(new Set([a.id, b.id]));
    hide(doc, t1, true);
    expect(doc.selectedClips.size).toBe(0);
  });
});
