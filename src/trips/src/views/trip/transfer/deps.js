// Wires the transfer runner and the follow of a moved trip to the session: worker calls, deploy, files, me:spaces.
import { fileBlob } from '../../../lib/files/index.js';
import { extensionOf } from '../../../lib/files/types.js';
import { replayStash, runTransfer, transferJournal } from '../../../lib/transfer/index.js';

export const personalOf = (context) => context.session?.personal ?? context.personal ?? null;
export const available = (context) => Boolean(context?.space && context.session?.api && context.session?.db && context.account?.uuid);
export const callFor = (api) => (worker, op, input = {}) => api.request(worker, JSON.stringify({ ...input, op }));
const missing = (error) => error?.status === 404 || error?.code === 'not_found';

/** Copies one file's bytes from the old trip into the new owner's own worker, keeping its id, then its thumbnail. */
function fileCopier({ space, api, puter, uid, call }) {
  return async (file, entry) => {
    let blob;
    try { blob = await fileBlob(space, file.id, { download: true, api, puter }); } catch (error) {
      if (missing(error)) return 'missing';
      throw error;
    }
    const ext = extensionOf(file.name);
    const inboxName = ext ? `${file.id}.${ext}` : file.id;
    // The new owner writes straight into their own trip's inbox, so videos and large files need no proxy.
    await puter.fs.write(`spaces/${entry.from.s}/inbox/${uid}/${inboxName}`, blob, { overwrite: true, dedupeName: false, createMissingParents: true });
    try {
      await call(entry.to.w, 'file.put', {
        space: entry.from.s, fileId: file.id, name: file.name, mime: file.mime, sha256: file.sha256, kind: file.kind, inboxName,
        ...(file.desc ? { desc: file.desc } : {}),
      });
    } catch (error) {
      if (error?.code !== 'exists') throw error;
    }
    if (file.thumb) {
      try {
        const thumb = await fileBlob(space, file.id, { thumb: true, api, puter });
        await api.upload(entry.to, file.id, thumb, { thumb: true });
      } catch { /* the copy shows a generic icon */ }
    }
    return 'copied';
  };
}

export function runnerDeps(context) {
  const { space, session, account } = context;
  const api = session.api;
  const call = callFor(api);
  const puter = context.puter ?? globalThis.puter;
  const personal = personalOf(context);
  return {
    uid: account.uuid,
    journal: transferJournal(session.db, space.ref.s),
    call,
    ensureWorker: async () => (await session.deployer.ensure()).worker.name,
    exportSpace: () => api.request(space.ref.w, JSON.stringify({ op: 'transfer.export', space: space.ref.s }), { binary: true }),
    copyFile: fileCopier({ space, api, puter, uid: account.uuid, call }),
    async index(entry) {
      const meta = entry.meta ?? {};
      await personal.spaces.upsert({ ref: entry.to, role: 'owner', title: meta.title ?? entry.title ?? '', ...(meta.start ? { start: meta.start } : {}), ...(meta.end ? { end: meta.end } : {}) });
      await personal.spaces.remove(entry.from);
    },
    removeCopy: (entry) => call(entry.to.w, 'space.delete', { space: entry.from.s }),
  };
}

export function followDeps(context) {
  const { space, session } = context;
  return {
    call: callFor(session.api),
    spaces: personalOf(context).spaces,
    stash: replayStash(session.db, space.ref.s),
    conflicts: () => (typeof space.conflicts === 'function' ? space.conflicts() : []),
    dropConflict: (opId) => space.resolveConflict?.(opId, { keep: 'theirs' }),
  };
}

// Running moves live here, not in a dialog, so closing it or switching tabs keeps them going.
const jobs = new Map();

export const jobFor = (spaceId) => jobs.get(spaceId) ?? null;

/** Listens to a space's job; the listener gets `{entry, status, error, result}`. */
export function onJob(spaceId, listener) {
  if (!jobs.has(spaceId)) jobs.set(spaceId, { entry: null, status: 'idle', error: null, result: null, listeners: new Set() });
  const job = jobs.get(spaceId);
  job.listeners.add(listener);
  return () => job.listeners.delete(listener);
}

/** Starts or resumes the move described by `entry`; a running one is returned as is. */
export function startJob(context, entry) {
  const id = entry.from.s;
  const job = jobs.get(id) ?? { listeners: new Set() };
  jobs.set(id, job);
  if (job.status === 'running') return job;
  const notify = () => { for (const listener of [...job.listeners]) listener(job); };
  Object.assign(job, { entry, status: 'running', error: null, result: null });
  notify();
  job.promise = runTransfer(entry, { ...runnerDeps(context), onProgress: (next) => { job.entry = next; notify(); } })
    .then((result) => { Object.assign(job, { status: result.status, result, entry: result.entry }); notify(); return result; })
    .catch((error) => { Object.assign(job, { status: 'paused', error }); notify(); return null; });
  return job;
}

/** Test hook: forgets every job. */
export function resetJobs() { jobs.clear(); }
