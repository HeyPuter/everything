// Mixer controller: the selected insert and every mixer action, each going
// through the store (one undo step per action; continuous gestures use
// begin/preview/commit). The panel, its menus, the commands and the effect
// editors all call this, so behaviour is the same wherever it starts.
//
// Events: 'select' (index) when the selected insert changes.

import { Emitter } from '../lib/emitter.js';
import * as E from '../model/edits.js';
import { COLORS } from '../model/project.js';
import { EFFECTS, effectsByCategory } from '../effects/catalog.js';
import { UNITY } from './db.js';
import * as R from './routing.js';
import * as S from './slots.js';

export class MixerController extends Emitter {
  constructor(app) {
    super();
    this.app = app;
    this.store = app.store;
    this.selected = this.store.project.mixer.length > 1 ? 1 : 0;
    // The selected insert follows the rack's channel selection.
    this.store.on('view', () => {
      const ch = this.store.channel;
      if (ch && ch.id !== this.lastChannel) {
        this.lastChannel = ch.id;
        if (ch.mixer > 0 && this.store.project.mixer[ch.mixer]) this.select(ch.mixer);
      }
    });
    this.lastChannel = this.store.channel?.id ?? null;
    this.store.on('change', (p) => {
      if (this.selected >= p.mixer.length) this.select(p.mixer.length - 1);
    });
  }

  get project() {
    return this.store.project;
  }

  get track() {
    return this.project.mixer[this.selected] || null;
  }

  label(i = this.selected) {
    return R.trackLabel(this.project, i);
  }

  select(i) {
    const n = Math.max(0, Math.min(this.project.mixer.length - 1, i));
    if (n === this.selected) return;
    this.selected = n;
    this.emit('select', n);
  }

  // ---------------------------------------------------------------- strips

  /** Knob/fader callbacks for a continuous control: one undo step per gesture. */
  gesture(label, edit, target) {
    const store = this.store;
    return {
      onStart: () => store.begin(label),
      onInput: (v) => {
        store.preview((p) => edit(p, v));
        if (target) this.app.lastTweaked = { label: typeof target.label === 'function' ? target.label() : label, target: target.target ?? target };
      },
      onEnd: () => store.commit(),
    };
  }

  trackGesture(i, param, label) {
    return this.gesture(label, (p, v) => E.updateMixerTrack(p, i, { [param]: v }), {
      label: () => `${this.label(i)} ${param}`,
      target: { kind: 'mixer', track: i, param },
    });
  }

  addInsert() {
    const r = this.store.apply('Add mixer insert', (p) => E.addMixerTrack(p));
    if (r?.index !== undefined) this.select(r.index);
    return r?.index;
  }

  rename(i, name) {
    const n = String(name || '').trim().slice(0, 40);
    if (!n) return;
    this.store.apply('Rename insert', (p) => E.updateMixerTrack(p, i, { name: n }));
  }

  setColor(i, color) {
    this.store.apply('Insert color', (p) => E.updateMixerTrack(p, i, { color }));
  }

  toggleMute(i) {
    const t = this.project.mixer[i];
    if (!t) return;
    this.store.apply(t.mute ? 'Unmute insert' : 'Mute insert', (p) => E.updateMixerTrack(p, i, { mute: !t.mute }));
  }

  solo(i, { add = false } = {}) {
    if (i === 0) return;
    this.store.apply('Solo insert', (p) => R.soloInsert(p, i, { add }));
  }

  resetVolume(i) {
    this.store.apply('Reset volume', (p) => E.updateMixerTrack(p, i, { volume: UNITY }));
  }

  resetPanWidth(i) {
    this.store.apply('Reset pan and width', (p) => E.updateMixerTrack(p, i, { pan: 0, width: 1 }));
  }

  resetStrip(i) {
    this.store.apply('Reset volume and pan', (p) => E.updateMixerTrack(p, i, { volume: UNITY, pan: 0, width: 1 }));
  }

  // ---------------------------------------------------------------- routing

  /** Toggles the send from `from` to `to`; refusals are explained in a toast. Returns whether it changed. */
  toggleRoute(from, to) {
    const on = Boolean(this.project.mixer[from]?.routes?.[to]);
    if (!on) {
      const check = R.canRoute(this.project, from, to);
      if (!check.ok) {
        this.app.notify(check.reason, { error: true });
        return false;
      }
    }
    this.store.apply(on ? 'Remove send' : 'Add send', (p) => R.toggleRoute(p, from, to));
    this.app.notify(on ? `${this.label(from)} no longer sends to ${this.label(to)}` : `${this.label(from)} now sends to ${this.label(to)}`);
    return true;
  }

  routeGesture(from, to) {
    return this.gesture('Send level', (p, v) => R.setRouteGain(p, from, to, v), null);
  }

  removeRoute(from, to) {
    this.store.apply('Remove send', (p) => E.setRoute(p, from, to, 0));
  }

  routeMasterOnly(i) {
    this.store.apply('Route to master only', (p) => R.routeMasterOnly(p, i));
  }

