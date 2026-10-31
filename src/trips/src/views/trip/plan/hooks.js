/**
 * Extension points for time-aware scheduling. Each hook is optional and gets `{space, plan}` in `context`.
 * - `annotate({entry, rows, context})` → `Map<rowKey, info>` for one day (arrival, departure, warnings…), computed once per render.
 * - `rowDetail({row, info, entry, context})` → a Node shown under a row (dwell, late warning).
 * - `connector({from, to, mode, info, entry, context})` → a Node with travel time and distance between two stops.
 * - `connectorAction` (same input) → a Node after the connector (transit options).
 * - `visitFields({visit, context})` → `{nodes: Node[], read() → {set, unset}}` extra fields in the visit form (dwell, pinned).
 * - `dayActions({entry, context})` → menu items `{label, icon?, onSelect}` for a day (auto schedule).
 * - `dayHeader`, `dayInfo`, `dayChip`, `dayPanel` (`{entry, context}`) → a Node in the day header, under it, in the day's
 *   rail chip, and at the end of the day panel (weather and holidays).
 * Several modules may register the same hook: lists and visit fields are joined, nodes shown in registration order,
 * and `annotate` comes from the first module that answers.
 * Call `refreshPlanHooks()` when results change without a store change, or `refreshPlanHooks(dayIds)` when only some
 * days changed (a day's route finished loading).
 */
const registrations = [];
const listeners = new Set();
/** The combined hooks by name. */
export const planHooks = {};

function results(name, input) {
  const out = [];
  for (const entry of registrations) {
    if (typeof entry[name] !== 'function') continue;
    try { const value = entry[name](input); if (value != null && value !== false) out.push(value); } catch { /* one failing module must not break the planner */ }
  }
  return out;
}

function combine(name, input) {
  const found = results(name, input);
  if (found.length <= 1) return found[0] ?? null;
  if (name === 'annotate') return found[0];
  if (found.every(Array.isArray)) return found.flat();
  if (name === 'visitFields') {
    return {
      nodes: found.flatMap((item) => item.nodes ?? []),
      read: () => found.reduce((all, item) => {
        const value = item.read?.() ?? {};
        return { set: { ...all.set, ...(value.set ?? {}) }, unset: [...all.unset, ...(value.unset ?? [])] };
      }, { set: {}, unset: [] }),
    };
  }
  const fragment = document.createDocumentFragment();
  fragment.append(...found);
  return fragment;
}

function changed() {
  for (const key of Object.keys(planHooks)) delete planHooks[key];
  for (const name of new Set(registrations.flatMap((entry) => Object.keys(entry)))) planHooks[name] = (input) => combine(name, input);
  for (const listener of listeners) listener();
}

export function registerPlanHooks(next) {
  const entry = { ...next };
  registrations.push(entry);
  changed();
  return () => {
    const index = registrations.indexOf(entry);
    if (index !== -1) registrations.splice(index, 1);
    changed();
  };
}
export function onPlanHooks(listener) { listeners.add(listener); return () => listeners.delete(listener); }
/** Re-renders mounted planners, for hooks whose results changed; `days` limits it to those day ids. */
export function refreshPlanHooks(days) { for (const listener of listeners) listener(days ? new Set(days) : undefined); }

export function callHook(name, input) {
  try { return combine(name, input); } catch { return null; }
}
