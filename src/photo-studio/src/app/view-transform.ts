// Geometry of a document view: how document pixels map onto a viewport.
// A view places the document center at the viewport center plus `pan`, then
// rotates and scales about it. `aspect` stretches document pixels
// horizontally (pixel aspect ratio correction) and `flip` mirrors the view.
// Everything here is pure so input, overlays and tests share one model.

export type ViewState = {
  zoom: number;
  pan: { x: number; y: number };
  // Degrees, clockwise on screen.
  rotation: number;
  flip: boolean;
  // Horizontal display scale of one document pixel (1 = square pixels).
  aspect?: number;
};
// Affine [a, b, c, d, e, f]: x' = a·x + c·y + e, y' = b·x + d·y + f.
export type Affine = [number, number, number, number, number, number];
export type Size = { width: number; height: number };

export const MIN_ZOOM = 0.01;
export const MAX_ZOOM = 64;
export const clampZoom = (z: number) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));

/** Normalize an angle to (-180, 180]. */
export function normalizeRotation(deg: number) {
  const r = ((((deg + 180) % 360) + 360) % 360) - 180;
  return r === -180 ? 180 : Math.abs(r) < 1e-9 ? 0 : r;
}

/** Document → viewport-local matrix for a viewport of `viewport` CSS pixels. */
export function viewMatrix(v: ViewState, doc: Size, viewport: Size): Affine {
  const a = (v.rotation * Math.PI) / 180,
    cos = Math.cos(a),
    sin = Math.sin(a);
  const sx = v.zoom * (v.aspect ?? 1) * (v.flip ? -1 : 1),
    sy = v.zoom;
  const cx = viewport.width / 2 + v.pan.x,
    cy = viewport.height / 2 + v.pan.y;
  // R · S · (p − docCenter) + viewCenter
  const m: Affine = [cos * sx, sin * sx, -sin * sy, cos * sy, 0, 0];
  m[4] = cx - (m[0] * doc.width) / 2 - (m[2] * doc.height) / 2;
  m[5] = cy - (m[1] * doc.width) / 2 - (m[3] * doc.height) / 2;
  return m;
}
export function applyAffine(m: Affine, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}
export function invertAffine(m: Affine): Affine {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!det || !Number.isFinite(det)) return [1, 0, 0, 1, 0, 0];
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}

/** CSS transform for a stage element of document size centered in its viewport
 * (top/left 50%, transform-origin center). */
export function stageTransform(v: ViewState) {
  const sx = v.zoom * (v.aspect ?? 1) * (v.flip ? -1 : 1);
  // Full precision: input maps through the same numbers (see viewMatrix).
  const rotate = v.rotation ? ` rotate(${v.rotation}deg)` : '';
  const scale = sx === v.zoom ? `scale(${v.zoom})` : `scale(${sx},${v.zoom})`;
  return `translate(calc(-50% + ${v.pan.x}px),calc(-50% + ${v.pan.y}px))${rotate} ${scale}`;
}

/** Screen-space size of the document's bounding box in this view. */
export function screenExtent(v: Pick<ViewState, 'rotation' | 'aspect'>, rect: Size, zoom = 1): Size {
  const a = (v.rotation * Math.PI) / 180,
    c = Math.abs(Math.cos(a)),
    s = Math.abs(Math.sin(a));
  const w = rect.width * (v.aspect ?? 1) * zoom,
    h = rect.height * zoom;
  return { width: w * c + h * s, height: w * s + h * c };
}

/** Zoom that fits a document rectangle inside the viewport (with a margin). */
export function fitZoom(v: Pick<ViewState, 'rotation' | 'aspect'>, rect: Size, viewport: Size, margin = 40, max = 1) {
  const e = screenExtent(v, rect);
  const w = Math.max(1, viewport.width - margin * 2),
    h = Math.max(1, viewport.height - margin * 2);
  return clampZoom(Math.min(w / Math.max(1e-6, e.width), h / Math.max(1e-6, e.height), max));
}
/** Zoom at which the rotated document covers the whole viewport. */
export function fillZoom(v: Pick<ViewState, 'rotation' | 'aspect'>, rect: Size, viewport: Size) {
  const e = screenExtent(v, rect);
  return clampZoom(Math.max(viewport.width / Math.max(1e-6, e.width), viewport.height / Math.max(1e-6, e.height)));
}

/** Pan that shows document point (x, y) at the viewport center. */
export function panToCenter(v: ViewState, doc: Size, x: number, y: number) {
  const m = viewMatrix({ ...v, pan: { x: 0, y: 0 } }, doc, { width: 0, height: 0 });
  const [px, py] = applyAffine(m, x, y);
  return { x: -px, y: -py };
}
/** Document point currently shown at the viewport center. */
export function centerPoint(v: ViewState, doc: Size): [number, number] {
  return applyAffine(invertAffine(viewMatrix(v, doc, { width: 0, height: 0 })), 0, 0);
}

/** Change the zoom keeping the document point under viewport-local (x, y) fixed. */
export function zoomAround(v: ViewState, zoom: number, viewport: Size, x = viewport.width / 2, y = viewport.height / 2) {
  const next = clampZoom(zoom);
  const ratio = next / v.zoom;
  const dx = x - viewport.width / 2,
    dy = y - viewport.height / 2;
  return { zoom: next, pan: { x: dx - (dx - v.pan.x) * ratio, y: dy - (dy - v.pan.y) * ratio } };
}
/** Rotate the view by `delta` degrees about the viewport-local point (x, y). */
export function rotateAround(v: ViewState, rotation: number, viewport: Size, x = viewport.width / 2, y = viewport.height / 2) {
  const next = normalizeRotation(rotation);
  const a = ((next - v.rotation) * Math.PI) / 180,
    c = Math.cos(a),
    s = Math.sin(a);
  const ox = x - viewport.width / 2,
    oy = y - viewport.height / 2;
  const px = v.pan.x - ox,
    py = v.pan.y - oy;
  return { rotation: next, pan: { x: ox + c * px - s * py, y: oy + s * px + c * py } };
}
/** Angle (degrees) of a drag around the viewport center, snapped when asked. */
export function dragRotation(start: number, from: [number, number], to: [number, number], center: [number, number], snap = 0) {
  const a0 = Math.atan2(from[1] - center[1], from[0] - center[0]),
    a1 = Math.atan2(to[1] - center[1], to[0] - center[0]);
  let r = start + ((a1 - a0) * 180) / Math.PI;
  if (snap > 0) r = Math.round(r / snap) * snap;
  return normalizeRotation(r);
}

/** Zoom that shows a document at its physical print size on screen. */
export function printSizeZoom(docPpi: number, screenPpi: number) {
  return clampZoom(screenPpi / Math.max(1e-6, docPpi));
}
/** Zoom at which one image pixel covers exactly one physical display pixel.
 * The canvas is laid out in CSS pixels, and one CSS pixel spans
 * `devicePixelRatio` display pixels (screen density times browser zoom). */
export function actualSizeZoom(devicePixelRatio: number) {
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  return clampZoom(1 / dpr);
}
/** Pixels per inch from a stored resolution (pixels per centimeter converted). */
export function pixelsPerInch(resolution?: { horizontalResolution: number; horizontalResolutionUnit: 'PPI' | 'PPCM' }) {
  if (!resolution) return 72;
  return resolution.horizontalResolutionUnit === 'PPCM' ? resolution.horizontalResolution * 2.54 : resolution.horizontalResolution;
}
