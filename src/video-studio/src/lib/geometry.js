/** Affine geometry in project pixels. Skew is the upper-right entry before rotation. */
export function poseMatrix(p, flips = true) {
  const r = p.rotation * Math.PI / 180;
  const c = Math.cos(r), s = Math.sin(r);
  const x = (p.sx ?? 1) * p.scale * (flips && p.flipH ? -1 : 1);
  const y = (p.sy ?? 1) * p.scale * (flips && p.flipV ? -1 : 1);
  const k = (p.skew || 0) * p.scale * (flips && p.flipV ? -1 : 1);
  return [c * x, s * x, c * k - s * y, s * k + c * y];
}

export function multiply(a, b) {
  return [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3]];
}

export function inverse(m) {
  const det = m[0] * m[3] - m[1] * m[2];
  return det && Number.isFinite(det) ? [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det] : null;
}

/** Decompose a non-reflecting linear transform without losing its shear. */
export function axes(m) {
  const sx = Math.hypot(m[0], m[1]);
  if (!sx) return { rotation: Math.atan2(-m[2], m[3]) * 180 / Math.PI, sx: 0, sy: Math.hypot(m[2], m[3]), skew: 0 };
  return { rotation: Math.atan2(m[1], m[0]) * 180 / Math.PI, sx, sy: Math.max(0, (m[0] * m[3] - m[1] * m[2]) / sx), skew: (m[0] * m[2] + m[1] * m[3]) / sx };
}

/** Place a child pose inside a parent, preserving rotations, reflections and shear. */
export function placePose(child, parent, W, H) {
  const r = parent.rotation * Math.PI / 180;
  const c = Math.cos(r), s = Math.sin(r);
  const px = parent.sx ?? 1, py = parent.sy ?? 1;
  const fx = parent.flipH ? -1 : 1, fy = parent.flipV ? -1 : 1;
  const X = child.x * W * px * fx + child.y * H * (parent.skew || 0) * fy;
  const Y = child.y * H * py * fy;
  child.x = parent.x + (X * c - Y * s) * parent.scale / W;
  child.y = parent.y + (X * s + Y * c) * parent.scale / H;
  if (px === py && !parent.skew) {
    child.rotation = parent.rotation + fx * fy * child.rotation;
    if (px !== 1) { child.sx = (child.sx ?? 1) * px; child.sy = (child.sy ?? 1) * py; }
    if (child.skew) child.skew *= px * fx * fy;
  } else {
    const matrix = multiply(poseMatrix({ ...parent, scale: 1 }), poseMatrix({ ...child, scale: 1 }));
    const flipH = Boolean(child.flipH) !== Boolean(parent.flipH);
    const flipV = Boolean(child.flipV) !== Boolean(parent.flipV);
    if (flipH) { matrix[0] *= -1; matrix[1] *= -1; }
    if (flipV) { matrix[2] *= -1; matrix[3] *= -1; }
    Object.assign(child, axes(matrix));
  }
  child.scale *= parent.scale;
  child.flipH = Boolean(child.flipH) !== Boolean(parent.flipH);
  child.flipV = Boolean(child.flipV) !== Boolean(parent.flipV);
  return child;
}

/** A box-local fraction (center is 0,0) to project pixels, excluding source flips. */
export function boxPoint(box, rotation, u, v) {
  const r = rotation * Math.PI / 180;
  const c = Math.cos(r), s = Math.sin(r);
  const x = u * box.w + v * (box.skew || 0), y = v * box.h;
  return [box.cx + x * c - y * s, box.cy + x * s + y * c];
}

export function boxLocal(box, rotation, px, py) {
  const r = rotation * Math.PI / 180;
  const c = Math.cos(r), s = Math.sin(r);
  const x = px - box.cx, y = py - box.cy;
  const v = (-x * s + y * c) / (box.h || 1);
  return [(x * c + y * s - v * (box.skew || 0)) / (box.w || 1), v];
}

/** Half extents of the transformed box's axis-aligned bounds. */
export function boxHalf(box, rotation) {
  const r = rotation * Math.PI / 180;
  const c = Math.cos(r), s = Math.sin(r), k = box.skew || 0;
  return { w: (Math.abs(box.w * c) + Math.abs(k * c - box.h * s)) / 2, h: (Math.abs(box.w * s) + Math.abs(k * s + box.h * c)) / 2 };
}
