/**
 * Hyphenation pattern files, one per language, loaded on first use (each is
 * its own chunk). The .tex files are the hyph-utf8 distributions of the
 * TeX hyphenation patterns, kept byte for byte: each carries its copyright
 * and license text in its header. `npm run check:licenses` verifies every
 * file against its hash, its license and its notice below.
 *
 *   license: the license we use the file under (SPDX id); `notice` is text
 *   the file's header must contain.
 */
export const PATTERN_FILES = {
  'en-us': {
    file: 'hyph-en-us.tex',
    label: 'English (US)',
    license: 'FSFAP',
    notice: 'Copying and distribution of this file, with or without modification',
    sha256: 'f4ffcd96c5cbc886bdad23f95dcae8edc3cd3620eae62f7946eceda97c4e68f8',
    load: () => import('./hyph-en-us.tex?raw'),
  },
  'en-gb': {
    file: 'hyph-en-gb.tex',
    label: 'English (UK)',
    license: 'MIT',
    notice: 'Permission is hereby granted, free of charge',
    sha256: 'e95bb4ab350f620c41c231c4785d7bdb4f91949d3e631b30e08b3ead3c340a52',
    load: () => import('./hyph-en-gb.tex?raw'),
  },
  de: {
    file: 'hyph-de-1996.tex',
    label: 'German (1996 spelling)',
    license: 'MIT',
    notice: 'Permission is hereby granted, free of charge',
    sha256: '374ad1ce3263f8a2791ec070ef9b516c532dae64456f3fb656e617e8ae53a9d3',
    load: () => import('./hyph-de-1996.tex?raw'),
  },
  fr: {
    file: 'hyph-fr.tex',
    label: 'French',
    license: 'MIT',
    notice: 'Permission is hereby granted, free of charge',
    sha256: '526cad6fe8f52fcd3caa3fcaf667cb1740cfc14bca198680e00dc343a84594de',
    load: () => import('./hyph-fr.tex?raw'),
  },
  es: {
    file: 'hyph-es.tex',
    label: 'Spanish',
    license: 'MIT',
    notice: 'Permission is hereby granted, free of charge',
    sha256: '6a2e5f39a991a23d1cd8a23dbd0f6fe96a9f07561a6695f4f3320f47030e236c',
    load: () => import('./hyph-es.tex?raw'),
  },
  it: {
    file: 'hyph-it.tex',
    label: 'Italian',
    // Offered under LPPL 1.3 or MIT; used under MIT.
    license: 'MIT',
    notice: 'Permission is hereby granted, free of charge',
    sha256: '6ce56ed6ed2ca7c0688838e366e6595e0429f984f4fc6e96ec045cebb1e76a47',
    load: () => import('./hyph-it.tex?raw'),
  },
  pt: {
    file: 'hyph-pt.tex',
    label: 'Portuguese',
    license: 'BSD-3-Clause',
    notice: 'Redistribution and use in source and binary forms',
    sha256: 'c110a39e501db372d1d755e1c64464321a2efa7d8e9617f66001000389b941f2',
    load: () => import('./hyph-pt.tex?raw'),
  },
  nl: {
    file: 'hyph-nl.tex',
    label: 'Dutch',
    license: 'MIT',
    notice: 'name: MIT',
    sha256: 'd21499bfbee53e4d50e867ef92a41fd28b65725d7c91c980e4f8f02889bf6b2a',
    load: () => import('./hyph-nl.tex?raw'),
  },
  sv: {
    file: 'hyph-sv.tex',
    label: 'Swedish',
    // LPPL 1.2 or later, distributed unmodified.
    license: 'LPPL-1.3c',
    notice: 'name: LPPL',
    sha256: '102253382bd91cdb7535de5c20744254c9ac9aaa4ca12ed420eb835e5004c0b3',
    load: () => import('./hyph-sv.tex?raw'),
  },
  da: {
    file: 'hyph-da.tex',
    label: 'Danish',
    // Offered under LPPL 1.3 or MIT; used under MIT.
    license: 'MIT',
    notice: 'Permission is hereby granted, free of charge',
    sha256: '23e0a50f0c20d632be06f973e700323463961eac737bb14f6c3787675a4f5575',
    load: () => import('./hyph-da.tex?raw'),
  },
  pl: {
    file: 'hyph-pl.tex',
    label: 'Polish',
    license: 'MIT',
    notice: 'Permission is hereby granted, free of charge',
    sha256: '83ddbbd21bc06a44bc4f4a4c49c38782e809cff5f026b764c044daa29e818843',
    load: () => import('./hyph-pl.tex?raw'),
  },
  no: {
    file: 'hyph-no.tex',
    label: 'Norwegian',
    license: 'FSFAP',
    notice: 'Copying and distribution of this file, with or without modification',
    sha256: '05a2ac5fbf88bdc78c580e5cb8a158e6aa760d13756604f9523aa99feec3ec65',
    load: () => import('./hyph-no.tex?raw'),
  },
};

/** Licenses pattern files may be used under (permissive, notice-preserving). */
export const PATTERN_LICENSES = ['MIT', 'BSD-3-Clause', 'FSFAP', 'LPPL-1.3c'];

/** Pattern file key for a language tag (null when there is none). */
export function patternKey(code) {
  const tag = String(code || 'en-US').toLowerCase();
  const [base, region] = tag.split(/[-_]/);
  if (base === 'en') return region === 'gb' || region === 'au' || region === 'nz' || region === 'ie' ? 'en-gb' : 'en-us';
  if (base === 'nb' || base === 'nn' || base === 'no') return 'no';
  return PATTERN_FILES[base] ? base : null;
}
