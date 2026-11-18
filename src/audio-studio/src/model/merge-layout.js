// A merge bakes only the selected audio. Keep its old overlap geometry so
// replacing several rectangles with one does not also change its neighbors.
// These layers contain no media: unselected clips retain their own audio.
// Geometry anchors release an old relationship when either clip is placed
// elsewhere or trimmed. Moving/copying an arrangement together remaps it.
const geometry = (c) => ({ id: c.id, trackId: c.trackId, start: c.start, length: c.length, z: c.z });
const same = (c, anchor) => c && Object.keys(anchor).every((key) => c[key] === anchor[key]);
const ownerAnchor = (c) => ({ ...geometry(c), offset: c.offset, loop: c.loop });
const overlaps = (a, b) => a.start < b.start + b.length && b.start < a.start + a.length;

export function copyMergeLayout(value) {
  if (!value || !value.anchor || !Array.isArray(value.neighbors) || !Array.isArray(value.layers)) return null;
  const valid = (c) => c && typeof c.id === 'string' && typeof c.trackId === 'string' &&
    ['start', 'length', 'z'].every((key) => Number.isFinite(c[key])) && c.start >= 0 && c.length > 0;
  if (!valid(value.anchor) || !value.neighbors.every(valid) || !value.layers.every((c) => c &&
    Number.isFinite(c.start) && Number.isFinite(c.length) && c.length > 0 && Number.isFinite(c.z) && Number.isFinite(c.position) && typeof c.origin === 'string' &&
    Array.isArray(c.bounds) && c.bounds.length === 2 && c.bounds.every(Number.isFinite) && c.bounds[1] > c.bounds[0] &&
    Array.isArray(c.targets) && c.targets.every((id) => typeof id === 'string') &&
    Array.isArray(c.front) && c.front.every((id) => typeof id === 'string') && c.fadeIn && c.fadeOut)) return null;
  return structuredClone(value);
}

/** Expand planning-only layers. `interacts` excludes already-baked pairs. */
export function mergeScene(clips) {
  const byId = new Map(clips.map((c) => [c.id, c]));
  const contexts = new Map(), ghosts = new Map(), before = new Map(), spans = new Map();
  for (const c of clips) {
    const layout = c.mergeLayout;
    if (!layout || !same(c, layout.anchor)) continue;
    const neighbors = new Set(layout.neighbors.filter((n) => same(byId.get(n.id), n)).map((n) => n.id));
    if (!neighbors.size) continue;
    contexts.set(c.id, neighbors);
    layout.layers.forEach((layer, index) => {
      const targets = new Set(layer.targets.filter((id) => neighbors.has(id)));
      if (!targets.size) return;
      const bounds = [Math.max(layer.start, layer.bounds?.[0] ?? layer.start, c.start),
        Math.min(layer.start + layer.length, layer.bounds?.[1] ?? layer.start + layer.length, c.start + c.length)];
      if (bounds[1] <= bounds[0]) return;
      let id = `${c.id}:merged:${index}`;
      while (byId.has(id) || ghosts.has(id)) id += ':';
      const ghost = { ...layer, id, trackId: c.trackId, mute: c.mute, bounds };
      const key = JSON.stringify([c.trackId, layer.origin, Boolean(c.mute)]);
      const span = spans.get(key);
      if (span) { span.start = Math.min(span.start, bounds[0]); span.end = Math.max(span.end, bounds[1]); span.clips.push(ghost); }
      else spans.set(key, { start: bounds[0], end: bounds[1], clips: [ghost] });
      ghosts.set(id, { owner: c.id, index, targets, layer, front: new Set(layer.front) });
      const next = byId.has(layer.before) ? layer.before : null;
      if (!before.has(next)) before.set(next, []);
      before.get(next).push(ghost);
    });
  }
  // Split pieces share a layer's origin. Their combined extent retains the old fade
  // geometry; removing an end piece shortens it, while each piece masks only
  // the interval it still occupies. The original media is never needed here.
  for (const span of spans.values()) for (const c of span.clips) {
    c.start = span.start;
    c.length = span.end - span.start;
  }
  for (const group of before.values()) group.sort((a, b) => a.position - b.position);
  const list = clips.flatMap((c) => [...(before.get(c.id) || []), c]);
  list.push(...(before.get(null) || []));
  const interacts = (a, b) => {
    const ga = ghosts.get(a.id), gb = ghosts.get(b.id);
    if (ga && gb) return false;
    if (ga) return ga.targets.has(b.id);
    if (gb) return gb.targets.has(a.id);
    return !contexts.get(a.id)?.has(b.id) && !contexts.get(b.id)?.has(a.id);
  };
  const order = new Map(clips.map((c, i) => [c.id, c.z * 1e6 + i]));
  const inFront = (a, b) => {
    const ga = ghosts.get(a.id), gb = ghosts.get(b.id);
    if (ga) return ga.front.has(b.id);
    if (gb) return !gb.front.has(a.id);
    return order.get(a.id) >= order.get(b.id);
  };
  return { list, ghosts, contexts, interacts, inFront };
}

