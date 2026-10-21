/**
 * Shared plumbing for the details panel. A "view" wraps one selected clip:
 * controls read the live clip through it, register an updater that writes
 * the current value back into the control (on edits, undo/redo and, for
 * keyframed values, playhead moves), and write through view.edit() so a
 * slider drag is one coalesced undo step.
 */
import { h } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { US } from '../../lib/time.js';
import { findClip } from '../../model/timeline.js';
import { valueAt, keyIndexAt, baseValue } from '../../model/keyframes.js';
import { sliderField, colorField, switchField, section } from '../controls.js';

let seq = 0;
export const uidFor = (p) => `insp-${p}-${++seq}`;

/** Updater registry. time updaters also run when only the playhead moved. */
export function createScope() {
  const all = [];
  const timed = [];
  return {
    bind(fn, { time = false } = {}) {
      (time ? timed : all).push(fn);
    },
    update() {
      for (let i = 0; i < all.length; i++) all[i]();
      for (let i = 0; i < timed.length; i++) timed[i]();
    },
    tick() {
      for (let i = 0; i < timed.length; i++) timed[i]();
    },
  };
}

/**
 * View over one clip id. scope collects updaters for whatever tab is shown;
 * index.js swaps it when the tab changes.
 */
export function createClipView(ctx, id) {
  const { store, actions } = ctx;
  const view = {
    ctx,
    store,
    actions,
    id,
    scope: createScope(),
    get found() {
      return findClip(store.project, id);
    },
    get clip() {
      return findClip(store.project, id)?.clip || null;
    },
    get project() {
      return store.project;
    },
    /** Playhead in clip-local time, clamped to the clip. */
    local() {
      const c = view.clip;
      if (!c) return 0;
      return Math.min(c.duration, Math.max(0, store.time - c.start));
    },
    tol() {
      return Math.round(US / store.fps / 2);
    },
    bind(fn, opts) {
      view.scope.bind(fn, opts);
    },
    /** Drop the updaters of the panel being replaced. */
    resetScope() {
      view.scope = createScope();
    },
    /**
     * Edit the clip. key names the control so consecutive drag steps merge
     * into one undo step; final ends that run.
     */
    edit(label, fn, { key = null, final = true } = {}) {
      const ok = actions.editClip(id, label, fn, key ? { coalesce: `${key}:${id}` } : {});
      if (final) store.seal();
      return ok;
    },
    /** Keyframable value: a key at the playhead when the prop has keys, else the base value. */
    animate(prop, value, { label = 'Edit', final = true, key = prop } = {}) {
      const ok = actions.setAnimatable(id, prop, value, { label, coalesce: `${key}:${id}` });
      if (final) store.seal();
      return ok;
    },
    /** Current (possibly keyframed) value of an animatable prop at the playhead. */
    valueOf(prop) {
      const c = view.clip;
      if (!c) return 0;
      return valueAt(c.keyframes, prop, view.local(), baseValue(c, prop));
    },
    keyState(prop) {
      const c = view.clip;
      return keyState(c, prop, store.time, view.tol());
    },
    /** Jump the playhead to the previous/next key of prop. */
    jumpKey(prop, dir) {
      const c = view.clip;
      if (!c) return;
      const keys = c.keyframes?.[prop];
      if (!keys?.length) return;
      const local = store.time - c.start;
      const tol = view.tol();
      let target = null;
      if (dir < 0) {
        for (let i = keys.length - 1; i >= 0; i--) if (keys[i].t < local - tol) { target = keys[i]; break; }
      } else {
        for (let i = 0; i < keys.length; i++) if (keys[i].t > local + tol) { target = keys[i]; break; }
      }
      if (target) store.seek(c.start + target.t);
    },
  };
  return view;
}

/** 'on' (key at the playhead), 'some' (keys elsewhere) or 'none'. */
export function keyState(clip, prop, time, tol) {
  const keys = clip?.keyframes?.[prop];
  if (!keys?.length) return 'none';
  return keyIndexAt(clip.keyframes, prop, time - clip.start, tol) >= 0 ? 'on' : 'some';
}

/** Insert a unit suffix after a slider's number box (empty keeps the columns aligned). */
function addUnit(field, unit) {
  const num = field.el.querySelector('.num-input');
  num?.after(h('span.num-unit', { 'aria-hidden': 'true' }, unit));
}

/**
 * Slider bound to a clip value.
 *  get(clip) -> display value; set(value, final) writes it
 *  prop: keyframable prop name (adds the diamond and prev/next buttons)
 */
