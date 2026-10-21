/**
 * Measuring on the page, as a desktop editor's Measure tool does: distances, perimeters, and
 * areas in real-world units from a drawing scale. PDF user space is 1/72 inch; the scale says
 * how much real length one unit of the page stands for (1:1 measures the paper itself).
 */
export const MEASURE_UNITS = {
  pt: { label: 'pt', perInch: 72 },
  in: { label: 'in', perInch: 1 },
  ft: { label: 'ft', perInch: 1 / 12 },
  mm: { label: 'mm', perInch: 25.4 },
  cm: { label: 'cm', perInch: 2.54 },
  m: { label: 'm', perInch: 0.0254 },
};

/** A length in points on the page, in the scale's unit. */
export function realLength(points, { unit = 'in', ratio = 1, userUnit = 1 } = {}) {
  const inches = (points * userUnit) / 72;
  return inches * MEASURE_UNITS[unit].perInch * ratio;
}

export function polylineLength(points, closed = false) {
  let total = 0;
  for (let i = 1; i < points.length; i++)
    total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  if (closed && points.length > 2)
    total += Math.hypot(points[0].x - points.at(-1).x, points[0].y - points.at(-1).y);
  return total;
}

/** The area of a polygon in square points (the shoelace formula). */
export function polygonArea(points) {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i],
      b = points[(i + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

const round = (value) => {
  const digits = Math.abs(value) >= 100 ? 1 : 2;
  // The label is drawn on the page in fonts with Western digits only: a locale's own digits
  // (Arabic-Indic, Bengali, …) would leave the measurement without a label.
  return value.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
    numberingSystem: 'latn',
  });
};

/** The label for a measurement: "12.50 cm", "48.2 cm", or "15.38 sq cm". */
export function measureLabel(kind, points, scale) {
  const unit = MEASURE_UNITS[scale.unit].label;
  if (kind === 'area') {
    const side = realLength(1, scale);
    return `${round(polygonArea(points) * side * side)} sq ${unit}`;
  }
  return `${round(realLength(polylineLength(points, kind === 'perimeter-closed'), scale))} ${unit}`;
}
