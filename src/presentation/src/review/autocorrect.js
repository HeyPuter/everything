// AutoCorrect: corrections made while typing on the slide. Each typed
// character may finish a correction: a word from the replacement list, a
// fraction, an ordinal, a dash, a sentence's first letter, straight quotes,
// or a "* " or "1. " that starts a list. A correction is one step of the
// editor's undo, so Ctrl+Z puts back what was typed.
import { el, dialog, iconButton } from "../ui.js";

const KEY = "presentation:autocorrect";

export const DEFAULT_REPLACEMENTS = [
  ["(c)", "©"],
  ["(r)", "®"],
  ["(tm)", "™"],
  ["...", "…"],
  ["->", "→"],
  ["<-", "←"],
  ["=>", "⇒"],
  ["<=>", "⇔"],
  ["i", "I"],
  ["teh", "the"],
  ["adn", "and"],
  ["taht", "that"],
  ["hte", "the"],
  ["wich", "which"],
  ["thier", "their"],
  ["recieve", "receive"],
  ["seperate", "separate"],
  ["definately", "definitely"],
  ["occured", "occurred"],
  ["untill", "until"],
  ["alot", "a lot"],
  ["becuase", "because"],
  ["accomodate", "accommodate"],
  ["acheive", "achieve"],
  ["beleive", "believe"],
  ["enviroment", "environment"],
  ["goverment", "government"],
  ["tommorow", "tomorrow"],
  ["wierd", "weird"],
  ["freind", "friend"],
  ["calender", "calendar"],
  ["existance", "existence"],
  ["publically", "publicly"],
  ["truely", "truly"],
];

export const DEFAULT_OPTIONS = {
  replace: true,
  capitalize: true,
  quotes: true,
  fractions: true,
  ordinals: true,
  dashes: true,
  lists: true,
  replacements: DEFAULT_REPLACEMENTS,
};

export function loadAutoCorrect() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "null");
    if (!raw || typeof raw !== "object") return { ...DEFAULT_OPTIONS };
    const out = { ...DEFAULT_OPTIONS };
    for (const k of Object.keys(DEFAULT_OPTIONS))
      if (k !== "replacements" && typeof raw[k] === "boolean") out[k] = raw[k];
    if (Array.isArray(raw.replacements))
      out.replacements = raw.replacements.filter(
        (r) =>
          Array.isArray(r) &&
          typeof r[0] === "string" &&
          typeof r[1] === "string" &&
          r[0],
      );
    return out;
  } catch {
    return { ...DEFAULT_OPTIONS };
  }
}
export function saveAutoCorrect(options) {
  try {
    localStorage.setItem(KEY, JSON.stringify(options));
  } catch {}
}

const TRIGGER = /[\s.,;:!?)\]}"'”’]/;
const LETTER = /\p{L}/u;
const ABBREVIATIONS = new Set([
  "e.g",
  "i.e",
  "etc",
  "vs",
  "mr",
  "mrs",
  "ms",
  "dr",
  "st",
  "no",
  "fig",
  "approx",
  "inc",
  "ltd",
  "jr",
  "sr",
]);
const FRACTIONS = {
  "1/2": "½",
  "1/4": "¼",
  "3/4": "¾",
  "1/3": "⅓",
  "2/3": "⅔",
};

// Keeps the typed word's capitals: "Teh" → "The", "TEH" → "THE".
function shapeCase(typed, replacement) {
  if (typed.length > 1 && typed === typed.toUpperCase() && LETTER.test(typed))
    return replacement.toUpperCase();
  if (typed[0] && typed[0] !== typed[0].toLowerCase())
    return replacement[0].toUpperCase() + replacement.slice(1);
  return replacement;
}

/**
 * The correction one typed character finishes, or null. `text` already
 * holds the character, just before `caret`. Returns
 * { start, end, replacement } to replace text[start, end), and optionally
 * `superscript: [from, to]` (offsets after the replacement) or
 * `list: "bullet" | "number"`.
 */
