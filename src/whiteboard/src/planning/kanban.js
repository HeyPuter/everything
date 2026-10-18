import { hasTask, readTask, statusFromTitle } from "./task.js";

// Kanban status sync: frames titled after a status ("To do", "In progress",
// "Blocked", "Done", or French equivalents) act as board columns.
export const statusSyncEnabled = (board) => !!board?.planning?.statusSync;

// Each task's frame, and the frames themselves, so a change can tell a
// card pasted into a column from one that came with its column.
export function taskParents(items) {
  return new Map(
    items
      .filter((i) => hasTask(i) || i.type === "frame")
      .map((i) => [i.id, i.parentId || null]),
  );
}

// Tasks that entered a status frame since `before`, or became tasks inside
// one, and would change status. A card pasted or duplicated into a column
// takes its status, as a cut card pasted into Done moves there; one that
// came with its column, as with a second copy of the Kanban template, keeps
// a status someone chose, such as blocked, and takes it only while it is
// still to do.
export function statusSyncChanges(before, items) {
  const frames = new Map(
    items.filter((i) => i.type === "frame").map((f) => [f.id, f]),
  );
  const changes = [];
  for (const i of items) {
    if (!hasTask(i)) continue;
    const parent = i.parentId || null;
    if (!parent || (before.has(i.id) && parent === before.get(i.id))) continue;
    if (
      !before.has(i.id) &&
      !before.has(parent) &&
      readTask(i).status !== "todo"
    )
      continue;
    const status = statusFromTitle(frames.get(parent)?.text || "");
    if (status && readTask(i).status !== status)
      changes.push({ item: i, status });
  }
  return changes;
}

// Turning sync on lines up the tasks already in status columns that are
// still to do, as cards made tasks in place are, so the columns and the
// statuses agree from the start. A status someone chose, such as a blocked
// card left in In progress, is kept.
// Tasks in `kept`, as locked or hidden ones, are left as they are.
export function alignColumnStatuses(board, kept = new Set()) {
  const changes = statusSyncChanges(new Map(), board.items).filter(
    ({ item }) => !kept.has(item.id),
  );
  for (const { item, status } of changes) item.task = { ...item.task, status };
  return changes;
}

export function applyStatusSync(board, before) {
  if (!statusSyncEnabled(board) || !before) return [];
  const changes = statusSyncChanges(before, board.items);
  for (const { item, status } of changes) item.task = { ...item.task, status };
  return changes;
}
