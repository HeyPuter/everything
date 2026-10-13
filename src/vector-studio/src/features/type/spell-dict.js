/**
 * A small affix-aware spelling checker for the bundled English word lists
 * (public/dictionaries, SCOWL: en_US and en_GB; see the LICENSE files
 * there).
 *
 * The word list stores stems with affix flags; the affix file holds the
 * prefix and suffix rules. A word is correct when it is a stem, or when
 * stripping one suffix and/or one prefix rule gives a stem that carries that
 * rule's flag. Suggestions come from single edits (transpositions,
 * replacements, deletions, insertions, the affix file's common
 * misspellings) and a few double edits, ranked by how people mistype.
 *
 * The files load once, on first use, with loadSpeller(); nothing is in the
 * main bundle.
 */

/** Parse affix rules: { pfx: [{ flag, strip, add, cond, cross }], sfx: [...], rep: [[from, to]], nosuggest }. */
export function parseAffixes(aff) {
  const out = { pfx: [], sfx: [], rep: [], nosuggest: '!', iconv: [] };
  const cross = {};
  for (const raw of String(aff).split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const p = line.split(/\s+/);
    if ((p[0] === 'PFX' || p[0] === 'SFX') && p.length === 4 && /^[YN]$/.test(p[2])) {
      cross[`${p[0]}${p[1]}`] = p[2] === 'Y';
      continue;
    }
    if ((p[0] === 'PFX' || p[0] === 'SFX') && p.length >= 5) {
      const [kind, flag, strip, add, cond = '.'] = p;
      const rule = {
        flag,
        strip: strip === '0' ? '' : strip,
        add: add === '0' ? '' : add.split('/')[0],
        cond: new RegExp(kind === 'SFX' ? `${cond}$` : `^${cond}`),
        cross: cross[`${kind}${flag}`] !== false,
      };
      (kind === 'PFX' ? out.pfx : out.sfx).push(rule);
    } else if (p[0] === 'REP' && p.length === 3) out.rep.push([p[1], p[2].replace(/_/g, ' ')]);
    else if (p[0] === 'NOSUGGEST' && p[1]) out.nosuggest = p[1];
    else if (p[0] === 'ICONV' && p.length === 3) out.iconv.push([p[1], p[2]]);
  }
  return out;
}

/** Parse the word list into Map(stem -> flags). The first line is a count. */
export function parseWords(dic) {
  const words = new Map();
  const lines = String(dic).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || (i === 0 && /^\d+$/.test(line))) continue;
    const slash = line.indexOf('/');
    const w = slash < 0 ? line : line.slice(0, slash);
    const flags = slash < 0 ? '' : line.slice(slash + 1);
    words.set(w, (words.get(w) || '') + flags);
  }
  return words;
}

const LETTERS = "abcdefghijklmnopqrstuvwxyz'";

/** Keyboard neighbors (QWERTY) for ranking replacement suggestions. */
const ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
function near(a, b) {
  for (let r = 0; r < ROWS.length; r++) {
    const i = ROWS[r].indexOf(a);
    if (i < 0) continue;
    for (let s = Math.max(0, r - 1); s <= Math.min(2, r + 1); s++) {
      const j = ROWS[s].indexOf(b);
      if (j >= 0 && Math.abs(j - i) <= 1) return true;
    }
  }
  return false;
}

function caseOf(w) {
  if (w === w.toLowerCase()) return 'lower';
  if (w === w.toUpperCase() && /\p{L}.*\p{L}/u.test(w)) return 'upper';
  if (w[0] === w[0].toUpperCase() && w.slice(1) === w.slice(1).toLowerCase()) return 'title';
  return 'mixed';
}

function applyCase(w, mode) {
  if (mode === 'upper') return w.toUpperCase();
  if (mode === 'title') return w[0].toUpperCase() + w.slice(1);
  return w;
}

