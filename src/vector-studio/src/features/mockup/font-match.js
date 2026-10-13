/**
 * Mapping identified typefaces to the fonts the app has.
 *
 * The vision model names the typefaces it sees (often fonts the app does
 * not have) and describes the lettering (classification, weight, slant).
 * Each available family is scored by:
 *   - an exact name match with an identified typeface (best),
 *   - being one the model picked from the available list,
 *   - classification and design traits shared with the identified
 *     typefaces (a table of well-known faces and of the bundled ones),
 *   - having the identified weight and slant.
 * The result is a ranked list with a short reason for each suggestion.
 */

/** Classification and traits of the bundled families. */
export const FAMILY_TRAITS = {
  inter: { category: 'sans-serif', traits: ['grotesque', 'neutral'] },
  roboto: { category: 'sans-serif', traits: ['grotesque', 'neutral'] },
  'open sans': { category: 'sans-serif', traits: ['humanist', 'neutral'] },
  lato: { category: 'sans-serif', traits: ['humanist', 'rounded'] },
  montserrat: { category: 'sans-serif', traits: ['geometric', 'wide'] },
  poppins: { category: 'sans-serif', traits: ['geometric'] },
  oswald: { category: 'sans-serif', traits: ['condensed', 'grotesque'] },
  'bebas neue': { category: 'display', traits: ['condensed', 'caps', 'grotesque'] },
  'source serif 4': { category: 'serif', traits: ['transitional'] },
  merriweather: { category: 'serif', traits: ['transitional', 'sturdy'] },
  'playfair display': { category: 'serif', traits: ['didone', 'high-contrast'] },
  lora: { category: 'serif', traits: ['oldstyle', 'calligraphic'] },
  'roboto mono': { category: 'monospace', traits: ['grotesque'] },
  'source code pro': { category: 'monospace', traits: ['humanist'] },
  pacifico: { category: 'handwriting', traits: ['script', 'brush', 'retro'] },
  lobster: { category: 'display', traits: ['script', 'retro', 'bold'] },
  'dancing script': { category: 'handwriting', traits: ['script', 'calligraphic'] },
  'permanent marker': { category: 'handwriting', traits: ['marker', 'caps'] },
};

