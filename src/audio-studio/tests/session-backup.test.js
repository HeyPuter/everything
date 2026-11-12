import { describe, it, expect, vi } from 'vitest';
import { MemDir } from './helpers/mem-opfs.js';
import { SessionBackupStore, installSessionBackup, backupsToPrune, backupsToOffer, validBackup, BACKUP_DIR } from '../src/storage/session-backup.js';
import { Session } from '../src/model/session.js';
import * as S from '../src/model/session-edits.js';
import { Channel } from '../src/audio/channel.js';
import { Emitter } from '../src/lib/emitter.js';
import { DEFAULTS } from '../src/lib/prefs.js';
import { CATEGORIES } from '../src/ui/preferences.js';
import { MENUS } from '../src/ui/menus.js';

function fakeApp(prefs = {}) {
  const app = new Emitter();
  app.documents = [];
  const values = { ...DEFAULTS, ...prefs };
  app.prefs = Object.assign(new Emitter(), { get: (k) => values[k], set: (k, v) => ((values[k] = v), app.prefs.emit('change', k)) });
  app.notify = vi.fn();
  app.uniqueName = (n) => n;
  app.addDocument = (d) => app.documents.push(d);
  return app;
}

function sessionWithClip(frames = 4800) {
  const doc = new Session({ name: 'Song.asesx', sampleRate: 48000, tracks: 1 });
  const ch = [Channel.fromSamples(new Float32Array(frames).fill(0.25)), Channel.fromSamples(new Float32Array(frames).fill(-0.25))];
  const id = doc.addSource({ name: 'Take.wav', channels: ch });
  const clip = S.createClip({ trackId: doc.state.tracks[0].id, sourceId: id, start: 100, length: frames });
  doc.apply('Add Clip', S.addClips(doc.state, [clip]));
  return doc;
}

describe('session backup planning', () => {
  const m = (key, group, savedAt, o = {}) => ({ version: 1, key, group, tab: group.split('-')[0], savedAt, text: '{}', media: [], dirty: true, ...o });

  it('keeps the newest backups of each session and drops very old ones', () => {
    const now = 100 * 24 * 3600 * 1000;
    const list = [m('a1', 't1-s1', now - 3), m('a2', 't1-s1', now - 2), m('a3', 't1-s1', now - 1), m('b1', 't1-s2', 0)];
    expect(backupsToPrune(list, 2, now).map((x) => x.key).sort()).toEqual(['a1', 'b1']);
  });

  it('offers the newest backup of sessions from ended tabs that had unsaved changes', () => {
    const list = [m('a1', 't1-s1', 1), m('a2', 't1-s1', 2), m('b1', 't2-s1', 5), m('c1', 't3-s1', 3, { dirty: false }), m('d1', 't4-s1', 4, { offered: true })];
    expect(backupsToOffer(list, new Set(['t2'])).map((x) => x.key)).toEqual(['a2']);
  });
});

