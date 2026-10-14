import { validateTimer, rebaseTimer } from "../timer.js";
import {
  rebaseWorkshop,
  keyKind,
  workshopCounts,
} from "../facilitation/model.js";
import { canRotateItem } from "../geometry.js";
import { validateTags, rebaseTags, rebaseTagIds, tagKey } from "../tags.js";
import { sharedTagKey, changeTagIds, readTagIds } from "./tags.js";
import { updateConnectors } from "../scene.js";
import {
  repairMindTrees,
  autoLayoutMindMaps,
  autoMindChildren,
} from "../mind-map.js";
import {
  blocksFromDelta,
  textParagraphs,
  spliceTextBlocks,
} from "../text-blocks.js";
import {
  TEXT_STYLE_KEYS,
  runsFromDelta,
  textSegments,
  textDifference,
  spliceTextRuns,
  sliceTextRuns,
} from "../rich-text.js";
import * as Y from "yjs";
import { validateBoard, sharedCopy } from "../model.js";
import { sameData, sameJSON } from "../same-json.js";
import { normalizeEmbed } from "../content/providers.js";
import {
  commitPlanning,
  readPlanning,
  rebasePlanning,
} from "../planning/task.js";
import { ASSET } from "./protocol.js";
import { CUSTOM_SHAPES } from "../shapes.js";
import {
  limitComments,
  rebaseComments,
  updateCommentAnchors,
  validateCommentLanguage,
} from "../comments.js";
import {
  changeCells,
  sharedCells,
  sharedCellLanguages,
  legacyCellLanguageKey,
  legacyCellKey,
  validCellText,
} from "./table-cells.js";
import { canonicalLanguage } from "../accessibility/language-tag.js";
import { rebaseTableLanguages } from "../table-draft.js";
import { rebaseCells } from "../table-cells.js";
import { rebaseTableSizes } from "../table-layout.js";
import {
  sizeKey,
  validSharedSize,
  sharedTableShape,
  changeSharedTableSizes,
  readSharedTableSizes,
} from "./table-sizes.js";

const equal = sameJSON;
// IDs order the same on every device, whatever its language: localeCompare
// sorts some letter pairs differently by locale, such as "aa" in Danish.
const byCode = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
// Records another device stored may list their fields in another order or
// hold a field set to undefined. Read the same, they are not rewritten:
// rewriting someone else's comment would have the save refused.
const sameRecord = (a, b) => {
  if (!a || !b || typeof a !== "object" || typeof b !== "object")
    return equal(a, b);
  const keys = Object.keys(a).filter((k) => a[k] !== undefined);
  return (
    keys.length === Object.keys(b).filter((k) => b[k] !== undefined).length &&
    keys.every((k) => equal(a[k], b[k]))
  );
};
// Source, crop and container geometry form one image revision.
const geometry = new Set([
  "x",
  "y",
  "w",
  "h",
  "points",
  "crop",
  "rotation",
  "src",
]);
const fields = new Set([
  "alt",
  "lang",
  "type",
  "shape",
  "color",
  "fontSize",
  "fontFamily",
  "autoFontSize",
  "autoHeight",
  "textColor",
  "highlight",
  "textAlign",
  "textValign",
  "bold",
  "italic",
  "underline",
  "strike",
  "groupId",
  "parentId",
  "routeAxis",
  "lineType",
  "lineStyle",
  "lineWidth",
  "startCap",
  "endCap",
  "startId",
  "endId",
  "locked",
  "order",
  "url",
  "objectLink",
  "mindMap",
  "mindCollapsed",
  "cells",
  "fileName",
  "mimeType",
  "size",
  "data",
  "task",
  "dependency",
  "provider",
  "sourceUrl",
]);
export const LOCAL = Symbol("local edit");
// Local writes kept out of undo history, which are saved like edits.
export const REPAIR = Symbol("local repair");

export function changeText(text, next) {
  const { start, end, insert } = textDifference(text.toString(), next);
  if (end > start) text.delete(start, end - start);
  if (insert) text.insert(start, insert);
}

// Only change attributes that differ. Unrelated formatting and concurrent
// character insertions retain their Y.Text identities and undo ownership.
export function changeTextRuns(text, runs = []) {
  const value = text.toString();
  const before = textSegments(value, runsFromDelta(text.toDelta()));
  const after = textSegments(value, runs);
  let a = 0,
    b = 0,
    at = 0;
  while (a < before.length && b < after.length) {
    const end = Math.min(before[a].end, after[b].end),
      patch = {};
    for (const key of TEXT_STYLE_KEYS)
      if (before[a].style[key] !== after[b].style[key])
        patch[key] = after[b].style[key] ?? null;
    if (Object.keys(patch).length) text.format(at, end - at, patch);
    at = end;
    if (end === before[a].end) a++;
    if (end === after[b].end) b++;
  }
}

export function changeTextBlocks(entry, blocks = []) {
  const text = entry.get("text"),
    value = text.toString(),
    delta = text.toDelta(),
    tail = entry.get("textTail");
  if (!blocks.length && !tail && !delta.some((op) => op.attributes?.block))
    return;
  const before = new Map(
    textParagraphs(value, blocksFromDelta(delta, tail)).map((p) => [p.end, p]),
  );
  const rows = textParagraphs(value, blocks);
  for (const row of rows) {
    const previous = before.get(row.end);
    const style = row.list ? { list: row.list, indent: row.indent } : undefined;
    if (row.end < value.length) {
      if (previous?.list !== row.list || previous?.indent !== row.indent)
        text.format(row.end, 1, { block: style || null });
    } else if (!equal(entry.get("textTail"), style)) {
      if (style) entry.set("textTail", style);
      else entry.delete("textTail");
    }
  }
}

