// ECMA-376 §17.4.56: either table can disallow overlap. Displacement follows
// native reference controls: try the right side, then the next available row.
const gap = value => Math.max(12, value || 0) / 15;
export function avoidTableOverlap(frame, previous, page) {
  if (!previous.length) return frame;
  let placed = { ...frame };
  const width = frame.right - frame.left, height = frame.bottom - frame.top;
  const candidates = previous.filter(f => f.page === frame.page && (f.overlap === 'never' || frame.overlap === 'never'));
  // Each downward move reaches a new obstacle bottom; at that height the
  // horizontal scan can encounter the earlier, taller obstacles again.
  for (let attempt = 0; attempt < (candidates.length + 1) ** 2; attempt++) {
    const hit = candidates.find(f => placed.left < f.right + 12 / 15 + gap(f.position.rightFromText) + gap(placed.position.leftFromText)
      && placed.right + 12 / 15 + gap(placed.position.rightFromText) + gap(f.position.leftFromText) > f.left
      && placed.top < f.bottom + (f.position.bottomFromText + placed.position.topFromText) / 15
      && placed.bottom > f.top - (f.position.topFromText + placed.position.bottomFromText) / 15);
    if (!hit) return placed;
    let left = hit.right + 12 / 15 + gap(hit.position.rightFromText) + gap(placed.position.leftFromText);
    let top = placed.top;
    if (left + width + gap(placed.position.rightFromText) > page.width - page.right) {
      left = Math.min(page.left + Math.max(10, placed.position.leftFromText) / 15,
        page.width - page.right - width - 12 / 15 - gap(placed.position.rightFromText));
      top = hit.bottom + (hit.position.bottomFromText + placed.position.topFromText) / 15;
    }
    placed = { ...placed, left, right: left + width, top, bottom: top + height };
  }
  throw new Error('Floating-table collision placement did not converge.');
}

const clip = (value, dx, dy) => ({ ...value, ...Object.fromEntries(['left','right','top','bottom']
  .filter(k => value[k] !== undefined).map(k => [k,value[k]+(['left','right'].includes(k)?dx:dy)])) });
export function shiftTableItem(item, dx, dy, shared = new Map()) {
  if (!dx && !dy) return item;
  const moved = { ...item };
  for (const key of ['x','columnLeft','hangingRight']) if (item[key] !== undefined) moved[key] += dx;
  for (const key of ['y','baseline']) if (item[key] !== undefined) moved[key] += dy;
  for (const key of ['cellClip','textClip']) if (item[key]) moved[key] = clip(item[key],dx,dy);
  for (const key of ['fragments','stops','underlines','strikes','backgrounds','leaders','bars']) if (item[key]) moved[key] = item[key].map(f => {
    if (!shared.has(f)) shared.set(f, { ...f, x:f.x+dx });
    return shared.get(f);
  });
  if (item.wrapSegments) moved.wrapSegments = item.wrapSegments.map(s => shiftTableItem(s,dx,dy,shared));
  for (const key of ['marker','paragraphBackground','paragraphFrame']) if (item[key]) moved[key] = { ...item[key], x:item[key].x+dx, ...(item[key].right === undefined ? {} : { right:item[key].right+dx }) };
  return moved;
}
