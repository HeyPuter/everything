/**
 * Simple-font encodings (Standard, WinAnsi, MacRoman) as glyph-name
 * tables, and glyph names to Unicode (uniXXXX/uXXXX names, the names these
 * encodings use, and common extras like ligatures).
 */

const ASCII = [
  'space', 'exclam', 'quotedbl', 'numbersign', 'dollar', 'percent', 'ampersand', 'quotesingle', 'parenleft', 'parenright', 'asterisk', 'plus', 'comma', 'hyphen', 'period', 'slash',
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'colon', 'semicolon', 'less', 'equal', 'greater', 'question',
  'at', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z',
  'bracketleft', 'backslash', 'bracketright', 'asciicircum', 'underscore', 'grave',
  'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
  'braceleft', 'bar', 'braceright', 'asciitilde',
];

function table(from32, high) {
  const t = new Array(256).fill('');
  from32.forEach((n, i) => (t[32 + i] = n));
  for (const [code, name] of Object.entries(high)) t[Number(code)] = name;
  return t;
}

const LATIN1_HIGH = [
  'space', 'exclamdown', 'cent', 'sterling', 'currency', 'yen', 'brokenbar', 'section', 'dieresis', 'copyright', 'ordfeminine', 'guillemotleft', 'logicalnot', 'hyphen', 'registered', 'macron',
  'degree', 'plusminus', 'twosuperior', 'threesuperior', 'acute', 'mu', 'paragraph', 'periodcentered', 'cedilla', 'onesuperior', 'ordmasculine', 'guillemotright', 'onequarter', 'onehalf', 'threequarters', 'questiondown',
  'Agrave', 'Aacute', 'Acircumflex', 'Atilde', 'Adieresis', 'Aring', 'AE', 'Ccedilla', 'Egrave', 'Eacute', 'Ecircumflex', 'Edieresis', 'Igrave', 'Iacute', 'Icircumflex', 'Idieresis',
  'Eth', 'Ntilde', 'Ograve', 'Oacute', 'Ocircumflex', 'Otilde', 'Odieresis', 'multiply', 'Oslash', 'Ugrave', 'Uacute', 'Ucircumflex', 'Udieresis', 'Yacute', 'Thorn', 'germandbls',
  'agrave', 'aacute', 'acircumflex', 'atilde', 'adieresis', 'aring', 'ae', 'ccedilla', 'egrave', 'eacute', 'ecircumflex', 'edieresis', 'igrave', 'iacute', 'icircumflex', 'idieresis',
  'eth', 'ntilde', 'ograve', 'oacute', 'ocircumflex', 'otilde', 'odieresis', 'divide', 'oslash', 'ugrave', 'uacute', 'ucircumflex', 'udieresis', 'yacute', 'thorn', 'ydieresis',
];

const WIN_HIGH = {
  128: 'Euro', 130: 'quotesinglbase', 131: 'florin', 132: 'quotedblbase', 133: 'ellipsis', 134: 'dagger', 135: 'daggerdbl', 136: 'circumflex', 137: 'perthousand', 138: 'Scaron', 139: 'guilsinglleft', 140: 'OE', 142: 'Zcaron',
  145: 'quoteleft', 146: 'quoteright', 147: 'quotedblleft', 148: 'quotedblright', 149: 'bullet', 150: 'endash', 151: 'emdash', 152: 'tilde', 153: 'trademark', 154: 'scaron', 155: 'guilsinglright', 156: 'oe', 158: 'zcaron', 159: 'Ydieresis',
};
LATIN1_HIGH.forEach((n, i) => (WIN_HIGH[160 + i] = n));
export const WIN_ANSI = table(ASCII, WIN_HIGH);
WIN_ANSI[127] = 'bullet';

