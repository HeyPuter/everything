import { it, expect, vi, afterEach } from 'vitest';
import { createAvatar, syncAvatarTo, relipAvatar, revoiceAvatar } from '../src/ui/avatar-actions.js';
import { avatarsTab } from '../src/ui/panels/avatars.js';
import { EditorStore } from '../src/model/store.js';
import { createActions } from '../src/ui/actions.js';
import { makeClip, makeTrack, normalizeAsset, normalizeProject } from '../src/model/project.js';
import { findClip } from '../src/model/timeline.js';
import { encodeLips } from '../src/media/lipsync.js';
import { setPref } from '../src/ui/prefs.js';
import { fixture, clip } from './helpers.js';
const tabs = [];
afterEach(() => { tabs.splice(0).forEach(t => t.dispose()); document.querySelector('.toasts')?.replaceChildren(); document.body.replaceChildren(); vi.restoreAllMocks(); delete globalThis.puter; });
const lips = n => encodeLips({ rate: 50, frames: 2, open: [n, n], wide: [0, 0], round: [0, 0], fric: [0, 0], beats: [] });
const modes = ['create', 'script', 'sync', 'relip', 'revoice'];
function setup(mode) {
  const p = fixture(), voice = clip('audio', 0, 2), other = clip('audio', 3, 2, { assetId: 'other' });
  voice.group = 'voice-group'; p.assets.aud.hash = 'original'; p.assets.other = normalizeAsset({ ...p.assets.aud, id: 'other' });
  const avatar = makeClip('avatar', { group: 'voice-group', duration: 2000000, avatar: { voiceAsset: 'aud', lips: lips(.1), script: 'Hello' } });
  p.tracks.push(makeTrack('audio', { clips: [voice, other] }), makeTrack('video', { clips: [avatar] }));
  const store = new EditorStore(p), work = { hold: true, finish: null, fail: null, signal: null, id: null };
  let seq = 0;
  const library = { backend: { kind: 'puter' }, importFile: vi.fn(async () => normalizeAsset({ id: `fresh${++seq}`, kind: 'audio', duration: 2000000, hash: 'generated', hasAudio: true })) };
  const analyze = vi.fn(async (asset, { signal }) => {
    work.signal = signal; work.id = asset.id;
    const result = lips(asset.hash === 'relinked' ? .9 : .3);
    if (work.hold) await new Promise((r, j) => { work.finish = r; work.fail = j; });
    return result;
  });
  const ctx = { store, library, avatarServices: { synthesize: async () => new Blob(['speech']), analyze } }; ctx.actions = createActions(ctx);
  const onCancel = vi.fn();
  const run = () => mode === 'create' ? createAvatar(ctx, { voiceClipId: voice.id }, { onCancel })
    : mode === 'script' ? createAvatar(ctx, { script: 'Hello' }, { onCancel })
    : mode === 'sync' ? syncAvatarTo(ctx, avatar.id, other.id, { onCancel })
    : mode === 'relip' ? relipAvatar(ctx, avatar.id, { onCancel })
    : revoiceAvatar(ctx, avatar.id, { script: 'New words' }, { onCancel });
  return { ctx, store, work, run, onCancel, voice, avatar, analyze };
}
async function start(x) {
  const pending = x.run().catch(e => e); await vi.waitFor(() => expect(x.work.finish).toBeTypeOf('function')); return { pending };
}
for (const mode of modes) {
  it.each(['relink', 'delete'])(`${mode} discards lip analysis after media %s and supports retry`, async change => {
    const x = setup(mode), { pending } = await start(x), id = x.work.id;
    const original = structuredClone(x.store.project.assets[id]);
    x.store.update('Change voice file', p => { if (change === 'delete') delete p.assets[id]; else p.assets[id].hash = 'relinked'; });
    const before = JSON.stringify(x.store.projectForSave()), history = x.store.history.undoStack.length, aborted = x.work.signal.aborted;
    x.work.finish(); const result = await pending;
    expect(aborted).toBe(true); expect(result.name).toBe('AbortError'); expect(JSON.stringify(x.store.projectForSave())).toBe(before); expect(x.store.history.undoStack).toHaveLength(history); expect(x.onCancel).toHaveBeenCalledOnce();
    if (change === 'delete') x.store.update('Restore media', p => { p.assets[id] = original; });
    x.work.hold = false; const fresh = await x.run(); expect(fresh).toBeTruthy();
    const made = findClip(x.store.project, fresh.id || x.avatar.id).clip, saved = structuredClone(made);
    x.store.undo(); expect(findClip(x.store.project, made.id)?.clip).not.toEqual(saved);
    x.store.redo(); expect(findClip(normalizeProject(x.store.projectForSave()), made.id).clip).toEqual(saved);
  });
  it(`${mode} keeps compatible placement, timing, volume, and name edits`, async () => {
    const x = setup(mode), { pending } = await start(x);
    x.store.update('Compatible edits', p => {
      const c = findClip(p, x.voice.id).clip; c.start = 1000000; c.in = 200000; c.duration = 1000000; c.speed = 2; c.volume = .4;
      p.name = 'Renamed'; p.assets[x.work.id].name = 'Voice label'; findClip(p, x.avatar.id).clip.avatar.bgColor = '#abcdef';
    });
    x.work.finish(); const result = await pending; expect(result).toBeTruthy(); expect(result.name).not.toBe('AbortError'); expect(x.onCancel).not.toHaveBeenCalled();
    if (mode === 'create') { expect(result.start).toBe(1000000); expect(result.duration).toBe(1000000); }
    if (mode !== 'revoice') expect(findClip(x.store.project, x.voice.id).clip.volume).toBe(.4);
  });
}
it.each(['create', 'relip'])('suppresses a failed obsolete %s analysis after relinking', async mode => {
  const x = setup(mode), { pending } = await start(x);
  x.store.update('Relink', p => { p.assets[x.work.id].hash = 'relinked'; });
  x.work.fail(new Error('Obsolete file failure')); expect(await pending).toMatchObject({ name: 'AbortError' });
});
it('releases the creation panel immediately after relinking its voice', async () => {
  const x = setup('create'); setPref('avatar', { source: 'clip' }); globalThis.puter = { ai: {} };
  const tab = avatarsTab(x.ctx); tabs.push(tab); document.body.append(tab.el);
  tab.el.querySelector('#avatar-clip').value = x.voice.id;
  const add = tab.el.querySelector('.avatar-add'); add.click(); await vi.waitFor(() => expect(x.work.finish).toBeTypeOf('function'));
  x.store.update('Relink', p => { p.assets.aud.hash = 'relinked'; });
  const idle = !add.disabled, status = tab.el.querySelector('.tts-status').textContent;
  x.work.finish(); await new Promise(r => setTimeout(r, 0));
  expect(idle).toBe(true); expect(status).toMatch(/cancelled.*source audio changed/i);
  expect(x.store.project.tracks.flatMap(t => t.clips).filter(c => c.type === 'avatar')).toHaveLength(1);
});
