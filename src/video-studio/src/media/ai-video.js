/**
 * Video from a description, or from a picture, through Puter AI
 * (puter.ai.txt2vid). A clip can start from a picture (image to video),
 * end on one (a bridge between two shots), or both.
 *
 * The provider's address for the clip is temporary and may not allow the
 * browser to read it, so the clip is written into the app's own folder in
 * Puter first (puter_output_path), read from there and the copy removed;
 * where that is refused, the address is read directly.
 *
 * txt2vid, the file system and fetch are injectable for tests.
 */
import { dataUrlToBlob } from './imagegen.js';
import { blobToDataUri } from './restyle.js';
import { errorMessage } from './transcribe.js';

export const VIDEO_PROMPT_MAX = 1500;

/**
 * The video models offered in the assistant's settings, newest and best
 * first (from Puter's catalog). t2v is used for a clip from words alone,
 * i2v when a first frame goes with it (null: the model works from words
 * only, and a clip that starts from a picture is made with
 * FRAME_FALLBACK instead). endFrame: it can also end on a picture.
 * seconds: the lengths it makes ({ min, max }, a list of choices, or null
 * when the model picks). res: the short side asked for. centsPerSecond:
 * Puter's price, for the estimate shown before a clip is made.
 *
 * The ids of the first three models offered (wan, seedance, veo) are kept,
 * as settings remember them.
 */
export const VIDEO_MODELS = [
  {
    id: 'seedance25',
    label: 'Seedance 2.5',
    hint: 'Newest, up to 30 s, sound',
    t2v: 'dreamina-seedance-2-5-260628',
    i2v: 'dreamina-seedance-2-5-260628',
    endFrame: true,
    seconds: { min: 4, max: 30 },
    res: 1080,
    centsPerSecond: 23.2,
  },
  {
    id: 'veo31',
    label: 'Veo 3.1',
    hint: 'Top quality, sound',
    t2v: 'togetherai:google/veo-3.1',
    i2v: 'togetherai:google/veo-3.1',
    endFrame: true,
    seconds: [4, 6, 8],
    res: 1080,
    centsPerSecond: 60,
  },
  {
    id: 'seedance20',
    label: 'Seedance 2.0',
    hint: 'Up to 15 s, sound',
    t2v: 'dreamina-seedance-2-0-260128',
    i2v: 'dreamina-seedance-2-0-260128',
    endFrame: true,
    seconds: { min: 4, max: 15 },
    res: 1080,
    centsPerSecond: 15.2,
  },
  {
    id: 'happyhorse11',
    label: 'HappyHorse 1.1',
    hint: 'Starts from a picture',
    t2v: 'togetherai:alibaba/happyhorse-1.1-t2v',
    i2v: 'togetherai:alibaba/happyhorse-1.1-i2v',
    endFrame: false,
    seconds: null,
    res: 1080,
    centsPerSecond: 18,
  },
  {
    id: 'minimaxh3',
    label: 'MiniMax H3',
    hint: '2K, from words only',
    t2v: 'togetherai:minimaxai/minimax-h3',
    i2v: null,
    endFrame: false,
    seconds: null,
    res: 1080,
    centsPerSecond: 13.91,
  },
  {
    id: 'flux3',
    label: 'FLUX 3',
    hint: 'From words only',
    t2v: 'togetherai:black-forest-labs/flux-3',
    i2v: null,
    endFrame: false,
    seconds: null,
    res: 1080,
    centsPerSecond: 29,
  },
  {
    id: 'wan',
    label: 'Wan 2.7',
    hint: 'Cheapest, 2 to 15 s',
    t2v: 'togetherai:wan-ai/wan2.7-t2v',
    i2v: 'togetherai:wan-ai/wan2.7-i2v',
    endFrame: true,
    seconds: { min: 2, max: 15 },
    res: 1080,
    centsPerSecond: 2,
  },
  {
    id: 'seedance',
    label: 'Seedance 2.0 Mini',
    hint: 'Fast, low cost',
    t2v: 'dreamina-seedance-2-0-mini-260615',
    i2v: 'dreamina-seedance-2-0-mini-260615',
    endFrame: true,
    seconds: { min: 4, max: 15 },
    res: 720,
    centsPerSecond: 7.6,
  },
  {
    id: 'veo',
    label: 'Veo 3.1 Lite',
    hint: 'With sound, 4, 6 or 8 s',
    t2v: 'togetherai:google/veo-3.1-lite',
    i2v: 'togetherai:google/veo-3.1-lite',
    endFrame: true,
    seconds: [4, 6, 8],
    res: 720,
    centsPerSecond: 8,
  },
];
export const DEFAULT_VIDEO_MODEL = 'seedance25';
/** The model a clip that starts or ends on a picture is made with when the chosen one can't. */
export const FRAME_FALLBACK = 'seedance25';
export const DEFAULT_SECONDS = 5;