/** Classification and traits of widely used typefaces the model is likely to name. */
export const KNOWN_TRAITS = {
  helvetica: { category: 'sans-serif', traits: ['grotesque', 'neutral'] },
  'helvetica neue': { category: 'sans-serif', traits: ['grotesque', 'neutral'] },
  arial: { category: 'sans-serif', traits: ['grotesque', 'neutral'] },
  'sf pro': { category: 'sans-serif', traits: ['grotesque', 'neutral'] },
  'san francisco': { category: 'sans-serif', traits: ['grotesque', 'neutral'] },
  univers: { category: 'sans-serif', traits: ['grotesque', 'neutral'] },
  akzidenz: { category: 'sans-serif', traits: ['grotesque'] },
  'akzidenz-grotesk': { category: 'sans-serif', traits: ['grotesque'] },
  'neue haas grotesk': { category: 'sans-serif', traits: ['grotesque', 'neutral'] },
  'segoe ui': { category: 'sans-serif', traits: ['humanist', 'neutral'] },
  frutiger: { category: 'sans-serif', traits: ['humanist'] },
  myriad: { category: 'sans-serif', traits: ['humanist'] },
  'myriad pro': { category: 'sans-serif', traits: ['humanist'] },
  verdana: { category: 'sans-serif', traits: ['humanist', 'wide'] },
  tahoma: { category: 'sans-serif', traits: ['humanist'] },
  'trebuchet ms': { category: 'sans-serif', traits: ['humanist'] },
  'gill sans': { category: 'sans-serif', traits: ['humanist'] },
  calibri: { category: 'sans-serif', traits: ['humanist', 'rounded'] },
  'source sans': { category: 'sans-serif', traits: ['humanist'] },
  'noto sans': { category: 'sans-serif', traits: ['humanist', 'neutral'] },
  futura: { category: 'sans-serif', traits: ['geometric'] },
  avenir: { category: 'sans-serif', traits: ['geometric'] },
  'century gothic': { category: 'sans-serif', traits: ['geometric', 'wide'] },
  gotham: { category: 'sans-serif', traits: ['geometric', 'wide'] },
  'proxima nova': { category: 'sans-serif', traits: ['geometric'] },
  'avant garde': { category: 'sans-serif', traits: ['geometric', 'wide'] },
  'itc avant garde gothic': { category: 'sans-serif', traits: ['geometric', 'wide'] },
  'gt walsheim': { category: 'sans-serif', traits: ['geometric'] },
  'circular': { category: 'sans-serif', traits: ['geometric'] },
  'din': { category: 'sans-serif', traits: ['grotesque', 'condensed'] },
  'din condensed': { category: 'sans-serif', traits: ['grotesque', 'condensed'] },
  impact: { category: 'display', traits: ['condensed', 'grotesque', 'bold'] },
  'franklin gothic': { category: 'sans-serif', traits: ['grotesque', 'condensed'] },
  'league gothic': { category: 'display', traits: ['condensed', 'grotesque'] },
  'alternate gothic': { category: 'display', traits: ['condensed', 'grotesque'] },
  'trade gothic': { category: 'sans-serif', traits: ['grotesque', 'condensed'] },
  'times new roman': { category: 'serif', traits: ['transitional'] },
  times: { category: 'serif', traits: ['transitional'] },
  georgia: { category: 'serif', traits: ['transitional', 'sturdy'] },
  baskerville: { category: 'serif', traits: ['transitional'] },
  'libre baskerville': { category: 'serif', traits: ['transitional'] },
  cambria: { category: 'serif', traits: ['transitional', 'sturdy'] },
  'pt serif': { category: 'serif', traits: ['transitional'] },
  garamond: { category: 'serif', traits: ['oldstyle'] },
  'eb garamond': { category: 'serif', traits: ['oldstyle'] },
  'adobe garamond': { category: 'serif', traits: ['oldstyle'] },
  caslon: { category: 'serif', traits: ['oldstyle'] },
  palatino: { category: 'serif', traits: ['oldstyle', 'calligraphic'] },
  minion: { category: 'serif', traits: ['oldstyle'] },
  bembo: { category: 'serif', traits: ['oldstyle'] },
  bodoni: { category: 'serif', traits: ['didone', 'high-contrast'] },
  didot: { category: 'serif', traits: ['didone', 'high-contrast'] },
  'abril fatface': { category: 'display', traits: ['didone', 'high-contrast', 'bold'] },
  rockwell: { category: 'serif', traits: ['slab', 'sturdy'] },
  clarendon: { category: 'serif', traits: ['slab', 'sturdy'] },
  'courier': { category: 'monospace', traits: ['slab'] },
  'courier new': { category: 'monospace', traits: ['slab'] },
  consolas: { category: 'monospace', traits: ['humanist'] },
  menlo: { category: 'monospace', traits: ['grotesque'] },
  monaco: { category: 'monospace', traits: ['grotesque'] },
  'fira code': { category: 'monospace', traits: ['humanist'] },
  'jetbrains mono': { category: 'monospace', traits: ['grotesque'] },
  'brush script': { category: 'handwriting', traits: ['script', 'brush'] },
  'brush script mt': { category: 'handwriting', traits: ['script', 'brush'] },
  'great vibes': { category: 'handwriting', traits: ['script', 'calligraphic'] },
  'comic sans': { category: 'handwriting', traits: ['casual', 'rounded'] },
  'comic sans ms': { category: 'handwriting', traits: ['casual', 'rounded'] },
  'cooper black': { category: 'display', traits: ['retro', 'bold', 'rounded'] },
};

