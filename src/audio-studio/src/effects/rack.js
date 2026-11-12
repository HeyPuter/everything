// Effects Rack: a chain of up to 16 realtime effect slots with master power,
// input and output gain and a wet/dry mix. This module holds the pure rack
// model, the playback-graph decoration, the destructive render, and
// createRackEditor, a reusable slot-list widget.
//
// Reusing the slot list (track effects in the Mixer or Multitrack editor):
//
//   import { createRackEditor, slotSpecs } from '../effects/rack.js';
//   const editor = createRackEditor({
//     app,
//     getSlots: () => track.fxSlots,          // array (holes allowed as null)
//     setSlots: (slots) => { track.fxSlots = slots; app.syncGraph(); },
//     label: `${track.name} effects`,
//     slotCount: 16,
//   });
//   panel.append(editor.el);
//   editor.render();                          // after external changes
//   // In the graph builder: track.fx = slotSpecs(track.fxSlots, `trk:${track.id}`);
//
// Slots are { id, effect, values, enabled }. Clicking a slot name opens the
// effect's dialog in edit mode (live changes, no Apply); the chevron menu
// chooses, replaces or removes the effect; the grip (or Alt+Up/Down) reorders.

import { h, announce } from '../lib/dom.js';
import { icon } from '../ui/icons.js';
import { EFFECTS, getEffect, slotSpec } from './registry.js';
import { normalizeValues } from './params.js';
import { isRealtime, tailFrames, latencyFrames, writeResult } from './apply.js';
import { EFFECT_GROUPS, alphabeticalGroups } from '../ui/menus.js';
import { openEffectDialog } from './dialog.js';
import { UserError } from '../lib/errors.js';
import { compensateLatency } from '../engine/mixcore.js';

export const RACK_SLOTS = 16;

let nextSlot = 1;

export function makeSlot(effectId, values, enabled = true) {
  const def = getEffect(effectId);
  return { id: `s${Date.now().toString(36)}${nextSlot++}`, effect: effectId, values: def ? normalizeValues(def, values) : { ...(values || {}) }, enabled };
}

export function createRack() {
  return { slots: Array(RACK_SLOTS).fill(null), power: true, input: 0, output: 0, mix: 1, process: 'selection' };
}

export function fitSlots(slots, count = RACK_SLOTS) {
  const out = (slots || []).slice(0, count);
  while (out.length < count) out.push(null);
  return out;
}

export function setSlot(slots, index, slot) {
  const out = slots.slice();
  out[index] = slot;
  return out;
}

export function removeSlot(slots, index) {
  return setSlot(slots, index, null);
}

export function toggleSlot(slots, index) {
  const s = slots[index];
  return s ? setSlot(slots, index, { ...s, enabled: !s.enabled }) : slots;
}

/** Moves slot `from` to position `to`; the others keep their order and the length is unchanged. */
export function moveSlot(slots, from, to) {
  if (from === to || from < 0 || to < 0 || from >= slots.length || to >= slots.length) return slots;
  const out = slots.slice();
  const [item] = out.splice(from, 1);
  out.splice(to, 0, item);
  return out;
}

/**
 * Playback options from Preferences > Effects (set by the app):
 * `processBypassed` keeps switched-off effects running silently during
 * playback (their state stays warm, so switching back on is seamless);
 * `sort` orders effect choosers by 'category' or 'name'.
 */
export const rackOptions = { processBypassed: false, sort: 'category' };

/** Filled, enabled slots whose effect is registered and realtime. */
export function playableSlots(slots) {
  return (slots || []).filter((s) => s && s.enabled !== false && getEffect(s.effect) && isRealtime(getEffect(s.effect)));
}

/**
 * Slot specs for the mix graph; `prefix` keeps keys unique per chain. With
 * rackOptions.processBypassed, switched-off slots come along as `shadow`
 * specs that the effect host processes without using their output.
 */
export function slotSpecs(slots, prefix = 'rack', doc = null, channels = 2) {
  const list = (slots || []).filter((s) => s && getEffect(s.effect) && isRealtime(getEffect(s.effect)) && (s.enabled !== false || rackOptions.processBypassed));
  return list.map((s) => {
    const def = getEffect(s.effect);
    const spec = slotSpec(def, normalizeValues(def, s.values), { key: `${prefix}:${s.id}`, doc, rate: doc?.sampleRate, channels });
    if (s.enabled === false) {
      spec.enabled = false;
      spec.shadow = true;
    }
    return spec;
  });
}

export function rackActive(rack) {
  return Boolean(rack && rack.power !== false && playableSlots(rack.slots).length);
}

