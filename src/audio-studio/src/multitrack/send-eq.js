// Send and track EQ controls shared by the Mixer strips and the track
// headers. A track shows one send at a time (picked from its eight) with
// power, pre/post fader, level, pan and destination bus; the EQ shows a small
// response curve with power and an edit button that opens the parametric EQ.

import { h } from '../lib/dom.js';
import { icon } from '../ui/icons.js';
import { knob, hotNumber } from '../ui/controls.js';
import { getEffect } from '../effects/registry.js';
import { openEffectDialog } from '../effects/dialog.js';
import { normalizeValues } from '../effects/params.js';
import { cssVar } from '../ui/theme.js';
import { setSend, updateTrack, findTrack, wouldCycle, MAX_SENDS, SILENT_DB } from '../model/session-edits.js';
import { formatGainShort, formatPan, parseGain } from './levels.js';

/** Switches one effect of a track's chain on or off as an undo step (Mixer strips, track headers). */
export function toggleTrackEffect(doc, trackId, index) {
  const track = findTrack(doc.state, trackId);
  const slot = track?.fx[index];
  if (!slot) return;
  const fx = track.fx.slice();
  fx[index] = { ...slot, enabled: slot.enabled === false };
  doc.endGesture();
  doc.apply(slot.enabled === false ? 'Effect On' : 'Effect Off', updateTrack(doc.state, trackId, { fx }));
}

/** Controls for the sends of one track. `compact` lays them out on one row (track headers). */
export class SendControls {
  constructor(app, doc, trackId, { compact = false } = {}) {
    this.app = app;
    this.doc = doc;
    this.id = trackId;
    this.index = 0;
    this.track = null;
    const edit = (patch, phase = 'change') => {
      doc.apply('Track Send', setSend(doc.state, this.id, this.index, patch), { coalesce: `send:${this.id}:${this.index}` });
      if (phase === 'change') doc.endGesture();
    };
    const level = (v) => (v <= -60 ? SILENT_DB : v);
    this.sel = h('select.select.mx-select.mx-send-sel', { 'aria-label': 'Send', title: 'Choose a send to show' });
    this.sel.addEventListener('change', () => {
      this.index = Number(this.sel.value);
      this.update(this.track);
    });
    this.power = h('button.mt-tb.mt-tb-power', { type: 'button', 'aria-label': 'Send on', title: 'Send On/Off', 'aria-pressed': 'false', onclick: () => edit({ on: !this.send()?.on }) }, icon('power', 12));
    this.pre = h('button.mt-tb.mt-tb-power.mx-send-pre', { type: 'button', 'aria-label': 'Pre-fader send', title: 'Pre-Fader (send before the track volume and pan)', 'aria-pressed': 'false', onclick: () => edit({ pre: !this.send()?.pre }) }, 'Pre');
    this.target = h('select.select.mx-select.mx-send-target', { 'aria-label': 'Send destination', title: 'Send To' });
    this.target.addEventListener('change', () => edit({ target: this.target.value || null }));
    if (compact) {
      this.level = hotNumber({ value: 0, min: SILENT_DB, max: 12, step: 0.1, defaultValue: 0, label: 'Send level (dB)', format: formatGainShort, parse: parseGain, onInput: (v) => edit({ level: v }, 'input'), onChange: (v) => edit({ level: v }) });
      this.pan = null;
      this.el = h('div.mt-th-sends', this.sel, this.power, this.pre, this.level, h('span.mt-th-glyph', { 'aria-hidden': 'true' }, icon('corner-down-right', 12)), this.target);
    } else {
      this.level = knob({ value: 0, min: -60, max: 12, step: 0.1, defaultValue: 0, label: 'Send level', format: (v) => formatGainShort(level(v)), size: 22, onInput: (v) => edit({ level: level(v) }, 'input'), onChange: (v) => edit({ level: level(v) }) });
      this.pan = knob({ value: 0, min: -100, max: 100, step: 1, defaultValue: 0, bipolar: true, label: 'Send pan', format: formatPan, size: 22, onInput: (v) => edit({ pan: v }, 'input'), onChange: (v) => edit({ pan: v }) });
      this.el = h(
        'div.mx-sends',
        { role: 'group', 'aria-label': 'Sends' },
        h('div.mx-fx-head', this.sel, h('div.spacer'), this.power, this.pre),
        h('div.mx-send-knobs', this.level, this.pan),
        h('label.mx-io-row', icon('corner-down-right', 12), this.target),
      );
    }
  }

  send() {
    return this.track?.sends?.[this.index] || null;
  }

