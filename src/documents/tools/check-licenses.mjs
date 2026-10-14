import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
execFileSync(process.execPath, [path.join(root, 'tools/generate-opentype-vendor.mjs'), '--check'], { stdio: 'inherit' });
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
// Explicitly reviewed SPDX expressions. Unknown/missing declarations fail closed.
const approved = new Set(['MIT', 'MIT-0', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', 'MPL-2.0', 'BlueOak-1.0.0', 'CC0-1.0', '(MIT AND Zlib)']);
const failures = [];
const selawikLicense = fs.readFileSync(path.join(root, 'public/fonts/Selawik-OFL.txt'), 'utf8');
if (!selawikLicense.includes('SIL OPEN FONT LICENSE Version 1.1') || !selawikLicense.includes('Copyright 2015, Microsoft Corporation') || !selawikLicense.includes('Reserved Font Name Selawik')) failures.push('Missing Selawik copyright/OFL license');
if (createHash('sha256').update(fs.readFileSync(path.join(root, 'public/fonts/Selawik-Semibold.ttf'))).digest('hex') !== '0a9e9d0549a10f24bef9b3a29e06fe6e0b5c21e7a784c503b048a307841a7783') failures.push('Selawik Semibold differs from its reviewed provenance');
const karlaLicense = fs.readFileSync(path.join(root, 'public/fonts/Karla-OFL.txt'), 'utf8');
if (!karlaLicense.includes('SIL OPEN FONT LICENSE Version 1.1') || !karlaLicense.includes('Copyright 2019 The Karla Project Authors')) failures.push('Missing Karla copyright/OFL license');
for (const [file, hash] of [['Karla-Regular.ttf', 'a533ac149c87d6ca172d86c918dff422ba7cea09dccad338c1af2f77e6ff838e'], ['Karla-Bold.ttf', '63858c99c0db9e443160b2c3bd4293b50b1a98c99c464cb40bef6f56670ade41']]) if (createHash('sha256').update(fs.readFileSync(path.join(root, 'public/fonts', file))).digest('hex') !== hash) failures.push(file + ' differs from its reviewed provenance');
let count = 0;
for (const [location, pkg] of Object.entries(lock.packages)) {
  if (!location) continue;
  count++;
  if (!approved.has(pkg.license)) failures.push(`${location}@${pkg.version}: unapproved license ${JSON.stringify(pkg.license)}`);
  const installed = path.join(root, location, 'package.json');
  if (fs.existsSync(installed)) {
    const metadata = JSON.parse(fs.readFileSync(installed, 'utf8'));
    if (metadata.version !== pkg.version || metadata.license !== pkg.license) failures.push(`${location}: installed metadata differs from the lockfile`);
  }
}
const fontLicense = fs.readFileSync(path.join(root, 'public/fonts/OFL.txt'), 'utf8');
if (!fontLicense.includes('SIL OPEN FONT LICENSE Version 1.1')) failures.push('Missing Noto Sans OFL license');
const fontHash = createHash('sha256').update(fs.readFileSync(path.join(root, 'public/fonts/NotoSans.ttf'))).digest('hex');
if (fontHash !== 'bfb7bb691513f12e734dc346c03a03f784912432d7e3fa8e56efcf906fe86b3d') failures.push('Noto Sans differs from its reviewed provenance; review source/license before updating this hash');
const italicHash = createHash('sha256').update(fs.readFileSync(path.join(root, 'public/fonts/NotoSans-Italic.ttf'))).digest('hex');
if (italicHash !== '58e6e0ebd1931b29a365aa2d3e2ee9a9e831a3af7cf3ad1462d4e72154f0b291') failures.push('Noto Sans Italic differs from its reviewed provenance');
const bebasLicense = fs.readFileSync(path.join(root, 'public/fonts/BebasNeue-OFL.txt'), 'utf8');
if (!bebasLicense.includes('SIL OPEN FONT LICENSE Version 1.1') || !bebasLicense.includes('Dharma Type')) failures.push('Missing Bebas Neue copyright/OFL license');
const bebasHash = createHash('sha256').update(fs.readFileSync(path.join(root, 'public/fonts/BebasNeue-Regular.ttf'))).digest('hex');
if (bebasHash !== '08e4623805102d819f58601e46e345648846075e363b2ceb23313c2d1c83ec73') failures.push('Bebas Neue differs from its reviewed provenance');
for (const name of ['Oswald', 'OpenSans']) {
  const license = fs.readFileSync(path.join(root, `public/fonts/${name}-OFL.txt`), 'utf8');
  if (!license.includes('SIL OPEN FONT LICENSE Version 1.1') || !license.includes(name === 'OpenSans' ? 'Open Sans Project Authors' : 'Oswald Project Authors')) failures.push(`Missing ${name} copyright/OFL license`);
}
const sourceSansItalicLicense = fs.readFileSync(path.join(root, 'public/fonts/SourceSansPro-1.075-OFL.txt'), 'utf8');
if (!sourceSansItalicLicense.includes('SIL OPEN FONT LICENSE Version 1.1') || !sourceSansItalicLicense.includes('Copyright 2010, 2012, 2014 Adobe')) failures.push('Missing Source Sans Pro 1.075 copyright/OFL license');
const sourceSansLicense = fs.readFileSync(path.join(root, 'public/fonts/SourceSansPro-OFL.txt'), 'utf8');
if (!sourceSansLicense.includes('SIL OPEN FONT LICENSE Version 1.1') || !sourceSansLicense.includes('Copyright 2010-2018 Adobe')) failures.push('Missing Source Sans Pro copyright/OFL license');
for (const [file, hash] of [
  ['SourceSansPro-Regular.ttf', 'c6f835b6a6d942b196e2607bf73a7b086407ae8dbdc928c23a2fb4893ec383f6'],
  ['SourceSansPro-Semibold.ttf', '72bf9aa2e78b8c78444ae74b6be09411d5fb5bf0eb9bcdfd47082cc5d9b536df'],
  ['SourceSansPro-SemiboldIt.ttf', 'e7687a5558387aa42c340012f24adc6d447f43cfaf3974e75fd91fff6451fe79'],
  ['SourceSansPro-It.ttf', '36133e9f508b0b4c639e84b2a09855350be0b13700ad729ab519aa78e5c48d20'],
  ['SourceSansPro-Bold.ttf', '8d869f2aeac0220984a430120af819fbcb12a88e8ea4ad72aae4c5f6d6a2b985'],
  ['SourceSansPro-BoldIt.ttf', 'eab3e6c76c677dda287b2e56f41f718cc975a14150f72ef82e0a87f1b56eac4c'],
  ['SourceSansPro-Black.ttf', '4183f9ae34bd50bde1ee5601302c0d1666638cad52ff2a8886d8c47535be1999'],
  ['SourceSansPro-BlackIt.ttf', '9ed6ca5d09d1651aa2d0d4526d952c73a0aa345ea408cd8b5682712ea4c5ff7c'],
  ['SourceSansPro-Light.ttf', 'ce323db75733028ec2961b442b3368117d4daf724e3217d120f1990da8533fd0'],
  ['SourceSansPro-LightIt.ttf', '8358a9a3bc57435de6c4310528c7e244c64de6a1cf2a302de7cd83d2099e81d3'],
  ['Oswald.ttf', '5b38c246e255a12f5712d640d56bcced0472466fc68983d2d0410ec0457c2817'],
  ['OpenSans.ttf', '36643644f318a812aab2d2ed3bb98f8cf0872527f835fe9398d95fe6b9adb878'],
  ['OpenSans-Italic.ttf', 'fe269381e992f32e135801740998544d6235061e37c93ec067ad2be3edd5b17b'],
  ['OpenSans-Light.ttf', '3472097ec4d9e57228cbfad3c9911e53923664d3df86568d0b05d674399e034e'],
  ['OpenSans-LightItalic.ttf', '548dc557bcef26267d16f1afaf0770814a329c9f04a0168d396ca9d1ceafb16f'],
  ['OpenSans-SemiBold.ttf', '4a413711684a9dd564ef0f1c10cb62b5d9f7eb6df2cff962f5341a6ecd5f64ae'],
  ['OpenSans-SemiBoldItalic.ttf', 'c646a9aefc0e964f66487260639e375685328a6280856faea3e012c43fe9c56d'],
]) if (createHash('sha256').update(fs.readFileSync(path.join(root, 'public/fonts', file))).digest('hex') !== hash) failures.push(`${file} differs from its reviewed provenance`);
const montserratLicense = fs.readFileSync(path.join(root, 'public/fonts/Montserrat-OFL.txt'), 'utf8');
if (!montserratLicense.includes('SIL OPEN FONT LICENSE Version 1.1') || !montserratLicense.includes('Copyright 2011 The Montserrat Project Authors')) failures.push('Missing Montserrat copyright/OFL license');
for (const [file, hash] of [["Montserrat-Regular.ttf", "2de60e08e1fef5ebac94d6c5e6935320b656564783b21748224c6a801ccb3b41"], ["Montserrat-Italic.ttf", "e86b9f14c6f27f3735b7a969d7f60e91f8b661566d0b22d741655f5ba5489b6b"], ["Montserrat-Bold.ttf", "0173e2eaf1a0382c57cb27de557dbde928d959ceb94f632cb16fcfe9fea0d128"], ["Montserrat-BoldItalic.ttf", "31a78b4a1dea9dda81aa398bb04f5cecc31a4494222dcaf54695308f995f7232"], ["Montserrat-Light.ttf", "ec895e15246a50bd490cc8e0429915016d4ed3738af4f5cc4763948303b898d0"], ["Montserrat-LightItalic.ttf", "73128d8186c0989281044188bdfb363c61c57ae5930c7247525365bc733824a3"]]) if (createHash('sha256').update(fs.readFileSync(path.join(root, 'public/fonts', file))).digest('hex') !== hash) failures.push(file + ' differs from its reviewed provenance');
// Metric-compatible substitutes for common document fonts: Carlito and Liberation (OFL-1.1), Caladea 2013 (Apache-2.0).
const caladeaLicense = fs.readFileSync(path.join(root, 'public/fonts/Caladea-Apache-2.0.txt'), 'utf8');
if (!caladeaLicense.includes('Apache License') || !caladeaLicense.includes('Version 2.0, January 2004')) failures.push('Missing Caladea Apache-2.0 license');
for (const [name, holder] of [['Carlito', 'The Carlito Project Authors'], ['Liberation', 'Red Hat, Inc.']]) {
  const license = fs.readFileSync(path.join(root, `public/fonts/${name}-OFL.txt`), 'utf8');
  if (!/SIL Open Font License,?\s*Version 1\.1/i.test(license) || !license.includes(holder)) failures.push(`Missing ${name} copyright/OFL license`);
}
for (const [file, hash] of [
  ['Carlito-Bold.ttf', 'bb5d20f79b82599ec72983597437373a80f2d2085fa91fc144fd74e876a594db'],
  ['Carlito-BoldItalic.ttf', 'b32928186c119599e03ca6a1ffc680fdcb7fac95772f4b95d989cf6cd3861517'],
  ['Carlito-Italic.ttf', '0b019225e58d702bfedcbd35c21696769f8ee115cb6343f84c2f240312450d1c'],
  ['Carlito-Regular.ttf', 'f6418f708baede9789daef5d458c0f53d2a888af9820e8062934e504fedc6595'],
  ['Caladea-Bold.ttf', '74eda4fc5ffba0d8dc4aa76d41499f5ab76168d9ed6141c6417064c6244db9b6'],
  ['Caladea-BoldItalic.ttf', 'f47a35ad6cd0efa9914d93f9d03c93e30c55da43674bccfabac73b3c0d522c01'],
  ['Caladea-Italic.ttf', '9c968bf60ba1e851cdfea77c71e3540c57792f77482dd241acc29d1425569c4e'],
  ['Caladea-Regular.ttf', 'd2f6cad33f191e65b68bd74e6d4f7708080a41b32db635866109df3090265d91'],
  ['LiberationMono-Bold.ttf', 'bd62a0672d0b9b6710b01df434c80ad54fa5f0835207eb7b17b7a761463067bb'],
  ['LiberationMono-BoldItalic.ttf', '79451f3c09fe25116098853b7a2ca6e2436220ccc11af022979adbcf195be130'],
  ['LiberationMono-Italic.ttf', '605c01c711b44480a7508d349dfbf3264e81fa43d69e61cfa7d10b86e764c4d1'],
  ['LiberationMono-Regular.ttf', 'f2b83c763e8afd21709333370bed4774337fae82267937e2b5aea7e2fbd922c1'],
  ['LiberationSans-Bold.ttf', '788abee4c806d660e8aee46689dd8540cd4bb98da03dcc9d171ce3efd99a9173'],
  ['LiberationSans-BoldItalic.ttf', '698da70fc191cc5f33ad4d6d3fe830fe4624b898ea2e3169955928b7c491f1ee'],
  ['LiberationSans-Italic.ttf', 'e5bae5c4cde31f22142753855f4f8fb86da6ff39955ed3c0a11248b0d16948b0'],
  ['LiberationSans-Regular.ttf', '76d04c18ea243f426b7de1f3ad208e927008f961dc5945e5aad352d0dfde8ee8'],
  ['LiberationSerif-Bold.ttf', 'd754ba427cfe0bca54ae052384baa8f842da5bd6550ad4da024ac441e7a7d5ce'],
  ['LiberationSerif-BoldItalic.ttf', 'f17db8af71e24d2066b587546021d4f0b296be389512b658dec3c09affeb11a7'],
  ['LiberationSerif-Italic.ttf', '0e3dea9f8d613e006ccfa62201f33e265d19167bd0907725c3e145368b04fc2e'],
  ['LiberationSerif-Regular.ttf', '058ea80864aef09a23f45cbec2bb5400bc3dfbdea01c3f10538a21fcb497fb74'],
]) if (createHash('sha256').update(fs.readFileSync(path.join(root, 'public/fonts', file))).digest('hex') !== hash) failures.push(`${file} differs from its reviewed provenance`);
// The en_US spelling dictionary: SCOWL size 60 with the Ispell-derived affix file, vendored unmodified from
// dictionary-en 4.0.0. Its notices require the copyright and permission text to travel with it.
const dictionaryLicense = fs.readFileSync(path.join(root, 'public/dictionaries/en-US-LICENSE.txt'), 'utf8');
if (!dictionaryLicense.includes('Copyright 2000-2018 by Kevin Atkinson') || !dictionaryLicense.includes('Copyright 1993, Geoff Kuenning') || !dictionaryLicense.includes('WordNet 1.6 Copyright 1997 by Princeton University')) failures.push('Missing en_US dictionary copyright and permission notices');
for (const [file, hash] of [['en-US.aff', '8ae1f19d4840d957728ad90555d5a8dff6cc5c046279c95ff0c00fc0a0136c7b'], ['en-US.dic', 'f0b1a234bd178bdd01875b2a392a9647f888b8fe879f79c52aae62c2759b3647'], ['en-US-LICENSE.txt', '2a7e8d8ae9e8facc84818546ae2a8d83aec5e9c80a675ff789acd1c338b53b3d']]) if (createHash('sha256').update(fs.readFileSync(path.join(root, 'public/dictionaries', file))).digest('hex') !== hash) failures.push(`${file} differs from its reviewed provenance`);
// The thesaurus is generated from the WordNet 3.1 database (tools/generate-thesaurus.mjs); its license must travel with it.
const wordnetLicense = fs.readFileSync(path.join(root, 'public/thesaurus/LICENSE-WordNet.txt'), 'utf8');
if (!wordnetLicense.includes('WordNet Release 3.1') || !wordnetLicense.includes('WordNet 3.1 Copyright 2011 by Princeton University.  All rights reserved.') || !wordnetLicense.includes('Permission to use, copy, modify and distribute this software and')) failures.push('Missing WordNet license for public/thesaurus');
for (const [file, hash] of [['en.json', '583c157505cd770d1cfe777ea577548c0516ba46fc3ea5de11819c939532af8b'], ['LICENSE-WordNet.txt', '71064f86c6330cd471e3f00c780ca0c4104467125c52655353a244598b0d067f']]) if (createHash('sha256').update(fs.readFileSync(path.join(root, 'public/thesaurus', file))).digest('hex') !== hash) failures.push(`public/thesaurus/${file} differs from its reviewed provenance; regenerate with tools/generate-thesaurus.mjs and review before updating this hash`);
if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
console.log(`License policy passed: ${count} locked packages; Noto Sans, Bebas Neue, Oswald, Open Sans, Source Sans Pro, Selawik, Karla and Montserrat under OFL-1.1; en_US dictionary (SCOWL) and WordNet thesaurus notices verified. All package licenses explicitly approved; no AGPL declarations.`);
