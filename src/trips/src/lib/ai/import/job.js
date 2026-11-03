// The import job of a trip: runs in the page across navigation, keeps its state in IndexedDB, commits after review.
// `spaceId` is the job's key: any string unique per account and trip.
import { resIssues, resPatch } from '../../res/index.js';
import { checkCandidate } from './checks.js';
import { fillMissing, markDuplicates, mergeDrafts } from './dedupe.js';
import { ExtractError, aiErrorCode, extractItems } from './extract.js';
import { candidateFromItem, finalize } from './schema.js';
import { readInput, sourceHash } from './sources.js';

const jobs = new Map();
const listeners = new Map();
const running = new Map();
const saves = new Map();
const STAMPS = new Set(['id', 'v', 'rev', 'upd', 'by', 'cr', 't', 'deleted']);
const strip = (entity) => Object.fromEntries(Object.entries(entity).filter(([key]) => !STAMPS.has(key)));
const storeKey = (spaceId) => `import:${spaceId}`;
const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (byte) => byte.toString(16).padStart(2, '0')).join('');

export const getJob = (spaceId) => jobs.get(spaceId) ?? null;

/** Calls `fn(job|null)` whenever the trip's import job changes. Returns an unsubscribe function. */
export function onJob(spaceId, fn) {
  if (!listeners.has(spaceId)) listeners.set(spaceId, new Set());
  listeners.get(spaceId).add(fn);
  return () => listeners.get(spaceId)?.delete(fn);
}

function emit(spaceId) {
  const job = getJob(spaceId);
  for (const fn of [...(listeners.get(spaceId) ?? [])]) { try { fn(job); } catch { /* A listener must not stop the job. */ } }
}

async function persist(db, spaceId) {
  if (!db) return;
  const job = getJob(spaceId);
  if (!job) { await db.remove(storeKey(spaceId)).catch(() => {}); return; }
  try { await db.put(storeKey(spaceId), job); }
  catch {
    // Some stores cannot keep Blobs; keep the job without its attachments.
    const light = { ...job, sources: job.sources.map(({ attach, ...source }) => ({ ...source, attach: [] })) };
    await db.put(storeKey(spaceId), light).catch(() => {});
  }
}

function schedule(db, spaceId) {
  clearTimeout(saves.get(spaceId));
  saves.set(spaceId, setTimeout(() => { saves.delete(spaceId); void persist(db, spaceId); }, 250));
}

function set(spaceId, job, { db, now = false } = {}) {
  if (job) jobs.set(spaceId, job); else jobs.delete(spaceId);
  emit(spaceId);
  if (now) { clearTimeout(saves.get(spaceId)); saves.delete(spaceId); void persist(db, spaceId); } else schedule(db, spaceId);
  return job;
}

function patchSource(spaceId, sourceId, patch, options) {
  const job = getJob(spaceId);
  if (!job) return null;
  return set(spaceId, { ...job, sources: job.sources.map((source) => (source.id === sourceId ? { ...source, ...patch } : source)) }, options);
}

/**
 * Loads a job saved by an earlier page. A job that was running when the page closed comes back as `review` with
 * its unfinished inputs marked `interrupted` (or as `failed` when nothing was found yet).
 */
export async function restoreJob({ db, spaceId }) {
  if (jobs.has(spaceId) || !db) return getJob(spaceId);
  let saved;
  try { saved = await db.get(storeKey(spaceId)); } catch { return null; }
  if (!saved || saved.v !== 1 || jobs.has(spaceId)) return getJob(spaceId);
  let job = saved;
  if (job.status === 'running') {
    const sources = job.sources.map((source) => (['pending', 'reading'].includes(source.state) ? { ...source, state: 'interrupted' } : source));
    job = { ...job, sources, status: job.candidates.length ? 'review' : 'failed', error: job.candidates.length ? job.error : 'interrupted' };
  }
  jobs.set(spaceId, job);
  emit(spaceId);
  return job;
}

/**
 * Starts reading `inputs` for a trip. Each input is `{type: 'file'|'paste'|'mail', label, ...}` (see `readInput`);
 * an optional `load()` resolves the rest of the input (`{file}` or `{message}`) when its turn comes.
 * `context` gives `people` ([{id, name}]), `trip` ({title, start, end}), `days`, `reservations()` (current list),
 * `services` ({airports, tz}), `model`, `fallbackTitle(type)`, `label(key)` and `testMode`. Inputs run one at a
 * time; a 402 stops the job. Resolves when the job reaches review.
 */