/** Replace selected clips, preserving their audible relationships with neighbors. */
export function mergeWithLayout(state, ids, merged) {
  const track = state.clips.filter((c) => c.trackId === merged.trackId);
  const scene = mergeScene(track);
  const selected = track.filter((c) => ids.has(c.id));
  const front = selected.reduce((a, b) => scene.inFront(a, b) ? a : b);
  const removed = (c) => ids.has(scene.ghosts.get(c.id)?.owner || c.id);
  const external = track.filter((c) => !ids.has(c.id));
  const layers = [];
  const byStart = external.slice().sort((a, b) => a.start - b.start);
  let maxLength = 0;
  for (const c of external) maxLength = Math.max(maxLength, c.length);
  const neighbors = new Set(external.filter((c) => overlaps(c, merged)).map((c) => c.id));
  const following = new Map();
  let next = null;
  for (let i = scene.list.length - 1; i >= 0; i--) {
    following.set(i, next);
    const c = scene.list[i];
    if (!scene.ghosts.has(c.id) && !ids.has(c.id)) next = c.id;
  }
  const nextReal = (index) => following.get(index);
  for (let i = 0; i < scene.list.length; i++) {
    const c = scene.list[i];
    if (!removed(c) || c.mute) continue;
    const targets = [], frontTargets = [];
    let lo = 0, hi = byStart.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (byStart[mid].start <= c.start - maxLength) lo = mid + 1;
      else hi = mid;
    }
    for (let j = lo; j < byStart.length && byStart[j].start < c.start + c.length; j++) {
      const other = byStart[j];
      if (!overlaps(c, other)) continue;
      // Even an ignored real pair needs to stay ignored after merging again.
      if (!scene.ghosts.has(c.id)) neighbors.add(other.id);
      if (scene.interacts(c, other)) {
        targets.push(other.id);
        if (scene.inFront(c, other)) frontTargets.push(other.id);
        neighbors.add(other.id);
      }
    }
    const original = scene.ghosts.get(c.id)?.layer || c;
    if (targets.length) layers.push({ start: original.start, length: original.length, z: c.z,
      origin: original.origin || c.id, bounds: c.bounds || [c.start, c.start + c.length],
      fadeIn: { ...c.fadeIn }, fadeOut: { ...c.fadeOut }, crossfade: c.crossfade,
      position: i, targets, front: frontTargets, before: nextReal(i) });
  }
  merged = { ...merged, z: front.z };
  if (neighbors.size) merged.mergeLayout = { anchor: ownerAnchor(merged),
    neighbors: external.filter((c) => neighbors.has(c.id)).map(geometry), layers };
  // Equal-geometry fades resolve in list order. Preserve that order even
  // when virtual layers from several earlier merges share an insertion point.
  const layerPositions = new Map();
  scene.list.forEach((c, index) => {
    const ghost = scene.ghosts.get(c.id);
    if (!ghost) return;
    if (!layerPositions.has(ghost.owner)) layerPositions.set(ghost.owner, new Map());
    layerPositions.get(ghost.owner).set(ghost.index, index);
  });
  const retain = (c) => {
    const positions = layerPositions.get(c.id);
    if (!positions) return c;
    const layers = c.mergeLayout.layers.map((layer, index) => positions.has(index)
      ? { ...layer, position: positions.get(index), before: nextReal(positions.get(index)) }
      : layer);
    if (layers.every((layer, i) => layer.position === c.mergeLayout.layers[i].position && layer.before === c.mergeLayout.layers[i].before)) return c;
    return { ...c, mergeLayout: { ...c.mergeLayout, layers } };
  };
  return { ...state, clips: state.clips.flatMap((c) => c.id === front.id ? [merged] : ids.has(c.id) ? [] : [retain(c)]) };
}

