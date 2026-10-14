// The Mixer panel: the master strip pinned on the left, insert strips in a
// horizontal scroller, an add-insert button, and the side panel with the
// selected insert's effects and routing. Strips update only when their
// mixer track object changes (reference diff); every meter is drawn on one
// canvas per frame from app.engine.meters.
//
// Installs: the panel, the mixer commands (scope 'mixer'), the effect
// editor windows (app.openEffectEditor) and app.effectMenuItems.

import '../styles/mixer.css';
import { h, announce } from '../lib/dom.js';
import { icon } from '../ui/icons.js';
import { contextMenu, isContextKey } from '../ui/menu.js';
import { getDragData, dragHasPayload } from '../lib/dnd.js';
import { EFFECTS } from '../effects/catalog.js';
import { IS_MAC } from '../lib/util.js';
import { MixerController } from '../mixer/controller.js';
import { registerMixerCommands } from '../mixer/commands.js';
import { createStrip } from '../mixer/strip.js';
import { createFxPanel } from '../mixer/fx-panel.js';
import { MeterState } from '../mixer/meters.js';
import { MeterView } from '../mixer/meter-view.js';
import { ticksFor } from '../mixer/db.js';
import { channelInputs, canRoute, trackLabel } from '../mixer/routing.js';
import { installEffectEditors } from '../effects/ui/editor.js';

const MOD = IS_MAC ? 'Cmd' : 'Ctrl';
const NARROW = 600; // px of panel width below which the side panel stacks under the strips
const COMPACT = 900; // below this the side panel gets narrower
const REDUCED = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };

export function install(app) {
  const ctl = new MixerController(app);
  app.mixerController = ctl;
  app.effectMenuItems = () => ctl.effectMenuItems();
  installEffectEditors(app, ctl);
  let impl = null;
  registerMixerCommands(app, ctl, () => impl);
  app.registerPanel({
    id: 'mixer',
    title: 'Mixer',
    icon: 'win-mixer',
    region: 'dock',
    create(app, host) {
      impl = createMixer(app, host, ctl);
      return impl;
    },
  });
}

