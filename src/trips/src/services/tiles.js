const ESRI = 'Tiles © Esri — Sources: Esri, Maxar, Earthstar Geographics, and the GIS User Community';
export function createTiles(config) {
  const enabled = name => Boolean(config.providers?.tiles?.includes(name)) && !config.disabled?.includes(name);
  return {
    styleUrl(theme) {
      if (!['light', 'dark'].includes(theme)) throw new RangeError('Invalid theme');
      if (!enabled('openfreemap')) return null;
      return `https://tiles.openfreemap.org/styles/${theme === 'dark' ? 'dark' : 'positron'}`;
    },
    /** Null when `esri` is in the disabled list. */
    satelliteSource() {
      if (config.disabled?.includes('esri')) return null;
      return { type: 'raster', tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'], tileSize: 256, maxzoom: 19, attribution: ESRI };
    },
    satelliteAttribution() { return [{ text: ESRI, url: 'https://www.esri.com/' }]; },
    attribution() { return [{ text: 'OpenFreeMap', url: 'https://openfreemap.org/' }, { text: '© OpenMapTiles', url: 'https://openmaptiles.org/' }, { text: '© OpenStreetMap contributors', url: 'https://www.openstreetmap.org/copyright' }]; },
  };
}
