// Keyed list rendering for panels that rebuild their markup on every update
// (the Layers panel lists every layer). The list is described as one HTML
// fragment per entry; entries whose markup is unchanged keep their DOM nodes,
// so an update that changes one row parses and lays out only that row, and
// thumbnails are not decoded again. Nodes changed by anything else since the
// last patch (an inline rename, drag highlighting, a loaded thumbnail, an
// edited field) are rebuilt from their markup, so the result always equals
// a full rebuild.

type Entry = { html: string; nodes: ChildNode[] };
type State = { entries: Entry[]; observer: MutationObserver };
const states = new WeakMap<Element, State>();
const template = typeof document !== 'undefined' ? document.createElement('template') : undefined;

// A form control whose current value differs from its markup (typed into,
// or set by code) is not reused: a rebuild would reset it.
function edited(n: ChildNode): boolean {
  if (!(n instanceof Element)) return false;
  for (const c of n.matches('input,select,textarea') ? [n] : n.querySelectorAll('input,select,textarea')) {
    if (c instanceof HTMLInputElement) {
      if (c.type === 'checkbox' || c.type === 'radio' ? c.checked !== c.defaultChecked : c.value !== c.defaultValue) return true;
    } else if (c instanceof HTMLTextAreaElement) {
      if (c.value !== c.defaultValue) return true;
    } else if (c instanceof HTMLSelectElement && c.options.length) {
      const marked = [...c.options].filter((o) => o.defaultSelected).at(-1) ?? [...c.options].find((o) => !o.disabled) ?? c.options[0];
      if (c.value !== marked.value) return true;
    }
  }
  return false;
}
function parse(html: string): ChildNode[] {
  template!.innerHTML = html;
  return [...template!.content.childNodes];
}

/** Make `container`'s children equal to the concatenation of `fragments`. */
export function patchList(container: Element, fragments: string[]) {
  let state = states.get(container);
  if (!state) {
    const observer = new MutationObserver(() => {});
    observer.observe(container, { childList: true, subtree: true, attributes: true, characterData: true });
    state = { entries: [], observer };
    states.set(container, state);
  }
  // Top-level nodes touched by other code since the last patch.
  const stale = new Set<Node>();
  for (const record of state.observer.takeRecords()) {
    let n: Node | null = record.target;
    if (n === container) {
      record.removedNodes.forEach((r) => stale.add(r));
      record.addedNodes.forEach((a) => stale.add(a));
      continue;
    }
    while (n && n.parentNode !== container) n = n.parentNode;
    if (n) stale.add(n);
  }
  const pool = new Map<string, Entry[]>();
  for (const entry of state.entries) {
    if (entry.nodes.some((n) => n.parentNode !== container || stale.has(n) || edited(n))) continue;
    const list = pool.get(entry.html);
    if (list) list.push(entry);
    else pool.set(entry.html, [entry]);
  }
  const entries: Entry[] = fragments.map((html) => pool.get(html)?.shift() ?? { html, nodes: parse(html) });
  // Drop nodes that are not reused first: otherwise the first one stays the
  // insertion point and every node after it is moved (and restyled and laid
  // out again) to land before it.
  const kept = new Set<ChildNode>();
  for (const entry of entries) for (const n of entry.nodes) kept.add(n);
  for (let n = container.firstChild; n; ) {
    const next = n.nextSibling;
    if (!kept.has(n)) n.remove();
    n = next;
  }
  // Move nodes into place; unchanged runs are left alone.
  let ref = container.firstChild;
  for (const entry of entries)
    for (const n of entry.nodes) {
      if (n === ref) ref = ref.nextSibling;
      else container.insertBefore(n, ref);
    }
  while (ref) {
    const next = ref.nextSibling;
    ref.remove();
    ref = next;
  }
  state.entries = entries;
  state.observer.takeRecords();
}