/** Frame shapes, by their 720p size; models that take no size use their own. */
export const VIDEO_ASPECTS = [
  { id: '16:9', w: 1280, h: 720 },
  { id: '9:16', w: 720, h: 1280 },
  { id: '1:1', w: 720, h: 720 },
  { id: '4:3', w: 960, h: 720 },
  { id: '3:4', w: 720, h: 960 },
];

export const videoModel = (id) => VIDEO_MODELS.find((m) => m.id === id) || VIDEO_MODELS[0];

/**
 * The model a clip is made with: the chosen one, unless the clip starts on a
 * picture it can't start from (or ends on one it can't end on): then
 * FRAME_FALLBACK. { model, fallback }.
 */
export function modelForFrames(id, { first = false, last = false } = {}) {
  const m = typeof id === 'string' ? videoModel(id) : id;
  const needsFirst = first || last;
  if ((needsFirst && !m.i2v) || (last && !m.endFrame)) return { model: videoModel(FRAME_FALLBACK), fallback: true };
  return { model: m, fallback: false };
}

/** The video shape closest to a width and height (a project's frame). */
export function videoAspectFor(width, height) {
  const r = width / height;
  return VIDEO_ASPECTS.reduce((best, a) => (Math.abs(Math.log(a.w / a.h / r)) < Math.abs(Math.log(best.w / best.h / r)) ? a : best), VIDEO_ASPECTS[0]);
}

/** A length the model makes: the nearest of its choices, or within its range; null when the model picks its own. */
export function fitSeconds(model, seconds) {
  const m = typeof model === 'string' ? videoModel(model) : model;
  if (!m.seconds) return null;
  const want = Number.isFinite(Number(seconds)) && Number(seconds) > 0 ? Number(seconds) : DEFAULT_SECONDS;
  if (Array.isArray(m.seconds)) return m.seconds.reduce((best, s) => (Math.abs(s - want) < Math.abs(best - want) ? s : best), m.seconds[0]);
  return Math.round(Math.min(m.seconds.max, Math.max(m.seconds.min, want)));
}

/** About what a clip costs, in US cents, at Puter's price for the model (a model that picks its length is counted at 5 s). */
export function estimateCents(model, seconds) {
  const m = typeof model === 'string' ? videoModel(model) : model;
  return Math.round(m.centsPerSecond * (fitSeconds(m, seconds) ?? DEFAULT_SECONDS));
}

/** What the assistant is told of the chosen model: "Seedance 2.5 (4 to 30 s; starts and ends on pictures; about 23¢ a second)". */
export function modelSummary(id) {
  const m = videoModel(id);
  const len = !m.seconds ? 'length picked by the model' : Array.isArray(m.seconds) ? `${m.seconds.join(', ')} s` : `${m.seconds.min} to ${m.seconds.max} s`;
  const frames = !m.i2v ? `words only, clips from a picture are made with ${videoModel(FRAME_FALLBACK).label}` : m.endFrame ? 'starts and ends on pictures' : 'starts from a picture';
  return `${m.label} (${len}; ${frames}; about ${formatCents(m.centsPerSecond)} a second)`;
}

/** "$1.16" for 116 cents, "23¢" under a dollar. */
export const formatCents = (cents) => (cents < 99.5 ? `${Math.max(1, Math.round(cents))}¢` : `$${(cents / 100).toFixed(2)}`);

/**
 * Options for puter.ai.txt2vid. firstFrame and lastFrame are data URIs (or
 * web addresses); a last frame without a first one is sent as the first, as
 * the models need one to end on another. A model that can't start from a
 * picture is swapped for FRAME_FALLBACK (modelForFrames). aspect applies to
 * clips from words alone; one from a picture has the picture's shape.
 */
