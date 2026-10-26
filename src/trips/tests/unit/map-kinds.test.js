import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTripMap, geodesicArc, topologyFeatures } from '../../src/map/index.js';

class OrderedMap {
  constructor(options) {
    this.options = options; this.sources = new Map(); this.order = ['background', 'roads', 'place-labels']; this.layers = new Map(this.order.map(id => [id, { id, type: id === 'place-labels' ? 'symbol' : 'line' }]));
    this.events = new Map(); this.canvas = document.createElement('canvas'); this.loaded = true; this.hits = []; this.easeTo = vi.fn();
  }
  on(type, fn) { if (!this.events.has(type)) this.events.set(type, new Set()); this.events.get(type).add(fn); }
  off(type, fn) { this.events.get(type)?.delete(fn); }
  emit(type, event = {}) { for (const handler of this.events.get(type) ?? []) handler(event); }
  addControl() {}
  getCanvas() { return this.canvas; }
  getStyle() { return { layers: this.order.map(id => ({ id, type: this.layers.get(id).type })) }; }
  getSource(id) { return this.sources.get(id); }
  addSource(id, value) { this.sources.set(id, { ...value, setData(data) { this.data = data; }, getClusterExpansionZoom: vi.fn(async () => 9) }); }
  removeSource(id) { this.sources.delete(id); }
  getLayer(id) { return this.layers.get(id); }
  addLayer(layer, before) { this.layers.set(layer.id, structuredClone(layer)); const index = before ? this.order.indexOf(before) : -1; this.order.splice(index < 0 ? this.order.length : index, 0, layer.id); }
  removeLayer(id) { this.layers.delete(id); this.order = this.order.filter(value => value !== id); }
  setPaintProperty(id, key, value) { this.layers.get(id).paint[key] = structuredClone(value); }
  setLayoutProperty(id, key, value) { this.layers.get(id).layout[key] = structuredClone(value); }
  setFilter(id, filter) { this.layers.get(id).filter = structuredClone(filter); }
  isStyleLoaded() { return this.loaded; }
  setStyle(style) { this.style = style; this.loaded = false; this.sources.clear(); this.order = ['background', 'roads', 'place-labels']; this.layers = new Map(this.order.map(id => [id, { id, type: id === 'place-labels' ? 'symbol' : 'line' }])); }
  queryRenderedFeatures(_point, { layers }) { return this.hits.filter(hit => layers.includes(hit.layer.id)); }
  remove() { this.removed = true; }
}
const point = (coordinates, properties = {}) => ({ type: 'Feature', geometry: { type: 'Point', coordinates }, properties });
const line = (coordinates, properties = {}) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates }, properties });
const square = properties => ({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] }, properties });
const collection = (...features) => ({ type: 'FeatureCollection', features });
const tokens = '--day-1:#2a6fc4;--day-2:#1f8a5b;--day-3:#b5462f;--accent:#2563eb;--surface:#ffffff;--ink:#111110';
async function fixture(options = {}) {
  const container = document.createElement('div'); container.style.cssText = tokens; document.body.append(container);
  const instance = await createTripMap(container, { t: key => key, navigation: false, loadLibrary: async () => ({ Map: OrderedMap }), fetch: async url => Response.json({ version: 8, name: String(url), sources: {}, layers: [] }), ...options });
  return { container, instance, map: instance.map };
}
const tripsOrder = map => map.order.filter(id => id.startsWith('trips-') || id === 'place-labels');
afterEach(() => { document.body.replaceChildren(); });

