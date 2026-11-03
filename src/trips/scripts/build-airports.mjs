import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { distinctOutput } from './data-io.mjs';

export function normalizeAirports(input) {
  const rows = Array.isArray(input) ? input : Object.values(input);
  const airports = new Map();
  for (const row of rows) {
    if (!/^[A-Z]{3}$/.test(row.iata ?? '')) continue;
    const longitude = row.lon ?? row.lng;
    const validNumber = value => typeof value === 'number' || (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value.trim()));
    if (!validNumber(row.lat) || !validNumber(longitude)) continue;
    const lat = Number(row.lat), lng = Number(longitude);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180 || typeof row.name !== 'string' || typeof row.tz !== 'string') continue;
    try { new Intl.DateTimeFormat('en', { timeZone: row.tz }); } catch { continue; }
    if (airports.has(row.iata)) throw new Error(`Duplicate IATA code: ${row.iata}`);
    airports.set(row.iata, { iata: row.iata, name: row.name, city: row.city ?? '', country: row.country ?? '', lat, lng, tz: row.tz });
  }
  if (!airports.size) throw new Error('No valid IATA airports');
  return [...airports.values()].sort((a, b) => a.iata.localeCompare(b.iata));
}
export async function buildAirports({ input, output = new URL('../public/data/airports.json', import.meta.url), sha256 } = {}) {
  if (!input || !/^[a-f0-9]{64}$/.test(sha256 ?? '')) throw new Error('Provide a reviewed local JSON input and its SHA-256');
  const raw = await readFile(input); const hash = createHash('sha256').update(raw).digest('hex'); if (hash !== sha256) throw new Error('Input checksum mismatch');
  const airports = normalizeAirports(JSON.parse(raw));
  const target = await distinctOutput(input, output);
  await mkdir(new URL('.', target), { recursive: true });
  await writeFile(target, JSON.stringify({ source: 'mwgg/Airports', license: 'MIT', sha256: hash, airports }) + '\n');
  return airports.length;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input, sha256, output] = process.argv.slice(2);
  buildAirports({ input, sha256, ...(output ? { output } : {}) }).then(count => process.stdout.write(`Wrote ${count} airports\n`)).catch(cause => { process.stderr.write(cause.message + '\n'); process.exitCode = 1; });
}
