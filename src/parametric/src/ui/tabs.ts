// WAI-ARIA tabs keyboard pattern: the tablist is a single tab stop (the
// selected tab) and the arrow keys, Home and End move between its tabs.

const tabsOf = (list: HTMLElement) => [...list.querySelectorAll<HTMLElement>('[role="tab"]')];

/** Makes the selected (or else the first visible) tab the list's only tab stop. */
export function syncTabStops(list: HTMLElement) {
  const tabs = tabsOf(list);
  const shown = tabs.filter((b) => !b.hidden);
  const stop = shown.find((b) => b.getAttribute('aria-selected') === 'true') ?? shown[0];
  for (const b of tabs) b.tabIndex = b === stop ? 0 : -1;
}

/** Marks the tabs matching `selected` as selected and moves the tab stop to them. */
export function selectTabs(list: HTMLElement, selected: (tab: HTMLElement) => boolean) {
  for (const b of tabsOf(list)) b.setAttribute('aria-selected', String(selected(b)));
  syncTabStops(list);
}

/**
 * Arrow keys (Left/Right, or Up/Down when vertical), Home and End move focus
 * between the visible tabs. With `activate` (the default) the focused tab is
 * also clicked; otherwise Enter or Space activates it.
 */
export function tabKeys(list: HTMLElement, opts: { vertical?: boolean; activate?: boolean } = {}) {
  syncTabStops(list);
  list.addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const tabs = tabsOf(list).filter((b) => !b.hidden && !(b as HTMLButtonElement).disabled);
    const i = tabs.indexOf(e.target as HTMLElement);
    if (i < 0) return;
    const [prev, next] = opts.vertical ? ['ArrowUp', 'ArrowDown'] : ['ArrowLeft', 'ArrowRight'];
    const j = e.key === next ? (i + 1) % tabs.length : e.key === prev ? (i - 1 + tabs.length) % tabs.length
      : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : -1;
    if (j < 0) return;
    e.preventDefault();
    const t = tabs[j];
    for (const b of tabsOf(list)) b.tabIndex = b === t ? 0 : -1;
    t.focus();
    if (opts.activate !== false && t.getAttribute('aria-selected') !== 'true') t.click();
  });
  // Leaving the list puts the tab stop back on the selected tab.
  list.addEventListener('focusout', (e) => {
    if (!list.contains(e.relatedTarget as Node | null)) syncTabStops(list);
  });
}
