/**
 * Every command the window offers, for the command search box, KeyTips and Customize Keyboard: the
 * ribbon's buttons (read from the ribbon itself, so module groups are included) and the classic menu
 * bar's items. Entries are built on demand, so their enabled state is current.
 *
 * entry: { id, label, path: [String], shortcut, disabled, run() }
 */

const clean = label => String(label || '').replace(/…$/, '').replace(/\s+/g, ' ').trim();

/** Ribbon commands: one entry per labelled button in each tab's panel. */
export function ribbonEntries({ ribbon, tabs, beforeRun = () => {} }) {
  const out = [];
  for (const tab of tabs) {
    const panel = ribbon.card.querySelector(`#ribbon-panel-${tab.id}`);
    const tabButton = document.getElementById(`ribbon-tab-${tab.id}`);
    if (!panel) continue;
    const tabShown = !tabButton?.hidden;
    for (const group of panel.querySelectorAll(':scope > .ribbon-group')) {
      const groupLabel = group.getAttribute('aria-label') || '';
      for (const control of group.querySelectorAll('.ribbon-group-body button')) {
        if (control.classList.contains('ribbon-collapsed')) continue;
        const label = clean(control.getAttribute('aria-label') || control.title || control.textContent);
        if (!label) continue;
        out.push({
          id: `ribbon:${tab.id}/${group.dataset.group}/${label}`,
          label, path: [tab.label, groupLabel], shortcut: control.dataset.shortcut || null,
          disabled: !tabShown || control.disabled,
          control,
          run: () => {
            if (!tabShown || control.disabled || !control.isConnected) return false;
            beforeRun();
            ribbon.select(tab.id);
            // A group folded for a narrow window opens its drop-down so the command has an anchor.
            if (!control.getClientRects().length) group.querySelector(':scope > .ribbon-collapsed:not([hidden])')?.click();
            control.click();
            return true;
          },
        });
      }
    }
  }
  return out;
}

/** Menu-bar items: each leaf with an action, under its menu path. */
export function menuEntries(menus) {
  const out = [];
  const walk = (items, path, idPath) => {
    for (const item of items || []) {
      if (!item || item.separator || item.header || item.note || item.custom || !item.label) continue;
      const label = clean(item.label);
      if (item.items) { walk(item.items, [...path, label], [...idPath, label]); continue; }
      if (!item.onSelect) continue;
      out.push({ id: `menu:${[...idPath, label].join('/')}`, label, path, shortcut: item.shortcut || null, disabled: !!item.disabled,
        run: () => { if (item.disabled) return false; item.onSelect(); return true; } });
    }
  };
  for (const menu of menus) {
    let items = [];
    try { items = menu.items(); } catch { items = []; }
    walk(items, [menu.label], [menu.id]);
  }
  return out;
}

/** Score an entry for a query: every word must start a word of its label or path; label hits rank first. */
export function scoreEntry(entry, query) {
  const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return 0;
  const label = entry.label.toLowerCase(), path = entry.path.join(' ').toLowerCase();
  const starts = (text, word) => text.startsWith(word) || text.includes(` ${word}`) || text.includes(`-${word}`) || text.includes(`(${word}`);
  let score = 0;
  for (const word of words) {
    if (label === word) score += 12;
    else if (label.startsWith(word)) score += 8;
    else if (starts(label, word)) score += 6;
    else if (label.includes(word) && word.length > 2) score += 3;
    else if (starts(path, word)) score += 1;
    else return 0;
  }
  return score - (entry.disabled ? 2 : 0) - entry.label.length / 100;
}

/** Search entries, one per label and path, best first. */
export function searchEntries(entries, query, limit = 8) {
  const seen = new Set();
  return entries.map(entry => [entry, scoreEntry(entry, query)]).filter(([, score]) => score > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([entry]) => entry)
    .filter(entry => { const key = `${entry.label}|${entry.disabled}`; if (seen.has(key)) return false; seen.add(key); return true; })
    .slice(0, limit);
}
