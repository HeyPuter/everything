/**
 * Tiny element builder.
 *   h('button.btn.primary', { onclick, 'aria-label': 'Add' }, 'Add', icon('plus'))
 * Attributes that are DOM properties are set as properties; everything else
 * (aria-*, data-*, role) goes through setAttribute. null/undefined/false skip.
 */
export function h(spec, attrs, ...children) {
  if (attrs instanceof Node || typeof attrs === 'string' || Array.isArray(attrs)) {
    children.unshift(attrs);
    attrs = {};
  }
  const [tagAndId, ...classes] = spec.split('.');
  const [tag, id] = tagAndId.split('#');
  const node = document.createElement(tag || 'div');
  if (id) node.id = id;
  if (classes.length) node.className = classes.join(' ');
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'style' && typeof v === 'object') {
      for (const [sk, sv] of Object.entries(v)) {
        if (sk.startsWith('--')) node.style.setProperty(sk, sv);
        else node.style[sk] = sv;
      }
    } else if (k === 'class') node.className = v;
    else if (k.includes('-') || k === 'role' || k === 'for' || k === 'list' || k === 'form' || !(k in node)) {
      node.setAttribute(k, v === true ? '' : v);
    } else node[k] = v;
  }
  append(node, children);
  return node;
}

export function append(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  node.replaceChildren();
  return node;
}

export function qs(sel, root = document) {
  return root.querySelector(sel);
}

export function qsa(sel, root = document) {
  return [...root.querySelectorAll(sel)];
}

/** Escape text for HTML insertion. */
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Returns a function that runs fn at most once per wait ms, trailing call kept. */
export function debounce(fn, wait) {
  let t = null;
  const d = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => {
      t = null;
      fn(...args);
    }, wait);
  };
  d.flush = (...args) => {
    if (t !== null) {
      clearTimeout(t);
      t = null;
      fn(...args);
    }
  };
  d.cancel = () => {
    clearTimeout(t);
    t = null;
  };
  d.pending = () => t !== null;
  return d;
}

export function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Where page-level things (messages, the live region) have to go to be seen and heard: a
 * modal dialog makes the rest of the page inert and covers it, so while one is open it is
 * the dialog; in full screen it is the element shown full screen; otherwise the page.
 */
export function topLayerHost() {
  const dialogs = document.querySelectorAll('dialog[open]');
  return dialogs[dialogs.length - 1] || document.fullscreenElement || document.body;
}

/** The live region to speak through: the page's, or one inside the open modal dialog. */
function liveRegion() {
  const page = document.getElementById('live-region');
  const dialogs = document.querySelectorAll('dialog[open]');
  const modal = dialogs[dialogs.length - 1];
  if (!modal || !page) return page;
  let region = modal.querySelector(':scope > .dialog-live');
  if (!region) {
    region = document.createElement('div');
    region.className = 'sr-only dialog-live';
    region.setAttribute('aria-live', 'polite');
    region.setAttribute('aria-atomic', 'true');
    modal.append(region);
  }
  return region;
}

/** Announce a message to assistive tech through the shared live region. */
export function announce(message) {
  const region = liveRegion();
  if (!region) return;
  region.textContent = '';
  // A separate task so repeated identical messages are still spoken. The region is looked up
  // again then: a dialog that announces and closes takes its own region with it.
  setTimeout(() => {
    const now = region.isConnected ? region : liveRegion();
    if (now) now.textContent = message;
  }, 30);
}
