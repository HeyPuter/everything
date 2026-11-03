// countries-50m keeps a few rings (Russia, Fiji) continuous across ±180, which planar renderers and point tests
// read as a band around the globe. Those rings are cut into an eastern and a western part.

const jumps = (ring) => ring.some((point, index) => index > 0 && Math.abs(point[0] - ring[index - 1][0]) > 180);

// Sutherland–Hodgman against the half-plane x <= edge (or x >= edge).
function clip(ring, east, edge = 180) {
  const keep = (x) => (east ? x >= edge : x <= edge);
  const out = [];
  for (let i = 0; i < ring.length - 1; i++) {
    const a = ring[i]; const b = ring[i + 1];
    const inA = keep(a[0]); const inB = keep(b[0]);
    if (inA) out.push(a);
    if (inA !== inB && a[0] !== b[0]) { const k = (edge - a[0]) / (b[0] - a[0]); out.push([edge, a[1] + k * (b[1] - a[1])]); }
  }
  if (out.length < 3) return null;
  out.push([...out[0]]);
  return out;
}

/** Splits one polygon (array of rings) when its outer ring crosses the antimeridian; otherwise returns it unchanged. */
export function splitPolygon(rings) {
  if (!rings.length || !jumps(rings[0])) return [rings];
  const shifted = rings.map((ring) => ring.map(([x, y]) => [x < 0 ? x + 360 : x, y]));
  // A ring that circles every longitude (Antarctica) cannot be unwrapped; keep it as drawn.
  if (shifted.some(jumps)) return [rings];
  const west = shifted.map((ring) => clip(ring, false));
  const east = shifted.map((ring) => clip(ring, true)?.map(([x, y]) => [x - 360, y]) ?? null);
  // A part exists only where its outer ring survives the cut.
  return [west, east].filter((part) => part[0]).map((part) => part.filter(Boolean));
}

/** A copy of a Polygon/MultiPolygon FeatureCollection with antimeridian-crossing rings split. */
export function splitAntimeridian(collection) {
  return {
    type: 'FeatureCollection',
    features: (collection?.features ?? []).map((feature) => {
      const geometry = feature.geometry;
      const polygons = geometry?.type === 'Polygon' ? [geometry.coordinates] : geometry?.type === 'MultiPolygon' ? geometry.coordinates : null;
      if (!polygons) return feature;
      const parts = polygons.flatMap(splitPolygon);
      return { ...feature, geometry: parts.length === 1 ? { type: 'Polygon', coordinates: parts[0] } : { type: 'MultiPolygon', coordinates: parts } };
    }),
  };
}
