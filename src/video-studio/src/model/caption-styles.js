/**
 * Caption looks: a text preset plus overrides and the letter animations
 * that suit captions (words popping in, a karaoke sweep), applied to every
 * caption at once. Highlighted words are in model/text-marks.js.
 */
import { resetContentTiming } from './inherited-motion.js';
import { TEXT_PRESETS } from './text-presets.js';

const PRESET = Object.fromEntries(TEXT_PRESETS.map((p) => [p.id, p.style]));

export const CAPTION_STYLES = [
  { id: 'pop-sweep', label: 'Sing along', preset: 'yellow-caption', style: { color: '#ffffff', highlightColor: '#ffe14d' }, loop: 'karaoke', sample: 'SING ALONG' },
  { id: 'word-pop', label: 'Word pop', preset: 'yellow-caption', style: { highlightColor: '#3de0ff' }, in: 'word-pop', sample: 'WORD POP' },
  { id: 'bold-rise', label: 'Bold rise', preset: 'outline', style: { size: 72, strokeWidth: 7, highlightColor: '#ff5a8a' }, in: 'word-rise', sample: 'Bold rise' },
  { id: 'clean', label: 'Clean', preset: 'clean-caption', style: { highlightColor: '#ffd23f' }, sample: 'Clean and simple' },
  { id: 'boxed', label: 'Boxed', preset: 'boxed', style: { size: 50, highlightColor: '#e8453c' }, sample: 'Boxed words' },
  { id: 'bar', label: 'Subtitle bar', preset: 'subtitle', style: { size: 46, highlightColor: '#ffd23f' }, sample: 'Subtitle bar' },
  { id: 'glow', label: 'Glow', preset: 'arcade', style: { size: 60, highlightColor: '#ffffff' }, in: 'letters-fade', sample: 'GLOW' },
  { id: 'marker', label: 'Marker', preset: 'highlighter', style: { size: 56, highlightColor: '#d7263d' }, sample: 'Key point' },
  { id: 'playful', label: 'Playful', preset: 'playful', style: { size: 76, highlightColor: '#ffe14d' }, in: 'letters-swing', sample: 'Yay!' },
  { id: 'cinema', label: 'Cinema', preset: 'cinematic', style: { size: 44, letterSpacing: 10, highlightColor: '#f0c27a' }, in: 'letters-fade', sample: 'The journey' },
  { id: 'type', label: 'Typed', preset: 'mono', style: { size: 46, highlightColor: '#ffffff' }, in: 'letters-fade', sample: '> typed out' },
  { id: 'heavy-sweep', label: 'Heavy sweep', preset: 'heavy', style: { size: 84, case: 'upper', highlightColor: '#39d98a' }, loop: 'karaoke', sample: 'HEAVY' },
];

/** Style fields that place a caption (kept when its look changes). */
const KEEP = ['boxWidth', 'boxHeight', 'align', 'vAlign'];

/**
 * Apply a caption look to a caption clip in place. Letter animations get
 * the whole clip (sweeps) or a short in phase (pops); its text, timing,
 * position and highlights stay. frameWidth (project px) gives captions
 * without a wrap width one.
 */
export function applyCaptionStyle(clip, def, defaultStyle, frameWidth = 0) {
  const kept = Object.fromEntries(KEEP.filter((k) => clip.style && k in clip.style).map((k) => [k, clip.style[k]]));
  // Larger looks must still fit: wrap inside most of the frame width.
  if (!(kept.boxWidth > 0) && frameWidth > 0) kept.boxWidth = Math.round(frameWidth * 0.9);
  clip.style = { ...defaultStyle, ...(PRESET[def.preset] || {}), ...def.style, ...kept };
  clip.animIn = def.in ? { id: def.in, duration: Math.min(600_000, Math.round(clip.duration * 0.5)) } : null;
  clip.animOut = null;
  clip.animLoop = def.loop ? { id: def.loop, duration: clip.duration } : null;
  for (const field of ['animIn', 'animOut', 'animLoop']) resetContentTiming(clip, field);
  clip.captionStyle = def.id;
}
