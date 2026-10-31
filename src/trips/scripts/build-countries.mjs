import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { distinctOutput } from './data-io.mjs';
export function validateCountries(input) {
  if (input?.type !== 'Topology' || !input.objects?.countries || !Array.isArray(input.arcs) || input.arcs.length > 1_000_000) throw new Error('Expected world-atlas countries TopoJSON');
  if (input.objects.countries.type !== 'GeometryCollection' || !Array.isArray(input.objects.countries.geometries) || !input.objects.countries.geometries.length) throw new Error('Countries missing');
  return input;
}
export async function buildCountries({ input, sha256, output = new URL('../public/data/countries-50m.json', import.meta.url) } = {}) {
  if (!input || !/^[a-f0-9]{64}$/.test(sha256 ?? '')) throw new Error('Provide a reviewed local TopoJSON input and its SHA-256');
  const raw = await readFile(input); const hash = createHash('sha256').update(raw).digest('hex'); if (hash !== sha256) throw new Error('Input checksum mismatch');
  const topology = validateCountries(JSON.parse(raw)); const target = await distinctOutput(input, output);
  const provenance = await distinctOutput(input, new URL('./countries-provenance.json', target));
  if (target.href === provenance.href) throw new Error('Dataset output must not overwrite its provenance');
  await mkdir(new URL('.', target), { recursive: true }); await writeFile(target, JSON.stringify(topology) + '\n');
  const manifest = { source: 'world-atlas countries-50m', license: 'ISC / Natural Earth public domain', sha256: hash, borders: 'Natural Earth de facto boundaries; disputed areas follow the upstream Natural Earth point of view.' };
  await writeFile(provenance, JSON.stringify(manifest, null, 2) + '\n');
  return topology.objects.countries.geometries.length;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input, sha256, output] = process.argv.slice(2);
  buildCountries({ input, sha256, ...(output ? { output } : {}) }).then(count => process.stdout.write(`Wrote ${count} country geometries\n`)).catch(cause => { process.stderr.write(cause.message + '\n'); process.exitCode = 1; });
}
