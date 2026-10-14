// Sections as the slide sorter edits them: an ordered list of
// { name, slides: [part names] } whose slides, read in order, are the deck's
// slide order. A deck without sections is one unnamed group.

// The deck's slides grouped by section. Slides a section list leaves out
// (a damaged file, or a slide added without a section) join the section of
// the slide before them, or the first section.
export function groupSlides(order, sections) {
  if (!sections?.length) return [{ name: null, slides: [...order] }];
  const owner = new Map();
  sections.forEach((sec, i) =>
    sec.slides.forEach((part) => {
      if (!owner.has(part)) owner.set(part, i);
    }),
  );
  const groups = sections.map((sec) => ({ name: sec.name, slides: [] }));
  let last = 0;
  for (const part of order) {
    const i = owner.has(part) ? owner.get(part) : last;
    groups[i].slides.push(part);
    last = i;
  }
  return groups;
}

const flatten = (groups) => groups.flatMap((g) => g.slides);
const result = (groups) => ({
  order: flatten(groups),
  sections:
    groups.length === 1 && groups[0].name === null
      ? []
      : groups.map((g) => ({
          name: g.name ?? "Default Section",
          slides: g.slides,
        })),
});

// Moves the slides in `moving` (kept in deck order) into group `section`,
// before the slide `before` (or to the end of the group).
export function moveSlidesTo(
  order,
  sections,
  moving,
  { section, before = null },
) {
  const groups = groupSlides(order, sections);
  const chosen = order.filter((p) => moving.has(p));
  if (!chosen.length || !groups[section]) return null;
  for (const g of groups) g.slides = g.slides.filter((p) => !moving.has(p));
  const target = groups[section].slides;
  const at = before && !moving.has(before) ? target.indexOf(before) : -1;
  target.splice(at < 0 ? target.length : at, 0, ...chosen);
  const next = result(groups);
  const same =
    next.order.every((p, i) => p === order[i]) &&
    JSON.stringify(next.sections) ===
      JSON.stringify(result(groupSlides(order, sections)).sections);
  return same ? null : next;
}

// A new section that starts at slide `part`, taking it and the slides after
// it in its section.
export function addSectionAt(order, sections, part, name) {
  const groups = groupSlides(order, sections);
  if (!sections?.length) {
    const at = Math.max(0, order.indexOf(part));
    return result(
      at > 0
        ? [
            { name: "Default Section", slides: order.slice(0, at) },
            { name, slides: order.slice(at) },
          ]
        : [{ name, slides: [...order] }],
    );
  }
  const i = groups.findIndex((g) => g.slides.includes(part));
  if (i < 0) return result([...groups, { name, slides: [] }]);
  const k = groups[i].slides.indexOf(part);
  const head = { name: groups[i].name, slides: groups[i].slides.slice(0, k) };
  const tail = { name, slides: groups[i].slides.slice(k) };
  groups.splice(i, 1, ...(head.slides.length ? [head, tail] : [tail]));
  return result(groups);
}

export function renameSectionAt(order, sections, i, name) {
  const groups = groupSlides(order, sections);
  if (!groups[i] || !name) return null;
  groups[i].name = name;
  return result(groups);
}

// A section moves past its neighbour, its slides with it.
export function moveSectionBy(order, sections, i, direction) {
  const groups = groupSlides(order, sections);
  const j = i + direction;
  if (!sections?.length || j < 0 || j >= groups.length) return null;
  [groups[i], groups[j]] = [groups[j], groups[i]];
  return result(groups);
}

// Removing a section keeps its slides in the section before it (or after
// it, for the first section); with `withSlides` they go too and are listed
// in `removed`. Removing the last section leaves the deck without any.
export function removeSectionAt(
  order,
  sections,
  i,
  { withSlides = false } = {},
) {
  const groups = groupSlides(order, sections);
  if (!sections?.length || !groups[i]) return null;
  const [gone] = groups.splice(i, 1);
  if (withSlides) {
    const next = result(groups.length ? groups : [{ name: null, slides: [] }]);
    return { ...next, removed: gone.slides };
  }
  if (!groups.length) return { order: gone.slides, sections: [], removed: [] };
  if (i > 0) groups[i - 1].slides.push(...gone.slides);
  else groups[0].slides.unshift(...gone.slides);
  return { ...result(groups), removed: [] };
}

export function removeAllSections(order) {
  return { order: [...order], sections: [] };
}
