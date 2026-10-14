import { DAY } from "./org.js";

// Housekeeping runs lazily, at most hourly per worker instance and in small
// batches, because workers have no scheduler. A legal hold stops all deletion.
// Each run makes at most `budget` deletions, so the request it runs in stays
// quick; `more` reports a remaining backlog so the caller can come back
// sooner than hourly. A large board is destroyed over several runs.
export async function purge(
  org,
  { batch = 200, rounds = 5, budget = 400 } = {},
) {
  const policy = await org.policy();
  if (policy.retention.legalHold) return { audit: 0, boards: 0, more: false };
  const now = org.now(),
    cutoff = new Date(now - policy.retention.auditDays * DAY).toISOString();
  let audit = 0,
    more = false,
    left = budget;
  // A board on legal hold keeps its activity log; the organization-wide
  // audit log still follows the retention period.
  const registry = (await org.list("org:board:")).map((r) => r.value);
  const held = new Set(registry.filter((b) => b?.legalHold).map((b) => b.room));
  for (let round = 0; round < rounds && left > 0; round++) {
    const size = Math.min(batch, left);
    const rows = await org.list("org:audit:", { limit: size });
    const expiredRows = [];
    for (const row of rows) {
      if (row.value.time >= cutoff) break;
      expiredRows.push(row);
    }
    // The directory predates the audit listing. Check holds
    // again before removing activity, in one read per batch rather than
    // one per event. Mark newly held activity so releasing the hold later
    // can still expire it after its organization audit records are gone.
    const rooms = [
      ...new Set(
        expiredRows
          .map((row) => row.value.board)
          .filter((room) => room && !held.has(room)),
      ),
    ];
    if (rooms.length) {
      const keys = rooms.map((room) => "org:board:" + room);
      const boards =
        keys.length > 1 ? await org.kv.get(keys) : [await org.kv.get(keys[0])];
      for (let n = 0; n < rooms.length; n++) {
        if (!boards[n]?.legalHold) continue;
        held.add(rooms[n]);
        if (!boards[n].keptActivity)
          await org.registerBoard(rooms[n], { keptActivity: true });
      }
    }
    // Ten rows at a time, so a run inside someone's request stays quick.
    for (let n = 0; n < expiredRows.length; n += 10)
      await Promise.all(
        expiredRows.slice(n, n + 10).map(async (row) => {
          if (row.value.board && !held.has(row.value.board))
            await org.kv.del(`org:bact:${row.value.board}:${row.value.id}`);
          // Keep the audit row until activity cleanup succeeds, so a refused
          // activity deletion can be retried by the next retention run.
          await org.kv.del(row.key);
        }),
      );
    const expired = expiredRows.length;
    audit += expired;
    left -= expired;
    more = expired === size;
    if (!more) break;
  }
  // Activity a hold kept outlives its audit records, so nothing else would
  // ever expire it. Held boards are marked, and once a hold ends, the
  // board's activity from before the retention period goes too.
  const since = now - policy.retention.auditDays * DAY;
  for (const b of registry) {
    if (b?.legalHold && !b.keptActivity)
      await org.registerBoard(b.room, { keptActivity: true });
    if (!b?.keptActivity || b.legalHold) continue;
    // A hold placed again since the directory was read keeps it all.
    if ((await org.kv.get("org:board:" + b.room))?.legalHold) continue;
    if (left <= 0) {
      more = true;
      break;
    }
    const limit = left;
    const rows = await org.list(`org:bact:${b.room}:`, { limit });
    const old = rows.filter((r) => r.value.at < since);
    for (const row of old) await org.kv.del(row.key);
    left -= old.length;
    // Rows come oldest first, so a newer row or a short listing means none
    // older are left.
    if (old.length < rows.length || rows.length < limit)
      await org.registerBoard(b.room, { keptActivity: null });
    else more = true;
  }
  let boards = 0;
  const due = (b) =>
    !!b &&
    !b.legalHold &&
    (b.purging ||
      (b.deleted && b.deleted < now - policy.retention.deletedBoardDays * DAY));
  const expired = registry.filter(due).slice(0, 5);
  for (const b of expired) {
    if (left <= 0) {
      more = true;
      break;
    }
    // The directory was read at the start of the run, so a hold or restore
    // since then must still save the board. One already being purged can
    // no longer be held or restored.
    if (!b.purging && !(await stillDue(org, b.room, due))) continue;
    const { done, used } = await destroyBoard(org, b.room, left);
    left -= used;
    if (!done) {
      more = true;
      break;
    }
    await org.audit(null, "board.purged", {
      type: "board",
      id: b.room,
      name: b.title,
    });
    boards++;
  }
  return { audit, boards, more };
}
// Whether a board read earlier is still deleted past the retention period
// with no hold on it. It is marked as being purged before the final check,
// so a hold or restore from then on is refused, and one that got in first
// is seen and clears the mark.
async function stillDue(org, room, due) {
  const current = async () => {
    const [record, meta, policy] = await Promise.all([
      org.kv.get("org:board:" + room),
      org.kv.get(`wb:${room}:meta`),
      org.policy(),
    ]);
    return (
      due({ ...record, purging: null }) &&
      !policy.retention.legalHold &&
      !(meta && (meta.legalHold || !meta.deleted))
    );
  };
  if (!(await current())) return false;
  await org.registerBoard(room, { purging: org.now() });
  if (await current()) return true;
  await org.registerBoard(room, { purging: null });
  return false;
}
// Permanently remove a board's records and files. Only reached after the
// deleted-board retention period, or never while a legal hold applies.
// Stops after `budget` record deletions; the board's directory entry goes
// last, so a later run finishes the rest.
export async function destroyBoard(org, room, budget = Infinity) {
  // Its first records go well before its directory entry, so from the
  // start it is marked as being purged and can no longer be restored or
  // held with part of it gone.
  const record = await org.kv.get("org:board:" + room);
  if (record && !record.purging)
    await org.registerBoard(room, { purging: org.now() });
  const member = `wb:${room}:member:`,
    handles = `wb:${room}:handle:`;
  let used = 0;
  for (const prefix of [`wb:${room}:`, `org:bact:${room}:`]) {
    if (used >= budget) break;
    for (const row of await org.list(prefix, {
      values: false,
      limit: budget - used,
    })) {
      const key = typeof row === "string" ? row : row.key;
      // Each membership has an entry in its person's board index.
      if (key.startsWith(member))
        await org.kv.del(`org:ub:${key.slice(member.length)}:${room}`);
      // Live event handles are revoked with Puter, not only forgotten, so
      // they stop working and stop counting toward the account's quota.
      if (key.startsWith(handles)) {
        const handle = await org.kv.get(key);
        if (handle)
          await org
            .fetcher(
              `${org.puter.APIOrigin}/events/kv-handles/${encodeURIComponent(handle)}`,
              {
                method: "DELETE",
                headers: { Authorization: `Bearer ${org.puter.authToken}` },
                signal: AbortSignal.timeout(5000),
              },
            )
            .catch(() => {});
        await org.kv.del(`org:uh:${key.slice(handles.length)}:${room}`);
      }
      await org.kv.del(key);
      used++;
    }
  }
  if (used >= budget) {
    // Records may remain beyond what this run listed.
    const rest = await org.list(`wb:${room}:`, { values: false, limit: 1 });
    const acts = await org.list(`org:bact:${room}:`, {
      values: false,
      limit: 1,
    });
    if (rest.length || acts.length) return { done: false, used };
  }
  await org.kv.del("org:board:" + room);
  await org.kv.del("org:visible:" + room);
  await org.kv.del("org:idx:" + room);
  await org.kv.del("org:boardslack:" + room);
  await org.kv.del("org:slackstatus:board:" + room);
  try {
    await org.puter.fs.delete(`whiteboard/shared/${room}`, {
      recursive: true,
    });
  } catch {
    /* Files may already be gone. */
  }
  return { done: true, used };
}
