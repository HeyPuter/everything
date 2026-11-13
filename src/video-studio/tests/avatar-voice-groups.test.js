import { afterEach, expect, it, vi } from 'vitest';
import { createProject, makeClip, makeTrack, normalizeAsset } from '../src/model/project.js';
import { EditorStore } from '../src/model/store.js';
import { findClip, ungroupClips } from '../src/model/timeline.js';
import { createActions } from '../src/ui/actions.js';
import { createInspector } from '../src/ui/inspector/index.js';
import { createAvatar, revoiceAvatar, syncAvatarTo } from '../src/ui/avatar-actions.js';
import { voiceTimeAt } from '../src/engine/scene.js';
import { encodeLips } from '../src/media/lipsync.js';

const lips = encodeLips({ rate: 50, frames: 2, open: [.2, .3], wide: [0, 0], round: [0, 0], fric: [0, 0], beats: [] });
const inspectors = [];
afterEach(() => {
  for (const inspector of inspectors.splice(0)) inspector.dispose();
  delete globalThis.puter;
  document.body.replaceChildren();
});
function setup({ group = 'own', otherGroup = 'other', otherLocked = false, ownStart = 0, otherStart = 0 } = {}) {
  const p = createProject();
  const avatar = makeClip('avatar', { start: 0, duration: 2e6, group, avatar: { script: 'Initial', voiceAsset: 'initial', lips } });
  const own = makeClip('audio', { assetId: 'initial', start: ownStart, duration: 2e6, group });
  const other = makeClip('audio', { assetId: 'initial', start: otherStart, duration: 2e6, group: otherGroup });
  const ownTrack = makeTrack('audio', { clips: [own] });
  const otherTrack = makeTrack('audio', { clips: [other], locked: otherLocked });
  p.tracks.push(makeTrack('video', { clips: [avatar] }), ownTrack, otherTrack);
  p.assets.initial = normalizeAsset({ id: 'initial', kind: 'audio', duration: 2e6, hasAudio: true });
  const store = new EditorStore(p);
  store.select(avatar.id);
  const synthesize = vi.fn(async () => new Blob(['new voice']));
  const ctx = { store, library: { backend: { kind: 'puter' }, importFile: vi.fn(async file => normalizeAsset({ id: 'new', name: file.name, kind: 'audio', duration: 1e6, hasAudio: true })) }, avatarServices: { synthesize, analyze: vi.fn(async () => lips) } };
  ctx.actions = createActions(ctx);
  globalThis.puter = { ai: {} };
  return { ctx, store, avatar, own, other, ownTrack, otherTrack, synthesize };
}
const clip = (e, id) => findClip(e.store.project, id)?.clip;
const speak = e => revoiceAvatar(e.ctx, e.avatar.id, { script: 'New voice' });
function inspectorSpeak(e) {
  const inspector = createInspector(e.ctx);
  inspectors.push(inspector);
  document.body.append(inspector.el);
  inspector.showTab('avatar');
  const field = inspector.el.querySelector('.avatar-script');
  field.value = 'New voice';
  field.dispatchEvent(new Event('input'));
  const button = [...inspector.el.querySelectorAll('button')].find(b => b.textContent === 'Speak again');
  button.click();
  return button;
}

it.each([
  ['another group', {}],
  ['ungrouped audio beside a grouped avatar', { otherGroup: null }],
  ['grouped audio beside an ungrouped avatar', { group: null }],
  ['a locked unrelated group', { otherLocked: true }],
])('inspector revoice preserves %s and undo restores only its voice edit', async (_, options) => {
  const e = setup(options);
  const originalAvatar = structuredClone(e.avatar);
  const button = inspectorSpeak(e);
  await vi.waitFor(() => expect(clip(e, e.avatar.id).avatar.script).toBe('New voice'));
  expect(clip(e, e.other.id)).toEqual(e.other);
  expect(clip(e, e.own.id)).toBeUndefined();
  const av = clip(e, e.avatar.id);
  const fresh = e.store.project.tracks.flatMap(t => t.clips).find(c => c.assetId === 'new');
  expect(fresh).toMatchObject({ group: av.group, start: av.start, duration: 1e6 });
  expect(av.duration).toBe(1.4e6);
  expect(button.disabled).toBe(false);
  expect(e.synthesize).toHaveBeenCalledTimes(1);
  e.store.undo();
  expect(clip(e, e.avatar.id)).toEqual(originalAvatar);
  expect(clip(e, e.own.id)).toEqual(e.own);
  expect(clip(e, e.other.id)).toEqual(e.other);
});

