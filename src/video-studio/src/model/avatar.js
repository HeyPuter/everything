/**
 * Presenter avatar clips (type 'avatar', on video tracks). An avatar is an
 * original drawn character (engine/avatars.js) that talks along with a voice
 * recording: clip.avatar holds the look and the link to its voice.
 *
 * clip.avatar = {
 *   character,                 // id from AVATAR_CHARACTER_IDS
 *   framing: 'head'|'waist',   // head and shoulders, or waist up (hands show)
 *   background: 'none'|'color'|'blur',
 *   bgColor: '#rrggbb',
 *   script, voice,             // the words and text-to-speech voice id (for re-voicing)
 *   voiceAsset,                // audio asset whose clips on the timeline the mouth follows
 *   lips,                      // analysis of that audio (media/lipsync.js), or null
 *   seed,                      // varies blinks and idle motion between avatars
 * }
 */
import { normalizeLips } from '../media/lipsync.js';

/** Characters in the gallery (drawn in engine/avatars.js). */
export const AVATAR_CHARACTER_IDS = ['ava', 'leo', 'noor', 'kofi', 'mei', 'ines', 'raj', 'grace'];

export const AVATAR_FRAMINGS = [
  { id: 'head', label: 'Shoulders up' },
  { id: 'waist', label: 'Waist up' },
];

export const AVATAR_BACKGROUNDS = [
  { id: 'none', label: 'None' },
  { id: 'color', label: 'Color' },
  { id: 'blur', label: 'Soft studio' },
];

/** Where the avatar sits: transform presets (x, y offsets as fractions of the frame). */
export const AVATAR_POSITIONS = [
  { id: 'full', label: 'Full frame', transform: { x: 0, y: 0, scale: 1 } },
  { id: 'br', label: 'Bottom right', transform: { x: 0.31, y: 0.29, scale: 0.34 } },
  { id: 'bl', label: 'Bottom left', transform: { x: -0.31, y: 0.29, scale: 0.34 } },
  { id: 'tr', label: 'Top right', transform: { x: 0.31, y: -0.29, scale: 0.34 } },
  { id: 'tl', label: 'Top left', transform: { x: -0.31, y: -0.29, scale: 0.34 } },
];

export const AVATAR_SCRIPT_MAX = 3000;

export const DEFAULT_AVATAR = Object.freeze({
  character: 'ava',
  framing: 'head',
  background: 'blur',
  bgColor: '#2f3d5c',
  script: '',
  voice: '',
  voiceAsset: null,
  lips: null,
  seed: 1,
});

const color = (v, d) => (/^#[0-9a-f]{6}$/i.test(String(v)) ? String(v).toLowerCase() : d);

/** Validate untrusted JSON into an avatar description. */
export function normalizeAvatar(raw) {
  const a = raw && typeof raw === 'object' ? raw : {};
  const d = DEFAULT_AVATAR;
  const seed = Math.floor(Number(a.seed));
  return {
    character: AVATAR_CHARACTER_IDS.includes(a.character) ? a.character : d.character,
    framing: AVATAR_FRAMINGS.some((f) => f.id === a.framing) ? a.framing : d.framing,
    background: AVATAR_BACKGROUNDS.some((b) => b.id === a.background) ? a.background : d.background,
    bgColor: color(a.bgColor, d.bgColor),
    script: typeof a.script === 'string' ? a.script.slice(0, AVATAR_SCRIPT_MAX) : '',
    voice: typeof a.voice === 'string' && /^[\w-]{1,40}$/.test(a.voice) ? a.voice : '',
    voiceAsset: typeof a.voiceAsset === 'string' && a.voiceAsset ? a.voiceAsset.slice(0, 64) : null,
    lips: normalizeLips(a.lips),
    seed: Number.isFinite(seed) && seed >= 0 ? seed % 2 ** 31 : d.seed,
  };
}

/** The position preset a transform matches, or null when it was moved by hand. */
export function positionOf(transform) {
  if (!transform) return null;
  const near = (a, b) => Math.abs((a ?? 0) - b) < 1e-3;
  const p = AVATAR_POSITIONS.find((x) => near(transform.x, x.transform.x) && near(transform.y, x.transform.y) && near(transform.scale, x.transform.scale));
  return p ? p.id : null;
}

/** A fresh seed for a new avatar. */
export function newAvatarSeed() {
  return Math.floor(Math.random() * 2 ** 31);
}
