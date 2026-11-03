// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { createAirports } from '../../src/services/airports.js';

const path = (file) => resolve('public/data', file);
describe('bundled licensed datasets', () => {
  it('provides airport lookup using the production adapter over the shipped data', async () => {
    const raw = await readFile(path('airports.json'), 'utf8');
    const adapter = createAirports({ fetch: async () => new Response(raw, { headers: { 'Content-Type': 'application/json' } }) });
    expect(await adapter.byCode('yvr')).toMatchObject({ iata: 'YVR', country: 'CA', tz: 'America/Vancouver' });
    expect((await adapter.search('Heathrow')).some((airport) => airport.iata === 'LHR')).toBe(true);
    const data = JSON.parse(raw);
    expect(new Set(data.airports.map((row) => row.iata)).size).toBe(data.airports.length);
    expect(data.airports.every((row) => Number.isFinite(row.lat) && Number.isFinite(row.lng))).toBe(true);
  }, 30_000); // Parses and indexes the full airport list.
  it('ships the declared dataset counts, source checksums and required license notices', async () => {
    const manifest = JSON.parse(await readFile(path('manifest.json'), 'utf8'));
    const airports = JSON.parse(await readFile(path(manifest.airports.file), 'utf8'));
    const topology = JSON.parse(await readFile(path(manifest.countries.file), 'utf8'));
    const provenance = JSON.parse(await readFile(path('countries-provenance.json'), 'utf8'));
    expect(airports.airports).toHaveLength(manifest.airports.count);
    expect(topology.objects.countries.geometries).toHaveLength(manifest.countries.count);
    expect(airports.sha256).toBe(manifest.airports.inputSha256);
    expect(provenance.sha256).toBe(manifest.countries.inputSha256);
    expect(await readFile(path(manifest.airports.notice), 'utf8')).toContain('Copyright (c) 2014 mwgg');
    expect(await readFile(path(manifest.countries.notice), 'utf8')).toContain('Copyright 2013-2019 Michael Bostock');
  });
});
