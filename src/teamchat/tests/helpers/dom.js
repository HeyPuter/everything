/**
 * A small DOM for driving the UI modules in node: elements with attributes,
 * classes, a selector engine (tags, ids, classes, attributes, :not, :has,
 * descendant/child/sibling combinators, comma lists), events that capture
 * and bubble, focus with activeElement, a hash location whose changes fire
 * hashchange on the next tick as a browser's do, history, localStorage,
 * matchMedia driven by a configurable viewport, and the observers the UI
 * constructs. No layout: every box is zero-sized, and an element counts as
 * rendered when it is connected and not under a [hidden] ancestor.
 *
 * Where it deliberately follows the spec rather than one browser: a focused
 * control that becomes disabled loses focus to the body (the focus fixup
 * rule, as Chrome and Firefox now do), so a test that redraws after holding
 * a button sees the same lost focus a reader would. Where it cannot follow a
 * browser: nothing has a size, so code that measures (unread pills, menu
 * placement, scroll positions) runs but cannot be asserted on, and CSS is
 * not applied, so an element hidden only by a stylesheet rule (a media
 * query's display: none) still counts as rendered here.
 *
 *   const dom = installDom({ hash: '#/ws/abc@x', width: 1280 });
 *   ...
 *   dom.uninstall();
 */

/* ---- selectors -------------------------------------------------------- */

function splitTop(s, sep) {
  const out = [];
  let depth = 0;
  let quote = null;
  let cur = '';
  for (const ch of s) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '(' || ch === '[') depth++;
    if (ch === ')' || ch === ']') depth--;
    if (ch === sep && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim() || out.length === 0) out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

