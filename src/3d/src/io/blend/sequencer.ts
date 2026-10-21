// Video Sequencer strips: timing, channels, blending, transform / crop, effect settings and
// inputs, scene strips, meta strips and packed sounds. Settings are read through the measured
// DNA rules (modprops.gen.ts); image and movie strips refer to files outside the .blend file.
import type { ID } from '../../data/types';
import { isEffect, isStill, newSequenceEditor, newStrip } from '../../sequencer/strips';
import type { SequenceEditor, Strip, StripType } from '../../sequencer/types';
import { mimeFor } from '../../sequencer/media';
import type { BStruct } from './reader';
import type { Ctx } from './context';
import { DNA_PROP_RULES } from './modprops.gen';
import { readRule } from './modifiers';

/** DNA strip type numbers. */
const TYPES: Record<number, StripType> = {
  0: 'IMAGE',
  1: 'META',
  2: 'SCENE',
  3: 'MOVIE',
  4: 'SOUND',
  5: 'SOUND',
  6: 'MOVIECLIP',
  7: 'MASK',
  8: 'CROSS',
  9: 'ADD',
  10: 'SUBTRACT',
  11: 'ALPHA_OVER',
  12: 'ALPHA_UNDER',
  13: 'GAMMA_CROSS',
  14: 'MULTIPLY',
  25: 'WIPE',
  26: 'GLOW',
  27: 'TRANSFORM',
  28: 'COLOR',
  29: 'SPEED',
  30: 'MULTICAM',
  31: 'ADJUSTMENT',
  40: 'GAUSSIAN_BLUR',
  41: 'TEXT',
  42: 'COLORMIX',
};

/** Rules of a strip type; types without their own (media strips) use the settings all strips share. */
function rulesOf(type: StripType) {
  const own = DNA_PROP_RULES[`Sequence:${type}`];
  if (own) return own.props;
  const base = DNA_PROP_RULES['Sequence:ADJUSTMENT']?.props ?? {};
  return Object.fromEntries(Object.entries(base).filter(([, r]) => !r.f.startsWith('effectdata.')));
}

function applyRules(d: BStruct, s: Strip, ctx: Ctx) {
  const target = s as unknown as Record<string, unknown>;
  for (const [key, r] of Object.entries(rulesOf(s.type))) {
    if (r.ptr) continue;
    // nested settings: transform.offset_x, crop.min_x
    const dot = key.indexOf('.');
    const owner = dot > 0 ? (target[key.slice(0, dot)] as Record<string, unknown> | undefined) : target;
    const k = dot > 0 ? key.slice(dot + 1) : key;
    if (!owner || !(k in owner)) continue;
    const v = readRule(d, r, ctx, (x) => ctx.objectRef(x));
    if (v !== undefined) owner[k] = v;
  }
}

export interface SceneRefs {
  sceneId(s: BStruct | null): ID | null;
}

