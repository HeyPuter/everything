import { describe, it, expect, vi, afterEach } from 'vitest';
import { EditorStore } from '../src/model/store.js';
import { createActions } from '../src/ui/actions.js';
import { makeClip, normalizeClip, normalizeProject, normalizeAsset, TRACK_KIND_FOR } from '../src/model/project.js';
import { findClip } from '../src/model/timeline.js';
import { normalizeAvatar, positionOf, AVATAR_POSITIONS, AVATAR_CHARACTER_IDS, DEFAULT_AVATAR } from '../src/model/avatar.js';
import { encodeLips } from '../src/media/lipsync.js';
import { avatarPose, blinkAt, gazeAt, gestureAt, poseKey, hash01, seedOf } from '../src/engine/avatar-motion.js';
import { drawAvatar, AVATAR_CHARACTERS, REST_POSE, avatarStage } from '../src/engine/avatars.js';
import { evaluate, voiceTimeAt } from '../src/engine/scene.js';
import { TextCache } from '../src/engine/text.js';
import { createAvatar, revoiceAvatar, syncAvatarTo, voiceChoices, AVATAR_TAIL } from '../src/ui/avatar-actions.js';
import { avatarsTab } from '../src/ui/panels/avatars.js';
import { createInspector, tabsFor } from '../src/ui/inspector/index.js';
import { mockContext } from './canvas-mock.js';
import { fixture, s, clip } from './helpers.js';

/** Lip data for `seconds` of speech: syllables that open and close, with a beat at 1 s. */
function lipsFor(seconds = 3) {
  const frames = Math.round(seconds * 50);
  const open = Array.from({ length: frames }, (_, i) => 0.5 + 0.5 * Math.sin(i / 3));
  const z = new Array(frames).fill(0);
  return encodeLips({ rate: 50, frames, open, wide: z.map((_, i) => (i % 20) / 20), round: z, fric: z, beats: [50] });
}

/** A project with an avatar at 1 s whose voice clip starts with it. */
function avatarProject({ framing = 'head' } = {}) {
  const p = fixture();
  const av = makeClip('avatar', { start: s(1), duration: s(3.4), avatar: { character: 'raj', framing, voiceAsset: 'aud', lips: lipsFor(3), seed: 42 } });
  const voice = clip('audio', 1, 3);
  p.tracks.unshift({ id: 'ov', kind: 'video', locked: false, hidden: false, muted: false, clips: [av] });
  p.tracks.push({ id: 'au', kind: 'audio', locked: false, hidden: false, muted: false, clips: [voice] });
  return { p, av, voice };
}

describe('avatar clips in the project', () => {
  it('live on video tracks with a normalized avatar', () => {
    expect(TRACK_KIND_FOR.avatar).toBe('video');
    const c = makeClip('avatar', { avatar: { character: 'mei' } });
    expect(c.avatar).toMatchObject({ ...DEFAULT_AVATAR, character: 'mei' });
    expect(c.transform).toMatchObject({ x: 0, y: 0, scale: 1 });
  });

  it('normalizes untrusted avatar data', () => {
    const a = normalizeAvatar({ character: 'nobody', framing: 'feet', background: 'blur', bgColor: '#ABCDEF', script: 'x'.repeat(5000), voice: 'bad voice!', voiceAsset: 7, lips: { rate: 50, data: '%%' }, seed: -3 });
    expect(a).toMatchObject({ character: 'ava', framing: 'head', background: 'blur', bgColor: '#abcdef', voice: '', voiceAsset: null, lips: null, seed: DEFAULT_AVATAR.seed });
    expect(a.script.length).toBe(3000);
    const lips = lipsFor(2);
    expect(normalizeAvatar({ character: 'kofi', voice: 'openai-nova', voiceAsset: 'a1', lips, seed: 9 })).toMatchObject({ character: 'kofi', voice: 'openai-nova', voiceAsset: 'a1', lips, seed: 9 });
  });

  it('survive a save and load', () => {
    const { p, av } = avatarProject();
    const back = normalizeProject(JSON.parse(JSON.stringify(p)));
    const c = findClip(back, av.id).clip;
    expect(c.type).toBe('avatar');
    expect(c.avatar).toEqual(av.avatar);
    expect(normalizeClip({ type: 'avatar', avatar: null }).avatar.character).toBe('ava');
  });

  it('match the position presets', () => {
    for (const pos of AVATAR_POSITIONS) expect(positionOf({ ...pos.transform, rotation: 0 })).toBe(pos.id);
    expect(positionOf({ x: 0.1, y: 0, scale: 1 })).toBe(null);
  });
});

