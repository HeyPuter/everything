// Pure strip data edits (unit tested): changing effect types and swapping strip content.
import type { Strip, StripType } from './types';
import * as S from './strips';

/** Effect types a strip can be changed into (same number of inputs). */
export function effectTypesFor(t: StripType): StripType[] {
  const n = S.inputCount(t);
  if (n === 2) return ['CROSS', 'GAMMA_CROSS', 'WIPE', 'ADD', 'SUBTRACT', 'MULTIPLY', 'ALPHA_OVER', 'ALPHA_UNDER', 'COLORMIX'];
  if (n === 1) return ['TRANSFORM', 'SPEED', 'GLOW', 'GAUSSIAN_BLUR'];
  if (t === 'COLOR' || t === 'TEXT' || t === 'ADJUSTMENT' || t === 'MULTICAM') return ['COLOR', 'TEXT', 'ADJUSTMENT', 'MULTICAM'];
  return [];
}

/** Turn an effect/generator strip into another type, keeping its timing and inputs. */
export function changeEffectType(s: Strip, type: StripType) {
  if (s.type === type) return;
  const fresh = S.newStrip(type, s.name, s.channel, s.frame_start, s.frame_duration);
  // type-specific settings come from the defaults of the new type; shared ones are kept
  const shared = new Set(Object.keys(S.newStrip('COLOR', '', 1, 1, 1)));
  for (const k of Object.keys(fresh) as (keyof Strip)[]) if (!shared.has(k) && (s as unknown as Record<string, unknown>)[k] === undefined) (s as unknown as Record<string, unknown>)[k] = fresh[k];
  s.type = type;
  if (type === 'COLOR' && (!s.color || s.color.length > 3)) s.color = [0.5, 0.5, 0.5];
  if (type === 'TEXT' && (!s.color || s.color.length < 4)) s.color = [1, 1, 1, 1];
}

/** Swap the content (source media, generator settings) of two strips, keeping their timing. */
export function swapData(a: Strip, b: Strip): string | null {
  const kind = (s: Strip) => (s.type === 'SOUND' ? 'sound' : S.inputCount(s.type) ? 'effect' : s.type === 'META' ? 'meta' : 'visual');
  if (kind(a) === 'meta' || kind(b) === 'meta') return 'Meta strips cannot swap data';
  if (kind(a) !== kind(b)) return 'Strips must be the same kind (both visual, both sound or both effects)';
  if (kind(a) === 'effect' && S.inputCount(a.type) !== S.inputCount(b.type)) return 'Effects must have the same number of inputs';
  const keys: (keyof Strip)[] = ['type', 'media', 'elements', 'orig_width', 'orig_height', 'fps', 'sound_offset', 'scene', 'scene_camera', 'color', 'text', 'multicam_source', 'frame_duration', 'animation_offset_start', 'animation_offset_end'];
  const rec = (s: Strip) => s as unknown as Record<string, unknown>;
  for (const k of keys) {
    const t = rec(a)[k];
    rec(a)[k] = rec(b)[k];
    rec(b)[k] = t;
  }
  for (const s of [a, b]) S.clampOffsets(s);
  return null;
}

