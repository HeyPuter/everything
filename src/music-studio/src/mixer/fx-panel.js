// The mixer's side panel for the selected insert: its effect slots (on/off,
// mix, reorder by drag or Mod+Up/Down, open the editor, replace, remove, drop
// effects from the browser) and a routing summary (sends with levels,
// returns, the rack channels playing through it).
//
//   const fx = createFxPanel(ctx)
//   fx.update(project, selectedIndex)   // keyed rows: live controls survive edits

import { h } from '../lib/dom.js';
import { icon } from '../ui/icons.js';
import { createKnob } from '../ui/knob.js';
import { contextMenu, isContextKey } from '../ui/menu.js';
import { getDragData, dragHasPayload } from '../lib/dnd.js';
import { EFFECTS } from '../effects/catalog.js';
import { IS_MAC } from '../lib/util.js';
import { MAX_FX_SLOTS, dropIndex } from './slots.js';
import { formatGain, MAX_GAIN } from './db.js';
import { sendsOf, sourcesOf, channelsFeeding, canRoute, trackLabel } from './routing.js';

const MIX = { id: 'mix', label: 'Mix', min: 0, max: 1, def: 1, unit: '%' };
const SEND = { id: 'send', label: 'Level', min: 0, max: MAX_GAIN, def: 1, curve: 'pow2' };
const MOD = IS_MAC ? 'Cmd' : 'Ctrl';

