import { el, icon } from './lib/ui.js';
import { unpackOutline } from './core/outline-transport.js';

/**
 * The document outline (bookmarks) as a tree in the side panel. Items that point at a page
 * navigate there; groups fold and unfold; Up and Down move through the visible items, Left
 * and Right fold and unfold, Home and End jump to the ends. The item for the page on view is
 * marked so long documents keep their place.
 */
/** The zero-based page a PDF.js destination (named or explicit) points to, or null. */
export async function destinationPage(pdf, dest) {
  return (await destinationTarget(pdf, dest))?.page ?? null;
}
/**
 * Where a destination points: its page, and the PDF coordinates that belong at the top left
 * of the view (`left` or `top` is null where the destination leaves it to the reader).
 */
export async function destinationTarget(pdf, dest) {
  try {
    const explicit = typeof dest === 'string' ? await pdf.getDestination(dest) : dest;
    const ref = explicit?.[0];
    if (ref == null) return null;
    const index = typeof ref === 'object' ? await pdf.getPageIndex(ref) : ref;
    if (!(Number.isInteger(index) && index >= 0 && index < pdf.numPages)) return null;
    const at = (i) => (Number.isFinite(explicit[i]) ? explicit[i] : null);
    const [left, top] =
      {
        XYZ: [at(2), at(3)],
        FitH: [null, at(2)],
        FitBH: [null, at(2)],
        FitV: [at(2), null],
        FitBV: [at(2), null],
        FitR: [at(2), at(5)],
      }[explicit[1]?.name] || [];
    return { page: index, left: left ?? null, top: top ?? null };
  } catch {
    return null;
  }
}
/** As many items as the tree shows; a longer outline is listed this far and says so. */
const MAX_ITEMS = 2000;
export function createOutlinePanel({ onNavigate, onMenu }) {
  const root = el('div', { class: 'outline' });
  let entries = [], // { button, page, depth, group, parent }
    generation = 0,
    snapshot = null,
    currentPage = null;
  const visible = () => entries.filter((entry) => !entry.button.closest('[hidden]'));
  function clear() {
    generation++;
    root.replaceChildren();
    entries = [];
    snapshot = null;
    currentPage = null;
  }
  /**
   * Resolve a replacement before publishing it, retaining the current tree while loading.
   * An unchanged outline keeps its DOM, expansion, focus, and scroll position across edits.
   */
  async function load(pdf, { isCurrent = () => true } = {}) {
    const token = ++generation;
    let items = null;
    try {
      items = unpackOutline(await pdf.getOutline());
    } catch {
      items = null;
    }
    if (token !== generation || !isCurrent()) return false;
    const flat = [];
    const pending = [{ list: items || [], next: 0 }];
    while (pending.length) {
      const frame = pending.at(-1);
      if (frame.next === frame.list.length) {
        pending.pop();
        continue;
      }
      const item = frame.list[frame.next++];
      flat.push(item);
      if (item.items?.length) pending.push({ list: item.items, next: 0 });
    }
    const targets = await Promise.all(
      flat
        .slice(0, MAX_ITEMS)
        .map((item) => (item.dest ? destinationTarget(pdf, item.dest) : null)),
    );
    if (token !== generation || !isCurrent()) return false;
    // Include resolved destinations: reordering pages can change navigation even when
    // titles and PDF object references are unchanged.
    const nextSnapshot = JSON.stringify([
      flat.length,
      flat
        .slice(0, MAX_ITEMS)
        .map((item, i) => [
          item.title,
          item.bold,
          item.italic,
          item.url,
          item.items?.length || 0,
          targets[i]?.page,
          targets[i]?.left,
          targets[i]?.top,
        ]),
    ]);
    if (nextSnapshot === snapshot) return entries.length > 0;
    const focusedPath = entries.find((entry) => entry.button === document.activeElement)?.path;
    const expanded = new Set(
      entries
        .filter((entry) => entry.group && !entry.group.hidden)
        .map((entry) => JSON.stringify(entry.path)),
    );
    const scrollTop = root.scrollTop;
    const nextEntries = [];
    const makeGroup = (depth) =>
      el('ul', {
        class: 'outline-list',
        ...(depth
          ? { role: 'group', hidden: true }
          : { role: 'tree', 'aria-label': 'Document outline' }),
      });
    const build = (list) => {
      const rootGroup = makeGroup(0);
      const stack = [{ list, depth: 0, parent: null, group: rootGroup, next: 0 }];
      while (stack.length && nextEntries.length < MAX_ITEMS) {
        const frame = stack.at(-1);
        if (frame.next === frame.list.length) {
          stack.pop();
          continue;
        }
        const { depth, parent, group } = frame;
        const position = frame.next++;
        const item = frame.list[position];
        const title = String(item.title || '').trim() || 'Untitled';
        const label = el(
          'button',
          {
            type: 'button',
            class: `outline-item${item.bold ? ' bold' : ''}${item.italic ? ' italic' : ''}`,
            role: 'treeitem',
            'aria-level': String(depth + 1),
            tabindex: -1,
            // Items without a destination stay focusable so arrow keys pass through them
            // and their menu stays reachable.
            'aria-disabled':
              targets[nextEntries.length] == null && !item.items?.length ? 'true' : null,
            title,
          },
          el('span', { class: 'outline-label' }, title),
        );
        label.style.paddingLeft = `${18 + depth * 14}px`;
        const entry = {
          button: label,
          page: targets[nextEntries.length]?.page ?? null,
          target: targets[nextEntries.length],
          depth,
          group: null,
          parent,
          title,
          path: [...(parent?.path ?? []), position],
        };
        // A right-click or long press offers to rename or remove the bookmark.
        if (onMenu)
          label.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            onMenu(entry, e);
          });
        if (entry.page == null && !item.items?.length && item.url)
          label.title = `${title} (web link, not followed)`;
        nextEntries.push(entry);
        const row = el('li', { role: 'none', class: 'outline-row' }, label);
        if (item.items?.length) {
          entry.group = makeGroup(depth + 1);
          stack.push({
            list: item.items,
            depth: depth + 1,
            parent: entry,
            group: entry.group,
            next: 0,
          });
          label.setAttribute('aria-expanded', 'false');
          const toggle = el(
            'button',
            {
              type: 'button',
              class: 'outline-toggle',
              'aria-label': `Expand ${title}`,
              tabindex: -1,
              onclick: () => {
                // Keep the tree's tab stop visible when a focused descendant is collapsed.
                label.focus({ preventScroll: true });
                setExpanded(entry, entry.group.hidden);
              },
            },
            icon('ChevronRight', 14),
          );
          // The 24px hit area is centered where the 20px chevron sat.
          toggle.style.left = `${depth * 14 - 2}px`;
          row.prepend(toggle);
          row.append(entry.group);
          if (expanded.has(JSON.stringify(entry.path))) setExpanded(entry, true);
        }
        label.addEventListener('click', () => {
          if (entry.page != null) onNavigate(entry.page, entry.target);
          else if (entry.group) setExpanded(entry, entry.group.hidden);
        });
        label.addEventListener('keydown', (e) => onKey(e, entry));
        label.addEventListener('focus', () => {
          entries.forEach((other) => (other.button.tabIndex = other === entry ? 0 : -1));
        });
        group.append(row);
      }
      return rootGroup;
    };
    const content = document.createDocumentFragment();
    if (items?.length) content.append(build(items));
    // A longer outline is cut to the first MAX_ITEMS; saying so beats ending without a word.
    if (flat.length > MAX_ITEMS)
      content.append(
        el(
          'p',
          { class: 'outline-note muted' },
          `Only the first ${MAX_ITEMS.toLocaleString()} of ${flat.length.toLocaleString()} bookmarks are listed.`,
        ),
      );
    entries = nextEntries;
    snapshot = nextSnapshot;
    if (entries[0]) entries[0].button.tabIndex = 0;
    root.replaceChildren(content);
    root.scrollTop = scrollTop;
    // A renamed/removed bookmark returns focus to its item or nearest remaining neighbor.
    if (focusedPath && document.activeElement === document.body) restoreFocus(focusedPath);
    return entries.length > 0;
  }
  /** Focus the item at a path, else its previous sibling, its parent, or the first item. */
  function restoreFocus(path) {
    const same = (entry, target) =>
      entry.path.length === target.length && entry.path.every((n, i) => n === target[i]);
    const candidates = [
      path,
      path.length ? [...path.slice(0, -1), path.at(-1) - 1] : null,
      path.length > 1 ? path.slice(0, -1) : null,
    ].filter(Boolean);
    const entry =
      candidates.map((target) => entries.find((e) => same(e, target))).find(Boolean) || entries[0];
    if (!entry) return;
    for (let parent = entry.parent; parent; parent = parent.parent) setExpanded(parent, true);
    entry.button.focus({ preventScroll: true });
  }
  function setExpanded(entry, expanded) {
    if (!entry.group) return;
    // A collapsed group's hidden items cannot keep the tree's tab stop. Safari and Firefox on
    // macOS do not focus a clicked button, so a click alone never moves it to the group.
    const stop = entries.find((other) => other.button.tabIndex === 0)?.button;
    if (!expanded && stop && entry.group.contains(stop)) {
      if (entry.group.contains(document.activeElement)) entry.button.focus({ preventScroll: true });
      else entries.forEach((other) => (other.button.tabIndex = other === entry ? 0 : -1));
    }
    entry.group.hidden = !expanded;
    entry.button.setAttribute('aria-expanded', String(expanded));
    const toggle = entry.button.parentElement.querySelector('.outline-toggle');
    if (toggle) {
      toggle.classList.toggle('open', expanded);
      toggle.setAttribute(
        'aria-label',
        `${expanded ? 'Collapse' : 'Expand'} ${entry.button.title}`,
      );
    }
  }
  function onKey(e, entry) {
    const list = visible(),
      at = list.indexOf(entry);
    const focus = (target) => target?.button.focus({ preventScroll: false });
    if (e.key === 'ArrowDown') focus(list[at + 1]);
    else if (e.key === 'ArrowUp') focus(list[at - 1]);
    else if (e.key === 'Home') focus(list[0]);
    else if (e.key === 'End') focus(list.at(-1));
    else if (e.key === 'ArrowRight') {
      if (entry.group && entry.group.hidden) setExpanded(entry, true);
      else if (entry.group) focus(visible()[at + 1]);
    } else if (e.key === 'ArrowLeft') {
      if (entry.group && !entry.group.hidden) setExpanded(entry, false);
      else focus(entry.parent);
    } else return;
    e.preventDefault();
  }
  /** Mark the items that point at the page on view, unfolding the way to the first one. */
  function setCurrent(pageIndex, { reveal = pageIndex !== currentPage } = {}) {
    if (!entries.length) {
      currentPage = null;
      return;
    }
    currentPage = pageIndex;
    let first = null;
    for (const entry of entries) {
      const current = entry.page === pageIndex;
      if (current) entry.button.setAttribute('aria-current', 'page');
      else entry.button.removeAttribute('aria-current');
      if (current && !first) first = entry;
    }
    if (reveal) {
      for (let entry = first?.parent; entry; entry = entry.parent) setExpanded(entry, true);
      if (first && root.isConnected && !root.hidden)
        first.button.scrollIntoView({ block: 'nearest' });
    }
  }
  return {
    el: root,
    load,
    setCurrent,
    clear,
    get hasItems() {
      return entries.length > 0;
    },
  };
}
