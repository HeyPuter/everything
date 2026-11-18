/** SVG brush geometry uses the same affine mapping as the source picture. */
export function mappedTransform(map, position = null) {
  const o = map(0, 0), x = map(1, 0), y = map(0, 1);
  const p = position || o;
  return `matrix(${x[0] - o[0]} ${x[1] - o[1]} ${y[0] - o[0]} ${y[1] - o[1]} ${p[0]} ${p[1]})`;
}

/** A source-pixel circle becomes the displayed ellipse, with a legible 1px outline. */
export function brushCursor(map, position, diameter, erase, node = null) {
  const el = node || document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  el.setAttribute('class', `mask-brush-cursor${erase ? ' erase' : ''}`);
  el.setAttribute('cx', '0'); el.setAttribute('cy', '0');
  el.setAttribute('r', Math.max(0.5, diameter) / 2);
  el.setAttribute('transform', mappedTransform(map, position));
  el.setAttribute('vector-effect', 'non-scaling-stroke');
  return el;
}