  /** Points the rack's selected channels at insert `i`. */
  routeSelectedChannels(i = this.selected) {
    const ids = [...this.store.view.selectedChannels];
    if (!ids.length) {
      this.app.notify('Select channels in the channel rack first.');
      return;
    }
    this.store.apply('Route channels to insert', (p) => R.routeChannels(p, ids, i));
    this.app.notify(`${ids.length === 1 ? '1 channel' : `${ids.length} channels`} now play through ${this.label(i)}`);
  }

  routeChannel(id, i) {
    const ch = this.project.channels.find((c) => c.id === id);
    if (!ch) return;
    this.store.apply('Route channel to insert', (p) => R.routeChannels(p, [id], i));
    this.app.notify(`${ch.name} now plays through ${this.label(i)}`);
  }

  moveInputs(from, to) {
    this.store.apply('Move channel inputs', (p) => R.moveChannelInputs(p, from, to));
  }

  // ---------------------------------------------------------------- effects

  addEffect(i, type, at) {
    if (!EFFECTS[type]) return null;
    const t = this.project.mixer[i];
    if (!t) return null;
    if (t.fx.length >= S.MAX_FX_SLOTS) {
      this.app.notify(`${this.label(i)} already has ${S.MAX_FX_SLOTS} effects. Remove one first.`, { error: true });
      return null;
    }
    const r = this.store.apply(`Add ${EFFECTS[type].label}`, (p) => S.addEffect(p, i, type, at));
    return r?.id ?? null;
  }

  replaceEffect(i, slotId, type) {
    const r = this.store.apply(`Replace with ${EFFECTS[type].label}`, (p) => S.replaceEffect(p, i, slotId, type));
    return r?.id ?? null;
  }

  removeEffect(i, slotId) {
    const s = S.slotById(this.project, i, slotId);
    if (!s) return;
    this.store.apply(`Remove ${EFFECTS[s.type]?.label || 'effect'}`, (p) => E.removeSlot(p, i, slotId));
  }

  duplicateEffect(i, slotId) {
    if (this.project.mixer[i]?.fx.length >= S.MAX_FX_SLOTS) {
      this.app.notify(`${this.label(i)} already has ${S.MAX_FX_SLOTS} effects.`, { error: true });
      return null;
    }
    return this.store.apply('Duplicate effect', (p) => S.duplicateSlot(p, i, slotId))?.id ?? null;
  }

  toggleEffect(i, slotId) {
    const s = S.slotById(this.project, i, slotId);
    if (!s) return;
    this.store.apply(s.on ? 'Bypass effect' : 'Enable effect', (p) => E.updateSlot(p, i, slotId, { on: !s.on }));
  }

  resetEffect(i, slotId) {
    this.store.apply('Reset effect', (p) => S.resetSlot(p, i, slotId));
  }

  moveEffect(i, slotId, to) {
    this.store.apply('Move effect', (p) => E.moveSlot(p, i, slotId, to));
  }

  nudgeEffect(i, slotId, dir) {
    this.store.apply('Move effect', (p) => S.nudgeSlot(p, i, slotId, dir));
  }

  clearEffects(i) {
    this.store.apply('Clear effects', (p) => S.clearEffects(p, i));
  }

  mixGesture(i, slotId) {
    return this.gesture('Effect mix', (p, v) => E.updateSlot(p, i, slotId, { mix: v }), {
      label: () => `${this.label(i)} effect mix`,
      target: { kind: 'fx', track: i, slot: slotId, param: 'mix' },
    });
  }

  paramGesture(i, slotId, def) {
    return this.gesture(def.label, (p, v) => E.setSlotParam(p, i, slotId, def.id, v), {
      label: () => {
        const s = S.slotById(this.project, i, slotId);
        return `${this.label(i)} ${EFFECTS[s?.type]?.label || 'effect'} ${def.label}`;
      },
      target: { kind: 'fx', track: i, slot: slotId, param: def.id },
    });
  }

  setParam(i, slotId, def, value) {
    this.store.apply(def.label, (p) => E.setSlotParam(p, i, slotId, def.id, value));
    const s = S.slotById(this.project, i, slotId);
    this.app.lastTweaked = { label: `${this.label(i)} ${EFFECTS[s?.type]?.label || 'effect'} ${def.label}`, target: { kind: 'fx', track: i, slot: slotId, param: def.id } };
  }

  // ---------------------------------------------------------------- menus

  /** Add > Effect on selected insert: effects by category. */
  effectMenuItems(i = this.selected, run = (type) => {
    const id = this.addEffect(i, type);
    if (id) this.app.openEffectEditor?.(i, id);
  }) {
    const items = [{ type: 'heading', label: `On ${this.label(i)}` }];
    for (const [cat, types] of effectsByCategory()) {
      items.push({ type: 'submenu', label: cat, items: types.map((t) => ({ type: 'cmd', label: EFFECTS[t].label, icon: 'fx', run: () => run(t) })) });
    }
    return items;
  }

  colorMenuItems(i) {
    const t = this.project.mixer[i];
    return [
      { type: 'radio', label: 'No color', checked: !t?.color, run: () => this.setColor(i, null) },
      ...COLORS.map((c, n) => ({ type: 'radio', label: `Color ${n + 1}`, swatch: c, checked: t?.color === c, run: () => this.setColor(i, c) })),
    ];
  }
}

