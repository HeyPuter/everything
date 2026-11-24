// Minimal DOM construction helpers.

type Attrs = Record<string, string | number | boolean | null | undefined | EventListener | Partial<CSSStyleDeclaration>>;
type Child = Node | string | number | null | undefined | false | Child[];

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'class') el.className = String(v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  append(el, children);
  return el;
}

export function append(el: Element, children: Child[]) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : String(c));
  }
}

export function clear(el: Element) {
  while (el.firstChild) el.firstChild.remove();
}

let uid = 0;
export const nextDomId = (p = 'id') => `${p}-${++uid}`;

/** Polite screen reader announcement. */
export function announce(text: string) {
  const r = document.getElementById('live-region');
  if (!r) return;
  r.textContent = '';
  setTimeout(() => { r.textContent = text; }, 30);
}

/** Gives an element whose text an ellipsis may clip its full text as a tooltip, while it is clipped. */
export function titleWhenClipped(el: HTMLElement) {
  el.addEventListener('pointerenter', () => {
    if (el.scrollWidth > el.clientWidth + 1) el.title = el.textContent ?? '';
    else el.removeAttribute('title');
  });
}

/** An element's ancestors, kept to find it again if it is re-rendered meanwhile (see refocus). */
export function ancestors(el: Element | null): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (let p = el?.parentElement; p && p !== document.body; p = p.parentElement) out.push(p);
  return out;
}

/**
 * Focuses an element again. When it was re-rendered meanwhile (a design tree
 * row after a rebuild), its replacement (same data-key) or else the current
 * tab stop of its nearest remaining ancestor gets focus, instead of the page body.
 */
export function refocus(prev: HTMLElement | null, parents: HTMLElement[], preventScroll = false) {
  if (!prev?.focus) return;
  if (prev.isConnected) { prev.focus({ preventScroll }); return; }
  const box = parents.find((p) => p.isConnected);
  if (!box) return;
  const key = prev.dataset.key;
  const target = (key ? box.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`) : null)
    ?? box.querySelector<HTMLElement>('[tabindex="0"]')
    ?? box.querySelector<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select, textarea');
  target?.focus({ preventScroll });
}

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** Formats a shortcut like "Ctrl+S" for the platform ("Control+" is the Control key, ⌃ on macOS). */
export function formatShortcut(s?: string): string {
  if (!s) return '';
  return isMac ? s.replace(/Control\+/g, '⌃').replace(/Ctrl\+/g, '⌘').replace(/Alt\+/g, '⌥').replace(/Shift\+/g, '⇧') : s.replace(/Control\+/g, 'Ctrl+');
}

export function isTextInput(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  if (el instanceof HTMLInputElement) return !['checkbox', 'radio', 'button', 'range', 'color'].includes(el.type);
  return false;
}