  update(track) {
    this.track = track;
    const state = this.doc.state;
    // Bus outputs and sends decide which buses would make a loop (wouldCycle).
    const busKey = (b) => `${b.id}:${b.name}:${b.output}:${(b.sends || []).map((x) => x?.target || '').join('/')}`;
    const key = `${this.index}|${JSON.stringify(track.sends || [])}|${state.tracks.map((b) => (b.type === 'bus' ? busKey(b) : '')).join(',')}`;
    if (key === this.key) return;
    this.key = key;
    this.sel.replaceChildren(
      ...Array.from({ length: MAX_SENDS }, (_, i) => {
        const snd = track.sends?.[i];
        const to = snd?.target && state.tracks.find((b) => b.id === snd.target);
        return h('option', { value: String(i), selected: i === this.index, title: to ? `Send ${i + 1} to ${to.name}` : `Send ${i + 1}` }, `S${i + 1}${to ? ' •' : ''}`);
      }),
    );
    const snd = this.send();
    this.power.setAttribute('aria-pressed', String(Boolean(snd?.on && snd.target)));
    this.pre.setAttribute('aria-pressed', String(Boolean(snd?.pre)));
    this.level.setValue(this.pan ? Math.max(-60, snd?.level ?? 0) : snd?.level ?? 0);
    this.pan?.setValue(snd?.pan ?? 0);
    const opts = [h('option', { value: '' }, 'None')];
    for (const b of state.tracks) if (b.type === 'bus' && b.id !== track.id && (b.id === snd?.target || !wouldCycle(state, track.id, b.id))) opts.push(h('option', { value: b.id }, b.name));
    this.target.replaceChildren(...opts);
    this.target.value = snd?.target || '';
    for (const c of [this.power, this.pre, this.level, this.pan]) c?.classList.toggle('dim', !snd?.target);
  }
}

/** Track EQ: response curve, power and edit. */
export class EqControls {
  constructor(app, doc, trackId, { compact = false } = {}) {
    this.app = app;
    this.doc = doc;
    this.id = trackId;
    this.def = getEffect('parametricEq');
    this.track = null;
    this.canvas = h('canvas.mx-eq-curve', { 'aria-hidden': 'true', title: 'Double-click to edit the EQ' });
    const setEq = (patch, label = 'Track EQ') => doc.apply(label, updateTrack(doc.state, this.id, { eq: { ...this.track.eq, ...patch } }), { coalesce: `eq:${this.id}` });
    this.power = h('button.mt-tb.mt-tb-power', { type: 'button', 'aria-label': 'EQ on', title: 'EQ On/Off', 'aria-pressed': 'false', onclick: () => {
      setEq({ on: !this.track.eq?.on }, this.track.eq?.on ? 'Track EQ Off' : 'Track EQ On');
      doc.endGesture();
    } }, icon('power', 12));
    const edit = async () => {
      if (!this.def) return;
      const t = this.track;
      doc.endGesture();
      await openEffectDialog(app, this.def, {
        mode: 'edit',
        title: `Track EQ: ${t.name}`,
        values: t.eq?.values,
        enabled: Boolean(t.eq?.on),
        doc: null,
        onChange: (values) => setEq({ values }),
        onPower: (on) => setEq({ on }),
      });
      doc.endGesture();
    };
    this.editBtn = h('button.icon-btn.sm', { type: 'button', 'aria-label': 'Edit EQ', title: 'Edit EQ', onclick: edit }, icon('sliders-horizontal', 13));
    this.canvas.addEventListener('dblclick', edit);
    if (!this.def) this.el = null;
    else if (compact) this.el = h('div.mt-th-eq', this.canvas, this.power, this.editBtn);
    else this.el = h('div.mx-eq', { role: 'group', 'aria-label': 'EQ' }, h('div.mx-fx-head', h('span', 'EQ'), h('div.spacer'), this.power, this.editBtn), this.canvas);
  }

  update(track) {
    this.track = track;
    if (!this.el) return;
    const eq = track.eq || { on: false, values: {} };
    this.power.setAttribute('aria-pressed', String(Boolean(eq.on)));
    const key = JSON.stringify(eq);
    if (key === this.key && this.canvas.width) return;
    this.key = key;
    drawEqCurve(this.canvas, this.def, eq, this.doc.sampleRate);
  }
}

/** Draws a track EQ's magnitude response (±18 dB) to fit its canvas. */
export function drawEqCurve(canvas, def, eq, rate) {
  const dpr = window.devicePixelRatio || 1;
  const W = Math.max(40, Math.round(canvas.clientWidth || 80));
  const H = Math.max(16, Math.round(canvas.clientHeight || 28));
  if (canvas.width !== W * dpr || canvas.height !== H * dpr) {
    canvas.width = W * dpr;
    canvas.height = H * dpr;
  }
  const ctx = canvas.getContext?.('2d');
  if (!ctx || !def) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = cssVar('--meter-bg');
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = cssVar('--border-soft');
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, Math.round(H / 2) + 0.5);
  ctx.lineTo(W, Math.round(H / 2) + 0.5);
  ctx.stroke();
  const freqs = Float32Array.from({ length: W }, (_, i) => 20 * Math.pow(1000, i / (W - 1)));
  let db;
  try {
    db = def.response(normalizeValues(def, eq.values || {}), freqs, rate);
  } catch {
    return;
  }
  ctx.strokeStyle = eq.on ? cssVar('--accent') : cssVar('--text-faint');
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 0; i < W; i++) {
    const y = H / 2 - (Math.max(-18, Math.min(18, db[i])) / 18) * (H / 2 - 2);
    if (i) ctx.lineTo(i, y);
    else ctx.moveTo(i, y);
  }
  ctx.stroke();
}
