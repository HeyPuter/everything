/**
 * The AI sidebar's tools: what the model may call, as OpenAI-style function
 * schemas, and how each call reads as a line in the chat ("Generate a 5s
 * video", "Trim "Intro" by 2.0s"). Nothing here touches the page or the
 * project; ui/ai-tool-runner.js performs the calls.
 *
 * Three groups:
 *  - looking: get_project, list_media, get_clip (change nothing)
 *  - editing: the edit assistant's tools (media/edit-assistant.js), checked
 *    and clamped there and performed by ui/assistant-actions.js
 *  - making: video from words or a picture, extending a clip, an AI bridge
 *    between two shots, pictures, picture edits and voiceover through Puter
 *    AI. Video costs the most: those calls are the ones the default approval
 *    mode asks about.
 *
 * A picture source (first_frame, last_frame, source) names where a picture
 * comes from: an image's media id, an image clip id, a video clip id with
 * "@first", "@last" or "@<seconds on the timeline>" (a bare video clip id is
 * its frame at the playhead when the playhead is on it, else its first
 * frame), or "playhead" for the whole frame at the playhead as the player
 * shows it.
 */
import { TOOLS as EDIT_TOOLS, CLIP_WORDS, secs, projectBrief } from './edit-assistant.js';
import { VIDEO_ASPECTS, VIDEO_PROMPT_MAX, modelForFrames, fitSeconds, estimateCents, formatCents } from './ai-video.js';
import { IMAGE_ASPECTS, IMAGE_STYLES } from './imagegen.js';
import { TTS_VOICES } from './tts.js';

const obj = (properties, required = []) => ({ type: 'object', properties, required });
const SECONDS = (what) => ({ type: 'number', description: `${what}, in seconds` });
const CLIP = { type: 'string', description: 'One clip id from the project state (or "selected", "first", "last").' };
const PICTURE = (what) => ({
  type: 'string',
  description: `${what}: an image's media id, an image clip id, a video clip id with @first, @last or @<seconds on the timeline> (e.g. "c4k2m9x1@last"), or "playhead" for the whole frame at the playhead.`,
});
const PLACE = {
  type: 'string',
  enum: ['end', 'playhead', 'after_selected', 'overlay', 'media'],
  description: 'Where the result goes: end (after the last clip of the base track, the default), playhead (into the base track at the cut nearest the playhead), after_selected (into the base track right after the selected clip), overlay (on a track above, from start), media (only into the media library).',
};

/** The tools that only look. */
export const READ_TOOLS = new Set(['get_project', 'list_media', 'get_clip']);
/** The tools that make video through Puter AI: the costly ones. */
export const VIDEO_TOOLS = new Set(['generate_video', 'animate_image', 'extend_clip', 'generate_transition']);
/** The tools that make other media through Puter AI (pictures, speech). */
export const MEDIA_TOOLS = new Set(['generate_image', 'edit_image', 'add_voiceover']);

