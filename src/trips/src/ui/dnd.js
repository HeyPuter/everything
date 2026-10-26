import { el, uid } from './dom.js';
import { t } from '../lib/i18n/index.js';

/** Pointer/touch sorting starts only on a grip; Alt+Arrow works without dragging. */
export function makeSortable(container, { itemSelector = '[data-sortable-item]', handleSelector = '[data-sortable-handle]', onMove } = {}) {
  const liveId = uid('sort-status');
  const live = el('span.sr-only', { id: liveId, role: 'status', 'aria-live': 'polite' }, t('ui.reorderHint'));
  // A list may only hold items, so its live region goes right after it (once the list is in place).
  const list = container.matches('ul, ol');
  const place = () => { if (list && !live.isConnected && container.parentNode) container.after(live); };
  if (list) queueMicrotask(place); else container.append(live);
  const oldAttrs = new Map();
  let drag;
  const items = () => [...container.querySelectorAll(itemSelector)].filter((node) => node.parentElement === container);
  const name = (node) => node.dataset.label || node.textContent.trim();
  function prepare() {
    place();
    for (const item of items()) {
      const handle = item.querySelector(handleSelector);
      if (!handle) continue;
      if (!oldAttrs.has(handle)) oldAttrs.set(handle, [handle.getAttribute('aria-label'), handle.getAttribute('aria-describedby')]);
      handle.setAttribute('aria-label', t('ui.reorder', { name: name(item) }));
      handle.setAttribute('aria-describedby', [oldAttrs.get(handle)[1], liveId].filter(Boolean).join(' '));
    }
  }
  function announce(item, from, to) {
    live.textContent = t('ui.moved', { name: name(item), position: to + 1, count: items().length });
    onMove?.({ item, from, to });
  }
  function stop(commit = false) {
    if (!drag) return;
    const state = drag; drag = null;
    let to = state.from;
    if (commit && state.started) {
      const preceding = [...container.children].slice(0, [...container.children].indexOf(state.placeholder));
      to = preceding.filter((node) => node !== state.item && node.matches(itemSelector)).length;
      container.insertBefore(state.item, state.placeholder);
    }
    state.placeholder?.remove(); state.ghost?.remove();
    state.item.classList.remove('sortable-dragging'); document.body.classList.remove('dnd-active');
    if (state.handle.hasPointerCapture?.(state.pointerId)) state.handle.releasePointerCapture(state.pointerId);
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    document.removeEventListener('pointercancel', cancel);
    document.removeEventListener('keydown', escape, true);
    state.handle.focus();
    if (commit && state.started && to !== state.from) announce(state.item, state.from, to);
  }
  function move(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (!drag.started && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 5) return;
    if (!drag.started) {
      drag.started = true;
      const box = drag.item.getBoundingClientRect();
      drag.ghost = drag.item.cloneNode(true);
      drag.ghost.classList.add('drag-ghost'); drag.ghost.setAttribute('aria-hidden', 'true'); drag.ghost.inert = true;
      drag.ghost.removeAttribute('id');
      for (const node of drag.ghost.querySelectorAll('[id]')) node.removeAttribute('id');
      Object.assign(drag.ghost.style, { width: `${box.width}px`, left: `${box.left}px`, top: `${box.top}px` });
      document.body.append(drag.ghost);
      drag.placeholder = el('div.card-placeholder', { style: { height: `${box.height}px` }, 'aria-hidden': 'true' });
      container.insertBefore(drag.placeholder, drag.item);
      drag.item.classList.add('sortable-dragging'); document.body.classList.add('dnd-active');
    }
    event.preventDefault();
    drag.ghost.style.transform = `translate(${event.clientX - drag.x}px, ${event.clientY - drag.y}px)`;
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest(itemSelector);
    if (target && target !== drag.item && target.parentElement === container) {
      const box = target.getBoundingClientRect();
      container.insertBefore(drag.placeholder, event.clientY < box.top + box.height / 2 ? target : target.nextSibling);
    }
  }
  function up(event) { if (event.pointerId === drag?.pointerId) stop(true); }
  function cancel() { stop(false); }
  function escape(event) { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); stop(false); } }
  function down(event) {
    const handle = event.target.closest(handleSelector);
    const item = handle?.closest(itemSelector);
    if (event.button !== 0 || !event.isPrimary || !item || item.parentElement !== container) return;
    stop(false);
    drag = { item, handle, pointerId: event.pointerId, x: event.clientX, y: event.clientY, from: items().indexOf(item), started: false };
    handle.setPointerCapture?.(event.pointerId);
    document.addEventListener('pointermove', move, { passive: false });
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', cancel);
    document.addEventListener('keydown', escape, true);
  }
  function keydown(event) {
    if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
    const handle = event.target.closest(handleSelector);
    const item = handle?.closest(itemSelector);
    if (!item || item.parentElement !== container) return;
    event.preventDefault();
    const current = items(); const from = current.indexOf(item); const to = from + (event.key === 'ArrowUp' ? -1 : 1);
    if (to < 0 || to >= current.length) return;
    container.insertBefore(item, to < from ? current[to] : current[to].nextSibling);
    handle.focus(); announce(item, from, to);
  }
  container.addEventListener('pointerdown', down); container.addEventListener('keydown', keydown);
  prepare();
  return { refresh: prepare, destroy() {
    stop(false); container.removeEventListener('pointerdown', down); container.removeEventListener('keydown', keydown);
    for (const [handle, attrs] of oldAttrs) {
      ['aria-label', 'aria-describedby'].forEach((key, index) => attrs[index] === null ? handle.removeAttribute(key) : handle.setAttribute(key, attrs[index]));
    }
    oldAttrs.clear(); live.remove();
  } };
}

