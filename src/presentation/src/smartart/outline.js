// A SmartArt graphic's text as an outline: a flat list of items, each with
// its text and level, as the Text Pane shows it. An item's subtree is the
// run of items after it at deeper levels. These are the edits the Text Pane
// and the SmartArt Design tab make, as pure functions from one list to the
// next.

const copy = (items) => items.map((i) => ({ text: i.text, level: i.level }));

// The first item sits at the top level and no item is more than one level
// deeper than the one before it.
export function normalize(items) {
  const out = [];
  let prev = -1;
  for (const item of items) {
    const level = Math.max(0, Math.min(item.level | 0, prev + 1));
    out.push({ text: String(item.text ?? ""), level });
    prev = level;
  }
  return out;
}
// The index just past item i's subtree.
export function subtreeEnd(items, i) {
  let j = i + 1;
  while (j < items.length && items[j].level > items[i].level) j++;
  return j;
}
const blank = (level) => ({ text: "", level });

// A sibling after the item and its subtree.
export function addAfter(items, i) {
  if (!items.length) return { items: [blank(0)], index: 0 };
  const at = subtreeEnd(items, i);
  const out = copy(items);
  out.splice(at, 0, blank(items[i].level));
  return { items: out, index: at };
}
// A sibling before the item.
export function addBefore(items, i) {
  if (!items.length) return { items: [blank(0)], index: 0 };
  const out = copy(items);
  out.splice(i, 0, blank(items[i].level));
  return { items: out, index: i };
}
// A new parent above the item: the item and its subtree move down a level.
export function addAbove(items, i) {
  if (!items.length) return { items: [blank(0)], index: 0 };
  const end = subtreeEnd(items, i);
  const out = copy(items);
  for (let j = i; j < end; j++) out[j].level++;
  out.splice(i, 0, blank(items[i].level));
  return { items: normalize(out), index: i };
}
// A new child below the item, after its other children.
export function addBelow(items, i) {
  if (!items.length) return { items: [blank(0)], index: 0 };
  const at = subtreeEnd(items, i);
  const out = copy(items);
  out.splice(at, 0, blank(items[i].level + 1));
  return { items: out, index: at };
}
export const canPromote = (items, i) => !!items[i] && items[i].level > 0;
export function promote(items, i) {
  if (!canPromote(items, i)) return { items, index: i };
  const end = subtreeEnd(items, i);
  const out = copy(items);
  for (let j = i; j < end; j++) out[j].level--;
  return { items: normalize(out), index: i };
}
export const canDemote = (items, i) =>
  i > 0 && !!items[i] && items[i - 1].level >= items[i].level;
export function demote(items, i) {
  if (!canDemote(items, i)) return { items, index: i };
  const end = subtreeEnd(items, i);
  const out = copy(items);
  for (let j = i; j < end; j++) out[j].level++;
  return { items: normalize(out), index: i };
}
// The sibling before, or after, the item: the start of its subtree.
function previousSibling(items, i) {
  for (let j = i - 1; j >= 0; j--) {
    if (items[j].level === items[i].level) return j;
    if (items[j].level < items[i].level) return -1;
  }
  return -1;
}
export const canMoveUp = (items, i) =>
  !!items[i] && previousSibling(items, i) >= 0;
export const canMoveDown = (items, i) => {
  if (!items[i]) return false;
  const end = subtreeEnd(items, i);
  return end < items.length && items[end].level === items[i].level;
};
export function moveUp(items, i) {
  const p = previousSibling(items, i);
  if (p < 0) return { items, index: i };
  const end = subtreeEnd(items, i);
  const out = [
    ...copy(items.slice(0, p)),
    ...copy(items.slice(i, end)),
    ...copy(items.slice(p, i)),
    ...copy(items.slice(end)),
  ];
  return { items: out, index: p };
}
export function moveDown(items, i) {
  if (!canMoveDown(items, i)) return { items, index: i };
  const end = subtreeEnd(items, i);
  const nextEnd = subtreeEnd(items, end);
  const out = [
    ...copy(items.slice(0, i)),
    ...copy(items.slice(end, nextEnd)),
    ...copy(items.slice(i, end)),
    ...copy(items.slice(nextEnd)),
  ];
  return { items: out, index: i + (nextEnd - end) };
}
// Removes the item; its children move up to take its place.
export function removeItem(items, i) {
  if (!items[i]) return { items, index: i };
  const end = subtreeEnd(items, i);
  const out = copy(items);
  for (let j = i + 1; j < end; j++) out[j].level--;
  out.splice(i, 1);
  return {
    items: normalize(out),
    index: Math.max(0, Math.min(i - 1, out.length - 1)),
  };
}

/* ---------- Text Pane editing ---------- */
// Enter: the text after the caret starts a new item at the same level.
export function splitItem(items, i, caret) {
  const out = copy(items);
  const text = out[i].text;
  out[i].text = text.slice(0, caret);
  out.splice(i + 1, 0, { text: text.slice(caret), level: out[i].level });
  return { items: out, index: i + 1, caret: 0 };
}
// Backspace at the start of an item joins it to the item before.
export function joinWithPrevious(items, i) {
  if (i <= 0) return { items, index: i, caret: 0 };
  const out = copy(items);
  const caret = out[i - 1].text.length;
  out[i - 1].text += out[i].text;
  out.splice(i, 1);
  return { items: normalize(out), index: i - 1, caret };
}
// Tab and Shift+Tab in the Text Pane move one line in or out; the lines
// below keep their place in the outline.
export function indentLine(items, i, delta) {
  const out = copy(items);
  const prev = i > 0 ? out[i - 1].level : -1;
  const next = Math.max(0, Math.min(out[i].level + delta, prev + 1));
  if (next === out[i].level) return { items, index: i };
  out[i].level = next;
  return { items: normalize(out), index: i };
}

// Paragraphs of a bulleted text box, as outline items.
export function itemsFromParagraphs(paragraphs) {
  return normalize(
    paragraphs
      .map((p) => ({ text: p.text.replace(/\s+$/u, ""), level: p.level || 0 }))
      .filter((p) => p.text.trim() !== ""),
  );
}