// Two people can create a tag of the same name at once. They are one tag:
// the one with the lowest ID, which every object with either now carries,
// the same on every device. Saving the board then stores it that way.
function foldTags(board) {
  const kept = new Map(),
    same = new Map();
  for (const tag of board.tags) {
    const key = tagKey(tag.name),
      first = kept.get(key);
    if (first) same.set(tag.id, first.id);
    else kept.set(key, tag);
  }
  if (!same.size) return;
  board.tags = board.tags.filter((tag) => !same.has(tag.id));
  for (const item of board.items)
    if (item.tagIds?.some((id) => same.has(id)))
      item.tagIds = [...new Set(item.tagIds.map((id) => same.get(id) ?? id))];
}
// The longest run of `ids` whose old ranks increase, the objects a reorder
// can leave where they are.
function orderedRun(ids, rank) {
  const tails = [],
    previous = new Array(ids.length);
  ids.forEach((id, n) => {
    const r = rank.get(id);
    let low = 0,
      high = tails.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (rank.get(ids[tails[mid]]) < r) low = mid + 1;
      else high = mid;
    }
    previous[n] = low ? tails[low - 1] : -1;
    tails[low] = n;
  });
  const run = new Set();
  for (let n = tails.at(-1) ?? -1; n >= 0; n = previous[n]) run.add(ids[n]);
  return run;
}
// Every Yjs type holds both keyed entries and a sequence. The document reads
// a map's entries and a text's sequence; whatever a crafted update puts in
// the other part is content nothing here projects, checks or counts.
function hiddenContent(type) {
  if (type instanceof Y.Map) {
    for (let entry = type._start; entry; entry = entry.right)
      if (!entry.deleted) return true;
    for (const value of type.values())
      if (value instanceof Y.AbstractType && hiddenContent(value)) return true;
    return false;
  }
  for (const entry of type._map.values()) if (!entry.deleted) return true;
  if (type instanceof Y.Array)
    for (const value of type.toArray())
      if (value instanceof Y.AbstractType && hiddenContent(value)) return true;
  return false;
}
// Whether one update's changes, as a transaction lists them by type and key
// (null for the sequence), put content where hiddenContent finds it. Types
// the update created are not listed themselves but sit under a listed key,
// so they are searched whole; content it did not touch was checked when it
// arrived, so a large board costs no more to check than a small one.
function hiddenChanges(changes) {
  for (const [type, keys] of changes) {
    if (type._item?.deleted) continue;
    if (type instanceof Y.Map) {
      if (keys.has(null))
        for (let entry = type._start; entry; entry = entry.right)
          if (!entry.deleted) return true;
      for (const key of keys) {
        const value = key === null ? undefined : type.get(key);
        if (value instanceof Y.AbstractType && hiddenContent(value))
          return true;
      }
      continue;
    }
    for (const key of keys)
      if (key !== null && type._map.get(key)?.deleted === false) return true;
    if (type instanceof Y.Array && keys.has(null))
      for (const value of type.toArray())
        if (value instanceof Y.AbstractType && hiddenContent(value))
          return true;
  }
  return false;
}
// Undo steps a shared board keeps, as History does for a personal one.
const UNDO_STEPS = 80;
export class SharedDocument {
  // `merge` keeps this browser's facilitation changes that another
  // facilitator's simultaneous change replaced; see mergeWorkshop.
  // Without `gc`, deleted content is kept, as for trying an undo on a copy.
  constructor(update, { merge = false, gc = true } = {}) {
    this.merges = merge;
    this.doc = new Y.Doc({ gc });
    this.meta = this.doc.getMap("board");
    this.items = this.doc.getMap("items");
    this.comments = this.doc.getMap("comments");
    this.tags = this.doc.getMap("tags");
    this.timer = this.doc.getMap("timer");
    // Facilitation registers stay outside drawing Undo/Redo, like the timer.
    this.workshop = this.doc.getMap("workshop");
    if (update) Y.applyUpdate(this.doc, update, "load");
    this.undo = new Y.UndoManager([this.meta, this.items, this.tags], {
      trackedOrigins: new Set([LOCAL]),
      captureTimeout: 0,
      // A table's cells are read before an undo removes the first of them,
      // for redo to fill in; see restoreMissing.
      deleteFilter: (item) => {
        if (this.undo?.undoing) this.keepCells(item);
        return true;
      },
    });
    // Undoing a deletion brings back only what this browser deleted. A
    // collaborator's concurrent change inside the object, such as a move,
    // replaced a register and went with the object, so the object would
    // return without its position or cells. Each undo step keeps the
    // objects it deleted as they were, to fill in what is missing.
    const keep = ({ stackItem }) => {
      // Tables whose cells a structural change or an undo replaced.
      const tables = this.tables;
      this.tables = null;
      if (tables?.size) {
        const kept = stackItem.meta.get("tables") || new Map();
        for (const [entry, table] of tables)
          if (!kept.has(entry)) kept.set(entry, table);
        stackItem.meta.set("tables", kept);
      }
      if (!this.removed?.size) return;
      const kept = stackItem.meta.get("removed") || new Map();
      for (const [id, item] of this.removed) kept.set(id, item);
      stackItem.meta.set("removed", kept);
      this.removed = null;
    };
    this.undo.on("stack-item-added", keep);
    this.undo.on("stack-item-updated", keep);
    // The history keeps 80 steps, as on a personal board. Each step keeps
    // what it deleted so it can be brought back; a step dropped off the end
    // lets that go, or a board kept open for hours holds every object ever
    // erased, in memory and in the copy saved on the device after each edit.
    this.undo.on("stack-item-added", ({ type }) => {
      const stack = this.undo.undoStack;
      if (type !== "undo" || stack.length <= UNDO_STEPS) return;
      const old = stack.shift();
      this.doc.transact((tr) =>
        Y.iterateDeletedStructs(tr, old.deletions, (struct) => {
          if (struct instanceof Y.Item) struct.keep = false;
        }),
      );
      Y.tryGc(old.deletions, this.doc.store, () => true);
    });
    this.undo.on("stack-item-popped", (event) => {
      const { stackItem, type } = event;
      this.restoreMissing(event);
      const removed = stackItem.meta.get("removed");
      if (!removed) return;
      // Redoing and undoing again keeps the same objects.
      const inverse = (
        type === "undo" ? this.undo.redoStack : this.undo.undoStack
      ).at(-1);
      inverse?.meta.set("removed", removed);
      if (type === "undo") this.repairRestored(removed);
    });
  }
  keepCells(item) {
    let child = item;
    while (child.parent?.parent && child.parent.parent !== this.items)
      child = child.parent._item;
    // An undo removing a whole table also removes its cells.
    const whole =
      item.parent === this.items && item.content?.type instanceof Y.Map;
    const entry = whole ? item.content.type : child.parent;
    if (
      (!whole && child.parentSub !== "cells") ||
      entry?.parent !== this.items ||
      this.tables?.has(entry) ||
      !(entry.get("cells") instanceof Y.Map)
    )
      return;
    try {
      const table = {
        type: "table",
        ...entry.get("geometry"),
        cells: sharedCells(entry.get("cells"), entry),
        cellLanguages: sharedCellLanguages(entry.get("cells"), entry),
      };
      readSharedTableSizes(entry, table);
      (this.tables ??= new Map()).set(entry, table);
    } catch {
      /* A malformed table has nothing worth restoring. */
    }
  }
  // When two people change the same property at once, Yjs keeps one value.
  // If its author undoes, Yjs does not bring back the value from before,
  // since the other came between them, and leaves the property empty, such
  // as an object without a position or cells. Redoing an addition someone
  // edited meanwhile likewise brings back only this browser's registers.
  // The values the step removed are still in its record: put back those a
  // property is now missing. A value a collaborator wrote or removed
  // afterwards stays as they left it.
  restoreMissing({ stackItem, type, changedParentTypes }) {
    const deleted = [...changedParentTypes.values()][0]?.[0]?.transaction
      .deleteSet;
    if (!deleted) return;
    const live = (map) =>
      map === this.meta ||
      map === this.tags ||
      (map instanceof Y.Map &&
        map._item?.deleted === false &&
        map.parent === this.items);
    // On an object still there, the property's latest value is the one
    // this undo or redo removed. An object brought back since is new, so
    // anything it lacks was left out.
    const emptied = (map, key, redone = false) => {
      if (map.has(key)) return false;
      if (redone) return true;
      const last = map._map.get(key);
      return !!last && Y.isDeleted(deleted, last.lastId);
    };
    const target = (parent) => {
      if (live(parent)) return parent;
      // The object as it came back since, deleted and brought back by an
      // undo or redo, which makes it a new entry.
      if (parent?._item?.parent !== this.items || !parent._item.deleted)
        return null;
      const now = this.items.get(parent._item.parentSub);
      return now !== parent && live(now) ? now : null;
    };
    const client = this.doc.clientID,
      start = Y.getState(this.doc.store, client);
    this.doc.transact((transaction) => {
      const tables = stackItem.meta.get("tables");
      Y.iterateDeletedStructs(transaction, stackItem.deletions, (struct) => {
        if (
          !(struct instanceof Y.Item) ||
          struct.parentSub === null ||
          struct.redone !== null ||
          Y.isDeleted(stackItem.insertions, struct.id)
        )
          return;
        const map = target(struct.parent),
          key = struct.parentSub;
        if (!map || !emptied(map, key, map !== struct.parent)) return;
        const value = struct.content.getContent().at(-1);
        if (!(value instanceof Y.AbstractType))
          map.set(key, structuredClone(value));
      });
      for (const [entry, table] of tables || []) {
        const map = target(entry);
        if (map && emptied(map, "cells", map !== entry)) {
          changeCells(
            map,
            table.cells,
            changeText,
            changeTextRuns,
            table.cellLanguages,
          );
          changeSharedTableSizes(map, table);
        }
      }
    }, REPAIR);
    // Redo removes these values again, so it can bring back the step's own.
    const end = Y.getState(this.doc.store, client),
      inverse = (
        type === "undo" ? this.undo.redoStack : this.undo.undoStack
      ).at(-1);
    if (end > start && inverse)
      inverse.insertions = Y.mergeDeleteSets([
        inverse.insertions,
        { clients: new Map([[client, [{ clock: start, len: end - start }]]]) },
      ]);
  }
  repairRestored(removed) {
    this.doc.transact(() => {
      for (const [id, item] of removed) {
        const entry = this.items.get(id);
        if (!(entry instanceof Y.Map)) continue;
        if (!(entry.get("text") instanceof Y.Text))
          entry.set("text", new Y.Text());
        const { z, geometryRegister, ...kept } = item;
        if (!Number.isFinite(entry.get("z")) && Number.isFinite(z))
          entry.set("z", z);
        // Sizes derive from the geometry register: put it back first.
        if (!entry.has("geometry") && geometryRegister)
          entry.set("geometry", structuredClone(geometryRegister));
        const now = this.readItem(id, entry),
          whole = { ...structuredClone(kept), ...now };
        if (!equal(whole, now)) this.writeItem(entry, whole);
      }
    }, REPAIR);
    // Tables kept while repairing belong to no undo step.
    this.tables = null;
  }
  // Without `content`, only comments and workshop registers are written:
  // a commenter's save leaves the board's content untouched, including values
  // the snapshot projects differently from how they are stored.
  commit(board, { content = true } = {}) {
    // Read before the change, while the stacking order kept between changes
    // still holds; objects the change removes are left out of it.
    const stacked = content ? this.layered() : null;
    this.doc.transact(() => {
      this.setWorkshop(board.workshop);
      if (content) this.commitContent(board, stacked);
      for (const thread of updateCommentAnchors(board.comments, board.items)) {
        let entry = this.comments.get(thread.id);
        if (!entry) {
          entry = new Y.Map();
          this.comments.set(thread.id, entry);
          entry.set("messages", new Y.Map());
        }
        const position = Object.fromEntries(
          ["x", "y", "anchorId", "dx", "dy"]
            .filter((k) => thread[k] !== undefined)
            .map((k) => [k, thread[k]]),
        );
        if (!sameRecord(entry.get("position"), position))
          entry.set("position", position);
        const messages = entry.get("messages");
        // A reply reopens its discussion. Written even when already open,
        // so a resolve made at the same moment without seeing the reply
        // can be told apart and undone; see mergeWorkshop.
        const replied =
          !thread.resolved &&
          thread.messages.some((message) => !messages.has(message.id));
        if (entry.get("resolved") !== thread.resolved || replied) {
          entry.set("resolved", thread.resolved);
          if (replied && this.merges)
            (this.reopened ??= new Map()).set(
              entry,
              entry._map.get("resolved"),
            );
        }
        for (const message of thread.messages) {
          let value = messages.get(message.id);
          if (!value) {
            value = new Y.Map();
            messages.set(message.id, value);
          }
          // Text and its passage offsets are one revision. Separate map keys
          // could merge one device's shorter text with another's old ranges.
          const body =
            message.textRuns?.length || typeof value.get("text") === "object"
              ? { value: message.text, textRuns: message.textRuns || [] }
              : message.text;
          if (!sameRecord(value.get("text"), body))
            value.set("text", structuredClone(body));
          for (const key of [
            "authorId",
            "authorName",
            "createdAt",
            "editedAt",
            "deleted",
            "lang",
          ])
            if (message[key] === undefined) {
              if (value.get(key) !== undefined) value.delete(key);
            } else if (!equal(value.get(key), message[key]))
              value.set(key, structuredClone(message[key]));
        }
      }
    }, LOCAL);
  }
  text(id, value, runs, blocks) {
    const entry = this.items.get(id),
      text = entry?.get("text");
    if (text instanceof Y.Text)
      this.doc.transact(() => {
        // A text already longer than may be typed is kept, not cut.
        const prev = text.toString(),
          next = value.slice(0, Math.max(20000, prev.length));
        if (blocks === undefined) {
          const change = textDifference(prev, next);
          blocks = spliceTextBlocks(
            prev,
            blocksFromDelta(text.toDelta(), entry.get("textTail")),
            change.start,
            change.end,
            change.insert,
          );
        }
        changeText(text, next);
        if (runs !== undefined) changeTextRuns(text, runs);
        changeTextBlocks(entry, blocks);
      }, LOCAL);
  }
  // One stored object as the board shows it.
  readItem(id, entry) {
    const item = {
      id,
      ...entry.get("geometry"),
      text: entry.get("text")?.toString() || "",
    };
    const delta = entry.get("text")?.toDelta() || [],
      runs = runsFromDelta(delta);
    if (runs.length) item.textRuns = runs;
    const blocks = blocksFromDelta(delta, entry.get("textTail"));
    if (blocks.length) item.textBlocks = blocks;
    for (const key of fields)
      if (entry.has(key))
        item[key] = structuredClone(
          key === "cells" ? sharedCells(entry.get(key), entry) : entry.get(key),
        );
    if (item.src === undefined && entry.has("src")) item.src = entry.get("src");
    if (item.cells) {
      const languages = sharedCellLanguages(entry.get("cells"), entry);
      if (languages) item.cellLanguages = languages;
    }
    readSharedTableSizes(entry, item);
    const tagIds = this.tags.size ? readTagIds(entry, this.tags) : [];
    if (tagIds.length) item.tagIds = tagIds;
    return item;
  }
  // Keeps each object as last read, for a document projected again after
  // every change, as the worker's and a session's are: only objects a change
  // touched are read again. A change to the tag catalog, which every
  // object's tags are read against, reads them all again. With `deep`, each
  // object is copied whole, for callers that change nested values as the
  // editor does; otherwise copies share them.
  cacheItems({ deep = false } = {}) {
    this.deep ||= deep;
    if (this.read) return;
    this.read = new Map();
    this.doc.on("afterTransaction", (transaction) => {
      this.encoded = null;
      // Objects added, removed or replaced, or given another layer rank,
      // change the stacking order; see layered.
      if (transaction.changed.has(this.items)) this.order = null;
      if (transaction.changed.has(this.tags)) return this.read.clear();
      for (const [type, keys] of transaction.changed) {
        if (type === this.items) {
          for (const key of keys) if (key !== null) this.read.delete(key);
          continue;
        }
        if (type._item?.parent === this.items && keys.has("z"))
          this.order = null;
        let entry = type;
        while (entry._item && entry._item.parent !== this.items)
          entry = entry._item.parent;
        if (entry._item) this.read.delete(entry._item.parentSub);
      }
    });
  }
  // From the first call, keeps what every change not made here touched, as
  // applyTracked lists it (`items` and `changes`), however it arrived, until
  // takeArrivals hands it over: a session checks only that once it has
  // checked the document whole.
  watchArrivals() {
    if (this.watching) return;
    this.watching = true;
    this.doc.on("afterTransaction", (transaction) => {
      if (transaction.origin === LOCAL || transaction.origin === REPAIR) return;
      const arrived = (this.arrivals ??= {
        items: new Set(),
        changes: new Map(),
      });
      for (const [type, keys] of transaction.changed) {
        if (!arrived.changes.has(type)) arrived.changes.set(type, new Set());
        for (const key of keys) arrived.changes.get(type).add(key);
        let root = type,
          id = null;
        while (root._item) {
          id = root._item.parentSub;
          root = root._item.parent;
        }
        if (root !== this.items) continue;
        if (type === this.items) {
          for (const key of keys) if (key !== null) arrived.items.add(key);
        } else if (id !== null) arrived.items.add(id);
      }
    });
  }
  takeArrivals() {
    const arrived = this.arrivals || { items: new Set(), changes: new Map() };
    this.arrivals = null;
    return arrived;
  }
  // From the call on, hands `removed` the objects each change removes, as
  // they last stood, with the board just before the change: its objects as
  // last read, its workshop, and every tag seen. An object is gone once
  // removed, so each one a change touches is read again after it, rather
  // than the whole board after every change.
  watchRemovals(removed) {
    const last = new Map(),
      tags = new Map();
    for (const [id, entry] of this.items)
      if (entry instanceof Y.Map) last.set(id, this.readItem(id, entry));
    const readTags = () => {
      for (const [id, tag] of this.tags) tags.set(id, structuredClone(tag));
    };
    const readWorkshop = () =>
      this.workshop.size
        ? Object.fromEntries(
            [...this.workshop].map(([k, v]) => [k, structuredClone(v)]),
          )
        : undefined;
    readTags();
    let workshop = readWorkshop();
    this.doc.on("afterTransaction", (transaction) => {
      const touched = new Set();
      for (const [type, keys] of transaction.changed) {
        let root = type,
          id = null;
        while (root._item) {
          id = root._item.parentSub;
          root = root._item.parent;
        }
        if (root !== this.items) continue;
        if (type === this.items) {
          for (const key of keys) if (key !== null) touched.add(key);
        } else if (id !== null) touched.add(id);
      }
      const gone = [...touched].filter(
        (id) => last.has(id) && !(this.items.get(id) instanceof Y.Map),
      );
      if (gone.length)
        removed(
          gone.map((id) => last.get(id)),
          {
            workshop,
            tags,
            get items() {
              return [...last.values()];
            },
          },
        );
      for (const id of touched) {
        const entry = this.items.get(id);
        if (entry instanceof Y.Map) last.set(id, this.readItem(id, entry));
        else last.delete(id);
      }
      if (transaction.changed.has(this.tags)) readTags();
      if (transaction.changed.has(this.workshop)) workshop = readWorkshop();
    });
  }
  // Writes the connectors attached to an object, and the objects at their
  // other ends, into `out` from index `n` while it has room, and returns
  // the index after them. The index of connectors by end is built when
  // first asked for and kept up to date.
  related(id, out, n) {
    if (!this.ends) {
      this.ends = new Map();
      this.attached = new Map();
      for (const key of this.items.keys()) this.indexEnds(key);
      this.doc.on("afterTransaction", (transaction) => {
        for (const [type, keys] of transaction.changed)
          if (type === this.items) {
            for (const key of keys) if (key !== null) this.indexEnds(key);
          } else if (
            type._item?.parent === this.items &&
            (keys.has("startId") || keys.has("endId"))
          )
            this.indexEnds(type._item.parentSub);
      });
    }
    const connectors = this.attached.get(id);
    if (connectors)
      for (const connector of connectors) {
        if (n >= out.length) break;
        out[n++] = connector;
        const ends = this.ends.get(connector),
          other = ends[0] === id ? ends[1] : ends[0];
        if (other && n < out.length) out[n++] = other;
      }
    return n;
  }
  indexEnds(id) {
    for (const end of this.ends.get(id) || []) {
      const connectors = this.attached.get(end);
      connectors?.delete(id);
      if (connectors?.size === 0) this.attached.delete(end);
    }
    this.ends.delete(id);
    const entry = this.items.get(id);
    if (!(entry instanceof Y.Map)) return;
    const ends = [entry.get("startId"), entry.get("endId")].map((end) =>
      typeof end === "string" ? end : null,
    );
    if (!ends[0] && !ends[1]) return;
    this.ends.set(id, ends);
    for (const end of ends)
      if (end) {
        if (!this.attached.has(end)) this.attached.set(end, new Set());
        this.attached.get(end).add(id);
      }
  }
  // One stored object as the board shows it, owned by the caller down to
  // its own fields, or entirely in deep mode.
  projectItem(id, entry) {
    if (!this.read) return this.readItem(id, entry);
    // While a transaction runs or finishes, objects it changed are not yet
    // forgotten, so they are read afresh and not kept.
    const busy = this.doc._transactionCleanups.length > 0;
    let item = busy ? undefined : this.read.get(id);
    if (!item) {
      item = this.readItem(id, entry);
      if (!busy) this.read.set(id, item);
    }
    return this.deep ? sharedCopy(item) : { ...item };
  }
  // Stored objects in stacking order: by layer rank, then ID. Each rank is
  // read once rather than at every comparison. A document projected after
  // every change keeps the order until a change affects it (see
  // cacheItems); callers must not change the list they are given.
  layered() {
    const busy = this.doc._transactionCleanups.length > 0;
    if (this.read && this.order && !busy) return this.order;
    const entries = [],
      ranks = new Map();
    for (const [id, entry] of this.items)
      if (entry instanceof Y.Map) {
        entries.push([id, entry]);
        ranks.set(id, entry.get("z") || 0);
      }
    entries.sort(([a], [b]) => ranks.get(a) - ranks.get(b) || byCode(a, b));
    if (this.read && !busy) this.order = entries;
    return entries;
  }
  snapshot(id = "shared", normalizeComments = true) {
    const items = this.layered().map(([id, entry]) =>
      this.projectItem(id, entry),
    );
    // Concurrent deletion of a frame/node also detaches its surviving children/connectors.
    const byId = new Map(items.map((i) => [i.id, i]));
    for (const i of items) {
      if (!canRotateItem(i) && Number.isFinite(i.rotation)) delete i.rotation;
      // Concurrent type conversion can leave a previous rectangle silhouette.
      // Keep validation strict for unknown values while ignoring a stale kind.
      if (i.type !== "rect" && CUSTOM_SHAPES.has(i.shape)) delete i.shape;
      if (
        !["note", "rect", "ellipse"].includes(i.type) &&
        typeof i.autoFontSize === "boolean"
      )
        delete i.autoFontSize;
      if (
        !["note", "rect", "ellipse"].includes(i.type) &&
        typeof i.textValign === "string"
      )
        delete i.textValign;
      if (i.type !== "text" && typeof i.autoHeight === "boolean")
        delete i.autoHeight;
      // Concurrent re-pointing can pair one person's URL with another's
      // provider; the URL says which provider shows it.
      if (i.type === "embed" && typeof i.url === "string") {
        const source = normalizeEmbed(i.url);
        if (source && source.provider !== i.provider)
          i.provider = source.provider;
      }
      if (
        i.parentId &&
        (i.type === "frame" || byId.get(i.parentId)?.type !== "frame")
      )
        delete i.parentId;
      for (const key of ["startId", "endId"])
        if (
          i[key] &&
          (!byId.has(i[key]) ||
            ["arrow", "pen", "frame"].includes(byId.get(i[key]).type))
        )
          delete i[key];
      if (i.startId && i.startId === i.endId) delete i.endId;
    }
    repairMindTrees(items);
    autoLayoutMindMaps(items);
    if (items.some((i) => i.mindMap || i.columnWidths || i.rowHeights))
      updateConnectors(items);
    const result = {
      version: 1,
      id,
      title: this.meta.get("title") || "Untitled board",
      items,
      ...readPlanning(this.meta),
      ...(this.timer.has("state")
        ? { timer: structuredClone(this.timer.get("state")) }
        : {}),
      ...(this.workshop.size
        ? {
            workshop: Object.fromEntries(
              [...this.workshop]
                .sort(([a], [b]) => byCode(a, b))
                .map(([k, v]) => [k, structuredClone(v)]),
            ),
          }
        : {}),
      ...(this.tags.size
        ? {
            tags: [...this.tags.values()]
              .map((t) => structuredClone(t))
              .sort((a, b) => byCode(a.id, b.id)),
          }
        : {}),
      ...(this.comments.size
        ? {
            comments: [...this.comments]
              .filter(([, t]) => t instanceof Y.Map)
              .map(([id, entry]) => ({
                id,
                ...structuredClone(entry.get("position")),
                resolved: entry.get("resolved"),
                messages: [
                  ...(entry.get("messages") instanceof Y.Map
                    ? entry.get("messages")
                    : []),
                ]
                  .map(([id, m]) => {
                    const message = {
                      id,
                      ...(m instanceof Y.Map
                        ? structuredClone(m.toJSON())
                        : {}),
                    };
                    const body = message.text;
                    if (
                      body &&
                      typeof body === "object" &&
                      !Array.isArray(body)
                    ) {
                      message.text = body.value;
                      if (body.textRuns?.length)
                        message.textRuns = body.textRuns;
                    }
                    return message;
                  })
                  .sort(
                    (a, b) => a.createdAt - b.createdAt || byCode(a.id, b.id),
                  ),
              }))
              .sort((a, b) => byCode(a.id, b.id)),
          }
        : {}),
    };
    if (result.tags?.length > 1) foldTags(result);
    if (result.comments) result.comments = limitComments(result.comments);
    if (normalizeComments && result.comments)
      result.comments = updateCommentAnchors(result.comments, items);
    return result;
  }
  // Messages per discussion as stored, including any snapshot() leaves out.
  commentCounts() {
    const threads = new Map();
    let total = 0;
    for (const [id, entry] of this.comments) {
      const messages = entry instanceof Y.Map && entry.get("messages");
      const count = messages instanceof Y.Map ? messages.size : 0;
      threads.set(id, count);
      total += count;
    }
    return { threads, total };
  }
  // The Yjs client whose edit first wrote this object: the browser session
  // of whoever added it, which the worker ties to one account for good.
  creator(id) {
    return this.items._map.get(id)?.id.client;
  }
  // How many objects the board has ever held: Yjs keeps the key of each
  // one removed, so removed ones count too.
  objectsEver() {
    return this.items._map.size;
  }
  // What validate() counts against the board's limits, as stored.
  counts() {
    return {
      items: this.items.size,
      tags: this.tags.size,
      workshop: workshopCounts(this.workshop.keys()),
    };
  }
  // `allowed` raises count limits, as validateBoard explains. A caller that
  // has projected the board already passes it as `board`, which is left
  // unchanged. Given `items`, the IDs an update wrote, only those objects'
  // stored structure is checked: no other object's can have changed.
  // Given `changes`, the types and keys an update changed as applyTracked
  // lists them, only those are searched for content nothing reads.
  validate(allowed = {}, { board, items, changes } = {}) {
    for (const key of this.doc.share.keys())
      if (
        !["board", "items", "comments", "tags", "timer", "workshop"].includes(
          key,
        )
      )
        throw Error("Invalid shared document structure.");
    // Content the checks below never read, such as a sequence under a map
    // or keyed entries under a text, would be stored, counted by no limit,
    // and sent to everyone.
    if (
      changes
        ? hiddenChanges(changes)
        : [...this.doc.share.values()].some(hiddenContent)
    )
      throw Error("Invalid shared document structure.");
    // The board map holds only its title and planning settings, which
    // validateBoard checks; anything else would be stored unseen.
    for (const [key, value] of this.meta)
      if (
        !["title", "planning"].includes(key) ||
        (key === "planning" &&
          (!value ||
            typeof value !== "object" ||
            Array.isArray(value) ||
            value instanceof Y.AbstractType))
      )
        throw Error("Invalid shared board structure.");
    // Workshop values are plain JSON registers; validateBoard checks them.
    for (const value of this.workshop.values())
      if (value instanceof Y.AbstractType || value === null)
        throw Error("Invalid shared workshop structure.");
    if ([...this.timer.keys()].some((key) => key !== "state"))
      throw Error("Invalid shared timer structure.");
    validateTimer(this.timer.get("state"));
    validateTags([...this.tags.values()], allowed.tags);
    for (const [id, tag] of this.tags)
      if (id !== tag.id) throw Error("Invalid shared tag.");
    for (const entry of this.comments.values()) {
      const position = entry instanceof Y.Map && entry.get("position");
      if (
        !(entry instanceof Y.Map) ||
        !position ||
        typeof position !== "object" ||
        Array.isArray(position) ||
        Object.keys(position).some(
          (key) => !["x", "y", "anchorId", "dx", "dy"].includes(key),
        ) ||
        !(entry.get("messages") instanceof Y.Map) ||
        [...entry.keys()].some(
          (k) => !["position", "resolved", "messages"].includes(k),
        )
      )
        throw Error("Invalid shared comment structure.");
      for (const message of entry.get("messages").values()) {
        if (
          !(message instanceof Y.Map) ||
          [...message.keys()].some(
            (k) =>
              ![
                "authorId",
                "authorName",
                "text",
                "createdAt",
                "editedAt",
                "deleted",
                "lang",
              ].includes(k),
          )
        )
          throw Error("Invalid shared comment message.");
        const body = message.get("text");
        if (typeof body === "object") {
          if (
            !body ||
            Array.isArray(body) ||
            body instanceof Y.AbstractType ||
            Object.keys(body).some(
              (key) => !["value", "textRuns"].includes(key),
            ) ||
            typeof body.value !== "string" ||
            !Array.isArray(body.textRuns)
          )
            throw Error("Invalid shared comment text.");
          validateCommentLanguage({
            text: body.value,
            textRuns: body.textRuns,
          });
        }
      }
    }
    for (const entry of items
      ? [...items]
          .map((id) => this.items.get(id))
          .filter((e) => e !== undefined)
      : this.items.values()) {
      if (
        !(entry instanceof Y.Map) ||
        !(entry.get("text") instanceof Y.Text) ||
        !Number.isFinite(entry.get("z"))
      )
        throw Error("Invalid shared object structure.");
      if ([...entry.keys()].filter(sharedTagKey).length > 1000)
        throw Error("Too many shared tag references.");
      if (entry.has("src") && !ASSET.test(entry.get("src")))
        throw Error("Shared assets must be stored as files.");
      // Geometry is spread into the object, so another key, such as an ID,
      // would change what the object is on every client.
      const g = entry.get("geometry");
      if (
        g !== undefined &&
        (!g ||
          typeof g !== "object" ||
          Array.isArray(g) ||
          g instanceof Y.AbstractType ||
          Object.keys(g).some((key) => !geometry.has(key)))
      )
        throw Error("Invalid shared object geometry.");
      for (const key of entry.keys())
        if (
          !["text", "textTail", "z", "geometry", "src"].includes(key) &&
          !fields.has(key) &&
          !(legacyCellKey(key) && validCellText(entry.get(key))) &&
          !(
            legacyCellLanguageKey(key) &&
            entry.get("type") === "table" &&
            canonicalLanguage(entry.get(key))
          ) &&
          !(sharedTagKey(key) && entry.get(key) === true) &&
          !(
            sizeKey(key) &&
            entry.get("type") === "table" &&
            // A resize concurrent with structural replacement leaves an
            // ignored register beside the new cell map.
            (Array.isArray(entry.get("cells")) ||
              entry.get("cells") instanceof Y.Map) &&
            validSharedSize(entry.get(key))
          )
        )
          throw Error("Unknown shared object property.");
    }
    const projected = board ?? this.snapshot("shared", false);
    return validateBoard(
      {
        ...projected,
        items: projected.items.map((i) => {
          if ((i.src && !ASSET.test(i.src)) || (i.data && !ASSET.test(i.data)))
            throw Error("Shared assets must be stored as files.");
          return i.src || i.data
            ? {
                ...i,
                ...(i.src ? { src: "data:image/png;base64,AA==" } : {}),
                ...(i.data
                  ? { data: "data:application/octet-stream;base64," }
                  : {}),
              }
            : i;
        }),
      },
      allowed,
      items,
    );
  }
  apply(bytes, origin = "remote") {
    Y.applyUpdate(this.doc, bytes, origin);
    if (this.written?.size || this.reopened?.size) this.mergeWorkshop();
  }
  // Board settings, the running vote or poll, the agenda and its run are
  // each one register, as is whether a discussion is resolved. When two facilitators change one at the same time,
  // one whole value wins and the other's change, such as hiding an object,
  // would be lost. The browser whose change lost puts it back on top of the
  // winning value, field by field as the editor merges queued changes. A
  // change made after seeing this one is left as it is. Likewise a reply
  // reopens a discussion someone resolved at the same moment.
  mergeWorkshop() {
    const changes = new Map();
    for (const [key, write] of this.written || []) {
      const current = this.workshop._map.get(key);
      if (current === write.item) continue;
      this.written.delete(key);
      if (!current || current.deleted || this.follows(current, write.item))
        continue;
      const remote = current.content.getContent().at(-1),
        next = rebaseWorkshop(
          { [key]: write.local },
          write.before === undefined ? {} : { [key]: write.before },
          { [key]: remote },
        )?.[key];
      if (next !== undefined && !equal(next, remote)) changes.set(key, next);
    }
    const reopen = [];
    for (const [entry, item] of this.reopened || []) {
      const current = entry._map.get("resolved");
      if (current === item) continue;
      this.reopened.delete(entry);
      if (
        entry._item?.deleted === false &&
        current &&
        !current.deleted &&
        current.content.getContent().at(-1) === true &&
        !this.follows(current, item)
      )
        reopen.push(entry);
    }
    if (changes.size || reopen.length)
      this.doc.transact(() => {
        for (const [key, value] of changes) this.workshop.set(key, value);
        for (const entry of reopen) entry.set("resolved", false);
      }, REPAIR);
  }
  // Whether a register value was written by someone who had seen `earlier`.
  follows(item, earlier) {
    for (let at = item.origin, n = 0; at && n < 1000; n++) {
      if (Y.compareIDs(at, earlier.id)) return true;
      if (earlier.origin && Y.compareIDs(at, earlier.origin)) return false;
      at = Y.getItem(this.doc.store, at)?.origin;
    }
    return false;
  }
  // Applies an update and reports what it wrote, including values set to
  // what they already were, which still win over concurrent changes: the
  // top-level maps it changed and the workshop registers it set or removed.
  // Applies an update and reports what it wrote to, including values
  // rewritten unchanged, which still win over concurrent edits: the roots,
  // workshop registers, objects (by ID), and comment messages (message IDs
  // by thread).
  applyTracked(bytes, origin = "remote") {
    const roots = new Set(),
      // Every type the update changed, with the keys it changed.
      changes = new Map(),
      workshop = new Set(),
      items = new Set(),
      messages = new Map(),
      // Objects and roots with a register written back with the value it
      // already had, or content inside an object written: changes nobody
      // sees, which still win over others' changes made at the same time.
      rewritten = new Set(),
      rewrittenRoots = new Set();
    const unchanged = (a, b) =>
      a instanceof Y.AbstractType && b instanceof Y.AbstractType
        ? equal(a.toJSON(), b.toJSON())
        : !(a instanceof Y.AbstractType) &&
          !(b instanceof Y.AbstractType) &&
          equal(a, b);
    const message = (thread, id) => {
      if (!messages.has(thread)) messages.set(thread, new Set());
      messages.get(thread).add(id);
    };
    const names = new Map([...this.doc.share].map(([k, v]) => [v, k]));
    const track = (transaction) => {
      for (const [type, keys] of transaction.changed) {
        if (!changes.has(type)) changes.set(type, new Set());
        for (const key of keys) changes.get(type).add(key);
        let root = type;
        const path = [];
        while (root._item) {
          path.unshift(root._item.parentSub);
          root = root._item.parent;
        }
        if (names.has(root)) roots.add(names.get(root));
        const named = [...keys].filter((key) => key !== null);
        if (type === this.workshop) for (const key of named) workshop.add(key);
        if (root === this.items) {
          if (type === this.items) for (const key of named) items.add(key);
          else if (path[0] != null) items.add(path[0]);
        }
        if (root === this.comments && path[1] === "messages") {
          if (path.length === 2) for (const key of named) message(path[0], key);
          else if (path[2] != null) message(path[0], path[2]);
        }
      }
      for (const root of [this.items, this.meta, this.tags, this.timer])
        for (const event of transaction.changedParentTypes.get(root) || []) {
          const target = event.target;
          if (target === this.items) {
            // An object replaced whole, even by an identical copy, drops
            // concurrent edits made to the one it replaces.
            for (const [key, change] of event.keys)
              if (change.action === "update") rewritten.add(key);
          } else if (root === this.items) {
            let entry = target;
            while (entry.parent !== this.items) entry = entry.parent;
            const id = entry._item.parentSub;
            if (target !== entry) rewritten.add(id);
            else
              for (const [key, change] of event.keys)
                if (
                  change.action === "update" &&
                  (change.oldValue instanceof Y.AbstractType ||
                    unchanged(change.oldValue, target.get(key)))
                )
                  rewritten.add(id);
          } else if (root !== this.items)
            for (const [key, change] of event.keys)
              if (
                change.action === "update" &&
                unchanged(change.oldValue, target.get(key))
              )
                rewrittenRoots.add(names.get(root));
        }
    };
    this.doc.on("afterTransaction", track);
    try {
      this.apply(bytes, origin);
    } finally {
      this.doc.off("afterTransaction", track);
    }
    return {
      roots,
      changes,
      workshop,
      items,
      messages,
      rewritten,
      rewrittenRoots,
    };
  }
  // A document projected after every change also keeps its whole state
  // encoded until the next change, as a worker hands it to everyone joining
  // and keeps it after each read of the log, which usually brings nothing.
  // Callers must not change what they are given.
  update(vector) {
    if (vector || !this.read) return Y.encodeStateAsUpdate(this.doc, vector);
    if (this.doc._transactionCleanups.length > 0)
      return Y.encodeStateAsUpdate(this.doc);
    return (this.encoded ??= Y.encodeStateAsUpdate(this.doc));
  }
  vector() {
    return Y.encodeStateVector(this.doc);
  }
  destroy() {
    this.undo.destroy();
    this.doc.destroy();
  }
  // `stacked` is the stacking order as it stood before the change.
  commitContent(board, stacked = this.layered()) {
    const automaticChildren = autoMindChildren(board.items);
    this.doc.transact(() => {
      this.setTimer(board.timer);
      if (this.meta.get("title") !== board.title)
        this.meta.set("title", board.title);
      commitPlanning(this.meta, board);
      const tagIds = new Set((board.tags || []).map((t) => t.id));
      for (const id of this.tags.keys())
        if (!tagIds.has(id)) this.tags.delete(id);
      for (const tag of board.tags || [])
        if (!equal(this.tags.get(tag.id), tag))
          this.tags.set(tag.id, structuredClone(tag));
      const ids = new Set(board.items.map((i) => i.id));
      this.removed = this.tables = null;
      for (const [id, entry] of this.items)
        if (!ids.has(id)) {
          if (entry instanceof Y.Map)
            (this.removed ??= new Map()).set(id, {
              ...this.readItem(id, entry),
              z: entry.get("z"),
              geometryRegister: structuredClone(entry.get("geometry")),
            });
          this.items.delete(id);
        }
      // The stored order is all that is compared, so the board is not
      // projected again for it.
      const oldOrder = stacked.map(([id]) => id).filter((id) => ids.has(id));
      const nextOrder = board.items.map((i) => i.id);
      const reordered = !equal(
        oldOrder,
        nextOrder.filter((id) => this.items.has(id)),
      );
      // Objects keep their layer rank unless they moved: a reorder gives new
      // ranks only to the objects outside the longest run still in their old
      // order, so reorders made at once by others, and objects they added,
      // keep their places.
      const kept = reordered
        ? orderedRun(
            nextOrder.filter((id) => this.items.has(id)),
            new Map(oldOrder.map((id, n) => [id, n])),
          )
        : null;
      const stays = (id) => this.items.has(id) && (!kept || kept.has(id));
      // Each new or moved object goes between its neighbours: the previous
      // one as placed here and the nearest following one that keeps its
      // rank, found in one pass from the end; scanning the rest of the list
      // per object was quadratic for large boards.
      const following = new Array(board.items.length);
      for (let n = board.items.length - 1, z; n >= 0; n--) {
        following[n] = z;
        if (stays(board.items[n].id))
          z = this.items.get(board.items[n].id).get("z") || 0;
      }
      const ranks = new Array(board.items.length);
      let crowded = false;
      board.items.forEach((item, index) => {
        if (stays(item.id)) {
          ranks[index] = this.items.get(item.id).get("z") || 0;
          return;
        }
        const previous = ranks[index - 1],
          next = following[index];
        const z =
          previous === undefined
            ? (next ?? 1) - 1
            : next === undefined
              ? previous + 1
              : (previous + next) / 2;
        // No number is left between them: every object is ranked afresh.
        if (
          !Number.isFinite(z) ||
          (previous !== undefined && z <= previous) ||
          (next !== undefined && z >= next)
        )
          crowded = true;
        ranks[index] = z;
      });
      board.items.forEach((item, index) => {
        let entry = this.items.get(item.id);
        const fresh = !entry;
        if (fresh) {
          entry = new Y.Map();
          this.items.set(item.id, entry);
          entry.set("text", new Y.Text());
        }
        const z = crowded ? index : ranks[index];
        if (entry.get("z") !== z) entry.set("z", z);
        // An object exactly as last read from the document, which nothing has
        // changed since, has nothing to write; comparing it is far cheaper
        // than writing it, so a large board's unchanged objects cost little.
        // Tables and images write more than they read back.
        const read = !fresh && this.deep && this.read.get(item.id);
        if (
          read &&
          item.type !== "table" &&
          item.src === undefined &&
          !entry.has("src") &&
          sameData(read, item)
        )
          return;
        this.writeItem(entry, item, automaticChildren.has(item.id));
      });
    }, LOCAL);
  }
  // Writes one object's stored registers, changing only what differs.
  writeItem(entry, item, automatic = false) {
    const g = Object.fromEntries(
      [...geometry]
        .filter((key) => item[key] !== undefined)
        .map((key) => [key, item[key]]),
    );
    // Automatic child positions are a projection of tree structure. Avoid
    // competing writes of those derived coordinates when clients add nodes.
    const previousGeometry = entry.get("geometry");
    if (
      item.type === "table" &&
      previousGeometry &&
      sharedTableShape(entry, item.cells)
    ) {
      if (item.columnWidths) g.w = previousGeometry.w;
      if (item.rowHeights) g.h = previousGeometry.h;
    }
    if (automatic && previousGeometry) {
      g.x = previousGeometry.x;
      g.y = previousGeometry.y;
    }
    if (!equal(entry.get("geometry"), g))
      entry.set("geometry", structuredClone(g));
    // Keep the legacy mirror for workers/clients awaiting an update. Current
    // clients read the source in geometry so concurrent crops cannot mix it.
    if (item.src === undefined) {
      if (entry.has("src")) entry.delete("src");
    } else if (entry.get("src") !== item.src) entry.set("src", item.src);
    for (const key of fields) {
      if (item[key] === undefined) {
        if (entry.has(key)) entry.delete(key);
      } else if (key === "cells") {
        // A table given new rows or columns gets a new cell map; keep the
        // old one's contents in case undoing this cannot bring it back.
        if (entry.has("cells") && !sharedTableShape(entry, item.cells))
          try {
            const table = {
              type: "table",
              ...previousGeometry,
              cells: sharedCells(entry.get("cells"), entry),
              cellLanguages: sharedCellLanguages(entry.get("cells"), entry),
            };
            readSharedTableSizes(entry, table);
            (this.tables ??= new Map()).set(entry, table);
          } catch {
            /* A malformed table has nothing worth restoring. */
          }
        changeCells(
          entry,
          item.cells,
          changeText,
          changeTextRuns,
          item.cellLanguages,
        );
      } else if (!equal(entry.get(key), item[key]))
        entry.set(key, structuredClone(item[key]));
    }
    changeSharedTableSizes(entry, item);
    changeTagIds(entry, item.tagIds);
    changeText(entry.get("text"), item.text || "");
    changeTextRuns(entry.get("text"), item.textRuns);
    changeTextBlocks(entry, item.textBlocks);
  }
  setWorkshop(workshop = {}) {
    this.doc.transact(() => {
      for (const key of [...this.workshop.keys()])
        if (!Object.hasOwn(workshop, key)) {
          this.workshop.delete(key);
          // A register cleared here has nothing left to keep.
          this.written?.delete(key);
        }
      for (const [key, value] of Object.entries(workshop)) {
        const before = this.workshop.get(key);
        if (equal(before, value)) continue;
        this.workshop.set(key, structuredClone(value));
        // Facilitator registers are remembered until another change to
        // them arrives; see mergeWorkshop.
        if (this.merges && keyKind(key) === key)
          (this.written ??= new Map()).set(key, {
            item: this.workshop._map.get(key),
            before: before === undefined ? undefined : structuredClone(before),
            local: structuredClone(value),
          });
      }
    }, LOCAL);
  }
  setTimer(timer) {
    validateTimer(timer);
    this.doc.transact(() => {
      if (!equal(this.timer.get("state"), timer)) {
        if (timer) this.timer.set("state", structuredClone(timer));
        else this.timer.delete("state");
      }
    }, LOCAL);
  }
}

