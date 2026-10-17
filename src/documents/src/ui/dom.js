/** Tiny element builder: el('button.btn.btn-primary', { onclick }, children...) */
export function el(spec, attrs = {}, ...children) {
  const [tag, ...classes] = spec.split('.');
  const node = document.createElement(tag || 'div');
  if (classes.length) node.className = classes.join(' ');

  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined) continue;
    if (v === false) {
      // Enumerated and ARIA attributes need the literal "false"; omission
      // leaves browser defaults (e.g. spellchecking and image dragging) on.
      if (k.startsWith('aria-') || ['spellcheck', 'draggable', 'contenteditable'].includes(k)) node.setAttribute(k, 'false');
      else if (k in node && typeof node[k] === 'boolean') node[k] = false;
      continue;
    }
    if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2), v);
    } else if (k === 'html') {
      node.innerHTML = v;
    } else if (k === 'dataset') {
      Object.assign(node.dataset, v);
    } else if (k === 'style' && typeof v === 'object') {
      Object.assign(node.style, v);
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
export const MOD_KEY = IS_MAC ? 'Cmd' : 'Ctrl';

/** The platform's primary modifier for shortcuts. */
export function isMod(e) {
  return IS_MAC ? e.metaKey : e.ctrlKey;
}

/**
 * The key a shortcut chord names, as a KeyboardEvent code. A letter is the letter the layout types,
 * as everywhere else on the system: Ctrl+Z is on the key labelled Z with QWERTZ, AZERTY or Dvorak,
 * not on the key where QWERTY has it. The physical key counts when the key types another script
 * (Cyrillic, Greek) or Option changes the character; punctuation a layout types on a letter key
 * (Dvorak's ' where QWERTY has Q) names no letter. Digits and punctuation keep their physical code.
 */
export function shortcutCode(e) {
  const key = String(e?.key || ''), code = e?.code || '';
  if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`;
  if (/^Key[A-Z]$/.test(code) && !e.altKey && [...key].length === 1 && !/\p{L}/u.test(key)) return '';
  return code;
}

/** IME confirmation/cancellation belongs to text composition, not shortcuts. */
export function isComposing(e) {
  // Some browsers end composition before the final keydown; 229 still marks
  // that event as belonging to the input method.
  return e.isComposing || e.keyCode === 229;
}

export function formatBytes(n) {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function relativeTime(ts, now = Date.now()) {
  if (!ts) return '';
  const ms = typeof ts === 'number' && ts < 1e12 ? ts * 1000 : Number(ts);
  const diff = now - ms;
  const min = Math.round(diff / 60000);
  if (min < 1) return 'Just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d} day${d === 1 ? '' : 's'} ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** 'smooth' for programmatic scrolls, or 'auto' (a jump) when the user has asked for reduced motion. */
export function scrollBehavior() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
}
