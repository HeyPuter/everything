/**
 * Loaded color lookup tables, shared by every compositor on the page (the
 * player, the exporter and previews). The .cube files live in the library
 * (library.importLut / readLut); clips refer to them by id through
 * clip.grade.lut. ensureLuts() loads whatever a project uses before a
 * frame is rendered; a LUT that is not loaded yet simply renders as off.
 */
import { lutVolume, parseCube, CubeError } from '../model/cube.js';

const loaded = new Map(); // id -> { id, name, size, data, domainMin, domainMax, version }
const pending = new Map(); // id -> Promise
const failed = new Set(); // missing or unreadable files
const retry = new Map(); // id -> { n, at }: reads that failed (a network error), tried again from `at`
const listeners = new Set();
let version = 0;

/** The GPU-ready LUT for an id, or null. */
export function getLut(id) {
  return loaded.get(id) || null;
}

/** Register a parsed .cube table under id. Returns the entry. */
export function putLut(id, parsed, name = '') {
  const vol = lutVolume(parsed);
  const entry = { id, name: name || parsed.title || 'LUT', size: vol.size, data: vol.data, domainMin: parsed.domainMin, domainMax: parsed.domainMax, version: ++version };
  loaded.set(id, entry);
  failed.delete(id);
  retry.delete(id);
  listeners.forEach((fn) => fn(id));
  return entry;
}

export function dropLut(id) {
  loaded.delete(id);
}

/** Called with the id whenever a LUT becomes available. Returns an unsubscribe function. */
export function onLutLoaded(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Ids of every LUT the project's clips use. */
export function lutIdsIn(project) {
  const ids = new Set();
  for (const t of project?.tracks || []) for (const c of t.clips) if (c.grade?.lut?.id) ids.add(c.grade.lut.id);
  return ids;
}

/** Load one LUT from the library (once). Resolves to the entry, or null when it cannot be read. */
export function loadLut(id, library) {
  if (loaded.has(id)) return Promise.resolve(loaded.get(id));
  if (failed.has(id) || !retryDue(id) || !library?.readLut) return Promise.resolve(null);
  let p = pending.get(id);
  if (!p) {
    p = (async () => {
      try {
        const { text, name } = await library.readLut(id);
        return putLut(id, parseCube(text), name);
      } catch (err) {
        console.warn(`LUT ${id} could not be loaded`, err);
        if (err instanceof CubeError || /missing/i.test(err?.message || '')) failed.add(id);
        else {
          // Most likely the network: try again on a later frame or export, after a growing pause.
          const n = (retry.get(id)?.n || 0) + 1;
          retry.set(id, { n, at: Date.now() + Math.min(60_000, 2000 * 2 ** (n - 1)) });
        }
        return null;
      } finally {
        pending.delete(id);
      }
    })();
    pending.set(id, p);
  }
  return p;
}

/** Load every LUT the project uses. Resolves to true when something new was loaded. */
export async function ensureLuts(project, library) {
  const missing = [...lutIdsIn(project)].filter((id) => !loaded.has(id) && !failed.has(id) && retryDue(id));
  if (!missing.length) return false;
  const got = await Promise.all(missing.map((id) => loadLut(id, library)));
  return got.some(Boolean);
}

function retryDue(id) {
  const r = retry.get(id);
  return !r || Date.now() >= r.at;
}

/** Whether a LUT id is known to be unreadable (missing file). */
export function lutFailed(id) {
  return failed.has(id);
}
