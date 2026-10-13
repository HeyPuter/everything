/**
 * Retouch looks: named sets of retouch values applied in one click. A look
 * holds any of the retouch parts (model/retouch.js): retouch (skin and lip
 * color), faceShape, bodyShape, makeup and hairColor. Applying one replaces
 * the skin, face, body and makeup settings with the look's (so switching
 * looks never stacks them) and sets hair color only when the look has one.
 * Which faces and which people a clip works on stay the clip's own choice.
 *
 * The built-in looks below are original; people save their own from a clip
 * (ui/retouch-looks.js keeps them in preferences).
 */
import {
  normalizeRetouch, retouchAmounts, skinFixAmounts, normalizeFaceShape, faceShapeAmounts, normalizeBodyShape, bodyShapeAmounts,
  normalizeMakeup, makeupAmounts, normalizeHairColor, hairColorOn,
} from './retouch.js';

export const LOOK_PARTS = ['retouch', 'faceShape', 'bodyShape', 'makeup', 'hairColor'];

export const RETOUCH_LOOKS = Object.freeze([
  {
    id: 'natural', label: 'Natural', hint: 'Smoother, even skin', accent: '#d8b49c',
    values: { retouch: { smooth: 35, even: 20, brighten: 10, blemishes: 40, darkCircles: 30 } },
  },
  {
    id: 'fresh', label: 'Fresh', hint: 'Bright skin and a flush of color', accent: '#ee9a85',
    values: {
      retouch: { smooth: 30, even: 25, brighten: 22, blemishes: 45, darkCircles: 45, teeth: 30, lips: 25, lipColor: '#c45f72' },
      makeup: { blush: 30, blushColor: '#e9886b', highlight: 25, highlightColor: '#fff2e4' },
      faceShape: { eyes: 8 },
    },
  },
  {
    id: 'soft-glam', label: 'Soft glam', hint: 'Polished skin, soft eyes and lips', accent: '#c26f86',
    values: {
      retouch: { smooth: 55, even: 30, brighten: 15, blemishes: 55, darkCircles: 50, teeth: 25, lips: 55, lipColor: '#a3616f' },
      makeup: {
        blush: 35, blushColor: '#da6b78', eyeshadow: 40, eyeshadowColor: '#c28272', eyeliner: 45, eyelinerColor: '#3f2b23',
        brows: 30, browColor: '#3c2b23', contour: 25, contourColor: '#8b5f49', highlight: 30, highlightColor: '#f6dcb1',
      },
      faceShape: { slim: 10, eyes: 10 },
    },
  },
  {
    id: 'sculpted', label: 'Sculpted', hint: 'Defined cheekbones and jaw', accent: '#9a6a52',
    values: {
      retouch: { smooth: 35, even: 20, brighten: 8, blemishes: 40 },
      makeup: { contour: 55, contourColor: '#8b5f49', highlight: 45, highlightColor: '#f6dcb1', brows: 35, browColor: '#3c2b23' },
      faceShape: { slim: 22, nose: 15, chin: 10 },
    },
  },
  {
    id: 'athletic', label: 'Athletic', hint: 'Broader shoulders, a trimmer waist', accent: '#6f8fa8',
    values: {
      retouch: { smooth: 15, even: 15, sharpen: 25 },
      bodyShape: { shoulders: 35, waist: 30, arms: 10, slim: 8, legs: 15 },
      makeup: { contour: 20, contourColor: '#704937' },
    },
  },
  {
    id: 'evening', label: 'Evening', hint: 'Smoky eyes and a deep lip', accent: '#5b3550',
    values: {
      retouch: { smooth: 45, even: 25, brighten: 10, blemishes: 50, darkCircles: 40, lips: 70, lipColor: '#8c2c4c' },
      makeup: {
        eyeshadow: 60, eyeshadowColor: '#4b4952', eyeliner: 70, eyelinerColor: '#18151a', brows: 40, browColor: '#262120',
        contour: 35, contourColor: '#704937', highlight: 35, highlightColor: '#e9c172', blush: 20, blushColor: '#b1486b',
      },
    },
  },
]);

/** A part as it renders, or null when it does nothing (so "absent" and "all zero" compare equal). */
function canonical(key, v) {
  if (!v || typeof v !== 'object') return null;
  if (key === 'retouch') return retouchAmounts(v) || skinFixAmounts(v) ? normalizeRetouch(v) : null;
  if (key === 'faceShape') return faceShapeAmounts(v) ? normalizeFaceShape(v) : null;
  if (key === 'bodyShape') return bodyShapeAmounts(v) ? normalizeBodyShape(v) : null;
  if (key === 'makeup') return makeupAmounts(v) ? normalizeMakeup(v) : null;
  if (key === 'hairColor') return hairColorOn(v) ? normalizeHairColor(v) : null;
  return null;
}

/** The look's values, cleaned (from preferences or a built-in), without the clip-only choices. */
export function lookValues(values) {
  const out = {};
  for (const k of LOOK_PARTS) {
    const v = canonical(k, values?.[k]);
    if (!v) continue;
    if (k === 'faceShape') delete v.faces;
    if (k === 'bodyShape') delete v.people;
    out[k] = v;
  }
  return out;
}

/** A user look from preferences, or null when it is not one. */
export function normalizeLook(l) {
  if (!l || typeof l !== 'object' || typeof l.id !== 'string') return null;
  const values = lookValues(l.values);
  if (!Object.keys(values).length) return null;
  return { id: l.id, name: String(l.name || 'My look').slice(0, 80), created: Number(l.created) || 0, values };
}

/** The retouch of a clip as look values (what Save as look keeps). */
export const lookFromClip = (clip) => lookValues(clip);

/** Whether a clip has any retouch a look would replace. */
export const hasRetouch = (clip) => LOOK_PARTS.some((k) => k !== 'hairColor' && canonical(k, clip?.[k]));

/**
 * Apply a look to a clip in place (null clears skin, face, body and makeup).
 * Which faces and people the clip works on are kept.
 */
export function applyLook(clip, look) {
  const v = look ? lookValues(look.values) : {};
  const faces = clip.faceShape?.faces;
  const people = clip.bodyShape?.people;
  if (v.retouch) clip.retouch = v.retouch;
  else delete clip.retouch;
  if (v.faceShape || faces === 'largest') clip.faceShape = normalizeFaceShape({ ...v.faceShape, faces });
  else delete clip.faceShape;
  if (v.bodyShape || people === 'largest') clip.bodyShape = normalizeBodyShape({ ...v.bodyShape, people });
  else delete clip.bodyShape;
  if (v.makeup) clip.makeup = v.makeup;
  else delete clip.makeup;
  if (v.hairColor) clip.hairColor = v.hairColor;
  return clip;
}

/** Whether a clip shows exactly a look (what applying it would give). */
export function lookMatches(clip, look) {
  if (!clip) return false;
  const parts = (c) => JSON.stringify(LOOK_PARTS.map((k) => canonical(k, c[k])));
  const copy = structuredClone(Object.fromEntries(LOOK_PARTS.filter((k) => clip[k]).map((k) => [k, clip[k]])));
  return parts(applyLook(copy, look)) === parts(clip);
}
