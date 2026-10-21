/**
 * Performs the AI sidebar's tool calls (media/ai-tools.js) in the editor.
 * Edit calls go through the edit assistant's runner (one undo step each);
 * calls that make media wait on Puter AI, then import what came back and put
 * it on the timeline in one synchronous undo step, so an edit the user makes
 * while a clip is being generated never folds into the assistant's step.
 *
 * What is made lands on the timeline (or compound clip) that was open when
 * the call started; when the user opened another one meanwhile it goes into
 * the media library only, and the model is told so.
 *
 * A clip still being generated when the user presses Stop is not thrown
 * away (it has been paid for): it lands in the media library when it is
 * done, and a toast says so.
 *
 * Every call resolves to { ok, content, changed, entry, target }: content is
 * what the model is told, entry the undo step it made (or null), target the
 * clips or time the chat links the step to.
 */
import { US } from '../lib/time.js';
import { makeClip } from '../model/project.js';
import * as T from '../model/timeline.js';
import { assistState, resolveClips, projectBrief, secs, stepLabel } from '../media/edit-assistant.js';
import { describeCall, isEditTool, mediaBrief, clipDetails } from '../media/ai-tools.js';
import { generateVideo, videoAspectFor, fitSeconds, videoModel, modelForFrames, videoFileName, DEFAULT_SECONDS } from '../media/ai-video.js';
import { generateImage, aspectForSize, imageFileName, IMAGE_STYLES, IMAGE_ASPECTS } from '../media/imagegen.js';
import { editPicture, fitSize } from '../media/restyle.js';
import { synthesize, speechFile, TTS_VOICES } from '../media/tts.js';
import { createAssistantRunner } from './assistant-actions.js';
import { clipPicture, replacePicture } from './inspector/stylize.js';
import { defaultLength } from './preferences-dialog.js';
import { toast } from './dialog.js';

const ok = (content, extra = {}) => ({ ok: true, content: `Done: ${content}`, ...extra });
const fail = (content) => ({ ok: false, content: `Error: ${content}` });
const str = (v, max = 2000) => (typeof v === 'string' ? v.trim().slice(0, max) : typeof v === 'number' ? String(v) : '');
const num = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
const span = (c) => `${secs(c.start)}-${secs(c.start + c.duration)}`;
const elapsed = (ms) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** The whole frame at timeline time t as the player shows it, fitted for the AI: { blob, width, height }. */
export async function framePicture(ctx, t) {
  const p = ctx.store.project;
  const size = fitSize(p.settings.width, p.settings.height);
  const { renderStill } = await import('../engine/exporter.js');
  const bmp = await renderStill(p, ctx.library, Math.max(0, Math.min(t, ctx.store.duration - 1)), { maxWidth: size.w });
  const c = document.createElement('canvas');
  c.width = bmp.width;
  c.height = bmp.height;
  c.getContext('2d').drawImage(bmp, 0, 0);
  bmp.close?.();
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  if (!blob) throw new Error('Could not capture the frame.');
  return { blob, width: c.width, height: c.height };
}

/**
 * createAiToolRunner(ctx, services) -> { run(name, args, control) }
 * services replace the slow or paid steps (tests): generateVideo(opts),
 * generateImage(prompt, opts), editPicture(picture, instruction),
 * synthesize(text, voice), picture(clip, time), frame(time), editDeps (for
 * the edit runner), videoModel() and imageModel() -> the chosen model ids,
 * testMode() -> boolean.
 */
