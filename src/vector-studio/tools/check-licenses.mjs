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
// The spelling dictionaries (Edit > Spelling): SCOWL size 60 with the Ispell-derived affix file, vendored
// unmodified from dictionary-en 4.0.0 (en_US) and dictionary-en-gb 3.0.0 (en_GB-ise word list; its affix
// file is byte for byte the en_US one, which it shares). Their notices require the copyright and permission
// text to travel with them.
const dictDir = path.join(root, 'public/dictionaries');
for (const lic of ['en-US-LICENSE.txt', 'en-GB-LICENSE.txt']) {
  const dictionaryLicense = fs.readFileSync(path.join(dictDir, lic), 'utf8');
  if (!dictionaryLicense.includes('Copyright 2000-2018 by Kevin Atkinson') || !dictionaryLicense.includes('Copyright 1993, Geoff Kuenning') || !dictionaryLicense.includes('WordNet 1.6 Copyright 1997 by Princeton University')) failures.push(`Missing dictionary copyright and permission notices in ${lic}`);
}
// The French dictionary (Grammalecte "Classique", from dictionary-fr 3.0.0) is MPL-2.0, distributed unmodified
// with its notices; its source is https://grammalecte.net/ and https://github.com/wooorm/dictionaries.
const frLicense = fs.readFileSync(path.join(dictDir, 'fr-FR-LICENSE.txt'), 'utf8');
if (!/MPL/.test(frLicense) || !/Mozilla Public License/.test(frLicense) || !fs.readFileSync(path.join(dictDir, 'fr-FR.aff'), 'utf8').includes('http://mozilla.org/MPL/2.0/')) failures.push('Missing fr_FR dictionary MPL-2.0 notices');
for (const [file, hash] of [
  ['en-US.aff', '8ae1f19d4840d957728ad90555d5a8dff6cc5c046279c95ff0c00fc0a0136c7b'],
  ['en-US.dic', 'f0b1a234bd178bdd01875b2a392a9647f888b8fe879f79c52aae62c2759b3647'],
  ['en-US-LICENSE.txt', '2a7e8d8ae9e8facc84818546ae2a8d83aec5e9c80a675ff789acd1c338b53b3d'],
  ['en-GB.dic', '869fe17ba4ee4b5401c60a666ee2d6a3dcc237f460b7294435df1cc6a799aa57'],
  ['en-GB-LICENSE.txt', '81b644347b40804c25811267efbea024a30b2bb1642fefa9c9c50f7b0bbcb67f'],
  ['fr-FR.aff', '05a735d34c912e4e381ff08ee7c747923ccf5cf9dca81d8467982fa1ca51c2b7'],
  ['fr-FR.dic', '984e933237bc1224a48f42828233be9b03228260ef67aa8e2bdddcd03a26230d'],
  ['fr-FR-LICENSE.txt', '0c785aebc7aae8aa00b8163e9b3219a8785a9900b71e85475204e48a5651ced4'],
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
console.log(`Licenses OK (${count} packages; en_US and en_GB (SCOWL) and fr_FR dictionary notices verified; ${patternCount} hyphenation pattern files verified).`);