const dbGain = (db) => Math.pow(10, (db || 0) / 20);

/** An amplify spec for a rack's input or output gain (dB). */
export function gainSpec(key, db) {
  const def = getEffect('amplify');
  return def ? slotSpec(def, { left: db, right: db, linked: true }, { key }) : null;
}

/** The rack's full chain: input gain then the slots. */
export function rackChain(rack, prefix = 'rack', doc = null) {
  const specs = [];
  if (rack.input) {
    const s = gainSpec(`${prefix}:in`, rack.input);
    if (s) specs.push(s);
  }
  return specs.concat(slotSpecs(rack.slots, prefix, doc));
}

/**
 * Routes an audio file's playback graph through its rack: the rack's slots
 * follow any preview effects on the file track; output gain and the wet/dry
 * mix become track gains, with a parallel dry track when mix < 1. The file
 * track is latency-compensated (compensateLatency) for the processing delay
 * of its chain (lookahead, spectral effects: the rack's switched-on slots and
 * preview slots carrying a `latency`), so what plays lines up with the
 * playhead, and the dry track for only the preview slots it shares, so the
 * blend does not comb filter.
 */
export function decorateGraph(graph, rack, doc = null) {
  const wet = graph.tracks.find((t) => t.id === 'file');
  if (!wet) return graph;
  const pre = wet.fx || [];
  const preLatency = pre.reduce((n, s) => n + (s.enabled !== false && s.latency > 0 ? s.latency : 0), 0);
  if (rackActive(rack)) {
    const out = dbGain(rack.output);
    const mix = Math.min(1, Math.max(0, rack.mix ?? 1));
    wet.fx = [...pre, ...rackChain(rack, 'rack', doc)];
    if (mix < 1) {
      const fx = pre.map((s) => ({ ...s, key: `dry:${s.key}` }));
      const gain = wet.gain * out * dbGain(rack.input) * (1 - mix);
      const dry = { ...wet, id: 'file-dry', fx, gain };
      if (preLatency) dry.latency = preLatency;
      graph.tracks.push(dry);
    }
    wet.gain *= out * mix;
    const latency = preLatency + rackTiming(rack, graph.rate || doc?.sampleRate || 48000).latency;
    if (latency) wet.latency = latency;
  } else if (preLatency) wet.latency = preLatency;
  return compensateLatency(graph);
}

/** Total tail and latency (frames) of the rack's playable slots, in series. */
export function rackTiming(rack, rate) {
  let tail = 0;
  let latency = 0;
  for (const s of playableSlots(rack.slots)) {
    const def = getEffect(s.effect);
    const v = normalizeValues(def, s.values);
    tail += tailFrames(def, v, rate);
    latency += latencyFrames(def, v, rate);
  }
  return { tail: Math.min(tail, rate * 60), latency };
}

/**
 * Renders the rack destructively over [start, end): input gain, effects,
 * wet/dry mix and output gain, with effect tails mixed after the range.
 */
export async function renderRack({ rack, state, start, end, mask = null, signal, onProgress, applyChain, doc = null }) {
  if (!rackActive(rack)) throw new UserError('The rack has no enabled effects.');
  const rate = state.sampleRate;
  const { tail, latency } = rackTiming(rack, rate);
  const wet = await applyChain(state.channels, rate, rackChain(rack, 'render', doc), { start, end, tail, latency, onProgress, signal });
  const out = dbGain(rack.output);
  const mix = Math.min(1, Math.max(0, rack.mix ?? 1));
  const inG = dbGain(rack.input);
  const n = end - start;
  const outs = wet.map((w, i) => {
    const r = new Float32Array(w.length);
    const dry = mix < 1 ? state.channels[Math.min(i, state.channels.length - 1)].toArray(start, end) : null;
    for (let k = 0; k < w.length; k++) r[k] = out * (mix * w[k] + (dry && k < n ? (1 - mix) * inG * dry[k] : 0));
    return r;
  });
  return writeResult(state, start, end, outs, mask, { tail });
}

// --------------------------------------------------------- effect lists

/** Registered effects grouped like the Effects menu: [{ label, defs }] (alphabetical groups when sorting by name). */
export function groupedEffects(filter = () => true) {
  const groups = categoryGroups(filter);
  if (rackOptions.sort !== 'name') return groups;
  const defs = groups.flatMap((g) => g.defs);
  return alphabeticalGroups(defs.map((d) => ({ id: d.id, label: d.name, def: d }))).map((g) => ({ label: g.label, defs: g.items.map((it) => it.def) }));
}

