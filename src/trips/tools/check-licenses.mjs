// Fails the build when an installed dependency has a license outside the
// reviewed open-source set (no commercial, source-available or custom terms).
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const approved = new Set(['MIT', 'MIT-0', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', 'MPL-2.0', 'BlueOak-1.0.0', 'CC0-1.0', '0BSD', 'Python-2.0', 'CC-BY-4.0', '(MIT OR CC0-1.0)', '(MIT OR Apache-2.0)', '(BSD-2-Clause OR MIT OR Apache-2.0)', 'MIT OR Apache-2.0', 'Apache-2.0 OR MIT']);
const failures = [];
let count = 0;
for (const [location, pkg] of Object.entries(lock.packages)) {
  if (!location) continue;
  count++;
  const license = pkg.license;
  if (!approved.has(license)) failures.push(`${location}@${pkg.version}: ${JSON.stringify(license)}`);
}
if (failures.length) {
  console.error(`Unapproved licenses:\n${failures.join('\n')}`);
  process.exit(1);
}
console.log(`Licenses OK (${count} packages).`);