const STD = ASCII.slice();
STD[39 - 32] = 'quoteright';
STD[96 - 32] = 'quoteleft';
export const STANDARD = table(STD, {
  161: 'exclamdown', 162: 'cent', 163: 'sterling', 164: 'fraction', 165: 'yen', 166: 'florin', 167: 'section', 168: 'currency', 169: 'quotesingle', 170: 'quotedblleft', 171: 'guillemotleft', 172: 'guilsinglleft', 173: 'guilsinglright', 174: 'fi', 175: 'fl',
  177: 'endash', 178: 'dagger', 179: 'daggerdbl', 180: 'periodcentered', 182: 'paragraph', 183: 'bullet', 184: 'quotesinglbase', 185: 'quotedblbase', 186: 'quotedblright', 187: 'guillemotright', 188: 'ellipsis', 189: 'perthousand', 191: 'questiondown',
  193: 'grave', 194: 'acute', 195: 'circumflex', 196: 'tilde', 197: 'macron', 198: 'breve', 199: 'dotaccent', 200: 'dieresis', 202: 'ring', 203: 'cedilla', 205: 'hungarumlaut', 206: 'ogonek', 207: 'caron', 208: 'emdash',
  225: 'AE', 227: 'ordfeminine', 232: 'Lslash', 233: 'Oslash', 234: 'OE', 235: 'ordmasculine', 241: 'ae', 245: 'dotlessi', 248: 'lslash', 249: 'oslash', 250: 'oe', 251: 'germandbls',
});

const MAC_HIGH_LIST = [
  'Adieresis', 'Aring', 'Ccedilla', 'Eacute', 'Ntilde', 'Odieresis', 'Udieresis', 'aacute', 'agrave', 'acircumflex', 'adieresis', 'atilde', 'aring', 'ccedilla', 'eacute', 'egrave',
  'ecircumflex', 'edieresis', 'iacute', 'igrave', 'icircumflex', 'idieresis', 'ntilde', 'oacute', 'ograve', 'ocircumflex', 'odieresis', 'otilde', 'uacute', 'ugrave', 'ucircumflex', 'udieresis',
  'dagger', 'degree', 'cent', 'sterling', 'section', 'bullet', 'paragraph', 'germandbls', 'registered', 'copyright', 'trademark', 'acute', 'dieresis', 'notequal', 'AE', 'Oslash',
  'infinity', 'plusminus', 'lessequal', 'greaterequal', 'yen', 'mu', 'partialdiff', 'summation', 'product', 'pi', 'integral', 'ordfeminine', 'ordmasculine', 'Omega', 'ae', 'oslash',
  'questiondown', 'exclamdown', 'logicalnot', 'radical', 'florin', 'approxequal', 'Delta', 'guillemotleft', 'guillemotright', 'ellipsis', 'space', 'Agrave', 'Atilde', 'Otilde', 'OE', 'oe',
  'endash', 'emdash', 'quotedblleft', 'quotedblright', 'quoteleft', 'quoteright', 'divide', 'lozenge', 'ydieresis', 'Ydieresis', 'fraction', 'currency', 'guilsinglleft', 'guilsinglright', 'fi', 'fl',
  'daggerdbl', 'periodcentered', 'quotesinglbase', 'quotedblbase', 'perthousand', 'Acircumflex', 'Ecircumflex', 'Aacute', 'Edieresis', 'Egrave', 'Iacute', 'Icircumflex', 'Idieresis', 'Igrave', 'Oacute', 'Ocircumflex',
  'apple', 'Ograve', 'Uacute', 'Ucircumflex', 'Ugrave', 'dotlessi', 'circumflex', 'tilde', 'macron', 'breve', 'dotaccent', 'ring', 'cedilla', 'hungarumlaut', 'ogonek', 'caron',
];
const MAC_HIGH = {};
MAC_HIGH_LIST.forEach((n, i) => (MAC_HIGH[128 + i] = n));
export const MAC_ROMAN = table(ASCII, MAC_HIGH);

export const ENCODINGS = { StandardEncoding: STANDARD, WinAnsiEncoding: WIN_ANSI, MacRomanEncoding: MAC_ROMAN };

