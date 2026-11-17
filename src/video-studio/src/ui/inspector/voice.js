/**
 * Voice tab: a grid of voice effects (model/audio.js VOICE_PRESETS, DSP in
 * media/audio-fx.js) with their one or two settings, a short live preview
 * when one is picked and "Apply to all audio clips" as one undo step.
 */
import '../../styles/audio-fx.css';
import { h, announce } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { US } from '../../lib/time.js';
import { VOICE_PRESETS, voicePreset, defaultVoiceParams, ensureAudioFx } from '../../model/audio.js';
import { slider, choiceGrid, propSection } from './common.js';

const NS = 'http://www.w3.org/2000/svg';

/** Deterministic pseudo-noise in [-1, 1] for glyph shapes. */
const jitter = (i) => {
  const x = Math.sin(i * 12.9898) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
};

/** Waveform shape (x in 0..1 -> y in -1..1) that hints at what each effect does. */
const SHAPES = {
  none: (x) => Math.sin(x * Math.PI * 4) * 0.7,
  low: (x) => Math.sin(x * Math.PI * 2) * 0.9,
  high: (x) => Math.sin(x * Math.PI * 10) * 0.6,
  squeaky: (x) => Math.sin(x * Math.PI * 18) * 0.45,
  giant: (x) => Math.tanh(Math.sin(x * Math.PI * 2) * 3) * 0.85,
  android: (x) => (Math.sin(x * Math.PI * 8) >= 0 ? 0.6 : -0.6),
  phone: (x) => Math.max(-0.4, Math.min(0.4, Math.sin(x * Math.PI * 6) * 0.9)),
  twoway: (x, i) => Math.max(-0.45, Math.min(0.45, Math.sin(x * Math.PI * 6))) + jitter(i) * 0.12,
  bullhorn: (x) => ((x * 3) % 1) * 1.4 - 0.7,
  submerged: (x) => Math.sin(x * Math.PI * 5) * (0.25 + 0.5 * Math.sin(x * Math.PI) ** 2),
  hall: (x) => Math.sin(x * Math.PI * 9) * 0.9 * Math.exp(-x * 1.4),
  closet: (x) => Math.sin(x * Math.PI * 9) * 0.9 * Math.exp(-x * 6),
  canyon: (x) => Math.sin(x * Math.PI * 24) * Math.exp(-((x * 3) % 1) * 7) * 0.9 * (1 - Math.floor(x * 3) * 0.3),
  ensemble: (x) => (Math.sin(x * Math.PI * 6) + Math.sin(x * Math.PI * 6.6 + 1) + Math.sin(x * Math.PI * 5.4 + 2)) * 0.28,
  amradio: (x, i) => Math.sin(x * Math.PI * 4) * 0.55 + jitter(i) * 0.2,
  wobble: (x) => Math.sin(x * Math.PI * 6 + Math.sin(x * Math.PI * 4) * 2.5) * 0.65,
  lowend: (x) => Math.sin(x * Math.PI * 2) * 0.6 + Math.sin(x * Math.PI * 12) * 0.15,
  spirit: (x) => Math.sin(x * Math.PI * 8 * (0.5 + x)) * 0.7 * Math.exp(-x * 1.2),
};

/** Small original SVG wave for a tile. */
export function voiceGlyph(id) {
  const shape = SHAPES[id || 'none'] || SHAPES.none;
  const W = 56;
  const H = 24;
  const pts = [];
  for (let i = 0; i <= 80; i++) {
    const x = i / 80;
    pts.push(`${(x * W).toFixed(1)},${(H / 2 - shape(x, i) * (H / 2 - 2)).toFixed(1)}`);
  }
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'voice-glyph');
  const line = document.createElementNS(NS, 'polyline');
  line.setAttribute('points', pts.join(' '));
  svg.append(line);
  return svg;
}

/** Clips that play sound and can carry a voice effect. */
export function soundClips(project) {
  const out = [];
  for (const t of project.tracks) {
    if (t.locked) continue;
    for (const c of t.clips) {
      if (c.type === 'audio' || (c.type === 'video' && project.assets[c.assetId]?.hasAudio && !c.audioDetached && !c.freeze)) out.push(c);
    }
  }
  return out;
}

let previewTimer = 0;
let stopWatching = null;

