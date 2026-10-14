// Effect editor windows: app.openEffectEditor(track, slotId) opens (or
// raises) a floating window keyed `fx:<track>:<slotId>` with the effect's
// name, the insert it is on, an on/off switch and the mix knob in the header,
// and the effect's own editor in the body: bespoke for the EQ (response graph),
// compressor and limiter (transfer curve) and delay (synced time readout),
// grouped knobs and option switches for the rest.
//
// Below the title bar a preset strip (previous, the current preset or
// "Custom", next, save) browses the built-in and saved presets.
//
// Windows follow the store: undo, automation and edits elsewhere update the
// controls, and a window closes when its slot (or insert) is gone.

import { h } from '../../lib/dom.js';
import { icon } from '../../ui/icons.js';
import { createKnob } from '../../ui/knob.js';
import { openWindow, getWindow } from '../../ui/windows.js';
import { contextMenu } from '../../ui/menu.js';
import { EFFECTS } from '../catalog.js';
import { trackLabel } from '../../mixer/routing.js';
import { slotById } from '../../mixer/slots.js';
import { paramControl, groupParams } from './controls.js';
import { createEqEditor } from './eq-editor.js';
import { createDynamicsEditor } from './dynamics-editor.js';
import { describeDelay } from './tempo.js';
import { effectPresetController } from './presets.js';
import { createPresetBar } from '../../ui/presets.js';
import '../../styles/mixer.css';

const MIX = { id: 'mix', label: 'Mix', min: 0, max: 1, def: 1, unit: '%' };

export function installEffectEditors(app, ctl) {
  app.openEffectEditor = (track, slotId) => openEffectEditor(app, ctl, track, slotId);
}

export function openEffectEditor(app, ctl, track, slotId) {
  const key = `fx:${track}:${slotId}`;
  const open = getWindow(key);
  if (open) {
    open.raise();
    open.focus();
    return open;
  }
  const store = app.store;
  let slot = slotById(store.project, track, slotId);
  if (!slot || !EFFECTS[slot.type]) return null;
  const def = EFFECTS[slot.type];
  const ctx = { app, ctl, track, slotId, slot, bpm: store.project.bpm };

  // Header: insert chip, power, mix, options.
  const chip = h('span.fxw-insert');
  const power = h('button.fxw-power', { type: 'button' }, icon('power', 13));
  power.addEventListener('click', () => ctl.toggleEffect(track, slotId));
  const mix = createKnob({ param: MIX, value: slot.mix, size: 22, showLabel: false, label: 'Mix', ...ctl.mixGesture(track, slotId) });
  const more = h('button.icon-btn.sm', { type: 'button', 'aria-label': `${def.label} options`, title: 'Options' }, icon('ellipsis', 14));
  more.addEventListener('click', () => {
    const r = more.getBoundingClientRect();
    contextMenu(
      { clientX: r.left, clientY: r.bottom, preventDefault() {} },
      [
        { type: 'submenu', label: 'Presets', items: () => presets.menuItems() },
        { type: 'sep' },
        { type: 'cmd', label: 'Reset parameters', run: () => ctl.resetEffect(track, slotId) },
        { type: 'cmd', label: 'Duplicate', run: () => ctl.duplicateEffect(track, slotId) },
        { type: 'sep' },
        { type: 'cmd', label: 'Remove effect', run: () => ctl.removeEffect(track, slotId) },
      ],
      `${def.label} options`,
    );
  });
  const toolbar = h('div.fxw-head', chip, h('span.fxw-spacer'), power, h('span.fxw-mix', { 'aria-hidden': 'true' }, 'Mix'), mix.el, more);

  const presets = effectPresetController(app, ctl, track, slotId);
  const presetBar = createPresetBar(presets, { label: `${def.label} preset`, className: 'fxw-presets' });

  const editor = buildEditor(ctx);
  const body = h('div.fxw', { dataset: { type: slot.type } }, presetBar.el, h('p.fxw-desc', def.description), editor.el);

  let off = () => {};
  const win = openWindow({
    key,
    title: def.label,
    icon: 'fx',
    body,
    width: editor.width || 460,
    toolbar,
    onClose: () => {
      off();
      presetBar.destroy();
      editor.destroy?.();
    },
  });

  let lastTrack = null;
  let lastBpm = null;
  const sync = () => {
    const p = store.project;
    const t = p.mixer[track];
    if (t && t === lastTrack && p.bpm === lastBpm) return;
    slot = t?.fx.find((s) => s.id === slotId) || null;
    if (!slot) {
      win.close();
      return;
    }
    if (!lastTrack || t.name !== lastTrack.name || t.color !== lastTrack.color) {
      chip.textContent = trackLabel(p, track);
      chip.style.setProperty('--chip', t.color || 'var(--faint)');
      win.el.setAttribute('aria-label', `${def.label} on ${trackLabel(p, track)}`);
    }
    lastTrack = t;
    lastBpm = p.bpm;
    power.setAttribute('aria-pressed', String(slot.on));
    power.setAttribute('aria-label', slot.on ? `${def.label} is on` : `${def.label} is bypassed`);
    power.title = slot.on ? 'On. Click to bypass.' : 'Bypassed. Click to enable.';
    win.el.classList.toggle('fx-off', !slot.on);
    mix.el.setAttribute('aria-label', `${def.label} mix`);
    mix.set(slot.mix);
    if (ctx.slot !== slot || ctx.bpm !== p.bpm) {
      ctx.slot = slot;
      ctx.bpm = p.bpm;
      editor.update(slot, p);
      presetBar.sync();
    }
  };
  off = store.on('change', sync);
  sync();
  requestAnimationFrame(() => editor.mounted?.());
  editor.mounted?.();
  return win;
}

