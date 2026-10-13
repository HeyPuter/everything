// Fails the build when an installed dependency has a license outside the
// reviewed open-source set (no commercial, source-available or custom terms).
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const root = path.resolve(import.meta.dirname, '..');
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const approved = new Set(['OFL-1.1', 'MIT', 'MIT-0', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', 'MPL-2.0', 'BlueOak-1.0.0', 'CC0-1.0', '0BSD', 'Python-2.0', 'CC-BY-4.0', '(MIT OR CC0-1.0)', '(MIT OR Apache-2.0)', '(BSD-2-Clause OR MIT OR Apache-2.0)', 'MIT OR Apache-2.0', 'Apache-2.0 OR MIT']);
const failures = [];
let count = 0;
for (const [location, pkg] of Object.entries(lock.packages)) {
  if (!location) continue;
  count++;
  const license = pkg.license;
  if (!approved.has(license)) failures.push(`${location}@${pkg.version}: ${JSON.stringify(license)}`);
}
// The en_US spelling dictionary (Edit > Spelling): SCOWL size 60 with the Ispell-derived affix file, vendored
// unmodified from dictionary-en 4.0.0. Its notices require the copyright and permission text to travel with it.
const dictDir = path.join(root, 'public/dictionaries');
const dictionaryLicense = fs.readFileSync(path.join(dictDir, 'en-US-LICENSE.txt'), 'utf8');
if (!dictionaryLicense.includes('Copyright 2000-2018 by Kevin Atkinson') || !dictionaryLicense.includes('Copyright 1993, Geoff Kuenning') || !dictionaryLicense.includes('WordNet 1.6 Copyright 1997 by Princeton University')) failures.push('Missing en_US dictionary copyright and permission notices');
for (const [file, hash] of [
  ['en-US.aff', '8ae1f19d4840d957728ad90555d5a8dff6cc5c046279c95ff0c00fc0a0136c7b'],
  ['en-US.dic', 'f0b1a234bd178bdd01875b2a392a9647f888b8fe879f79c52aae62c2759b3647'],
  ['en-US-LICENSE.txt', '2a7e8d8ae9e8facc84818546ae2a8d83aec5e9c80a675ff789acd1c338b53b3d'],
]) {
  if (createHash('sha256').update(fs.readFileSync(path.join(dictDir, file))).digest('hex') !== hash) failures.push(`${file} differs from its reviewed provenance`);
}
// Hyphenation patterns (model/hyphenation): TeX pattern files kept byte for byte, each under a permissive license whose notice is in its header.
const { PATTERN_FILES, PATTERN_LICENSES } = await import('../src/model/hyphenation/patterns.js');
const patternDir = path.join(root, 'src/model/hyphenation');
let patternCount = 0;
for (const [key, p] of Object.entries(PATTERN_FILES)) {
  const file = path.join(patternDir, p.file);
  if (!fs.existsSync(file)) {
    failures.push(`Hyphenation patterns ${key}: missing ${p.file}`);
    continue;
  }
  const data = fs.readFileSync(file);
  if (!PATTERN_LICENSES.includes(p.license)) failures.push(`Hyphenation patterns ${p.file}: unapproved license ${JSON.stringify(p.license)}`);
  if (!p.notice || !data.toString('utf8').includes(p.notice)) failures.push(`Hyphenation patterns ${p.file}: license notice missing`);
  if (createHash('sha256').update(data).digest('hex') !== p.sha256) failures.push(`${p.file} differs from its reviewed provenance`);
  patternCount++;
}
for (const f of fs.readdirSync(patternDir)) {
  if (f.endsWith('.tex') && !Object.values(PATTERN_FILES).some((p) => p.file === f)) failures.push(`Hyphenation patterns ${f}: not reviewed (add it to PATTERN_FILES)`);
}
if (failures.length) {
  console.error(`Unapproved licenses:\n${failures.join('\n')}`);
  process.exit(1);
}
console.log(`Licenses OK (${count} packages; en_US dictionary (SCOWL) notices verified; ${patternCount} hyphenation pattern files verified).`);
