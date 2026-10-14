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
    vegas: { bank: 0, ts: 0 },
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

// The Vegas bank goes down as well as up, so max/min merging cannot work;
// whichever side changed it last wins. Two devices settling different games
// while offline from each other keep only the later device's total.
function mergeVegas(a, b) {
  const va = a?.vegas;
  const vb = b?.vegas;
  const pick = (vb?.ts || 0) > (va?.ts || 0) ? vb : va;
  return { bank: Number(pick?.bank) || 0, ts: pick?.ts || 0 };
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
  return Number(stats?.vegas?.bank) || 0;
}

// Adds a finished (won or abandoned) Vegas game's score to the bank.
export function recordVegasResult(stats, score, now) {
  return {
    ...stats,
    v: STATS_VERSION,
    vegas: { bank: vegasBank(stats) + score, ts: now },
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
