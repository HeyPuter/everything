// Tiny DOM builder: h('div.panel#props', { onClick, 'aria-label': 'x' }, child, ...).
// Attributes starting with "on" become listeners; class and style accept objects.

export function h(sel, attrs, ...children) {
  if (attrs == null || typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs)) {
    if (attrs != null) children.unshift(attrs);
    attrs = {};
  }
  const m = /^([a-z0-9-]+)?((?:[.#][^.#]+)*)$/i.exec(sel);
  const tag = m?.[1] || 'div';
  const el = tag === 'svg' || tag === 'path' ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag);
  for (const part of (m?.[2] || '').match(/[.#][^.#]+/g) || []) {
    if (part[0] === '.') el.classList.add(part.slice(1));
    else el.id = part.slice(1);
  }
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') {
      if (typeof v === 'string') el.classList.add(...v.split(/\s+/).filter(Boolean));
      else for (const [c, on] of Object.entries(v)) if (on) el.classList.add(c);
    } else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'value' && 'value' in el) el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'hidden' || k === 'selected' || k === 'indeterminate') el[k] = !!v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.firstChild.remove();
  return el;
}

/** Replaces an element's children. */
export function render(el, ...children) {
  clear(el);
  return append(el, children);
}

let idCounter = 0;
export const nextId = (prefix = 'el') => `${prefix}-${++idCounter}`;

/** Announces a message to screen readers through the polite live region. */
export function announce(text) {
  const region = document.getElementById('live-region');
  if (!region) return;
  region.textContent = '';
  // A new text node after a tick makes repeated messages announce again.
  setTimeout(() => { region.textContent = text; }, 30);
}

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

const MAC_MODS = { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Mod: '⌘', Meta: '⌘' };
const MAC_ORDER = ['Ctrl', 'Alt', 'Shift', 'Mod', 'Meta'];

/**
 * Human-readable shortcut label: 'Ctrl+Shift+Z', or on macOS the system's
 * symbols in the system's order ('⇧⌘Z'). Several shortcuts are separated by
 * spaces ('Mod+Y Mod+Shift+Z') and shown as a list. Safe to pass to map().
 */
export function shortcutLabel(s, { mac = isMac } = {}) {
  if (!s) return '';
  return s.split(' ').map((chord) => {
    const m = /^((?:(?:Mod|Shift|Alt|Ctrl|Meta)\+)*)(.+)$/.exec(chord);
    const mods = m[1].split('+').filter(Boolean);
    const key = m[2].length === 1 ? m[2].toUpperCase() : m[2];
    if (mac) return MAC_ORDER.filter((k) => mods.includes(k)).map((k) => MAC_MODS[k]).join('') + key;
    return [...mods.map((k) => (k === 'Mod' ? 'Ctrl' : k)), key].join('+');
  }).join(', ');
}

/** The primary modifier's name for help text: '⌘' on macOS, 'Ctrl' elsewhere. */
export const modKey = ({ mac = isMac } = {}) => (mac ? '⌘' : 'Ctrl');

/** Trap Tab focus within a container; returns a release function. */
export function trapFocus(container) {
  const onKey = (e) => {
    if (e.key !== 'Tab') return;
    const items = [...container.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((x) => !x.disabled && x.offsetParent !== null);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  container.addEventListener('keydown', onKey);
  return () => container.removeEventListener('keydown', onKey);
}
