// Where an object added without a pointer goes, as from a shortcut, the
// command search or the shapes picker: the spot asked for, or else the
// nearest one in view that nothing else covers. Several people adding sticky
// notes from the keyboard while they look at the same place, as when they
// follow a facilitator, or one person adding a few in a row, then see each
// note beside the others rather than only the last one on top of them.
// Frames and connectors may lie under a new object, and lie across the
// whole of a section, so they never count as covering a spot.
const UNDERNEATH = new Set(["frame", "arrow"]);
// Up to this many steps out from the spot asked for, in each direction.
const RINGS = 6;
// Then beside up to this many of the nearest objects.
const NEIGHBOURS = 40;
// `turn`, a fraction of a full turn, starts the search in another
// direction, so people adding notes at the same moment, before each sees the
// others', mostly take different spots around the same middle.
export function freeSpot(
  items,
  box,
  view,
  { gap = 24, margin = 8, turn = 0 } = {},
) {
  const inside = (b) =>
    b.x >= view.x &&
    b.y >= view.y &&
    b.x + b.w <= view.x + view.w &&
    b.y + b.h <= view.y + view.h;
  // Only objects near the view can cover a spot in it.
  const reach = {
    x: Math.min(view.x, box.x) - margin,
    y: Math.min(view.y, box.y) - margin,
    r: Math.max(view.x + view.w, box.x + box.w) + margin,
    b: Math.max(view.y + view.h, box.y + box.h) + margin,
  };
  const solid = [];
  for (const i of items) {
    if (UNDERNEATH.has(i.type)) continue;
    const x = Math.min(i.x, i.x + i.w),
      y = Math.min(i.y, i.y + i.h),
      r = Math.max(i.x, i.x + i.w),
      b = Math.max(i.y, i.y + i.h);
    if (r < reach.x || x > reach.r || b < reach.y || y > reach.b) continue;
    solid.push({ x, y, r, b });
  }
  const free = (c) =>
    !solid.some(
      (s) =>
        c.x < s.r + margin &&
        c.x + c.w > s.x - margin &&
        c.y < s.b + margin &&
        c.y + c.h > s.y - margin,
    );
  const start = { x: box.x, y: box.y, w: box.w, h: box.h };
  if (free(start)) return { x: box.x, y: box.y };
  // Nearest first; at the same distance, to the right, then below, then
  // around clockwise, as reading continues, from where `turn` starts.
  const cells = [];
  for (let dy = -RINGS; dy <= RINGS; dy++)
    for (let dx = -RINGS; dx <= RINGS; dx++)
      if (dx || dy)
        cells.push({
          dx,
          dy,
          d: dx * dx + dy * dy,
          a:
            (Math.atan2(dy, dx) - 2 * Math.PI * turn + 4 * Math.PI) %
            (2 * Math.PI),
        });
  cells.sort((p, q) => p.d - q.d || p.a - q.a);
  for (const { dx, dy } of cells) {
    const c = {
      x: box.x + dx * (box.w + gap),
      y: box.y + dy * (box.h + gap),
      w: box.w,
      h: box.h,
    };
    if (inside(c) && free(c)) return { x: c.x, y: c.y };
  }
  // Steps of a large object's own size soon leave the view; the nearest
  // spot just beside one of the objects nearby may still be free.
  const near = (s) =>
    Math.hypot(
      (s.x + s.r) / 2 - (box.x + box.w / 2),
      (s.y + s.b) / 2 - (box.y + box.h / 2),
    );
  const beside = solid
    .map((s) => ({ s, d: near(s) }))
    .sort((p, q) => p.d - q.d)
    .slice(0, NEIGHBOURS)
    .flatMap(({ s }) => [
      { x: s.r + gap, y: box.y },
      { x: box.x, y: s.b + gap },
      { x: s.x - gap - box.w, y: box.y },
      { x: box.x, y: s.y - gap - box.h },
    ])
    .map((c) => ({ ...c, w: box.w, h: box.h }))
    .filter((c) => inside(c) && free(c))
    .sort(
      (p, q) =>
        Math.hypot(p.x - box.x, p.y - box.y) -
        Math.hypot(q.x - box.x, q.y - box.y),
    );
  if (beside.length) return { x: beside[0].x, y: beside[0].y };
  // A view with no room left keeps the spot asked for.
  return { x: box.x, y: box.y };
}

// Where a block of new frames, as an imported document, goes when asked to
// start at `box`: there, or else just right of what it would overlap, so it
// neither covers the board's content nor hides under it. Frames count here,
// as frames laid over others would seem to belong to them.
export function clearSpot(items, box, { gap = 80 } = {}) {
  const solid = [];
  for (const i of items) {
    if (i.type === "arrow") continue;
    solid.push({
      x: Math.min(i.x, i.x + i.w),
      y: Math.min(i.y, i.y + i.h),
      r: Math.max(i.x, i.x + i.w),
      b: Math.max(i.y, i.y + i.h),
    });
  }
  let x = box.x;
  // Each step moves past at least one object, so this ends.
  for (let n = 0; n <= solid.length; n++) {
    let right = -Infinity;
    for (const s of solid)
      if (
        x < s.r + gap &&
        x + box.w > s.x - gap &&
        box.y < s.b + gap &&
        box.y + box.h > s.y - gap
      )
        right = Math.max(right, s.r);
    if (right === -Infinity) break;
    x = right + gap;
  }
  return { x, y: box.y };
}