// Unicode for the high halves of Windows-1252 and Mac Roman (code 128.. order).
const WIN_UNI = [0x20ac, 0, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0, 0x17d, 0, 0, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0, 0x17e, 0x178];
const MAC_UNI = [
  0xc4, 0xc5, 0xc7, 0xc9, 0xd1, 0xd6, 0xdc, 0xe1, 0xe0, 0xe2, 0xe4, 0xe3, 0xe5, 0xe7, 0xe9, 0xe8, 0xea, 0xeb, 0xed, 0xec, 0xee, 0xef, 0xf1, 0xf3, 0xf2, 0xf4, 0xf6, 0xf5, 0xfa, 0xf9, 0xfb, 0xfc,
  0x2020, 0xb0, 0xa2, 0xa3, 0xa7, 0x2022, 0xb6, 0xdf, 0xae, 0xa9, 0x2122, 0xb4, 0xa8, 0x2260, 0xc6, 0xd8, 0x221e, 0xb1, 0x2264, 0x2265, 0xa5, 0xb5, 0x2202, 0x2211, 0x220f, 0x3c0, 0x222b, 0xaa, 0xba, 0x3a9, 0xe6, 0xf8,
  0xbf, 0xa1, 0xac, 0x221a, 0x192, 0x2248, 0x2206, 0xab, 0xbb, 0x2026, 0xa0, 0xc0, 0xc3, 0xd5, 0x152, 0x153, 0x2013, 0x2014, 0x201c, 0x201d, 0x2018, 0x2019, 0xf7, 0x25ca, 0xff, 0x178, 0x2044, 0xa4, 0x2039, 0x203a, 0xfb01, 0xfb02,
  0x2021, 0xb7, 0x201a, 0x201e, 0x2030, 0xc2, 0xca, 0xc1, 0xcb, 0xc8, 0xcd, 0xce, 0xcf, 0xcc, 0xd3, 0xd4, 0xf8ff, 0xd2, 0xda, 0xdb, 0xd9, 0x131, 0x2c6, 0x2dc, 0xaf, 0x2d8, 0x2d9, 0x2da, 0xb8, 0x2dd, 0x2db, 0x2c7,
];

const EXTRA = {
  Lslash: 0x141, lslash: 0x142, minus: 0x2212, fraction: 0x2044, ff: 0xfb00, ffi: 0xfb03, ffl: 0xfb04, fi: 0xfb01, fl: 0xfb02, nbspace: 0xa0, nonbreakingspace: 0xa0, sfthyphen: 0xad, softhyphen: 0xad,
  Euro: 0x20ac, quotesingle: 0x27, grave: 0x60, dotlessi: 0x131, dotlessj: 0x237, Scedilla: 0x15e, scedilla: 0x15f, Gbreve: 0x11e, gbreve: 0x11f, Idotaccent: 0x130, Ccaron: 0x10c, ccaron: 0x10d,
  Ecaron: 0x11a, ecaron: 0x11b, Rcaron: 0x158, rcaron: 0x159, Zacute: 0x179, zacute: 0x17a, Zdotaccent: 0x17b, zdotaccent: 0x17c, Sacute: 0x15a, sacute: 0x15b, Nacute: 0x143, nacute: 0x144,
  Cacute: 0x106, cacute: 0x107, Aogonek: 0x104, aogonek: 0x105, Eogonek: 0x118, eogonek: 0x119, Uring: 0x16e, uring: 0x16f, Tcaron: 0x164, tcaron: 0x165, Dcaron: 0x10e, dcaron: 0x10f, Ncaron: 0x147, ncaron: 0x148,
  Ohungarumlaut: 0x150, ohungarumlaut: 0x151, Uhungarumlaut: 0x170, uhungarumlaut: 0x171, Amacron: 0x100, amacron: 0x101, Emacron: 0x112, emacron: 0x113, Imacron: 0x12a, imacron: 0x12b,
  arrowleft: 0x2190, arrowup: 0x2191, arrowright: 0x2192, arrowdown: 0x2193, arrowboth: 0x2194, checkmark: 0x2713, copyrightserif: 0xa9, registerserif: 0xae, trademarkserif: 0x2122,
  copyrightsans: 0xa9, registersans: 0xae, trademarksans: 0x2122, onethird: 0x2153, twothirds: 0x2154, oneeighth: 0x215b, threeeighths: 0x215c, fiveeighths: 0x215d, seveneighths: 0x215e,
  periodcentered: 0xb7, middot: 0xb7, bullet: 0x2022, ellipsis: 0x2026, mu: 0xb5, Omega: 0x3a9, Delta: 0x2206, pi: 0x3c0, lozenge: 0x25ca, apple: 0xf8ff, space: 0x20,
  alpha: 0x3b1, beta: 0x3b2, gamma: 0x3b3, delta: 0x3b4, epsilon: 0x3b5, zeta: 0x3b6, eta: 0x3b7, theta: 0x3b8, iota: 0x3b9, kappa: 0x3ba, lambda: 0x3bb, nu: 0x3bd, xi: 0x3be, omicron: 0x3bf, rho: 0x3c1,
  sigma: 0x3c3, tau: 0x3c4, upsilon: 0x3c5, phi: 0x3c6, chi: 0x3c7, psi: 0x3c8, omega: 0x3c9, Alpha: 0x391, Beta: 0x392, Gamma: 0x393, Theta: 0x398, Lambda: 0x39b, Sigma: 0x3a3, Phi: 0x3a6, Psi: 0x3a8,
  degree: 0xb0, infinity: 0x221e, notequal: 0x2260, lessequal: 0x2264, greaterequal: 0x2265, approxequal: 0x2248, radical: 0x221a, integral: 0x222b, summation: 0x2211, product: 0x220f, partialdiff: 0x2202,
};