function convertStrip(d: BStruct, ctx: Ctx, refs: SceneRefs, owner: string, inputs: Map<number, string>): Strip | null {
  const type = TYPES[d.num('type')];
  const name = d.str('name').slice(2);
  if (!type) {
    ctx.warn.add('Video sequencer strips of unsupported types skipped', `${owner}: ${name}`);
    return null;
  }
  const s = newStrip(type, name, d.num('machine') || 1, d.num('start'), Math.max(1, d.num('len')));
  applyRules(d, s, ctx);
  const startofs = d.num('startofs'),
    endofs = d.num('endofs');
  if (isStill(s) || isEffect(type)) {
    // generators store one content frame extended by negative offsets: here the length is the strip's
    s.frame_start = d.num('start') + startofs;
    s.frame_duration = Math.max(1, d.num('len') - startofs - endofs);
  } else {
    if (startofs < 0 || endofs < 0) ctx.warn.add('Frame holds before / after strip content trimmed', `${owner}: ${name}`);
    s.frame_offset_start = Math.max(0, startofs);
    s.frame_offset_end = Math.max(0, endofs);
  }
  s.animation_offset_start = d.num('anim_startofs');
  s.animation_offset_end = d.num('anim_endofs');
  // effect inputs by name
  for (const [field, key] of [
    ['seq1', 'input_1'],
    ['seq2', 'input_2'],
  ] as const) {
    const a = d.ptr(field);
    if (a) {
      const t = d.at(a);
      if (t) inputs.set(t.offset, t.str('name').slice(2));
      if (t) s[key] = t.str('name').slice(2);
    }
  }
  switch (type) {
    case 'SCENE': {
      s.scene = refs.sceneId(d.ref('scene')) ?? undefined;
      s.scene_camera = ctx.objectRef(d.ref('scene_camera'));
      if (!s.scene) ctx.warn.add('Scene strips whose scene was not imported (left empty)', `${owner}: ${name}`);
      break;
    }
    case 'META':
      s.strips = convertList(d.list('seqbase', 100_000), ctx, refs, owner, inputs);
      break;
    case 'SOUND': {
      const snd = d.ref('sound');
      const pf = snd?.ref('packedfile');
      const size = pf?.num('size') ?? 0;
      const bytes = pf && size > 0 ? ctx.f.bytesAt(pf.ptr('data'), size, pf.block) : null;
      const path = snd?.str('filepath') ?? '';
      if (!bytes) {
        ctx.warn.add('Sound strips whose sound is not packed in the .blend file skipped', `${owner}: ${name}${path ? ` (${path})` : ''}`);
        return null;
      }
      const file = path.replace(/^.*[\\/]/, '') || `${name}.wav`;
      s.media = { filepath: file, mime: mimeFor(file, ''), bytes };
      s.volume = d.num('volume');
      s.pan = d.num('pan');
      s.sound_offset = d.num('sound_offset');
      break;
    }
    case 'IMAGE':
    case 'MOVIE': {
      const sd = d.ref('strip') ?? d.ref('data');
      const dir = sd?.str('dir') ?? '';
      const first = sd?.ref('stripdata')?.str('name') ?? d.str('filepath');
      ctx.warn.add(`${type === 'IMAGE' ? 'Image' : 'Movie'} strips refer to files outside the .blend file (skipped; add them in the Video Sequencer)`, `${owner}: ${name}${first ? ` (${dir}${first})` : ''}`);
      return null;
    }
    case 'MOVIECLIP':
    case 'MASK':
      ctx.warn.add('Movie clip and mask strips not imported', `${owner}: ${name}`);
      return null;
  }
  if (d.list('modifiers', 1000).length) ctx.warn.add('Video sequencer strip modifiers not imported', `${owner}: ${name}`);
  return s;
}

function convertList(list: BStruct[], ctx: Ctx, refs: SceneRefs, owner: string, inputs: Map<number, string>): Strip[] {
  const out: Strip[] = [];
  for (const d of list) {
    const s = convertStrip(d, ctx, refs, owner, inputs);
    if (s) out.push(s);
  }
  // effects whose inputs were skipped lose them
  const names = new Set(out.map((s) => s.name));
  for (const s of out) {
    if (s.input_1 && !names.has(s.input_1)) s.input_1 = null;
    if (s.input_2 && !names.has(s.input_2)) s.input_2 = null;
  }
  return out;
}

/** The sequence editor of a scene, or null when the scene has none. */
export function convertSequencer(sc: BStruct, ctx: Ctx, refs: SceneRefs): SequenceEditor | null {
  const ed = sc.ref('ed');
  if (!ed) return null;
  const list = ed.has('seqbase') ? ed.list('seqbase', 100_000) : ed.list('strips', 100_000);
  if (!list.length) return null;
  const out = newSequenceEditor();
  out.strips = convertList(list, ctx, refs, sc.idName, new Map());
  // channel names and lock / mute states
  for (const ch of ed.list('channels', 1000)) {
    const i = ch.num('index');
    if (!out.channels[i]) continue;
    const name = ch.str('name');
    const flag = ch.num('flag');
    out.channels[i] = { name: name || out.channels[i].name, lock: (flag & 1) !== 0, mute: (flag & 2) !== 0 };
  }
  const act = ed.ref('act_seq') ?? ed.ref('act_strip');
  if (act) out.active_strip = act.str('name').slice(2);
  return out;
}
