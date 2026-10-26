// The new owner's side of an ownership transfer as a resumable state machine. Each step is idempotent and the journal
// is saved after every unit of work, so a failure at any point resumes from there without losing or duplicating data:
// deploy → accept (freezes the source) → export → create → import → files → seats → complete → index → done.
import { newId } from '../../shared/ids.js';
import { TransferError, copyMeta, fileParts, importParts, readTransferExport, seatsFor } from './export.js';

export const STEPS = Object.freeze(['deploy', 'accept', 'export', 'create', 'import', 'files', 'seats', 'complete', 'index', 'done']);
const NEEDS_DATA = new Set(['create', 'import', 'files', 'seats', 'complete']);
const CANCELLED = new Set(['transfer_cancelled', 'no_offer', 'offer_expired']);
const STALE_ATTEMPTS = 3;
const SETTLE_ATTEMPTS = 6;
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** A fresh journal entry for accepting `from` (`{w, s, k}`); `chosen` lists the members to re-invite (null = all). */
export function transferEntry({ from, title = '', chosen = null, now = Date.now() }) {
  return {
    v: 1, from: { w: from.w, s: from.s, k: from.k }, to: null, step: 'deploy', started: now, at: now, title, chosen,
    settleAt: 0, rev: null, meta: null, imported: {}, files: {}, fileTotal: 0, invalid: 0, attempts: 0, movedTo: null, sourceGone: false, error: null,
  };
}

/** Errors that sending the same request again will not fix. */
export const isDefinite = (error) => typeof error?.status === 'number' && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status);
const transient = (error) => !isDefinite(error) && !(error?.status === 429) && error?.name !== 'TransferError';

async function locked(id, task) {
  const locks = globalThis.navigator?.locks;
  if (!locks?.request) return task();
  return locks.request(`trips:transfer:${id}`, { ifAvailable: true }, (lock) => {
    if (!lock) throw new TransferError('busy');
    return task();
  });
}

class Cancelled extends Error {}

/**
 * Runs or resumes a transfer. `deps`:
 * - `journal` (`transferJournal`), `uid` (the new owner);
 * - `ensureWorker()` → this account's worker name;
 * - `call(worker, op, input)` → the worker's answer (input carries `space`);
 * - `exportSpace()` → the parsed `transfer.export` body;
 * - `copyFile(file, entry)` → `'copied'` or `'missing'` (the source has no bytes for it);
 * - `index(entry)` puts the new trip in `me:spaces` and drops the old one;
 * - `removeCopy(entry)` deletes the copy after the owner cancelled;
 * - optional `wait(ms)`, `now()`, `makeId()`, `onProgress(entry)`.
 * Resolves to `{status: 'done', entry}` or `{status: 'cancelled', entry}`; rejects with a `TransferError` carrying
 * `step`, `definite` and `retryAfter`, after recording it in the journal.
 */
