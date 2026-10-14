import { COLORS, escape } from "../model.js";
import { t, language, plural } from "../i18n.js";
import { objectNameHTML } from "./object-content.js";

// Objects in the order a screen reader meets them: each frame, in the order
// frames are presented, followed by what it holds, then everything outside
// frames. Within each, objects are read as the board is, in rows from the
// top and left to right along a row, whatever order they were added or
// stacked in; connectors follow, as they are described by what they join.
export function outlineOrder(items) {
  const frames = items
    .filter((i) => i.type === "frame")
    .sort((a, b) => (a.order || 0) - (b.order || 0));
  if (!frames.length) return readingOrder(items);
  const held = new Map(frames.map((f) => [f.id, []])),
    rest = [];
  for (const i of items)
    if (i.type !== "frame") (held.get(i.parentId) || rest).push(i);
  return [
    ...frames.flatMap((f) => [f, ...readingOrder(held.get(f.id))]),
    ...readingOrder(rest),
  ];
}
// An object starts a new row unless its top is above the middle of the
// row's first object, so a row of notes a little out of line stays a row.
function readingOrder(items) {
  const lines = [],
    placed = [];
  for (const i of items) (i.type === "arrow" ? lines : placed).push(i);
  placed.sort((a, b) => a.y - b.y || a.x - b.x);
  const ordered = [];
  for (let start = 0; start < placed.length;) {
    const middle = placed[start].y + (placed[start].h || 0) / 2;
    let end = start + 1;
    while (end < placed.length && placed[end].y < middle) end++;
    ordered.push(...placed.slice(start, end).sort((a, b) => a.x - b.x));
    start = end;
  }
  return [...ordered, ...lines];
}

const COLOR_NAMES = ["Butter", "Sage", "Blue", "Lilac", "Peach", "White"];
// A connected object names at most this many objects at each end.
const CONNECTIONS_NAMED = 5;

// Only pass the objects this person may read, with private content masked.
// A relationship must never recover a name from the unfiltered board.
// `tags` is the board's tag catalog and `comments` its discussions, so an
// object says what the canvas shows on it: its colour, tags, connections,
// and open discussions.
export function objectRelationships(items, { tags = [], comments = [] } = {}) {
  const byId = new Map(items.map((i) => [i.id, i]));
  const groups = new Map();
  const children = new Map();
  // Connections each way, by the connector's own place on the board.
  const outgoing = new Map(),
    incoming = new Map();
  const add = (map, id, other) => {
    if (!map.has(id)) map.set(id, []);
    map.get(id).push(other);
  };
  const tagNames = new Map(tags.map((tag) => [tag.id, tag.name]));
  const discussions = new Map();
  for (const thread of comments)
    if (
      thread.anchorId &&
      !thread.resolved &&
      thread.messages.some((m) => !m.deleted)
    )
      discussions.set(
        thread.anchorId,
        (discussions.get(thread.anchorId) || 0) + 1,
      );
  for (const i of items) {
    if (i.type === "arrow" && i.startId && i.endId) {
      add(outgoing, i.startId, i.endId);
      add(incoming, i.endId, i.startId);
    }
    if (i.groupId) {
      if (!groups.has(i.groupId))
        groups.set(i.groupId, { number: groups.size + 1, count: 0 });
      groups.get(i.groupId).count++;
    }
    if (i.parentId)
      children.set(i.parentId, (children.get(i.parentId) || 0) + 1);
  }
  const label = (value) => escape(t(value));
  // French sets a colon apart with a space.
  const colon = language === "fr" ? " :" : ":";
  const count = (n) =>
    `${n} ${label(n === 1 ? "visible object" : "visible objects")}`;
  // A frame holding hundreds of objects is named once for all of them.
  const names = new Map();
  const name = (id) => {
    if (names.has(id)) return names.get(id);
    const target = byId.get(id);
    const html = target ? objectNameHTML(target, 120) : label("Hidden object");
    names.set(id, html);
    return html;
  };
  const cap = (value) =>
    label(
      value === "arrow" ? "Arrowhead" : value === "circle" ? "Dot" : "None",
    );
  const connected = (ids) => {
    const shown = ids.slice(0, CONNECTIONS_NAMED).map(name).join(", ");
    return ids.length > CONNECTIONS_NAMED
      ? `${shown} ${escape(plural(ids.length - CONNECTIONS_NAMED, "and {count} more", "and {count} more"))}`
      : shown;
  };
  const describe = (i) => {
    const parts = [];
    // Colour often carries meaning, as a retrospective's columns do; a
    // shape left white says nothing by it.
    const color = COLORS.indexOf(i.color);
    if (
      color >= 0 &&
      (i.type === "note" ||
        (["rect", "ellipse", "shape"].includes(i.type) &&
          COLOR_NAMES[color] !== "White"))
    )
      parts.push(`${label(`${COLOR_NAMES[color]} color`)}.`);
    const tagged = (i.tagIds || []).filter((id) => tagNames.has(id));
    if (tagged.length)
      parts.push(
        `${label(tagged.length === 1 ? "Tag" : "Tags")}${colon} ${tagged
          .map(
            (id) =>
              `<span data-user-content>${escape(tagNames.get(id))}</span>`,
          )
          .join(", ")}.`,
      );
    if (i.parentId)
      parts.push(`${label("In frame")}${colon} ${name(i.parentId)}.`);
    if (i.type === "frame" && children.has(i.id))
      parts.push(`${label("Contains")}${colon} ${count(children.get(i.id))}.`);
    if (i.groupId) {
      const group = groups.get(i.groupId);
      parts.push(
        `${label("Group")} ${group.number}${colon} ${count(group.count)}.`,
      );
    }
    if (outgoing.has(i.id))
      parts.push(
        `${label("Connects to")}${colon} ${connected(outgoing.get(i.id))}.`,
      );
    if (incoming.has(i.id))
      parts.push(
        `${label("Connected from")}${colon} ${connected(incoming.get(i.id))}.`,
      );
    if (discussions.has(i.id)) {
      const n = discussions.get(i.id);
      parts.push(
        `${n} ${label(n === 1 ? "open discussion" : "open discussions")}.`,
      );
    }
    if (i.mindMap?.parent)
      parts.push(
        `${label("Mind map parent")}${colon} ${name(i.mindMap.parent)}.`,
      );
    if (i.type === "arrow") {
      parts.push(
        `${label("Start object")}${colon} ${i.startId ? name(i.startId) : label("Free endpoint")}.`,
      );
      parts.push(
        `${label("End object")}${colon} ${i.endId ? name(i.endId) : label("Free endpoint")}.`,
      );
      parts.push(
        `${label("Start")}${colon} ${cap(i.startCap || "none")}. ${label("End")}${colon} ${cap(i.endCap || "arrow")}.`,
      );
    }
    return parts.join(" ");
  };
  // Each description is written when first asked for: a long outline is
  // written a part at a time, and the objects dialog shows a few hundred.
  const descriptions = new Map();
  return {
    get(id) {
      if (!descriptions.has(id) && byId.has(id))
        descriptions.set(id, describe(byId.get(id)));
      return descriptions.get(id);
    },
  };
}
