/**
 * AI restyle: a picture (an image clip, or one frame of a video clip) is
 * sent with a style instruction to Puter AI image generation
 * (puter.ai.txt2img with input_image), which draws it again in that style.
 * Only runs when the user presses Restyle; the call is injectable for tests.
 */
import { imageBlobFrom, imageErrorMessage } from './imagegen.js';

export const RESTYLE_PROMPT_MAX = 600;
/** Longest side of the picture sent. */
export const RESTYLE_MAX_SIDE = 1024;

/** Original style chips: a short label and the phrase sent to the model. */
export const RESTYLE_STYLES = [
  { id: 'storybook', label: 'Storybook', phrase: 'a soft storybook illustration in gouache with gentle textures' },
  { id: 'cel', label: 'Cel shaded', phrase: 'a clean cel-shaded animation frame with bold outlines and flat colors' },
  { id: 'clay', label: 'Clay', phrase: 'a handmade clay stop-motion scene with soft studio light' },
  { id: 'papercut', label: 'Paper cut', phrase: 'layered paper cutout art with soft shadows between the layers' },
  { id: 'oil', label: 'Oil painting', phrase: 'a classic oil painting with visible brush strokes' },
  { id: 'graphite', label: 'Graphite', phrase: 'a detailed graphite pencil drawing on textured paper' },
  { id: 'pixel', label: 'Pixel art', phrase: 'crisp retro pixel art with a limited palette' },
  { id: 'neon', label: 'Neon night', phrase: 'a neon-lit night scene with glowing magenta and cyan light' },
  { id: 'poster', label: 'Screen print', phrase: 'a two-color screen-printed poster with halftone texture' },
];

/** The instruction sent with the picture. */
export function restylePrompt(text, styleId) {
  const t = String(text || '').trim().slice(0, RESTYLE_PROMPT_MAX);
  const style = RESTYLE_STYLES.find((s) => s.id === styleId);
  if (!t && !style) return '';
  const look = [style ? `in the style of ${style.phrase}` : '', t].filter(Boolean).join('. ');
  return `Redraw this picture ${look}. Keep the same composition, framing, subjects and their poses. Return the full image with the same aspect ratio.`;
}

/** Fit w x h inside max on its longer side. */
export function fitSize(w, h, max = RESTYLE_MAX_SIDE) {
  const s = Math.min(1, max / Math.max(1, w, h));
  return { w: Math.max(16, Math.round(w * s)), h: Math.max(16, Math.round(h * s)) };
}

/** Data URI of a Blob. */
export async function blobToDataUri(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return `data:${blob.type || 'image/png'};base64,${btoa(bin)}`;
}

const defaultTxt2img = (prompt, options) => {
  if (typeof puter === 'undefined' || !puter.ai?.txt2img) throw new Error('Restyling needs Puter.');
  return puter.ai.txt2img(prompt, options);
};

/**
 * Restyle a picture: { blob } of the new picture. picture is
 * { blob, width, height } (already at most RESTYLE_MAX_SIDE).
 * txt2img and fetchFn are injectable for tests.
 */
export async function restylePicture(picture, { prompt = '', style = null, testMode = false, txt2img = defaultTxt2img, fetchFn } = {}) {
  const text = restylePrompt(prompt, style);
  if (!text) throw new Error('Pick a style or describe the look first.');
  if (!picture?.blob) throw new Error('There is no picture to restyle here.');
  const options = { ratio: { w: picture.width, h: picture.height }, input_image: await blobToDataUri(picture.blob), ...(testMode ? { test_mode: true } : {}) };
  let result;
  try {
    result = await txt2img(text, options);
  } catch (err) {
    throw new Error(imageErrorMessage(err));
  }
  const blob = await imageBlobFrom(result, fetchFn);
  return { blob, prompt: text };
}

/** A file name for a restyled picture: "Clip name - Storybook.png". */
export function restyleFileName(base, styleId, type = 'image/png') {
  const style = RESTYLE_STYLES.find((s) => s.id === styleId)?.label || 'Restyled';
  const stem = String(base || 'Picture').replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[\\/:*?"<>|\n\r]+/g, ' ').trim().slice(0, 48) || 'Picture';
  const ext = (type.split('/')[1] || 'png').replace('jpeg', 'jpg');
  return `${stem} - ${style}.${ext}`;
}