/** A complex selector into [{ comb, compound }], left to right. */
function parseComplex(s) {
  const parts = [];
  let i = 0;
  let comb = null;
  const str = s.trim();
  while (i < str.length) {
    // combinator
    let m = /^\s*([>+~])\s*/.exec(str.slice(i));
    if (m) { comb = m[1]; i += m[0].length; }
    else if (/^\s+/.test(str.slice(i)) && parts.length) { comb = ' '; i += /^\s+/.exec(str.slice(i))[0].length; }
    // compound
    const simple = [];
    while (i < str.length && !/[\s>+~]/.test(str[i])) {
      const rest = str.slice(i);
      if ((m = /^([a-zA-Z][\w-]*|\*)/.exec(rest))) { simple.push({ t: 'tag', v: m[1].toLowerCase() }); i += m[0].length; continue; }
      if ((m = /^#([\w-]+)/.exec(rest))) { simple.push({ t: 'id', v: m[1] }); i += m[0].length; continue; }
      if ((m = /^\.([\w-]+)/.exec(rest))) { simple.push({ t: 'class', v: m[1] }); i += m[0].length; continue; }
      if ((m = /^\[\s*([\w:-]+)\s*(?:([~|^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]*)))?\s*\]/.exec(rest))) {
        simple.push({ t: 'attr', name: m[1], op: m[2] || null, v: m[3] ?? m[4] ?? m[5] ?? null });
        i += m[0].length;
        continue;
      }
      if ((m = /^::?([\w-]+)/.exec(rest))) {
        i += m[0].length;
        let arg = null;
        if (str[i] === '(') {
          let depth = 0;
          let j = i;
          for (; j < str.length; j++) {
            if (str[j] === '(') depth++;
            if (str[j] === ')') { depth--; if (depth === 0) break; }
          }
          arg = str.slice(i + 1, j);
          i = j + 1;
        }
        simple.push({ t: 'pseudo', name: m[1], arg: arg != null ? parseList(arg) : null });
        continue;
      }
      throw new SyntaxError(`Unsupported selector: ${s}`);
    }
    if (simple.length) { parts.push({ comb, compound: simple }); comb = null; }
    else if (i < str.length && !/[\s>+~]/.test(str[i])) throw new SyntaxError(`Unsupported selector: ${s}`);
    else if (i >= str.length) break;
  }
  return parts;
}

const parseCache = new Map();
function parseList(s) {
  if (!parseCache.has(s)) parseCache.set(s, splitTop(s, ',').map(parseComplex));
  return parseCache.get(s);
}

function matchesSimple(el, sel) {
  switch (sel.t) {
    case 'tag': return sel.v === '*' || el.localName === sel.v;
    case 'id': return el.getAttribute('id') === sel.v;
    case 'class': return el.classList.contains(sel.v);
    case 'attr': {
      const v = el.getAttribute(sel.name);
      if (v === null) return false;
      if (!sel.op) return true;
      if (sel.op === '=') return v === sel.v;
      if (sel.op === '^=') return v.startsWith(sel.v);
      if (sel.op === '$=') return v.endsWith(sel.v);
      if (sel.op === '*=') return v.includes(sel.v);
      if (sel.op === '~=') return v.split(/\s+/).includes(sel.v);
      if (sel.op === '|=') return v === sel.v || v.startsWith(`${sel.v}-`);
      return false;
    }
    case 'pseudo': {
      const doc = el.ownerDocument;
      switch (sel.name) {
        case 'not': return !sel.arg.some((c) => matchesComplex(el, c));
        case 'is': case 'where': case 'matches': return sel.arg.some((c) => matchesComplex(el, c));
        case 'has': return descendants(el).some((d) => sel.arg.some((c) => matchesComplex(d, c)));
        case 'first-child': return el.parentNode?.children?.[0] === el;
        case 'last-child': { const k = el.parentNode?.children || []; return k[k.length - 1] === el; }
        case 'only-child': return el.parentNode?.children?.length === 1;
        case 'empty': return el.childNodes.length === 0;
        case 'focus': return doc.activeElement === el && el !== doc.body;
        case 'focus-within': return doc.activeElement !== doc.body && el.contains(doc.activeElement);
        case 'focus-visible': return doc.activeElement === el && el !== doc.body;
        case 'checked': return el.checked === true;
        case 'disabled': return el.hasAttribute('disabled');
        case 'enabled': return !el.hasAttribute('disabled');
        case 'hover': case 'active': case 'visited': case 'link': return false;
        case 'scope': case 'root': return el === doc.documentElement;
        default: return false;
      }
    }
    default: return false;
  }
}

function matchesCompound(el, compound) {
  return compound.every((s) => matchesSimple(el, s));
}

function matchesComplex(el, parts) {
  // Right to left.
  const walk = (node, idx) => {
    if (!node || node.nodeType !== 1) return false;
    if (!matchesCompound(node, parts[idx].compound)) return false;
    if (idx === 0) return true;
    const comb = parts[idx].comb || ' ';
    if (comb === '>') return walk(node.parentNode, idx - 1);
    if (comb === '+') return walk(node.previousElementSibling, idx - 1);
    if (comb === '~') {
      for (let s = node.previousElementSibling; s; s = s.previousElementSibling) if (walk(s, idx - 1)) return true;
      return false;
    }
    for (let a = node.parentNode; a && a.nodeType === 1; a = a.parentNode) if (walk(a, idx - 1)) return true;
    return false;
  };
  return walk(el, parts.length - 1);
}

function descendants(node) {
  const out = [];
  const visit = (n) => { for (const c of n.childNodes) { if (c.nodeType === 1) { out.push(c); visit(c); } } };
  visit(node);
  return out;
}

/* ---- events ----------------------------------------------------------- */

const define = (o, k, v) => Object.defineProperty(o, k, { value: v, configurable: true, writable: true });

export class DomEventTarget {
  constructor() { this._listeners = new Map(); }
  addEventListener(type, fn, opts) {
    if (!fn) return;
    const capture = typeof opts === 'boolean' ? opts : !!opts?.capture;
    const once = !!opts?.once;
    const list = this._listeners.get(type) || [];
    if (list.some((l) => l.fn === fn && l.capture === capture)) return;
    list.push({ fn, capture, once });
    this._listeners.set(type, list);
  }
  removeEventListener(type, fn, opts) {
    const capture = typeof opts === 'boolean' ? opts : !!opts?.capture;
    const list = this._listeners.get(type);
    if (!list) return;
    this._listeners.set(type, list.filter((l) => !(l.fn === fn && l.capture === capture)));
  }
  _invoke(ev, phase, state) {
    const list = [...(this._listeners.get(ev.type) || [])];
    for (const l of list) {
      if (state.immediate) return;
      if (phase === 'capture' && !l.capture) continue;
      if (phase === 'bubble' && l.capture) continue;
      if (l.once) this.removeEventListener(ev.type, l.fn, l.capture);
      define(ev, 'currentTarget', this);
      if (typeof l.fn === 'function') l.fn.call(this, ev); else l.fn.handleEvent?.(ev);
    }
    const on = this[`on${ev.type}`];
    if (typeof on === 'function' && phase !== 'capture' && !state.immediate) on.call(this, ev);
  }
  dispatchEvent(ev) {
    define(ev, 'target', this);
    const state = { stopped: false, immediate: false };
    const sp = ev.stopPropagation.bind(ev);
    const sip = ev.stopImmediatePropagation.bind(ev);
    define(ev, 'stopPropagation', () => { state.stopped = true; sp(); });
    define(ev, 'stopImmediatePropagation', () => { state.stopped = true; state.immediate = true; sip(); });
    const path = [];
    for (let n = this; n; n = n._eventParent()) path.push(n);
    define(ev, 'composedPath', () => [...path]);
    // Capture: from the outermost down to the target's parent.
    for (let i = path.length - 1; i > 0 && !state.stopped; i--) path[i]._invoke(ev, 'capture', state);
    if (!state.stopped) path[0]._invoke(ev, 'target', state);
    if (ev.bubbles) for (let i = 1; i < path.length && !state.stopped; i++) path[i]._invoke(ev, 'bubble', state);
    define(ev, 'currentTarget', null);
    return !ev.defaultPrevented;
  }
  _eventParent() { return null; }
}

const EVENT_FIELDS = ['key', 'code', 'keyCode', 'which', 'charCode', 'shiftKey', 'metaKey', 'ctrlKey', 'altKey', 'isComposing', 'repeat',
  'clientX', 'clientY', 'screenX', 'screenY', 'pageX', 'pageY', 'button', 'buttons', 'pointerId', 'pointerType', 'relatedTarget',
  'data', 'inputType', 'dataTransfer', 'clipboardData', 'oldURL', 'newURL', 'key', 'newValue', 'oldValue', 'storageArea', 'url', 'deltaY', 'deltaX', 'touches', 'changedTouches', 'width', 'height', 'pressure', 'isPrimary'];

function uiEvent(name) {
  return class extends Event {
    constructor(type, init = {}) {
      super(type, init);
      for (const k of EVENT_FIELDS) if (k in init) this[k] = init[k];
    }
    get [Symbol.toStringTag]() { return name; }
  };
}

export const KeyboardEvent = uiEvent('KeyboardEvent');
export const MouseEvent = uiEvent('MouseEvent');
export const PointerEvent = uiEvent('PointerEvent');
export const FocusEvent = uiEvent('FocusEvent');
export const InputEvent = uiEvent('InputEvent');
export const HashChangeEvent = uiEvent('HashChangeEvent');
export const DragEvent = uiEvent('DragEvent');
export const ClipboardEvent = uiEvent('ClipboardEvent');
export const StorageEvent = uiEvent('StorageEvent');
export const WheelEvent = uiEvent('WheelEvent');
export const TouchEvent = uiEvent('TouchEvent');
export const UIEvent = uiEvent('UIEvent');

/* ---- nodes ------------------------------------------------------------ */

const ATTR_PROPS = ['title', 'href', 'src', 'alt', 'placeholder', 'name', 'lang', 'dir', 'loading', 'target', 'rel', 'download', 'for', 'maxlength', 'accept', 'enterkeyhint', 'inputmode', 'autocomplete', 'role', 'datetime', 'pattern', 'min', 'max', 'step', 'rows', 'cols', 'wrap'];
const BOOL_PROPS = ['hidden', 'disabled', 'required', 'readOnly', 'multiple', 'selected', 'open', 'inert', 'autofocus'];
const VOID = new Set(['img', 'input', 'br', 'hr', 'meta', 'link', 'path', 'circle', 'line', 'polyline', 'rect', 'polygon', 'ellipse', 'use']);
const escape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export class DomNode extends DomEventTarget {
  constructor(doc) {
    super();
    this.ownerDocument = doc;
    this.parentNode = null;
    this.childNodes = [];
  }
  _eventParent() { return this.parentNode || (this.nodeType === 9 ? this.defaultView : null); }
  get isConnected() {
    for (let n = this; n; n = n.parentNode) if (n.nodeType === 9) return true;
    return false;
  }
  get parentElement() { return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null; }
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
  get nextSibling() { const k = this.parentNode?.childNodes; return k ? k[k.indexOf(this) + 1] || null : null; }
  get previousSibling() { const k = this.parentNode?.childNodes; return k ? k[k.indexOf(this) - 1] || null : null; }
  get children() { return this.childNodes.filter((c) => c.nodeType === 1); }
  get childElementCount() { return this.children.length; }
  get firstElementChild() { return this.children[0] || null; }
  get lastElementChild() { const c = this.children; return c[c.length - 1] || null; }
  get nextElementSibling() { for (let s = this.nextSibling; s; s = s.nextSibling) if (s.nodeType === 1) return s; return null; }
  get previousElementSibling() { for (let s = this.previousSibling; s; s = s.previousSibling) if (s.nodeType === 1) return s; return null; }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(v) { this.replaceChildren(v == null ? '' : String(v)); }
  get nodeValue() { return null; }
  hasChildNodes() { return this.childNodes.length > 0; }
  contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
  _toNode(x) { return x instanceof DomNode ? x : this.ownerDocument.createTextNode(String(x)); }
  _insert(nodes, before) {
    for (const raw of nodes) {
      const n = this._toNode(raw);
      if (n.nodeType === 11) { this._insert([...n.childNodes], before); continue; }
      if (n === this) throw new Error('A node cannot be inserted into itself');
      if (n.parentNode) n.parentNode.removeChild(n);
      n.parentNode = this;
      const i = before ? this.childNodes.indexOf(before) : -1;
      if (i >= 0) this.childNodes.splice(i, 0, n); else this.childNodes.push(n);
    }
  }
  appendChild(n) { this._insert([n], null); return n; }
  append(...nodes) { this._insert(nodes, null); }
  prepend(...nodes) { this._insert(nodes, this.firstChild); }
  insertBefore(n, ref) { this._insert([n], ref); return n; }
  removeChild(n) {
    const i = this.childNodes.indexOf(n);
    if (i < 0) throw new Error('Not a child');
    this.childNodes.splice(i, 1);
    n.parentNode = null;
    const doc = this.ownerDocument;
    if (doc && doc._active && n.contains(doc._active)) doc._active = null;
    return n;
  }
  replaceChildren(...nodes) {
    for (const c of [...this.childNodes]) this.removeChild(c);
    this._insert(nodes, null);
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  replaceWith(...nodes) { const p = this.parentNode; if (!p) return; const next = this.nextSibling; p.removeChild(this); p._insert(nodes, next); }
  before(...nodes) { this.parentNode?._insert(nodes, this); }
  after(...nodes) { this.parentNode?._insert(nodes, this.nextSibling); }
  cloneNode(deep = false) {
    const c = this.nodeType === 3 ? this.ownerDocument.createTextNode(this.data) : this.ownerDocument.createElementNS(this.namespaceURI, this.localName);
    if (this.nodeType === 1) for (const [k, v] of this._attrs) c._attrs.set(k, v);
    if (deep) for (const k of this.childNodes) c.appendChild(k.cloneNode(true));
    return c;
  }
  querySelectorAll(sel) { const list = parseList(sel); return descendants(this).filter((d) => list.some((c) => matchesComplex(d, c))); }
  querySelector(sel) { const list = parseList(sel); return descendants(this).find((d) => list.some((c) => matchesComplex(d, c))) || null; }
  getElementById(id) { return this.querySelector(`#${id}`); }
  getRootNode() { let n = this; while (n.parentNode) n = n.parentNode; return n; }
}

export class DomText extends DomNode {
  constructor(doc, data) { super(doc); this.nodeType = 3; this.nodeName = '#text'; this.data = String(data); }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v); }
  get nodeValue() { return this.data; }
  set nodeValue(v) { this.data = String(v); }
  get outerHTML() { return escape(this.data); }
}