// Preserve only uncommitted local fields while bringing a remote transaction into the editor.
export function rebase(local, before, remote) {
  const old = new Map(before.items.map((i) => [i.id, i]));
  const mine = new Map(local.items.map((i) => [i.id, i]));
  let items = remote.items
    .filter((i) => !old.has(i.id) || mine.has(i.id))
    .map((item) => {
      const a = old.get(item.id),
        b = mine.get(item.id);
      // The editor and its saved baseline rebase against the same snapshot.
      // Never share newly received objects or nested geometry between them:
      // editing one must not also change the baseline used to detect edits.
      // Boards are plain data, which sharedCopy() copies several times faster
      // than structuredClone() does one object at a time.
      if (!a || !b) return sharedCopy(item);
      const result = sharedCopy(item);
      // Crops and center-pivot rotations belong to their geometry. Keep those
      // values together when queued transforms meet a concurrent resize.
      const transformGeometry =
        (b.type === "image" || a.rotation || b.rotation || item.rotation) &&
        [...geometry].some((key) => !equal(a[key], b[key]));
      const replacedRemotely =
        b.type === "image" && a.src !== item.src && a.src === b.src;
      for (const key of new Set([
        ...Object.keys(a),
        ...Object.keys(b),
        ...(transformGeometry ? geometry : []),
      ])) {
        if (key === "cellLanguages" || (replacedRemotely && geometry.has(key)))
          continue;
        if (
          (transformGeometry && geometry.has(key)) ||
          !equal(a[key], b[key])
        ) {
          if (b[key] === undefined) delete result[key];
          else if (key === "cells" && item.cells)
            result.cells = rebaseCells(b.cells, a.cells, item.cells);
          else result[key] = sharedCopy(b[key]);
        }
      }
      // Formatting changed here while the words changed there: the
      // formatting moves through their edit, so it stays on the same words.
      const was = a.text || "",
        now = item.text || "";
      if (was !== now && was === (b.text || "")) {
        const { start, end, insert } = textDifference(was, now);
        // The words they typed keep the formatting they were typed with.
        if (!equal(a.textRuns, b.textRuns) && b.textRuns?.length)
          result.textRuns = spliceTextRuns(
            b.textRuns,
            start,
            end,
            insert,
            undefined,
            sliceTextRuns(item.textRuns, start, start + insert.length),
          );
        if (!equal(a.textBlocks, b.textBlocks) && b.textBlocks?.length)
          result.textBlocks = spliceTextBlocks(
            was,
            b.textBlocks,
            start,
            end,
            insert,
          );
      }
      if (result.type === "table")
        Object.assign(result, rebaseTableLanguages(result.cells, b, a, item));
      const tagIds = rebaseTagIds(b.tagIds, a.tagIds, item.tagIds);
      if (tagIds.length) result.tagIds = tagIds;
      else delete result.tagIds;
      return rebaseTableSizes(result, b, a, item);
    });
  const surviving = new Map(items.map((i) => [i.id, i]));
  const localOrder = local.items
    .filter((i) => old.has(i.id) && surviving.has(i.id))
    .map((i) => i.id);
  const previousOrder = before.items
    .filter((i) => mine.has(i.id) && surviving.has(i.id))
    .map((i) => i.id);
  if (!equal(localOrder, previousOrder)) {
    // Apply an intentional local reorder only to its surviving objects.
    // Remote-only objects retain their slots and all remote properties survive.
    let index = 0;
    items = items.map((i) =>
      old.has(i.id) ? surviving.get(localOrder[index++]) : i,
    );
  }
  // Place new local objects before their next surviving neighbor, or at the front
  // of the canvas stack when there is no following neighbor.
  const insertions = new Map();
  let anchor = null;
  for (let index = local.items.length - 1; index >= 0; index--) {
    const i = local.items[index];
    if (surviving.has(i.id)) anchor = i.id;
    else if (!old.has(i.id)) {
      if (!insertions.has(anchor)) insertions.set(anchor, []);
      insertions.get(anchor).push(sharedCopy(i));
    }
  }
  items = items.flatMap((i) => [...(insertions.get(i.id)?.reverse() || []), i]);
  items.push(...(insertions.get(null)?.reverse() || []));
  const tags = rebaseTags(local.tags, before.tags, remote.tags);
  const knownTags = new Set(tags.map((t) => t.id));
  for (const i of items)
    if (i.tagIds) {
      i.tagIds = i.tagIds.filter((id) => knownTags.has(id));
      if (!i.tagIds.length) delete i.tagIds;
    }
  return {
    ...remote,
    ...(local.timer || before.timer || remote.timer
      ? { timer: rebaseTimer(local.timer, before.timer, remote.timer) }
      : {}),
    ...(tags.length || local.tags || before.tags || remote.tags
      ? { tags }
      : {}),
    ...(local.workshop || before.workshop || remote.workshop
      ? {
          workshop: rebaseWorkshop(
            local.workshop,
            before.workshop,
            remote.workshop,
          ),
        }
      : {}),
    title: local.title !== before.title ? local.title : remote.title,
    ...rebasePlanning(local, before, remote),
    items,
    ...(local.comments?.length ||
    before.comments?.length ||
    remote.comments?.length
      ? {
          comments: rebaseComments(
            local.comments,
            before.comments,
            remote.comments,
          ),
        }
      : {}),
  };
}
