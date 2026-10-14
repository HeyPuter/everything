export const STATS_VERSION = 1;

const STATS_KEY = 'solitaire.stats.v1';
const SAVE_KEY = 'solitaire.save.v1';
const MODE_KEY = 'solitaire.mode';

// The top-level played/won/bestMoves are Klondike draw-one: the only game
// before the game menu existed, and the only counters an older build of
// this app reads, merges, and pushes back. Every other game keeps the same
// three counters under modes[key]. An older build's push drops `modes` and
// `vegas` from the cloud copy, but the next merge on a newer build takes the
// max of each counter against its local copy, so nothing is lost for good.
export const LEGACY_MODE = 'klondike-1';

export function emptyStats() {
  return {
    v: STATS_VERSION, played: 0, won: 0, bestMoves: null, ts: 0,
    modes: {},
    vegas: { devices: {}, settled: [] },
  };
}

function minDefined(a, b) {
  const vals = [a, b].filter(v => typeof v === 'number' && Number.isFinite(v));
  return vals.length ? Math.min(...vals) : null;
}

function mergeCounters(a, b) {
  return {
    played: Math.max(a?.played || 0, b?.played || 0),
    won: Math.max(a?.won || 0, b?.won || 0),
    bestMoves: minDefined(a?.bestMoves, b?.bestMoves),
  };
}

// The Vegas bank goes down as well as up, so max/min merging cannot work,
// and a single "latest wins" total would let one device's write erase
// games another device settled. Instead each device keeps its own running
// total, written only by that device, and the bank is their sum; a merge
// keeps the newer entry per device. `settled` lists the ids of the most
// recent games already paid in, from any device, so a game that comes back
// (a cloud save, an undo after a win, a reload) is never paid in twice.
export const SETTLED_KEEP = 100;

function mergeVegas(a, b) {
  const devices = { ...(a?.vegas?.devices || {}) };
  for (const [id, entry] of Object.entries(b?.vegas?.devices || {})) {
    if (!devices[id] || (entry?.ts || 0) > (devices[id]?.ts || 0)) devices[id] = entry;
  }
  const settled = [...new Set([...(a?.vegas?.settled || []), ...(b?.vegas?.settled || [])])];
  return { devices, settled: settled.slice(-SETTLED_KEEP) };
}

export function mergeStats(a, b) {
  const keys = new Set([...Object.keys(a?.modes || {}), ...Object.keys(b?.modes || {})]);
  const modes = {};
  for (const k of keys) modes[k] = mergeCounters(a?.modes?.[k], b?.modes?.[k]);
  return {
    v: STATS_VERSION,
    ...mergeCounters(a, b),
    ts: Math.max(a?.ts || 0, b?.ts || 0),
    modes,
    vegas: mergeVegas(a, b),
  };
}

export function modeStats(stats, mode = LEGACY_MODE) {
  const src = mode === LEGACY_MODE ? stats : stats?.modes?.[mode];
  return mergeCounters(src, null);
}

function withModeStats(stats, mode, counters, now) {
  const next = mode === LEGACY_MODE
    ? { ...stats, ...counters }
    : { ...stats, modes: { ...(stats.modes || {}), [mode]: counters } };
  return { ...next, v: STATS_VERSION, ts: now };
}

export function recordGameStarted(stats, now, mode = LEGACY_MODE) {
  const c = modeStats(stats, mode);
  return withModeStats(stats, mode, { ...c, played: c.played + 1 }, now);
}

export function recordGameWon(stats, moves, now, mode = LEGACY_MODE) {
  const c = modeStats(stats, mode);
  return withModeStats(stats, mode, {
    ...c,
    won: c.won + 1,
    bestMoves: minDefined(c.bestMoves, moves),
  }, now);
}

export function vegasBank(stats) {
  return Object.values(stats?.vegas?.devices || {})
    .reduce((sum, d) => sum + (Number(d?.bank) || 0), 0);
}

export function isVegasSettled(stats, gameId) {
  return !!gameId && (stats?.vegas?.settled || []).includes(gameId);
}

// Adds a finished (won or abandoned) Vegas game's score to this device's
// share of the bank, once per game id.
export function recordVegasResult(stats, { gameId, score, deviceId, now }) {
  if (isVegasSettled(stats, gameId)) return stats;
  const devices = stats?.vegas?.devices || {};
  const mine = Number(devices[deviceId]?.bank) || 0;
  return {
    ...stats,
    v: STATS_VERSION,
    vegas: {
      devices: { ...devices, [deviceId]: { bank: mine + score, ts: now } },
      settled: [...(stats?.vegas?.settled || []), gameId].slice(-SETTLED_KEEP),
    },
    ts: now,
  };
}

function readJSON(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private browsing or a full quota. Losing stats is not worth an exception.
  }
}

export function loadLocalStats() {
  const parsed = readJSON(STATS_KEY);
  if (!parsed || parsed.v !== STATS_VERSION) return emptyStats();
  return mergeStats(emptyStats(), parsed);
}

export function saveLocalStats(stats) {
  writeJSON(STATS_KEY, stats);
}

export function loadLocalSave() {
  return readJSON(SAVE_KEY);
}

export function saveLocalSave(save) {
  writeJSON(SAVE_KEY, save);
}

export function clearLocalSave() {
  try {
    localStorage.removeItem(SAVE_KEY);
  } catch {
    // Ignore.
  }
}

// A random id for this browser's share of the Vegas bank (see mergeVegas).
// If storage is unavailable it lasts for the page's lifetime, which is all
// that storage-less stats last for anyway.
const DEVICE_KEY = 'solitaire.device';
export function deviceId() {
  let id = readJSON(DEVICE_KEY);
  if (typeof id !== 'string' || !id) {
    id = Math.random().toString(36).slice(2, 12);
    writeJSON(DEVICE_KEY, id);
  }
  return id;
}

// The game the menu last picked, so a fresh deal after a reload (or after a
// win) is the same game. A saved game in progress carries its own mode and
// wins over this.
export function loadModePref() {
  const v = readJSON(MODE_KEY);
  return typeof v === 'string' ? v : null;
}

export function saveModePref(key) {
  writeJSON(MODE_KEY, key);
}
