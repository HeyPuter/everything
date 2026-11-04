/**
 * A person's arrangement of the ribbon: which tabs show and in what order, names they gave tabs, tabs of their
 * own, and groups of their own (on their tabs or added to the built-in ones), each holding any commands.
 *
 * { order: [tabId], hidden: [tabId], names: { tabId: name }, tabs: [{ id, name }], groups: { tabId: [{ id, name, commands: [commandId] }] } }
 *
 * A built-in tab's id is its name ("Home"); a tab of the person's own has an id starting "custom-". The
 * functions here are pure: each returns a new layout, and none knows about the screen.
 *
 * A built-in tab's id stays its English name in every language (it is what a layout keeps); the name shown for
 * it is builtinTabLabel's.
 */
import { t, tSource } from '../i18n/index.js';

/** The catalog key of each built-in tab's name, by its id; the contextual tabs too. */
const BUILTIN_TAB_KEYS = {
  Home: 'ribbonLayout.tab.home', Insert: 'ribbonLayout.tab.insert', Draw: 'ribbonLayout.tab.draw', 'Page Layout': 'ribbonLayout.tab.pageLayout',
  Formulas: 'ribbonLayout.tab.formulas', Data: 'ribbonLayout.tab.data', Review: 'ribbonLayout.tab.review', View: 'ribbonLayout.tab.view',
  Automate: 'ribbonLayout.tab.automate', Table: 'ribbonLayout.tab.table', 'Chart Design': 'ribbonLayout.tab.chartDesign', Format: 'ribbonLayout.tab.format',
  'SmartArt Design': 'ribbonLayout.tab.smartArtDesign', 'SmartArt Format': 'ribbonLayout.tab.smartArtFormat', 'Picture Format': 'ribbonLayout.tab.pictureFormat',
};

/** The name a built-in tab shows, in the interface language (its id for a tab not known here). */
export const builtinTabLabel = (id) => (Object.hasOwn(BUILTIN_TAB_KEYS, id) ? t(BUILTIN_TAB_KEYS[id]) : id);
/** The same name in English: what the tab's key tip is worked out from, so it is the same in every language. */
export const builtinTabSourceLabel = (id) => (Object.hasOwn(BUILTIN_TAB_KEYS, id) ? tSource(BUILTIN_TAB_KEYS[id]) : id);
const newTabName = () => t('ribbonLayout.newTab');
const newGroupName = () => t('ribbonLayout.newGroup');

export const EMPTY_LAYOUT = Object.freeze({ order: [], hidden: [], names: {}, tabs: [], groups: {} });

const MAX_NAME = 60;
const cleanName = (name, fallback) => (typeof name === 'string' && name.trim() ? name.trim().slice(0, MAX_NAME) : fallback);
const isId = (v) => typeof v === 'string' && v.length > 0 && v.length <= 400;

/** A layout of the right shape, whatever was stored; ids of tabs that no longer exist are dropped by `tabsIn`. */
export function normalizeLayout(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const tabs = (Array.isArray(src.tabs) ? src.tabs : [])
    .filter((tab) => tab && /^custom-[\w-]{1,40}$/.test(tab.id))
    .map((tab) => ({ id: tab.id, name: cleanName(tab.name, newTabName()) }));
  const groups = {};
  if (src.groups && typeof src.groups === 'object') {
    for (const [tab, list] of Object.entries(src.groups)) {
      if (!Array.isArray(list)) continue;
      const kept = list.filter((g) => g && /^group-[\w-]{1,40}$/.test(g.id))
        .map((g) => ({ id: g.id, name: cleanName(g.name, newGroupName()), commands: [...new Set((Array.isArray(g.commands) ? g.commands : []).filter(isId))].slice(0, 60) }));
      if (kept.length) groups[tab] = kept;
    }
  }
  const names = {};
  if (src.names && typeof src.names === 'object') for (const [id, name] of Object.entries(src.names)) if (isId(id) && typeof name === 'string' && name.trim()) names[id] = cleanName(name);
  return {
    order: [...new Set((Array.isArray(src.order) ? src.order : []).filter(isId))],
    hidden: [...new Set((Array.isArray(src.hidden) ? src.hidden : []).filter(isId))],
    names, tabs, groups,
  };
}