let NAME_TO_UNI = null;
function nameTable() {
  if (NAME_TO_UNI) return NAME_TO_UNI;
  const t = new Map();
  ASCII.forEach((n, i) => t.set(n, 32 + i));
  LATIN1_HIGH.forEach((n, i) => {
    if (!t.has(n)) t.set(n, 160 + i);
  });
  for (let i = 0; i < 32; i++) {
    const n = WIN_HIGH[128 + i];
    if (n && WIN_UNI[i] && !t.has(n)) t.set(n, WIN_UNI[i]);
  }
  for (let i = 0; i < 128; i++) {
    const n = MAC_HIGH_LIST[i];
    if (n && !t.has(n)) t.set(n, MAC_UNI[i]);
  }
  for (const [n, u] of Object.entries(EXTRA)) t.set(n, u);
  t.set('quoteleft', 0x2018);
  t.set('quoteright', 0x2019);
  t.set('space', 0x20);
  t.set('hyphen', 0x2d);
  NAME_TO_UNI = t;
  return t;
}

/** Unicode text for a glyph name ('' when unknown). */
export function glyphNameToUnicode(name) {
  if (!name) return '';
  const t = nameTable();
  if (t.has(name)) return String.fromCodePoint(t.get(name));
  // Suffixed variants: "a.sc", "one.oldstyle", "f_f_i" ligatures.
  const base = name.split('.')[0];
  if (base !== name && base) return glyphNameToUnicode(base);
  if (name.includes('_')) return name.split('_').map(glyphNameToUnicode).join('');
  let m = /^uni([0-9A-Fa-f]{4,})$/.exec(name);
  if (m) {
    let s = '';
    for (let i = 0; i + 4 <= m[1].length; i += 4) s += String.fromCharCode(parseInt(m[1].slice(i, i + 4), 16));
    return s;
  }
  m = /^u([0-9A-Fa-f]{4,6})$/.exec(name);
  if (m) {
    const cp = parseInt(m[1], 16);
    return cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
  }
  return '';
}

/** Unicode for a byte in the Windows-1252 or Mac Roman character sets (used for symbolic TrueType fallbacks). */
export function winAnsiUnicode(code) {
  if (code >= 128 && code < 160) return WIN_UNI[code - 128] || code;
  return code;
}
