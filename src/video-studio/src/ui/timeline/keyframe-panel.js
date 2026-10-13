/**
 * Keyframe panel: a strip under the timeline with one lane per animated
 * property of the selected clip. Each lane shows its keys (drag to move,
 * right-click for easing, Delete to remove, double-click to jump there) and
 * a curve of how the value changes, lined up with the timeline above.
 */
import { h, announce, clamp } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { US, timecode, snapToFrame } from '../../lib/time.js';
import { valueAt, baseValue, setKey, keyIndexAt } from '../../model/keyframes.js';
import * as T from '../../model/timeline.js';
import { showMenu } from '../menu.js';
import { EASE_LABELS, easeLabel } from '../organize-actions.js';
import { openEaseEditor } from '../ease-editor.js';

const NAMES = {
  x: 'Position X', y: 'Position Y', scale: 'Scale', rotation: 'Rotation', opacity: 'Opacity', volume: 'Volume',
  'style.colorR': 'Text color (red)', 'style.colorG': 'Text color (green)', 'style.colorB': 'Text color (blue)',
};

/** Readable name for a keyframe property id. */
export function propLabel(prop) {
  if (NAMES[prop]) return NAMES[prop];
  const [group, key] = prop.includes('.') ? prop.split('.') : [null, prop];
  const words = (s) => s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^\w/, (c) => c.toUpperCase());
  if (group === 'adjust') return words(key);
  if (group && /^mask\d+$/.test(group)) return `Mask ${Number(group.slice(4)) + 1} ${words(key).toLowerCase()}`;
  if (group && /^remove\d+$/.test(group)) return `Removal region ${Number(group.slice(6)) + 1} ${key === 'x' || key === 'y' ? `position ${key.toUpperCase()}` : words(key).toLowerCase()}`;
  return group ? `${words(group)} ${words(key).toLowerCase()}` : words(key);
}

/** Properties a clip can animate from this panel (beyond those already keyed). */
export function animatableProps(clip) {
  if (clip.type === 'audio') return ['volume'];
  const out = [];
  if (clip.transform) out.push('x', 'y', 'scale', 'rotation', 'opacity');
  if (clip.type === 'video') out.push('volume');
  if (clip.adjust) out.push(...Object.keys(clip.adjust).map((k) => `adjust.${k}`));
  return out;
}

// ---- Single-property key edits (pure) ----------------------------------------

export function moveKey(clip, prop, from, to, tol = 0) {
  const keys = clip.keyframes?.[prop];
  if (!keys) return false;
  const k = keys.find((x) => Math.abs(x.t - from) <= tol);
  if (!k) return false;
  const t = Math.round(clamp(to, 0, clip.duration));
  const clash = keys.findIndex((x) => x !== k && Math.abs(x.t - t) <= tol);
  if (clash >= 0) keys.splice(clash, 1);
  k.t = t;
  keys.sort((a, b) => a.t - b.t);
  return true;
}

export function setEase(clip, prop, t, easeName, tol = 0) {
  const k = clip.keyframes?.[prop]?.find((x) => Math.abs(x.t - t) <= tol);
  if (!k) return false;
  k.ease = easeName;
  return true;
}

export function deleteKey(clip, prop, t, tol = 0) {
  const keys = clip.keyframes?.[prop];
  if (!keys) return false;
  const i = keys.findIndex((x) => Math.abs(x.t - t) <= tol);
  if (i < 0) return false;
  keys.splice(i, 1);
  if (!keys.length) delete clip.keyframes[prop];
  return true;
}

/** Value range of a property's curve over the clip, padded so flat lines sit mid-lane. */
export function curveRange(clip, prop, samples = 64) {
  let lo = Infinity;
  let hi = -Infinity;
  const base = baseValue(clip, prop) ?? clip.keyframes?.[prop]?.[0]?.v ?? 0;
  for (let i = 0; i <= samples; i++) {
    const v = valueAt(clip.keyframes, prop, (clip.duration * i) / samples, base);
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!Number.isFinite(lo)) return { lo: 0, hi: 1 };
  if (hi - lo < 1e-9) return { lo: lo - 1, hi: hi + 1 };
  const pad = (hi - lo) * 0.12;
  return { lo: lo - pad, hi: hi + pad };
}

const ROW_H = 30;