/**
 * The tabs in the order shown, given the built-in ones: [{ id, name, builtin, hidden, renamed }]. A built-in tab's
 * name is the person's for it, or else its own in the interface language; `renamed` says which. Tabs the order
 * does not mention (new built-in ones, say) keep their place after the ones it does.
 */
export function tabsIn(layout, builtins) {
  const all = [...builtins.map((id) => ({ id, builtin: true })), ...layout.tabs.map((tab) => ({ id: tab.id, builtin: false }))];
  const known = new Map(all.map((tab) => [tab.id, tab]));
  const ordered = layout.order.filter((id) => known.has(id)).map((id) => known.get(id));
  const rest = all.filter((tab) => !layout.order.includes(tab.id));
  // A tab left out of the order goes after the last listed tab that came before it among the built-ins.
  const out = [...ordered];
  for (const tab of rest) {
    const at = all.indexOf(tab);
    const before = all.slice(0, at).reverse().find((p) => out.includes(p));
    out.splice(before ? out.indexOf(before) + 1 : 0, 0, tab);
  }
  return out.map((tab) => ({
    ...tab,
    name: tab.builtin ? layout.names[tab.id] || builtinTabLabel(tab.id) : layout.tabs.find((c) => c.id === tab.id).name,
    hidden: layout.hidden.includes(tab.id),
    renamed: tab.builtin && !!layout.names[tab.id],
  }));
}

const fresh = (prefix, taken) => {
  for (let i = 1; ; i++) {
    const id = `${prefix}-${Date.now().toString(36)}${i}`;
    if (!taken.has(id)) return id;
  }
};
const allIds = (layout) => new Set([...layout.tabs.map((tab) => tab.id), ...Object.values(layout.groups).flat().map((g) => g.id)]);

/** A new tab of the person's own, after `afterId` (or at the end), with one empty group in it. */
export function addTab(layout, builtins, name = newTabName(), afterId = null) {
  const id = fresh('custom', allIds(layout));
  const group = { id: fresh('group', new Set([...allIds(layout), id])), name: newGroupName(), commands: [] };
  const order = tabsIn(layout, builtins).map((tab) => tab.id);
  const at = afterId && order.includes(afterId) ? order.indexOf(afterId) + 1 : order.length;
  order.splice(at, 0, id);
  return { ...layout, order, tabs: [...layout.tabs, { id, name: cleanName(name, newTabName()) }], groups: { ...layout.groups, [id]: [group] }, created: { tab: id, group: group.id } };
}

/** A new empty group at the end of a tab. */
export function addGroup(layout, tabId, name = newGroupName()) {
  const id = fresh('group', allIds(layout));
  const list = [...(layout.groups[tabId] || []), { id, name: cleanName(name, newGroupName()), commands: [] }];
  return { ...layout, groups: { ...layout.groups, [tabId]: list }, created: { group: id } };
}

/**
 * Rename a tab (built-in or own) or a group of the person's own. A built-in tab given its own name again (its id, or
 * the name it shows in the interface language) loses the rename.
 */
export function rename(layout, id, name) {
  if (layout.tabs.some((tab) => tab.id === id)) return { ...layout, tabs: layout.tabs.map((tab) => (tab.id === id ? { ...tab, name: cleanName(name, tab.name) } : tab)) };
  const groups = mapGroups(layout, (g) => (g.id === id ? { ...g, name: cleanName(name, g.name) } : g));
  if (groups) return { ...layout, groups };
  const names = { ...layout.names };
  if (!name || !name.trim() || name.trim() === id || name.trim() === builtinTabLabel(id)) delete names[id]; else names[id] = cleanName(name, id);
  return { ...layout, names };
}