export class DomFragment extends DomNode {
  constructor(doc) { super(doc); this.nodeType = 11; this.nodeName = '#document-fragment'; }
}

export class DomElement extends DomNode {
  constructor(doc, tag, ns = 'http://www.w3.org/1999/xhtml') {
    super(doc);
    this.nodeType = 1;
    this.namespaceURI = ns;
    this.localName = ns === 'http://www.w3.org/1999/xhtml' ? String(tag).toLowerCase() : String(tag);
    this.tagName = ns === 'http://www.w3.org/1999/xhtml' ? this.localName.toUpperCase() : this.localName;
    this.nodeName = this.tagName;
    this._attrs = new Map();
    this._html = '';
    this._value = null;
    this._checked = false;
    this.scrollTop = 0;
    this.scrollLeft = 0;
    this._style = {};
    const style = this._style;
    this.style = new Proxy(style, {
      get: (t, k) => {
        if (k === 'setProperty') return (n, v) => { t[n] = String(v); };
        if (k === 'removeProperty') return (n) => { const v = t[n]; delete t[n]; return v ?? ''; };
        if (k === 'getPropertyValue') return (n) => t[n] ?? '';
        if (k === 'cssText') return Object.entries(t).map(([a, b]) => `${a}: ${b}`).join('; ');
        return t[k] ?? '';
      },
      set: (t, k, v) => { t[k] = String(v); return true; },
    });
    this.dataset = new Proxy({}, {
      get: (_, k) => (typeof k === 'string' ? this.getAttribute(`data-${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`) ?? undefined : undefined),
      set: (_, k, v) => { this.setAttribute(`data-${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`, v); return true; },
      has: (_, k) => this.hasAttribute(`data-${String(k).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`),
      deleteProperty: (_, k) => { this.removeAttribute(`data-${String(k).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`); return true; },
      ownKeys: () => [...this._attrs.keys()].filter((k) => k.startsWith('data-')).map((k) => k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())),
      getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
    });
    const self = this;
    this.classList = {
      get length() { return self._classes().length; },
      contains: (c) => self._classes().includes(c),
      add: (...cs) => { const set = new Set(self._classes()); for (const c of cs) set.add(c); self._setClasses([...set]); },
      remove: (...cs) => self._setClasses(self._classes().filter((c) => !cs.includes(c))),
      toggle: (c, force) => { const has = self.classList.contains(c); const on = force === undefined ? !has : !!force; if (on) self.classList.add(c); else self.classList.remove(c); return on; },
      replace: (a, b) => { const cs = self._classes(); const i = cs.indexOf(a); if (i < 0) return false; cs[i] = b; self._setClasses(cs); return true; },
      item: (i) => self._classes()[i] ?? null,
      toString: () => self.getAttribute('class') || '',
      [Symbol.iterator]: function* () { yield* self._classes(); },
      forEach: (fn) => self._classes().forEach(fn),
      get value() { return self.getAttribute('class') || ''; },
    };
  }
  _classes() { return (this.getAttribute('class') || '').split(/\s+/).filter(Boolean); }
  _setClasses(cs) { if (cs.length) this.setAttribute('class', cs.join(' ')); else this.removeAttribute('class'); }
  get attributes() { return [...this._attrs].map(([name, value]) => ({ name, value })); }
  getAttribute(n) { const v = this._attrs.get(String(n).toLowerCase()); return v === undefined ? null : v; }
  setAttribute(n, v) { this._attrs.set(String(n).toLowerCase(), String(v)); }
  removeAttribute(n) { this._attrs.delete(String(n).toLowerCase()); }
  hasAttribute(n) { return this._attrs.has(String(n).toLowerCase()); }
  toggleAttribute(n, force) { const has = this.hasAttribute(n); const on = force === undefined ? !has : !!force; if (on) this.setAttribute(n, ''); else this.removeAttribute(n); return on; }
  getAttributeNames() { return [...this._attrs.keys()]; }
  get id() { return this.getAttribute('id') || ''; }
  set id(v) { this.setAttribute('id', v); }
  get className() { return this.getAttribute('class') || ''; }
  set className(v) { if (v) this.setAttribute('class', v); else this.removeAttribute('class'); }
  get tabIndex() { const t = this.getAttribute('tabindex'); if (t !== null) return Number(t); return ['a', 'button', 'input', 'textarea', 'select'].includes(this.localName) ? 0 : -1; }
  set tabIndex(v) { this.setAttribute('tabindex', v); }
  get type() { const t = this.getAttribute('type'); if (t) return t; return this.localName === 'button' ? 'submit' : this.localName === 'input' ? 'text' : ''; }
  set type(v) { this.setAttribute('type', v); }
  get value() { if (this._value !== null) return this._value; return this.getAttribute('value') || ''; }
  set value(v) { this._value = String(v); }
  get checked() { return this._checked; }
  set checked(v) { this._checked = !!v; }
  get draggable() { return this.getAttribute('draggable') === 'true'; }
  set draggable(v) { this.setAttribute('draggable', v ? 'true' : 'false'); }
  get innerHTML() { return this._html + this.childNodes.map((c) => c.outerHTML).join(''); }
  set innerHTML(v) { this.replaceChildren(); this._html = String(v ?? ''); }
  get innerText() { return this.textContent; }
  set innerText(v) { this.textContent = v; }
  get textContent() { return this._html.replace(/<[^>]*>/g, '') + super.textContent; }
  set textContent(v) { this._html = ''; this.replaceChildren(v == null ? '' : String(v)); }
  get outerHTML() {
    const attrs = [...this._attrs].map(([k, v]) => ` ${k}="${escape(v)}"`).join('');
    if (VOID.has(this.localName) && !this.childNodes.length && !this._html) return `<${this.localName}${attrs}/>`;
    return `<${this.localName}${attrs}>${this.innerHTML}</${this.localName}>`;
  }
  /** template.content: a fragment holding an element named after the markup's first tag. */
  get content() {
    const frag = this.ownerDocument.createDocumentFragment();
    const m = /<([a-zA-Z][\w-]*)/.exec(this._html);
    if (m) {
      const node = this.ownerDocument.createElementNS(m[1] === 'svg' ? 'http://www.w3.org/2000/svg' : 'http://www.w3.org/1999/xhtml', m[1]);
      node._html = this._html.replace(/^\s*<[^>]*>/, '').replace(/<\/[^>]*>\s*$/, '');
      const attrs = /^\s*<[^>\s]+([^>]*)>/.exec(this._html)?.[1] || '';
      for (const a of attrs.matchAll(/([\w:-]+)="([^"]*)"/g)) node.setAttribute(a[1], a[2]);
      frag.append(node);
    }
    return frag;
  }
  get form() { return this.closest('form'); }
  get offsetParent() { return this._rendered() ? this.parentNode : null; }
  get offsetWidth() { return 0; }
  get offsetHeight() { return 0; }
  get offsetTop() { return 0; }
  get offsetLeft() { return 0; }
  get clientWidth() { return 0; }
  get clientHeight() { return 0; }
  get scrollHeight() { return 0; }
  get scrollWidth() { return 0; }
  _rendered() { return this.isConnected && !this.closest('[hidden]'); }
  getBoundingClientRect() { return { x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
  getClientRects() { return this._rendered() ? [this.getBoundingClientRect()] : []; }
  matches(sel) { return parseList(sel).some((c) => matchesComplex(this, c)); }
  closest(sel) { for (let n = this; n && n.nodeType === 1; n = n.parentNode) if (n.matches(sel)) return n; return null; }
  _focusable() {
    if (this.hasAttribute('disabled')) return false;
    if (this.hasAttribute('tabindex') || this.getAttribute('contenteditable') === 'true') return true;
    if (this.localName === 'a') return this.hasAttribute('href');
    return ['button', 'input', 'textarea', 'select', 'summary'].includes(this.localName);
  }
  focus() {
    const doc = this.ownerDocument;
    if (!this._rendered() || !this._focusable()) return;
    const prev = doc.activeElement;
    if (prev === this) return;
    doc._active = this;
    if (prev && prev !== doc.body) {
      prev.dispatchEvent(new FocusEvent('blur', { relatedTarget: this }));
      prev.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: this }));
    }
    this.dispatchEvent(new FocusEvent('focus', { relatedTarget: prev }));
    this.dispatchEvent(new FocusEvent('focusin', { bubbles: true, relatedTarget: prev }));
  }
  blur() {
    const doc = this.ownerDocument;
    if (doc.activeElement !== this) return;
    doc._active = null;
    this.dispatchEvent(new FocusEvent('blur'));
    this.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  }
  click() {
    if (this.hasAttribute('disabled')) return;
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, clientX: 0, clientY: 0 });
    this.dispatchEvent(ev);
    if (ev.defaultPrevented) return;
    const a = this.closest('a[href]');
    if (a) {
      const href = a.getAttribute('href');
      if (href.startsWith('#')) this.ownerDocument.defaultView.location.hash = href;
      return;
    }
    if (this.localName === 'input' && (this.type === 'checkbox' || this.type === 'radio')) this.checked = this.type === 'radio' ? true : !this.checked;
    const btn = this.closest('button, input[type="submit"]');
    if (btn && btn.type === 'submit' && btn.form) btn.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  }
  setSelectionRange() {}
  select() {}
  setPointerCapture() {}
  releasePointerCapture() {}
  hasPointerCapture() { return false; }
  scrollIntoView() {}
  scrollTo() {}
  scrollBy() {}
  showPicker() {}
  checkValidity() { return true; }
  reportValidity() { return true; }
  animate() { return { finished: Promise.resolve(), cancel() {}, finish() {}, onfinish: null }; }
  getAnimations() { return []; }
  insertAdjacentElement(where, node) {
    if (where === 'beforebegin') this.before(node); else if (where === 'afterend') this.after(node);
    else if (where === 'afterbegin') this.prepend(node); else this.append(node);
    return node;
  }
}
for (const p of ATTR_PROPS) {
  Object.defineProperty(DomElement.prototype, p, {
    get() { return this.getAttribute(p) ?? ''; },
    set(v) { if (v == null || v === false) this.removeAttribute(p); else this.setAttribute(p, v); },
    configurable: true,
  });
}
for (const p of BOOL_PROPS) {
  Object.defineProperty(DomElement.prototype, p, {
    get() { return this.hasAttribute(p.toLowerCase()); },
    set(v) {
      if (v) this.setAttribute(p.toLowerCase(), ''); else this.removeAttribute(p.toLowerCase());
      // The focus fixup rule: a focused control that stops being focusable
      // (disabled, or hidden) hands focus to the body.
      if (v && (p === 'disabled' || p === 'hidden') && this.ownerDocument.activeElement === this) this.blur();
    },
    configurable: true,
  });
}

