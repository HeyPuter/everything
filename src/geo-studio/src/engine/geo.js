/**
 * Geo Studio map model (original). ArcGIS-inspired local layers — not Esri ArcGIS.
 */

/** @typedef {{ id:string, name:string, lat:number, lng:number, note?:string }} Marker */
/** @typedef {{ id:string, name:string, visible:boolean, markers: Marker[] }} Layer */
/** @typedef {{ center:{lat:number,lng:number}, zoom:number, layers: Layer[] }} MapDoc */

/** @returns {MapDoc} */
export function createMap(center = { lat: 37.7749, lng: -122.4194 }, zoom = 11) {
  return {
    center: { ...center },
    zoom,
    layers: [
      {
        id: 'base',
        name: 'Features',
        visible: true,
        markers: [],
      },
    ],
  };
}

/** Web-mercator-ish project for canvas (DOCUMENTED approximation, not a LIVE tile service). */
export function project(lat, lng, center, zoom, width, height) {
  const scale = 256 * 2 ** (zoom - 8);
  const x = (lng - center.lng) * scale + width / 2;
  const y = (center.lat - lat) * scale + height / 2;
  return { x, y };
}

/** @param {MapDoc} doc @param {string} layerId @param {Omit<Marker,'id'>} marker */
export function addMarker(doc, layerId, marker) {
  const layers = doc.layers.map((layer) => {
    if (layer.id !== layerId) return layer;
    const id = `m${layer.markers.length + 1}_${Math.abs(Math.round(marker.lat * 1e4))}`;
    return { ...layer, markers: [...layer.markers, { id, ...marker }] };
  });
  return { ...doc, layers };
}

/** @param {MapDoc} doc */
export function toGeoJSON(doc) {
  /** @type {object[]} */
  const features = [];
  for (const layer of doc.layers) {
    if (!layer.visible) continue;
    for (const m of layer.markers) {
      features.push({
        type: 'Feature',
        properties: { id: m.id, name: m.name, note: m.note || '', layer: layer.name },
        geometry: { type: 'Point', coordinates: [m.lng, m.lat] },
      });
    }
  }
  return { type: 'FeatureCollection', features };
}

/** @param {MapDoc} doc @param {string} name */
export function addLayer(doc, name) {
  const id = `l${doc.layers.length + 1}`;
  return {
    ...doc,
    layers: [...doc.layers, { id, name, visible: true, markers: [] }],
  };
}

/** Haversine km between two WGS84 points. */
export function distanceKm(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
