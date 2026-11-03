import { arcGeoJSON, createTripMap, geodesicArc, topologyFeatures } from '../../src/map/index.js';
import { loadMapLibre } from '../../src/map/library.js';

await loadMapLibre();
globalThis.mapFixture = { arcGeoJSON, createTripMap, geodesicArc, topologyFeatures };
document.documentElement.dataset.ready = 'true';
