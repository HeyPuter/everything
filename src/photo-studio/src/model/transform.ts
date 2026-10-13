import { allLayers, type Layer, type PhotoDocument, type Transform } from './document';
import { layerLock } from './locks';
import { multiplyMaskMatrix } from './pixel-mask';
import { guideLines } from './guides';

export type Point = [number, number];
export type ResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
export const handles: Record<ResizeHandle, Point> = {
  nw: [-1, -1],
  n: [0, -1],
  ne: [1, -1],
  e: [1, 0],
  se: [1, 1],
  s: [0, 1],
  sw: [-1, 1],
  w: [-1, 0],
};
export type Guides = { x?: number; y?: number };
export type SnapTargets = { x: number[]; y: number[] };
export function worldPoint(t: Transform, x: number, y: number): Point {
  const a = (t.rotation * Math.PI) / 180,
    c = Math.cos(a),
    s = Math.sin(a);
  const dx = (x - 0.5) * t.width,
    dy = (y - 0.5) * t.height;
  return [t.x + t.width / 2 + c * dx - s * dy, t.y + t.height / 2 + s * dx + c * dy];
}
export function transformBounds(t: Transform) {
  const points = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ].map(([x, y]) => worldPoint(t, x, y));
  const x = Math.min(...points.map((p) => p[0])),
    y = Math.min(...points.map((p) => p[1]));
  return {
    x,
    y,
    width: Math.max(...points.map((p) => p[0])) - x,
    height: Math.max(...points.map((p) => p[1])) - y,
  };
}
export function layerLocked(layers: Layer[], id: string, inherited = false): boolean {
  return inherited || layerLock(layers, id);
}
// Which kinds of target snapping considers (View > Snap To). Grid snapping
// takes the grid spacing; its subdivisions are targets too.
export type SnapOptions = { guides?: boolean; layers?: boolean; document?: boolean; grid?: number; gridDivisions?: number };
/** Canvas and grid lines plus guides, without layer edges. */
export function lineTargets(doc: Pick<PhotoDocument, 'width' | 'height' | 'guides'> & Partial<Pick<PhotoDocument, 'layers'>>, opts: SnapOptions = {}): SnapTargets {
  const targets: SnapTargets = { x: [], y: [] };
  if (opts.document !== false) {
    targets.x.push(0, doc.width / 2, doc.width);
    targets.y.push(0, doc.height / 2, doc.height);
  }
  if (opts.grid && opts.grid > 0) {
    const step = opts.grid / Math.max(1, opts.gridDivisions ?? 1);
    // Very fine grids would add thousands of targets; coarser lines suffice.
    const s = Math.max(step, Math.max(doc.width, doc.height) / 2000);
    for (let x = s; x < doc.width; x += s) targets.x.push(x);
    for (let y = s; y < doc.height; y += s) targets.y.push(y);
  }
  if (opts.guides !== false) {
    const g = guideLines(doc);
    targets.x.push(...g.x);
    targets.y.push(...g.y);
  }
  return targets;
}
/** Bounds of visible, unselected leaf layers (snap and alignment targets). */
export function layerTargetRects(doc: PhotoDocument, selected: Layer | Layer[]) {
  const excluded = new Set(allLayers(Array.isArray(selected) ? selected : [selected]).map((l) => l.id));
  const rects: ReturnType<typeof transformBounds>[] = [];
  const visit = (layers: Layer[]) => {
    for (const l of layers) {
      if (!l.visible || excluded.has(l.id)) continue;
      const box = l.artboard?.rect ?? l.frame?.rect;
      if (box) rects.push({ x: box.x, y: box.y, width: box.width, height: box.height });
      if (l.kind === 'group') visit(l.children);
      else if (l.kind !== 'adjustment') rects.push(transformBounds(l.transform));
    }
  };
  visit(doc.layers);
  return rects;
}
export function snapTargets(doc: PhotoDocument, selected: Layer | Layer[], opts: SnapOptions = {}): SnapTargets {
  const lines = lineTargets({ width: doc.width, height: doc.height }, { ...opts, guides: false });
  const targets: SnapTargets = { x: lines.x, y: lines.y };
  if (opts.layers !== false)
    for (const b of layerTargetRects(doc, selected)) {
      targets.x.push(b.x, b.x + b.width / 2, b.x + b.width);
      targets.y.push(b.y, b.y + b.height / 2, b.y + b.height);
    }
  if (opts.guides !== false) {
    const g = guideLines(doc);
    targets.x.push(...g.x);
    targets.y.push(...g.y);
  }
  for (const extra of snapProviders) {
    const t = extra(doc);
    targets.x.push(...t.x);
    targets.y.push(...t.y);
  }
  return targets;
}
// Features add snapping targets (for example slice edges) without editing this module.
export const snapProviders: ((doc: PhotoDocument) => SnapTargets)[] = [];
export function closestSnap(values: number[], targets: number[], threshold: number) {
  let result: { delta: number; target: number } | undefined;
  for (const value of values)
    for (const target of targets) {
      const delta = target - value;
      if (Math.abs(delta) <= threshold && (!result || Math.abs(delta) < Math.abs(result.delta)))
        result = { delta, target };
    }
  return result;
}
export function snapTranslation(t: Transform, targets: SnapTargets, threshold: number) {
  const b = transformBounds(t);
  const x = closestSnap([b.x, b.x + b.width / 2, b.x + b.width], targets.x, threshold);
  const y = closestSnap([b.y, b.y + b.height / 2, b.y + b.height], targets.y, threshold);
  return {
    transform: { ...t, x: t.x + (x?.delta ?? 0), y: t.y + (y?.delta ?? 0) },
    guides: { x: x?.target, y: y?.target },
  };
}
export function resizeTransform(
  t: Transform,
  handle: ResizeHandle,
  delta: Point,
  proportional: boolean,
): Transform {
  const [sx, sy] = handles[handle],
    a = (t.rotation * Math.PI) / 180;
  const dx = delta[0] * Math.cos(a) + delta[1] * Math.sin(a);
  const dy = -delta[0] * Math.sin(a) + delta[1] * Math.cos(a);
  let width = t.width + sx * dx,
    height = t.height + sy * dy;
  if (proportional) {
    const wx = width / t.width,
      hy = height / t.height;
    let factor = !sx ? hy : !sy ? wx : Math.abs(wx - 1) >= Math.abs(hy - 1) ? wx : hy;
    factor = Math.max(
      Math.max(1 / t.width, 1 / t.height),
      Math.min(Math.min(8192 / t.width, 8192 / t.height), factor),
    );
    width = t.width * factor;
    height = t.height * factor;
  } else {
    width = Math.max(1, Math.min(8192, width));
    height = Math.max(1, Math.min(8192, height));
  }
  // Pin the opposite corner (or opposite edge midpoint) even on rotated layers.
  const ax = (1 - sx) / 2,
    ay = (1 - sy) / 2;
  const anchor = worldPoint(t, ax, ay);
  const offset = worldPoint(
    { x: -width / 2, y: -height / 2, width, height, rotation: t.rotation },
    ax,
    ay,
  );
  return {
    x: anchor[0] - offset[0] - width / 2,
    y: anchor[1] - offset[1] - height / 2,
    width,
    height,
    rotation: t.rotation,
  };
}
export function normalizeAngle(angle: number) {
  return ((((angle + 180) % 360) + 360) % 360) - 180;
}

