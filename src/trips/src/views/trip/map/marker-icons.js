import { MARKER_ICONS, markerGlyph } from './icons.js';

const GLYPH = 14;
const PREFIX = 'planmap-';
export const markerIconId = (name) => PREFIX + (Object.hasOwn(MARKER_ICONS, name) ? name : 'map-pin');

/**
 * Category glyphs over marker circles: the map wrapper has no icon layers, so this adds a symbol layer per marker
 * source (`trips-<key>-source`) under its badge layer, and re-adds images and layers after every basemap swap.
 */
export function createMarkerIcons(tripMap, container) {
  const map = tripMap.map;
  const layers = new Map();
  const cache = new Map();
  let color = '';
  let ready = false;
  let closed = false;
  let generation = 0;

  const surface = () => getComputedStyle(container).getPropertyValue('--surface').trim() || getComputedStyle(container).backgroundColor;
  async function rasterize(name, stroke, ratio) {
    const size = Math.ceil(GLYPH * ratio);
    const svg = markerGlyph(name, stroke, GLYPH);
    const image = new Image(size, size);
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = size; canvas.height = size;
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0, size, size);
    return { width: size, height: size, data: new Uint8Array(context.getImageData(0, 0, size, size).data.buffer) };
  }
  function addImages() {
    const ratio = Math.min(3, Math.max(1, globalThis.devicePixelRatio || 1));
    for (const [name, image] of cache.get(color) ?? []) {
      const id = PREFIX + name;
      try {
        if (map.hasImage(id)) map.removeImage(id);
        map.addImage(id, image, { pixelRatio: ratio });
      } catch { /* Style not loaded yet. */ }
    }
  }
  function install(key) {
    const entry = layers.get(key);
    const source = `trips-${key}-source`; const id = `trips-${key}-glyphs`; const badge = `trips-${key}:badge`;
    if (!ready || !entry) return;
    // Before the style has loaded MapLibre throws; the `style.load` handler installs again.
    try {
      if (!map.getSource(source)) return;
      const layout = { 'icon-image': ['get', 'icon'], 'icon-allow-overlap': true, 'icon-ignore-placement': true, visibility: entry.visible ? 'visible' : 'none' };
      if (!map.getLayer(id)) map.addLayer({ id, type: 'symbol', source, filter: ['all', ['!', ['has', 'point_count']], ['has', 'icon']], layout }, map.getLayer(badge) ? badge : undefined);
      else {
        map.setLayoutProperty(id, 'visibility', layout.visibility);
        if (map.getLayer(badge)) map.moveLayer(id, badge);
      }
    } catch { /* Style not loaded yet. */ }
  }
  async function prepare() {
    const current = ++generation; const stroke = surface();
    if (!cache.has(stroke)) {
      const ratio = Math.min(3, Math.max(1, globalThis.devicePixelRatio || 1));
      const entries = await Promise.all(Object.keys(MARKER_ICONS).map(async (name) => [name, await rasterize(name, stroke, ratio)]));
      cache.set(stroke, new Map(entries));
    }
    if (closed || current !== generation) return;
    color = stroke; ready = true;
    addImages(); for (const key of layers.keys()) install(key);
  }
  const onStyle = () => { if (!ready) return; addImages(); for (const key of layers.keys()) install(key); };
  map.on('style.load', onStyle);

  return {
    prepare,
    /** Call after each `setMarkers(key, …)`; features with an `icon` property (see `markerIconId`) get a glyph. */
    attach(key, { visible = true } = {}) { layers.set(key, { visible }); install(key); },
    /** Re-strokes glyphs when the surface token changed (app theme or contrast). */
    refresh() { if (surface() !== color) return prepare(); return Promise.resolve(); },
    destroy() { closed = true; map.off('style.load', onStyle); },
  };
}
