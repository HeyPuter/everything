/**
 * Creating and re-voicing presenter avatars. A new avatar gets its voice
 * from text to speech (Puter AI) or from an audio clip already on the
 * timeline; the voice is analyzed on the device for lip sync
 * (media/lipsync.js) and the avatar clip goes on an overlay track, grouped
 * with its voice clip so they move together.
 *
 * The speech and the analysis are services so tests (and later other voice
 * sources) can stand in: ctx.avatarServices = { synthesize, analyze }.
 */
import { US } from '../lib/time.js';
import { announce } from '../lib/dom.js';
import { makeClip } from '../model/project.js';
import * as T from '../model/timeline.js';
import { AVATAR_POSITIONS, normalizeAvatar, newAvatarSeed } from '../model/avatar.js';
import { avatarCharacter } from '../engine/avatars.js';
import { synthesize, speechFile } from '../media/tts.js';

/** Rest after the last word before the avatar clip ends. */
export const AVATAR_TAIL = 400_000;

/** Lip data for an audio asset: decoded and analyzed on the device. */
export async function analyzeVoiceAsset(library, asset, { signal } = {}) {
  const [{ mediabunnyOpener }, { decodeClipSound, downmix }, { analyzeVoice, encodeLips, LIP_MAX_SECONDS }] = await Promise.all([
    import('../engine/audio-mix.js'),
    import('../media/audio-analysis.js'),
    import('../media/lipsync.js'),
  ]);
  const span = { in: 0, duration: asset.duration || LIP_MAX_SECONDS * US, speed: 1 };
  const snd = await decodeClipSound(mediabunnyOpener(library), asset, span, { maxSeconds: LIP_MAX_SECONDS, signal });
  if (!snd?.channels[0]?.length) throw new Error('No sound found in the voice.');
  return encodeLips(analyzeVoice(downmix(snd.channels), snd.sampleRate));
}

/** Speech and analysis, from ctx.avatarServices when given (tests). */
export function avatarServices(ctx) {
  return {
    synthesize: (text, voice) => synthesize(text, voice),
    analyze: (asset) => analyzeVoiceAsset(ctx.library, asset),
    ...ctx.avatarServices,
  };
}

/** Speech for a script, imported as media. */
async function speechAsset(ctx, services, script, voice) {
  const text = String(script || '').trim();
  if (!text) throw new Error('Write what the avatar should say first.');
  const blob = await services.synthesize(text, voice);
  const [asset] = await ctx.actions.importFiles([speechFile(blob, text)], { origin: 'avatar' });
  if (!asset) throw new Error("Couldn't add the voice to your media.");
  return asset;
}

const avatarName = (character) => `${avatarCharacter(character).label} avatar`;

/**
 * Add an avatar. opts: { character, framing, background, bgColor, position,
 * script, voice } for a spoken script, or { voiceClipId } to lip-sync to an
 * audio clip on the timeline (the avatar starts and ends with it).
 * onStep(label) reports progress. Returns the avatar clip or null.
 */
export async function createAvatar(ctx, opts = {}, { onStep = () => {} } = {}) {
  const { store } = ctx;
  const services = avatarServices(ctx);
  const look = normalizeAvatar({ ...opts, seed: opts.seed ?? newAvatarSeed() });
  let asset;
  let voiceClip = null;
  if (opts.voiceClipId) {
    voiceClip = T.findClip(store.project, opts.voiceClipId)?.clip;
    asset = voiceClip && store.project.assets[voiceClip.assetId];
    if (!asset) throw new Error('That audio clip is no longer on the timeline.');
  } else {
    onStep('Creating the voice...');
    asset = await speechAsset(ctx, services, look.script, look.voice);
  }
  onStep('Matching the lips to the voice...');
  const lips = await services.analyze(asset);
  const start = voiceClip ? voiceClip.start : opts.start ?? store.time;
  const duration = voiceClip ? voiceClip.duration : Math.max(US, (asset.duration || 3 * US) + AVATAR_TAIL);
  const clip = makeClip('avatar', { start, duration, name: avatarName(look.character), avatar: { ...look, voiceAsset: asset.id, lips } });
  const pos = AVATAR_POSITIONS.find((p) => p.id === opts.position) || AVATAR_POSITIONS[0];
  Object.assign(clip.transform, pos.transform);
  const ok = store.update('Add avatar', (p) => {
    T.addClip(p, clip, { ...store.opts, main: false });
    let voiceId = voiceClip?.id;
    if (!voiceClip) {
      const audio = makeClip('audio', { assetId: asset.id, name: asset.name, start, duration: Math.max(T.MIN_CLIP, asset.duration || duration) });
      T.addClip(p, audio, { ...store.opts, main: false });
      voiceId = audio.id;
    }
    // Moving or deleting them together keeps the lips in step.
    const v = T.findClip(p, voiceId)?.clip;
    if (v && !v.group) T.groupClips(p, [clip.id, voiceId]);
  });
  if (!ok) return null;
  store.select(clip.id);
  announce(`${avatarName(look.character)} added`);
  return clip;
}

