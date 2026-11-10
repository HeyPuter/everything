/** Tiny element builder: el('button.btn.btn-primary', { onclick }, children...) */
import { t, formatDate } from '../i18n/index.js';

export function el(spec, attrs = {}, ...children) {
  const [tag, ...classes] = spec.split('.');
  const node = document.createElement(tag || 'div');
  if (classes.length) node.className = classes.join(' ');

  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined) continue;
    // `false` leaves an attribute out (`title: cond && '…'`), but a boolean property whose default is
    // on has to be switched off: `spellcheck: false` keeps the browser from marking formulas. jsdom has
    // no spellcheck property, so that one is named to reach the attribute path.
    if (v === false && typeof node[k] !== 'boolean' && k !== 'spellcheck') continue;
    if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2), v);
    } else if (k === 'html') {
      node.innerHTML = v;
    } else if (k === 'dataset') {
      Object.assign(node.dataset, v);
    } else if (k === 'style' && typeof v === 'object') {
      for (const [prop, val] of Object.entries(v)) {
        if (prop.startsWith('--')) node.style.setProperty(prop, val);
        else node.style[prop] = val;
      }
    } else if (k in node && k !== 'list' && k !== 'form') {
      node[k] = v;
    } else {
      node.setAttribute(k, v === true ? '' : v);
    }
  }

  append(node, children);
  return node;
}

/**
 * Children written as `condition && el(...)` can yield any falsy value, and
 * all of them are dropped (a bare 0 would otherwise render as text).
 */
export function append(node, children) {
  for (const child of children.flat(Infinity)) {
    if (!child) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

let uid = 0;
export function fieldId(prefix = 'f') {
  uid += 1;
  return `${prefix}-${uid}`;
}

export function clear(node) {
  node.replaceChildren();
  return node;
}

/** Clamp a number. */
export const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/** Debounce with a trailing call; `.flush()` runs a pending call now. */
export function debounce(fn, ms) {
  let timer = null;
  let pendingArgs = null;
  const wrapped = (...args) => {
    pendingArgs = args;
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; const a = pendingArgs; pendingArgs = null; fn(...a); }, ms);
  };
  wrapped.flush = () => {
    if (timer) { clearTimeout(timer); timer = null; const a = pendingArgs; pendingArgs = null; fn(...a); }
  };
  wrapped.cancel = () => { clearTimeout(timer); timer = null; pendingArgs = null; };
  return wrapped;
}

/** True on Apple platforms, where the command key replaces control. */
export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '');
export const MOD_KEY = IS_MAC ? '⌘' : 'Ctrl';

/** The platform's primary modifier for shortcuts. */
export function isMod(e) {
  if (e.getModifierState?.('AltGraph')) return false;
  return IS_MAC ? e.metaKey : e.ctrlKey;
}

const BYTE_UNITS = ['KB', 'MB', 'GB', 'TB'];
/** A size for people: whole bytes below a kilobyte, kilobytes to one decimal below ten and whole above, larger units to one decimal. */
export function formatBytes(n) {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  let value = n / 1024;
  let unit = 0;
  const decimals = () => (unit === 0 && value >= 10 ? 0 : 1);
  // The rounded figure is what is shown, and one that rounds to 1024 belongs to the next unit ("1.0 MB", not "1024 KB").
  while (unit < BYTE_UNITS.length - 1 && Number(value.toFixed(decimals())) >= 1024) { value /= 1024; unit++; }
  return `${value.toFixed(decimals())} ${BYTE_UNITS[unit]}`;
}

export function relativeTime(ts) {
  if (!ts) return '';
  const ms = typeof ts === 'number' && ts < 1e12 ? ts * 1000 : Number(ts);
  const diff = Date.now() - ms;
  // Whole units gone by, as a clock would say: 89 minutes is "1 hour ago", not two, and 23.6 hours is not yesterday.
  const min = Math.floor(diff / 60000);
  if (min < 1) return t('dom.justNow');
  if (min < 60) return t('dom.minutesAgo', { count: min });
  const h = Math.floor(min / 60);
  if (h < 24) return t('dom.hoursAgo', { count: h });
  const d = Math.floor(h / 24);
  if (d < 7) return t('dom.daysAgo', { count: d });
  return formatDate(new Date(ms), { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Composition keys belong to the IME, including Safari's confirmation key. */
export function isComposing(e) {
  return e.isComposing || e.keyCode === 229;
}