it('replaces all same-asset group members even after moving or splitting the voice', async () => {
  const e = setup({ ownStart: 500000, otherGroup: 'own', otherStart: 1500000 });
  await speak(e);
  expect(clip(e, e.own.id)).toBeUndefined();
  expect(clip(e, e.other.id)).toBeUndefined();
  expect(e.store.project.tracks.flatMap(t => t.clips).filter(c => c.type === 'audio')).toHaveLength(1);
});

it('preserves another asset within the avatar group', async () => {
  const e = setup({ otherGroup: 'own' });
  e.store.update('Different source', p => { findClip(p, e.other.id).clip.assetId = 'music'; });
  await speak(e);
  expect(clip(e, e.other.id).assetId).toBe('music');
});

it.each([0, 999])('retains legacy ungrouped voice matching at offset %i microseconds', async offset => {
  const e = setup({ group: null, otherGroup: null, ownStart: offset, otherStart: 1000 });
  await speak(e);
  expect(clip(e, e.own.id)).toBeUndefined();
  expect(clip(e, e.other.id)).toEqual(e.other);
  expect(clip(e, e.avatar.id).group).toBeTruthy();
});

it('revoices normally after the user ungroups the avatar and voice', async () => {
  const e = setup();
  e.store.update('Ungroup', p => ungroupClips(p, [e.avatar.id]));
  await speak(e);
  expect(clip(e, e.own.id)).toBeUndefined();
  expect(clip(e, e.other.id)).toEqual(e.other);
});

it('rejects an actually linked locked voice before requesting speech', async () => {
  const e = setup({ otherGroup: 'own', otherStart: 1500000, otherLocked: true });
  await expect(speak(e)).rejects.toThrow(/Unlock/);
  expect(e.synthesize).not.toHaveBeenCalled();
  expect(clip(e, e.own.id)).toEqual(e.own);
});

it.each(['lock', 'delete', 'move'])('does not cancel revoice when unrelated grouped audio changes: %s', async change => {
  const e = setup();
  let release;
  e.synthesize.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const result = speak(e);
  e.store.update('Unrelated edit', p => {
    const f = findClip(p, e.other.id);
    if (change === 'lock') f.track.locked = true;
    if (change === 'delete') f.track.clips = [];
    if (change === 'move') f.clip.start = 4e6;
  });
  const expected = structuredClone(clip(e, e.other.id));
  release(new Blob(['voice']));
  await expect(result).resolves.toBe(true);
  expect(clip(e, e.other.id)).toEqual(expected);
  e.store.undo();
  expect(clip(e, e.other.id)).toEqual(expected);
});

it('cancels pending revoice when its own voice leaves the group', async () => {
  const e = setup();
  let release;
  e.synthesize.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const result = speak(e);
  e.store.update('Regroup voice', p => { findClip(p, e.own.id).clip.group = 'different'; });
  release(new Blob(['voice']));
  await expect(result).rejects.toMatchObject({ name: 'AbortError' });
  expect(e.ctx.library.importFile).not.toHaveBeenCalled();
  expect(clip(e, e.own.id).group).toBe('different');
});

it('preserves pre-existing grouped source audio after creating and revoicing an avatar', async () => {
  const e = setup();
  const made = await createAvatar(e.ctx, { voiceClipId: e.other.id });
  expect(made.group).toBeFalsy();
  await revoiceAvatar(e.ctx, made.id, { script: 'New voice' });
  expect(clip(e, e.other.id)).toEqual(e.other);
  expect(clip(e, e.own.id)).toEqual(e.own);
});

it('Use clip follows audible audio across groups but does not grant replacement ownership', async () => {
  const e = setup();
  e.store.update('Choose another asset', p => {
    p.assets.other = normalizeAsset({ id: 'other', kind: 'audio', duration: 2e6, hasAudio: true });
    findClip(p, e.other.id).clip.assetId = 'other';
    findClip(p, e.other.id).clip.in = 250000;
  });
  await syncAvatarTo(e.ctx, e.avatar.id, e.other.id);
  expect(voiceTimeAt(e.store.project, clip(e, e.avatar.id).avatar, 500000)).toBe(.75);
  const source = structuredClone(clip(e, e.other.id));
  await speak(e);
  expect(clip(e, e.other.id)).toEqual(source);
  expect(clip(e, e.own.id)).toEqual(e.own);
  expect(voiceTimeAt(e.store.project, clip(e, e.avatar.id).avatar, 500000)).toBe(.5);
  e.store.undo();
  expect(voiceTimeAt(e.store.project, clip(e, e.avatar.id).avatar, 500000)).toBe(.75);
});
