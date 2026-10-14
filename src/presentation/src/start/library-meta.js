// What this device remembers about the presentations in the library, per
// account: which are pinned to the top of the list, and when each was last
// opened here. Kept in localStorage; a presentation is known by where it
// lives, or by its recovery draft's id.

const KEY = "presentation.library.v1";

function readAll() {
  try {
    const data = JSON.parse(globalThis.localStorage?.getItem(KEY) || "null");
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}
function writeAll(data) {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(data));
  } catch {}
}
/** A listed presentation's key: where it lives, or its draft's id. */
export const libraryKey = (f) => String(f?.path || f?.id || "");
const MAX_OPENED = 300;

/** What this device remembers about `owner`'s presentations. */
export function libraryMeta(owner) {
  const load = () => {
    const all = readAll();
    const mine = all[owner] || {};
    return {
      all,
      mine: {
        pins: Array.isArray(mine.pins)
          ? mine.pins.filter((k) => typeof k === "string")
          : [],
        opened:
          mine.opened && typeof mine.opened === "object" ? mine.opened : {},
      },
    };
  };
  const save = (all, mine) => {
    all[owner] = mine;
    writeAll(all);
  };
  return {
    isPinned(f) {
      return load().mine.pins.includes(libraryKey(f));
    },
    /** Pins or unpins; resolves to whether it is now pinned. */
    togglePin(f) {
      const key = libraryKey(f);
      if (!key) return false;
      const { all, mine } = load();
      const pinned = mine.pins.includes(key);
      mine.pins = pinned
        ? mine.pins.filter((k) => k !== key)
        : [key, ...mine.pins];
      save(all, mine);
      return !pinned;
    },
    /** When the presentation was last opened here (ms), or null. */
    openedAt(f) {
      const v = Number(load().mine.opened[libraryKey(f)]);
      return Number.isFinite(v) && v > 0 ? v : null;
    },
    noteOpened(f, at = Date.now()) {
      const key = libraryKey(f);
      if (!key) return;
      const { all, mine } = load();
      mine.opened[key] = at;
      const keys = Object.keys(mine.opened);
      if (keys.length > MAX_OPENED)
        for (const k of keys
          .sort((a, b) => mine.opened[a] - mine.opened[b])
          .slice(0, keys.length - MAX_OPENED))
          delete mine.opened[k];
      save(all, mine);
    },
    /** A presentation moved or was renamed: its record follows it. */
    rename(from, to) {
      const a = libraryKey(from),
        b = libraryKey(to);
      if (!a || !b || a === b) return;
      const { all, mine } = load();
      mine.pins = mine.pins.map((k) => (k === a ? b : k));
      if (mine.opened[a]) {
        mine.opened[b] = mine.opened[a];
        delete mine.opened[a];
      }
      save(all, mine);
    },
    forget(f) {
      const key = libraryKey(f);
      const { all, mine } = load();
      mine.pins = mine.pins.filter((k) => k !== key);
      delete mine.opened[key];
      save(all, mine);
    },
  };
}