export function txt2vidOptions({ prompt, model = DEFAULT_VIDEO_MODEL, seconds, aspect = '16:9', firstFrame = null, lastFrame = null, sound, negativePrompt = '', outputPath = null, testMode = false } = {}) {
  const first = firstFrame || null;
  const { model: m } = modelForFrames(model, { first: Boolean(first), last: Boolean(first && lastFrame) });
  const a = VIDEO_ASPECTS.find((x) => x.id === aspect) || VIDEO_ASPECTS[0];
  const k = (m.res || 720) / 720;
  const even = (v) => Math.round((v * k) / 2) * 2;
  const out = {
    prompt: String(prompt || '').trim().slice(0, VIDEO_PROMPT_MAX),
    model: first ? m.i2v : m.t2v,
    // A clip from a picture takes the picture's shape: only the resolution is asked for. A size in pixels
    // carries a ratio too, which Seedance refuses beside a first frame ("the output ratio follows the
    // first-frame image").
    size: first ? `${m.res || 720}p` : `${even(a.w)}x${even(a.h)}`,
  };
  const len = fitSeconds(m, seconds);
  if (len != null) out.seconds = len;
  if (first) out.input_reference = first;
  if (first && lastFrame && m.endFrame) out.last_frame = lastFrame;
  if (typeof sound === 'boolean') out.generate_audio = sound;
  const neg = String(negativePrompt || '').trim().slice(0, 500);
  if (neg) out.negative_prompt = neg;
  if (outputPath) out.puter_output_path = outputPath;
  if (testMode) out.test_mode = true;
  return out;
}

/** A user-facing message for a failed request, by the codes txt2vid gives. */
export function videoErrorMessage(err) {
  const code = String(err?.code || err?.error?.code || '');
  const why = String(err?.errorCode || err?.error?.errorCode || '');
  if (why === 'moderation_flagged' || code === 'moderation_flagged') return 'The request was declined by the content filter. Try a different description or picture.';
  if (code === 'insufficient_funds') return 'Your Puter balance is too low to make this video. A shorter clip may fit.';
  if (code === 'upstream_timeout') return 'The video took too long to make. Try again, or ask for a shorter clip.';
  if (code === 'upstream_failed') return 'The video service could not make this clip. Try again.';
  if (code === 'prompt_required') return 'Describe the video first.';
  if (code === 'network_error' || code === 'request_timeout' || err instanceof TypeError) return 'The AI service could not be reached. Check your connection and try again.';
  return errorMessage(err, "Couldn't make the video. Try again.");
}