describe('session backups (mock OPFS)', () => {
  it('backs up changed sessions, shares unchanged media and restores into a new session', async () => {
    const root = new MemDir();
    const store = new SessionBackupStore(async () => root);
    const app = fakeApp();
    let t = Date.now();
    const ctl = installSessionBackup(app, { store, tab: 'tab1', now: () => t++ });
    const doc = sessionWithClip();
    app.documents.push(doc);
    await ctl.run();
    let list = await store.list();
    expect(list).toHaveLength(1);
    expect(validBackup(list[0])).toBe(true);
    expect(list[0]).toMatchObject({ name: 'Song.asesx', dirty: true, tab: 'tab1' });
    // Nothing changed: no new backup.
    await ctl.run();
    expect(await store.list()).toHaveLength(1);
    // A mix change makes a second backup that reuses the same media file.
    doc.apply('Volume', S.updateTrack(doc.state, doc.state.tracks[0].id, { volume: -6 }));
    await ctl.run();
    list = await store.list();
    expect(list).toHaveLength(2);
    expect(new Set(list.map((x) => x.media[0].key)).size).toBe(1);
    const media = (await root.getDirectoryHandle(BACKUP_DIR)).children.get('media');
    expect(media.children.size).toBe(1);
    ctl.destroy();

    // The next launch offers the newest backup and restores it.
    const app2 = fakeApp();
    const ctl2 = installSessionBackup(app2, { store, tab: 'tab2' });
    const offer = await ctl2.check();
    expect(offer).toHaveLength(1);
    const restored = await ctl2.restore(offer[0]);
    expect(restored.kind).toBe('session');
    expect(restored.dirty).toBe(true);
    expect(S.findTrack(restored.state, restored.state.tracks[0].id).volume).toBe(-6);
    const clip = restored.state.clips[0];
    const src = restored.pool.get(clip.sourceId);
    expect(src.channels[0].length).toBe(4800);
    const buf = new Float32Array(4);
    src.channels[1].read(0, buf, 0, 4);
    expect(buf[0]).toBeCloseTo(-0.25);
    await ctl2.markOffered(offer);
    expect(await ctl2.check()).toEqual([]);
    ctl2.destroy();
  });

  it('writes the media again after a failed write instead of keeping an empty file', async () => {
    const root = new MemDir();
    const store = new SessionBackupStore(async () => root);
    const app = fakeApp();
    let t = Date.now();
    const ctl = installSessionBackup(app, { store, tab: 'tab1', now: () => t++ });
    const doc = sessionWithClip();
    app.documents.push(doc);
    // The first media write runs out of storage space.
    const write = store.writeMedia.bind(store);
    let fail = true;
    store.writeMedia = async (key, rate, channels) => {
      if (!fail) return write(key, rate, channels);
      const media = await (await root.getDirectoryHandle(BACKUP_DIR, { create: true })).getDirectoryHandle('media', { create: true });
      const file = await media.getFileHandle(`${key}.wav`, { create: true });
      file.createWritable = async () => ({ write: async () => Promise.reject(Object.assign(new Error('Quota'), { name: 'QuotaExceededError' })), close: async () => {}, abort: async () => {} });
      return write(key, rate, channels);
    };
    await ctl.run();
    expect(app.notify).toHaveBeenCalledTimes(1);
    expect(await store.list()).toHaveLength(0);
    // Space is available again: the next backup must hold the audio.
    fail = false;
    doc.apply('Volume', S.updateTrack(doc.state, doc.state.tracks[0].id, { volume: -3 }));
    await ctl.run();
    const [m] = await store.list();
    expect((await store.readMedia(m.media[0].key)).size).toBe(44 + 4800 * 2 * 4);
    const restored = await ctl.restore(m);
    expect(restored.pool.get(restored.state.clips[0].sourceId).channels[0].length).toBe(4800);
    ctl.destroy();
  });

  it('keeps at most the configured number of backups and deletes unused media', async () => {
    const root = new MemDir();
    const store = new SessionBackupStore(async () => root);
    const app = fakeApp({ sessionBackupMax: 2 });
    let t = Date.now();
    const ctl = installSessionBackup(app, { store, tab: 'tab1', now: () => t++ });
    const doc = sessionWithClip(100);
    app.documents.push(doc);
    for (let i = 0; i < 4; i++) {
      // Replace the source audio each time so each backup has its own media.
      const id = doc.state.clips[0].sourceId;
      doc.updateSource(id, { channels: [Channel.fromSamples(new Float32Array(100).fill(i / 10))] });
      doc.apply('Volume', S.updateTrack(doc.state, doc.state.tracks[0].id, { volume: -i }));
      await ctl.run();
    }
    const list = await store.list();
    expect(list).toHaveLength(2);
    const media = (await root.getDirectoryHandle(BACKUP_DIR)).children.get('media');
    expect(media.children.size).toBe(2);
    ctl.destroy();
  });

  it('skips sessions that were never edited and saved sessions are not offered', async () => {
    const root = new MemDir();
    const store = new SessionBackupStore(async () => root);
    const app = fakeApp();
    let t = Date.now();
    const ctl = installSessionBackup(app, { store, tab: 'tab1', now: () => t++ });
    const fresh = new Session({ name: 'Empty.asesx' });
    app.documents.push(fresh);
    await ctl.run();
    expect(await store.list()).toHaveLength(0);
    const doc = sessionWithClip(10);
    doc.markSaved();
    doc.apply('Volume', S.updateTrack(doc.state, doc.state.tracks[0].id, { volume: -1 }));
    app.documents.push(doc);
    await ctl.run();
    doc.apply('Volume', S.updateTrack(doc.state, doc.state.tracks[0].id, { volume: -2 }));
    doc.markSaved();
    await ctl.run();
    const list = await store.list();
    expect(list.map((m) => m.dirty).sort()).toEqual([false, true]);
    const ctl2 = installSessionBackup(fakeApp(), { store, tab: 'tab2' });
    expect(await ctl2.check()).toEqual([]);
    ctl.destroy();
    ctl2.destroy();
  });
});

