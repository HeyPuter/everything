# Trips external services

Puter has no maps, geocoding, routing or weather APIs, so these come from third parties called from the browser. One small worker that the developer runs proxies the services that have a global rate limit. Prices, limits and terms were checked in October 2026 and change often, so every provider sits behind an adapter that can be switched at runtime.

## 1. Adapters

`src/services/<capability>.js` each export one interface. Each adapter must:

- read its provider list from `config.json` (§4), so a provider can be switched off without a release;
- cache results in IndexedDB (per user) with the TTLs below;
- throttle and dedupe in the client, retry with backoff, and fall back to the next provider;
- return the attribution string for the UI to show;
- run offline from cache, and return `null` instead of throwing when nothing is cached.

| Capability | Interface |
| --- | --- |
| `tiles` | `styleUrl(theme)`, `satelliteSource()`, `attribution()` |
| `geocode` | `autocomplete(q, {bias, lang})`, `search(q, opts)`, `reverse(lat, lng)`, `pois(bbox, category)` |
| `placeInfo` | `details({wikidata, osm, tags, name, lat, lng, tz, lang})` → description, photos with credits, hours, facts |
| `route` | `route(points, mode, {avoid})`, `matrix(points, mode)`, `day({start, stops, end, mode})` |
| `weather` | `forecast(lat, lng)`, `normals(lat, lng, month)` |
| `fx` | `rates(base, date?)` |
| `holidays` | `public(country, year, region?)`, `school(country, year, subdivision?)`, `subdivisions(country)` |
| `tz` | `zoneAt(lat, lng)` (offline) |
| `airports` | `search(q)`, `byCode(iata)` (offline) |
| `images` | `search(q)` for cover images, with credits; `markUsed(photo)` |
| `transit` | `available()`, `plan({from, to, at, arriveBy})` |
| `flights` | `available()`, `status({number, date}, {key})` |
| `roadRoute` (road trips) | `route(points, {avoid})` → one line per leg plus toll, ferry and motorway flags when Valhalla answers |
| `corridor` (road trips) | `search(line, {categories, widthKm})`: fuel, charging, rest areas, campsites, lodging, food and sights along a line |
| `hazards` (road trips) | `gdacs()`, `dwd(bbox)` |

Keyed providers (Geoapify, ORS, Unsplash, AeroDataBox) use only the user's own key, passed as `createServices({keys})` (or per call for flight status), and run only when config lists them and a key exists.

## 2. Providers