export function createFxPanel(ctx) {
  const { ctl, app } = ctx;
  const title = h('h3.mx-side-title');
  const swatch = h('span.mx-side-swatch', { 'aria-hidden': 'true' });
  const count = h('span.mx-side-count');
  const menuBtn = h('button.icon-btn.sm', { type: 'button', 'aria-label': 'Insert options', title: 'Insert options' }, icon('ellipsis', 14));
  menuBtn.addEventListener('click', () => {
    const r = menuBtn.getBoundingClientRect();
    ctx.openStripMenu(state.index, { clientX: r.left, clientY: r.bottom, preventDefault() {} });
  });
  const list = h('ol.mx-slots', { 'aria-label': 'Effect slots' });
  const sendsList = h('ul.mx-route-list', { 'aria-label': 'Sends' });
  const recvList = h('ul.mx-route-list', { 'aria-label': 'Receives from' });
  const chanList = h('ul.mx-route-list', { 'aria-label': 'Channels' });
  const addSendBtn = h('button.btn.sm.ghost', { type: 'button' }, icon('plus', 12), 'Add send');
  const routeSelBtn = h('button.btn.sm.ghost', { type: 'button', title: `Route the channels selected in the rack here (${MOD}+L)` }, icon('link', 12), 'Route selected channels here');
  const recvSection = h('div.mx-route-sec', h('h4', 'Receives from'), recvList);
  const sendsSection = h('div.mx-route-sec', h('h4', 'Sends to'), sendsList, addSendBtn);
  const chanSection = h('div.mx-route-sec', h('h4', 'Channels'), chanList, routeSelBtn);
  const routing = h('section.mx-routing', { 'aria-label': 'Routing' }, h('h3.mx-sub', 'Routing'), sendsSection, recvSection, chanSection);
  const el = h(
    'aside.mx-side',
    { 'aria-label': 'Effects and routing of the selected insert' },
    h('header.mx-side-head', swatch, title, count, menuBtn),
    h('section.mx-fx', { 'aria-label': 'Effects' }, list),
    routing,
  );

  addSendBtn.addEventListener('click', () => openSendMenu());
  routeSelBtn.addEventListener('click', () => ctl.routeSelectedChannels(state.index));

  const state = { index: -1, track: null, slotKey: null, sendKey: null, recvKey: null, chanKey: null };
  const rows = new Map(); // slot id -> row api
  const sendRows = new Map(); // target index -> { el, knob }
  const empties = [];

  // ---------------------------------------------------------------- slots

  function slotRow(slot) {
    const grip = h('button.mx-grip', { type: 'button', tabindex: '-1', 'aria-hidden': 'true', title: `Drag to reorder (${MOD}+Up/Down)` }, icon('grip-vertical', 12));
    const led = h('button.led', { type: 'button' });
    const num = h('span.mx-slot-n', { 'aria-hidden': 'true' });
    const name = h('button.mx-slot-name', { type: 'button' });
    let g = null;
    const mix = createKnob({
      param: MIX,
      size: 20,
      showLabel: false,
      label: 'Mix',
      onStart: () => g.onStart(),
      onInput: (v) => g.onInput(v),
      onEnd: (v) => g.onEnd(v),
    });
    const more = h('button.icon-btn.xs', { type: 'button', title: 'Effect options' }, icon('ellipsis-vertical', 12));
    const li = h('li.mx-slot', { dataset: { id: slot.id } }, grip, num, led, name, mix.el, more);
    const api = {
      el: li,
      slot: null,
      name,
      update(s, i) {
        if (api.slot === s && api.i === i && api.track === state.index) return;
        api.slot = s;
        api.i = i;
        api.track = state.index;
        g = ctl.mixGesture(state.index, s.id);
        const label = EFFECTS[s.type]?.label || s.type;
        num.textContent = String(i + 1);
        name.textContent = label;
        name.setAttribute('aria-label', `${label}, slot ${i + 1}${s.on ? '' : ', bypassed'}. Open editor`);
        name.title = `Open the ${label} editor. ${MOD}+Up/Down to move, Delete to remove.`;
        led.setAttribute('aria-pressed', String(s.on));
        led.setAttribute('aria-label', `${label} on`);
        led.title = s.on ? 'On. Click to bypass.' : 'Bypassed. Click to enable.';
        li.classList.toggle('off', !s.on);
        mix.el.setAttribute('aria-label', `${label} mix`);
        mix.set(s.mix);
        more.setAttribute('aria-label', `${label} options`);
      },
    };
    led.addEventListener('click', () => ctl.toggleEffect(state.index, api.slot.id));
    name.addEventListener('click', () => app.openEffectEditor?.(state.index, api.slot.id));
    name.addEventListener('keydown', (e) => {
      const mod = IS_MAC ? e.metaKey : e.ctrlKey;
      if (mod && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        e.stopPropagation();
        const id = api.slot.id;
        ctl.nudgeEffect(state.index, id, e.key === 'ArrowUp' ? -1 : 1);
        rows.get(id)?.name.focus();
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        const names = [...list.querySelectorAll('.mx-slot-name, .mx-slot-add')];
        names[names.indexOf(name) + (e.key === 'ArrowUp' ? -1 : 1)]?.focus();
      } else if (isContextKey(e)) {
        e.preventDefault();
        const r = name.getBoundingClientRect();
        openSlotMenu(api.slot, { clientX: r.left, clientY: r.bottom, preventDefault() {} });
      }
    });
    more.addEventListener('click', () => {
      const r = more.getBoundingClientRect();
      openSlotMenu(api.slot, { clientX: r.left, clientY: r.bottom, preventDefault() {} });
    });
    li.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.knob')) return;
      e.preventDefault();
      openSlotMenu(api.slot, e);
    });
    grip.addEventListener('pointerdown', (e) => startReorder(e, api));
    dropTarget(li, () => api.i);
    return api;
  }

  function emptyRow(i) {
    const btn = h('button.mx-slot-add', { type: 'button' }, h('span.mx-slot-n', { 'aria-hidden': 'true' }, String(i + 1)), icon('plus', 12), h('span', 'Add effect'));
    const li = h('li.mx-slot.empty', btn);
    btn.addEventListener('click', () => openAddMenu(btn));
    btn.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      e.preventDefault();
      e.stopPropagation();
      const names = [...list.querySelectorAll('.mx-slot-name, .mx-slot-add')];
      names[names.indexOf(btn) + (e.key === 'ArrowUp' ? -1 : 1)]?.focus();
    });
    dropTarget(li, () => null);
    return { el: li, btn };
  }

  function dropTarget(li, indexOf) {
    li.addEventListener('dragover', (e) => {
      if (!dragHasPayload(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      li.classList.add('drop');
    });
    li.addEventListener('dragleave', () => li.classList.remove('drop'));
    li.addEventListener('drop', (e) => {
      li.classList.remove('drop');
      const data = getDragData(e);
      if (data?.kind !== 'effect') return;
      e.preventDefault();
      e.stopPropagation();
      const id = ctl.addEffect(state.index, data.type, indexOf() ?? undefined);
      if (id) app.notify(`Added ${EFFECTS[data.type].label} to ${ctl.label(state.index)}`);
    });
  }

  function openAddMenu(anchor) {
    const r = anchor.getBoundingClientRect();
    contextMenu({ clientX: r.left, clientY: r.bottom, preventDefault() {} }, ctl.effectMenuItems(state.index), 'Add effect');
  }

  function openSlotMenu(slot, e) {
    const i = state.index;
    const idx = state.track.fx.indexOf(slot);
    const items = [
      { type: 'cmd', label: 'Open editor', run: () => app.openEffectEditor?.(i, slot.id) },
      { type: 'check', label: 'Enabled', checked: slot.on, run: () => ctl.toggleEffect(i, slot.id) },
      { type: 'sep' },
      {
        type: 'submenu',
        label: 'Replace with',
        items: () => ctl.effectMenuItems(i, (type) => {
          const id = ctl.replaceEffect(i, slot.id, type);
          if (id) app.openEffectEditor?.(i, id);
        }).slice(1),
      },
      { type: 'cmd', label: 'Duplicate', run: () => ctl.duplicateEffect(i, slot.id), enabled: state.track.fx.length < MAX_FX_SLOTS },
      { type: 'cmd', label: 'Reset parameters', run: () => ctl.resetEffect(i, slot.id) },
      { type: 'sep' },
      { type: 'cmd', label: 'Move up', keys: `${MOD}+Up`, enabled: idx > 0, run: () => ctl.nudgeEffect(i, slot.id, -1) },
      { type: 'cmd', label: 'Move down', keys: `${MOD}+Down`, enabled: idx < state.track.fx.length - 1, run: () => ctl.nudgeEffect(i, slot.id, 1) },
      { type: 'sep' },
      { type: 'cmd', label: 'Remove', keys: 'Del', run: () => ctl.removeEffect(i, slot.id) },
    ];
    contextMenu(e, items, `${EFFECTS[slot.type]?.label || 'Effect'} options`);
  }

  // Pointer reorder by the grip (mouse, touch and pen).
  function startReorder(e, api) {
    if (e.button !== 0) return;
    e.preventDefault();
    const grip = e.currentTarget;
    grip.setPointerCapture?.(e.pointerId);
    const filled = [...rows.values()].sort((a, b) => a.i - b.i);
    const mids = filled.map((r) => {
      const b = r.el.getBoundingClientRect();
      return b.top + b.height / 2;
    });
    const from = api.i;
    let to = from;
    api.el.classList.add('dragging');
    const marker = h('div.mx-drop-line', { 'aria-hidden': 'true' });
    list.append(marker);
    const place = () => {
      const target = filled[to].el;
      const y = to > from ? target.offsetTop + target.offsetHeight : target.offsetTop;
      marker.style.top = `${y - 1}px`;
      marker.hidden = to === from;
    };
    place();
    const move = (ev) => {
      to = dropIndex(mids, ev.clientY, from);
      place();
    };
    const up = () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      grip.removeEventListener('pointercancel', up);
      api.el.classList.remove('dragging');
      marker.remove();
      if (to !== from) ctl.moveEffect(state.index, api.slot.id, to);
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
    grip.addEventListener('pointercancel', up);
  }

  // ---------------------------------------------------------------- routing

  function openSendMenu() {
    const p = ctl.project;
    const from = state.index;
    const items = [];
    p.mixer.forEach((t, i) => {
      if (i === from || p.mixer[from].routes?.[i]) return;
      const check = canRoute(p, from, i);
      items.push({ type: 'cmd', label: trackLabel(p, i), swatch: t.color || undefined, enabled: check.ok, run: () => ctl.toggleRoute(from, i) });
    });
    const r = addSendBtn.getBoundingClientRect();
    contextMenu({ clientX: r.left, clientY: r.bottom, preventDefault() {} }, items.length ? items : [{ type: 'cmd', label: 'No other inserts', enabled: false }], 'Add send');
  }

  function renderSends(p, i) {
    const sends = sendsOf(p, i);
    const key = sends.map((s) => `${s.index}:${trackLabel(p, s.index)}:${p.mixer[s.index].color}`).join('|');
    if (key !== state.sendKey) {
      state.sendKey = key;
      sendRows.clear();
      sendsList.replaceChildren(
        ...sends.map((s) => {
          const t = p.mixer[s.index];
          const g = ctl.routeGesture(i, s.index);
          const knob = createKnob({ param: SEND, size: 20, showLabel: false, label: `Send level to ${trackLabel(p, s.index)}`, format: (v) => formatGain(v), ...g });
          const label = h('button.mx-route-name', { type: 'button', title: 'Select this insert' }, h('span.mx-dot', { style: { background: t.color || 'var(--faint)' } }), trackLabel(p, s.index));
          label.addEventListener('click', () => ctx.select(s.index, { focus: true }));
          const val = h('span.mx-route-val');
          const rm = h('button.icon-btn.xs', { type: 'button', 'aria-label': `Remove send to ${trackLabel(p, s.index)}`, title: 'Remove send' }, icon('x', 12));
          rm.addEventListener('click', () => ctl.removeRoute(i, s.index));
          const li = h('li', label, val, knob.el, rm);
          sendRows.set(s.index, { knob, val });
          return li;
        }),
      );
      if (!sends.length) sendsList.append(h('li.mx-route-empty', i === 0 ? 'The master goes to the audio output.' : 'No sends: this insert is silent.'));
    }
    for (const s of sends) {
      const r = sendRows.get(s.index);
      if (!r) continue;
      r.knob.set(s.gain);
      r.val.textContent = formatGain(s.gain);
    }
    addSendBtn.hidden = i === 0;
  }

  function renderReceives(p, i) {
    const src = sourcesOf(p, i);
    const key = src.map((s) => `${s.index}:${trackLabel(p, s.index)}:${p.mixer[s.index].color}:${s.gain.toFixed(3)}`).join('|');
    if (key === state.recvKey) return;
    state.recvKey = key;
    recvList.replaceChildren(
      ...src.map((s) => {
        const b = h('button.mx-route-name', { type: 'button', title: 'Select this insert' }, h('span.mx-dot', { style: { background: p.mixer[s.index].color || 'var(--faint)' } }), trackLabel(p, s.index));
        b.addEventListener('click', () => ctx.select(s.index, { focus: true }));
        return h('li', b, h('span.mx-route-val', formatGain(s.gain)));
      }),
    );
    if (!src.length) recvList.append(h('li.mx-route-empty', 'Nothing'));
  }

  function renderChannels(p, i) {
    const chans = channelsFeeding(p, i);
    const key = chans.map((c) => `${c.id}:${c.name}:${c.color}`).join('|');
    if (key === state.chanKey) return;
    state.chanKey = key;
    chanList.replaceChildren(
      ...chans.map((c) => {
        const b = h('button.mx-route-name', { type: 'button', title: 'Select in the channel rack' }, h('span.mx-dot', { style: { background: c.color } }), c.name);
        b.addEventListener('click', () => app.store.selectChannels([c.id]));
        return h('li', b);
      }),
    );
    if (!chans.length) chanList.append(h('li.mx-route-empty', 'No rack channels'));
  }

  // ---------------------------------------------------------------- update

  function update(p, i) {
    const t = p.mixer[i];
    if (!t) return;
    const trackChanged = t !== state.track || i !== state.index;
    if (i !== state.index) {
      state.sendKey = state.recvKey = state.chanKey = null;
      for (const r of rows.values()) r.slot = null;
    }
    state.index = i;
    if (trackChanged) {
      state.track = t;
      title.textContent = trackLabel(p, i);
      swatch.style.background = t.color || 'var(--faint)';
      count.textContent = `${t.fx.length}/${MAX_FX_SLOTS}`;
      count.title = `${t.fx.length} of ${MAX_FX_SLOTS} effect slots used`;
      // Slot rows, keyed by slot id.
      const key = t.fx.map((s) => s.id).join(',');
      if (key !== state.slotKey) {
        state.slotKey = key;
        const keep = new Set(t.fx.map((s) => s.id));
        for (const [id, r] of rows) {
          if (keep.has(id)) continue;
          r.el.remove();
          rows.delete(id);
        }
        const els = [];
        t.fx.forEach((s) => {
          let r = rows.get(s.id);
          if (!r) rows.set(s.id, (r = slotRow(s)));
          els.push(r.el);
        });
        while (empties.length < MAX_FX_SLOTS) empties.push(emptyRow(empties.length));
        for (let n = t.fx.length; n < MAX_FX_SLOTS; n++) {
          const e = empties[n];
          e.btn.firstChild.textContent = String(n + 1);
          e.el.classList.toggle('first', n === t.fx.length);
          els.push(e.el);
        }
        // Reinserting a focused row blurs it: put focus back.
        const focused = list.contains(document.activeElement) ? document.activeElement : null;
        list.replaceChildren(...els);
        if (focused?.isConnected && document.activeElement !== focused) focused.focus({ preventScroll: true });
      }
      t.fx.forEach((s, n) => rows.get(s.id).update(s, n));
    }
    renderSends(p, i);
    renderReceives(p, i);
    renderChannels(p, i);
    routeSelBtn.hidden = !p.channels.length;
  }

  /** The slot id whose row holds keyboard focus, or null. */
  function focusedSlot() {
    const li = document.activeElement?.closest?.('.mx-slot');
    return li && el.contains(li) ? li.dataset.id || null : null;
  }

  return { el, update, focusedSlot, focusFirst: () => list.querySelector('.mx-slot-name, .mx-slot-add')?.focus() };
}