describe('session backup settings', () => {
  it('does not offer sessions saved after their last backup or closed without saving', async () => {
    const root = new MemDir();
    const store = new SessionBackupStore(async () => root);
    const app = fakeApp();
    app.addDocument = (d) => {
      app.documents.push(d);
      d.on('change', (e) => app.emit('doc-change', d, e));
      app.emit('documents');
    };
    let t = Date.now();
    const ctl = installSessionBackup(app, { store, tab: 'tab1', now: () => t++ });
    const saved = sessionWithClip(10);
    const closed = sessionWithClip(10);
    app.addDocument(saved);
    app.addDocument(closed);
    await ctl.run();
    expect((await store.list()).map((m) => m.dirty)).toEqual([true, true]);
    // Saved with no edit since the backup, and closed with "Don't Save".
    saved.markSaved();
    app.documents.splice(app.documents.indexOf(closed), 1);
    app.emit('documents');
    await ctl.run();
    const ctl2 = installSessionBackup(fakeApp(), { store, tab: 'tab2' });
    expect(await ctl2.check()).toEqual([]);
    // Both stay available in File > Restore Session Backup.
    expect(await ctl2.list()).toHaveLength(2);
    ctl.destroy();
    ctl2.destroy();
  });

  it('does not delete media another tab has written for a backup it is still finishing', async () => {
    const root = new MemDir();
    const store1 = new SessionBackupStore(async () => root);
    const store2 = new SessionBackupStore(async () => root);
    let t = Date.now();
    const app1 = fakeApp();
    const app2 = fakeApp();
    const ctl1 = installSessionBackup(app1, { store: store1, tab: 'tab1', now: () => t++ });
    const ctl2 = installSessionBackup(app2, { store: store2, tab: 'tab2', now: () => t++ });
    const doc1 = sessionWithClip(100);
    const doc2 = sessionWithClip(200);
    app1.documents.push(doc1);
    app2.documents.push(doc2);
    // Tab 2 has written its media and is about to write the manifest when tab 1 backs up.
    let release;
    const gate = new Promise((r) => (release = r));
    const writeManifest = store2.writeManifest.bind(store2);
    store2.writeManifest = async (m) => {
      await gate;
      return writeManifest(m);
    };
    const pending = ctl2.run();
    await new Promise((r) => setTimeout(r, 20));
    await ctl1.run();
    release();
    await pending;
    const m2 = (await store1.list()).find((m) => m.tab === 'tab2');
    expect(await store1.hasMedia(m2.media[0].key)).toBe(true);
    const restored = await ctl1.restore(m2);
    expect(restored.pool.get(restored.state.clips[0].sourceId).channels[0].length).toBe(200);
    // Media no backup uses are still removed once they are old.
    const media = (await root.getDirectoryHandle(BACKUP_DIR)).children.get('media');
    await store1.writeMedia('tab3-x-1', 48000, [Channel.fromSamples(new Float32Array(10))]);
    media.children.get('tab3-x-1.wav').lastModified = Date.now() - 3600 * 1000;
    await ctl1.run();
    doc1.apply('Volume', S.updateTrack(doc1.state, doc1.state.tracks[0].id, { volume: -2 }));
    await ctl1.run();
    expect(media.children.has('tab3-x-1.wav')).toBe(false);
    ctl1.destroy();
    ctl2.destroy();
  });

  it('has defaults, an Auto Save section and a File menu command', () => {
    expect(DEFAULTS).toMatchObject({ sessionBackup: true, sessionBackupInterval: 3, sessionBackupMax: 10 });
    const page = CATEGORIES.find((c) => c.id === 'autoSave');
    const sec = page.sections.find((s) => s.title === 'Multitrack Session Backups');
    expect(sec.items.filter((i) => i.key).map((i) => i.key)).toEqual(['sessionBackup', 'sessionBackupInterval', 'sessionBackupMax']);
    expect(MENUS[0].submenu).toContain('file.restoreBackup');
  });
});