/** Play a few seconds of the clip (from the playhead when it is over the clip) so the effect is heard. */
export function previewClip(view, seconds = 3.5) {
  const player = view.ctx.player;
  const store = view.store;
  const c = view.clip;
  if (!player || !c || player.playing) return false;
  const t = store.time;
  const from = t >= c.start && t < c.start + c.duration - 0.5 * US ? t : c.start;
  store.seek(from);
  clearTimeout(previewTimer);
  stopWatching?.();
  player.play();
  // The preview ends itself only while it is still the same playback: once the user pauses
  // (and maybe plays again), the playback is theirs and is left alone.
  const timer = setTimeout(() => {
    stopWatching?.();
    if (!player.playing) return;
    player.pause();
    store.seek(from);
  }, seconds * 1000);
  previewTimer = timer;
  const off = player.on?.('play', ({ playing }) => {
    if (playing) return;
    clearTimeout(timer);
    stopWatching?.();
  });
  stopWatching = () => {
    stopWatching = null;
    off?.();
  };
  return true;
}

export function voiceTab(view, state = {}) {
  state.voicePreview ??= true;
  const items = [{ id: null, label: 'Original', preview: voiceGlyph(null) }, ...VOICE_PRESETS.map((p) => ({ id: p.id, label: p.label, preview: voiceGlyph(p.id) }))];
  const grid = choiceGrid({
    label: 'Voice effect',
    className: 'voice-grid',
    items,
    value: view.clip.audioFx?.voice?.id || null,
    onPick: (id) => {
      view.edit(id ? 'Voice effect' : 'Remove voice effect', (c) => {
        const fx = ensureAudioFx(c);
        fx.voice = id ? { id, params: fx.voice?.id === id ? fx.voice.params : defaultVoiceParams(id) } : null;
      });
      announce(id ? `${voicePreset(id).label} voice` : 'Original voice');
      if (id && state.voicePreview) previewClip(view);
    },
  });
  VOICE_PRESETS.forEach((p, i) => grid.buttons[i + 1].style.setProperty('--voice-hue', String(p.hue)));

  const params = h('div.voice-params');
  let shownId;
  const renderParams = () => {
    const c = view.clip;
    if (!c) return;
    const v = c.audioFx?.voice || null;
    grid.set(v?.id || null);
    if ((v?.id || null) === shownId) return;
    shownId = v?.id || null;
    const p = v ? voicePreset(v.id) : null;
    if (!p) {
      params.replaceChildren(h('p.insp-empty', 'Pick an effect to change how voices sound.'));
      return;
    }
    params.replaceChildren(...p.params.map((d) => slider(view, {
      label: d.label,
      min: d.min,
      max: d.max,
      step: d.step || 1,
      unit: d.unit || '',
      get: (x) => (x.audioFx?.voice?.id === p.id ? x.audioFx.voice.params[d.key] ?? d.def : d.def),
      set: (val, final) => view.edit(`${p.label}: ${d.label.toLowerCase()}`, (x) => {
        if (x.audioFx?.voice?.id !== p.id) return false;
        x.audioFx.voice.params[d.key] = val;
      }, { key: `voice-${d.key}`, final }),
    }).el));
  };
  renderParams();
  view.bind(renderParams);

  const previewSw = h('input', { type: 'checkbox', checked: state.voicePreview });
  previewSw.addEventListener('change', () => {
    state.voicePreview = previewSw.checked;
  });
  const listen = h('button.btn.small', { type: 'button' }, icon('headphones', 14), 'Listen');
  listen.addEventListener('click', () => previewClip(view));
  const all = h('button.btn.small', { type: 'button' }, icon('copy', 14), 'Apply to all audio clips');
  all.addEventListener('click', () => {
    const voice = view.clip?.audioFx?.voice || null;
    let n = 0;
    view.store.update('Apply voice to all', (p) => {
      for (const c of soundClips(p)) {
        if (!voice && !c.audioFx?.voice) continue;
        ensureAudioFx(c).voice = voice ? structuredClone(voice) : null;
        n++;
      }
      return n > 0;
    }, { structural: false });
    view.store.seal();
    announce(n ? `${voice ? voicePreset(voice.id).label : 'Original'} voice on ${n} ${n === 1 ? 'clip' : 'clips'}` : 'Nothing to change');
  });

  return h('div.voice-tab',
    propSection('Voice effects', [
      h('div.voice-tools', h('label.fx-check', previewSw, h('span', 'Play a preview when picking')), listen),
      grid.el,
    ]),
    propSection('Effect settings', [params]),
    h('div.voice-apply', all),
  );
}
