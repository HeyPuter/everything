// View settings kept per presentation on this device: the view it was left
// in, the sorter's and notes pages' zoom, and which sections and outline
// slides are collapsed. The most recently used presentations are kept.
const KEY = "presentation:views";
const LIMIT = 50;

function readAll(storage) {
  try {
    const value = JSON.parse(storage.getItem(KEY) || "{}");
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : {};
  } catch {
    return {};
  }
}

export function loadViewSettings(key, storage = globalThis.localStorage) {
  if (!key || !storage) return {};
  const entry = readAll(storage)[key];
  return entry && typeof entry === "object" ? { ...entry } : {};
}

export function saveViewSettings(
  key,
  patch,
  storage = globalThis.localStorage,
  now = Date.now(),
) {
  if (!key || !storage) return;
  const all = readAll(storage);
  all[key] = { ...(all[key] || {}), ...patch, used: now };
  const keys = Object.keys(all).sort(
    (a, b) => (all[b].used || 0) - (all[a].used || 0),
  );
  for (const old of keys.slice(LIMIT)) delete all[old];
  try {
    storage.setItem(KEY, JSON.stringify(all));
  } catch {}
}

// The editor's view for a file's recorded last view, when nothing was kept
// on this device.
export function viewFromFile(lastView) {
  return (
    {
      outlineView: "outline",
      sldSorterView: "sorter",
      notesView: "notesPage",
    }[lastView] || null
  );
}
