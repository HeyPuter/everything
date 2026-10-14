// One channel row of the rack: the row controls (mute LED, pan and volume
// knobs, mixer insert, selection marker, name button) and the step cells or,
// when the channel's notes do not fit the step model, a read-only mini
// piano-roll preview. The row patches itself: setChannel and setNotes compare
// references and touch only the cells whose state changed.

import { h } from '../lib/dom.js';
import { formatDb, formatPan } from '../lib/util.js';
import { createKnob } from '../ui/knob.js';
import { icon } from '../ui/icons.js';
import { cssVar } from '../ui/theme.js';
import { STEP } from '../model/time.js';
import { createInsertSpin } from './insert-spin.js';
import { fitsSteps, stepStates, stepsPerBeat, stepsPerBar } from './steps.js';

export const VOLUME = { id: 'volume', label: 'Volume', min: 0, max: 1.25, def: 0.78 };
export const PAN = { id: 'pan', label: 'Pan', min: -1, max: 1, def: 0 };

/** Grid columns: the row controls, then one column per step. */
export const COL = { mute: 0, pan: 1, vol: 2, insert: 3, sel: 4, name: 5, steps: 6 };
export const PHONE_HIDDEN = new Set([COL.pan, COL.vol, COL.insert, COL.sel]);

const cellLabel = (i, v) => (v < 0 ? `Step ${i + 1}, off` : `Step ${i + 1}, on${v < 0.995 ? `, velocity ${Math.round(v * 100)}%` : ''}`);

export class RackRow {
  /**
   * `view` supplies: knob(ch id, param, phase, value), insertName(i),
   * stepX(i), stepsW, stepW, previewH.
   */
  constructor(view, ch) {
    this.view = view;
    this.id = ch.id;
    this.ch = null;
    this.notes = undefined;
    this.root = null;
    this.count = 0;
    this.sigKey = '';
    this.fits = true;
    this.cells = [];
    this.states = new Float32Array(0);
    this.shown = new Float32Array(0);
    this.build(ch);
  }

  build(ch) {
    const knob = (param, fmt, label) =>
      createKnob({
        param,
        value: ch[param.id],
        label,
        ariaLabel: `${ch.name} ${label.toLowerCase()}`,
        size: 20,
        showLabel: false,
        format: fmt,
        onStart: () => this.view.knob(this.id, param.id, 'start'),
        onInput: (v) => this.view.knob(this.id, param.id, 'input', v),
        onEnd: (v) => this.view.knob(this.id, param.id, 'end', v),
      });
    this.pan = knob(PAN, formatPan, 'Pan');
    this.vol = knob(VOLUME, formatDb, 'Volume');
    for (const k of [this.pan, this.vol]) {
      k.el.tabIndex = -1;
      k.el.classList.add('rack-knob');
    }
    this.pan.el.dataset.col = String(COL.pan);
    this.vol.el.dataset.col = String(COL.vol);
    this.insert = createInsertSpin({
      max: this.view.mixerMax(),
      value: ch.mixer,
      label: `${ch.name} mixer insert`,
      nameOf: (i) => this.view.insertName(i),
      onStart: () => this.view.insertGesture(this.id, 'start'),
      onInput: (v) => this.view.insertGesture(this.id, 'input', v),
      onEnd: (v) => this.view.insertGesture(this.id, 'end', v),
    });
    this.insert.el.dataset.col = String(COL.insert);
    this.led = h('button.led.rack-mute', { type: 'button', tabindex: '-1', dataset: { col: String(COL.mute) } });
    this.sel = h('button.rack-sel', { type: 'button', tabindex: '-1', dataset: { col: String(COL.sel) } });
    this.nameText = h('span.rack-name-text');
    this.nameBtn = h('button.rack-name', { type: 'button', tabindex: '-1', draggable: 'true', 'aria-haspopup': 'menu', dataset: { col: String(COL.name) } }, h('span.rack-chip'), this.nameText);
    this.grip = h('span.rack-grip', { 'aria-hidden': 'true', title: 'Drag to reorder (Alt+Up / Alt+Down)' }, icon('grip-vertical', 12));
    const cell = (cls, child, role = 'gridcell') => h(`div.rack-c.${cls}`, { role }, child);
    this.ctl = h(
      'div.rack-ctl',
      { role: 'none' },
      this.grip,
      cell('c-mute', this.led),
      cell('c-pan', this.pan.el),
      cell('c-vol', this.vol.el),
      cell('c-ins', this.insert.el),
      cell('c-sel', this.sel),
      cell('c-name', this.nameBtn, 'rowheader'),
    );
    this.stepsEl = h('div.rack-steps', { role: 'none' });
    this.canvas = h('canvas.rack-preview-canvas', { 'aria-hidden': 'true' });
    this.preview = h('div.rack-preview', { role: 'gridcell', tabindex: '-1', dataset: { col: String(COL.steps) }, hidden: true }, this.canvas);
    this.el = h('div.rack-row', { role: 'row', dataset: { id: this.id } }, this.ctl, this.stepsEl, this.preview);
  }

