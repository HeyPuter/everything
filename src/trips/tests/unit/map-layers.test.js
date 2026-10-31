import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTripMap } from '../../src/map/index.js';
import { textLabel } from '../../src/map/labels.js';
class TestMap {
  constructor(options) { this.options = options; this.sources = new Map(); this.layers = new Map(); this.events = new Map(); this.controls = []; this.canvas = document.createElement('canvas'); this.loaded = true; this.features = []; this.easeTo = vi.fn(); }
  on(type, fn) { if (!this.events.has(type)) this.events.set(type, new Set()); this.events.get(type).add(fn); }
  off(type, fn) { this.events.get(type)?.delete(fn); }
  emit(type, event = {}) { for (const handler of this.events.get(type) ?? []) handler(event); }
  addControl(control) { this.controls.push(control); const element = control.onAdd(this); this.container?.append(element); }
  removeControl(control) { control.onRemove(); this.controls = this.controls.filter(value => value !== control); }
  getCanvas() { return this.canvas; }
  getSource(id) { return this.sources.get(id); }
  addSource(id, value) { this.sources.set(id, { ...value, setData(data) { this.data = data; }, getClusterExpansionZoom: vi.fn(async () => 8) }); }
  removeSource(id) { this.sources.delete(id); }
  getLayer(id) { return this.layers.get(id); }
  addLayer(layer) { this.layers.set(layer.id, structuredClone(layer)); }
  removeLayer(id) { this.layers.delete(id); }
  setPaintProperty(id, key, value) { this.layers.get(id).paint[key] = structuredClone(value); }
  setLayoutProperty(id, key, value) { this.layers.get(id).layout[key] = structuredClone(value); }
  isStyleLoaded() { return this.loaded; }
  setStyle(style) { this.style = style; this.loaded = false; this.sources.clear(); this.layers.clear(); }
  queryRenderedFeatures() { return this.features; }
  remove() { this.removed = true; }
}
class TestGeolocate {
  constructor(options) { this.options = options; this.handlers = new Map(); this.calls = 0; TestGeolocate.last = this; }
  on(type, fn) { this.handlers.set(type, fn); }
  off(type, fn) { if (this.handlers.get(type) === fn) this.handlers.delete(type); }
  onAdd() { this.root = document.createElement('div'); this.button = document.createElement('button'); this.root.append(this.button); this.button.addEventListener('click', () => this.calls++); return this.root; }
  onRemove() { this.removed = true; this.root.remove(); }
}
const feature = (coordinates, properties = {}) => ({ type: 'Feature', geometry: { type: 'Point', coordinates }, properties });
const collection = (...features) => ({ type: 'FeatureCollection', features });
const cluster = { layer: { id: 'trips-places-clusters' }, geometry: { type: 'Point', coordinates: [13, 52] }, properties: { cluster_id: 12, point_count: 2 } };
async function fixture(options = {}) {
  const container = document.createElement('div'); container.style.cssText = '--day-1:#2a6fc4;--surface:#ffffff;--ink:#111110'; document.body.append(container);
  const instance = await createTripMap(container, { t: key => 'translated:' + key, navigation: false, loadLibrary: async () => ({ Map: TestMap, GeolocateControl: TestGeolocate }), fetch: async url => Response.json({ version: 8, name: String(url), sources: {}, layers: [] }), ...options });
  return { container, instance, map: instance.map };
}
afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals(); });
describe('map labels and controls', () => {
  it('uses property text as a bounded literal, without expression or markup interpretation', async () => {
    const { instance, map, container } = await fixture(); const input = collection(feature([0, 0], { title: '{name}<img src=x>\u0000\u202E' }), feature([1, 1], { title: ['image', 'evil'] }), feature([2, 2], { title: 1234 }));
    instance.setLabels('names', input); const layer = map.getLayer('trips-names'); const source = map.getSource('trips-names-source');
    expect(layer.type).toBe('symbol'); expect(layer.layout['text-field']).toEqual(['get', '__trips_label']); expect(source.data.features.map(value => value.properties.__trips_label)).toEqual(['{name}<img src=x>  ', '', '1,234']);
    expect(input.features[0].properties).not.toHaveProperty('__trips_label'); expect(container.querySelector('img')).toBeNull(); expect([...textLabel('😀'.repeat(400))]).toHaveLength(300);
  });
  it('restores labels and token halos after a theme change and updates layouts in place', async () => {
    const { instance, map, container } = await fixture(); const data = collection(feature([0, 0], { title: 'Name' })); instance.setLabels('names', data);
    expect(map.getLayer('trips-names').paint).toMatchObject({ 'text-color': '#111110', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 });
    instance.setLabels('names', data, { textSize: 18, offset: [0, 1] }); expect(map.getLayer('trips-names').layout['text-size']).toBe(18);
    container.style.setProperty('--ink', '#f4f4f2'); container.style.setProperty('--surface', '#18181a'); await instance.setTheme('dark'); map.loaded = true; map.emit('style.load');
    expect(map.getLayer('trips-names').paint).toMatchObject({ 'text-color': '#f4f4f2', 'text-halo-color': '#18181a' }); expect(map.getSource('trips-names-source').data.features[0].properties.__trips_label).toBe('Name');
  });
  it('preserves the old layer for invalid label options or malformed geometry', async () => {
    const { instance, map } = await fixture(); const data = collection(feature([0, 0])); instance.setLayer('old', data);
    for (const options of [{ textProperty: 'constructor' }, { textSize: Infinity }, { offset: [0] }, { font: [] }]) expect(() => instance.setLabels('old', data, options)).toThrow();
    expect(() => instance.setLabels('old', collection(feature([])))).toThrow(); expect(map.getLayer('trips-old').type).toBe('circle'); expect(map.getSource('trips-old-source').data).toEqual(data);
  });
  it('supports line label placement and rejects mismatched symbol geometry', async () => {
    const { instance, map } = await fixture(); const line = collection({ type: 'Feature', properties: { title: 'Route' }, geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] } });
    expect(() => instance.setLabels('route', line)).toThrow(); instance.setLabels('route', line, { placement: 'line' }); expect(map.getLayer('trips-route').layout['symbol-placement']).toBe('line');
  });
  it('injects translated native navigation, geolocation and gesture strings', async () => {
    const { map } = await fixture(); expect(map.options.locale).toMatchObject({ 'Map.Title': 'translated:map.label', 'NavigationControl.ZoomIn': 'translated:map.zoomIn', 'GeolocateControl.FindMyLocation': 'translated:map.findLocation', 'CooperativeGesturesHandler.MobileHelpText': 'translated:map.gesturesMobile' });
  });
  it('keeps geolocation opt-in and blocks synthetic clicks, with control teardown', async () => {
    const first = await fixture(); expect(first.map.controls).toHaveLength(0);
    const onLocation = vi.fn(), onError = vi.fn(); const { instance, map } = await fixture({ geolocation: true, onLocation, onError }); const native = TestGeolocate.last;
    expect(native.options).toMatchObject({ trackUserLocation: false, positionOptions: { enableHighAccuracy: false } }); expect(native.calls).toBe(0); native.button.click(); expect(native.calls).toBe(0);
    native.handlers.get('geolocate')({ coords: { latitude: 1 } }); expect(onLocation).toHaveBeenCalledOnce(); instance.destroy(); expect(native.handlers.size).toBe(0); expect(native.removed).toBe(true); expect(map.controls).toHaveLength(0);
  });
});
describe('cluster labels and lifecycle', () => {
  it('adds localized counts, strips user cluster markers and permits count visibility changes', async () => {
    const { instance, map } = await fixture({ language: 'de' }); const data = collection(feature([0, 0], { point_count: 500, cluster_id: 99, title: 'Own point' }));
    instance.setLayer('places', data, { cluster: true }); expect(map.getSource('trips-places-source').data.features[0].properties).toEqual({ title: 'Own point' }); expect(data.features[0].properties.point_count).toBe(500);
    expect(map.getLayer('trips-places:count').layout['text-field']).toEqual(['number-format', ['get', 'point_count'], { locale: 'de', 'max-fraction-digits': 0 }]);
    instance.setLayer('places', data, { cluster: true, clusterLabels: false }); expect(map.getLayer('trips-places:count')).toBeUndefined(); instance.removeLayer('places'); expect(map.layers.size).toBe(0);
  });
  it('expands a clicked cluster with reduced motion and resets cursor after removal', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true })); const { instance, map } = await fixture(); instance.setLayer('places', collection(feature([0, 0])), { cluster: true }); map.features = [cluster]; map.emit('mousemove', { point: [1, 1] }); expect(map.canvas.style.cursor).toBe('pointer'); map.emit('click', { point: [1, 1] });
    await vi.waitFor(() => expect(map.easeTo).toHaveBeenCalledWith({ center: [13, 52], zoom: 8, duration: 0 })); instance.removeLayer('places'); expect(map.canvas.style.cursor).toBe('');
  });
  it.each(['remove', 'data', 'style', 'destroy'])('ignores delayed expansion after %s', async change => {
    const { instance, map } = await fixture(); instance.setLayer('places', collection(feature([0, 0])), { cluster: true }); const source = map.getSource('trips-places-source'); let resolve; source.getClusterExpansionZoom = () => new Promise(done => { resolve = done; });
    const pending = instance.expandCluster('places', cluster);
    if (change === 'remove') instance.removeLayer('places');
    if (change === 'data') instance.setLayer('places', collection(feature([1, 1])), { cluster: true });
    if (change === 'style') await instance.setTheme('dark');
    if (change === 'destroy') instance.destroy();
    resolve(10); expect(await pending).toBe(false); expect(map.easeTo).not.toHaveBeenCalled();
  });
  it('removes global map listeners and ignores non-interactive cluster clicks', async () => {
    const { instance, map } = await fixture(); instance.setLayer('places', collection(feature([0, 0])), { cluster: true, interactive: false }); map.features = [cluster]; map.emit('click', { point: [1, 1] }); await Promise.resolve(); expect(map.easeTo).not.toHaveBeenCalled(); instance.destroy(); expect([...map.events.values()].every(set => set.size === 0)).toBe(true);
  });
});

