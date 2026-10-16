// Strip modifiers beyond the colour basics: Hue Correct, Mask, Tonemap and the sound modifiers
// Pitch and Echo. The list of every modifier type (menu order) lives here; image modifiers run as
// GPU passes in the sequencer compositor, sound modifiers in the Web Audio graph.
import { h, type Child } from '../ui/h';
import { app } from '../app/app';
import { num, enumProp, splitRow } from '../ui/props';
import type { NodeData, NodeTreeData } from '../data/types';
import type { ModifierType, Strip, StripModifier } from './types';
import type { Compositor, Target } from './gpu';
import { bakeHueCurves, defaultHueCurves } from '../compositor/color/colorspace';
import { drawCurves } from '../nodes/editor/rampui';
import { restartPlayback } from './audio';
import { dataBlockSelector } from '../editors/properties/tabs';
import { runCompositorGroup } from '../compositor/run';

export interface ModifierKind {
  type: ModifierType;
  label: string;
  icon: string;
  sound: boolean;
}

/** Every strip modifier type in Add Modifier menu order. */
export const MODIFIER_KINDS: ModifierKind[] = [
  { type: 'BRIGHT_CONTRAST', label: 'Brightness/Contrast', icon: 'seq_adjustment', sound: false },
  { type: 'COLOR_BALANCE', label: 'Color Balance', icon: 'seq_color', sound: false },
  { type: 'CURVES', label: 'Curves', icon: 'seq_color', sound: false },
  { type: 'HUE_CORRECT', label: 'Hue Correct', icon: 'seq_color', sound: false },
  { type: 'MASK', label: 'Mask', icon: 'mod_mask', sound: false },
  { type: 'TONEMAP', label: 'Tone Map', icon: 'seq_adjustment', sound: false },
  { type: 'WHITE_BALANCE', label: 'White Balance', icon: 'seq_color', sound: false },
  { type: 'COMPOSITOR', label: 'Compositor', icon: 'node_compositing', sound: false },
  { type: 'SOUND_EQUALIZER', label: 'Equalizer', icon: 'file_sound', sound: true },
  { type: 'PITCH', label: 'Pitch', icon: 'file_sound', sound: true },
  { type: 'ECHO', label: 'Echo', icon: 'file_sound', sound: true },
];

export const modifierKind = (t: ModifierType) => MODIFIER_KINDS.find((k) => k.type === t);
export const isSoundModifier = (t: ModifierType) => !!modifierKind(t)?.sound;

/** Add Modifier menu items for a strip (sound strips take sound modifiers, the rest image ones). */
export function modifierAddItems(s: Strip | null): { label: string; icon: string; op: string; props: Record<string, unknown> }[] {
  const sound = s?.type === 'SOUND';
  return MODIFIER_KINDS.filter((k) => k.sound === sound).map((k) =>
    k.type === 'COMPOSITOR'
      ? { label: k.label, icon: k.icon, op: 'sequencer.strip_modifier_add_node_group', props: {} }
      : { label: k.label, icon: k.icon, op: 'sequencer.strip_modifier_add', props: { type: k.type } },
  );
}

// ---------------------------------------------------------------------------
// image passes