const MAKE_TOOLS = [
  {
    name: 'get_project',
    description: 'Read the whole project as it is now: settings, every track and clip with its id, the selection, markers. Each message comes with a shorter version of this; call it after changes or when the clips you need are not listed.',
    parameters: obj({}),
  },
  {
    name: 'list_media',
    description: 'List the media library: each video, image and audio file with its media id, length, size, whether it was generated, and how many clips use it.',
    parameters: obj({}),
  },
  {
    name: 'get_clip',
    description: 'Read every setting of one clip (timing, source range, speed, transform, color, filter, effects, animations, text style).',
    parameters: obj({ clip: CLIP }, ['clip']),
  },
  {
    name: 'generate_video',
    description: 'Make a new video clip with Puter AI from a description, optionally starting from a picture (image to video) and/or ending on one. Takes from about half a minute to a few minutes, and costs the user Puter credits by its length.',
    parameters: obj({
      prompt: { type: 'string', description: 'What happens in the clip: subject, action, setting, camera movement, lighting and mood. With a first frame, describe the motion from that picture.' },
      seconds: SECONDS('Length (default 5; the model rounds to what it makes)'),
      aspect: { type: 'string', enum: VIDEO_ASPECTS.map((a) => a.id), description: 'Frame shape (default: the project\'s)' },
      first_frame: PICTURE('The picture the clip starts from'),
      last_frame: PICTURE('The picture the clip ends on (needs first_frame)'),
      sound: { type: 'boolean', description: 'Generate a soundtrack, on models that can (default: the model\'s own)' },
      avoid: { type: 'string', description: 'Things to keep out of the clip (a negative prompt)' },
      place: PLACE,
      start: SECONDS('Start time for place=overlay or place=playhead (default: the playhead)'),
    }, ['prompt']),
  },
  {
    name: 'animate_image',
    description: 'Turn an image clip into a video clip that starts from its picture and moves as described, in its place on the timeline (keeping its position, look and effects). Costs Puter credits.',
    parameters: obj({
      clip: CLIP,
      prompt: { type: 'string', description: 'The motion: what moves and how, camera movement, mood.' },
      seconds: SECONDS('Length (default: the image clip\'s, within what the model makes)'),
      sound: { type: 'boolean' },
    }, ['clip', 'prompt']),
  },
  {
    name: 'extend_clip',
    description: 'Make the shot go on: a new clip that starts from the last frame of a video or image clip and continues as described, put right after it. Costs Puter credits.',
    parameters: obj({
      clip: CLIP,
      prompt: { type: 'string', description: 'What happens next, continuing the shot.' },
      seconds: SECONDS('Length of the new part (default 5)'),
      sound: { type: 'boolean' },
    }, ['clip', 'prompt']),
  },
  {
    name: 'generate_transition',
    description: 'Make a short AI shot that morphs from the last frame of a base track clip into the first frame of the clip after it, and put it between them. Costs Puter credits.',
    parameters: obj({
      after_clip: CLIP,
      prompt: { type: 'string', description: 'How the first shot becomes the second (e.g. "the camera flies through the window into the next scene"). Optional.' },
      seconds: SECONDS('Length (default: the shortest the model makes)'),
    }, ['after_clip']),
  },
  {
    name: 'generate_image',
    description: 'Make a picture with Puter AI and add it as an image clip (a backdrop, a title card, a still to animate later).',
    parameters: obj({
      prompt: { type: 'string', description: 'What the picture shows.' },
      aspect: { type: 'string', enum: IMAGE_ASPECTS.map((a) => a.id), description: 'Shape (default: the project\'s)' },
      style: { type: 'string', enum: IMAGE_STYLES.map((s) => s.id) },
      place: PLACE,
      start: SECONDS('Start time for place=overlay or place=playhead (default: the playhead)'),
      duration: SECONDS('How long the image clip lasts (default: the editor\'s image length)'),
    }, ['prompt']),
  },
  {
    name: 'edit_image',
    description: 'Change a picture as described with Puter AI ("make it night", "remove the car", "add snow"). From an image clip it replaces that clip\'s picture (unless replace is false); from a video frame or media it makes a new image clip.',
    parameters: obj({
      source: PICTURE('The picture to change'),
      instruction: { type: 'string', description: 'The change to make.' },
      replace: { type: 'boolean', description: 'For an image clip: show the new picture in that clip (default true). False adds it as a new clip.' },
      place: PLACE,
      start: SECONDS('Start time for a new clip with place=overlay or place=playhead'),
    }, ['source', 'instruction']),
  },
  {
    name: 'add_voiceover',
    description: 'Speak a text with a text-to-speech voice and put it on an audio track.',
    parameters: obj({
      text: { type: 'string', description: 'What the voice says (up to 3000 characters).' },
      voice: { type: 'string', enum: TTS_VOICES.map((v) => v.id), description: 'Voice (default: the first)' },
      start: SECONDS('Where the speech starts (default: the playhead)'),
    }, ['text']),
  },
  {
    name: 'add_media_to_timeline',
    description: 'Put media from the library (an attached file, or something made with place=media) on the timeline.',
    parameters: obj({
      media: { type: 'string', description: 'A media id from list_media or an attachment.' },
      place: PLACE,
      start: SECONDS('Start time for place=overlay or place=playhead (default: the playhead)'),
      duration: SECONDS('Length for an image (default: the editor\'s image length)'),
    }, ['media']),
  },
];

/** Every tool, in the order the model is shown them. */
export const TOOLS = [...MAKE_TOOLS.slice(0, 3), ...EDIT_TOOLS.map(({ name, description, parameters }) => ({ name, description, parameters })), ...MAKE_TOOLS.slice(3)];
export const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));
const EDIT_NAMES = new Set(EDIT_TOOLS.map((t) => t.name));
export const isEditTool = (name) => EDIT_NAMES.has(name);

/** The tools as OpenAI-style function definitions for puter.ai.chat({ tools }). */
export function toolSpecs() {
  return TOOLS.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

/** Whether a call changes the project (selecting and moving the playhead change only the view). */
export function changesProject(name) {
  return TOOL_NAMES.has(name) && !READ_TOOLS.has(name) && name !== 'select_clips' && name !== 'move_playhead';
}

/** Whether a call spends the user's credits on video. */
export const costly = (name) => VIDEO_TOOLS.has(name);

/* ---------- How a call reads in the chat ---------- */

const quote = (s, max = 40) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return `"${t.length > max ? `${t.slice(0, max - 1)}…` : t}"`;
};
const num = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
const sec = (v) => (Number.isFinite(num(v)) ? secs(Math.round(num(v) * 1_000_000)) : '');
const count = (list, word) => {
  const l = Array.isArray(list) ? list : list == null ? [] : [list];
  if (l.length === 1 && CLIP_WORDS[String(l[0]).toLowerCase()]) return CLIP_WORDS[String(l[0]).toLowerCase()];
  if (l.length === 1) return `clip ${l[0]}`;
  return `${l.length} ${word}s`;
};