export function createSpeller({ aff, dic }) {
  const A = parseAffixes(aff);
  const words = parseWords(dic);
  const sfxByEnd = new Map(); // last char of `add` ('' for none) -> rules
  for (const r of A.sfx) {
    const k = r.add.slice(-1);
    if (!sfxByEnd.has(k)) sfxByEnd.set(k, []);
    sfxByEnd.get(k).push(r);
  }
  const has = (stem, flag) => {
    const f = words.get(stem);
    return f !== undefined && (flag == null || f.includes(flag));
  };
  const suggestable = (w) => !(words.get(w) || '').includes(A.nosuggest);

  /** Suffix-stripped stems: [{ stem, rule }]. */
  const suffixStems = (w) => {
    const out = [];
    for (const k of [w.slice(-1), '']) {
      for (const r of sfxByEnd.get(k) || []) {
        if (!w.endsWith(r.add) || w.length <= r.add.length) continue;
        const stem = w.slice(0, w.length - r.add.length) + r.strip;
        if (r.cond.test(stem)) out.push({ stem, rule: r });
      }
    }
    return out;
  };

  /** Exact lookup of one case form, with affixes. */
  const lookup = (w) => {
    if (!w) return false;
    if (words.has(w)) return true;
    for (const { stem, rule } of suffixStems(w)) if (has(stem, rule.flag)) return true;
    for (const p of A.pfx) {
      if (!p.add || !w.startsWith(p.add) || w.length <= p.add.length) continue;
      const base = p.strip + w.slice(p.add.length);
      if (!p.cond.test(base)) continue;
      if (has(base, p.flag)) return true;
      if (!p.cross) continue;
      for (const { stem, rule } of suffixStems(base)) if (rule.cross && has(stem, p.flag) && has(stem, rule.flag)) return true;
    }
    return false;
  };

  const normalize = (w) => {
    let s = String(w);
    for (const [a, b] of A.iconv) s = s.split(a).join(b);
    return s;
  };

  /**
   * True when a word is spelled correctly. Lowercase list entries accept any
   * capitalization of a word in lowercase, Title or UPPER case; capitalized
   * entries (names) need their capital. `matchCase: false` accepts any case.
   */
  const correct = (word, { matchCase = true } = {}) => {
    const w = normalize(word);
    if (!w) return true;
    if (lookup(w)) return true;
    const lower = w.toLowerCase();
    const mode = caseOf(w);
    if (!matchCase) return lookup(lower) || lookup(lower[0].toUpperCase() + lower.slice(1));
    if (mode === 'title' || mode === 'upper') {
      if (lookup(lower)) return true;
      if (mode === 'upper' && lookup(lower[0].toUpperCase() + lower.slice(1))) return true;
    }
    return false;
  };

  const known = (w) => lookup(w) && suggestable(w);

  /** Spelling suggestions, best first (case follows the word's own case). */
  const suggest = (word, { limit = 8 } = {}) => {
    const w0 = normalize(word);
    const mode = caseOf(w0);
    const w = mode === 'mixed' ? w0 : w0.toLowerCase();
    const scored = new Map(); // candidate -> score (lower is better)
    const add = (c, score) => {
      if (!c || c === w) return;
      if (c.includes(' ')) {
        if (!c.split(' ').every((p) => (p.length > 1 || p === 'a' || p === 'i') && (known(p) || known(p[0].toUpperCase() + p.slice(1))))) return;
      } else if (!known(c)) {
        // Proper names keep their capital.
        const cap = c[0].toUpperCase() + c.slice(1);
        if (cap === c || !known(cap)) return;
        c = cap;
        score += 0.3;
      }
      if ((scored.get(c) ?? Infinity) > score) scored.set(c, score);
    };
    // Only the capital is wrong (a name typed in lowercase).
    if (mode === 'lower') add(w[0].toUpperCase() + w.slice(1), 0);
    // Common misspellings from the affix file.
    for (const [from, to] of A.rep) {
      let i = w.indexOf(from);
      while (i >= 0) {
        add(w.slice(0, i) + to + w.slice(i + from.length), 1);
        i = w.indexOf(from, i + 1);
      }
    }
    const edits = (s, base, cb) => {
      for (let i = 0; i < s.length - 1; i++) if (s[i] !== s[i + 1]) cb(s.slice(0, i) + s[i + 1] + s[i] + s.slice(i + 2), base + 0.6);
      for (let i = 0; i < s.length; i++) {
        cb(s.slice(0, i) + s.slice(i + 1), base + (s[i] === s[i - 1] || s[i] === s[i + 1] ? 0.7 : 1.1));
        for (const c of LETTERS) if (c !== s[i]) cb(s.slice(0, i) + c + s.slice(i + 1), base + (near(s[i], c) ? 0.9 : 1.3));
      }
      for (let i = 0; i <= s.length; i++) for (const c of LETTERS) cb(s.slice(0, i) + c + s.slice(i), base + (c === s[i - 1] || c === s[i] ? 0.8 : 1.2));
    };
    edits(w, 0, add);
    // Two words run together.
    for (let i = 1; i < w.length; i++) add(`${w.slice(0, i)} ${w.slice(i)}`, 2 + Math.abs(w.length / 2 - i) * 0.01);
    if (scored.size < 3 && w.length <= 12) {
      // Second edits from the deletions and transpositions of the word (cheap and common).
      const firsts = new Set();
      for (let i = 0; i < w.length; i++) firsts.add(w.slice(0, i) + w.slice(i + 1));
      for (let i = 0; i < w.length - 1; i++) firsts.add(w.slice(0, i) + w[i + 1] + w[i] + w.slice(i + 2));
      for (const f of firsts) edits(f, 1.2, add);
    }
    return [...scored]
      .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
      .slice(0, limit)
      .map(([c]) => (mode === 'mixed' ? c : c === c.toLowerCase() ? applyCase(c, mode) : mode === 'upper' ? c.toUpperCase() : c));
  };

  return { correct, suggest, size: words.size };
}