function buildEditor(ctx) {
  switch (ctx.slot.type) {
    case 'eq':
      return createEqEditor(ctx);
    case 'compressor':
    case 'limiter':
      return createDynamicsEditor(ctx);
    case 'delay':
      return createDelayEditor(ctx);
    default:
      return createGenericEditor(ctx);
  }
}

/** Knobs grouped by `group`, option lists as switches. */
export function createGenericEditor(ctx) {
  const def = EFFECTS[ctx.slot.type];
  const controls = [];
  const groups = [];
  for (const [group, defs] of groupParams(def.params)) {
    const body = h('div.fxw-grid');
    for (const d of defs) {
      const c = paramControl(ctx, d, ctx.slot.params[d.id]);
      controls.push(c);
      body.append(c.el);
    }
    groups.push(group ? h('div.fxw-group', h('h4.fxw-group-title', group), body) : body);
  }
  return {
    el: h('div.fxw-generic', ...groups),
    width: Math.min(560, 120 + def.params.length * 64),
    update(slot) {
      for (const c of controls) c.set(slot.params[c.def.id]);
    },
  };
}

/** Delay: shows only the time control that applies, plus the synced time in ms at the project tempo. */
function createDelayEditor(ctx) {
  const def = EFFECTS.delay;
  const controls = def.params.map((d) => paramControl(ctx, d, ctx.slot.params[d.id]));
  const ctl = Object.fromEntries(controls.map((c) => [c.def.id, c]));
  const timeInfo = h('p.fxw-time', { 'aria-live': 'polite' });
  const timeRow = h('div.fxw-grid', ctl.sync.el, ctl.division.el, ctl.time.el);
  const rest = h('div.fxw-grid', ...['feedback', 'pingpong', 'tone', 'wet', 'dry'].map((id) => ctl[id].el));
  const el = h('div.fxw-delay', h('div.fxw-group', h('h4.fxw-group-title', 'Time'), timeRow, timeInfo), h('div.fxw-group', h('h4.fxw-group-title', 'Echoes'), rest));
  const sync = () => {
    const p = ctx.slot.params;
    const synced = p.sync >= 0.5;
    ctl.division.el.hidden = !synced;
    ctl.time.el.hidden = synced;
    timeInfo.textContent = describeDelay(p, ctx.bpm || 120);
  };
  sync();
  return {
    el,
    width: 500,
    update(slot) {
      for (const c of controls) c.set(slot.params[c.def.id]);
      sync();
    },
  };
}
