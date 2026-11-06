import { describe, expect, it } from 'vitest';
import { addLayer, addMarker, createMap, distanceKm, toGeoJSON } from '../src/engine/geo.js';

describe('geo studio', () => {
  it('creates a map with a default layer', () => {
    const m = createMap();
    expect(m.layers).toHaveLength(1);
    expect(m.center.lat).toBeCloseTo(37.7749, 3);
  });

  it('adds markers and exports GeoJSON', () => {
    let m = createMap();
    m = addMarker(m, 'base', { name: 'Ferry', lat: 37.8, lng: -122.4, note: 'pier' });
    const gj = toGeoJSON(m);
    expect(gj.type).toBe('FeatureCollection');
    expect(gj.features).toHaveLength(1);
    expect(gj.features[0].geometry.coordinates).toEqual([-122.4, 37.8]);
  });

  it('adds layers', () => {
    const m = addLayer(createMap(), 'Transit');
    expect(m.layers.map((l) => l.name)).toContain('Transit');
  });

  it('computes haversine distance', () => {
    const km = distanceKm({ lat: 0, lng: 0 }, { lat: 0, lng: 1 });
    expect(km).toBeGreaterThan(110);
    expect(km).toBeLessThan(112);
  });
});
