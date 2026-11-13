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

function checkAvatar(signal) {
  if (signal?.aborted) throw new DOMException('Avatar creation cancelled.', 'AbortError');
}
const editingContext = (store) => JSON.stringify([store.project.id, store.project.timelineId, ...(store.nest || []).map((f) => f.id)]);

/** Lip data for an audio asset: decoded and analyzed on the device. */
export async function analyzeVoiceAsset(library, asset, { signal } = {}) {
  checkAvatar(signal);
  const [{ mediabunnyOpener }, { decodeClipSound, downmix }, { analyzeVoice, encodeLips, LIP_MAX_SECONDS }] = await Promise.all([
    import('../engine/audio-mix.js'),
    import('../media/audio-analysis.js'),
    import('../media/lipsync.js'),
  ]);
  checkAvatar(signal);
  const span = { in: 0, duration: asset.duration || LIP_MAX_SECONDS * US, speed: 1 };
  const snd = await decodeClipSound(mediabunnyOpener(library), asset, span, { maxSeconds: LIP_MAX_SECONDS, signal });
  checkAvatar(signal);
  if (!snd?.channels[0]?.length) throw new Error('No sound found in the voice.');
  return encodeLips(analyzeVoice(downmix(snd.channels), snd.sampleRate));
}

/** Speech and analysis, from ctx.avatarServices when given (tests). */
export function avatarServices(ctx) {
  return {
    synthesize: (text, voice, opts) => synthesize(text, voice, opts),
    analyze: (asset, opts) => analyzeVoiceAsset(ctx.library, asset, opts),
    ...ctx.avatarServices,
  };
}