export function autoCorrectAt(text, caret, options = DEFAULT_OPTIONS) {
  if (caret < 1) return null;
  const typed = text[caret - 1];
  const lineStart = text.lastIndexOf("\n", caret - 1) + 1;
  const line = text.slice(lineStart, caret);

  // Straight quotes become curly as they are typed.
  if (options.quotes && (typed === '"' || typed === "'")) {
    const prev = caret >= 2 ? text[caret - 2] : "";
    const opening = !prev || /[\s([{—–-]/.test(prev);
    const curly = typed === '"' ? (opening ? "“" : "”") : opening ? "‘" : "’";
    return { start: caret - 1, end: caret, replacement: curly };
  }

  // Symbols from the list complete as their last character is typed.
  if (options.replace)
    for (const [from, to] of [...options.replacements].sort(
      (a, b) => b[0].length - a[0].length,
    )) {
      if (LETTER.test(from.replace(/^\(|\)$/g, "")) && !/^\(.*\)$/.test(from))
        continue;
      if (text.slice(lineStart, caret).endsWith(from)) {
        const start = caret - from.length;
        // "(c)" only on its own, not inside a word.
        if (
          from.startsWith("(") &&
          start > lineStart &&
          /[\p{L}\p{N}]/u.test(text[start - 1])
        )
          continue;
        return { start, end: caret, replacement: to };
      }
    }

  // A list starts with "* ", "- " or "1. " typed at the start of a line.
  if (options.lists && typed === " " && caret - lineStart <= 3) {
    if (/^[*\-•] $/.test(line))
      return { start: lineStart, end: caret, replacement: "", list: "bullet" };
    if (/^1[.)] $/.test(line))
      return { start: lineStart, end: caret, replacement: "", list: "number" };
  }

  if (!TRIGGER.test(typed)) return null;
  // The word just finished, before the character that finished it.
  const end = caret - 1;
  let start = end;
  while (start > lineStart && !/\s/.test(text[start - 1])) start--;
  // Quotes and brackets around a word are not part of it.
  while (start < end && /["'“‘(\[{]/.test(text[start])) start++;
  let word = text.slice(start, end);
  // Trailing punctuation typed before this trigger ("word." then space).
  let tail = "";
  const m = /^(.*?)([.,;:!?)"'”’]+)$/u.exec(word);
  if (m && m[1]) {
    word = m[1];
    tail = m[2];
  }
  if (!word) return null;
  const wordEnd = start + word.length;
  let replacement = word;
  let superscript = null;

  if (options.dashes) {
    // "well--known" → em dash; "this -- that" → en dash.
    const em = /^([\p{L}\p{N}]+)--([\p{L}\p{N}]+)$/u.exec(word);
    if (em) replacement = `${em[1]}—${em[2]}`;
    else if (
      word !== "--" &&
      / -- $/.test(text.slice(Math.max(lineStart, start - 4), start))
    ) {
      // Replace the " -- " before this word.
      const dashAt = start - 3;
      return {
        start: dashAt,
        end: start,
        replacement: "– ",
      };
    }
  }
  if (options.fractions && FRACTIONS[word]) replacement = FRACTIONS[word];
  if (options.ordinals) {
    const ord = /^(\d*?)(1st|2nd|3rd|[04-9]th|1[123]th)$/.exec(word);
    if (ord) {
      const digits = word.replace(/(st|nd|rd|th)$/, "");
      const n = Number(digits) % 100;
      const proper =
        n >= 11 && n <= 13
          ? "th"
          : { 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th";
      if (word.endsWith(proper))
        superscript = [start + digits.length, start + word.length];
    }
  }
  if (options.replace && replacement === word) {
    const hit = options.replacements.find(
      ([from]) =>
        from.toLowerCase() === word.toLowerCase() && LETTER.test(from),
    );
    if (hit) {
      // "i" only alone; other words keep the case they were typed in.
      if (hit[0] === "i" ? word === "i" : true)
        replacement = hit[0] === "i" ? "I" : shapeCase(word, hit[1]);
    }
  }
  if (options.capitalize && /^\p{Ll}/u.test(replacement)) {
    const before = text.slice(lineStart, start);
    const prev = /([\p{L}.]+)[.!?]["'”’)]*\s+$/u.exec(before);
    const sentenceStart =
      /^\s*$/.test(before) ||
      (/[.!?]["'”’)]*\s+$/.test(before) &&
        !(prev && ABBREVIATIONS.has(prev[1].toLowerCase())));
    // Not a web or file address, nor a word with a dot inside.
    if (sentenceStart && !/[./@]/.test(replacement) && /^\p{L}+$/u.test(word))
      replacement = replacement[0].toUpperCase() + replacement.slice(1);
  }
  if (replacement === word && !superscript) return null;
  return {
    start,
    end: wordEnd,
    replacement,
    ...(superscript ? { superscript } : {}),
    tail,
  };
}

/**
 * Applies AutoCorrect to an open text editor: `editor` gives text(),
 * selectionOffsets(), replaceRange(start, end, value), setSelection(a, b),
 * toggleListStyle(style), and superscript(from, to).
 */
export function attachAutoCorrect(editor, getOptions = loadAutoCorrect) {
  const input = editor.input;
  let busy = false;
  input.addEventListener("input", (e) => {
    if (busy || e.isComposing || e.inputType !== "insertText" || !e.data)
      return;
    if (e.data.length !== 1) return;
    const options = getOptions();
    const sel = editor.selectionOffsets();
    if (!sel || sel[0] !== sel[1]) return;
    const caret = sel[0];
    const fix = autoCorrectAt(editor.text(), caret, options);
    if (!fix) return;
    busy = true;
    try {
      const delta = fix.replacement.length - (fix.end - fix.start);
      if (fix.replacement !== editor.text().slice(fix.start, fix.end))
        editor.replaceRange(fix.start, fix.end, fix.replacement);
      const after = caret + delta;
      editor.setSelection(after, after);
      if (fix.list) editor.toggleListStyle(fix.list);
      if (fix.superscript) {
        editor.superscript(fix.superscript[0], fix.superscript[1]);
        editor.setSelection(after, after);
      }
    } finally {
      busy = false;
    }
  });
}

// The AutoCorrect Options dialog.
export async function autoCorrectDialog() {
  const options = loadAutoCorrect();
  const box = (key, label) =>
    el(
      "label",
      { class: "check-field" },
      el("input", {
        type: "checkbox",
        checked: options[key],
        onchange: (e) => (options[key] = e.target.checked),
      }),
      el("span", {}, label),
    );
  let rows = options.replacements.map(([a, b]) => [a, b]);
  const list = el("div", {
    class: "autocorrect-list",
    role: "list",
    "aria-label": "Replacements",
  });
  const from = el("input", {
    class: "input",
    "aria-label": "Replace",
    placeholder: "Replace",
    maxlength: 40,
  });
  const to = el("input", {
    class: "input",
    "aria-label": "With",
    placeholder: "With",
    maxlength: 120,
  });
  const draw = () =>
    list.replaceChildren(
      ...rows.map(([a, b], i) =>
        el(
          "div",
          { class: "autocorrect-row", role: "listitem" },
          el("span", { class: "autocorrect-from" }, a),
          el("span", { class: "autocorrect-to" }, b),
          iconButton(`Delete ${a}`, "Trash2", () => {
            rows.splice(i, 1);
            draw();
          }),
        ),
      ),
    );
  draw();
  const add = () => {
    const a = from.value.trim(),
      b = to.value;
    if (!a || !b) return;
    rows = rows.filter(([x]) => x !== a);
    rows.unshift([a, b]);
    from.value = to.value = "";
    draw();
    from.focus();
  };
  for (const field of [from, to])
    field.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        add();
      }
    });
  const body = el(
    "div",
    { class: "dialog-body autocorrect-dialog" },
    el(
      "p",
      { class: "helper" },
      "Corrections made as you type on a slide. Undo takes back a correction right after it is made.",
    ),
    el(
      "fieldset",
      { class: "autocorrect-options" },
      el("legend", {}, "As you type"),
      box("capitalize", "Capitalize the first letter of sentences"),
      box("quotes", "Replace straight quotes with smart quotes"),
      box("fractions", "Replace fractions (1/2) with fraction characters (½)"),
      box("ordinals", "Superscript ordinals (1st)"),
      box("dashes", "Replace hyphens (--) with dashes (—)"),
      box("lists", "Start bulleted and numbered lists automatically"),
      box("replace", "Replace text as you type"),
    ),
    el(
      "div",
      { class: "autocorrect-add" },
      from,
      to,
      el(
        "button",
        { type: "button", class: "btn secondary", onclick: add },
        "Add",
      ),
    ),
    list,
    el(
      "button",
      {
        type: "button",
        class: "text-button",
        onclick: () => {
          rows = DEFAULT_REPLACEMENTS.map(([a, b]) => [a, b]);
          draw();
        },
      },
      "Restore the default list",
    ),
  );
  const ok = await dialog({ title: "AutoCorrect", body, confirm: "OK" });
  if (!ok) return false;
  options.replacements = rows;
  saveAutoCorrect(options);
  return true;
}
