// Minimal TopoJSON decoder for the bundled countries file (Polygon/MultiPolygon, quantized or not).
const reserved = new Set(['__proto__', 'constructor', 'prototype']);
function decodeArcs(topology) {
  const transform = topology.transform;
  if (!Array.isArray(topology.arcs) || topology.arcs.length > 100_000) throw new RangeError('Invalid topology');
  return topology.arcs.map(arc => {
    if (!Array.isArray(arc) || arc.length > 100_000) throw new RangeError('Invalid topology');
    let x = 0, y = 0;
    return arc.map(position => {
      if (!Array.isArray(position) || !Number.isFinite(position[0]) || !Number.isFinite(position[1])) throw new RangeError('Invalid topology');
      if (!transform) return [position[0], position[1]];
      x += position[0]; y += position[1];
      return [x * transform.scale[0] + transform.translate[0], y * transform.scale[1] + transform.translate[1]];
    });
  });
}
/** Converts one named object of a topology into a GeoJSON FeatureCollection. */
export function topologyFeatures(topology, name) {
  if (topology?.type !== 'Topology' || typeof name !== 'string' || reserved.has(name) || !Object.hasOwn(topology.objects ?? {}, name)) throw new RangeError('Invalid topology object');
  const arcs = decodeArcs(topology);
  const arc = index => {
    if (!Number.isInteger(index)) throw new RangeError('Invalid topology');
    const line = arcs[index < 0 ? ~index : index]; if (!line) throw new RangeError('Invalid topology');
    return index < 0 ? [...line].reverse() : line;
  };
  const ring = indexes => {
    const points = [];
    for (const index of indexes) { const line = arc(index); points.push(...(points.length ? line.slice(1) : line)); }
    if (points.length && (points[0][0] !== points.at(-1)[0] || points[0][1] !== points.at(-1)[1])) points.push([...points[0]]);
    while (points.length && points.length < 4) points.push([...points[0]]);
    return points;
  };
  const geometry = value => {
    if (value?.type === 'Polygon') return { type: 'Polygon', coordinates: value.arcs.map(ring) };
    if (value?.type === 'MultiPolygon') return { type: 'MultiPolygon', coordinates: value.arcs.map(polygon => polygon.map(ring)) };
    return null;
  };
  const object = topology.objects[name];
  const items = object.type === 'GeometryCollection' ? object.geometries : [object];
  return { type: 'FeatureCollection', features: items.flatMap(item => {
    const shape = geometry(item); if (!shape) return [];
    return [{ type: 'Feature', ...(item.id === undefined ? {} : { id: item.id }), properties: { ...(item.properties ?? {}) }, geometry: shape }];
  }) };
}
