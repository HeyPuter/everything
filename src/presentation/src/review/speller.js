// The spelling engine: the en-US Hunspell word list (SCOWL, in
// public/dictionaries) through nspell, loaded on first use, plus the words
// the user added. Also which words of a text to check, and how to order
// suggestions.

const PERSONAL_KEY = "presentation:dictionary";

// Addresses, paths and handles are not words to check.
const ADDRESS = /^(?:https?:\/\/|www\.|mailto:)|@|\\|\/|\.[a-z]{2,4}$/i;

/**
 * The words of `text` worth checking: [{ start, end, word }]. Numbers,
 * acronyms in capitals, addresses and words with underscores are skipped;
 * typographic apostrophes count as plain ones and a possessive's "'s" is
 * left off.
 */
export function checkableWords(text) {
  const out = [];
  const segmenter = new Intl.Segmenter("en", { granularity: "word" });
  for (const seg of segmenter.segment(text)) {
    if (!seg.isWordLike) continue;
    const start = seg.index;
    const end = start + seg.segment.length;
    let from = start;
    while (from > 0 && !/\s/.test(text[from - 1])) from--;
    let to = end;
    while (to < text.length && !/\s/.test(text[to])) to++;
    const token = text.slice(from, to).replace(/[.,;:!?)"'’”]+$/, "");
    if (ADDRESS.test(token)) continue;
    const word = seg.segment.replace(/’/g, "'");
    if (/[\d_]/.test(word)) continue;
    if (!/\p{L}/u.test(word)) continue;
    if (word.length > 1 && word === word.toUpperCase()) continue;
    const trimmed = word.replace(/'s$/i, "").replace(/^'+|'+$/g, "");
    out.push({ start, end, word: trimmed || word });
  }
  return out;
}

function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [
    i,
    ...Array(b.length).fill(0),
  ]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  return d[a.length][b.length];
}

const swapped = (a, b) =>
  a.length === b.length &&
  [...a].filter((ch, i) => ch !== b[i]).length === 2 &&
  [...a].sort().join() === [...b].sort().join();

/**
 * Suggestions closest first; ties keep the engine's order. They take the
 * word's capitalization: "Teh" → "The", "TEH" → "THE".
 */
export function orderSuggestions(word, suggestions, limit = 8) {
  const lower = word.toLowerCase();
  const capital =
    word.length > 0 &&
    word[0] !== word[0].toLowerCase() &&
    word.slice(1) === word.slice(1).toLowerCase();
  const upper = word.length > 1 && word === word.toUpperCase();
  const ranked = [...new Set(suggestions)]
    .map((s, i) => {
      const c = s.toLowerCase();
      let score = editDistance(lower, c) * 10;
      // Two letters typed the wrong way round is the commonest slip.
      if (swapped(lower, c)) score -= 6;
      if (c[0] !== lower[0]) score += 3;
      if (c.length !== lower.length) score += 1;
      return { s, score, i };
    })
    .sort((a, b) => a.score - b.score || a.i - b.i);
  const out = [];
  for (const { s } of ranked) {
    const shaped = upper
      ? s.toUpperCase()
      : capital && s === s.toLowerCase()
        ? s[0].toUpperCase() + s.slice(1)
        : s;
    if (!out.includes(shaped)) out.push(shaped);
    if (out.length >= limit) break;
  }
  return out;
}

export function personalWords() {
  try {
    const list = JSON.parse(localStorage.getItem(PERSONAL_KEY) || "[]");
    return Array.isArray(list) ? list.filter((w) => typeof w === "string") : [];
  } catch {
    return [];
  }
}
function addPersonalWord(word) {
  const list = personalWords();
  if (list.includes(word)) return;
  list.push(word);
  try {
    localStorage.setItem(PERSONAL_KEY, JSON.stringify(list.slice(-5000)));
  } catch {}
}

// Words of everyday slides the word list leaves out.
const COMMON_WORDS = [
  "roadmap",
  "roadmaps",
  "onboarding",
  "offboarding",
  "workflow",
  "workflows",
  "dashboard",
  "dashboards",
  "startup",
  "startups",
  "stakeholder",
  "stakeholders",
  "deliverable",
  "deliverables",
  "upsell",
  "upskill",
  "scalable",
  "scalability",
  "teammate",
  "teammates",
  "timeline",
  "timelines",
  "webinar",
  "webinars",
  "app",
  "apps",
  "online",
  "offline",
  "email",
  "emails",
  "website",
  "websites",
  "ecommerce",
  "fintech",
  "SaaS",
  "unselected",
];

let loading = null;
/** The checker: { correct(word), suggest(word), add(word) }. */
export function loadSpeller(base = document.baseURI) {
  loading ??= (async () => {
    const fetchText = (name) =>
      fetch(new URL(`dictionaries/${name}`, base)).then((r) => {
        if (!r.ok)
          throw new Error("The spelling dictionary could not be loaded.");
        return r.text();
      });
    const [{ default: nspell }, aff, dic] = await Promise.all([
      import("nspell"),
      fetchText("en-US.aff"),
      fetchText("en-US.dic"),
    ]);
    const engine = nspell(aff, dic);
    for (const w of [...COMMON_WORDS, ...personalWords()]) engine.add(w);
    const correct = (word) =>
      engine.correct(word) ||
      // A capitalized word at a sentence start.
      (word[0] !== word[0].toLowerCase() &&
        word.slice(1) === word.slice(1).toLowerCase() &&
        engine.correct(word.toLowerCase()));
    return {
      correct,
      suggest: (word) => orderSuggestions(word, engine.suggest(word)),
      add: (word) => {
        engine.add(word);
        addPersonalWord(word);
      },
    };
  })().catch((e) => {
    loading = null;
    throw e;
  });
  return loading;
}