describe('avatar motion', () => {
  it('is repeatable for the same inputs', () => {
    const lips = lipsFor(3);
    const a = avatarPose({ seed: 5, t: 1.23, voiceSec: 0.8, lips });
    expect(avatarPose({ seed: 5, t: 1.23, voiceSec: 0.8, lips })).toEqual(a);
    expect(poseKey(a)).toBe(poseKey(avatarPose({ seed: 5, t: 1.23, voiceSec: 0.8, lips })));
    expect(avatarPose({ seed: 6, t: 1.23, voiceSec: 0.8, lips })).not.toEqual(a);
  });

  it('keeps the mouth shut without a voice and moves it with one', () => {
    const lips = lipsFor(3);
    expect(avatarPose({ seed: 1, t: 1 }).open).toBe(0);
    const opens = Array.from({ length: 30 }, (_, i) => avatarPose({ seed: 1, t: i * 0.05, voiceSec: i * 0.05, lips }).open);
    expect(Math.max(...opens)).toBeGreaterThan(0.8);
    expect(Math.min(...opens)).toBeLessThan(0.2);
  });

  it('blinks every few seconds, briefly', () => {
    let closed = 0;
    let blinks = 0;
    let prev = 0;
    const step = 0.01;
    for (let t = 0; t < 60; t += step) {
      const b = blinkAt(77, t);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThanOrEqual(1);
      if (b > 0.5) closed += step;
      if (b > 0.5 && prev <= 0.5) blinks++;
      prev = b;
    }
    expect(blinks).toBeGreaterThan(9);
    expect(blinks).toBeLessThan(30);
    expect(closed / blinks).toBeLessThan(0.15);
  });

  it('glances only a little', () => {
    for (let t = 0; t < 20; t += 0.37) {
      const g = gazeAt(3, t);
      expect(Math.abs(g.x)).toBeLessThanOrEqual(0.35);
      expect(Math.abs(g.y)).toBeLessThanOrEqual(0.18);
    }
  });

  it('gestures around emphasis beats, with hands only in the waist-up framing', () => {
    const lips = lipsFor(3);
    expect(gestureAt(1, lips, 0.2)).toBe(null);
    const at = gestureAt(1, lips, 1.1, 'waist');
    expect(at.amount).toBe(1);
    // Some seed gives a hand gesture in the waist framing; never with the head framing.
    const seeds = Array.from({ length: 40 }, (_, i) => i);
    expect(seeds.some((sd) => gestureAt(sd, lips, 1.1, 'waist').kind === 'hand')).toBe(true);
    expect(seeds.every((sd) => gestureAt(sd, lips, 1.1, 'head').kind !== 'hand')).toBe(true);
    const handSeed = seeds.find((sd) => gestureAt(sd, lips, 1.1, 'waist').kind === 'hand');
    expect(avatarPose({ seed: handSeed, t: 2, voiceSec: 1.1, lips, framing: 'waist' }).hand).toBe(1);
    expect(avatarPose({ seed: handSeed, t: 2, voiceSec: 1.1, lips, framing: 'head' }).hand).toBe(0);
  });

  it('hashes into [0, 1)', () => {
    for (let i = 0; i < 2000; i++) {
      const v = hash01(seedOf(`x${i}`), i);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('avatar drawing', () => {
  const calls = (look, pose, w = 640, h = 360) => {
    const ctx = mockContext();
    drawAvatar(ctx, w, h, look, pose);
    return ctx;
  };

  it('draws every character, framing and background with finite numbers', () => {
    expect(AVATAR_CHARACTERS.map((c) => c.id)).toEqual(AVATAR_CHARACTER_IDS);
    const pose = { ...REST_POSE, open: 0.8, wide: 0.5, round: 0.3, fric: 0.6, blink: 0.5, brow: 1, rot: 3, yaw: 0.5, hand: 0.7, handSide: -1 };
    for (const c of AVATAR_CHARACTERS) {
      for (const framing of ['head', 'waist']) {
        for (const background of ['none', 'color', 'blur']) {
          const ctx = calls({ character: c.id, framing, background, bgColor: '#336699', seed: 4 }, pose);
          expect(ctx.bad, `${c.id} ${framing} ${background}`).toEqual([]);
          expect(ctx.calls.length).toBeGreaterThan(100);
        }
      }
    }
  });

  it('is deterministic: the same look and pose give the same drawing at any size', () => {
    const look = { character: 'ines', framing: 'waist', background: 'blur', bgColor: '#445566', seed: 8 };
    const pose = avatarPose({ seed: 8, t: 2.5, voiceSec: 1.1, lips: lipsFor(3), framing: 'waist' });
    const json = (ctx) => JSON.stringify(ctx.calls);
    expect(json(calls(look, pose))).toBe(json(calls(look, pose)));
    // Preview and export sizes differ only by scale: the same operations, in the same order.
    const names = (ctx) => ctx.calls.map((c) => c[0]);
    expect(names(calls(look, pose, 1920, 1080))).toEqual(names(calls(look, pose, 480, 270)));
    expect(json(calls(look, { ...pose, open: 0.9 }))).not.toBe(json(calls(look, pose)));
  });

  it('only paints a background when one is chosen', () => {
    const ctx = calls({ character: 'leo', framing: 'head', background: 'none', bgColor: '#000000' }, REST_POSE);
    expect(ctx.calls.filter((c) => c[0] === 'fillRect' && c[3] === 640)).toEqual([]);
    const withBg = calls({ character: 'leo', framing: 'head', background: 'color', bgColor: '#000000' }, REST_POSE);
    expect(withBg.calls.some((c) => c[0] === 'fillRect' && c[3] === 640)).toBe(true);
  });

  it('fits the framing into wide and tall frames', () => {
    const wide = avatarStage(1920, 1080, 'head');
    const tall = avatarStage(1080, 1920, 'head');
    expect(wide.ox).toBe(960);
    expect(tall.u * 3.5).toBeLessThanOrEqual(1080 + 1e-6);
    expect(avatarStage(1920, 1080, 'waist').u).toBeLessThan(wide.u);
  });
});

describe('avatars in the scene', () => {
  it('follow the voice clip on the timeline', () => {
    const { p, av, voice } = avatarProject();
    expect(voiceTimeAt(p, av.avatar, s(1.5))).toBeCloseTo(0.5);
    voice.start = s(2);
    expect(voiceTimeAt(p, av.avatar, s(1.5))).toBe(null);
    expect(voiceTimeAt(p, av.avatar, s(2.25))).toBeCloseTo(0.25);
    voice.in = s(1);
    expect(voiceTimeAt(p, av.avatar, s(2.25))).toBeCloseTo(1.25);
    voice.muted = true;
    expect(voiceTimeAt(p, av.avatar, s(2.25))).toBe(null);
  });

  it('evaluate to an avatar layer with a pose that repeats', () => {
    const { p, av } = avatarProject();
    const layer = evaluate(p, s(2)).find((l) => l.kind === 'avatar');
    expect(layer.clip.id).toBe(av.id);
    expect(layer.frameW).toBe(1920);
    expect(layer.local).toBe(s(1));
    expect(layer.pose).toEqual(evaluate(p, s(2)).find((l) => l.kind === 'avatar').pose);
    expect(layer.pose.open).toBeGreaterThanOrEqual(0);
  });

  it('cache rasters by pose and size', () => {
    const { p } = avatarProject();
    const cache = new TextCache();
    const l1 = evaluate(p, s(2)).find((l) => l.kind === 'avatar');
    const a = cache.get(l1, 0.5);
    expect(a).toMatchObject({ projW: 1920, projH: 1080, width: 960, height: 540 });
    expect(cache.get(l1, 0.5).version).toBe(a.version);
    const l2 = evaluate(p, s(2.5)).find((l) => l.kind === 'avatar');
    expect(cache.get(l2, 0.5).version).toBe(a.version + 1);
  });
});

/* ---- Actions and UI --------------------------------------------------------------- */

function env({ signedIn = true } = {}) {
  const store = new EditorStore(fixture());
  const imported = [];
  const library = {
    backend: { kind: signedIn ? 'puter' : 'local' },
    async importFile(file) {
      const a = normalizeAsset({ kind: 'audio', name: file.name, duration: s(2), hasAudio: true });
      imported.push(file);
      return a;
    },
  };
  const ctx = { store, library, player: { pause() {} } };
  ctx.actions = createActions(ctx);
  ctx.avatarServices = {
    synthesize: vi.fn(async () => new Blob(['voice'], { type: 'audio/mpeg' })),
    analyze: vi.fn(async () => lipsFor(2)),
  };
  if (signedIn) globalThis.puter = { ai: {} };
  return { store, ctx, imported };
}

const allClips = (p) => p.tracks.flatMap((t) => t.clips);

afterEach(() => {
  delete globalThis.puter;
  document.body.replaceChildren();
});

describe('creating avatars', () => {
  it('speaks a script, adds the avatar and its voice grouped together', async () => {
    const { store, ctx, imported } = env();
    const c = await createAvatar(ctx, { character: 'noor', framing: 'waist', position: 'br', script: 'Hello there', voice: 'openai-nova', start: s(1) });
    expect(ctx.avatarServices.synthesize).toHaveBeenCalledWith('Hello there', 'openai-nova');
    expect(imported[0].name).toMatch(/^Speech - Hello there/);
    const av = findClip(store.project, c.id);
    expect(av.track.kind).toBe('video');
    expect(av.track.main).toBeFalsy();
    expect(av.clip).toMatchObject({ start: s(1), duration: s(2) + AVATAR_TAIL, name: 'Noor avatar' });
    expect(av.clip.transform).toMatchObject(AVATAR_POSITIONS.find((x) => x.id === 'br').transform);
    expect(av.clip.avatar).toMatchObject({ character: 'noor', framing: 'waist', script: 'Hello there', voice: 'openai-nova' });
    const voice = allClips(store.project).find((x) => x.type === 'audio' && x.assetId === av.clip.avatar.voiceAsset);
    expect(voice).toMatchObject({ start: s(1), duration: s(2), group: av.clip.group });
    expect(store.selectedIds).toEqual([c.id]);
    // One undo removes both clips.
    store.undo();
    expect(allClips(store.project).some((x) => x.type === 'avatar')).toBe(false);
  });

  it('lip-syncs to an audio clip already on the timeline', async () => {
    const { store, ctx } = env({ signedIn: false });
    const voice = clip('audio', 2, 4);
    store.update('add', (p) => p.tracks.push({ id: 'a1', kind: 'audio', locked: false, hidden: false, muted: false, clips: [voice] }));
    expect(voiceChoices(store.project).map((x) => x.id)).toEqual([voice.id]);
    const c = await createAvatar(ctx, { character: 'leo', voiceClipId: voice.id });
    expect(ctx.avatarServices.synthesize).not.toHaveBeenCalled();
    expect(c).toMatchObject({ start: s(2), duration: s(4) });
    expect(c.avatar.voiceAsset).toBe('aud');
    expect(allClips(store.project).filter((x) => x.type === 'audio')).toHaveLength(1);
  });

  it('re-voices: new speech replaces the old voice clip and the avatar fits it', async () => {
    const { store, ctx } = env();
    const c = await createAvatar(ctx, { script: 'One', voice: 'polly' });
    const oldAsset = findClip(store.project, c.id).clip.avatar.voiceAsset;
    expect(await revoiceAvatar(ctx, c.id, { script: 'Two words', voice: 'openai-echo' })).toBeTruthy();
    const after = findClip(store.project, c.id).clip;
    expect(after.avatar).toMatchObject({ script: 'Two words', voice: 'openai-echo' });
    expect(after.avatar.voiceAsset).not.toBe(oldAsset);
    const voices = allClips(store.project).filter((x) => x.type === 'audio');
    expect(voices.map((v) => v.assetId)).toEqual([after.avatar.voiceAsset]);
    expect(voices[0].group).toBe(after.group);
    store.undo();
    expect(findClip(store.project, c.id).clip.avatar.voiceAsset).toBe(oldAsset);
  });

  it('switches the lips to another audio clip', async () => {
    const { store, ctx } = env();
    const c = await createAvatar(ctx, { script: 'One', voice: 'polly' });
    const other = clip('audio', 0, 3);
    store.update('add', (p) => p.tracks.push({ id: 'a9', kind: 'audio', locked: false, hidden: false, muted: false, clips: [other] }));
    await syncAvatarTo(ctx, c.id, other.id);
    expect(findClip(store.project, c.id).clip.avatar.voiceAsset).toBe('aud');
  });

  it('asks for a script first', async () => {
    const { ctx } = env();
    await expect(createAvatar(ctx, { script: '  ' })).rejects.toThrow(/Write what/);
  });
});

describe('avatar panel', () => {
  it('shows the sign-in prompt for scripts when signed out but still offers audio clips', async () => {
    const { store, ctx } = env({ signedIn: false });
    const voice = clip('audio', 0, 2);
    store.update('add', (p) => p.tracks.push({ id: 'a1', kind: 'audio', locked: false, hidden: false, muted: false, clips: [voice] }));
    const tab = avatarsTab(ctx);
    document.body.append(tab.el);
    expect(tab.el.textContent).toMatch(/Sign in for spoken scripts/);
    const add = tab.el.querySelector('.avatar-add');
    expect(add.disabled).toBe(true);
    [...tab.el.querySelectorAll('[role=radio]')].find((b) => b.textContent === 'Audio clip').click();
    expect(tab.el.querySelector('#avatar-clip').value).toBe(voice.id);
    expect(add.disabled).toBe(false);
    [...tab.el.querySelectorAll('.avatar-grid .choice')].find((b) => /Grace/.test(b.textContent)).click();
    expect(add.textContent).toMatch(/Add Grace/);
    add.click();
    await vi.waitFor(() => expect(allClips(store.project).some((x) => x.type === 'avatar')).toBe(true));
    expect(allClips(store.project).find((x) => x.type === 'avatar').avatar.character).toBe('grace');
    tab.dispose();
  });

  it('adds a scripted avatar when signed in', async () => {
    const { store, ctx } = env();
    const tab = avatarsTab(ctx);
    document.body.append(tab.el);
    [...tab.el.querySelectorAll('[role=radio]')].find((b) => b.textContent === 'Script').click();
    const text = tab.el.querySelector('#avatar-script');
    text.value = 'Welcome to the show';
    text.dispatchEvent(new Event('input'));
    tab.el.querySelector('.avatar-add').click();
    await vi.waitFor(() => expect(allClips(store.project).some((x) => x.type === 'avatar')).toBe(true));
    expect(ctx.avatarServices.synthesize).toHaveBeenCalledWith('Welcome to the show', expect.any(String));
    tab.dispose();
  });
});

describe('avatar details tab', () => {
  it('edits the presenter, framing, background and position', async () => {
    const { store, ctx } = env();
    const c = await createAvatar(ctx, { character: 'ava', script: 'Hi', voice: 'polly' });
    expect(tabsFor(store.project, c)).toEqual(['avatar', 'animation', 'clipfx']);
    const insp = createInspector(ctx);
    document.body.append(insp.el);
    const live = () => findClip(store.project, c.id).clip;
    [...insp.el.querySelectorAll('.avatar-grid .choice')].find((b) => /Raj/.test(b.textContent)).click();
    expect(live().avatar.character).toBe('raj');
    expect(live().name).toBe('Raj avatar');
    [...insp.el.querySelectorAll('[role=radio]')].find((b) => b.textContent === 'Waist up').click();
    expect(live().avatar.framing).toBe('waist');
    [...insp.el.querySelectorAll('[role=radio]')].find((b) => b.textContent === 'Color').click();
    expect(live().avatar.background).toBe('color');
    [...insp.el.querySelectorAll('[role=radio]')].find((b) => b.getAttribute('aria-label') === 'Top left').click();
    expect(live().transform).toMatchObject(AVATAR_POSITIONS.find((x) => x.id === 'tl').transform);
    store.undo();
    expect(live().transform.scale).toBe(1);
    insp.dispose();
  });

  it('speaks a new script from the details tab', async () => {
    const { store, ctx } = env();
    const c = await createAvatar(ctx, { script: 'Hi', voice: 'polly' });
    const insp = createInspector(ctx);
    document.body.append(insp.el);
    const ta = insp.el.querySelector('.avatar-script');
    expect(ta.value).toBe('Hi');
    ta.value = 'A new line';
    ta.dispatchEvent(new Event('input'));
    [...insp.el.querySelectorAll('button')].find((b) => b.textContent === 'Speak again').click();
    await vi.waitFor(() => expect(findClip(store.project, c.id).clip.avatar.script).toBe('A new line'));
    insp.dispose();
  });
});
