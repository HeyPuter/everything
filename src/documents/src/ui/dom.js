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
/** A list item holding `node`: a button in a list keeps its button role (role="listitem" on it would replace it). */
export const listItem = node => el('div', { role: 'listitem' }, node);

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

const TEXT_FIELD = 'textarea, select, [contenteditable]:not([contenteditable="false"]), input:not([type]), input[type="text"], input[type="search"], input[type="number"], input[type="email"], input[type="url"], input[type="tel"], input[type="password"]';
/**
 * Whether a key goes to a text field of the window's own (the search box, a comment, a dialog's or a
 * pane's input) rather than to the document, so document shortcuts leave it to that field.
 */
export function typingElsewhere(target) {
  return !!target?.matches?.(TEXT_FIELD) && !target.matches('.canvas-input') && !target.closest('.outline-view');
}

/**
 * Whether a keydown types a character rather than making a chord. AltGr reaches the page as Ctrl+Alt
 * on Windows (Polish AltGr+O is ó, French AltGr+0 is @, German AltGr+7 is {), and Option types
 * characters on a Mac (Option+Shift+D is Î, Option+Shift+hyphen an em dash). Those keys belong to
 * the text; a Ctrl+Alt or Option chord on the same key gives way to them.
 */
export function typesCharacter(e, mac = IS_MAC) {
  const key = String(e?.key || '');
  if (!e?.altKey || [...key].length !== 1 || !/\S/u.test(key) || /^[a-z0-9]$/i.test(key)) return false;
  return mac ? !e.metaKey && !e.ctrlKey : !!e.ctrlKey && !e.metaKey;
}

/** IME confirmation/cancellation belongs to text composition, not shortcuts. */
export function isComposing(e) {
  // Some browsers end composition before the final keydown; 229 still marks
  // that event as belonging to the input method.
  return e.isComposing || e.keyCode === 229;
}

/**
 * Make a listbox of option buttons one Tab stop: the selected option (the first when none is) takes
 * Tab, and Up, Down, Home and End move focus to another option and call `select` with it. Returns a
 * function that puts the Tab stop back on the selected option after the options change.
 */
export function listboxKeys(list, select) {
  const options = () => [...list.querySelectorAll('[role="option"]')].filter(o => !o.disabled && !o.closest('[hidden]'));
  const settle = (stop = null) => {
    const all = options();
    stop ||= all.find(o => o.getAttribute('aria-selected') === 'true') || all[0];
    for (const o of all) o.tabIndex = o === stop ? 0 : -1;
    return stop;
  };
  list.addEventListener('focusin', e => { const option = e.target.closest?.('[role="option"]'); if (option && list.contains(option)) settle(option); });
  list.addEventListener('keydown', e => {
    if (isComposing(e) || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const all = options(), at = all.indexOf(e.target.closest?.('[role="option"]'));
    const next = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: all.length - 1 }[e.key];
    if (next === undefined || at < 0) return;
    e.preventDefault();
    const option = all[Math.max(0, Math.min(all.length - 1, next))];
    if (option === all[at]) return;
    select(option); settle(option); option.focus();
  });
  settle();
  return () => settle();
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

/**
 * Give a style sample its style's color through --style-color, which the stylesheets paint as is in
 * a light theme and lighten where needed in a dark one: colors chosen for white paper (a gray subtitle,
 * a dark blue heading) are unreadable on dark panels.
 */
export function styleColor(node, color) {
  if (color) node.style.setProperty('--style-color', color);
  return node;
}