export function createMixer(app, host, ctl) {
  const store = app.store;
  const body = host.body;

  // ---------------------------------------------------------------- DOM
  const masterCol = h('div.mx-pinned');
  const row = h('div.mx-row');
  const addBtn = h('button.mx-add', { type: 'button', 'aria-label': 'Add mixer insert', title: 'Add mixer insert' }, icon('plus', 16), h('span', 'Insert'));
  row.append(addBtn);
  const scroller = h('div.mx-scroller', row);
  const canvas = h('canvas.mx-meters', { 'aria-hidden': 'true' });
  const area = h('div.mx-area', masterCol, scroller, canvas);
  const ctx = {
    app,
    ctl,
    select: (i, opts = {}) => select(i, opts),
    rename: (i) => rename(i),
    resetClip: (i) => {
      meterState.resetClip(i);
      needDraw = true;
    },
    openStripMenu: (i, e) => openStripMenu(i, e),
    openInputsMenu: (i, anchor) => openInputsMenu(i, anchor),
    stripMenuItems: (i) => stripMenuItems(i),
  };
  const fx = createFxPanel(ctx);
  const root = h('div.mx', { role: 'region', 'aria-label': 'Mixer strips' }, area, fx.el);
  body.append(root);

  const fxToggle = h('button.icon-btn.sm', { type: 'button', 'aria-label': 'Effects and routing panel', title: `Effects and routing panel (${MOD}+Shift+E)` }, icon('fx', 14));
  fxToggle.addEventListener('click', () => app.commands.run('mixer.toggleEffectsPanel'));
  const addTool = h('button.icon-btn.sm', { type: 'button', 'aria-label': 'Add mixer insert', title: 'Add mixer insert' }, icon('plus', 14));
  addTool.addEventListener('click', () => app.commands.run('mixer.addInsert'));
  const toolbar = h('div.mx-tools', addTool, fxToggle);

  addBtn.addEventListener('click', () => {
    ctl.addInsert();
    requestAnimationFrame(() => {
      scroller.scrollLeft = scroller.scrollWidth;
      focusSelected();
    });
  });

  // ---------------------------------------------------------------- strips
  const strips = [];
  const meterState = new MeterState(store.project.mixer.length);
  const meterView = new MeterView(canvas);
  let rects = new Float32Array(0);
  let layoutDirty = true;
  let needDraw = true;
  let visible = false;
  let ticksKey = '';
  let ticks = [];
  const last = { mixer: null, channels: null, selected: -1, inputs: new Map(), inputKeys: new Map() };

  function ensureStrips(n) {
    while (strips.length < n) {
      const s = createStrip(ctx, strips.length);
      if (ticks.length) s.setTicks(ticks);
      stripDrop(s);
      if (s.index === 0) masterCol.append(s.el);
      else row.insertBefore(s.el, addBtn);
      strips.push(s);
      layoutDirty = true;
    }
    while (strips.length > n) {
      strips.pop().el.remove();
      layoutDirty = true;
    }
  }

  function sendState(p, sel, i) {
    if (sel === 0 || !p.mixer[sel]) return null;
    const color = p.mixer[sel].color || null;
    if (i === sel) return { mode: 'self', from: sel, color, gain: 0 };
    const g = p.mixer[sel].routes?.[i];
    if (g) return { mode: 'on', from: sel, color, gain: g };
    return { mode: canRoute(p, sel, i).ok ? 'off' : 'blocked', from: sel, color, gain: 0 };
  }

  function render() {
    const p = store.project;
    ensureStrips(p.mixer.length);
    if (p.channels !== last.channels) {
      last.channels = p.channels;
      last.inputs = channelInputs(p);
      last.inputKeys = new Map([...last.inputs].map(([k, list]) => [k, list.map((c) => c.name).join('\u0001')]));
    }
    const sel = ctl.selected;
    const sendsDirty = p.mixer !== last.mixer || sel !== last.selected;
    last.mixer = p.mixer;
    last.selected = sel;
    for (let i = 0; i < strips.length; i++) {
      const s = strips[i];
      if (sendsDirty) s.send = sendState(p, sel, i);
      s.update({ track: p.mixer[i], selected: i === sel, inputs: last.inputs.get(i) || [], inputsKey: last.inputKeys.get(i) || '', send: s.send });
    }
    fx.update(p, sel);
    root.style.setProperty('--sel-color', p.mixer[sel]?.color || 'var(--accent)');
  }

  // ---------------------------------------------------------------- selection

  function select(i, { focus = false, fromFocus = false } = {}) {
    const before = ctl.selected;
    ctl.select(i);
    if (focus) focusSelected();
    else if (!fromFocus && before !== ctl.selected) strips[ctl.selected]?.el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }

  function focusSelected() {
    const s = strips[ctl.selected];
    if (!s) return;
    s.el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    s.focus();
  }

  ctl.on('select', (i) => {
    render();
    announce(`${trackLabel(store.project, i)} selected`);
  });

  // ---------------------------------------------------------------- rename

  function rename(i) {
    const s = strips[i];
    const t = store.project.mixer[i];
    if (!s || !t || s.el.querySelector('.mx-rename')) return;
    select(i);
    const input = h('input.input.sm.mx-rename', { type: 'text', value: t.name, 'aria-label': `Rename ${trackLabel(store.project, i)}`, maxLength: 40 });
    s.nameBtn.hidden = true;
    s.nameBtn.after(input);
    input.focus();
    input.select();
    let done = false;
    const close = (apply) => {
      if (done) return;
      done = true;
      if (apply && input.value.trim() && input.value.trim() !== t.name) ctl.rename(i, input.value);
      input.remove();
      s.nameBtn.hidden = false;
      s.nameBtn.focus({ preventScroll: true });
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') close(true);
      else if (e.key === 'Escape') close(false);
    });
    input.addEventListener('blur', () => close(true));
  }

  // ---------------------------------------------------------------- menus

  function stripMenuItems(i) {
    const p = store.project;
    const t = p.mixer[i];
    if (!t) return [];
    const inputs = channelInputs(p);
    const from = [...inputs.keys()].filter((k) => k !== i && p.mixer[k]).sort((a, b) => a - b);
    const nSel = store.view.selectedChannels.size;
    return [
      { type: 'heading', label: trackLabel(p, i) },
      { type: 'cmd', label: 'Rename...', keys: 'F2', run: () => rename(i) },
      { type: 'submenu', label: 'Color', items: () => ctl.colorMenuItems(i) },
      { type: 'sep' },
      { type: 'submenu', label: 'Add effect', items: () => ctl.effectMenuItems(i).slice(1) },
      { type: 'cmd', label: 'Clear effects', enabled: t.fx.length > 0, run: () => ctl.clearEffects(i) },
      { type: 'sep' },
      { type: 'cmd', label: 'Route to master only', enabled: i > 0, run: () => ctl.routeMasterOnly(i) },
      { type: 'cmd', label: nSel > 1 ? `Route ${nSel} selected channels here` : 'Route selected channel here', keys: `${MOD}+L`, enabled: nSel > 0, run: () => ctl.routeSelectedChannels(i) },
      {
        type: 'submenu',
        label: 'Move channel inputs here from',
        enabled: from.length > 0,
        items: () => from.map((k) => ({ type: 'cmd', label: `${trackLabel(p, k)} (${inputs.get(k).map((c) => c.name).join(', ')})`, run: () => ctl.moveInputs(k, i) })),
      },
      { type: 'sep' },
      { type: 'cmd', label: 'Reset volume', run: () => ctl.resetVolume(i) },
      { type: 'cmd', label: 'Reset pan and width', run: () => ctl.resetPanWidth(i) },
      { type: 'sep' },
      { type: 'check', label: 'Mute', keys: 'M', checked: t.mute, run: () => ctl.toggleMute(i) },
      { type: 'check', label: 'Solo', keys: 'S', checked: t.solo, enabled: i > 0, run: () => ctl.solo(i) },
      { type: 'sep' },
      { type: 'cmd', label: 'Add insert', run: () => ctl.addInsert() },
    ];
  }

  function openStripMenu(i, e) {
    contextMenu(e, stripMenuItems(i), `${trackLabel(store.project, i)} options`);
  }

  function openInputsMenu(i, anchor) {
    const p = store.project;
    const list = channelInputs(p).get(i) || [];
    const r = anchor.getBoundingClientRect();
    contextMenu(
      { clientX: r.left, clientY: r.bottom, preventDefault() {} },
      [
        { type: 'heading', label: `Playing through ${trackLabel(p, i)}` },
        ...list.map((c) => ({ type: 'cmd', label: c.name, swatch: c.color, run: () => store.selectChannels([c.id]) })),
        { type: 'sep' },
        { type: 'cmd', label: 'Route selected channels here', keys: `${MOD}+L`, enabled: store.view.selectedChannels.size > 0, run: () => ctl.routeSelectedChannels(i) },
      ],
      'Inputs',
    );
  }

  // Context menu key on a strip's name button.
  area.addEventListener('keydown', (e) => {
    if (!e.target.classList?.contains('mx-name') || !isContextKey(e)) return;
    e.preventDefault();
    const i = Number(e.target.closest('.mx-strip').dataset.index);
    const r = e.target.getBoundingClientRect();
    openStripMenu(i, { clientX: r.left, clientY: r.bottom, preventDefault() {} });
  });

  // ---------------------------------------------------------------- drag and drop

  function stripDrop(s) {
    const el = s.el;
    el.addEventListener('dragover', (e) => {
      if (!dragHasPayload(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      el.classList.add('drop');
    });
    el.addEventListener('dragleave', (e) => {
      if (!el.contains(e.relatedTarget)) el.classList.remove('drop');
    });
    el.addEventListener('drop', (e) => {
      el.classList.remove('drop');
      const data = getDragData(e);
      if (!data) return;
      if (data.kind === 'effect' && EFFECTS[data.type]) {
        e.preventDefault();
        select(s.index);
        if (ctl.addEffect(s.index, data.type)) app.notify(`Added ${EFFECTS[data.type].label} to ${trackLabel(store.project, s.index)}`);
      } else if (data.kind === 'channel' && data.id) {
        e.preventDefault();
        ctl.routeChannel(data.id, s.index);
      }
    });
  }

  // ---------------------------------------------------------------- layout and meters

  function measure() {
    layoutDirty = false;
    const n = strips.length;
    if (rects.length < n * 4) rects = new Float32Array(Math.max(n, 16) * 4);
    const a = area.getBoundingClientRect();
    meterView.resize(area.clientWidth, area.clientHeight);
    const sl = scroller.scrollLeft;
    scrollBase = sl;
    for (let i = 0; i < n; i++) {
      const r = strips[i].meter.getBoundingClientRect();
      rects[i * 4] = r.left - a.left;
      rects[i * 4 + 1] = r.top - a.top;
      rects[i * 4 + 2] = r.width;
      rects[i * 4 + 3] = r.height;
    }
    const s = scroller.getBoundingClientRect();
    clipL = s.left - a.left;
    clipR = clipL + scroller.clientWidth;
    // Scale ticks for the current fader height.
    const slider = strips[1]?.fader.slider || strips[0]?.fader.slider;
    const travel = slider ? slider.clientHeight - 14 : 0;
    const next = travel > 0 ? ticksFor(travel, 11) : [];
    const key = next.map((t) => t.label).join(',');
    if (key !== ticksKey) {
      ticksKey = key;
      ticks = next;
      for (const st of strips) st.setTicks(ticks);
    }
    root.classList.toggle('mx-narrow', body.clientWidth < NARROW);
    root.classList.toggle('mx-compact', body.clientWidth < COMPACT);
    needDraw = true;
  }
  let clipL = 0;
  let clipR = 0;
  let scrollBase = 0;
  let lastScroll = 0;

  function drawMeters() {
    const n = strips.length;
    // Insert rects were measured at scrollBase; shift by the scroll since then.
    const dx = scroller.scrollLeft - scrollBase;
    if (dx) {
      for (let i = 1; i < n; i++) rects[i * 4] -= dx;
      scrollBase = scroller.scrollLeft;
    }
    meterView.draw(meterState, rects, n, 1, clipL, clipR);
    needDraw = false;
  }

  let lastT = 0;
  const offFrame = app.on('frame', () => {
    if (!visible) return;
    const now = performance.now();
    const dt = lastT ? Math.min(0.1, (now - lastT) / 1000) : 1 / 60;
    lastT = now;
    if (meterState.tracks !== strips.length) meterState.resize(strips.length);
    const meters = app.engine.meters;
    const changed = meterState.update(meters, dt, REDUCED.matches);
    if (layoutDirty) measure();
    if (scroller.scrollLeft !== lastScroll) {
      lastScroll = scroller.scrollLeft;
      needDraw = true;
    }
    if (changed || needDraw) drawMeters();
  });

  const ro = new ResizeObserver(() => {
    layoutDirty = true;
  });
  ro.observe(area);
  ro.observe(row);
  const onTheme = () => {
    meterView.themeChanged();
    needDraw = true;
  };
  window.addEventListener('themechange', onTheme);

  // ---------------------------------------------------------------- store

  const offChange = store.on('change', () => {
    render();
    if (!visible) return;
    layoutDirty = layoutDirty || strips.length !== store.project.mixer.length;
  });
  const syncPrefs = () => {
    const show = app.prefs.get('mixer')?.fx !== false;
    root.classList.toggle('mx-no-side', !show);
    fx.el.hidden = !show;
    fxToggle.setAttribute('aria-pressed', String(show));
    layoutDirty = true;
  };
  const offPrefs = app.prefs.on('change', (k) => {
    if (k === 'mixer') syncPrefs();
  });
  syncPrefs();
  render();

  return {
    toolbar,
    onShow() {
      visible = true;
      layoutDirty = true;
      lastT = 0;
    },
    onHide() {
      visible = false;
    },
    onResize() {
      layoutDirty = true;
    },
    focus: () => focusSelected(),
    focusSelected,
    rename,
    /** Draws the meters now (tests and hidden tabs where animation frames do not run). */
    drawNow() {
      measure();
      meterState.update(app.engine.meters, 1 / 60, REDUCED.matches);
      drawMeters();
    },
    strips,
    meterState,
    actions: {
      delete: () => {
        const id = fx.focusedSlot();
        if (id) ctl.removeEffect(ctl.selected, id);
      },
      duplicate: () => {
        const id = fx.focusedSlot();
        if (id) ctl.duplicateEffect(ctl.selected, id);
      },
    },
    destroy() {
      offFrame();
      offChange();
      offPrefs();
      ro.disconnect();
      window.removeEventListener('themechange', onTheme);
    },
  };
}