describe('map abort signal', () => {
  it('rejects before creating anything when aborted during library load', async () => {
    const controller = new AbortController(); let release;
    const loadLibrary = () => new Promise(resolve => { release = () => resolve({ Map: OrderedMap }); });
    const container = document.createElement('div'); document.body.append(container);
    const pending = createTripMap(container, { t: key => key, loadLibrary, signal: controller.signal });
    await vi.waitFor(() => expect(release).toBeTypeOf('function')); controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' }); release();
    expect(container.classList.contains('trips-map')).toBe(false); expect(container.childElementCount).toBe(0);
    const early = new AbortController(); early.abort();
    await expect(createTripMap(container, { t: key => key, loadLibrary: async () => ({ Map: OrderedMap }), signal: early.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('destroys the map when the signal aborts after creation', async () => {
    const controller = new AbortController(); const { instance, map, container } = await fixture({ signal: controller.signal });
    instance.setMarkers('places', collection(point([1, 1], { id: 'p1' }))); controller.abort();
    expect(map.removed).toBe(true); expect(container.querySelector('.trips-map-attribution')).toBeNull(); expect(() => instance.setMarkers('places', collection())).toThrow();
  });
});

describe('map layer kinds', () => {
  it('draws clustered markers with token tones, literal colors, order badges and a selection ring', async () => {
    const { instance, map } = await fixture();
    instance.setMarkers('places', collection(point([1, 1], { id: 'p1', tone: 2, order: 1 }), point([2, 2], { id: 'p2', color: '#123456', order: 12345 }), point([3, 3], { id: 'p3', tone: 'nope', order: '<b>' })), { selected: 'p2' });
    const source = map.getSource('trips-places-source'); expect(source.cluster).toBe(true);
    expect(source.data.features.map(feature => [feature.properties.__trips_tone, feature.properties.__trips_hex, feature.properties.__trips_badge])).toEqual([['day-2', undefined, '1'], [undefined, '#123456', '1234'], [undefined, undefined, '<b>']]);
    const main = map.getLayer('trips-places'); expect(main.filter).toEqual(['!', ['has', 'point_count']]);
    expect(main.paint['circle-color']).toEqual(['case', ['has', '__trips_hex'], ['to-color', ['get', '__trips_hex']], ['match', ['get', '__trips_tone'], 'day-1', '#2a6fc4', 'day-2', '#1f8a5b', 'day-3', '#b5462f', 'accent', '#2563eb', 'ink', '#111110', '#2a6fc4']]);
    expect(map.getLayer('trips-places:badge').layout).toMatchObject({ 'text-field': ['get', '__trips_badge'], 'text-allow-overlap': true });
    expect(map.getLayer('trips-places-selected').filter[2]).toEqual(['==', ['get', '__trips_id'], 'p2']);
    instance.setSelected('places', null); expect(map.getLayer('trips-places-selected').filter[2][2]).toBe('\u0000');
    expect(map.getLayer('trips-places-clusters')).toBeTruthy(); expect(map.getLayer('trips-places:count')).toBeTruthy();
    expect(() => instance.setSelected('missing', 'x')).toThrow(); expect(() => instance.setMarkers('bad', collection(line([[0, 0], [1, 1]])))).toThrow();
  });
  it('dashes estimated routes and pending arcs, cases routes and tracks, and keeps lines under basemap labels', async () => {
    const { instance, map } = await fixture();
    instance.setMarkers('places', collection(point([0, 0])));
    instance.setRoutes('day-1', collection(line([[0, 0], [1, 1]], { tone: 1 }), line([[1, 1], [2, 2]], { tone: 1, estimated: true })));
    instance.setArcs('flights', collection(geodesicArc([2, 49], [-73, 40], { properties: { status: 'pending' } })));
    instance.setTracks('gpx', collection(line([[0, 0], [0, 1]])), { width: 2 });
    instance.setAreas('atlas', collection(square({ tone: 'accent', opacity: 2 }), square({})), { opacity: 0.3 });
    expect(map.getSource('trips-day-1-source').data.features.map(feature => feature.properties.__trips_dashed)).toEqual([false, true]);
    expect(map.getSource('trips-flights-source').data.features[0].properties.__trips_dashed).toBe(true);
    expect(map.getLayer('trips-day-1-dashed').paint['line-dasharray']).toEqual([2, 1.5]); expect(map.getLayer('trips-day-1-casing').paint['line-width']).toBe(7);
    expect(map.getLayer('trips-flights-casing')).toBeUndefined(); expect(map.getLayer('trips-gpx-casing').paint['line-width']).toBe(5);
    expect(map.getSource('trips-atlas-source').data.features.map(feature => feature.properties.__trips_opacity)).toEqual([1, 0.3]);
    expect(map.getLayer('trips-atlas').paint['fill-opacity']).toEqual(['get', '__trips_opacity']);
    expect(tripsOrder(map)).toEqual(['trips-atlas', 'trips-atlas-outline', 'trips-gpx-casing', 'trips-gpx', 'trips-gpx-dashed', 'trips-day-1-casing', 'trips-day-1', 'trips-day-1-dashed', 'trips-flights', 'trips-flights-dashed', 'place-labels', 'trips-places-selected', 'trips-places', 'trips-places:badge', 'trips-places-clusters', 'trips-places:count']);
    instance.setRoutes('day-1', collection(line([[0, 0], [1, 1]])), { casing: false });
    expect(map.getLayer('trips-day-1-casing')).toBeUndefined(); expect(map.sources.size).toBe(5);
    expect(() => instance.setRoutes('bad', collection(point([0, 0])))).toThrow(); expect(() => instance.setAreas('bad', collection(line([[0, 0], [1, 1]])))).toThrow(); expect(() => instance.setRoutes('bad', collection(), { width: 99 })).toThrow();
  });
  it('restores every kind, order and visibility after a theme change with new token colors', async () => {
    const { instance, map, container } = await fixture();
    instance.setPois('explore', collection(point([0, 0], { id: 'poi' })));
    instance.setRoutes('day-2', collection(line([[0, 0], [1, 1]], { tone: 2 })));
    instance.setVisible('explore', false);
    container.style.setProperty('--day-2', '#5fd39a'); container.style.setProperty('--surface', '#18181a');
    await instance.setTheme('dark'); expect(map.getLayer('trips-explore')).toBeUndefined(); map.loaded = true; map.emit('style.load');
    expect(map.getLayer('trips-explore').layout.visibility).toBe('none'); expect(map.getLayer('trips-explore').paint['circle-color']).toBe('#18181a');
    expect(map.getLayer('trips-day-2').paint['line-color'][3]).toContain('#5fd39a');
    expect(tripsOrder(map)).toEqual(['trips-day-2-casing', 'trips-day-2', 'trips-day-2-dashed', 'place-labels', 'trips-explore']);
    instance.setVisible('explore', true); expect(map.getLayer('trips-explore').layout.visibility).toBe('visible');
    container.style.setProperty('--day-2', '#000000'); instance.refresh(); expect(map.getLayer('trips-day-2').paint['line-color'][3]).toContain('#000000');
  });
  it('reports clicks and hovers per layer with public properties and expands clusters instead', async () => {
    const { instance, map } = await fixture();
    instance.setMarkers('places', collection(point([1, 1], { id: 'p1', name: 'Louvre' })));
    instance.setPois('explore', collection(point([2, 2], { id: 'x1' })), { interactive: false });
    const clicked = vi.fn(); const hovered = vi.fn(); const off = instance.onClick('places', clicked); instance.onHover('places', hovered);
    map.hits = [{ layer: { id: 'trips-places:badge' }, properties: { __trips_id: 'p1', __trips_badge: '1', name: 'Louvre' } }];
    map.emit('mousemove', { point: { x: 1, y: 1 } }); map.emit('mousemove', { point: { x: 1, y: 2 } }); map.emit('click', { point: { x: 1, y: 1 }, lngLat: { lng: 1, lat: 1 } });
    expect(clicked).toHaveBeenCalledWith({ key: 'places', id: 'p1', properties: { name: 'Louvre' }, lngLat: [1, 1] }); expect(hovered).toHaveBeenCalledOnce(); expect(map.canvas.style.cursor).toBe('pointer');
    map.hits = []; map.emit('mousemove', { point: { x: 9, y: 9 } }); expect(hovered).toHaveBeenLastCalledWith(null); expect(map.canvas.style.cursor).toBe('');
    off(); map.hits = [{ layer: { id: 'trips-places' }, properties: { __trips_id: 'p1' } }]; map.emit('click', { point: {} }); expect(clicked).toHaveBeenCalledOnce();
    const exploreClick = vi.fn(); instance.onClick('explore', exploreClick); map.hits = [{ layer: { id: 'trips-explore' }, properties: {} }]; map.emit('click', { point: {} }); expect(exploreClick).not.toHaveBeenCalled();
    map.hits = [{ layer: { id: 'trips-places-clusters' }, geometry: { type: 'Point', coordinates: [1, 1] }, properties: { cluster_id: 3, point_count: 2 } }];
    map.emit('click', { point: {} }); await vi.waitFor(() => expect(map.easeTo).toHaveBeenCalledWith(expect.objectContaining({ zoom: 9 })));
    expect(() => instance.onClick('places', 'nope')).toThrow();
  });
  it('switches to satellite imagery under basemap labels with Esri credit and honours the disabled list', async () => {
    const { instance, map, container } = await fixture();
    instance.setBasemap('satellite');
    expect(map.getSource('trips-satellite-source').tiles[0]).toContain('server.arcgisonline.com'); expect(map.order.indexOf('trips-satellite')).toBe(map.order.indexOf('place-labels') - 1);
    expect([...container.querySelectorAll('.trips-map-attribution a')].some(link => link.textContent.includes('Esri'))).toBe(true);
    await instance.setTheme('dark'); map.loaded = true; map.emit('style.load'); expect(map.getLayer('trips-satellite')).toBeTruthy();
    instance.setBasemap('map'); expect(map.getLayer('trips-satellite')).toBeUndefined(); expect(container.textContent).not.toContain('Esri');
    const disabled = await fixture({ config: { providers: { tiles: ['openfreemap'] }, disabled: ['esri'] } });
    expect(() => disabled.instance.setBasemap('satellite')).toThrow(); expect(() => instance.setBasemap('terrain')).toThrow();
  });
});

describe('map review fixes', () => {
  it('keeps numeric ids literal for selection and events', async () => {
    const { instance, map } = await fixture();
    instance.setMarkers('places', collection(point([1, 1], { id: 1234 })), { selected: 1234 });
    expect(map.getSource('trips-places-source').data.features[0].properties.__trips_id).toBe('1234');
    expect(map.getLayer('trips-places-selected').filter[2]).toEqual(['==', ['get', '__trips_id'], '1234']);
  });
  it('never selects id-less markers with an empty or unusable selection', async () => {
    const { instance, map } = await fixture();
    for (const selected of ['', {}, true]) { instance.setMarkers('places', collection(point([1, 1])), { selected }); expect(map.getLayer('trips-places-selected').filter[2][2]).toBe('\u0000'); }
    instance.setSelected('places', ''); expect(map.getLayer('trips-places-selected').filter[2][2]).toBe('\u0000');
  });
  it('rejects keys that collide with derived layer ids', async () => {
    const { instance } = await fixture();
    for (const key of ['day-casing', 'x-dashed', 'p-selected', 'a-outline', 'b-clusters', 'satellite', 'Bad']) expect(() => instance.setRoutes(key, collection())).toThrow();
    expect(() => instance.setRoutes('day-1', collection())).not.toThrow();
  });
  it('draws badge digits in ink on a surface halo and cluster counts in accent ink', async () => {
    const { instance, map, container } = await fixture(); container.style.setProperty('--accent-ink', '#fefefe');
    instance.setMarkers('places', collection(point([1, 1], { order: 1 })));
    expect(map.getLayer('trips-places:badge').paint).toEqual({ 'text-color': '#111110', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 });
    expect(map.getLayer('trips-places:count').paint).toMatchObject({ 'text-color': '#fefefe', 'text-halo-width': 0 });
  });
  it('keeps the current basemap and overlays when the next style fails to load, and retries later', async () => {
    let online = false; const errors = [];
    const fetch = vi.fn(async url => online ? Response.json({ version: 8, name: String(url), sources: {}, layers: [] }) : Promise.reject(new TypeError('offline')));
    const { instance, map } = await fixture({ fetch, onError: cause => errors.push(cause.message) }); const setStyle = vi.spyOn(map, 'setStyle');
    instance.setRoutes('day-1', collection(line([[0, 0], [1, 1]])));
    expect(await instance.setTheme('dark')).toBe(false); expect(setStyle).not.toHaveBeenCalled(); expect(errors).toEqual(['offline']);
    instance.setVisible('day-1', false); expect(map.getLayer('trips-day-1').layout.visibility).toBe('none');
    online = true; const first = instance.setTheme('dark'); const again = instance.setTheme('dark'); expect(await first).toBe(true); expect(await again).toBe(true);
    expect(setStyle).toHaveBeenCalledOnce(); expect(setStyle.mock.calls[0]).toEqual([expect.objectContaining({ name: 'https://tiles.openfreemap.org/styles/dark' }), { diff: false }]);
    map.loaded = true; map.emit('style.load'); expect(map.getLayer('trips-day-1').layout.visibility).toBe('none');
    expect(await instance.setTheme('dark')).toBe(false); expect(setStyle).toHaveBeenCalledOnce();
    const slow = instance.setTheme('light'); instance.destroy(); expect(await slow).toBe(false); expect(setStyle).toHaveBeenCalledOnce();
  });
  it('reloads the current theme only after its first style failed', async () => {
    class Cold extends OrderedMap { constructor(options) { super(options); this.loaded = false; } }
    const { instance, map } = await fixture({ loadLibrary: async () => ({ Map: Cold }) }); const setStyle = vi.spyOn(map, 'setStyle');
    expect(await instance.setTheme('light')).toBe(false); map.emit('error', { error: new Error('style fetch failed') });
    expect(await instance.setTheme('light')).toBe(true); expect(setStyle).toHaveBeenCalledOnce();
    map.loaded = true; map.emit('style.load'); expect(await instance.setTheme('light')).toBe(false);
  });
  it('lets a newer theme request supersede a pending one', async () => {
    let release; const fetch = vi.fn(url => String(url).endsWith('/dark') ? new Promise(resolve => { release = () => resolve(Response.json({ version: 8, sources: {}, layers: [] })); }) : Response.json({ version: 8, sources: {}, layers: [] }));
    const { instance, map } = await fixture({ fetch }); const setStyle = vi.spyOn(map, 'setStyle');
    const dark = instance.setTheme('dark'); await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect(await instance.setTheme('light')).toBe(false); release(); expect(await dark).toBe(false); expect(setStyle).not.toHaveBeenCalled();
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
  });
});

describe('atlas topology', () => {
  it('decodes the shipped countries into closed polygons that the area layer accepts', async () => {
    const topology = JSON.parse(await readFile(resolve('public/data/countries-50m.json'), 'utf8'));
    const countries = topologyFeatures(topology, 'countries');
    expect(countries.features.length).toBeGreaterThan(200);
    for (const feature of countries.features) {
      const polygons = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
      for (const ring of polygons.flat()) { expect(ring.length).toBeGreaterThanOrEqual(4); expect(ring[0]).toEqual(ring.at(-1)); }
    }
    const { instance, map } = await fixture(); instance.setAreas('countries', countries);
    expect(map.getSource('trips-countries-source').data.features).toHaveLength(countries.features.length);
    expect(() => topologyFeatures(topology, '__proto__')).toThrow(); expect(() => topologyFeatures({ type: 'Topology', objects: { a: { type: 'Polygon', arcs: [[5]] } }, arcs: [] }, 'a')).toThrow();
  });
});