const LABELS = {
  get_project: () => 'Read the project',
  list_media: () => 'List the media',
  get_clip: (a) => `Read clip ${a.clip ?? ''}`.trim(),
  split: (a) => `Split at ${sec(a.time) || 'a time'}`,
  delete_clips: (a) => `Delete ${count(a.clips, 'clip')}`,
  remove_time_range: (a) => `Cut out ${sec(a.start)} to ${sec(a.end)}`,
  trim_clip: (a) => `Trim ${count(a.clip, 'clip')}`,
  move_clip: (a) => `Move ${count(a.clip, 'clip')} to ${sec(a.start)}`,
  duplicate_clips: (a) => `Duplicate ${count(a.clips, 'clip')}`,
  set_speed: (a) => `Set ${count(a.clips, 'clip')} to ${a.speed}x speed`,
  add_text: (a) => `Add text ${quote(a.text)}`,
  edit_text: (a) => `Edit ${count(a.clips, 'text clip')}`,
  set_filter: (a) => `Apply the ${a.filter} filter`,
  add_effect: (a) => `Add the ${a.effect} effect`,
  set_transition: (a) => `Add the ${a.transition} transition`,
  set_animation: (a) => `Set the ${a.kind || ''} animation ${a.animation || ''}`.replace(/\s+/g, ' ').trim(),
  set_audio: (a) => `Change the sound of ${count(a.clips, 'clip')}`,
  adjust_color: (a) => `Adjust the color of ${count(a.clips, 'clip')}`,
  set_transform: (a) => `Position ${count(a.clips, 'clip')}`,
  add_captions: () => 'Add captions',
  remove_silences: () => 'Remove silences',
  add_marker: (a) => `Add a marker${a.label ? ` ${quote(a.label, 30)}` : ''}`,
  select_clips: (a) => (Array.isArray(a.clips) && !a.clips.length ? 'Clear the selection' : `Select ${count(a.clips, 'clip')}`),
  set_aspect_ratio: (a) => `Change the frame to ${a.ratio}`,
  move_playhead: (a) => `Move the playhead to ${sec(a.time)}`,
  generate_video: (a) => `Generate a ${a.first_frame ? 'video from a picture' : 'video'}${sec(a.seconds) ? ` (${sec(a.seconds)})` : ''}`,
  animate_image: (a) => `Animate ${count(a.clip, 'clip')}`,
  extend_clip: (a) => `Extend ${count(a.clip, 'clip')}`,
  generate_transition: (a) => `Generate a transition after ${count(a.after_clip, 'clip')}`,
  generate_image: () => 'Generate a picture',
  edit_image: (a) => (a.source === 'playhead' ? 'Edit the frame at the playhead' : `Edit the picture of ${a.source ?? 'a clip'}`),
  add_voiceover: (a) => `Add a voiceover ${quote(a.text, 30)}`,
  add_media_to_timeline: (a) => `Add media ${a.media ?? ''} to the timeline`.replace(/\s+/g, ' '),
};

/**
 * A call as a line in the chat: { label, detail?, costly }. detail is shown
 * when the call asks to be allowed (the prompt it would send, for one).
 * `videoModel`: the id of the model chosen for video; a video call names the
 * model it will be made with (another, when the chosen one can't start from a
 * picture), its length and about what it costs. `seconds`: the length the
 * call will ask for when it names none (an animated image clip's own).
 */