const zones = new Set();
let active = null;

function scroller(node) {
  for (let parent = node; parent && parent !== document.body; parent = parent.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(parent).overflowY) && parent.scrollHeight > parent.clientHeight) return parent;
  }
  return null;
}

// The innermost zone under the pointer that takes this payload, so nested lists can take different payloads.
function zoneAt(node, data, item) {
  let best = null;
  for (const zone of zones) {
    if (zone.area.contains(node) && (!best || best.area.contains(zone.area)) && zone.accepts(data, item)) best = zone;
  }
  return best;
}

/**
 * Drag items into drop zones anywhere on the page, including other panes. A drag starts on a grip (`handle`), anywhere
 * on the item with a mouse when `handle` is null, or after a long press on touch when `longPress` is set.
 * `data(item)` names the payload (null refuses the drag); Alt+Arrow on a grip calls `onKey({item, data, delta})`.
 * The DOM is left alone on drop: zones get `onDrop` and callers re-render from their own state.
 */
export function makeDragSource(container, { itemSelector, handle = '[data-drag-handle]', data, longPress = false, onKey } = {}) {
  let pending = null;
  const itemOf = (target) => {
    const item = target?.closest?.(itemSelector);
    return item && container.contains(item) ? item : null;
  };
  function clearPending() {
    if (!pending) return;
    clearTimeout(pending.timer);
    document.removeEventListener('pointermove', pendingMove);
    document.removeEventListener('pointerup', clearPending);
    document.removeEventListener('pointercancel', clearPending);
    pending = null;
  }
  function pendingMove(event) {
    if (!pending || event.pointerId !== pending.pointerId) return;
    const distance = Math.hypot(event.clientX - pending.x, event.clientY - pending.y);
    if (pending.mode === 'hold') { if (distance > 8) clearPending(); return; }
    if (distance >= 5) { const start = pending; clearPending(); begin(start, event); }
  }
  function down(event) {
    if (active || pending || event.button !== 0 || !event.isPrimary) return;
    const item = itemOf(event.target);
    if (!item) return;
    const grip = handle ? event.target.closest(handle) : null;
    const touch = event.pointerType !== 'mouse';
    let mode = null;
    if (grip && item.contains(grip)) mode = 'move';
    else if (touch && longPress) mode = 'hold';
    else if (!touch && !handle && !event.target.closest('input, select, textarea, [contenteditable]')) mode = 'move';
    if (!mode) return;
    pending = { item, grip: grip ?? item, pointerId: event.pointerId, x: event.clientX, y: event.clientY, mode };
    if (mode === 'hold') pending.timer = setTimeout(() => { const start = pending; clearPending(); begin(start, { clientX: start.x, clientY: start.y }); }, 350);
    document.addEventListener('pointermove', pendingMove);
    document.addEventListener('pointerup', clearPending);
    document.addEventListener('pointercancel', clearPending);
  }
  function begin(start, event) {
    const payload = data?.(start.item);
    if (payload == null || !start.item.isConnected) return;
    const box = start.item.getBoundingClientRect();
    const ghost = start.item.cloneNode(true);
    ghost.classList.add('drag-ghost'); ghost.setAttribute('aria-hidden', 'true'); ghost.inert = true;
    ghost.removeAttribute('id');
    for (const node of ghost.querySelectorAll('[id]')) node.removeAttribute('id');
    Object.assign(ghost.style, { width: `${box.width}px`, left: `${box.left}px`, top: `${box.top}px` });
    document.body.append(ghost);
    active = {
      source: api, item: start.item, grip: start.grip, data: payload, ghost, pointerId: start.pointerId,
      x: start.x, y: start.y, lastX: event.clientX, lastY: event.clientY, height: Math.min(Math.max(box.height, 32), 96),
      placeholder: null, zone: null, frame: 0, hidden: false,
    };
    start.item.classList.add('dnd-source');
    document.body.classList.add('dnd-active');
    try { start.grip.setPointerCapture?.(start.pointerId); } catch { /* The pointer may already be gone. */ }
    document.addEventListener('pointermove', move, { passive: false });
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', cancel);
    document.addEventListener('keydown', escape, true);
    locate(event.clientX, event.clientY);
    active.frame = requestAnimationFrame(tick);
  }
  function placeholderFor(zone) {
    const state = active;
    const tag = ['UL', 'OL'].includes(zone.list.tagName) ? 'li' : 'div';
    if (state.placeholder?.tagName.toLowerCase() !== tag) {
      state.placeholder?.remove();
      state.placeholder = el(`${tag}.card-placeholder`, { 'aria-hidden': 'true', style: { height: `${state.height}px` } });
    }
    return state.placeholder;
  }
  function locate(x, y) {
    const state = active;
    const under = document.elementFromPoint(x, y);
    const zone = under ? zoneAt(under, state.data, state.item) : null;
    if (state.zone && state.zone !== zone) state.zone.area.classList.remove('dnd-over');
    state.zone = zone;
    if (!zone || !zone.placeholder) {
      // Outside a list the slot goes back where the item was, so nothing jumps under the pointer.
      if (state.hidden && state.item.parentElement) state.item.before(placeholderFor({ list: state.item.parentElement }));
      else state.placeholder?.remove();
    }
    if (!zone) return;
    if (!zone.placeholder) { zone.area.classList.add('dnd-over'); return; }
    const placeholder = placeholderFor(zone);
    if (!state.hidden && state.item.parentElement === zone.list) {
      zone.list.insertBefore(placeholder, state.item);
      state.item.classList.add('dnd-hidden'); state.hidden = true;
    }
    const target = under.closest(zone.itemSelector);
    if (target && target.parentElement === zone.list && target !== state.item) {
      const box = target.getBoundingClientRect();
      zone.list.insertBefore(placeholder, y < box.top + box.height / 2 ? target : target.nextSibling);
    } else if (placeholder.parentElement !== zone.list) zone.list.append(placeholder);
  }
  function tick() {
    const state = active;
    if (!state) return;
    const under = document.elementFromPoint(state.lastX, state.lastY);
    const target = scroller(under ?? container);
    const top = target ? target.getBoundingClientRect().top : 0;
    const bottom = target ? target.getBoundingClientRect().bottom : innerHeight;
    const edge = 48;
    const step = state.lastY < top + edge ? -Math.ceil((top + edge - state.lastY) / 4) : state.lastY > bottom - edge ? Math.ceil((state.lastY - bottom + edge) / 4) : 0;
    if (step) { (target ?? window).scrollBy(0, step); locate(state.lastX, state.lastY); }
    state.frame = requestAnimationFrame(tick);
  }
  function move(event) {
    if (!active || event.pointerId !== active.pointerId) return;
    event.preventDefault();
    active.lastX = event.clientX; active.lastY = event.clientY;
    active.ghost.style.transform = `translate(${event.clientX - active.x}px, ${event.clientY - active.y}px)`;
    locate(event.clientX, event.clientY);
  }
  function finish(commit) {
    const state = active;
    if (!state || state.source !== api) return;
    active = null;
    cancelAnimationFrame(state.frame);
    let drop = null;
    if (commit && state.zone && !state.zone.placeholder) drop = { zone: state.zone, index: -1 };
    else if (commit && state.zone && state.placeholder?.parentElement === state.zone.list) {
      const items = [...state.zone.list.children].filter((node) => node === state.placeholder || (node.matches(state.zone.itemSelector) && node !== state.item));
      drop = { zone: state.zone, index: items.indexOf(state.placeholder) };
    }
    state.zone?.area.classList.remove('dnd-over');
    state.placeholder?.remove(); state.ghost.remove();
    state.item.classList.remove('dnd-source', 'dnd-hidden');
    document.body.classList.remove('dnd-active');
    try { if (state.grip.hasPointerCapture?.(state.pointerId)) state.grip.releasePointerCapture(state.pointerId); } catch { /* Released already. */ }
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    document.removeEventListener('pointercancel', cancel);
    document.removeEventListener('keydown', escape, true);
    if (commit) {
      // The release would otherwise click whatever the item was dropped on.
      const swallow = (event) => { event.preventDefault(); event.stopPropagation(); };
      document.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => document.removeEventListener('click', swallow, { capture: true }), 0);
    }
    if (state.grip.isConnected && state.grip !== state.item) state.grip.focus({ preventScroll: true });
    if (drop) drop.zone.onDrop?.({ data: state.data, index: drop.index, item: state.item });
  }
  function up(event) { if (active && event.pointerId === active.pointerId) finish(true); }
  function cancel() { finish(false); }
  function escape(event) { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(false); } }
  function keydown(event) {
    if (!onKey || !event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
    const item = itemOf(event.target);
    if (!item || (handle && !event.target.closest(handle))) return;
    const payload = data?.(item);
    if (payload == null) return;
    event.preventDefault();
    onKey({ item, data: payload, delta: event.key === 'ArrowUp' ? -1 : 1 });
  }
  // Registered up front so a long press can stop the page from scrolling once the drag starts.
  function touchmove(event) { if (active?.source === api) event.preventDefault(); }
  function contextmenu(event) { if (pending || active?.source === api) event.preventDefault(); }
  const api = {
    destroy() {
      clearPending(); finish(false);
      container.removeEventListener('pointerdown', down);
      container.removeEventListener('keydown', keydown);
      container.removeEventListener('touchmove', touchmove);
      container.removeEventListener('contextmenu', contextmenu);
    },
  };
  container.addEventListener('pointerdown', down);
  container.addEventListener('keydown', keydown);
  container.addEventListener('touchmove', touchmove, { passive: false });
  container.addEventListener('contextmenu', contextmenu);
  return api;
}

/**
 * A list that takes drops. `area` (default `list`) is the hit area; `onDrop({data, index, item})` gets the index among
 * its items. With `placeholder: false` the area gets `.dnd-over` instead and `index` is -1 (a target such as a day chip).
 */
export function makeDropZone(list, { area = list, itemSelector = '[data-drop-item]', accepts = () => true, onDrop, placeholder = true } = {}) {
  const zone = { list, area, itemSelector, accepts, onDrop, placeholder };
  zones.add(zone);
  return {
    destroy() {
      zones.delete(zone);
      if (active?.zone === zone) { active.placeholder?.remove(); area.classList.remove('dnd-over'); active.zone = null; }
    },
  };
}