/** A short file name from the description: "a fox in the snow" -> "a fox in the snow.mp4". */
export function videoFileName(prompt, type = 'video/mp4') {
  const stem = String(prompt || '').replace(/[\\/:*?"<>|\n\r]+/g, ' ').replace(/\s+/g, ' ').trim().split(' ').slice(0, 6).join(' ').slice(0, 48).trim();
  const ext = /webm/.test(type) ? 'webm' : /quicktime/.test(type) ? 'mov' : 'mp4';
  return `${stem || 'Generated video'}.${ext}`;
}

const isWriteRefusal = (err) => /^(access_denied|cannot_write_to_root|forbidden)$/.test(String(err?.code || err?.error?.code || ''));

/** The address of what txt2vid returned (an element, or an object with src). */
function sourceOf(result) {
  if (typeof result === 'string') return result;
  return result?.currentSrc || result?.src || result?.getAttribute?.('src') || '';
}

/** The clip's bytes: the saved copy when there is one, the data URI, or the address read directly. */
export async function videoBlobFrom(result, { savedPath = null, fs = null, fetchFn = globalThis.fetch } = {}) {
  let blob = null;
  if (savedPath && fs?.read) {
    try {
      blob = await fs.read(savedPath);
    } catch {
      blob = null;
    }
    // The copy has done its work once read: the media library stores its own.
    Promise.resolve(fs.delete?.(savedPath)).catch(() => {});
  }
  if (!blob?.size) {
    const src = sourceOf(result);
    if (!src) throw new Error('No video came back. Try again.');
    blob = dataUrlToBlob(src);
    if (!blob) {
      let res;
      try {
        res = await fetchFn(src, { mode: 'cors', credentials: 'omit' });
      } catch {
        throw new Error("The video was made but couldn't be downloaded.");
      }
      if (!res?.ok) throw new Error("The video was made but couldn't be downloaded.");
      blob = await res.blob();
    }
  }
  if (!blob?.size) throw new Error('The video came back empty.');
  const declared = String(result?.getAttribute?.('data-mime-type') || result?.dataset?.mimeType || '');
  if (blob.type && !blob.type.startsWith('video/') && blob.type !== 'application/octet-stream') throw new Error('The answer was not a video.');
  if (!blob.type || blob.type === 'application/octet-stream') blob = new Blob([blob], { type: declared.startsWith('video/') ? declared : 'video/mp4' });
  return blob;
}

/** A picture (Blob) as a data URI for input_reference / last_frame. */
export async function frameReference(picture) {
  if (!picture) return null;
  const blob = picture instanceof Blob ? picture : picture.blob;
  return blob ? blobToDataUri(blob) : null;
}

let tempSeq = 0;
const TEMP_DIR = '.ai-temp';
// Named by when the generation started, which is how old copies are told apart (see cleanAiTemp).
const tempPath = () => `video-studio/${TEMP_DIR}/${Date.now().toString(36)}-${(++tempSeq).toString(36)}.mp4`;
/** Copies being made by generations running in this tab. */
const tempsInUse = new Set();
/** A copy left this long ago was abandoned: no generation takes a day. */
export const TEMP_MAX_AGE = 24 * 60 * 60 * 1000;

/**
 * Delete the copies Puter wrote for generations that never collected them (the page closed while a clip was being
 * made): each is a whole paid-for video left in video-studio/.ai-temp. Only copies older than maxAge go, never one a
 * generation in this tab is still waiting on. backend is the library's (paths under video-studio/). Returns how many
 * were deleted.
 */
export async function cleanAiTemp(backend, { now = Date.now(), maxAge = TEMP_MAX_AGE } = {}) {
  let removed = 0;
  for (const item of await backend.list(TEMP_DIR)) {
    if (item.isDir || tempsInUse.has(`video-studio/${TEMP_DIR}/${item.name}`)) continue;
    const named = /^([0-9a-z]+)-[0-9a-z]+\.[a-z0-9]+$/.exec(item.name);
    const started = named ? parseInt(named[1], 36) : NaN;
    // Puter gives times in seconds.
    const modified = Number(item.modified) > 0 ? (item.modified < 1e12 ? item.modified * 1000 : item.modified) : NaN;
    const at = Number.isFinite(started) && started > 0 ? started : modified;
    if (!Number.isFinite(at) || now - at <= maxAge) continue;
    await backend.remove(`${TEMP_DIR}/${item.name}`).then(() => removed++, () => {});
  }
  return removed;
}

const defaultTxt2vid = (options) => {
  if (typeof puter === 'undefined' || !puter.ai?.txt2vid) throw new Error('Video generation needs Puter.');
  return puter.ai.txt2vid(options);
};
const defaultFs = () => (typeof puter !== 'undefined' ? puter.fs : null);

/**
 * Make a clip: { blob, prompt, options }. opts are txt2vidOptions' (with
 * firstFrame / lastFrame as Blobs or { blob } pictures). Throws Errors with
 * readable messages.
 */
export async function generateVideo(opts = {}, { txt2vid = defaultTxt2vid, fs = defaultFs(), fetchFn } = {}) {
  const prompt = String(opts.prompt || '').trim();
  if (!prompt) throw new Error('Describe the video first.');
  const firstFrame = await frameReference(opts.firstFrame);
  const lastFrame = await frameReference(opts.lastFrame);
  const savedPath = fs?.read ? tempPath() : null;
  const base = { ...opts, prompt, firstFrame: firstFrame || lastFrame, lastFrame: firstFrame ? lastFrame : null };
  let options = txt2vidOptions({ ...base, outputPath: savedPath });
  if (savedPath) tempsInUse.add(savedPath);
  try {
    let result;
    try {
      result = await txt2vid(options);
    } catch (err) {
      // A folder the service may not write to: asked again without the copy (it is refused before a clip is made).
      if (!savedPath || !isWriteRefusal(err)) throw new Error(videoErrorMessage(err), { cause: err });
      options = txt2vidOptions(base);
      try {
        result = await txt2vid(options);
      } catch (again) {
        throw new Error(videoErrorMessage(again), { cause: again });
      }
    }
    const blob = await videoBlobFrom(result, { savedPath: options.puter_output_path || null, fs, fetchFn });
    return { blob, prompt, options };
  } finally {
    if (savedPath) tempsInUse.delete(savedPath);
  }
}
