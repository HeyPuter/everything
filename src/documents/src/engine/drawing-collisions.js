// Non-overlapping floating drawings are resolved in anchor/source order,
// before paint order is applied. Native controls show inclusive twip edges:
// touching frames retain one twip of overlap (ECMA-376 20.4.2.3 divergence).
const TWIP = 1 / 15;
const intersects = (a, b) => Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > TWIP + 1e-7 &&
  Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > TWIP + 1e-7;

export function resolveDrawingCollisions(frames, pages) {
  if (!frames.some(f => f.image.anchor.allowOverlap === false)) return;
  const byPage = new Map();
  for (const frame of frames) {
    if (frame.image.hidden) continue;
    const earlier = byPage.get(frame.page) || [];
    const obstacles = earlier.filter(other => frame.image.anchor.allowOverlap === false || other.image.anchor.allowOverlap === false);
    // Moving right or down is monotonic. Revisit earlier obstacles after each
    // displacement, since clearing one object can enter another object's box.
    for (let pass = 0; pass <= obstacles.length * 2; pass++) {
      const obstacle = obstacles.find(other => intersects(frame, other));
      if (!obstacle) break;
      if (frame.image.anchor.wrap !== 'none' || obstacle.image.anchor.wrap !== 'none') throw new Error('Collision displacement involving text-wrapped drawings is not supported yet.');
      const x = obstacle.x + obstacle.width - TWIP;
      if (x + frame.width <= pages[frame.page].width + 1e-7) frame.x = x;
      else frame.y = obstacle.y + obstacle.height - TWIP;
      if (pass === obstacles.length * 2) throw new Error('Drawing collisions could not be resolved.');
    }
    earlier.push(frame); byPage.set(frame.page, earlier);
  }
}