/** Carry overlap geometry when an arrangement is moved or copied together. */
export function relocateMergeLayouts(originals, replacements) {
  if (!originals.some((c) => c.mergeLayout)) return replacements;
  const old = new Map(originals.map((c) => [c.id, c]));
  const moved = new Map(originals.map((c, i) => [c.id, replacements[i]]));
  const copied = originals.some((c, i) => c.id !== replacements[i].id);
  const origins = new Map();
  const copyOrigin = (origin) => {
    if (!copied) return origin;
    if (!origins.has(origin)) origins.set(origin, `${replacements[0].id}:layer:${origins.size}`);
    return origins.get(origin);
  };
  return originals.map((c, index) => {
    const result = replacements[index], layout = c.mergeLayout;
    if (!layout) return result;
    if (!same(c, layout.anchor) || c.length !== result.length || c.offset !== result.offset || c.loop !== result.loop) return { ...result, mergeLayout: null };
    const dt = result.start - c.start;
    const neighbors = layout.neighbors.filter((n) => {
      const next = moved.get(n.id);
      return same(old.get(n.id), n) && next && next.start === n.start + dt && next.length === n.length && next.trackId === result.trackId;
    });
    if (!neighbors.length) return { ...result, mergeLayout: null };
    const ids = new Map(neighbors.map((n) => [n.id, moved.get(n.id).id]));
    const remap = (list) => list.filter((id) => ids.has(id)).map((id) => ids.get(id));
    const layers = layout.layers.map((layer) => ({ ...layer, start: layer.start + dt,
      origin: copyOrigin(layer.origin),
      bounds: layer.bounds.map((at) => at + dt),
      targets: remap(layer.targets), front: remap(layer.front), before: moved.get(layer.before)?.id || null,
    })).filter((layer) => layer.targets.length);
    return { ...result, mergeLayout: { anchor: ownerAnchor(result), neighbors: neighbors.map((n) => geometry(moved.get(n.id))), layers } };
  });
}

/** Splitting retains a baked arrangement; the pieces share its layer origins. */
export function splitMergeLayout(clip, pieces) {
  if (!clip.mergeLayout || !same(clip, clip.mergeLayout.anchor)) return pieces;
  return pieces.map((c) => ({ ...c, mergeLayout: { ...clip.mergeLayout, anchor: ownerAnchor(c) } }));
}

/** Existing merges still refer to both pieces of a neighbor split in place. */
export function retargetSplitLayouts(clips, splits) {
  return clips.map((c) => {
    const layout = c.mergeLayout;
    if (!layout) return c;
    const ids = new Map();
    const neighbors = layout.neighbors.flatMap((n) => {
      const split = splits.get(n.id);
      if (!split || !same(split.original, n)) return [n];
      ids.set(n.id, split.pieces.map((piece) => piece.id));
      return split.pieces.map(geometry);
    });
    if (!ids.size) return c;
    const remap = (list) => list.flatMap((id) => ids.get(id) || [id]);
    const layers = layout.layers.map((layer) => ({ ...layer, targets: remap(layer.targets), front: remap(layer.front) }));
    return { ...c, mergeLayout: { ...layout, neighbors, layers } };
  });
}
