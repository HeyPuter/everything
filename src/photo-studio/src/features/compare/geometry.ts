// Geometry of View → Quick Compare, kept pure for tests: where the stored
// state's image sits on the current canvas, which part of it a split shows
// (a screen-space half of the window mapped into document space, so the
// divider stays upright on a rotated or mirrored view) and how large the
// cached image of the stored state may be.
import { applyAffine, invertAffine, type Affine, type Size } from '../../app/view-transform';

export type Rect = { x: number; y: number; width: number; height: number };
/** 'vertical': an upright divider with the stored state on the left;
 * 'horizontal': a level divider with the stored state above. */
export type Orientation = 'vertical' | 'horizontal';

/** Where a stored state of size `before` is drawn on a canvas of size
 * `current`, in current document pixels. Equal sizes coincide; the same
 * proportions (an image resize) are stretched over the canvas; otherwise (a
 * crop or a canvas size change) it keeps its pixel size, centered. */
export function beforePlacement(before: Size, current: Size): Rect {
  if (before.width === current.width && before.height === current.height)
    return { x: 0, y: 0, width: current.width, height: current.height };
  const ra = before.width / before.height,
    rb = current.width / current.height;
  if (Math.abs(ra / rb - 1) < 0.01)
    return { x: 0, y: 0, width: current.width, height: current.height };
  return {
    x: (current.width - before.width) / 2,
    y: (current.height - before.height) / 2,
    width: before.width,
    height: before.height,
  };
}

/** The stored-state side of a split, as a polygon in the coordinates of an
 * element placed at `place` in document space. `m` maps document to
 * viewport-local coordinates; `position` (0–1) is the divider's place across
 * the viewport. */
export function splitClip(
  m: Affine,
  viewport: Size,
  orientation: Orientation,
  position: number,
  place: Rect,
): [number, number][] {
  const { width: W, height: H } = viewport;
  // Reach well past the window so no edge of the clip is ever visible.
  const B = W + H + 16;
  const p = Math.max(0, Math.min(1, position));
  const screen: [number, number][] =
    orientation === 'vertical'
      ? [
          [-B, -B],
          [p * W, -B],
          [p * W, H + B],
          [-B, H + B],
        ]
      : [
          [-B, -B],
          [W + B, -B],
          [W + B, p * H],
          [-B, p * H],
        ];
  const inv = invertAffine(m);
  // The element's box is laid out in document pixels from its corner.
  return screen.map(([x, y]) => {
    const [dx, dy] = applyAffine(inv, x, y);
    return [dx - place.x, dy - place.y];
  });
}

/** A CSS clip-path polygon (pixels, rounded to 1/100). */
export function clipPathCss(points: [number, number][]): string {
  const r = (v: number) => Math.round(v * 100) / 100;
  return `polygon(${points.map(([x, y]) => `${r(x)}px ${r(y)}px`).join(', ')})`;
}

/** Size of the cached image of the stored state: full resolution up to a
 * longest side of `maxSide` and an area of `maxArea` pixels. */
export function cacheSize(
  width: number,
  height: number,
  maxSide = 8192,
  maxArea = 40_000_000,
): Size {
  const k = Math.min(
    1,
    maxSide / Math.max(width, height),
    Math.sqrt(maxArea / Math.max(1, width * height)),
  );
  return { width: Math.max(1, Math.floor(width * k)), height: Math.max(1, Math.floor(height * k)) };
}

/** The divider position after a key press, or undefined for other keys:
 * arrows move 1% (10% with Shift), Home and End go to the edges, Page Up and
 * Page Down move 10%. */
export function dividerKey(position: number, key: string, shift: boolean): number | undefined {
  const step = shift ? 0.1 : 0.01;
  const clamp = (v: number) => Math.max(0, Math.min(1, Math.round(v * 1000) / 1000));
  switch (key) {
    case 'ArrowLeft':
    case 'ArrowUp':
      return clamp(position - step);
    case 'ArrowRight':
    case 'ArrowDown':
      return clamp(position + step);
    case 'PageUp':
      return clamp(position - 0.1);
    case 'PageDown':
      return clamp(position + 0.1);
    case 'Home':
      return 0;
    case 'End':
      return 1;
  }
  return undefined;
}
