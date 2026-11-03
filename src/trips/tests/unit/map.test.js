import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTripMap } from '../../src/map/index.js';
import { createTiles } from '../../src/services/tiles.js';
import { DEFAULT_CONFIG } from '../../src/services/core.js';
class FakeMap {
  constructor(options) { this.options = options; this.sources = new Map(); this.layers = new Map(); this.events = new Map(); this.canvas = document.createElement('canvas'); this.loaded = true; this.paintCalls = []; }
  on(name, handler) { this.events.set(name, handler); }
  off(name, handler) { if (this.events.get(name) === handler) this.events.delete(name); }
  emit(name) { this.events.get(name)?.(); }
  getCanvas() { return this.canvas; }
  addControl() {}
  isStyleLoaded() { return this.loaded; }
  getSource(id) { return this.sources.get(id); }
  addSource(id, source) { this.sources.set(id, { ...source, setData(data) { this.data = data; } }); }
  getLayer(id) { return this.layers.get(id); }
  addLayer(layer) { this.layers.set(layer.id, layer); }
  removeLayer(id) { this.layers.delete(id); }
  removeSource(id) { this.sources.delete(id); }
  setPaintProperty(...args) { this.paintCalls.push(args); }
  setStyle(style) { this.style = style; this.sources.clear(); this.layers.clear(); this.loaded = false; }
  fitBounds(...args) { this.bounds = args; }
  resize() {}
  remove() { this.removed = true; }
}
const data = { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [13, 52] }, properties: { title: '<title>' } }] };
const fixture = async () => {
  const container = document.createElement('div'); document.body.append(container); container.style.setProperty('--day-1', '#2a6fc4'); container.style.setProperty('--surface', '#fff');
  const loader = vi.fn(async () => ({ Map: FakeMap })); const instance = await createTripMap(container, { t: key => key, loadLibrary: loader, fetch: async url => Response.json({ version: 8, name: String(url), sources: {}, layers: [] }) }); return { container, loader, instance, map: instance.map };
};
afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals(); });
describe('map wrapper', () => {
  it('loads the library only on creation and keeps keyboard/attribution accessible', async () => {
    const { instance, container, loader, map } = await fixture(); expect(loader).toHaveBeenCalledOnce(); expect(map.options.keyboard).toBe(true); expect(map.canvas.getAttribute('aria-label')).toBe('map.label');
    expect(container.querySelectorAll('.trips-map-attribution a')).toHaveLength(3); expect(container.querySelector('a').rel).toContain('noopener'); instance.destroy(); expect(map.removed).toBe(true);
  });
  it('restores GeoJSON and cluster layers after theme changes', async () => {
    const { instance, map } = await fixture(); instance.setLayer('places', data, { cluster: true }); expect(map.getSource('trips-places-source').cluster).toBe(true); expect(map.getLayer('trips-places-clusters')).toBeTruthy();
    expect(await instance.setTheme('dark')).toBe(true); expect(map.style.name).toBe('https://tiles.openfreemap.org/styles/dark'); expect(map.layers.size).toBe(0); map.loaded = true; map.emit('style.load');
    expect(map.getSource('trips-places-source').data).toEqual(data); expect(map.getLayer('trips-places-clusters')).toBeTruthy();
    instance.removeLayer('places'); expect(map.layers.size).toBe(0); expect(map.sources.size).toBe(0);
  });
  it('updates data and cluster colors without duplicating sources', async () => {
    const { instance, map } = await fixture(); instance.setLayer('places', data, { cluster: true }); instance.setLayer('places', { type: 'FeatureCollection', features: [] }, { cluster: true, color: '#ff0000' });
    expect(map.sources.size).toBe(1); expect(map.getSource('trips-places-source').data.features).toHaveLength(0); expect(map.paintCalls.some(([id, key, value]) => id === 'trips-places-clusters' && key === 'circle-color' && value === '#ff0000')).toBe(true);
  });
  it('validates inputs and treats attribution text as text', async () => {
    const { instance, container } = await fixture(); expect(() => instance.setLayer('../bad', data)).toThrow(); expect(() => instance.setLayer('places', { ...data, features: [{ ...data.features[0], geometry: { type: 'Point', coordinates: [0, 91] } }] })).toThrow();
    instance.setAttribution([{ text: '<img src=x onerror=alert(1)>', url: 'https://example.com' }, { text: 'bad', url: 'javascript:alert(1)' }]); expect(container.querySelector('img')).toBeNull(); expect(container.textContent).toContain('<img'); expect(container.querySelectorAll('a')).toHaveLength(4);
  });
  it('keeps an existing layer when its proposed replacement is invalid', async () => {
    const { instance, map } = await fixture(); instance.setLayer('places', data);
    expect(() => instance.setLayer('places', { type: 'invalid' }, { type: 'line' })).toThrow();
    expect(map.getSource('trips-places-source').data).toEqual(data);
    expect(map.getLayer('trips-places').type).toBe('circle'); instance.destroy();
  });
  it('fits validated bounds with reduced motion and removes listeners idempotently', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true })); const { instance, map, container } = await fixture(); instance.fit([[0, 0], [10, 20]]); expect(map.bounds).toEqual([[[0, 0], [10, 20]], expect.objectContaining({ duration: 0 })]);
    instance.destroy(); instance.destroy(); expect(map.events.size).toBe(0); expect(container.querySelector('.trips-map-attribution')).toBeNull(); expect(() => instance.setLayer('places', data)).toThrow();
  });
  it('honors disabled basemaps and supplies satellite source credits', () => {
    expect(createTiles({ providers: { tiles: [] } }).styleUrl('light')).toBeNull(); expect(createTiles(DEFAULT_CONFIG).satelliteSource().attribution).toContain('Esri');
  });
});