export function createAiToolRunner(ctx, services = {}) {
  const { store, actions } = ctx;
  const svc = {
    generateVideo: (opts) => generateVideo(opts),
    generateImage: (prompt, opts) => generateImage(prompt, opts),
    editPicture: (picture, instruction, opts) => editPicture(picture, instruction, opts),
    synthesize: (text, voice, opts) => synthesize(text, voice, opts),
    picture: (clip, time) => clipPicture(ctx, clip, time),
    frame: (time) => framePicture(ctx, time),
    videoModel: () => 'seedance25',
    imageModel: () => 'default',
    testMode: () => false,
    ...services,
  };
  const edits = createAssistantRunner(ctx, svc.editDeps);

  // ---- Clips and pictures ----------------------------------------------------

  /** One clip from an id or clip word, accepted by accept(clip): { clip, track } or { error }. */
  function oneClip(raw, accept = () => true, what = 'clip') {
    const st = assistState(store);
    const r = resolveClips(raw, st, accept);
    if (r.ids.length !== 1) {
      if (r.unknown.length) return { error: `there is no clip ${r.unknown[0]} in the project (call get_project for the ids)` };
      if (r.rejected) return { error: `that is not a ${what} that can be used here, or its track is locked` };
      return { error: `name exactly one ${what}` };
    }
    return T.findClip(store.project, r.ids[0]);
  }

  /** A picture from a picture source (see media/ai-tools.js): { picture, from: words, clip? }. */
  async function pictureFrom(source) {
    const s = str(source, 200);
    if (!s) throw new Error('no picture was named');
    if (s.toLowerCase() === 'playhead') return { picture: await svc.frame(store.time), from: `the frame at ${secs(store.time)}` };
    const [id, at = ''] = s.split('@');
    const p = store.project;
    const asset = p.assets[id];
    if (asset) {
      if (asset.kind === 'audio') throw new Error(`media ${id} is audio, not a picture`);
      // A media item is drawn through a stand-in clip of its own.
      const stand = makeClip(asset.kind === 'image' ? 'image' : 'video', { assetId: id, start: 0, duration: asset.kind === 'image' ? US : Math.max(US / 10, asset.duration) });
      const local = asset.kind === 'image' ? 0 : at === 'last' ? stand.duration : /^\d/.test(at) ? Math.round(num(at) * US) : 0;
      return { picture: await svc.picture(stand, local), from: `media ${id}` };
    }
    const found = oneClip(id, (c) => c.type === 'video' || c.type === 'image', 'video or image clip');
    if (found.error) throw new Error(found.error);
    const { clip } = found;
    let t;
    if (at === 'first') t = clip.start;
    else if (at === 'last') t = clip.start + clip.duration;
    else if (at && Number.isFinite(num(at))) t = Math.round(num(at) * US);
    else if (clip.type === 'video' && store.time >= clip.start && store.time < clip.start + clip.duration) t = store.time;
    else t = clip.start;
    t = Math.min(Math.max(t, clip.start), clip.start + clip.duration);
    return { picture: await svc.picture(clip, t), from: `clip ${clip.id} at ${secs(t)}`, clip };
  }

  // ---- Putting media in the project ----------------------------------------------

  const baseEnd = () => (T.mainTrack(store.project)?.clips || []).reduce((end, c) => Math.max(end, T.clipEnd(c)), 0);
  const isVisual = (asset) => asset.kind === 'video' || asset.kind === 'image';

  /** Into the base track at time t, at the cut nearest it, later clips moving along. */
  function insertOnMain(asset, t, duration) {
    const firstVisual = !T.allClips(store.project).some((c) => c.type === 'video' || c.type === 'image');
    const clip = makeClip(asset.kind === 'image' ? 'image' : 'video', { assetId: asset.id, name: asset.name, start: Math.max(0, t), duration: duration || (asset.kind === 'image' ? defaultLength.image() : Math.max(T.MIN_CLIP, asset.duration)) });
    const done = store.update(`Add ${asset.name}`, (p) => {
      T.addClip(p, clip, { ...store.opts, ripple: true, main: true });
    });
    if (!done) return null;
    if (firstVisual) actions.adoptMediaShape(asset);
    return T.findClip(store.project, clip.id)?.clip || null;
  }

  /**
   * Put an asset where place says. Returns { clip, words } (clip null for
   * media only). duration (microseconds) sets an image's length.
   */
  function place(asset, { place: where = 'end', start, duration, afterId = null, trackId } = {}) {
    const p = store.project;
    const t = Number.isFinite(num(start)) ? Math.round(Math.max(0, num(start)) * US) : store.time;
    if (where === 'media') return { clip: null, words: 'in the media library (not on the timeline)' };
    let clip = null;
    if (!isVisual(asset)) clip = actions.addAsset(asset, { start: t });
    else if (where === 'overlay') {
      clip = actions.addAsset(asset, { start: t, main: false, ...(trackId ? { trackId } : {}) });
      if (clip && duration && asset.kind === 'image') store.update('Clip length', (pp) => T.trimClip(pp, clip.id, 'end', clip.start + duration, store.opts), { structural: false });
    } else {
      let at = baseEnd();
      if (where === 'playhead') at = t;
      else if (where === 'after') {
        const after = afterId && T.findClip(p, afterId)?.clip;
        if (after) at = T.clipEnd(after);
      } else if (where === 'after_selected') {
        const sel = store.selectedIds.map((id) => T.findClip(p, id)).filter((f) => f?.track.main).map((f) => f.clip);
        if (sel.length) at = Math.max(...sel.map(T.clipEnd));
      }
      clip = insertOnMain(asset, at, asset.kind === 'image' ? duration : 0);
    }
    if (!clip) return { clip: null, words: 'in the media library, but there was no room for it on the timeline' };
    clip = T.findClip(store.project, clip.id)?.clip || clip;
    const track = T.findClip(store.project, clip.id)?.track;
    return { clip, words: `as clip ${clip.id} on ${track?.main ? 'the base track' : `track ${track?.id}`} at ${span(clip)}` };
  }

  /** Import a made file into the media library (no undo step yet): the asset. */
  async function importMade(file, origin) {
    const asset = await ctx.library.importFile(file, { origin });
    if (!asset) throw new Error(`Couldn't add ${file.name} to the media`);
    return asset;
  }

  /** The timeline being edited, and the compound clips opened in it. */
  const openedAt = () => [store.project.timelineId, ...store.nest.map((f) => f.id)].join('/');

  /**
   * Register an asset and do the rest of fn() as one undo step labeled label:
   * { entry, value }. fn() is skipped when the timeline open at the start of
   * the call (at) isn't the one open now.
   */
  function oneStep(label, asset, fn, at) {
    const mark = store.beginBatch();
    let value;
    try {
      store.update(`Add ${asset.name}`, (p) => {
        p.assets[asset.id] = asset;
      }, { structural: false });
      value = at && at !== openedAt() ? { clip: null, words: 'in the media library only, not on the timeline: another timeline was opened while it was being made' } : fn();
    } catch (err) {
      store.endBatch(mark, label);
      throw err;
    }
    return { entry: store.endBatch(mark, label), value };
  }

  /**
   * Wait on a generation, telling the chat how long it has run. When the user
   * stops the assistant meanwhile, what comes back still goes to the media
   * library (keep(result)), and the step reports skipped.
   */
  async function generating(control, label, work, keep) {
    const t0 = Date.now();
    control?.note?.(`${label}…`);
    const timer = setInterval(() => control?.note?.(`${label}… ${elapsed(Date.now() - t0)}`), 1000);
    let result;
    try {
      result = await work();
    } finally {
      clearInterval(timer);
    }
    if (control?.stopped?.()) {
      await keep(result);
      return null;
    }
    return result;
  }

  /** Made but stopped: the asset goes into the media library only, said so. */
  function keepMade(asset, what) {
    actions.registerAsset(asset);
    toast(`The ${what} you stopped has finished. It is in your media.`, { kind: 'success', duration: 6000 });
    return { skipped: true };
  }

  // Generated after a Stop: kept in the media library, said so.
  async function keepVideo({ blob }, prompt) {
    try {
      keepMade(await importMade(new File([blob], videoFileName(prompt, blob.type), { type: blob.type || 'video/mp4' }), 'ai-video'), 'video');
    } catch {
      /* nothing to keep */
    }
  }

  /** Make a video (opts as generateVideo's), import it and put it with put(asset): the tool's result. */
  async function makeVideo(control, { prompt, seconds, aspect, firstFrame, lastFrame, sound, avoid }, label, put, at) {
    // A model that can't start (or end) on a picture hands the clip to one that can.
    const chosen = videoModel(svc.videoModel());
    const { model, fallback } = modelForFrames(chosen, { first: Boolean(firstFrame || lastFrame), last: Boolean(firstFrame && lastFrame) });
    const s = store.project.settings;
    const shape = aspect || videoAspectFor(s.width, s.height).id;
    const len = fitSeconds(model, seconds ?? DEFAULT_SECONDS);
    const made = await generating(control, `Generating ${len ? `${len}s of ` : ''}video with ${model.label}`,
      () => svc.generateVideo({ prompt, model: model.id, seconds: len, aspect: shape, firstFrame, lastFrame, sound, negativePrompt: avoid, testMode: svc.testMode() }),
      (r) => keepVideo(r, prompt));
    if (!made) return { skipped: true };
    control?.note?.('Adding the video to the project…');
    const asset = await importMade(new File([made.blob], videoFileName(prompt, made.blob.type), { type: made.blob.type || 'video/mp4' }), 'ai-video');
    if (control?.stopped?.()) return keepMade(asset, 'video');
    const { entry, value } = oneStep(label, asset, () => put(asset), at);
    const clip = value?.clip || null;
    if (clip) store.select(clip.id);
    const length = asset.duration ? secs(asset.duration) : len ? `${len}s` : '';
    const how = fallback ? ` with ${model.label}, as ${chosen.label} can't ${firstFrame && lastFrame ? 'start and end on pictures' : 'start from a picture'}` : ` with ${model.label}`;
    return ok(`made a ${length ? `${length} ` : ''}video${how} (media ${asset.id}) and added it ${value?.words || 'to the media library'}.`, { changed: true, entry, target: clip ? { ids: [clip.id], time: clip.start } : null });
  }

  // ---- The tools ---------------------------------------------------------------

  const TOOLS = {
    get_project: () => ok(`${projectBrief(assistState(store))}\n\nMedia library:\n${mediaBrief(store.project)}`.replace(/^/, '\n')),
    list_media: () => ok(`\n${mediaBrief(store.project)}`),
    get_clip(a) {
      const f = oneClip(a.clip);
      if (f.error) return fail(f.error);
      return ok(`\n${clipDetails(store.project, f.clip, f.track)}`, { target: { ids: [f.clip.id], time: f.clip.start } });
    },

    async generate_video(a, control, at) {
      const prompt = str(a.prompt);
      if (!prompt) return fail('describe the video in prompt');
      let first = null;
      let last = null;
      if (a.first_frame || a.last_frame) control?.note?.('Capturing the pictures…');
      try {
        if (a.first_frame) first = (await pictureFrom(a.first_frame)).picture;
        if (a.last_frame) last = (await pictureFrom(a.last_frame)).picture;
      } catch (err) {
        return fail(err.message);
      }
      return makeVideo(control, { prompt, seconds: num(a.seconds), aspect: a.aspect, firstFrame: first, lastFrame: last, sound: typeof a.sound === 'boolean' ? a.sound : undefined, avoid: str(a.avoid, 500) }, 'Generate video',
        (asset) => place(asset, { place: a.place, start: a.start }), at);
    },

    async animate_image(a, control, at) {
      const f = oneClip(a.clip, (c) => c.type === 'image', 'image clip');
      if (f.error) return fail(f.error);
      const prompt = str(a.prompt);
      if (!prompt) return fail('describe the motion in prompt');
      const id = f.clip.id;
      control?.note?.('Capturing the picture…');
      let picture;
      try {
        picture = await svc.picture(f.clip, f.clip.start);
      } catch (err) {
        return fail(err.message);
      }
      const seconds = Number.isFinite(num(a.seconds)) ? num(a.seconds) : f.clip.duration / US;
      return makeVideo(control, { prompt, seconds, firstFrame: picture, sound: typeof a.sound === 'boolean' ? a.sound : undefined }, 'Animate picture', (asset) => {
        const now = T.findClip(store.project, id);
        if (!now || now.track.locked) return place(asset, { place: 'end' });
        store.update('Animate picture', (p) => {
          const c = T.findClip(p, id)?.clip;
          if (!c) return false;
          Object.assign(c, { type: 'video', assetId: asset.id, name: asset.name, in: 0, speed: 1, freeze: false, reversed: false });
          delete c.speedCurve;
          if (asset.duration) T.trimClip(p, id, 'end', c.start + asset.duration, { ...store.opts, ripple: true });
        });
        const clip = T.findClip(store.project, id)?.clip;
        return { clip, words: `in place of the picture, as clip ${id} at ${clip ? span(clip) : ''}` };
      }, at);
    },

    async extend_clip(a, control, at) {
      const f = oneClip(a.clip, (c) => c.type === 'video' || c.type === 'image', 'video or image clip');
      if (f.error) return fail(f.error);
      const prompt = str(a.prompt);
      if (!prompt) return fail('describe what happens next in prompt');
      const { clip, track } = f;
      control?.note?.('Capturing the last frame…');
      let picture;
      try {
        picture = await svc.picture(clip, clip.start + clip.duration);
      } catch (err) {
        return fail(err.message);
      }
      const full = `Continue this shot without a cut: ${prompt}. Keep the same subjects, look, lighting and camera style.`;
      return makeVideo(control, { prompt: full, seconds: num(a.seconds), firstFrame: picture, sound: typeof a.sound === 'boolean' ? a.sound : undefined }, 'Extend clip', (asset) => {
        if (track.main) return place(asset, { place: 'after', afterId: clip.id });
        const now = T.findClip(store.project, clip.id)?.clip || clip;
        return place(asset, { place: 'overlay', start: T.clipEnd(now) / US, trackId: track.id });
      }, at);
    },

    async generate_transition(a, control, at) {
      const f = oneClip(a.after_clip, (c) => c.type === 'video' || c.type === 'image', 'video or image clip');
      if (f.error) return fail(f.error);
      if (!f.track.main) return fail('AI transitions go between clips on the base track');
      const next = T.nextAdjacent(store.project, f.clip.id);
      if (!next || (next.type !== 'video' && next.type !== 'image')) return fail(`no video or image clip follows ${f.clip.id} directly on the base track`);
      control?.note?.('Capturing both shots…');
      let from;
      let to;
      try {
        from = await svc.picture(f.clip, f.clip.start + f.clip.duration);
        to = await svc.picture(next, next.start);
      } catch (err) {
        return fail(err.message);
      }
      const { model } = modelForFrames(svc.videoModel(), { first: true, last: true });
      const shortest = !model.seconds ? null : Array.isArray(model.seconds) ? model.seconds[0] : model.seconds.min;
      const prompt = `A seamless cinematic transition that morphs the first shot into the second. ${str(a.prompt) || 'Smooth camera movement, continuous motion, no cut.'}`;
      const id = f.clip.id;
      return makeVideo(control, { prompt, seconds: Number.isFinite(num(a.seconds)) ? num(a.seconds) : shortest ?? undefined, firstFrame: from, lastFrame: to }, 'AI transition', (asset) => place(asset, { place: 'after', afterId: id }), at);
    },

    async generate_image(a, control, at) {
      const prompt = str(a.prompt, 1000);
      if (!prompt) return fail('describe the picture in prompt');
      const s = store.project.settings;
      const aspect = IMAGE_ASPECTS.some((x) => x.id === a.aspect) ? a.aspect : aspectForSize(s.width, s.height).id;
      const style = IMAGE_STYLES.some((x) => x.id === a.style) ? a.style : 'none';
      const made = await generating(control, 'Generating the picture', () => svc.generateImage(prompt, { aspect, style, model: svc.imageModel(), testMode: svc.testMode() }), async (r) => {
        const asset = await importMade(new File([r.blob], imageFileName(prompt), { type: r.blob.type || 'image/png' }), 'ai-image').catch(() => null);
        if (asset) actions.registerAsset(asset);
      });
      if (!made) return { skipped: true };
      const asset = await importMade(new File([made.blob], imageFileName(prompt, (made.blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg')), { type: made.blob.type || 'image/png' }), 'ai-image');
      if (control?.stopped?.()) return keepMade(asset, 'picture');
      const duration = Number.isFinite(num(a.duration)) ? Math.round(Math.max(0.2, num(a.duration)) * US) : 0;
      const { entry, value } = oneStep('Generate picture', asset, () => place(asset, { place: a.place, start: a.start, duration }), at);
      if (value.clip) store.select(value.clip.id);
      return ok(`made a picture (media ${asset.id}) and added it ${value.words}.`, { changed: true, entry, target: value.clip ? { ids: [value.clip.id], time: value.clip.start } : null });
    },

    async edit_image(a, control, at) {
      const instruction = str(a.instruction, 600);
      if (!instruction) return fail('describe the change in instruction');
      control?.note?.('Capturing the picture…');
      let got;
      try {
        got = await pictureFrom(a.source);
      } catch (err) {
        return fail(err.message);
      }
      const made = await generating(control, 'Editing the picture', () => svc.editPicture(got.picture, instruction, { model: svc.imageModel(), testMode: svc.testMode() }), async () => {});
      if (!made) return { skipped: true };
      const base = got.clip ? got.clip.name || store.project.assets[got.clip.assetId]?.name : 'Picture';
      const asset = await importMade(new File([made.blob], imageFileName(`${String(base || 'Picture').replace(/\.[a-z0-9]{2,5}$/i, '')} edited`), { type: made.blob.type || 'image/png' }), 'ai-image');
      if (control?.stopped?.()) return keepMade(asset, 'picture');
      const inPlace = got.clip?.type === 'image' && a.replace !== false;
      const sourceClip = got.clip;
      const { entry, value } = oneStep('Edit picture', asset, () => {
        if (inPlace && replacePicture(ctx, sourceClip.id, asset)) {
          const clip = T.findClip(store.project, sourceClip.id)?.clip;
          return { clip, words: `in place of the picture of clip ${sourceClip.id}` };
        }
        return place(asset, { place: a.place || 'overlay', start: a.start ?? (sourceClip ? sourceClip.start / US : store.time / US) });
      }, at);
      if (value.clip) store.select(value.clip.id);
      return ok(`changed the picture from ${got.from} (new media ${asset.id}) and put it ${value.words}.`, { changed: true, entry, target: value.clip ? { ids: [value.clip.id], time: value.clip.start } : null });
    },

    async add_voiceover(a, control, at) {
      const text = str(a.text, 3000);
      if (!text) return fail('give the words to speak in text');
      const voice = TTS_VOICES.some((v) => v.id === a.voice) ? a.voice : TTS_VOICES[0].id;
      const blob = await generating(control, 'Recording the voice', () => svc.synthesize(text, voice, { testMode: svc.testMode() }), async () => {});
      if (!blob) return { skipped: true };
      const asset = await importMade(speechFile(blob, text), 'tts');
      if (control?.stopped?.()) return keepMade(asset, 'voiceover');
      const { entry, value } = oneStep('Add voiceover', asset, () => place(asset, { start: a.start }), at);
      return ok(`added the voiceover (media ${asset.id}) ${value.words}.`, { changed: true, entry, target: value.clip ? { ids: [value.clip.id], time: value.clip.start } : null });
    },

    add_media_to_timeline(a) {
      const asset = store.project.assets[str(a.media, 80)];
      if (!asset) return fail(`there is no media ${str(a.media, 80) || '(none named)'} in the library (call list_media)`);
      const duration = Number.isFinite(num(a.duration)) ? Math.round(Math.max(0.2, num(a.duration)) * US) : 0;
      const mark = store.beginBatch();
      let value;
      try {
        value = place(asset, { place: a.place === 'media' ? 'end' : a.place, start: a.start, duration });
      } catch (err) {
        store.endBatch(mark, `Add ${asset.name}`);
        throw err;
      }
      const entry = store.endBatch(mark, `Add ${asset.name}`);
      if (!value.clip) return fail(`there was no room for ${asset.name} on the timeline`);
      store.select(value.clip.id);
      return ok(`added media ${asset.id} ${value.words}.`, { changed: true, entry, target: { ids: [value.clip.id], time: value.clip.start } });
    },
  };

  /** Perform one call: { ok, content, changed, entry, target } (or { skipped } once stopped). */
  async function run(name, args = {}, control = null) {
    const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
    if (isEditTool(name)) {
      const label = stepLabel(describeCall(name, a).label).replace(/^Assistant: /, 'AI: ');
      ctx.player?.pause?.();
      const { results, entry } = await edits.run([{ name, args: a }], { label, signal: control?.signal, onProgress: (t) => control?.note?.(t) });
      const r = results[0];
      if (!r) return control?.stopped?.() ? { skipped: true } : fail('nothing was done');
      if (!r.ok) return fail(r.text.replace(/^[^:]+:\s*/, ''));
      const ids = (r.ids || []).filter((id) => T.findClip(store.project, id));
      const time = ids.length ? Math.min(...ids.map((id) => T.findClip(store.project, id).clip.start)) : null;
      return ok(`${r.text}${ids.length ? ` [${ids.slice(0, 20).join(', ')}]` : ''}.`, { changed: Boolean(entry), entry, target: ids.length ? { ids, time } : name === 'move_playhead' ? { ids: [], time: store.time } : null });
    }
    const tool = TOOLS[name];
    if (!tool) return fail(`there is no tool called ${name}`);
    try {
      if (VIDEO_PAUSE.has(name)) ctx.player?.pause?.();
      return await tool(a, control, openedAt());
    } catch (err) {
      if (err?.name === 'AbortError') return { skipped: true };
      console.error(err);
      return fail(err?.message || 'something went wrong');
    }
  }

  return { run };
}

const VIDEO_PAUSE = new Set(['animate_image', 'extend_clip', 'generate_transition', 'edit_image']);