const FS_EXTRA = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uTex0; uniform sampler2D uTex1;
uniform float uOp;
uniform vec4 uA; uniform vec4 uB; uniform vec3 uC;
vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + 1e-10)), d / (q.x + 1e-10), q.x);
}
vec3 hsv2rgb(vec3 c) {
  vec3 p = abs(fract(c.xxx + vec3(1.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
void main() {
  vec4 p = texture(uTex0, vUv);
  float a = p.a;
  vec3 c = a > 0.0 ? p.rgb / a : vec3(0.0);
  if (uOp < 0.5) {
    // hue correct: uTex1 is the hue / saturation / value lookup over hue
    vec3 hsv = rgb2hsv(c);
    vec3 k = texture(uTex1, vec2(clamp(hsv.x, 0.0, 1.0) * (255.0 / 256.0) + 0.5 / 256.0, 0.5)).rgb;
    hsv.x = fract(hsv.x + k.x - 0.5);
    hsv.y = clamp(hsv.y * k.y * 2.0, 0.0, 1.0);
    hsv.z = hsv.z * k.z * 2.0;
    c = hsv2rgb(hsv);
  } else if (uOp < 1.5) {
    // mask: the mask's luminance multiplies the alpha
    a *= clamp(luma(texture(uTex1, vUv).rgb), 0.0, 1.0);
  } else if (uOp < 2.5) {
    // simple tone map: uA = (scale, offset, inverse gamma)
    vec3 s = max(c * uA.x, vec3(0.0));
    s = s / (s + uA.y);
    c = pow(max(s, vec3(0.0)), vec3(uA.z));
  } else {
    // photoreceptor tone map: uA = (f, m, light adaptation, chromatic adaptation), uB.x = mean luminance, uC = mean colour
    float L = luma(c);
    vec3 Il = mix(vec3(L), c, uA.w);
    vec3 Ig = mix(vec3(uB.x), uC, uA.w);
    vec3 Ia = mix(Ig, Il, uA.z);
    c = c / max(c + pow(max(uA.x * Ia, vec3(0.0)), vec3(uA.y)), vec3(1e-12));
  }
  o = vec4(max(c, 0.0) * a, a);
}`;

/** Image statistics for tone mapping: mean colour, mean / log-mean / min / max luminance. */
function imageStats(c: Compositor, src: Target) {
  const { data } = c.sample(src);
  const n = data.length / 4;
  let r = 0,
    g = 0,
    b = 0,
    lsum = 0,
    logsum = 0,
    lmin = Infinity,
    lmax = -Infinity;
  for (let i = 0; i < data.length; i += 4) {
    const L = Math.max(0, 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]);
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
    lsum += L;
    logsum += Math.log(L + 1e-5);
    lmin = Math.min(lmin, L);
    lmax = Math.max(lmax, L);
  }
  return { mean: [r / n, g / n, b / n], lav: lsum / n, logAv: logsum / n, lmin, lmax };
}

/** Tone mapping parameters from a modifier and the image statistics (pure, unit tested). */
export function tonemapUniforms(m: StripModifier, st: ReturnType<typeof imageStats>): { op: number; A: number[]; B: number[]; C: number[] } {
  if ((m.tonemap_type ?? 'RH_SIMPLE') === 'RH_SIMPLE') {
    const lav = Math.exp(st.logAv);
    const g = m.gamma ?? 1;
    return { op: 2, A: [lav > 0 ? (m.key ?? 0.18) / lav : 1, Math.max(1e-6, m.offset ?? 1), g > 0 ? 1 / g : 1, 0], B: [0, 0, 0, 0], C: [0, 0, 0] };
  }
  const lmx = Math.log(st.lmax + 1e-5),
    lmn = Math.log(st.lmin + 1e-5);
  const contrast = m.tm_contrast ?? 0;
  const mm = contrast > 0 ? contrast : 0.3 + 0.7 * Math.pow(lmx - lmn > 1e-9 ? (lmx - st.logAv) / (lmx - lmn) : 0.5, 1.4);
  return { op: 3, A: [Math.exp(-(m.intensity ?? 0)), mm, Math.min(1, Math.max(0, m.adaptation ?? 1)), Math.min(1, Math.max(0, m.correction ?? 0))], B: [st.lav, 0, 0, 0], C: st.mean };
}

/**
 * Apply an image modifier handled here into `dst`. Returns false for types this module does not
 * handle. `mask` is the modifier's mask input (the Mask modifier uses it as the new alpha).
 */
export function applyExtraModifier(c: Compositor, dst: Target, src: Target, m: StripModifier, mask: Target | null): boolean {
  if (m.type === 'HUE_CORRECT') {
    const props = (m.hue_mapping ??= defaultHueCurves());
    const lut = c.lut(`hue:${JSON.stringify(props)}`, 256, () => bakeHueCurves(props, 256));
    c.pass('seq-extra', FS_EXTRA, dst, [src.tex, lut], { uOp: 0 });
    return true;
  }
  if (m.type === 'MASK') {
    if (!mask) {
      c.copy(dst, src);
      return true;
    }
    c.pass('seq-extra', FS_EXTRA, dst, [src.tex, mask.tex], { uOp: 1 });
    return true;
  }
  if (m.type === 'TONEMAP') {
    const u = tonemapUniforms(m, imageStats(c, src));
    c.pass('seq-extra', FS_EXTRA, dst, [src.tex, src.tex], { uOp: u.op, uA: u.A, uB: u.B, uC: u.C });
    return true;
  }
  if (m.type === 'COMPOSITOR') {
    const g = m.node_group ? app.doc.node_groups[m.node_group] : undefined;
    if (!g || g.tree.type !== 'COMPOSITOR') {
      c.copy(dst, src);
      return true;
    }
    const r = runCompositorGroup(app.doc, g, { data: c.readFloat(src), width: src.w, height: src.h });
    if (!r) {
      c.copy(dst, src);
      return true;
    }
    const tex = c.uploadFloat(r.data, src.w, src.h);
    c.pass('seq-copytex', FS_COPYTEX, dst, [tex]);
    c.deleteTexture(tex);
    return true;
  }
  return false;
}

const FS_COPYTEX = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o; uniform sampler2D uTex0;
void main() { o = texture(uTex0, vUv); }`;

// ---------------------------------------------------------------------------
// sound

/** Frequency ratio of a Pitch modifier. */
export function pitchRatio(m: StripModifier): number {
  if (m.pitch_mode === 'RATIO') return Math.max(0.05, Math.min(20, m.ratio ?? 1));
  return Math.pow(2, ((m.semitones ?? 0) + (m.cents ?? 0) / 100) / 12);
}

/**
 * Shift the pitch of samples by `ratio` keeping their duration: resample, then put the length
 * back with overlapping windowed grains (a plain time-domain shifter, good for voices and music
 * within an octave or so).
 */
export function pitchShift(x: Float32Array, ratio: number, rate: number): Float32Array {
  if (Math.abs(ratio - 1) < 1e-4 || x.length < 4) return x;
  const n = x.length;
  const out = new Float32Array(n);
  const norm = new Float32Array(n);
  const grain = Math.max(64, Math.round(rate * 0.04));
  const hop = grain >> 1;
  // grain g of the output starts at g·hop and reads the input from g·hop, played back `ratio` times faster
  for (let start = 0; start < n; start += hop) {
    for (let i = 0; i < grain && start + i < n; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (grain - 1));
      const pos = start + i * ratio;
      const k = Math.floor(pos);
      if (k + 1 >= n) break;
      const f = pos - k;
      out[start + i] += w * (x[k] * (1 - f) + x[k + 1] * f);
      norm[start + i] += w;
    }
  }
  for (let i = 0; i < n; i++) if (norm[i] > 1e-6) out[i] /= norm[i];
  return out;
}

const pitched = new WeakMap<AudioBuffer, Map<number, AudioBuffer>>();

/** A pitch-shifted copy of a buffer (cached per buffer and ratio). */
export function pitchedBuffer(ctx: BaseAudioContext, buf: AudioBuffer, ratio: number): AudioBuffer {
  if (Math.abs(ratio - 1) < 1e-4) return buf;
  let m = pitched.get(buf);
  if (!m) pitched.set(buf, (m = new Map()));
  const key = Math.round(ratio * 1e5);
  const hit = m.get(key);
  if (hit) return hit;
  const out = ctx.createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate);
  for (let ch = 0; ch < buf.numberOfChannels; ch++) out.copyToChannel(pitchShift(buf.getChannelData(ch), ratio, buf.sampleRate) as Float32Array<ArrayBuffer>, ch);
  m.set(key, out);
  return out;
}

/** Echo: the signal plus a delayed, fed-back copy mixed in. Returns the node to continue from. */
export function echoNode(ctx: BaseAudioContext, input: AudioNode, m: StripModifier): AudioNode {
  const delay = ctx.createDelay(5);
  delay.delayTime.value = Math.max(0.001, Math.min(5, m.delay ?? 0.25));
  const fb = ctx.createGain();
  fb.gain.value = Math.max(0, Math.min(0.95, m.feedback ?? 0.5));
  const wet = ctx.createGain();
  wet.gain.value = Math.max(0, Math.min(1, m.mix ?? 0.5));
  const dry = ctx.createGain();
  dry.gain.value = 1 - wet.gain.value;
  const out = ctx.createGain();
  input.connect(dry);
  input.connect(delay);
  delay.connect(fb);
  fb.connect(delay);
  delay.connect(wet);
  dry.connect(out);
  wet.connect(out);
  return out;
}

// ---------------------------------------------------------------------------
// sidebar

/** Panel rows of the modifiers handled here (undefined for other types). */
export function extraModifierUI(s: Strip, m: StripModifier, maskRows: (s: Strip, m: StripModifier) => Child): Child | undefined {
  const audio = { onChange: () => restartPlayback() };
  if (m.type === 'HUE_CORRECT') {
    const props = (m.hue_mapping ??= defaultHueCurves());
    props.curve_kind ??= 'HUE';
    const node = { id: `hue-${s.name}-${m.name}`, type: 'CompositorNodeHueCorrect', name: m.name, location: [0, 0], inputs: {}, props } as unknown as NodeData;
    return [
      h(
        'div',
        { class: 'seq-curves' },
        drawCurves({
          node,
          tree: { type: 'COMPOSITOR', nodes: [], links: [] } as unknown as NodeTreeData,
          key: `seq-hue-${s.name}-${m.name}`,
          where: 'sidebar',
          changed: (label, final) => (app.changed('doc'), final !== false && app.pushUndo(label)),
        }),
      ),
      maskRows(s, m),
    ];
  }
  if (m.type === 'MASK') return [h('div', { class: 'prop-note' }, 'The mask input’s brightness becomes the strip’s opacity'), maskRows(s, m)];
  if (m.type === 'TONEMAP') {
    const simple = (m.tonemap_type ?? 'RH_SIMPLE') === 'RH_SIMPLE';
    return [
      enumProp(m as never, 'tonemap_type', 'Tonemap Type', [
        ['RH_SIMPLE', 'Simple'],
        ['RD_PHOTORECEPTOR', 'Photoreceptor'],
      ]),
      simple
        ? [num(m, 'key', 'Key', { min: 0, max: 1, precision: 3 }), num(m, 'offset', 'Offset', { min: 0.001, max: 10, precision: 3 }), num(m, 'gamma', 'Gamma', { min: 0.001, max: 3, precision: 3 })]
        : [
            num(m, 'intensity', 'Intensity', { min: -8, max: 8, precision: 3 }),
            num(m, 'tm_contrast', 'Contrast', { min: 0, max: 1, slider: true, precision: 3 }),
            num(m, 'adaptation', 'Light Adaptation', { min: 0, max: 1, slider: true, precision: 3 }),
            num(m, 'correction', 'Chromatic Adaptation', { min: 0, max: 1, slider: true, precision: 3 }),
          ],
      maskRows(s, m),
    ];
  }
  if (m.type === 'PITCH')
    return [
      enumProp(m as never, 'pitch_mode', 'Mode', [
        ['SEMITONES', 'Semitones'],
        ['RATIO', 'Ratio'],
      ]),
      m.pitch_mode === 'RATIO'
        ? num(m, 'ratio', 'Ratio', { min: 0.05, max: 20, softMin: 0.25, softMax: 4, precision: 3, ...audio })
        : [num(m, 'semitones', 'Semitones', { int: true, min: -24, max: 24, ...audio }), num(m, 'cents', 'Cents', { int: true, min: -100, max: 100, ...audio })],
      splitRow('', h('span', { class: 'prop-note' }, `Frequency ×${pitchRatio(m).toFixed(3)}`)),
    ];
  if (m.type === 'COMPOSITOR') {
    const groups = Object.values(app.doc.node_groups).filter((g) => g.tree.type === 'COMPOSITOR');
    return [
      h(
        'div',
        { class: 'seq-cmpmod-ng' },
        dataBlockSelector(
          `seq-cmpmod-${s.name}-${m.name}`,
          'node_tree',
          groups,
          m.node_group ?? null,
          (id) => ((m.node_group = id), app.pushUndo('Strip Node Group'), app.changed('doc')),
          () => ((s.active_modifier = m.name), app.run('node.new_compositor_sequencer_node_group')),
          { duplicate: m.node_group ? () => ((s.active_modifier = m.name), app.run('node.duplicate_compositing_modifier_node_group')) : undefined },
        ),
      ),
      h('div', { class: 'prop-note' }, 'Edit the nodes in a Compositor editor set to Sequencer; the first color input receives the strip image'),
    ];
  }
  if (m.type === 'ECHO')
    return [
      num(m, 'delay', 'Delay', { min: 0.001, max: 5, unit: 'time', precision: 3, ...audio }),
      num(m, 'feedback', 'Feedback', { min: 0, max: 0.95, slider: true, precision: 3, ...audio }),
      num(m, 'mix', 'Mix', { min: 0, max: 1, slider: true, precision: 3, ...audio }),
    ];
  return undefined;
}