/**
 * Bundled dictionaries by key: files under public/dictionaries. en-GB
 * shares the en-US affix file (they are the same file).
 */
export const DICTIONARIES = {
  'en-US': { label: 'English: USA', aff: 'en-US.aff', dic: 'en-US.dic' },
  'en-GB': { label: 'English: UK', aff: 'en-US.aff', dic: 'en-GB.dic' },
};

/** The dictionary for a language tag (null when there is none). British spelling for the UK and the Commonwealth. */
export function dictionaryKey(code) {
  const tag = String(code || 'en-US').toLowerCase();
  const [base, region] = tag.split(/[-_]/);
  if (base !== 'en') return null;
  return ['gb', 'au', 'nz', 'ie', 'za', 'in'].includes(region) ? 'en-GB' : 'en-US';
}

const spellers = new Map(); // key -> Promise<speller>
const ready = new Map(); // key -> speller

/** Load a bundled dictionary (once). Resolves to a speller. */
export function loadSpeller(key = 'en-US') {
  const def = DICTIONARIES[key] || DICTIONARIES['en-US'];
  const k = DICTIONARIES[key] ? key : 'en-US';
  let p = spellers.get(k);
  if (!p) {
    const base = typeof document !== 'undefined' ? document.baseURI : 'http://localhost/';
    const get = (f) =>
      fetch(new URL(`dictionaries/${f}`, base)).then((r) => {
        if (!r.ok) throw new Error('The spelling dictionary could not be loaded.');
        return r.text();
      });
    p = Promise.all([get(def.aff), get(def.dic)])
      .then(([aff, dic]) => {
        const sp = createSpeller({ aff, dic });
        ready.set(k, sp);
        return sp;
      })
      .catch((err) => {
        spellers.delete(k);
        throw err;
      });
    spellers.set(k, p);
  }
  return p;
}

/** A dictionary's speller when it has loaded (null otherwise). */
export function loadedSpeller(key = 'en-US') {
  return ready.get(key) || null;
}

/** Use a ready speller (tests, or a speller built elsewhere); without a key it serves every dictionary. */
export function setSpeller(speller, key = null) {
  for (const k of key ? [key] : Object.keys(DICTIONARIES)) {
    spellers.set(k, Promise.resolve(speller));
    ready.set(k, speller);
  }
}