export function selectionFrame(roots: Layer[]): Transform | undefined {
  if (roots.length === 1 && roots[0].kind !== 'group') return { ...roots[0].transform };
  // Artboards and frames have their own rectangles, also when empty.
  const layers = allLayers(roots);
  const boxes = [
    ...layers.filter((l) => l.kind !== 'group').map((l) => transformBounds(l.transform)),
    ...layers.flatMap((l) => (l.artboard ? [l.artboard.rect] : l.frame ? [l.frame.rect] : [])),
  ];
  if (!boxes.length) return;
  const x = Math.min(...boxes.map((b) => b.x)),
    y = Math.min(...boxes.map((b) => b.y));
  return {
    x,
    y,
    width: Math.max(...boxes.map((b) => b.x + b.width)) - x,
    height: Math.max(...boxes.map((b) => b.y + b.height)) - y,
    rotation: 0,
  };
}
/** A similarity transform preserves rotated rectangles without introducing shear. */
export function transformSelection(roots: Layer[], before: Transform, after: Transform) {
  if (roots.length === 1 && roots[0].kind !== 'group') {
    roots[0].transform = { ...after };
    return;
  }
  const scale = after.width / before.width;
  const angle = normalizeAngle(after.rotation - before.rotation);
  const a = (angle * Math.PI) / 180,
    c = Math.cos(a),
    s = Math.sin(a);
  const bx = before.x + before.width / 2,
    by = before.y + before.height / 2;
  const ax = after.x + after.width / 2,
    ay = after.y + after.height / 2;
  const map = (x: number, y: number): Point => [
    ax + scale * ((x - bx) * c - (y - by) * s),
    ay + scale * ((x - bx) * s + (y - by) * c),
  ];
  const layers = allLayers(roots);
  if (layers.some((l) => l.kind === 'group' && !l.pixelMask && (l.maskAsset || l.maskStrokes?.length)))
    throw new Error('Remove the group bitmap or painted mask before transforming this selection.');
  if (Math.abs(angle) > 0.001 && layers.some((l) => l.mask))
    throw new Error('Remove rectangular masks before rotating multiple layers or a group.');
  if (Math.abs(angle) > 0.001 && layers.some((l) => l.artboard || l.frame))
    throw new Error('Artboards and frames cannot be rotated; rotate their contents instead.');
  for (const l of layers) {
    for (const box of [l.artboard, l.frame])
      if (box) {
        const [x, y] = map(box.rect.x, box.rect.y);
        box.rect = { x, y, width: box.rect.width * scale, height: box.rect.height * scale };
        // Artboards stay on whole pixels so exports keep their exact size.
        if (l.artboard) box.rect = { x: Math.round(x), y: Math.round(y), width: Math.max(1, Math.round(box.rect.width)), height: Math.max(1, Math.round(box.rect.height)) };
      }
    if (l.kind === 'group' && l.pixelMask && !l.pixelMask.positionRelativeToLayer)
      l.pixelMask.matrix = multiplyMaskMatrix([scale*c,scale*s,-scale*s,scale*c,
        ax-scale*(bx*c-by*s),ay-scale*(bx*s+by*c)], l.pixelMask.matrix);
    if (l.kind !== 'group') {
      const t = l.transform;
      const [x, y] = map(t.x + t.width / 2, t.y + t.height / 2);
      const width = t.width * scale,
        height = t.height * scale;
      l.transform = {
        x: x - width / 2,
        y: y - height / 2,
        width,
        height,
        rotation: normalizeAngle(t.rotation + angle),
      };
    }
    if (l.mask) {
      const [x, y] = map(l.mask.x, l.mask.y);
      l.mask = {
        x,
        y,
        width: l.mask.width * scale,
        height: l.mask.height * scale,
      };
    }
  }
}
