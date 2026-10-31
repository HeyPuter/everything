// Running a booking move across two trips (possibly two owners' workers): create the copy in the target, copy files,
// then remove the booking from the source. Each step is idempotent (fixed op ids, files deduplicated by content), and
// a journal in the account's IndexedDB keeps unfinished moves so they can be finished or undone later.
import { DomainError } from '../../../../shared/errors.js';
import { newId } from '../../../../shared/ids.js';
import { refreshPatch } from './plan.js';

const key = (spaceId) => `moves:${spaceId}`;

/** Unfinished moves out of one trip, kept per account: `{v: 1, items: {<id>: entry}}`. */
export function moveJournal(db, spaceId) {
  return {
    async list() {
      const value = await db.get(key(spaceId));
      return Object.values(value?.items ?? {}).sort((a, b) => (a.started ?? 0) - (b.started ?? 0));
    },
    async put(entry) {
      await db.update(key(spaceId), (value) => ({ v: 1, items: { ...(value?.items ?? {}), [entry.id]: entry } }));
    },
    async remove(id) {
      await db.update(key(spaceId), (value) => {
        const items = { ...(value?.items ?? {}) };
        delete items[id];
        return Object.keys(items).length ? { v: 1, items } : undefined;
      });
    },
  };
}

/** A journal entry for a planned move (`plan` from `planMove`). */
export function moveEntry({ plan, from, fromTitle, to, toTitle, title, makeId = newId, now = Date.now() }) {
  return {
    v: 1, id: makeId(), started: now, at: now, stage: 'target',
    from, fromTitle, to, toTitle, title,
    resId: plan.resId, sourceRes: plan.sourceArgs.res,
    target: plan.targetOps,
    created: plan.created,
    files: plan.files, copied: {}, failedFiles: [],
    source: { opId: makeId(), do: 'res.moveToTrip', args: plan.sourceArgs },
    private: plan.privateExps ?? [],
    error: null,
  };
}

export class MoveError extends DomainError {}
const moveError = (code, cause) => Object.assign(new MoveError(code, cause?.status ?? 400), { cause, reason: cause?.code ?? null });

/** Errors that will not go away by sending the same request again. */
export function isDefinite(error) {
  return [400, 403, 404, 409, 413, 422, 426].includes(error?.status);
}
const createdIds = (entry) => new Set(entry.target.filter((op) => op.put).map((op) => `${op.t}:${op.id}`));

async function locked(id, task) {
  const locks = globalThis.navigator?.locks;
  if (!locks?.request) return task();
  return locks.request(`trips:move:${id}`, { ifAvailable: true }, (lock) => {
    if (!lock) throw moveError('busy');
    return task();
  });
}

/**
 * Runs or resumes a move from its stage. `commit(ref, ops)` sends one commit and resolves to the worker's answer;
 * `copyFile(file, entry)` resolves to `{id, duplicate}`; `onStage(stage)` reports progress; `movePrivate(entry)`
 * moves or unlinks the mover's private expenses once the booking has left the source (best effort).
 * Resolves to `{status: 'done', entry, alreadyGone?}`. Rejects with a `MoveError`:
 * - `target_failed`: the target refused the copy; nothing was written and the journal entry is gone;
 * - `target_pending`: the target could not be reached; whether the copy exists is unknown, so retry or undo;
 * - `source_pending` / `source_failed`: the copy exists but the booking is still in the source (retry, undo or keep both);
 * - `copy_gone`: the copy was deleted in the target meanwhile, so the source keeps the booking;
 * - `busy`: another tab is running this move.
 */
