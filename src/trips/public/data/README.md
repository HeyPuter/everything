# Bundled data

Built on 2026-10-24 from the reviewed sources below. Source checksums are SHA-256 of the downloaded input, before transformation. Dataset generation is independent of app builds and needs no Puter credentials.

| Artifact | Source | Input checksum | License |
| --- | --- | --- | --- |
| `airports.json` (7,917 unique IATA airports) | [mwgg/Airports at a89e4e0dda9d9878337e2da190ebe1ef1d6af705](https://raw.githubusercontent.com/mwgg/Airports/a89e4e0dda9d9878337e2da190ebe1ef1d6af705/airports.json) | `a7754cbe722ea21f0f9ab1ef07f4f07ee1e85b9cc99191ebde0b49fabb3c149a` | MIT; [notice](airports-LICENSE.txt) |
| `countries-50m.json` (241 geometries) | [world-atlas 2.0.2](https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-50m.json) | `04342cdc1e3016bcd7db1630de95684d67b79fe3c8c460321e87aef469502394` | ISC; [notice](countries-LICENSE.txt); Natural Earth public-domain source |
| `regions/<CC>.json` (4,487 admin-1 regions in 239 countries, 2.3 MB, median file 5 KB) and `regions/index.json` | [Natural Earth 10m admin-1 states and provinces v5.1.2](https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_10m_admin_1_states_provinces.geojson) | `22d0e3ad85eb3e27f17cabf8ba2d50e554fbc27a87796ff891d958185da62fb5` | Public domain (Natural Earth) |

Run `scripts/build-airports.mjs`, `scripts/build-countries.mjs` or `scripts/build-regions.mjs` with a local source file and its checksum to reproduce. The builders refuse to overwrite their input. Airport rows without a valid IATA code, coordinates or IANA zone are omitted; duplicate codes fail the build. Airport rows preserve upstream names and country identifiers.

Country topology follows Natural Earth's de facto boundary point of view, including its disputed areas, without app-specific political adjustments. A geometry count is not a count of sovereign states. Attribution and checksums are also recorded in the generated artifacts/provenance.

Regions are one TopoJSON per atlas country (object `regions`, feature id = region code, `properties.name` in English, `local` when the local name differs, `iso: false` for Natural Earth's `XX-X<n>` codes where a subdivision has no ISO 3166-2 code). Features sharing an ISO code are merged. Coordinates are on a 0.001° grid; shared borders are cut into shared arcs before Douglas–Peucker simplification at 0.02°, so neighbours never gap; islands under 0.0016 square degrees (about 20 km² at the equator) are dropped unless a region has nothing else; points there snap to the nearest region within 0.25°. Antarctica is left out. `index.json` lists the region count per country and `moved`, the regions filed under a country other than their code's prefix.

Region borders follow Natural Earth's default (de facto) point of view, the same as the country file: each region is filed under the country Natural Earth assigns it to (`iso_a2`), and areas it leaves without a country code (Somaliland, Northern Cyprus, the Sovereign Base Areas, Siachen and a few others) are omitted. The app does not adjudicate disputes.