export class DomDocument extends DomNode {
  constructor(win, href) {
    super(null);
    this.ownerDocument = this;
    this.nodeType = 9;
    this.nodeName = '#document';
    this.defaultView = win;
    this._active = null;
    this.title = '';
    this.hidden = false;
    this.visibilityState = 'visible';
    this.readyState = 'complete';
    this._href = href;
    this.documentElement = this.createElement('html');
    this.head = this.createElement('head');
    this.body = this.createElement('body');
    this.documentElement.append(this.head, this.body);
    super.appendChild(this.documentElement);
  }
  get baseURI() { return this._href; }
  get activeElement() { return this._active && this._active.isConnected ? this._active : this.body; }
  hasFocus() { return this._hasFocus ?? true; }
  createElement(tag) { return new DomElement(this, tag); }
  createElementNS(ns, tag) { return new DomElement(this, tag, ns); }
  createTextNode(s) { return new DomText(this, s); }
  createDocumentFragment() { return new DomFragment(this); }
  createComment() { return new DomText(this, ''); }
  createEvent() { return new Event('x'); }
  get scrollingElement() { return this.documentElement; }
  elementFromPoint() { return null; }
  execCommand() { return false; }
  getSelection() { return { rangeCount: 0, removeAllRanges() {}, addRange() {}, toString: () => '' }; }
}