export function slider(view, { label, min, max, step = 1, unit = '', decimals, get, set, prop = null, hardMin, hardMax, time = false, className = '' }) {
  const c = view.clip;
  const field = sliderField({
    label,
    min,
    max,
    step,
    decimals,
    value: get(c),
    onInput: (v, final) => set(v, final),
    read: () => (view.clip ? get(view.clip) : undefined),
    keyframe: prop
      ? {
        onToggle: () => view.actions.toggleKeyframe(view.id, prop),
        onPrev: () => view.jumpKey(prop, -1),
        onNext: () => view.jumpKey(prop, 1),
      }
      : undefined,
  });
  addUnit(field, unit);
  if (className) field.el.classList.add(...className.split(' '));
  if (hardMin !== undefined || hardMax !== undefined) field.setLimits(hardMin ?? min, hardMax ?? max);
  // field.set() leaves a focused slider alone. A slider that merely has
  // focus (not being dragged) should still follow the playhead and undo, so
  // only an active drag or typing in the number box holds the value.
  const range = field.input;
  const num = field.el.querySelector('.num-input');
  const dec = decimals ?? (step < 1 ? Math.max(0, -Math.floor(Math.log10(step))) : 0);
  let dragging = false;
  range.addEventListener('pointerdown', () => (dragging = true));
  const release = () => (dragging = false);
  range.addEventListener('pointerup', release);
  range.addEventListener('pointercancel', release);
  range.addEventListener('change', release);
  const write = (v) => {
    field.set(v);
    if (document.activeElement !== range || dragging) return;
    range.value = String(v);
    num.value = Number(v).toFixed(dec);
    const lo = Number(range.min);
    const hi = Number(range.max);
    range.style.setProperty('--pct', `${((Number(range.value) - lo) / (hi - lo || 1)) * 100}%`);
  };
  let last = get(c);
  let lastKey = null;
  view.bind(() => {
    const clip = view.clip;
    if (!clip) return;
    const v = get(clip);
    if (v !== last) {
      last = v;
      write(v);
    }
    if (prop) {
      const k = view.keyState(prop);
      if (k !== lastKey) {
        lastKey = k;
        field.setKeyframe(k);
      }
    }
  }, { time: time || Boolean(prop) });
  if (prop) {
    lastKey = view.keyState(prop);
    field.setKeyframe(lastKey);
  }
  return field;
}

export function color(view, { label, get, set }) {
  const field = colorField({ label, value: get(view.clip), onInput: (v, final) => set(v, final) });
  let last = get(view.clip);
  view.bind(() => {
    const clip = view.clip;
    if (!clip) return;
    const v = get(clip);
    if (v !== last) {
      last = v;
      field.set(v);
    }
  });
  return field;
}

export function toggle(view, { label, get, set, hint }) {
  const field = switchField({ label, hint, checked: get(view.clip), onChange: (v) => set(v) });
  view.bind(() => {
    const clip = view.clip;
    if (clip) field.set(get(clip));
  });
  return field;
}

/** A pressed-state icon button (bold, italic, flip...). */
export function pressButton(view, { label, iconName, get, set }) {
  const b = h('button.icon-btn.press-btn', { type: 'button', 'aria-label': label, 'data-tip': label, 'aria-pressed': String(Boolean(get(view.clip))) }, icon(iconName, 16));
  b.addEventListener('click', () => set(b.getAttribute('aria-pressed') !== 'true'));
  view.bind(() => {
    const clip = view.clip;
    if (clip) b.setAttribute('aria-pressed', String(Boolean(get(clip))));
  });
  return b;
}

/** Section with an optional Reset button in its header. */
export function propSection(title, children, { onReset, actions = null, open = true } = {}) {
  let reset = null;
  if (onReset) {
    reset = h('button.icon-btn.small.section-reset', { type: 'button', 'aria-label': `Reset ${title}`, 'data-tip': 'Reset' }, icon('rotateLeft', 14));
    reset.addEventListener('click', onReset);
  }
  const acts = actions || reset ? h('div.section-actions', actions, reset) : null;
  return section(title, children, { open, actions: acts });
}

/** Label-left row for controls that are not sliders. */
export function row(label, control, { id } = {}) {
  return h('div.field.insp-row', id ? h('label.field-label', { for: id }, label) : h('span.field-label', label), h('div.insp-row-control', control));
}

/**
 * Tabs with tab panels. items: [{ id, label }]. render(id) builds the panel
 * content. Returns { list, panel, select(id), current }.
 */