export function startJob({ spaceId, db, puter, inputs, context = {} }) {
  if (running.has(spaceId)) throw new Error('job_running');
  const sources = inputs.map((input, index) => ({ id: `s${index + 1}`, label: String(input.label ?? '').slice(0, 300), type: input.type, state: 'pending', error: null, count: 0, notes: [], attach: [] }));
  // Saved at once, so a reload right after starting still finds the job (and marks it interrupted).
  set(spaceId, { v: 1, id: randomId(), spaceId, status: 'running', startedAt: Date.now(), sources, candidates: [], error: null }, { db, now: true });
  const control = { cancelled: false };
  running.set(spaceId, control);
  const run = (async () => {
    const cache = new Map();
    const people = context.people ?? [];
    const options = { people, fallbackTitle: context.fallbackTitle, label: context.label };
    for (const [index, input] of inputs.entries()) {
      if (control.cancelled) break;
      const source = sources[index];
      patchSource(spaceId, source.id, { state: 'reading' }, { db });
      let resolved = input;
      if (typeof input.load === 'function') {
        try { resolved = { ...input, ...(await input.load()) }; }
        catch (error) { patchSource(spaceId, source.id, { state: 'failed', error: error?.code === 'credit' ? 'credit' : 'load_failed' }, { db }); continue; }
      }
      let prepared;
      try { prepared = await readInput(resolved); }
      catch (error) { patchSource(spaceId, source.id, { state: 'failed', error: error?.code ?? 'unreadable' }, { db }); continue; }
      const hash = await sourceHash(resolved).catch(() => undefined);
      const items = prepared.items.map((item) => ({ item, kind: 'pkpass', trusted: true }));
      let error = null;
      if (prepared.text || prepared.files.length) {
        try {
          const extracted = await extractItems(prepared, { puter, model: context.model, trip: context.trip, people: people.map((person) => person.name), testMode: context.testMode });
          items.push(...extracted.map((item) => ({ item, kind: 'ai', trusted: false })));
        } catch (failure) { error = failure instanceof ExtractError ? failure.code : aiErrorCode(failure); }
      }
      const made = [];
      for (const [position, { item, kind, trusted }] of items.entries()) {
        const candidate = candidateFromItem(item, { ...options, kind, hash, trusted });
        const checked = await checkCandidate(candidate, { services: context.services, days: context.days, fallbackTitle: context.fallbackTitle, cache });
        made.push({ id: `${source.id}-${position + 1}`, sourceId: source.id, sourceIds: [source.id], kind, ...checked });
      }
      const job = getJob(spaceId);
      if (!job) return;
      set(spaceId, {
        ...job,
        candidates: [...job.candidates, ...made],
        sources: job.sources.map((entry) => (entry.id === source.id ? {
          ...entry, state: error && !made.length ? 'failed' : 'done', error, count: made.length,
          notes: prepared.failures.map((failure) => ({ name: failure.name, code: failure.code })), attach: made.length ? prepared.attach : [],
        } : entry)),
      }, { db });
      if (error === 'credit' || error === 'unavailable') { control.stopped = error; break; }
    }
    const job = getJob(spaceId);
    if (!job) return;
    const candidates = markDuplicates(job.candidates, context.reservations?.() ?? []);
    const sourcesLeft = job.sources.map((source) => (source.state === 'pending' ? { ...source, state: control.stopped ? 'skipped' : 'cancelled' } : source));
    const failed = !candidates.length && Boolean(control.stopped);
    set(spaceId, { ...job, candidates, sources: sourcesLeft, status: failed ? 'failed' : 'review', error: control.stopped ?? null }, { db });
  })().finally(() => running.delete(spaceId));
  return run;
}

export const isRunning = (spaceId) => running.has(spaceId);

/** Stops after the input being read; what was found so far goes to review. */
export function cancelJob(spaceId) {
  const control = running.get(spaceId);
  if (control) control.cancelled = true;
}

/** Forgets the trip's job (memory and IndexedDB). */
export async function clearJob({ db, spaceId }) {
  cancelJob(spaceId);
  jobs.delete(spaceId);
  clearTimeout(saves.get(spaceId));
  saves.delete(spaceId);
  emit(spaceId);
  if (db) await db.remove(storeKey(spaceId)).catch(() => {});
}

function updateCandidates(spaceId, change, { db, reservations = [] } = {}) {
  const job = getJob(spaceId);
  if (!job) return null;
  return set(spaceId, { ...job, candidates: markDuplicates(change(job.candidates), reservations) }, { db });
}