export function runTransfer(start, deps) {
  return locked(start.from.s, async () => {
    const { journal, call, wait = sleep, now = Date.now, makeId = newId, onProgress = () => {} } = deps;
    const space = start.from.s;
    let entry = { ...start, error: null, attempts: 0 };
    let data = null;
    const save = async (patch) => { entry = { ...entry, ...patch, at: now() }; await journal.put(entry); onProgress(entry); };
    const from = () => ({ w: entry.from.w, s: space });

    async function guarded(code, task) {
      for (let attempt = 0; ; attempt++) {
        try { return await task(); } catch (error) {
          if (error instanceof Cancelled || error instanceof TransferError) throw error;
          if (CANCELLED.has(error?.code)) throw new Cancelled(error.code);
          if (transient(error) && attempt < 2) { await wait(1000 * 3 ** attempt); continue; }
          const definite = isDefinite(error);
          await save({ error: { code: error?.code ?? code, step: entry.step, at: now(), definite, ...(error?.retryAfter ? { retryAfter: error.retryAfter } : {}) } });
          throw new TransferError(code, { step: entry.step, definite, retryAfter: error?.retryAfter, reason: error?.code ?? null, cause: error });
        }
      }
    }
    async function loadData() {
      for (let attempt = 0; ; attempt++) {
        try { data = readTransferExport(await deps.exportSpace(), { space, kind: entry.from.k }); return; } catch (error) {
          if (error?.code === 'transfer_settling' && attempt < SETTLE_ATTEMPTS) { await wait(Math.max(1, error.retryAfter ?? 6) * 1000); continue; }
          throw error;
        }
      }
    }
    const importCall = (input) => call(entry.to.w, 'transfer.import', { space, from: from(), ...input });

    onProgress(entry);
    try {
      while (entry.step !== 'done') {
        if (NEEDS_DATA.has(entry.step) && !data) await guarded('export_failed', loadData);
        switch (entry.step) {
          case 'deploy': {
            const worker = await guarded('deploy_failed', () => deps.ensureWorker());
            await save({ to: { w: worker, s: space, k: entry.from.k }, step: 'accept', error: null });
            break;
          }
          case 'accept': {
            const result = await guarded('accept_failed', () => call(entry.from.w, 'transfer.accept', { space, worker: entry.to.w }));
            await save({ settleAt: Number(result?.settleAt) || 0, step: 'export', error: null });
            break;
          }
          case 'export': {
            if (!data) await guarded('export_failed', loadData);
            const { title, start: first, end } = data.meta;
            await save({ rev: data.rev, invalid: data.invalid, fileTotal: data.files.length, meta: { title, start: first ?? null, end: end ?? null }, step: 'create', error: null });
            break;
          }
          case 'create':
            await guarded('create_failed', () => importCall({ create: { kind: entry.from.k, meta: copyMeta(data.meta) } }));
            await save({ step: 'import', error: null });
            break;
          case 'import':
            for (const part of importParts(data, entry.imported)) {
              const id = makeId();
              await guarded('import_failed', () => importCall({
                part: id, ents: part.ents, del: part.del, ...(part.authors ? { authors: part.authors } : {}), ...(part.pollvoted ? { pollvoted: part.pollvoted } : {}),
              }));
              await save({ imported: { ...entry.imported, ...part.keys } });
            }
            await save({ step: 'files', rev: data.rev, error: null });
            break;
          case 'files':
            for (const file of data.files) {
              if (entry.files[file.id]) continue;
              const result = await guarded('file_failed', () => deps.copyFile(file, entry));
              await save({ files: { ...entry.files, [file.id]: result === 'missing' ? 'missing' : 'copied' } });
            }
            for (const files of fileParts(data.files, entry.files)) {
              const id = makeId();
              await guarded('import_failed', () => importCall({ part: id, files }));
            }
            await save({ step: 'seats', error: null });
            break;
          case 'seats':
            await guarded('seats_failed', () => importCall({ seats: seatsFor(data.members, deps.uid, entry.chosen) }));
            await save({ step: 'complete', error: null });
            break;
          case 'complete': {
            let result = null;
            try {
              result = await guarded('complete_failed', () => call(entry.from.w, 'transfer.complete', { space, to: { w: entry.to.w, s: space }, rev: data.rev }));
            } catch (error) {
              const reason = error?.reason;
              // Something was written after the export: export again and import the difference.
              if (reason === 'transfer_stale' && entry.attempts < STALE_ATTEMPTS) { data = null; await save({ attempts: entry.attempts + 1, step: 'export', error: null }); break; }
              // The old owner deleted the trip after the copy was made: keep the copy.
              if (reason === 'space_not_found') { await save({ sourceGone: true, step: 'index', error: null }); break; }
              throw error;
            }
            await save({ movedTo: result?.movedTo ?? null, step: 'index', error: null });
            break;
          }
          case 'index':
            await guarded('index_failed', () => deps.index(entry));
            await save({ step: 'done', error: null });
            break;
          default:
            throw new TransferError('invalid_journal');
        }
      }
    } catch (error) {
      if (!(error instanceof Cancelled)) throw error;
      // The owner withdrew the offer or stopped the move: drop the copy, which nobody else can see yet.
      if (entry.to && STEPS.indexOf(entry.step) > STEPS.indexOf('export')) await Promise.resolve(deps.removeCopy?.(entry)).catch(() => {});
      await journal.remove();
      return { status: 'cancelled', entry, reason: error.message };
    }
    await journal.remove();
    return { status: 'done', entry };
  });
}

/**
 * The new owner stops a transfer: the source is unfrozen first, then the copy (if any) is deleted. Refuses with
 * `already_moved` once the move has completed.
 */
export async function cancelTransfer(entry, { journal, call, removeCopy }) {
  try {
    await call(entry.from.w, 'transfer.cancel', { space: entry.from.s });
  } catch (error) {
    if (error?.code === 'space_moved') throw new TransferError('already_moved', { cause: error });
    if (!isDefinite(error)) throw new TransferError('cancel_failed', { cause: error, definite: false });
  }
  if (entry.to && STEPS.indexOf(entry.step) > STEPS.indexOf('export')) await Promise.resolve(removeCopy?.(entry)).catch(() => {});
  await journal.remove();
}
