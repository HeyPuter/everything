// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile, rm, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { normalizeAirports, buildAirports } from '../../scripts/build-airports.mjs';
import { validateCountries, buildCountries } from '../../scripts/build-countries.mjs';
const airport = { iata: 'YVR', name: 'Vancouver', lat: '49.2', lon: '-123.2', tz: 'America/Vancouver' };
describe('reviewed dataset builders', () => {
  it('trims airport rows, validates zones/coordinates and refuses duplicate codes', () => {
    expect(normalizeAirports({ one: airport, two: { ...airport, iata: '' } })).toEqual([{ iata: 'YVR', name: 'Vancouver', city: '', country: '', lat: 49.2, lng: -123.2, tz: 'America/Vancouver' }]);
    expect(() => normalizeAirports([airport, airport])).toThrow('Duplicate'); expect(() => normalizeAirports([{ ...airport, tz: 'bad' }])).toThrow('No valid');
    for (const lat of [null, '', ' ', false]) expect(() => normalizeAirports([{ ...airport, lat }])).toThrow('No valid');
  });
  it('requires checksum verification and writes reproducible dataset provenance', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'trips-data-'));
    try {
      const input = join(dir, 'input.json'), output = join(dir, 'airports.json'); const raw = JSON.stringify([airport]); await writeFile(input, raw);
      await expect(buildAirports({ input, output, sha256: '0'.repeat(64) })).rejects.toThrow('checksum'); const sha256 = createHash('sha256').update(raw).digest('hex');
      expect(await buildAirports({ input, output, sha256 })).toBe(1); expect(JSON.parse(await readFile(output, 'utf8'))).toMatchObject({ source: 'mwgg/Airports', license: 'MIT', sha256 });
      await expect(buildAirports({ input, output: input, sha256 })).rejects.toThrow('overwrite');
      const symbolic = join(dir, 'alias.json'); await symlink(input, symbolic);
      await expect(buildAirports({ input, output: symbolic, sha256 })).rejects.toThrow('overwrite');
      const hard = join(dir, 'hard.json'); await link(input, hard);
      await expect(buildAirports({ input, output: hard, sha256 })).rejects.toThrow('overwrite');
      expect(await readFile(input, 'utf8')).toBe(raw);
    } finally { await rm(dir, { recursive: true }); }
  });
  it('validates country topology and emits its upstream boundary point of view', async () => {
    expect(() => validateCountries({ type: 'FeatureCollection' })).toThrow();
    const topology = { type: 'Topology', objects: { countries: { type: 'GeometryCollection', geometries: [{ type: 'Polygon', arcs: [[0]], id: '1' }] } }, arcs: [[[0, 0], [1, 0], [0, 1], [-1, -1]]] };
    const dir = await mkdtemp(join(tmpdir(), 'trips-countries-'));
    try {
      const raw = JSON.stringify(topology), input = join(dir, 'input.json'), output = join(dir, 'countries.json'); await writeFile(input, raw); const sha256 = createHash('sha256').update(raw).digest('hex');
      expect(await buildCountries({ input, output, sha256 })).toBe(1); expect(JSON.parse(await readFile(join(dir, 'countries-provenance.json'), 'utf8')).borders).toContain('de facto');
    } finally { await rm(dir, { recursive: true }); }
  });
});