export function createKeyframePanel(ctx, timeline) {
  const { store, actions } = ctx;
  let open = false;
  let extra = new Set(); // props added to the panel without keys yet
  let drag = null;
  let selKey = null; // { prop, t }
  const title = h('span.kf-panel-title', 'Keyframes');
  const addBtn = h('button.btn.small.ghost', { type: 'button', 'aria-haspopup': 'menu' }, icon('plus', 14), 'Property');
  const closeBtn = h('button.icon-btn.small', { type: 'button', 'aria-label': 'Close keyframe panel', 'data-tip': 'Close' }, icon('close', 14));
  const body = h('div.kf-panel-body', { role: 'group', 'aria-label': 'Keyframe lanes' });
  const empty = h('p.kf-panel-empty', 'Select a clip to see its keyframes.');
  const el = h('section.kf-panel', { hidden: true, 'aria-label': 'Keyframe panel' }, h('div.kf-panel-head', title, h('span.spacer'), addBtn, closeBtn), body, empty);

  closeBtn.addEventListener('click', () => setOpen(false));
  addBtn.addEventListener('click', () => {
    const c = store.selected?.clip;
    if (!c) return;
    const have = new Set([...Object.keys(c.keyframes || {}), ...extra]);
    const items = animatableProps(c).filter((p) => !have.has(p)).map((p) => ({ label: propLabel(p), onSelect: () => addKeyAtPlayhead(c.id, p) }));
    showMenu(addBtn, items.length ? items : [{ label: 'Every property already has a lane', disabled: true }], { label: 'Add property' });
  });

  const tol = () => Math.round(US / store.fps / 2);

  function addKeyAtPlayhead(clipId, prop) {
    const f = T.findClip(store.project, clipId);
    if (!f) return;
    const local = Math.round(store.time - f.clip.start);
    if (local < 0 || local > f.clip.duration) {
      toastOutside();
      return;
    }
    actions.editClip(clipId, `Add ${propLabel(prop).toLowerCase()} keyframe`, (c) => {
      c.keyframes ||= {};
      const v = valueAt(c.keyframes, prop, local, baseValue(c, prop) ?? c.keyframes[prop]?.[0]?.v ?? 0);
      setKey(c.keyframes, prop, local, v, 'linear', tol());
    });
    extra.add(prop);
  }

  function toastOutside() {
    announce('Move the playhead over the clip to add a keyframe');
  }

  function setOpen(v) {
    open = Boolean(v);
    el.hidden = !open;
    timeline.el.classList.toggle('kf-open', open);
    render();
    timeline.render?.(true);
  }

  function lanesFor(c) {
    const keyed = Object.keys(c.keyframes || {}).filter((p) => c.keyframes[p]?.length);
    const props = [...new Set([...keyed, ...[...extra].filter((p) => animatableProps(c).includes(p))])];
    const order = animatableProps(c);
    return props.sort((a, b) => (order.indexOf(a) + 1 || 999) - (order.indexOf(b) + 1 || 999));
  }

  function render() {
    if (!open) return;
    const s = store.selected;
    const c = s?.clip;
    if (!c || !c.keyframes) {
      body.replaceChildren();
      empty.hidden = false;
      empty.textContent = c ? 'This clip has nothing to animate.' : 'Select a clip to see its keyframes.';
      title.textContent = 'Keyframes';
      return;
    }
    empty.hidden = true;
    title.textContent = `Keyframes: ${T.clipLabel(store.project, c)}`;
    const g = timeline.geometry();
    const props = lanesFor(c);
    if (!props.length) {
      body.replaceChildren();
      empty.hidden = false;
      empty.textContent = 'No keyframes yet. Use + Property, or the diamond next to a setting in Details.';
      return;
    }
    const x0 = g.timeToX(c.start) - g.scrollLeft;
    const wpx = (c.duration / US) * g.pps;
    const local = store.time - c.start;
    body.replaceChildren(...props.map((prop) => {
      const keys = c.keyframes[prop] || [];
      const atKey = keyIndexAt(c.keyframes, prop, local, tol()) >= 0;
      const kfBtn = h(`button.icon-btn.small.kf-toggle${atKey ? '.on' : ''}`, { type: 'button', 'aria-pressed': String(atKey), 'aria-label': `${atKey ? 'Remove' : 'Add'} ${propLabel(prop)} keyframe at the playhead`, 'data-tip': atKey ? 'Remove keyframe' : 'Add keyframe' }, icon('keyframe', 12));
      kfBtn.addEventListener('click', () => {
        if (atKey) actions.editClip(c.id, 'Remove keyframe', (cc) => deleteKey(cc, prop, local, tol()));
        else addKeyAtPlayhead(c.id, prop);
      });
      const prev = h('button.icon-btn.small', { type: 'button', 'aria-label': `Previous ${propLabel(prop)} keyframe` }, icon('chevronLeft', 12));
      const next = h('button.icon-btn.small', { type: 'button', 'aria-label': `Next ${propLabel(prop)} keyframe` }, icon('chevronRight', 12));
      prev.addEventListener('click', () => {
        const k = [...keys].reverse().find((x) => x.t < local - tol());
        if (k) store.seek(c.start + k.t);
      });
      next.addEventListener('click', () => {
        const k = keys.find((x) => x.t > local + tol());
        if (k) store.seek(c.start + k.t);
      });
      const label = h('div.kf-label', { style: { width: `${g.headerW}px` } }, h('span.kf-name', { title: propLabel(prop) }, propLabel(prop)), h('span.kf-nav', prev, kfBtn, next));
      const cv = h('canvas.kf-curve', { 'aria-hidden': 'true' });
      const lane = h('div.kf-lane', { 'data-prop': prop },
        h('div.kf-span', { style: { left: `${x0}px`, width: `${Math.max(2, wpx)}px` } }),
        cv,
        ...keys.map((k) => {
          const sel = selKey && selKey.prop === prop && Math.abs(selKey.t - k.t) <= tol();
          return h(`button.kf-key${sel ? '.sel' : ''}`, {
            type: 'button',
            'data-t': String(k.t),
            'data-ease': k.ease || 'linear',
            'aria-label': `${propLabel(prop)} keyframe at ${timecode(c.start + k.t, store.fps)}, ${easeLabel(k.ease || 'linear')}`,
            style: { left: `${x0 + (k.t / US) * g.pps}px` },
          });
        }),
      );
      requestAnimationFrame(() => drawCurve(cv, c, prop, x0, wpx));
      return h('div.kf-row', { style: { height: `${ROW_H}px` } }, label, lane);
    }));
  }

  function drawCurve(cv, c, prop, x0, wpx) {
    const w = cv.parentElement?.clientWidth || 0;
    const hgt = ROW_H - 6;
    if (!w) return;
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(hgt * dpr);
    cv.style.width = `${w}px`;
    cv.style.height = `${hgt}px`;
    const g = cv.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const { lo, hi } = curveRange(c, prop);
    const base = baseValue(c, prop) ?? c.keyframes[prop]?.[0]?.v ?? 0;
    g.strokeStyle = getComputedStyle(el).getPropertyValue('--accent').trim() || '#4f8ff7';
    g.lineWidth = 1.5;
    g.beginPath();
    const a = Math.max(0, x0);
    const b = Math.min(w, x0 + wpx);
    for (let px = a; px <= b; px += 2) {
      const t = ((px - x0) / Math.max(1, wpx)) * c.duration;
      const v = valueAt(c.keyframes, prop, t, base);
      const y = hgt - 2 - ((v - lo) / (hi - lo)) * (hgt - 4);
      if (px === a) g.moveTo(px, y);
      else g.lineTo(px, y);
    }
    g.stroke();
  }

  // Keys: drag to move, click to select (and jump), right-click for easing.
  body.addEventListener('pointerdown', (e) => {
    const keyEl = e.target.closest('.kf-key');
    if (!keyEl || e.button !== 0) return;
    const c = store.selected?.clip;
    if (!c) return;
    e.preventDefault();
    keyEl.setPointerCapture(e.pointerId);
    const prop = keyEl.closest('.kf-lane').dataset.prop;
    const from = Number(keyEl.dataset.t);
    const g = timeline.geometry();
    const x0 = e.clientX;
    let to = from;
    let moved = false;
    selKey = { prop, t: from };
    drag = true;
    const move = (ev) => {
      if (!moved && Math.abs(ev.clientX - x0) < 3) return;
      moved = true;
      to = snapToFrame(c.start + clamp(from + ((ev.clientX - x0) / g.pps) * US, 0, c.duration), store.fps) - c.start;
      keyEl.style.left = `${g.timeToX(c.start + to) - g.scrollLeft}px`;
    };
    const up = () => {
      keyEl.removeEventListener('pointermove', move);
      keyEl.removeEventListener('pointerup', up);
      keyEl.removeEventListener('pointercancel', up);
      drag = null;
      if (moved && to !== from) {
        actions.editClip(c.id, 'Move keyframe', (cc) => moveKey(cc, prop, from, to, tol()));
        selKey = { prop, t: to };
      } else {
        store.seek(c.start + from);
        render();
      }
      keyEl.focus?.();
    };
    keyEl.addEventListener('pointermove', move);
    keyEl.addEventListener('pointerup', up);
    keyEl.addEventListener('pointercancel', up);
  });
  body.addEventListener('dblclick', (e) => {
    const lane = e.target.closest('.kf-lane');
    const c = store.selected?.clip;
    if (!lane || !c || e.target.closest('.kf-key')) return;
    // Double-clicking an empty part of a lane adds a key there.
    const g = timeline.geometry();
    const r = lane.getBoundingClientRect();
    const t = snapToFrame(clamp(((e.clientX - r.left + g.scrollLeft - g.timeToX(c.start)) / g.pps) * US + c.start, c.start, c.start + c.duration), store.fps);
    store.seek(t);
    addKeyAtPlayhead(c.id, lane.dataset.prop);
  });
  body.addEventListener('contextmenu', (e) => {
    const keyEl = e.target.closest('.kf-key');
    const c = store.selected?.clip;
    if (!keyEl || !c) return;
    e.preventDefault();
    const prop = keyEl.closest('.kf-lane').dataset.prop;
    const t = Number(keyEl.dataset.t);
    const cur = keyEl.dataset.ease;
    showMenu({ x: e.clientX, y: e.clientY }, [
      ...Object.entries(EASE_LABELS).map(([k, label]) => ({ label, icon: 'easing', radio: true, checked: cur === k, onSelect: () => actions.editClip(c.id, `Keyframe: ${label}`, (cc) => setEase(cc, prop, t, k, tol())) })),
      {
        label: 'Custom curve...',
        icon: 'easing',
        radio: true,
        checked: cur.startsWith('cubic('),
        onSelect: async () => {
          const name = await openEaseEditor(cur);
          if (name) actions.editClip(c.id, 'Keyframe: custom curve', (cc) => setEase(cc, prop, t, name, tol()));
        },
      },
      'separator',
      { label: 'Go to keyframe', onSelect: () => store.seek(c.start + t) },
      { label: 'Delete keyframe', icon: 'trash', danger: true, onSelect: () => actions.editClip(c.id, 'Delete keyframe', (cc) => deleteKey(cc, prop, t, tol())) },
    ], { label: `${propLabel(prop)} keyframe` });
  });
  body.addEventListener('keydown', (e) => {
    const keyEl = e.target.closest?.('.kf-key');
    const c = store.selected?.clip;
    if (!keyEl || !c) return;
    const prop = keyEl.closest('.kf-lane').dataset.prop;
    const t = Number(keyEl.dataset.t);
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      e.stopPropagation();
      actions.editClip(c.id, 'Delete keyframe', (cc) => deleteKey(cc, prop, t, tol()));
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      e.stopPropagation();
      const step = Math.round(US / store.fps) * (e.shiftKey ? 10 : 1) * (e.key === 'ArrowLeft' ? -1 : 1);
      actions.editClip(c.id, 'Move keyframe', (cc) => moveKey(cc, prop, t, t + step, tol()), { coalesce: `kfmove:${c.id}:${prop}` });
      selKey = { prop, t: clamp(t + step, 0, c.duration) };
    }
  });

  const offs = [
    store.on('select', () => {
      extra = new Set();
      selKey = null;
      render();
    }),
    store.on('change', () => {
      if (!drag) render();
    }),
    store.on('time', () => {
      if (open && !drag && !ctx.player?.playing) render();
    }),
  ];
  timeline.onView?.(() => {
    if (!drag) render();
  });

  return {
    el,
    get open() {
      return open;
    },
    setOpen,
    toggle: () => setOpen(!open),
    render,
    dispose() {
      offs.forEach((f) => f());
    },
  };
}