| Capability | Default | Fallback | Via geo worker? | TTL | Notes |
| --- | --- | --- | --- | --- | --- |
| Map library | MapLibre GL JS (BSD-3) | none | n/a | n/a | lazy-loaded chunk |
| Tiles | OpenFreeMap `positron`/`liberty` (light), `dark` (dark) | CARTO with key (1M/month commercial), self-hosted PMTiles for a low-zoom world | **no** (proxying tiles is forbidden or pointless) | browser cache | commercial use OK, no SLA |
| Satellite | ESRI World Imagery | none | no | browser cache | attribution required |
| Autocomplete, search, reverse | Photon `photon.komoot.io` (debounce 300 ms, ≥3 chars, bias) | Nominatim (search submit and reverse only, never autocomplete); Geoapify key | Photon: no; **Nominatim: yes** | 30 days | Nominatim allows 1 req/s for the whole app |
| POIs | Photon category `include` filters + bbox (retries with the deprecated `osm_tag` filters if refused) | Geoapify Places | no | 1 day | do not use overpass-api.de |
| Place info | Wikidata → Wikipedia/Wikivoyage summaries, Commons images | Openverse (`license_type=commercial`) | **no** (per-browser limits are higher) | 30 days | send `Api-User-Agent`; CC BY-SA text needs credit and a link |
| Routing | FOSSGIS OSRM `routing.openstreetmap.de/routed-{car,bike,foot}` | FOSSGIS Valhalla (avoid options), ORS with a user key, straight line × 1.25 | **yes** (global 1 req/s, cache) | 7 days, rounded coordinates | `router.project-osrm.org` is non-commercial and ignores the foot/bike profiles; never use it |
| Transit | deep links (Google/Apple) | Transitous only if its operators confirm Trips qualifies (free, open source) | no | 10 min near the travel time, else 12 h | adapter built; off until config lists `transit: ["transitous"]` |
| Weather forecast | **decision D3**: MET Norway (commercial OK; ≤4 decimal coordinates; honour `Expires`) or Open-Meteo (non-commercial free tier) | the other | no | per `Expires`, ~1 h | credit MET Norway or Open-Meteo |
| Climate normals | NASA POWER climatology (public domain) | Open-Meteo archive (non-commercial) | optional shared cache | 365 days | 0.5° cells |
| FX rates | Frankfurter v2 (MIT, 223 currencies) | fawazahmed0 exchange-api on jsDelivr (CC0) | no | 12 h; frozen per expense | |
| Public holidays | Nager.Date v4 (`nagerVersion: 3` rolls back; v3 ends 2027-01-31) | OpenHolidays public holidays (ODbL) | no | permanent per (country, year) | `date-holidays` is not used: it declares `(ISC AND CC-BY-3.0)` with CC BY-SA 3.0 data, outside the license allowlist |
| School holidays | OpenHolidays (36 countries, ODbL) | none | no | 30 days | |
| Boundaries | `world-atlas` countries-50m (ISC, Natural Earth PD) as a static asset; admin-1 regions from NE 10m v5.1.2, simplified and split per country (`data/regions/<CC>.json`, fetched on demand) | none | n/a | static (service worker caches on first use) | Natural Earth's default (de facto) point of view for both; see `public/data/README.md` |
| Time zone | `@photostructure/tz-lookup` (CC0, offline) | airport tz for flights | n/a | n/a | |
| Airports | mwgg/Airports (MIT, includes tz), trimmed to IATA airports | OurAirports (PD) | n/a | static | avoid the OpenFlights repo (AGPL code) |
| Cover images | Openverse / Wikimedia search | user's own Unsplash key | no | 1 day | credit the author |
| Flight status | none without a key | AeroDataBox on RapidAPI with the user's key (browser-direct, `me:key:aerodatabox`) | no | 12 h far out, 10–30 min near departure, 7 days once final | no free option allows commercial use; no retries (calls count against the user's plan) |
| Road routing (road trip) | FOSSGIS Valhalla through the geo worker (per-leg shapes, `has_toll`/`has_ferry`/`has_highway`) | the shared `route` adapter (OSRM, ORS, straight line), without flags | **yes** | 7 days | `roadRoute.js`; uses the `route` provider list |
| EV charging and places along the route (road trip) | OSM `amenity=charging_station` and the other corridor tags via Photon `include` filters, one request per box | Geoapify Places with a user key; MobiData BW OCPDB (DE/CH) not built until its terms are confirmed | no | 1 day | `corridor.js`; uses the `pois` provider list |
| Hazards (road trip) | GDACS event list (orange and red, last 14 days) | DWD WFS `Warnungen_Landkreise` (Germany only) | no | 10 min | `hazards.js`; provider list `hazards` |

## 3. Geo worker (`trips-geo`, developer-run)

- **Why:** Nominatim and FOSSGIS routing limit the whole application to about 1 request per second, require caching and identification, and must be switchable by their operators without an app update. That can only be enforced in one shared place.
- **Who pays:** the developer account, for KV cache operations and rent. This is the one deployer-paid piece, kept small.
- **Code:** `worker-geo/index.js`, built like the trip worker. Deployed by CI with `HeyPuter/puter-worker-deploy-action` (copy `.github/workflows/deploy-meetings-worker.yml`).
- **Routes:** `GET /nominatim/search|reverse|lookup`, `POST /route`, `POST /matrix` (OSRM), `POST /valhalla` (avoid options), `GET /config`. Plain `fetch` without credentials; the client throttles per user.
- **Cache:**
  1. a per-isolate LRU;
  2. then KV `geo:<provider>:<sha256(normalized request)>` with `expire`.
  Normalization: lowercase, language, a rounded viewbox; 5 decimals for reverse lookups; rounded waypoints plus the profile for routes.
