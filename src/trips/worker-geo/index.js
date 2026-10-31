import { createGeoHandler } from './handler.js';
// Upstream calls stay off until the operator writes `geo:config` with the verified region count (services.md §3).
const handler = createGeoHandler({ kv: me.puter.kv, enabled: ['nominatim', 'osrm', 'valhalla'] });
for (const method of ['get', 'post', 'options']) router[method]('/*path', ({ request }) => handler(request));