export function runMove(entry, { journal, commit, copyFile, movePrivate = async () => {}, onStage = () => {}, makeId = newId, now = Date.now }) {
  return locked(entry.id, async () => {
    let current = { ...entry };
    const settlePrivate = async () => { if (current.private?.length) await movePrivate(current).catch(() => {}); };
    const save = async (patch) => { current = { ...current, ...patch, at: now() }; await journal.put(current); };
    if (current.stage === 'target') {
      onStage('target');
      try { await commit(current.to, current.target); } catch (error) {
        // A create whose id is taken by our own earlier attempt means the copy is there.
        const ours = error?.code === 'already_exists' && error.server && createdIds(current).has(`${error.server.t}:${error.server.id}`);
        if (!ours) {
          if (isDefinite(error)) { await journal.remove(current.id); throw moveError('target_failed', error); }
          await save({ error: error?.code ?? 'network' });
          throw moveError('target_pending', error);
        }
      }
      await save({ stage: current.files.length ? 'files' : 'source', error: null });
    }
    if (current.stage === 'files') {
      onStage('files');
      const copied = { ...current.copied };
      const failedFiles = [];
      for (const file of current.files) {
        if (copied[file.id]) continue;
        try {
          const result = await copyFile(file, current);
          copied[file.id] = { id: result.id, duplicate: Boolean(result.duplicate) };
        } catch { failedFiles.push(file.id); }
      }
      // Originals stay in the source trip, so a failed copy loses nothing; it is reported and the move goes on.
      await save({ stage: 'source', copied, failedFiles });
    }
    onStage('source');
    for (let attempt = 0; ; attempt++) {
      try {
        await commit(current.from, [current.source]);
        break;
      } catch (error) {
        if (error?.status === 409 && error.code === 'gone') {
          await settlePrivate();
          await journal.remove(current.id);
          return { status: 'done', entry: current, alreadyGone: true };
        }
        if (error?.status === 409 && error.code === 'stale' && error.server && attempt === 0) {
          // The booking changed after the copy was made: bring the copy up to date, then remove against the new version.
          try {
            const copy = current.target.find((op) => op.t === 'res' && op.id === current.resId)?.put;
            const patch = refreshPatch(copy, error.server);
            await commit(current.to, [{ opId: makeId(), t: 'res', id: current.resId, ...patch }]);
          } catch (failure) {
            if (failure?.status === 409 && failure.code === 'gone') { await save({ error: 'copy_gone' }); throw moveError('copy_gone', failure); }
            await save({ error: failure?.code ?? 'network' });
            throw moveError(isDefinite(failure) ? 'source_failed' : 'source_pending', failure);
          }
          await save({ source: { opId: makeId(), do: 'res.moveToTrip', args: { ...current.source.args, base: error.server.v } } });
          continue;
        }
        await save({ error: error?.code ?? 'network' });
        throw moveError(isDefinite(error) ? 'source_failed' : 'source_pending', error);
      }
    }
    await settlePrivate();
    await journal.remove(current.id);
    return { status: 'done', entry: current };
  });
}

/**
 * Undoes an unfinished move: deletes the copy (booking, moved expenses, and a copied place unless `placeInUse(id)`)
 * from the target and trashes its uploaded files. When `sourceHas()` (a fresh read) is false the move had finished and
 * nothing is undone. Resolves to `{status: 'undone'|'finished', failed}`.
 */
export function undoMove(entry, { journal, commit, trash, sourceHas, placeInUse = async () => false, makeId = newId }) {
  return locked(entry.id, async () => {
    if (entry.stage !== 'target' && !(await sourceHas())) {
      await journal.remove(entry.id);
      return { status: 'finished', failed: [] };
    }
    const failed = [];
    for (const target of entry.created) {
      if (target.t === 'place') {
        let used = true;
        try { used = await placeInUse(target.id); } catch { used = true; }
        if (used) continue;
      }
      try { await commit(entry.to, [{ opId: makeId(), t: target.t, id: target.id, del: true }]); } catch (error) {
        if (!(error?.status === 409 && error.code === 'gone')) failed.push(target);
      }
    }
    for (const copy of Object.values(entry.copied ?? {})) {
      if (copy.duplicate) continue;
      try { await trash(copy.id); } catch { /* left in the target's files */ }
    }
    if (failed.length) {
      await journal.put({ ...entry, error: 'undo_failed' });
      throw moveError('undo_failed');
    }
    await journal.remove(entry.id);
    return { status: 'undone', failed };
  });
}