- **Global limiter:** `incr('rl:<provider>:<epochSecond>')` with a 5 s expiry. Over the limit, wait up to 1 s, then answer 429 with `Retry-After` and let the client fall back to a straight line. KV `incr` is atomic only per region, so upstream calls stay off until the operator writes `geo:config` = `{regions, limits?, disabled?, killed?}` in the worker's KV; each region then gets `limit / regions`. `disabled` and `killed` are the kill switch (re-read every 30 s); cached answers are still served.
- **Budgets:**
  - the worker's own KV bucket is ~40 ops/s, so the isolate cache absorbs repeats;
  - cache only successful responses;
  - cap any single value at 300 KB.
- **Identification:** `User-Agent: PuterTrips/1.0 (+https://trips.puter.com)`.
- **Scale warning:** public FOSSGIS and Nominatim capacity covers a beta, not a large launch. Before a wide launch, choose a keyed provider (Geoapify, ORS, or a hosted OSRM/Valhalla) behind this worker (**decision D4**).

## 4. Runtime config

`public/config.json` is served no-cache with the app:

```json
{
  "providers": {
    "tiles": ["openfreemap"],
    "geocode": ["photon", "nominatim"],
    "pois": ["photon"],
    "placeInfo": ["wikimedia"],
    "route": ["geo-osrm", "geo-valhalla", "ors", "straight"],
    "weather": ["metno"],
    "normals": ["nasa"],
    "fx": ["frankfurter", "fawaz"],
    "publicHolidays": ["nager", "openholidays"],
    "schoolHolidays": ["openholidays"],
    "subdivisions": ["openholidays"],
    "images": ["unsplash", "openverse", "wikimedia"],
    "flights": ["aerodatabox"],
    "hazards": ["gdacs", "dwd"]
  },
  "geoWorker": null,
  "nagerVersion": 4,
  "disabled": []
}
```

Optional entries: `openmeteo` in `weather` or `normals` (D3), `geoapify` in `geocode` or `pois`, `esri` in `disabled` to drop satellite imagery, `"transit": ["transitous"]` once Transitous confirms Trips may use it. `geoWorker` stays `null` until `trips-geo` is deployed (H3).

The client reads it at boot and caches it for 1 hour. To pull a misbehaving provider within minutes, edit this file and redeploy only the static file.

## 5. Policy rules for agents

- Never call `overpass-api.de`, `router.project-osrm.org`, `tile.openstreetmap.org` (bulk or prefetch is forbidden), or any keyed API with a developer key from the browser.
- Prefetch only OpenFreeMap vector tiles for offline use, within their stated limits (4 parallel requests, identify the app).
- **Attribution** must be visible:
  - OSM and OpenFreeMap on every map, plus the FOSSGIS "fix the map" link when routes are shown;
  - the weather provider in the weather panel;
  - per-image author and license for Commons and Openverse;
  - CC BY-SA link for Wikipedia and Wikivoyage text;
  - Natural Earth (optional, but credit it in About).
- Keep OSM-derived caches internal. Publishing or exporting them as a dataset triggers ODbL share-alike.
- No AGPL or GPL code in the bundle (`npm run check:licenses`). LGPL/MPL need a note in the PR. `opening_hours` (LGPL) is excluded; use `simple-opening-hours` (MIT).
- **Libraries** (licenses checked):

  | Purpose | Library |
  | --- | --- |
  | GPX/KML parsing | `@tmcw/togeojson` (BSD-2) |
  | GPX export | `@dwayneparton/geojson-to-gpx` (MIT) |
  | ICS | write it ourselves, or adapt `src/calendar/src/js/ics.js` |
  | PDF | print CSS; `pagedjs` (MIT) only if page numbers are needed |
  | Map helpers | `@turf/*` (MIT), `supercluster` (ISC), `@mapbox/polyline` (BSD-3), `topojson-client` (ISC) |
  | HEIC | must pass the license check; libheif-based packages are LGPL, so prefer platform decoding where the browser supports it |