/** Replaces a candidate's draft with edited fields (normalized and re-checked against the schema). */
export function editCandidate(spaceId, id, fields, options = {}) {
  return updateCandidates(spaceId, (list) => list.map((candidate) => {
    if (candidate.id !== id) return candidate;
    const draft = finalize({ ...fields, src: candidate.draft.src }, { provider: candidate.provider, fallbackTitle: options.fallbackTitle });
    return { ...candidate, draft, issues: resIssues(draft) };
  }), options);
}

/** `create` (new booking), `update` (fill the matching booking), `skip` or `discard`. */
export function setAction(spaceId, id, action, options = {}) {
  return updateCandidates(spaceId, (list) => list.map((candidate) => (candidate.id === id ? { ...candidate, action } : candidate)), options);
}

export function discardCandidate(spaceId, id, options = {}) {
  return updateCandidates(spaceId, (list) => list.filter((candidate) => candidate.id !== id), options);
}

/** Merges candidates of one group into the first of them, in list order. */
export function mergeCandidates(spaceId, ids, options = {}) {
  return updateCandidates(spaceId, (list) => {
    const chosen = list.filter((candidate) => ids.includes(candidate.id));
    if (chosen.length < 2) return list;
    const [first] = chosen;
    const draft = finalize(mergeDrafts(chosen.map((candidate) => candidate.draft)), { provider: first.provider, fallbackTitle: options.fallbackTitle });
    const merged = {
      ...first, id: `${first.id}+${chosen.length - 1}`, draft, issues: resIssues(draft), hints: {}, action: undefined,
      sourceIds: [...new Set(chosen.flatMap((candidate) => candidate.sourceIds ?? [candidate.sourceId]))],
      warnings: chosen.flatMap((candidate) => candidate.warnings ?? []).filter((warning) => warning.leg === undefined),
    };
    return list.flatMap((candidate) => (candidate.id === first.id ? [merged] : ids.includes(candidate.id) ? [] : [candidate]));
  }, options);
}

/** Candidates that will be written: chosen to create or update and free of schema issues. */
export const readyCandidates = (job) => (job?.candidates ?? []).filter((candidate) => ['create', 'update'].includes(candidate.action) && !candidate.issues?.length);

/**
 * Ops for the approved candidates: creates for new bookings and conflict-checked patches that fill matching ones.
 * Returns `{ops, links}` where `links` maps each source id to the reservation ids it produced.
 */
export function importOps(job, space) {
  const ops = [];
  const links = new Map();
  const link = (candidate, resId) => {
    for (const sourceId of candidate.sourceIds ?? [candidate.sourceId]) {
      if (!links.has(sourceId)) links.set(sourceId, []);
      links.get(sourceId).push(resId);
    }
  };
  let created = 0;
  let updated = 0;
  for (const candidate of readyCandidates(job)) {
    const existing = candidate.action === 'update' && candidate.duplicate ? space.get('res', candidate.duplicate.resId) : null;
    if (existing) {
      const patch = resPatch(strip(existing), fillMissing(strip(existing), candidate.draft));
      if (Object.keys(patch.set).length || patch.unset.length) { ops.push(space.ops.patch('res', existing.id, patch, { base: true })); updated += 1; }
      link(candidate, existing.id);
    } else {
      const op = space.ops.create('res', candidate.draft);
      ops.push(op);
      created += 1;
      link(candidate, op.id);
    }
  }
  return { ops, links, created, updated };
}

/**
 * Writes the approved candidates in one batch and clears the job. Then attaches each input's files to the bookings
 * it produced through `upload(file, links)`, when given. Resolves to `{created, updated, attachments}`, where
 * `attachments` resolves to `{attached, failed}` once the uploads settle.
 */
export async function commitJob({ space, spaceId, db, history, upload }) {
  const job = getJob(spaceId);
  if (!job || job.status !== 'review') throw new Error('job_not_ready');
  const { ops, links, created, updated } = importOps(job, space);
  if (ops.length) await space.apply(ops, history ? { history } : {});
  await clearJob({ db, spaceId });
  const attachments = (async () => {
    let attached = 0;
    let failed = 0;
    if (!upload) return { attached, failed };
    for (const source of job.sources) {
      const resIds = links.get(source.id);
      if (!resIds?.length) continue;
      for (const file of source.attach ?? []) {
        try { await upload(file, resIds.map((id) => ({ t: 'res', id }))); attached += 1; } catch { failed += 1; }
      }
    }
    return { attached, failed };
  })();
  return { created, updated, attachments };
}