  /** Updates the controls from the channel (no-op when unchanged) and the per-sync flags. */
  setChannel(ch, { audible = true, selected = false, primary = false } = {}) {
    if (ch !== this.ch) {
      const prev = this.ch;
      this.ch = ch;
      if (!prev || prev.name !== ch.name) {
        this.nameText.textContent = ch.name;
        this.nameBtn.title = `${ch.name}: click to select, double-click or Enter for the editor, right-click for options`;
        this.pan.el.setAttribute('aria-label', `${ch.name} pan`);
        this.vol.el.setAttribute('aria-label', `${ch.name} volume`);
        this.insert.el.setAttribute('aria-label', `${ch.name} mixer insert`);
        this.sel.setAttribute('aria-label', `Select ${ch.name}`);
      }
      if (!prev || prev.color !== ch.color) {
        this.el.style.setProperty('--ch', ch.color);
        if (!this.fits) this.drawPreview();
      }
      this.pan.set(ch.pan);
      this.vol.set(ch.volume);
      this.insert.set(ch.mixer);
      this.led.setAttribute('aria-pressed', String(!ch.mute));
      this.led.classList.toggle('solo', ch.solo);
      this.led.setAttribute('aria-label', `${ch.name}: ${ch.mute ? 'muted' : 'on'}${ch.solo ? ', solo' : ''}`);
      this.led.title = `${ch.mute ? 'Unmute' : 'Mute'} ${ch.name} (click). Solo: Ctrl+click or right-click`;
    }
    this.el.classList.toggle('inaudible', !audible);
    this.el.classList.toggle('selected', selected);
    this.el.classList.toggle('primary', primary);
    this.sel.setAttribute('aria-pressed', String(selected));
    this.el.setAttribute('aria-selected', String(selected));
  }

  /** (Re)creates the step cells for `count` steps in time signature `sig`. */
  buildCells(count, sig) {
    const spb = stepsPerBeat(sig);
    const spBar = stepsPerBar(sig);
    const frag = document.createDocumentFragment();
    const cells = new Array(count);
    for (let i = 0; i < count; i++) {
      const beat = Math.floor(i / spb);
      let cls = 'div.step';
      if (beat % 2) cls += '.alt';
      if (i > 0 && i % spb === 0) cls += i % spBar === 0 ? '.bar' : '.beat';
      const c = h(cls, { role: 'gridcell', tabindex: '-1', dataset: { step: String(i), col: String(COL.steps + i) } });
      cells[i] = c;
      frag.append(c);
    }
    this.stepsEl.replaceChildren(frag);
    this.cells = cells;
    this.count = count;
    this.sigKey = sig.join('/');
    this.states = new Float32Array(count);
    this.shown = new Float32Array(count).fill(NaN);
  }

