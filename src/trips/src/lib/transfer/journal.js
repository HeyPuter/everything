// The receiving side's progress for one transfer, in the account's IndexedDB, so a move resumes where it stopped.
const key = (spaceId) => `transfer:${spaceId}`;
const replayKey = (spaceId) => `transfer:replay:${spaceId}`;

/** `{get(), put(entry), remove()}` for the transfer of space `spaceId` into this account. */
export function transferJournal(db, spaceId) {
  return {
    get: async () => (await db.get(key(spaceId))) ?? null,
    put: (entry) => db.put(key(spaceId), entry),
    remove: () => db.remove(key(spaceId)),
  };
}

/** Edits a member made while the trip was frozen, kept until the moved trip opens: `{to, ops, at}`. */
export function replayStash(db, spaceId) {
  return {
    get: async () => (await db.get(replayKey(spaceId))) ?? null,
    async add(to, ops, now = Date.now()) {
      if (!ops.length) return;
      await db.update(replayKey(spaceId), (value) => {
        const seen = new Set((value?.ops ?? []).map((op) => op.opId));
        return { to, at: now, ops: [...(value?.ops ?? []), ...ops.filter((op) => !seen.has(op.opId))] };
      });
    },
    remove: () => db.remove(replayKey(spaceId)),
  };
}