/* ---- window ----------------------------------------------------------- */

export function installDom({ href = 'https://app.test/', hash = '', width = 1280, height = 800, coarse = false, hover = true, dark = false, reducedMotion = false, standalone = false } = {}) {
  const saved = {};
  const env = { width, height, coarse, hover, dark, reducedMotion, standalone };
  const win = new DomEventTarget();
  const base = new URL(href);
  base.hash = '';
  const doc = new DomDocument(win, base.toString());
  win.document = doc;
  win.window = win;
  win.self = win;
  win.top = win;
  win.parent = win;

  /* location & history, hash-only */
  const entries = [hash || ''];
  let index = 0;
  let scheduled = false;
  const fire = () => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => { scheduled = false; win.dispatchEvent(new HashChangeEvent('hashchange', { oldURL: '', newURL: location.href })); }, 0);
  };
  const setHash = (h, { push = true, silent = false } = {}) => {
    const next = h && !h.startsWith('#') ? `#${h}` : h || '';
    const cur = entries[index];
    if (next === cur) return;
    if (push) { entries.splice(index + 1); entries.push(next); index = entries.length - 1; } else entries[index] = next;
    if (!silent) fire();
  };
  const location = {
    get href() { return base.toString() + entries[index]; },
    set href(v) { const u = new URL(v, base); setHash(u.hash); },
    get hash() { return entries[index] === '#' ? '' : entries[index]; },
    set hash(v) { setHash(v == null ? '' : String(v)); },
    get origin() { return base.origin; },
    get pathname() { return base.pathname; },
    get search() { return base.search; },
    get host() { return base.host; },
    get hostname() { return base.hostname; },
    get protocol() { return base.protocol; },
    get port() { return base.port; },
    reloads: 0,
    reload() { this.reloads++; },
    assign(v) { this.href = v; },
    replace(v) { const u = new URL(v, base); setHash(u.hash, { push: false }); },
    toString() { return this.href; },
  };
  const history = {
    state: null,
    get length() { return entries.length; },
    pushState(state, _t, url) { this.state = state; if (url != null) setHash(new URL(url, location.href).hash, { silent: true }); },
    replaceState(state, _t, url) { this.state = state; if (url != null) setHash(new URL(url, location.href).hash, { push: false, silent: true }); },
    back() { if (index > 0) { index--; fire(); } },
    forward() { if (index < entries.length - 1) { index++; fire(); } },
    go(n) { const to = index + (n || 0); if (to >= 0 && to < entries.length && to !== index) { index = to; fire(); } },
    scrollRestoration: 'auto',
  };

  /* storage */
  const storage = () => {
    const m = new Map();
    return {
      getItem: (k) => (m.has(String(k)) ? m.get(String(k)) : null),
      setItem: (k, v) => { m.set(String(k), String(v)); },
      removeItem: (k) => { m.delete(String(k)); },
      clear: () => m.clear(),
      key: (i) => [...m.keys()][i] ?? null,
      get length() { return m.size; },
    };
  };
  const localStorage = storage();
  const sessionStorage = storage();

  /* media queries */
  const mqListeners = [];
  const evalQuery = (q) => {
    const s = String(q);
    const parts = s.split(',').map((p) => p.trim());
    return parts.some((p) => {
      const conds = [...p.matchAll(/\(([^)]+)\)/g)].map((m) => m[1]);
      return conds.every((c) => {
        let m;
        if ((m = /^max-width:\s*(\d+(?:\.\d+)?)px$/.exec(c))) return env.width <= Number(m[1]);
        if ((m = /^min-width:\s*(\d+(?:\.\d+)?)px$/.exec(c))) return env.width >= Number(m[1]);
        if ((m = /^max-height:\s*(\d+(?:\.\d+)?)px$/.exec(c))) return env.height <= Number(m[1]);
        if ((m = /^min-height:\s*(\d+(?:\.\d+)?)px$/.exec(c))) return env.height >= Number(m[1]);
        if (c === 'pointer: coarse') return env.coarse;
        if (c === 'pointer: fine') return !env.coarse;
        if (c === 'hover: none') return !env.hover;
        if (c === 'hover: hover') return env.hover;
        if (c === 'prefers-color-scheme: dark') return env.dark;
        if (c === 'prefers-color-scheme: light') return !env.dark;
        if (c === 'prefers-reduced-motion: reduce') return env.reducedMotion;
        if (c === 'display-mode: standalone') return env.standalone;
        if (c === 'forced-colors: active') return false;
        return false;
      });
    });
  };
  const matchMedia = (q) => {
    const mq = {
      media: String(q),
      get matches() { return evalQuery(q); },
      onchange: null,
      _fns: [],
      addEventListener(type, fn) { if (type === 'change') this._fns.push(fn); },
      removeEventListener(type, fn) { this._fns = this._fns.filter((f) => f !== fn); },
      addListener(fn) { this._fns.push(fn); },
      removeListener(fn) { this._fns = this._fns.filter((f) => f !== fn); },
      dispatchEvent() { return true; },
    };
    mqListeners.push(mq);
    return mq;
  };
  const setEnv = (patch) => {
    const before = mqListeners.map((mq) => mq.matches);
    Object.assign(env, patch);
    mqListeners.forEach((mq, i) => {
      if (mq.matches !== before[i]) {
        const ev = { type: 'change', matches: mq.matches, media: mq.media };
        for (const fn of [...mq._fns]) fn(ev);
        mq.onchange?.(ev);
      }
    });
  };

  const navigator = {
    platform: 'MacIntel',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) TeamchatTestShim/1.0',
    language: 'en-US',
    languages: ['en-US'],
    onLine: true,
    maxTouchPoints: coarse ? 5 : 0,
    clipboard: { writeText: async (t) => { navigator.clipboard.last = t; }, readText: async () => '' , last: null },
    vibrate() { return false; },
    sendBeacon() { return true; },
  };

  class Observer { constructor(cb) { this.cb = cb; } observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } }

  Object.assign(win, {
    location, history, localStorage, sessionStorage, matchMedia, navigator,
    get innerWidth() { return env.width; },
    get innerHeight() { return env.height; },
    devicePixelRatio: 1,
    requestAnimationFrame: (fn) => setTimeout(() => fn(Date.now()), 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    scrollTo() {},
    open() { return null; },
    getSelection: () => doc.getSelection(),
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    ResizeObserver: Observer, IntersectionObserver: Observer, MutationObserver: Observer,
    KeyboardEvent, MouseEvent, PointerEvent, FocusEvent, InputEvent, HashChangeEvent, DragEvent, ClipboardEvent, StorageEvent, WheelEvent, TouchEvent, UIEvent,
    Node: DomNode, Element: DomElement, HTMLElement: DomElement, HTMLInputElement: DomElement, HTMLTextAreaElement: DomElement, HTMLButtonElement: DomElement,
    HTMLAnchorElement: DomElement, SVGElement: DomElement, DocumentFragment: DomFragment, Text: DomText, Document: DomDocument,
  });

  const globals = {
    window: win, document: doc, location, history, localStorage, sessionStorage, matchMedia, navigator,
    requestAnimationFrame: win.requestAnimationFrame, cancelAnimationFrame: win.cancelAnimationFrame, getComputedStyle: win.getComputedStyle,
    ResizeObserver: Observer, IntersectionObserver: Observer, MutationObserver: Observer,
    KeyboardEvent, MouseEvent, PointerEvent, FocusEvent, InputEvent, HashChangeEvent, DragEvent, ClipboardEvent, StorageEvent, WheelEvent, TouchEvent, UIEvent,
    Node: DomNode, Element: DomElement, HTMLElement: DomElement, HTMLInputElement: DomElement, HTMLTextAreaElement: DomElement, HTMLButtonElement: DomElement,
    HTMLAnchorElement: DomElement, SVGElement: DomElement, DocumentFragment: DomFragment, Text: DomText, Document: DomDocument,
    innerWidth: env.width, innerHeight: env.height, self: win,
  };
  for (const [k, v] of Object.entries(globals)) {
    saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true, enumerable: false });
  }

  const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
  return {
    window: win, document: doc, location, history, localStorage, sessionStorage, navigator, env, tick,
    setWidth: (w) => setEnv({ width: w }),
    setEnv,
    /** Type into a field the way a person does: value, then an input event. */
    type(input, text) { input.value = text; input.dispatchEvent(new InputEvent('input', { bubbles: true })); },
    key(target, key, init = {}) {
      const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
      target.dispatchEvent(ev);
      return ev;
    },
    uninstall() {
      // What the process had before is put back; what it did not have
      // (document, window, the element classes: nothing of Node's) is left
      // standing, detached, rather than deleted. A timer a test left running
      // (a dialog's 200 ms closing animation, a deferred focus) fires after
      // the test is over and reads `document`; deleted, that read threw a
      // TypeError vitest counts as an unhandled error, and a whole green run
      // was reported red for it, once in a while and more often under load.
      // The next test installs fresh fakes over these before it imports
      // anything, so nothing carries across.
      for (const [k, d] of Object.entries(saved)) {
        if (d) Object.defineProperty(globalThis, k, d);
      }
    },
  };
}