  /** Shows the channel's notes in this pattern; patches only changed cells. */
  setNotes(notes, count, sig, force = false) {
    const root = this.ch?.root;
    const sigKey = sig.join('/');
    if (!force && notes === this.notes && count === this.count && root === this.root && sigKey === this.sigKey) return false;
    if (count !== this.count || sigKey !== this.sigKey) this.buildCells(count, sig);
    this.notes = notes;
    this.root = root;
    const fits = fitsSteps(notes, root);
    if (fits !== this.fits) {
      this.fits = fits;
      this.stepsEl.hidden = !fits;
      this.preview.hidden = fits;
      this.el.classList.toggle('has-preview', !fits);
    }
    if (fits) {
      stepStates(notes, count, this.states);
      for (let i = 0; i < count; i++) {
        const v = this.states[i];
        if (v === this.shown[i]) continue;
        this.shown[i] = v;
        const c = this.cells[i];
        c.classList.toggle('on', v >= 0);
        if (v >= 0) c.style.setProperty('--vel', v.toFixed(2));
        else c.style.removeProperty('--vel');
        c.setAttribute('aria-label', cellLabel(i, v));
      }
    } else {
      const n = notes?.length || 0;
      this.preview.setAttribute('aria-label', `${n} note${n === 1 ? '' : 's'} that do not fit the steps. Press Enter to open in the piano roll`);
      this.preview.title = 'These notes use the piano roll. Click to open it';
      this.drawPreview();
    }
    return true;
  }

  setPlay(step, on) {
    if (this.fits) this.cells[step]?.classList.toggle('play', on);
  }

  /** Element for grid column `col` (steps clamp to the last one). */
  focusable(col) {
    switch (col) {
      case COL.mute:
        return this.led;
      case COL.pan:
        return this.pan.el;
      case COL.vol:
        return this.vol.el;
      case COL.insert:
        return this.insert.el;
      case COL.sel:
        return this.sel;
      case COL.name:
        return this.nameBtn;
      default:
        if (!this.fits) return this.preview;
        return this.cells[Math.min(col - COL.steps, this.count - 1)] || this.nameBtn;
    }
  }

  lastCol() {
    return this.fits ? COL.steps + this.count - 1 : COL.steps;
  }

  /** Draws the mini piano roll (notes laid out on the step columns). */
  drawPreview() {
    if (this.fits) return;
    const v = this.view;
    const w = Math.max(1, Math.round(v.stepsW));
    const hgt = v.previewH;
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const cv = this.canvas;
    cv.style.width = `${w}px`;
    cv.style.height = `${hgt}px`;
    if (cv.width !== w * dpr || cv.height !== hgt * dpr) {
      cv.width = w * dpr;
      cv.height = hgt * dpr;
    }
    let ctx = null;
    try {
      ctx = cv.getContext('2d');
    } catch {
      ctx = null;
    }
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hgt);
    const sig = this.sigKey.split('/').map(Number);
    const spb = stepsPerBeat(sig);
    const sw = v.stepW;
    // Beat bands like the step cells.
    const off = cssVar('--step-off');
    const alt = cssVar('--step-off-alt');
    for (let b = 0; b * spb < this.count; b++) {
      const x0 = v.stepX(b * spb);
      const last = Math.min(this.count, (b + 1) * spb) - 1;
      ctx.fillStyle = b % 2 ? alt : off;
      ctx.globalAlpha = 0.55;
      ctx.fillRect(x0, 0, v.stepX(last) + sw - x0, hgt);
    }
    ctx.globalAlpha = 1;
    const notes = this.notes || [];
    if (!notes.length) return;
    let lo = 127;
    let hi = 0;
    for (const n of notes) {
      if (n.key < lo) lo = n.key;
      if (n.key > hi) hi = n.key;
    }
    const span = Math.max(12, hi - lo + 1);
    const mid = (lo + hi) / 2;
    lo = Math.floor(mid - span / 2);
    const rowH = (hgt - 4) / span;
    const nh = Math.max(3, Math.min(6, rowH));
    const end = this.count * STEP;
    const tx = (t) => {
      const s = Math.min(this.count - 1, Math.floor(t / STEP));
      return v.stepX(s) + ((t - s * STEP) / STEP) * sw;
    };
    ctx.fillStyle = this.ch?.color || cssVar('--accent');
    for (const n of notes) {
      if (n.pos >= end) continue;
      const x0 = tx(n.pos);
      const x1 = n.pos + n.len >= end ? v.stepX(this.count - 1) + sw : tx(n.pos + n.len);
      const y = 2 + (hgt - 4) - (n.key - lo + 1) * rowH + (rowH - nh) / 2;
      ctx.globalAlpha = 0.6 + 0.4 * n.vel;
      ctx.fillRect(x0, Math.round(y), Math.max(2, x1 - x0 - 1), nh);
    }
    ctx.globalAlpha = 1;
  }
}