const CATEGORY_ALIASES = {
  sans: 'sans-serif',
  'sans serif': 'sans-serif',
  sansserif: 'sans-serif',
  grotesk: 'sans-serif',
  slab: 'serif',
  'slab serif': 'serif',
  'slab-serif': 'serif',
  script: 'handwriting',
  handwritten: 'handwriting',
  cursive: 'handwriting',
  calligraphic: 'handwriting',
  brush: 'handwriting',
  mono: 'monospace',
  monospaced: 'monospace',
  decorative: 'display',
};

const TRAIT_ALIASES = {
  'neo-grotesque': 'grotesque',
  neogrotesque: 'grotesque',
  grotesk: 'grotesque',
  'old-style': 'oldstyle',
  'old style': 'oldstyle',
  garalde: 'oldstyle',
  modern: 'didone',
  'high contrast': 'high-contrast',
  narrow: 'condensed',
  compressed: 'condensed',
  extended: 'wide',
  'all caps': 'caps',
  uppercase: 'caps',
  'slab serif': 'slab',
  'slab-serif': 'slab',
  egyptian: 'slab',
  handwritten: 'script',
  cursive: 'script',
};

/** Lowercase, collapsed name without style words ("Helvetica Neue Bold" -> "helvetica neue"). */
export function normalizeName(name) {
  let s = String(name || '')
    .toLowerCase()
    .replace(/[_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Trailing style and vendor words; names that are known as they are stay whole.
  const STYLE = /\s(regular|bold|italic|oblique|light|medium|semibold|black|heavy|thin|std|lt|\d+)$/;
  while (STYLE.test(s) && !KNOWN_TRAITS[s] && !FAMILY_TRAITS[s]) s = s.replace(STYLE, '');
  return s;
}

export function normalizeCategory(c) {
  const k = String(c || '').toLowerCase().trim();
  if (['serif', 'sans-serif', 'display', 'handwriting', 'monospace'].includes(k)) return k;
  return CATEGORY_ALIASES[k] || null;
}

function normalizeTraits(list) {
  const out = new Set();
  for (const t of Array.isArray(list) ? list : []) {
    const k = String(t || '').toLowerCase().trim();
    if (!k) continue;
    out.add(TRAIT_ALIASES[k] || k);
  }
  return out;
}

/** Traits of a typeface name: { category, traits } or null. */
export function traitsOf(name) {
  const k = normalizeName(name);
  if (!k) return null;
  if (FAMILY_TRAITS[k]) return FAMILY_TRAITS[k];
  if (KNOWN_TRAITS[k]) return KNOWN_TRAITS[k];
  // "Helvetica Neue LT Std 75" and similar: the longest known prefix.
  let best = null;
  for (const key of Object.keys(KNOWN_TRAITS)) if (k.startsWith(`${key} `) && (!best || key.length > best.length)) best = key;
  return best ? KNOWN_TRAITS[best] : null;
}

/** How alike two descriptions are (0..1): classification first, then shared traits. */
export function similarity(a, b) {
  if (!a || !b) return 0;
  let s = 0;
  if (a.category && b.category) {
    if (a.category === b.category) s += 0.55;
    // Display faces are often sans or script styles.
    else if ([a.category, b.category].includes('display')) s += 0.15;
  }
  const ta = a.traits instanceof Set ? a.traits : new Set(a.traits || []);
  const tb = b.traits instanceof Set ? b.traits : new Set(b.traits || []);
  if (ta.size && tb.size) {
    let shared = 0;
    for (const t of ta) if (tb.has(t)) shared++;
    s += 0.45 * (shared / Math.max(ta.size, tb.size));
  }
  return Math.min(1, s);
}

/**
 * Clean up the model's answer: { text, fonts: [{ name, confidence }],
 * closest: [names], category, traits: Set, weight, italic, color,
 * background }.
 */
export function normalizeAnswer(a = {}) {
  const fonts = (Array.isArray(a.fonts) ? a.fonts : [])
    .map((f, i) => (typeof f === 'string' ? { name: f, confidence: 1 - i * 0.15 } : { name: String(f?.name || ''), confidence: Number(f?.confidence) }))
    .filter((f) => f.name.trim())
    .map((f) => ({ name: f.name.trim(), confidence: Number.isFinite(f.confidence) ? Math.max(0, Math.min(1, f.confidence > 1 ? f.confidence / 100 : f.confidence)) : 0.5 }))
    .slice(0, 8);
  const hex = (c) => (/^#[0-9a-f]{6}$/i.test(String(c || '').trim()) ? String(c).trim().toLowerCase() : null);
  const w = Number(a.weight);
  return {
    text: typeof a.text === 'string' ? a.text.replace(/\r\n?/g, '\n').trim() : '',
    fonts,
    closest: (Array.isArray(a.closest) ? a.closest : []).map((n) => String(n || '').trim()).filter(Boolean).slice(0, 8),
    category: normalizeCategory(a.category),
    traits: normalizeTraits(a.traits),
    weight: Number.isFinite(w) ? Math.max(100, Math.min(900, Math.round(w / 100) * 100)) : 400,
    italic: Boolean(a.italic),
    color: hex(a.color),
    background: hex(a.background),
  };
}

/**
 * Rank the available families for an answer: [{ family, weight, style,
 * score (0..1), reason }], best first, at most `limit`. `families` is
 * [{ family, category?, faces: [{ weight, style }] }].
 */
export function rankFonts(answer, families, { limit = 8 } = {}) {
  const a = answer.traits instanceof Set ? answer : normalizeAnswer(answer);
  const described = { category: a.category, traits: a.traits };
  const ids = a.fonts.map((f) => ({ ...f, key: normalizeName(f.name), info: traitsOf(f.name) }));
  const closest = a.closest.map(normalizeName);
  const out = [];
  for (const fam of families) {
    const key = normalizeName(fam.family);
    const own = FAMILY_TRAITS[key] || (fam.category ? { category: normalizeCategory(fam.category), traits: [] } : null);
    let score = 0;
    let reason = '';
    const exact = ids.findIndex((f) => f.key === key);
    if (exact >= 0) {
      score = 0.9 + 0.1 * ids[exact].confidence;
      reason = 'Identified typeface';
    }
    const pick = closest.indexOf(key);
    if (pick >= 0 && score < 0.85 - pick * 0.05) {
      score = 0.85 - pick * 0.05;
      reason = 'Closest match among your fonts';
    }
    for (const f of ids) {
      if (!f.info || f.key === key) continue;
      const s = similarity(f.info, own) * (0.45 + 0.4 * f.confidence);
      if (s > score) {
        score = s;
        reason = `Similar to ${f.name}`;
      }
    }
    const d = similarity(described, own) * 0.6;
    if (d > score) {
      score = d;
      reason = a.category ? `${labelOf(a.category)} like the sample` : 'Similar style';
    }
    // Faces: the identified weight and slant, when the family has them.
    const faces = fam.faces?.length ? fam.faces : [{ weight: 400, style: 'normal' }];
    const wantStyle = a.italic ? 'italic' : 'normal';
    let face = faces[0];
    let fd = Infinity;
    for (const f of faces) {
      const dd = Math.abs((f.weight || 400) - a.weight) + (f.style === wantStyle ? 0 : 1000);
      if (dd < fd) {
        fd = dd;
        face = f;
      }
    }
    if (fd === 0) score += 0.03;
    else if (fd >= 1000) score -= 0.03;
    if (score <= 0.05) continue;
    out.push({ family: fam.family, weight: face.weight || 400, style: face.style || 'normal', score: Math.max(0, Math.min(1, score)), reason });
  }
  out.sort((p, q) => q.score - p.score || p.family.localeCompare(q.family));
  return out.slice(0, limit);
}

function labelOf(category) {
  return { serif: 'Serif', 'sans-serif': 'Sans serif', display: 'Display face', handwriting: 'Script', monospace: 'Monospaced' }[category] || 'Similar style';
}