function mapGroups(layout, fn) {
  let hit = false;
  const groups = {};
  for (const [tab, list] of Object.entries(layout.groups)) groups[tab] = list.map((g) => { const next = fn(g, tab); if (next !== g) hit = true; return next; });
  return hit ? groups : null;
}

/** Find a group of the person's own: { tab, group, index }. */
export function findGroup(layout, groupId) {
  for (const [tab, list] of Object.entries(layout.groups)) {
    const index = list.findIndex((g) => g.id === groupId);
    if (index >= 0) return { tab, group: list[index], index };
  }
  return null;
}

/** Show or hide a tab. */
export function setTabHidden(layout, tabId, hidden) {
  const set = new Set(layout.hidden);
  if (hidden) set.add(tabId); else set.delete(tabId);
  return { ...layout, hidden: [...set] };
}

/** Move a tab one place along (-1 earlier, +1 later) among the tabs shown in the list. */
export function moveTab(layout, builtins, tabId, step) {
  const order = tabsIn(layout, builtins).map((tab) => tab.id);
  const at = order.indexOf(tabId);
  const to = at + step;
  if (at < 0 || to < 0 || to >= order.length) return layout;
  order.splice(at, 1);
  order.splice(to, 0, tabId);
  return { ...layout, order };
}

/** Move a group one place along its tab. */
export function moveGroup(layout, groupId, step) {
  const found = findGroup(layout, groupId);
  if (!found) return layout;
  const list = [...layout.groups[found.tab]];
  const to = found.index + step;
  if (to < 0 || to >= list.length) return layout;
  list.splice(found.index, 1);
  list.splice(to, 0, found.group);
  return { ...layout, groups: { ...layout.groups, [found.tab]: list } };
}

/** Add a command to a group (at the end); a command already there stays where it is. */
export function addCommand(layout, groupId, commandId) {
  const groups = mapGroups(layout, (g) => (g.id === groupId && !g.commands.includes(commandId) ? { ...g, commands: [...g.commands, commandId].slice(0, 60) } : g));
  return groups ? { ...layout, groups } : layout;
}

/** Take a command out of a group. */
export function removeCommand(layout, groupId, commandId) {
  const groups = mapGroups(layout, (g) => (g.id === groupId && g.commands.includes(commandId) ? { ...g, commands: g.commands.filter((c) => c !== commandId) } : g));
  return groups ? { ...layout, groups } : layout;
}

/** Move a command one place along its group. */
export function moveCommand(layout, groupId, commandId, step) {
  const groups = mapGroups(layout, (g) => {
    if (g.id !== groupId) return g;
    const at = g.commands.indexOf(commandId), to = at + step;
    if (at < 0 || to < 0 || to >= g.commands.length) return g;
    const commands = [...g.commands];
    commands.splice(at, 1);
    commands.splice(to, 0, commandId);
    return { ...g, commands };
  });
  return groups ? { ...layout, groups } : layout;
}

/** Remove a tab of the person's own (with its groups) or a group of their own. Built-in tabs cannot be removed, only hidden. */
export function removeItem(layout, id) {
  if (layout.tabs.some((tab) => tab.id === id)) {
    const groups = { ...layout.groups };
    delete groups[id];
    return { ...layout, tabs: layout.tabs.filter((tab) => tab.id !== id), order: layout.order.filter((tab) => tab !== id), hidden: layout.hidden.filter((tab) => tab !== id), groups };
  }
  const found = findGroup(layout, id);
  if (!found) return layout;
  const list = layout.groups[found.tab].filter((g) => g.id !== id);
  const groups = { ...layout.groups };
  if (list.length) groups[found.tab] = list; else delete groups[found.tab];
  return { ...layout, groups };
}

/** Whether a layout changes nothing. */
export const isDefaultLayout = (layout) => !layout.order.length && !layout.hidden.length && !Object.keys(layout.names).length && !layout.tabs.length && !Object.keys(layout.groups).length;