/** Voice clips of an avatar: its voice audio on the timeline, in its group or starting with it. */
function voiceClipsOf(p, avatarClip) {
  const id = avatarClip.avatar.voiceAsset;
  if (!id) return [];
  const out = [];
  for (const t of p.tracks) {
    if (t.kind !== 'audio') continue;
    for (const c of t.clips) {
      if (c.assetId !== id) continue;
      if ((avatarClip.group && c.group === avatarClip.group) || Math.abs(c.start - avatarClip.start) < 1000) out.push({ track: t, clip: c });
    }
  }
  return out;
}

/**
 * Speak a new script (and/or another voice): new speech replaces the old
 * voice clip, the lips are matched again and the avatar fits the new length.
 */
export async function revoiceAvatar(ctx, id, { script, voice } = {}, { onStep = () => {} } = {}) {
  const { store } = ctx;
  const services = avatarServices(ctx);
  const before = T.findClip(store.project, id)?.clip;
  if (!before || before.type !== 'avatar') return false;
  onStep('Creating the voice...');
  const asset = await speechAsset(ctx, services, script ?? before.avatar.script, voice ?? before.avatar.voice);
  onStep('Matching the lips to the voice...');
  const lips = await services.analyze(asset);
  return store.update('Change avatar voice', (p) => {
    const f = T.findClip(p, id);
    if (!f || f.track.locked) return false;
    const c = f.clip;
    const old = voiceClipsOf(p, c);
    for (const v of old) v.track.clips.splice(v.track.clips.indexOf(v.clip), 1);
    c.avatar = normalizeAvatar({ ...c.avatar, script: script ?? c.avatar.script, voice: voice ?? c.avatar.voice, voiceAsset: asset.id, lips });
    c.duration = Math.max(US, (asset.duration || c.duration) + AVATAR_TAIL);
    const audio = makeClip('audio', { assetId: asset.id, name: asset.name, start: c.start, duration: Math.max(T.MIN_CLIP, asset.duration || c.duration) });
    T.addClip(p, audio, { trackId: old[0]?.track.id, main: false });
    if (c.group) audio.group = c.group;
    else T.groupClips(p, [c.id, audio.id]);
  });
}

/** Lip-sync an avatar to another audio clip already on the timeline (keeps both where they are). */
export async function syncAvatarTo(ctx, id, audioClipId, { onStep = () => {} } = {}) {
  const { store } = ctx;
  const audio = T.findClip(store.project, audioClipId)?.clip;
  const asset = audio && store.project.assets[audio.assetId];
  if (!asset) throw new Error('That audio clip is no longer on the timeline.');
  onStep('Matching the lips to the voice...');
  const lips = await avatarServices(ctx).analyze(asset);
  return store.update('Lip-sync avatar', (p) => {
    const f = T.findClip(p, id);
    if (!f || f.track.locked) return false;
    f.clip.avatar = normalizeAvatar({ ...f.clip.avatar, voiceAsset: asset.id, lips });
  });
}

/** Analyze an avatar's voice again (when its lip data is missing). */
export async function relipAvatar(ctx, id, { onStep = () => {} } = {}) {
  const { store } = ctx;
  const c = T.findClip(store.project, id)?.clip;
  const asset = c?.avatar?.voiceAsset && store.project.assets[c.avatar.voiceAsset];
  if (!asset) throw new Error('This avatar has no voice yet.');
  onStep('Matching the lips to the voice...');
  const lips = await avatarServices(ctx).analyze(asset);
  return store.update('Lip-sync avatar', (p) => {
    const f = T.findClip(p, id);
    if (!f || f.track.locked) return false;
    f.clip.avatar = normalizeAvatar({ ...f.clip.avatar, lips });
  });
}

/** Audio clips on the timeline a voice can come from: [{ id, label, start }]. */
export function voiceChoices(project) {
  const out = [];
  for (const t of project.tracks) {
    if (t.kind !== 'audio') continue;
    for (const c of t.clips) if (project.assets[c.assetId]) out.push({ id: c.id, label: T.clipLabel(project, c), start: c.start });
  }
  return out.sort((a, b) => a.start - b.start);
}