function categoryGroups(filter) {
  const used = new Set();
  const groups = [];
  for (const g of EFFECT_GROUPS) {
    const defs = g.ids.map((id) => getEffect(id)).filter((d) => d && filter(d));
    defs.forEach((d) => used.add(d.id));
    if (defs.length) groups.push({ label: g.label, defs });
  }
  const extra = new Map();
  for (const d of EFFECTS.values()) {
    if (used.has(d.id) || !filter(d)) continue;
    const label = d.group || 'Other';
    if (!extra.has(label)) extra.set(label, []);
    extra.get(label).push(d);
  }
  for (const [label, defs] of extra) {
    const g = groups.find((x) => x.label === label);
    if (g) g.defs.push(...defs);
    else groups.push({ label, defs });
  }
  return groups;
}

// ---------------------------------------------------------- rack editor

/**
 * Slot list widget. Options:
 *   app, getSlots(), setSlots(slots), label, slotCount (16),
 *   onEdit(index, slot)   default: opens the effect dialog in edit mode
 *   disabled()            greys the list (e.g. master power off)
 */
export function createRackEditor({ app, getSlots, setSlots, label = 'Effects Rack', slotCount = RACK_SLOTS, onEdit, disabled = () => false }) {
  const list = h('ol.rack-list', { 'aria-label': label });
  const el = h('div.rack-editor', list);
  const slotsNow = () => fitSlots(getSlots(), slotCount);
  let focusIndex = 0;

  const commit = (slots, message) => {
    setSlots(slots);
    render();
    if (message) announce(message);
  };

  const edit = async (i) => {
    const slot = slotsNow()[i];
    if (!slot) return chooser(i);
    if (onEdit) return onEdit(i, slot);
    const def = getEffect(slot.effect);
    if (!def) return;
    await openEffectDialog(app, def, {
      mode: 'edit',
      values: slot.values,
      title: `Effect - ${def.name} (Slot ${i + 1})`,
      slotId: slot.id,
      onChange: (values) => {
        const cur = slotsNow();
        if (cur[i]?.id !== slot.id) return;
        setSlots(setSlot(cur, i, { ...cur[i], values }));
      },
      onPower: (enabled) => {
        const cur = slotsNow();
        if (cur[i]?.id !== slot.id) return;
        setSlots(setSlot(cur, i, { ...cur[i], enabled }));
        render();
      },
      enabled: slot.enabled !== false,
    });
    render();
  };

  const choose = (i, def) => {
    const slots = slotsNow();
    const prev = slots[i];
    const slot = makeSlot(def.id, prev?.effect === def.id ? prev.values : undefined);
    commit(setSlot(slots, i, slot), `${def.name} added to slot ${i + 1}`);
    focusRow(i);
    // Preferences > Effects: open the new effect's settings right away.
    if (app?.prefs?.get('fxOpenOnAdd') && prev?.effect !== def.id) edit(i);
  };

  const chooser = (i, anchor = list.children[i]?.querySelector('.rack-name')) => {
    const slot = slotsNow()[i];
    const groups = groupedEffects(isRealtime);
    const items = groups.map((g) => ({
      type: 'sub',
      label: g.label,
      items: g.defs.map((d) => ({ type: 'cmd', label: d.name, enabled: true, checked: slot?.effect === d.id, run: () => choose(i, d) })),
    }));
    if (!items.length) items.push({ type: 'cmd', label: 'No realtime effects available', enabled: false });
    if (slot) {
      items.push({ type: 'sep' });
      items.push({ type: 'cmd', label: 'Edit Effect...', enabled: Boolean(getEffect(slot.effect)), run: () => edit(i) });
      items.push({ type: 'cmd', label: slot.enabled === false ? 'Turn On' : 'Turn Off', enabled: true, run: () => commit(toggleSlot(slotsNow(), i)) });
      items.push({ type: 'cmd', label: 'Remove Effect', enabled: true, run: () => commit(removeSlot(slotsNow(), i), `Slot ${i + 1} cleared`) });
    }
    const r = anchor?.getBoundingClientRect?.();
    app.openMenu(items, { anchor, x: r ? r.left : undefined, y: r ? r.bottom : undefined, label: `Slot ${i + 1} effect` });
  };

  const focusRow = (i) => {
    focusIndex = i;
    requestAnimationFrame(() => list.children[i]?.querySelector('.rack-name')?.focus());
  };

  const move = (from, to) => {
    if (to < 0 || to >= slotCount) return;
    commit(moveSlot(slotsNow(), from, to), `Moved to slot ${to + 1}`);
    focusRow(to);
  };

  // Pointer reordering by the grip: rows shift visually as the pointer passes them.
  const startDrag = (e, i) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const rows = [...list.children];
    const rects = rows.map((r) => r.getBoundingClientRect());
    const grip = e.currentTarget;
    grip.setPointerCapture(e.pointerId);
    rows[i].classList.add('dragging');
    let target = i;
    const onMove = (ev) => {
      const y = ev.clientY;
      target = rects.findIndex((r) => y < r.top + r.height / 2);
      if (target < 0) target = rows.length - 1;
      else if (target > i) target -= 1;
      rows.forEach((r, k) => r.classList.toggle('drop-target', k === target && k !== i));
    };
    const onUp = () => {
      grip.removeEventListener('pointermove', onMove);
      grip.removeEventListener('pointerup', onUp);
      grip.removeEventListener('pointercancel', onUp);
      rows.forEach((r) => r.classList.remove('dragging', 'drop-target'));
      if (target !== i) move(i, target);
    };
    grip.addEventListener('pointermove', onMove);
    grip.addEventListener('pointerup', onUp);
    grip.addEventListener('pointercancel', onUp);
  };

  const rowKeys = (e, i) => {
    if (e.altKey && e.key === 'ArrowUp') move(i, i - 1);
    else if (e.altKey && e.key === 'ArrowDown') move(i, i + 1);
    else if (e.key === 'ArrowUp' && !e.altKey) focusRow(Math.max(0, i - 1));
    else if (e.key === 'ArrowDown' && !e.altKey) focusRow(Math.min(slotCount - 1, i + 1));
    else if ((e.key === 'Delete' || e.key === 'Backspace') && slotsNow()[i]) commit(removeSlot(slotsNow(), i), `Slot ${i + 1} cleared`);
    else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) chooser(i);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  function render() {
    const slots = slotsNow();
    const off = disabled();
    list.classList.toggle('off', off);
    // Rows are rebuilt: a focused slot control keeps its focus (power toggles,
    // Delete, and the slot after its effect dialog closes).
    const active = document.activeElement;
    const focusRowIndex = active && list.contains(active) ? [...list.children].indexOf(active.closest('li')) : -1;
    const focusPart = active?.classList?.contains('rack-power') ? '.rack-power' : '.rack-name';
    list.replaceChildren(
      ...slots.map((slot, i) => {
        const def = slot && getEffect(slot.effect);
        const on = slot ? slot.enabled !== false : false;
        const name = slot ? def?.name || `${slot.effect} (not available)` : '';
        const power = h(
          'button.icon-btn.rack-power',
          {
            type: 'button',
            disabled: !slot,
            'aria-pressed': String(on),
            'aria-label': slot ? `${name}: ${on ? 'on' : 'off'}` : `Slot ${i + 1} power`,
            title: slot ? (on ? 'Turn effect off' : 'Turn effect on') : '',
            onclick: () => commit(toggleSlot(slotsNow(), i), `${name} ${on ? 'off' : 'on'}`),
          },
          icon('power', 13),
        );
        const nameBtn = h(
          `button.rack-name${slot ? '' : '.empty'}`,
          {
            type: 'button',
            tabindex: i === focusIndex ? '0' : '-1',
            'aria-label': slot ? `Slot ${i + 1}: ${name}. Press Enter to edit, Alt+Up or Alt+Down to move, Delete to remove.` : `Slot ${i + 1}: empty. Press Enter to choose an effect.`,
            onclick: () => (slot ? edit(i) : chooser(i)),
            onfocus: () => (focusIndex = i),
            onkeydown: (e) => rowKeys(e, i),
          },
          h('span.rack-index', String(i + 1)),
          h('span.rack-label', slot ? name : ''),
        );
        const menuBtn = h(
          'button.icon-btn.rack-menu',
          { type: 'button', tabindex: '-1', 'aria-label': `Choose effect for slot ${i + 1}`, title: 'Choose effect', onclick: (e) => chooser(i, e.currentTarget) },
          icon('chevron-down', 13),
        );
        const grip = h('span.rack-grip', { 'aria-hidden': 'true', title: 'Drag to reorder', onpointerdown: (e) => slot && startDrag(e, i) }, icon('grip-vertical', 13));
        return h(`li.rack-slot${slot ? '' : '.empty'}${slot && !on ? '.bypassed' : ''}${def ? '' : slot ? '.missing' : ''}`, power, nameBtn, menuBtn, grip);
      }),
    );
    if (focusRowIndex >= 0) {
      const row = list.children[focusRowIndex];
      const target = row?.querySelector(focusPart);
      (target && !target.disabled ? target : row?.querySelector('.rack-name'))?.focus();
    }
  }

  render();
  return { el, render, focus: () => focusRow(focusIndex), chooser, edit };
}
