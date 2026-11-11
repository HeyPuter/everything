// Minimal keyed virtual DOM used by editors that redraw from document state
// (similar in spirit to an immediate-mode UI): draw functions return a tree,
// `patch` reconciles it with the live DOM, keeping focus and element identity.

export type Child = VNode | string | number | null | undefined | false | Child[];

export interface VNode {
  tag: string;
  key?: string | number;
  attrs: Record<string, unknown>;
  children: VNode[];
  text?: string;
  el?: Node;
}

const TEXT = '#text';

export function h(tag: string, attrs: Record<string, unknown> | null = null, ...children: Child[]): VNode {
  const a = attrs ?? {};
  const flat: VNode[] = [];
  const push = (c: Child) => {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) c.forEach(push);
    else if (typeof c === 'string' || typeof c === 'number') flat.push({ tag: TEXT, attrs: {}, children: [], text: String(c) });
    else flat.push(c);
  };
  children.forEach(push);
  return { tag, key: a.key as string | number | undefined, attrs: a, children: flat };
}

/** Raw HTML/SVG node that is created once by `create` and left alone afterwards. */
export function raw(key: string, create: () => Element): VNode {
  return { tag: '#raw', key, attrs: { create }, children: [] };
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const SVG_TAGS = new Set(['svg', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'g', 'text', 'defs', 'linearGradient', 'radialGradient', 'stop', 'ellipse', 'clipPath', 'pattern', 'use', 'tspan', 'mask']);

function createEl(v: VNode, svg: boolean): Node {
  if (v.tag === TEXT) return document.createTextNode(v.text ?? '');
  if (v.tag === '#raw') return (v.attrs.create as () => Element)();
  const isSvg = svg || v.tag === 'svg';
  const el = isSvg && SVG_TAGS.has(v.tag) ? document.createElementNS(SVG_NS, v.tag) : document.createElement(v.tag);
  setAttrs(el as HTMLElement, {}, v.attrs, isSvg);
  for (const c of v.children) {
    const child = createEl(c, isSvg && v.tag !== 'foreignObject');
    c.el = child;
    el.appendChild(child);
  }
  const ref = v.attrs.ref as ((el: Element) => void) | undefined;
  if (ref) ref(el);
  return el;
}

type Handler = (e: Event) => void;
const HANDLERS = Symbol('handlers');

function setAttrs(el: HTMLElement, old: Record<string, unknown>, next: Record<string, unknown>, svg: boolean) {
  for (const k in old) {
    if (k in next || k === 'key' || k === 'ref') continue;
    if (k.startsWith('on')) setHandler(el, k.slice(2).toLowerCase(), null);
    else if (k === 'class') el.removeAttribute('class');
    else if (k === 'style') el.removeAttribute('style');
    else if (k === 'value' || k === 'checked') continue;
    else el.removeAttribute(k);
  }
  for (const k in next) {
    if (k === 'key' || k === 'ref' || k === 'create') continue;
    const v = next[k];
    if (old[k] === v && k !== 'value' && k !== 'checked') continue;
    if (k.startsWith('on') && typeof v === 'function') setHandler(el, k.slice(2).toLowerCase(), v as Handler);
    else if (k.startsWith('on')) setHandler(el, k.slice(2).toLowerCase(), null);
    else if (k === 'style') {
      if (typeof v === 'string') el.setAttribute('style', v);
      else if (v && typeof v === 'object') {
        const s = el.style as unknown as Record<string, string>;
        const o = (old.style && typeof old.style === 'object' ? old.style : {}) as Record<string, string>;
        for (const p in o) if (!(p in (v as object))) s[p] = '';
        for (const [p, val] of Object.entries(v as Record<string, string>)) {
          if (p.startsWith('--')) el.style.setProperty(p, String(val));
          else if (s[p] !== String(val)) s[p] = String(val);
        }
      } else el.removeAttribute('style');
    } else if (k === 'value') {
      const input = el as HTMLInputElement;
      if (document.activeElement !== el && input.value !== String(v ?? '')) input.value = String(v ?? '');
    } else if (k === 'checked') (el as HTMLInputElement).checked = !!v;
    else if (k === 'class') {
      const c = Array.isArray(v) ? v.filter(Boolean).join(' ') : typeof v === 'object' && v ? Object.entries(v).filter(([, on]) => on).map(([n]) => n).join(' ') : String(v ?? '');
      if (svg) el.setAttribute('class', c);
      else if (el.className !== c) el.className = c;
    } else if (v === false || v === null || v === undefined) el.removeAttribute(k);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
}

function setHandler(el: HTMLElement, type: string, fn: Handler | null) {
  const store = ((el as unknown as Record<symbol, Record<string, Handler | null>>)[HANDLERS] ??= {});
  if (!(type in store)) {
    el.addEventListener(type, (e) => store[type]?.(e), type === 'wheel' || type === 'touchstart' || type === 'touchmove' ? { passive: false } : undefined);
  }
  store[type] = fn;
}

/** Whether a vdom element currently has a handler for an event type (e.g. 'pointerdown'). */
export function hasHandler(el: Element, type: string): boolean {
  return !!(el as unknown as Record<symbol, Record<string, Handler | null> | undefined>)[HANDLERS]?.[type];
}

function sameNode(a: VNode, b: VNode) {
  return a.tag === b.tag && a.key === b.key;
}

function patchNode(parent: Node, old: VNode, next: VNode, svg: boolean) {
  const el = old.el!;
  next.el = el;
  if (next.tag === TEXT) {
    if (old.text !== next.text) el.textContent = next.text ?? '';
    return;
  }
  if (next.tag === '#raw') return;
  const isSvg = svg || next.tag === 'svg';
  setAttrs(el as HTMLElement, old.attrs, next.attrs, isSvg);
  patchChildren(el, old.children, next.children, isSvg && next.tag !== 'foreignObject');
  void parent;
}

function patchChildren(el: Node, oldCh: VNode[], newCh: VNode[], svg: boolean) {
  const keyed = new Map<string | number, VNode>();
  const unkeyed: VNode[] = [];
  for (const c of oldCh) {
    if (c.key !== undefined) keyed.set(`${c.tag}:${c.key}`, c);
    else unkeyed.push(c);
  }
  let ui = 0;
  const used = new Set<VNode>();
  newCh.forEach((c, i) => {
    let match: VNode | undefined;
    if (c.key !== undefined) match = keyed.get(`${c.tag}:${c.key}`);
    else
      for (let j = ui; j < unkeyed.length; j++)
        if (!used.has(unkeyed[j]) && unkeyed[j].tag === c.tag) {
          match = unkeyed[j];
          ui = j + 1;
          break;
        }
    if (match && !used.has(match) && sameNode(match, c)) {
      used.add(match);
      patchNode(el, match, c, svg);
    } else {
      c.el = createEl(c, svg);
    }
    const ref = el.childNodes[i];
    if (ref !== c.el) el.insertBefore(c.el!, ref ?? null);
  });
  for (const c of oldCh) if (!used.has(c) && c.el && c.el.parentNode === el) el.removeChild(c.el);
}

const ROOTS = new WeakMap<Element, VNode[]>();

/** Render a list of vnodes into a container element. */
export function patch(container: Element, vnodes: Child) {
  const next = h('#root', null, vnodes).children;
  const old = ROOTS.get(container);
  if (!old) {
    container.textContent = '';
    for (const c of next) {
      c.el = createEl(c, container instanceof SVGElement);
      container.appendChild(c.el);
    }
  } else patchChildren(container, old, next, container instanceof SVGElement);
  ROOTS.set(container, next);
}

export function clearRoot(container: Element) {
  ROOTS.delete(container);
  container.textContent = '';
}