export function describeCall(name, args = {}, { videoModel = null, seconds } = {}) {
  const a = args && typeof args === 'object' ? args : {};
  let label;
  try {
    label = LABELS[name]?.(a) || name;
  } catch {
    label = name;
  }
  const out = { label: label.charAt(0).toUpperCase() + label.slice(1), costly: costly(name) };
  const prompt = a.prompt || a.instruction || '';
  if (VIDEO_TOOLS.has(name)) {
    const frames = name === 'generate_video' ? { first: Boolean(a.first_frame || a.last_frame), last: Boolean(a.first_frame && a.last_frame) } : { first: true, last: name === 'generate_transition' };
    const parts = [prompt && `"${String(prompt).slice(0, VIDEO_PROMPT_MAX)}"`];
    if (videoModel) {
      const { model, fallback } = modelForFrames(videoModel, frames);
      const shortest = !model.seconds ? null : Array.isArray(model.seconds) ? model.seconds[0] : model.seconds.min;
      const want = Number.isFinite(num(a.seconds)) ? num(a.seconds) : Number.isFinite(seconds) ? seconds : name === 'generate_transition' ? shortest : undefined;
      const len = fitSeconds(model, want);
      const bits = [`with ${model.label}${fallback ? ' (the chosen model can\'t start from a picture)' : ''}`, len ? `${len}s long` : 'at the length the model picks', a.aspect].filter(Boolean).join(', ');
      parts.push(`Made ${bits}. About ${formatCents(estimateCents(model, want))} in Puter credits.`);
    } else parts.push('Uses Puter credits.');
    out.detail = parts.filter(Boolean).join(' ');
  } else if (prompt) out.detail = `"${String(prompt).slice(0, 600)}"`;
  else if (name === 'add_voiceover' && a.text) out.detail = `"${String(a.text).slice(0, 600)}"`;
  return out;
}

/* ---------- What the model reads ---------- */

/** Where a media item came from, in a word, when the app made it. */
const MADE = { 'ai-video': 'generated video', 'ai-image': 'generated picture', restyle: 'generated picture', tts: 'voiceover', assistant: 'attached in chat' };

/** The media library, one line an item: id, kind, name, length or size, origin, clips using it. */
export function mediaBrief(project, { limit = 200 } = {}) {
  const uses = new Map();
  for (const t of project.tracks) for (const c of t.clips) if (c.assetId) uses.set(c.assetId, (uses.get(c.assetId) || 0) + 1);
  const assets = Object.values(project.assets || {}).sort((a, b) => (b.added || 0) - (a.added || 0));
  if (!assets.length) return 'The media library is empty.';
  const lines = assets.slice(0, limit).map((a) => {
    const bits = [a.id, a.kind, quote(a.name, 60)];
    if (a.kind !== 'image' && a.duration) bits.push(secs(a.duration));
    if (a.width && a.height) bits.push(`${a.width}x${a.height}`);
    if (a.kind === 'video' && a.hasAudio === false) bits.push('no sound');
    if (MADE[a.origin]) bits.push(MADE[a.origin]);
    const n = uses.get(a.id) || 0;
    bits.push(n ? `${n} clip${n === 1 ? '' : 's'} on this timeline` : 'not on this timeline');
    return bits.join(' ');
  });
  if (assets.length > limit) lines.push(`(${assets.length - limit} more not listed)`);
  return lines.join('\n');
}

/** One clip's settings as JSON for get_clip: times in seconds, keyframes counted rather than listed. */
export function clipDetails(project, clip, track) {
  const toS = (us) => Math.round(us / 1000) / 1000;
  const out = { id: clip.id, type: clip.type, track: track?.id, base_track: !!track?.main, start: toS(clip.start), end: toS(clip.start + clip.duration), duration: toS(clip.duration) };
  const skip = new Set(['id', 'type', 'start', 'duration', 'keyframes', 'marks', 'avatar', 'lipsync', 'retouchCache', 'tracking', 'cutout']);
  for (const [k, v] of Object.entries(clip)) {
    if (skip.has(k) || v === null || v === undefined || v === false || v === '') continue;
    if (k === 'in' || k === 'fadeIn' || k === 'fadeOut') out[k] = toS(v);
    else if (k === 'assetId') out.media = { id: v, name: project.assets?.[v]?.name, kind: project.assets?.[v]?.kind };
    else out[k] = v;
  }
  const keyed = Object.keys(clip.keyframes || {});
  if (keyed.length) out.keyframed = keyed;
  const text = JSON.stringify(out);
  return text.length > 6000 ? `${text.slice(0, 6000)}…` : text;
}

/**
 * The state sent with each message: the date, the project brief (tracks,
 * clips with ids, selection, playhead), how much media there is, and the
 * models chosen for video and pictures.
 */
export function projectSnapshot(state, { now = new Date(), videoModel = '', imageModel = '' } = {}) {
  const lines = [`Today is ${now.toLocaleDateString('en-CA')}.`, projectBrief(state)];
  const assets = Object.values(state.project.assets || {});
  const unused = assets.filter((a) => !state.project.tracks.some((t) => t.clips.some((c) => c.assetId === a.id)));
  lines.push(`Media library: ${assets.length} item${assets.length === 1 ? '' : 's'}${unused.length ? `, ${unused.length} not on this timeline` : ''} (list_media lists them).`);
  if (videoModel) lines.push(`Video is generated with ${videoModel}.`);
  if (imageModel) lines.push(`Pictures are generated and edited with ${imageModel}.`);
  return lines.join('\n');
}
