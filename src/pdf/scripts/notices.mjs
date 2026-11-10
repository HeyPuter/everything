import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const dependencies = [
  'pdfjs-dist',
  'pdf-lib',
  '@pdf-lib/fontkit',
  '@xmldom/xmldom',
  '@pdf-lib/standard-fonts',
  '@pdf-lib/upng',
  'pako',
  'tslib',
  'lucide',
  'tesseract.js',
  'tesseract.js-core',
  'regenerator-runtime',
];
const texts = [
  'PDF Editor: third-party notices\n\nThese licenses apply to their respective dependencies, not to the application as a whole.\nPuter.js is loaded from https://js.puter.com/v2/ and is subject to Puter terms.\n',
];
for (const name of dependencies) {
  const dir = `node_modules/${name}`;
  const pkg = JSON.parse(readFileSync(`${dir}/package.json`));
  const file = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENSE-MIT', 'CopyrightNotice.txt'].find(
    (p) => existsSync(`${dir}/${p}`),
  );
  const fallback = name === '@pdf-lib/fontkit' ? 'docs/fontkit-LICENSE' : null;
  if (!file && !fallback) throw new Error(`Missing license: ${name}`);
  texts.push(
    `${'='.repeat(72)}\n${name} ${pkg.version} (${pkg.license})\n${'='.repeat(72)}\n\n${readFileSync(file ? `${dir}/${file}` : fallback, 'utf8')}`,
  );
}
const bundle = readFileSync('node_modules/@pdf-lib/fontkit/dist/fontkit.es.js', 'utf8');
const embeddedNotices = [...bundle.matchAll(/\/\*[\s\S]*?\*\//g)]
  .map((m) => m[0])
  .filter((t) => /copyright|license/i.test(t));
const nodeNotice = bundle.match(/  \/\/ Copyright Joyent,[\s\S]*?  \/\/ SOFTWARE\./)?.[0];
texts.push(
  'Fontkit embedded notices\n\n' + [...new Set(embeddedNotices), nodeNotice || ''].join('\n\n'),
);
texts.push(
  'TypeScript runtime attribution\n' +
    readFileSync('node_modules/tslib/CopyrightNotice.txt', 'utf8'),
);
texts.push('Noto Sans font\n\n' + readFileSync('public/fonts/OFL.txt', 'utf8'));
texts.push(
  'Noto Sans CJK fonts\n\n' +
    readFileSync('public/fonts/NotoSansCJK-SOURCE.txt', 'utf8') +
    '\n' +
    readFileSync('public/fonts/NotoSansCJK-OFL.txt', 'utf8'),
);
texts.push('Great Vibes font\n\n' + readFileSync('public/fonts/GreatVibes-OFL.txt', 'utf8'));

// The PDF.js standard-font substitutes bundled under pdfjs/standard_fonts/ include Liberation
// Sans 1.07.4 (GPL v2 with a font exception) and Foxit fonts (a permissive BSD-3-Clause-style
// license). The GPL requires the corresponding source to accompany the fonts, so the build
// ships it and these notices point to it.
const fontDir = 'node_modules/pdfjs-dist/standard_fonts';
texts.push(
  [
    `${'='.repeat(72)}`,
    'Bundled PDF.js standard fonts (pdfjs/standard_fonts/)',
    `${'='.repeat(72)}`,
    '',
    'PDF.js substitutes the standard 14 PDF fonts with these font files, shipped',
    'under pdfjs/standard_fonts/ in the build:',
    '',
    '  - Liberation Sans 1.07.4 (LiberationSans-Regular/Bold/Italic/BoldItalic.ttf)',
    '    Copyright (C) 2007-2011 Red Hat, Inc., original design by Steve Matteson',
    '    (Ascender Corp.). Licensed under the GNU General Public License version 2',
    '    with a font exception (full text below). The font exception lets you embed',
    '    the font in a document without that document becoming GPL; distributing the',
    '    font files themselves is governed by the GPL v2.',
    '  - Foxit fonts (Foxit*.pfb) under a permissive BSD-3-Clause-style license',
    '    (full text below); no source-redistribution obligation applies to them.',
    '',
    'Corresponding source for the GPL fonts. As required by GPL v2 section 3, the',
    'complete corresponding source for Liberation Sans 1.07.4 accompanies the fonts:',
    '',
    '  - In the build: pdfjs/standard_fonts/liberation-source/',
    '    (liberation-fonts-ttf-1.07.4.tar.gz, the upstream fontforge-buildable source).',
    '  - In this repository: vendor/liberation-fonts/.',
    '  - Upstream download:',
    '    https://releases.pagure.org/liberation-fonts/liberation-fonts-ttf-1.07.4.tar.gz',
    '    (SHA-256 61a7e2b6742a43c73e8762cdfeaf6dfcf9abdd2cfa0b099a9854d69bc4cfee5c);',
    '    project home https://github.com/liberationfonts/liberation-fonts.',
    '',
    'The distributed .ttf files are the Liberation Sans 1.07.4 fonts as vendored and',
    'byte-optimized by the PDF.js project (same typeface, version 1.07.4, and font',
    'revision; PDF.js re-compiles them, so a few bytes differ from the upstream',
    'release). Their optimization tooling is part of PDF.js (Apache-2.0), whose',
    'source is at https://github.com/mozilla/pdf.js (external/standard_fonts).',
    '',
    'Written offer. For three years from the date you received this software, the',
    'maintainers will, on request, provide the complete corresponding machine-',
    'readable source for the bundled Liberation Sans 1.07.4 fonts on a medium',
    'customarily used for software interchange, for no more than the cost of',
    'performing the distribution, by opening an issue at',
    'https://github.com/HeyPuter/pdf-editor.',
    '',
    `${'-'.repeat(72)}`,
    'Liberation Sans license (GNU GPL v2 with the font exception)',
    `${'-'.repeat(72)}`,
    '',
    readFileSync(`${fontDir}/LICENSE_LIBERATION`, 'utf8').trim(),
    '',
    `${'-'.repeat(72)}`,
    'Foxit fonts license',
    `${'-'.repeat(72)}`,
    '',
    readFileSync(`${fontDir}/LICENSE_FOXIT`, 'utf8').trim(),
  ].join('\n'),
);

// On-device OCR assets shipped under ocr/ (see vite.config.js). The tesseract.js worker bundle
// carries its own embedded notices; the WebAssembly core statically links Tesseract and the
// image libraries Leptonica reads scans with, whose notices travel with binary copies too.
const rule = (title) => `${'-'.repeat(72)}\n${title}\n${'-'.repeat(72)}\n`;
const tessdata = JSON.parse(readFileSync('node_modules/@tesseract.js-data/eng/package.json'));
texts.push(
  [
    `${'='.repeat(72)}`,
    'On-device OCR (ocr/ in the build)',
    `${'='.repeat(72)}`,
    '',
    'ocr/worker.min.js is the tesseract.js worker bundle and ocr/core/ holds the',
    'tesseract.js-core WebAssembly builds (Apache-2.0, licenses above). Their bundled',
    'third-party notices follow.',
    '',
    rule('Notices embedded in ocr/worker.min.js'),
    readFileSync('node_modules/tesseract.js/dist/worker.min.js.LICENSE.txt', 'utf8').trim(),
    '',
    rule('English OCR model (ocr/lang/eng.traineddata.gz)'),
    `The English model is tessdata_best_int 4.0.0 from the Tesseract OCR project`,
    `(https://github.com/tesseract-ocr/tessdata_best), repackaged gzip-compressed as`,
    `@tesseract.js-data/eng ${tessdata.version} (https://github.com/naptha/tessdata).`,
    'The trained data is licensed under the Apache License, Version 2.0 (full text in',
    'the tesseract.js section above). Copyright the Tesseract OCR authors (Google).',
    '',
    rule('Libraries compiled into ocr/core/*.wasm.js'),
    'Tesseract OCR (forked for tesseract.js-core): Apache License 2.0, full text above.',
    'Copyright the Tesseract OCR authors. https://github.com/tesseract-ocr/tesseract',
    '',
    'Leptonica (https://github.com/DanBloomberg/leptonica): BSD 2-Clause',
    '',
    'Copyright (C) 2001 Leptonica. All rights reserved.',
    '',
    'Redistribution and use in source and binary forms, with or without modification,',
    'are permitted provided that the following conditions are met:',
    '1. Redistributions of source code must retain the above copyright notice, this',
    '   list of conditions and the following disclaimer.',
    '2. Redistributions in binary form must reproduce the above copyright notice,',
    '   this list of conditions and the following disclaimer in the documentation',
    '   and/or other materials provided with the distribution.',
    '',
    'THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND',
    'ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED',
    'WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE',
    'DISCLAIMED. IN NO EVENT SHALL ANY CONTRIBUTORS BE LIABLE FOR ANY DIRECT,',
    'INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING,',
    'BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,',
    'DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF',
    'LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE',
    'OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF',
    'ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.',
    '',
    'libpng 1.6.38: PNG Reference Library License version 2',
    '',
    'Copyright (c) 1995-2022 The PNG Reference Library Authors.',
    'Copyright (c) 2018-2022 Cosmin Truta.',
    'Copyright (c) 2000-2002, 2004, 2006-2018 Glenn Randers-Pehrson.',
    'Copyright (c) 1996-1997 Andreas Dilger.',
    'Copyright (c) 1995-1996 Guy Eric Schalnat, Group 42, Inc.',
    '',
    'The software is supplied "as is", without warranty of any kind, express or',
    'implied, including, without limitation, the warranties of merchantability,',
    'fitness for a particular purpose, title, and non-infringement. In no event shall',
    'the Copyright owners, or anyone distributing the software, be liable for any',
    'damages or other liability, whether in contract, tort or otherwise, arising',
    'from, out of, or in connection with the software, or the use or other dealings',
    'in the software, even if advised of the possibility of such damage.',
    '',
    'Permission is hereby granted to use, copy, modify, and distribute this',
    'software, or portions hereof, for any purpose, without fee, subject to the',
    'following restrictions:',
    ' 1. The origin of this software must not be misrepresented; you must not claim',
    '    that you wrote the original software. If you use this software in a product,',
    '    an acknowledgment in the product documentation would be appreciated, but is',
    '    not required.',
    ' 2. Altered source versions must be plainly marked as such, and must not be',
    '    misrepresented as being the original software.',
    ' 3. This Copyright notice may not be removed or altered from any source or',
    '    altered source distribution.',
    '',
    'zlib 1.2.12: zlib License',
    '',
    'Copyright (C) 1995-2022 Jean-loup Gailly and Mark Adler',
    '',
    "This software is provided 'as-is', without any express or implied warranty. In",
    'no event will the authors be held liable for any damages arising from the use',
    'of this software. Permission is granted to anyone to use this software for any',
    'purpose, including commercial applications, and to alter it and redistribute it',
    'freely, subject to the following restrictions:',
    ' 1. The origin of this software must not be misrepresented; you must not claim',
    '    that you wrote the original software. If you use this software in a product,',
    '    an acknowledgment in the product documentation would be appreciated but is',
    '    not required.',
    ' 2. Altered source versions must be plainly marked as such, and must not be',
    '    misrepresented as being the original software.',
    ' 3. This notice may not be removed or altered from any source distribution.',
    '',
    'libjpeg (Independent JPEG Group)',
    '',
    'This software is based in part on the work of the Independent JPEG Group.',
    'Copyright (C) 1991-2014, Thomas G. Lane, Guido Vollbeding.',
    '',
    'LibTIFF: libtiff License',
    '',
    'Copyright (c) 1988-1997 Sam Leffler',
    'Copyright (c) 1991-1997 Silicon Graphics, Inc.',
    '',
    'Permission to use, copy, modify, distribute, and sell this software and its',
    'documentation for any purpose is hereby granted without fee, provided that (i)',
    'the above copyright notices and this permission notice appear in all copies of',
    'the software and related documentation, and (ii) the names of Sam Leffler and',
    'Silicon Graphics may not be used in any advertising or publicity relating to',
    'the software without the specific, prior written permission of Sam Leffler and',
    'Silicon Graphics.',
    '',
    'THE SOFTWARE IS PROVIDED "AS-IS" AND WITHOUT WARRANTY OF ANY KIND, EXPRESS,',
    'IMPLIED OR OTHERWISE, INCLUDING WITHOUT LIMITATION, ANY WARRANTY OF',
    'MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE. IN NO EVENT SHALL SAM',
    'LEFFLER OR SILICON GRAPHICS BE LIABLE FOR ANY SPECIAL, INCIDENTAL, INDIRECT OR',
    'CONSEQUENTIAL DAMAGES OF ANY KIND, OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS',
    'OF USE, DATA OR PROFITS, WHETHER OR NOT ADVISED OF THE POSSIBILITY OF DAMAGE,',
    'AND ON ANY THEORY OF LIABILITY, ARISING OUT OF OR IN CONNECTION WITH THE USE OR',
    'PERFORMANCE OF THIS SOFTWARE.',
    '',
    'libwebp: BSD 3-Clause',
    '',
    'Copyright (c) 2010, Google Inc. All rights reserved.',
    '',
    'Redistribution and use in source and binary forms, with or without modification,',
    'are permitted provided that the following conditions are met:',
    '  * Redistributions of source code must retain the above copyright notice, this',
    '    list of conditions and the following disclaimer.',
    '  * Redistributions in binary form must reproduce the above copyright notice,',
    '    this list of conditions and the following disclaimer in the documentation',
    '    and/or other materials provided with the distribution.',
    '  * Neither the name of Google nor the names of its contributors may be used to',
    '    endorse or promote products derived from this software without specific',
    '    prior written permission.',
    '',
    'THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND',
    'ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED',
    'WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE',
    'DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE',
    'FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL',
    'DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR',
    'SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER',
    'CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,',
    'OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE',
    'OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.',
  ].join('\n'),
);

texts.push(
  'Additional PDF.js notices are shipped alongside its CMaps, fonts, ICC profiles, and WebAssembly assets under pdfjs/.',
);
writeFileSync(
  'public/THIRD_PARTY_NOTICES.txt',
  texts
    .join('\n\n')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, ''),
);
