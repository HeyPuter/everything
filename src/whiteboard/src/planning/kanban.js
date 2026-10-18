import { hasTask, readTask, statusFromTitle } from "./task.js";

// Kanban status sync: frames titled after a status ("To do", "In progress",
// "Blocked", "Done", or French equivalents) act as board columns.
export const statusSyncEnabled = (board) => !!board?.planning?.statusSync;

export function taskParents(items) {
  return new Map(items.filter(hasTask).map((i) => [i.id, i.parentId || null]));
}

// Tasks that entered a status frame since `before`, or became tasks inside
// one, and would change status. A task new since `before`, as a pasted,
// duplicated or inserted card, takes its column's status only while it is
// still to do: a status someone chose, such as a blocked card, is kept.
export function statusSyncChanges(before, items) {
  const frames = new Map(
    items.filter((i) => i.type === "frame").map((f) => [f.id, f]),
  );
  const changes = [];
  for (const i of items) {
    if (!hasTask(i)) continue;
    const parent = i.parentId || null;
    if (!parent || (before.has(i.id) && parent === before.get(i.id))) continue;
    if (!before.has(i.id) && readTask(i).status !== "todo") continue;
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