export function tabSet({ label, items, value, onChange, className = '' }) {
  const base = uidFor('tabs');
  const panel = h('div.insp-tabpanel', { role: 'tabpanel', id: `${base}-panel`, tabindex: '-1' });
  const list = h(`div.insp-tabs${className ? '.' + className : ''}`, { role: 'tablist', 'aria-label': label });
  let current = items.some((i) => i.id === value) ? value : items[0]?.id;
  const btns = items.map((it) => {
    const b = h('button.insp-tab', { type: 'button', role: 'tab', id: `${base}-${it.id}`, 'aria-controls': `${base}-panel`, 'aria-selected': String(it.id === current), tabindex: it.id === current ? '0' : '-1', dataset: { tab: it.id } }, it.label);
    b.addEventListener('click', () => {
      if (current === it.id) return;
      select(it.id);
      onChange?.(it.id);
    });
    return b;
  });
  const select = (id) => {
    current = id;
    btns.forEach((b, i) => {
      const on = items[i].id === id;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    });
    const b = btns.find((x) => x.dataset.tab === id);
    if (b) panel.setAttribute('aria-labelledby', b.id);
  };
  list.addEventListener('keydown', (e) => {
    const i = btns.indexOf(document.activeElement);
    if (i < 0) return;
    let j = -1;
    if (e.key === 'ArrowRight') j = (i + 1) % btns.length;
    if (e.key === 'ArrowLeft') j = (i - 1 + btns.length) % btns.length;
    if (e.key === 'Home') j = 0;
    if (e.key === 'End') j = btns.length - 1;
    if (j >= 0) {
      e.preventDefault();
      e.stopPropagation();
      btns[j].focus();
      btns[j].click();
    }
  });
  list.append(...btns);
  select(current);
  return {
    list,
    panel,
    select,
    get current() {
      return current;
    },
  };
}

/**
 * Grid of mutually exclusive tiles (radio group with roving focus).
 * items: [{ id, label, preview?: Node }]; id null is the None tile.
 */
export function choiceGrid({ label, items, value, onPick, className = '' }) {
  const grid = h(`div.choice-grid${className ? '.' + className : ''}`, { role: 'radiogroup', 'aria-label': label, 'data-own-arrows': '' });
  const btns = items.map((it) => {
    const b = h('button.choice', { type: 'button', role: 'radio', 'aria-checked': 'false', tabindex: '-1', dataset: { id: it.id ?? '' }, title: it.label },
      h('span.choice-preview', it.preview || null),
      h('span.choice-label', it.label),
    );
    b.addEventListener('click', () => {
      set(it.id ?? null);
      onPick(it.id ?? null);
    });
    return b;
  });
  const set = (id) => {
    let any = false;
    btns.forEach((b, i) => {
      const on = (items[i].id ?? null) === (id ?? null);
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
      any ||= on;
    });
    if (!any && btns[0]) btns[0].tabIndex = 0;
  };
  grid.addEventListener('keydown', (e) => {
    if (!['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    const i = btns.indexOf(document.activeElement);
    if (i < 0) return;
    const w = btns[0].getBoundingClientRect().width;
    const cols = w ? Math.max(1, Math.round(grid.clientWidth / w)) : 4;
    let j = i;
    if (e.key === 'ArrowRight') j = i + 1;
    if (e.key === 'ArrowLeft') j = i - 1;
    if (e.key === 'ArrowDown') j = i + cols;
    if (e.key === 'ArrowUp') j = i - cols;
    if (e.key === 'Home') j = 0;
    if (e.key === 'End') j = btns.length - 1;
    e.preventDefault();
    e.stopPropagation();
    if (j >= 0 && j < btns.length) {
      btns.forEach((b) => (b.tabIndex = -1));
      btns[j].tabIndex = 0;
      btns[j].focus();
    }
  });
  grid.append(...btns);
  set(value);
  return { el: grid, set, buttons: btns };
}

/**
 * Run fn (an edit that may rebuild the control that has focus), then, if
 * focus was lost (to the page, or onto a control that is now disabled),
 * focus the first of finders() that gives a usable element. Keeps the next
 * Space from playing the timeline instead of pressing a button.
 */
export function keepFocus(fn, ...finders) {
  fn();
  const a = document.activeElement;
  if (a && a !== document.body && a.isConnected && !a.disabled) return;
  for (const find of finders) {
    const el = find();
    if (el?.isConnected && !el.disabled && !el.closest('[hidden]')) {
      el.focus();
      return;
    }
  }
}

/** Seconds with one decimal, for labels. */
export const secs = (us) => `${(us / US).toFixed(1)}s`;

export function note(text, iconName = 'info') {
  return h('p.insp-note', icon(iconName, 14), h('span', text));
}