/** Speech for a script, imported as media. */
async function speechAsset(ctx, services, script, voice, signal) {
  checkAvatar(signal);
  const text = String(script || '').trim();
  if (!text) throw new Error('Write what the avatar should say first.');
  const blob = await services.synthesize(text, voice, ...(signal ? [{ signal }] : []));
  checkAvatar(signal);
  const [asset] = await ctx.actions.importFiles([speechFile(blob, text)], { origin: 'avatar', ...(signal ? { signal } : {}) });
  checkAvatar(signal);
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
export async function createAvatar(ctx, opts = {}, { onStep = () => {}, signal } = {}) {
  checkAvatar(signal);
  const { store } = ctx;
  const services = avatarServices(ctx);
  const look = normalizeAvatar({ ...opts, seed: opts.seed ?? newAvatarSeed() });
  const requestedStart = opts.start ?? store.time;
  const pos = AVATAR_POSITIONS.find((p) => p.id === opts.position) || AVATAR_POSITIONS[0];
  const voiceId = opts.voiceClipId;
  let voiceClip = voiceId ? T.findClip(store.project, voiceId)?.clip : null;
  let asset = voiceClip && store.project.assets[voiceClip.assetId];
  if (voiceId && !asset) throw new Error('That audio clip is no longer on the timeline.');
  const source = editingContext(store), sourceAsset = asset?.id, controller = new AbortController();
  let off;
  const abort = () => {
    controller.abort();
    off?.();
    off = null;
    signal?.removeEventListener('abort', abort);
  };
  off = store.on('change', () => {
    const voice = voiceId && T.findClip(store.project, voiceId)?.clip;
    if (editingContext(store) !== source || (voiceId && (!voice || voice.assetId !== sourceAsset))) abort();
  });
  signal?.addEventListener('abort', abort, { once: true });
  try {
    if (!voiceId) {
      onStep('Creating the voice...');
      asset = await speechAsset(ctx, services, look.script, look.voice, controller.signal);
    }
    checkAvatar(controller.signal);
    onStep('Matching the lips to the voice...');
    checkAvatar(controller.signal);
    const lips = await services.analyze(asset, { signal: controller.signal });
    checkAvatar(controller.signal);
    // A voice clip may have moved while analysis ran; keep the avatar beside it.
    if (voiceId) voiceClip = T.findClip(store.project, voiceId).clip;
    const start = voiceClip ? voiceClip.start : requestedStart;
    const duration = voiceClip ? voiceClip.duration : Math.max(US, (asset.duration || 3 * US) + AVATAR_TAIL);
    const clip = makeClip('avatar', { start, duration, name: avatarName(look.character), avatar: { ...look, voiceAsset: asset.id, lips } });
    Object.assign(clip.transform, pos.transform);
    const ok = store.update('Add avatar', (p) => {
      T.addClip(p, clip, { ...store.opts, main: false });
      let voice = voiceId;
      if (!voiceClip) {
        const audio = makeClip('audio', { assetId: asset.id, name: asset.name, start, duration: Math.max(T.MIN_CLIP, asset.duration || duration) });
        T.addClip(p, audio, { ...store.opts, main: false });
        voice = audio.id;
      }
      // Moving or deleting them together keeps the lips in step.
      const v = T.findClip(p, voice)?.clip;
      if (v && !v.group) T.groupClips(p, [clip.id, voice]);
    });
    if (!ok) return null;
    store.select(clip.id);
    announce(`${avatarName(look.character)} added`);
    return clip;
  } catch (err) {
    checkAvatar(controller.signal);
    throw err;
  } finally {
    off?.();
    signal?.removeEventListener('abort', abort);
  }
}

/** Voice clips owned by an avatar's group, with a timing fallback for ungrouped pairs. */
function voiceClipsOf(p, avatarClip) {
  const id = avatarClip.avatar.voiceAsset;
  if (!id) return [];
  const out = [];
  for (const t of p.tracks) {
    if (t.kind !== 'audio') continue;
    for (const c of t.clips) {
      if (c.assetId !== id) continue;
      // An explicit group takes precedence over coincident placement. Reusing a
      // voice asset (including Use clip) must not consume another group's audio.
      const linked = avatarClip.group ? c.group === avatarClip.group : !c.group && Math.abs(c.start - avatarClip.start) < 1000;
      if (linked) out.push({ track: t, clip: c });
    }
  }
  return out;
}

// Only one voice edit may own an avatar at a time, including direct action callers.
const voiceEdits = new WeakMap();
async function editAvatarVoice(ctx, id, { signal, onCancel, audioId, replaceVoice = false }, run) {
  checkAvatar(signal);
  const { store } = ctx;
  const found = T.findClip(store.project, id);
  if (!found || found.clip.type !== 'avatar' || found.track.locked) return false;
  const a = found.clip.avatar;
  const source = editingContext(store), script = a.script, voice = a.voice, voiceAsset = a.voiceAsset, lipData = a.lips?.data;
  const oldVoices = replaceVoice ? voiceClipsOf(store.project, found.clip) : [];
  if (oldVoices.some((v) => v.track.locked)) throw new Error("Unlock the avatar's voice track before changing its voice.");
  const oldIds = new Set(oldVoices.map((v) => v.clip.id));
  const audioAsset = audioId ? T.findClip(store.project, audioId)?.clip.assetId : null;
  const controller = new AbortController();
  let off;
  let edits = voiceEdits.get(store);
  if (!edits) voiceEdits.set(store, edits = new Map());
  const close = () => {
    off?.();
    off = null;
    signal?.removeEventListener('abort', abort);
    if (edits.get(id) === abort) edits.delete(id);
  };
  const abort = () => {
    if (controller.signal.aborted) return;
    controller.abort();
    close();
    onCancel?.();
  };
  const valid = () => {
    if (editingContext(store) !== source) return false;
    const f = T.findClip(store.project, id), current = f?.clip.avatar;
    if (!current || f.clip.type !== 'avatar' || f.track.locked || current.script !== script || current.voice !== voice || current.voiceAsset !== voiceAsset || current.lips?.data !== lipData) return false;
    if (audioId && T.findClip(store.project, audioId)?.clip.assetId !== audioAsset) return false;
    if (replaceVoice) {
      const voices = voiceClipsOf(store.project, f.clip);
      if (voices.length !== oldIds.size || voices.some((v) => v.track.locked || !oldIds.has(v.clip.id))) return false;
    }
    return true;
  };
  const check = () => {
    if (signal?.aborted || !valid()) abort();
    checkAvatar(controller.signal);
  };
  edits.get(id)?.();
  edits.set(id, abort);
  off = store.on('change', () => { if (!valid()) abort(); });
  signal?.addEventListener('abort', abort, { once: true });
  try {
    check();
    return await run({ signal: controller.signal, check, commit(fn) {
      check();
      // The synchronous edit changes the captured voice itself; stop observing first.
      close();
      return fn();
    } });
  } catch (err) {
    checkAvatar(controller.signal);
    throw err;
  } finally {
    close();
  }
}

/** Replace an avatar's script/voice and its linked voice clips. */
export async function revoiceAvatar(ctx, id, { script, voice } = {}, { onStep = () => {}, signal, onCancel } = {}) {
  return editAvatarVoice(ctx, id, { signal, onCancel, replaceVoice: true }, async (task) => {
    const { store } = ctx, services = avatarServices(ctx), before = T.findClip(store.project, id).clip;
    const words = script ?? before.avatar.script, chosenVoice = voice ?? before.avatar.voice;
    onStep('Creating the voice...');
    const asset = await speechAsset(ctx, services, words, chosenVoice, task.signal);
    task.check();
    onStep('Matching the lips to the voice...');
    task.check();
    const lips = await services.analyze(asset, { signal: task.signal });
    return task.commit(() => store.update('Change avatar voice', (p) => {
      const c = T.findClip(p, id).clip;
      const old = voiceClipsOf(p, c);
      for (const v of old) v.track.clips.splice(v.track.clips.indexOf(v.clip), 1);
      c.avatar = normalizeAvatar({ ...c.avatar, script: words, voice: chosenVoice, voiceAsset: asset.id, lips });
      c.duration = Math.max(US, (asset.duration || c.duration) + AVATAR_TAIL);
      const audio = makeClip('audio', { assetId: asset.id, name: asset.name, start: c.start, duration: Math.max(T.MIN_CLIP, asset.duration || c.duration) });
      T.addClip(p, audio, { trackId: old[0]?.track.id, main: false });
      if (c.group) audio.group = c.group;
      else T.groupClips(p, [c.id, audio.id]);
    }));
  });
}

/** Lip-sync an avatar to another audio clip without changing either clip's placement. */
export async function syncAvatarTo(ctx, id, audioClipId, { onStep = () => {}, signal, onCancel } = {}) {
  checkAvatar(signal);
  const { store } = ctx;
  const audio = T.findClip(store.project, audioClipId)?.clip;
  const asset = audio && store.project.assets[audio.assetId];
  if (!asset) throw new Error('That audio clip is no longer on the timeline.');
  return editAvatarVoice(ctx, id, { signal, onCancel, audioId: audioClipId }, async (task) => {
    onStep('Matching the lips to the voice...');
    task.check();
    const lips = await avatarServices(ctx).analyze(asset, { signal: task.signal });
    return task.commit(() => store.update('Lip-sync avatar', (p) => {
      const c = T.findClip(p, id).clip;
      c.avatar = normalizeAvatar({ ...c.avatar, voiceAsset: asset.id, lips });
    }));
  });
}

/** Analyze the current avatar voice again without replacing its audio. */
export async function relipAvatar(ctx, id, { onStep = () => {}, signal, onCancel } = {}) {
  checkAvatar(signal);
  const { store } = ctx;
  const c = T.findClip(store.project, id)?.clip;
  const asset = c?.avatar?.voiceAsset && store.project.assets[c.avatar.voiceAsset];
  if (!asset) throw new Error('This avatar has no voice yet.');
  return editAvatarVoice(ctx, id, { signal, onCancel }, async (task) => {
    onStep('Matching the lips to the voice...');
    task.check();
    const lips = await avatarServices(ctx).analyze(asset, { signal: task.signal });
    return task.commit(() => store.update('Lip-sync avatar', (p) => {
      const c = T.findClip(p, id).clip;
      c.avatar = normalizeAvatar({ ...c.avatar, lips });
    }));
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