it('keeps installing layers while another source is still loading', async () => {
  const { instance, map } = await fixture(); instance.setLayer('first', collection(feature([0, 0]))); map.loaded = false;
  instance.setLayer('second', collection(feature([1, 1]))); expect(map.getLayer('trips-second')).toBeTruthy();
});
it('invalidates expansion at style-change start even when MapLibre retains the old source', async () => {
  const { instance, map } = await fixture(); instance.setLayer('places', collection(feature([0, 0])), { cluster: true }); const source = map.getSource('trips-places-source'); let resolve;
  source.getClusterExpansionZoom = () => new Promise(done => { resolve = done; }); const expansion = instance.expandCluster('places', cluster);
  map.setStyle = () => { map.loaded = false; }; await instance.setTheme('dark'); map.loaded = true; map.emit('style.load');
  expect(map.getSource('trips-places-source')).toBe(source); resolve(10); expect(await expansion).toBe(false); expect(map.easeTo).not.toHaveBeenCalled();
});
it.each(['remove', 'data', 'style', 'destroy'])('drops delayed expansion errors after %s', async change => {
  const { instance, map } = await fixture(); instance.setLayer('places', collection(feature([0, 0])), { cluster: true }); const source = map.getSource('trips-places-source'); let reject;
  source.getClusterExpansionZoom = () => new Promise((_done, fail) => { reject = fail; }); const pending = instance.expandCluster('places', cluster);
  if (change === 'remove') instance.removeLayer('places');
  if (change === 'data') instance.setLayer('places', collection(feature([1, 1])), { cluster: true });
  if (change === 'style') { map.setStyle = () => {}; await instance.setTheme('dark'); }
  if (change === 'destroy') instance.destroy();
  reject(new Error('retired source')); expect(await pending).toBe(false);
});
it('rejects non-point count placement before changing an existing layer', async () => {
  const { instance, map } = await fixture(); const data = collection(feature([0, 0])); instance.setLayer('places', data);
  expect(() => instance.setLayer('places', data, { cluster: true, clusterLabelOptions: { placement: 'line' } })).toThrow(); expect(map.getLayer('trips-places').type).toBe('circle'); expect(map.getSource('trips-places-source').cluster).toBeUndefined();
});
