// Panels and bars that rebuild their markup on every update would drop the
// keyboard focus to the page (and the next Tab would start over from the top).
// `keepFocus` runs such a redraw and puts the focus back on the same control,
// or on the control that replaced it.

type Mark = { el: HTMLElement; selector: string; loose: string; index: number; start: number | null; end: number | null };

const caret = (el: Element, key: 'selectionStart' | 'selectionEnd') => {
  try {
    return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el[key] : null;
  } catch {
    return null;
  }
};
// Attributes that identify a control across redraws (not its state).
const identifying = (name: string) => name.startsWith('data-') || name === 'name' || name === 'role' || name === 'type';

function mark(root: HTMLElement): Mark | undefined {
  const f = document.activeElement as HTMLElement | null;
  if (!f || f === root || !root.contains(f)) return undefined;
  const tag = f.tagName.toLowerCase();
  const attrs = [...f.attributes].filter((a) => identifying(a.name));
  const selector = f.id ? `#${CSS.escape(f.id)}` : tag + attrs.map((a) => `[${a.name}="${CSS.escape(a.value)}"]`).join('');
  const loose = tag + attrs.map((a) => `[${a.name}]`).join('');
  return { el: f, selector, loose, index: [...root.querySelectorAll(selector)].indexOf(f), start: caret(f, 'selectionStart'), end: caret(f, 'selectionEnd') };
}

function restore(root: HTMLElement, m: Mark) {
  const now = document.activeElement;
  // The focus moved on purpose (a dialog, another field): leave it there.
  if (now === m.el || (now && now !== document.body && now.isConnected)) return;
  let next: HTMLElement | undefined = m.el.isConnected && root.contains(m.el) ? m.el : undefined;
  if (!next) {
    const exact = root.querySelectorAll<HTMLElement>(m.selector);
    const list = exact.length ? exact : root.querySelectorAll<HTMLElement>(m.loose);
    next = list[Math.max(0, Math.min(m.index, list.length - 1))];
  }
  if (!next) return;
  next.focus({ preventScroll: true });
  if (m.start !== null && m.end !== null && caret(next, 'selectionStart') !== null) (next as HTMLInputElement).setSelectionRange(m.start, m.end);
}

/** Run `redraw` on `root`, keeping the keyboard focus inside it. */
export function keepFocus<T>(root: HTMLElement, redraw: () => T): T {
  const m = mark(root);
  const out = redraw();
  if (m) restore(root, m);
  return out;
}
