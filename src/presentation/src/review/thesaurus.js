// The Thesaurus pane (Shift+F7): synonyms and antonyms for the selected
// word, from Puter's AI, or from a small built-in list when the AI cannot be
// reached. Insert puts the chosen word in place of the selection; Copy puts
// it on the clipboard. Double-click a word to look it up in turn.
import { el, icon, toast } from "../ui.js";
import { aiAvailable, askJson } from "./ai.js";
import { offlineLookup } from "./thesaurus-data.js";

const SYSTEM =
  "You are a thesaurus. Answer only with JSON of the form " +
  '{"word": string, "meanings": [{"sense": string, "synonyms": string[], "antonyms": string[]}]}. ' +
  "Give up to four senses of the word, each with a short sense label (two to four words) and up to eight synonyms and four antonyms in the same part of speech and the word's language. Use [] when there are none.";

export function normalizeThesaurus(data, word) {
  const meanings = Array.isArray(data?.meanings) ? data.meanings : [];
  const clean = (list) =>
    [
      ...new Set(
        (Array.isArray(list) ? list : [])
          .filter((w) => typeof w === "string" && w.trim())
          .map((w) => w.trim()),
      ),
    ].slice(0, 12);
  const out = meanings
    .map((m) => ({
      sense: typeof m?.sense === "string" ? m.sense.trim() : "",
      synonyms: clean(m?.synonyms),
      antonyms: clean(m?.antonyms),
    }))
    .filter((m) => m.synonyms.length || m.antonyms.length)
    .slice(0, 4);
  return {
    word: typeof data?.word === "string" ? data.word : word,
    meanings: out,
  };
}

export function createThesaurus(env, host) {
  const state = {
    query: "",
    result: null,
    loading: false,
    error: null,
    offline: false,
    chosen: null,
    // The text the lookup started from, which Insert replaces.
    source: null,
    request: 0,
  };

  async function lookUp(word) {
    const query = String(word || "").trim();
    state.query = query;
    state.chosen = null;
    state.error = null;
    state.result = null;
    if (!query) {
      host.refresh("thesaurus");
      return;
    }
    const request = ++state.request;
    state.loading = true;
    host.refresh("thesaurus");
    let result = null,
      offline = false;
    if (aiAvailable()) {
      try {
        result = normalizeThesaurus(
          await askJson(SYSTEM, `Word: ${query}`, { maxTokens: 800 }),
          query,
        );
      } catch (e) {
        state.error = e.message;
      }
    }
    if (!result?.meanings.length) {
      const fallback = offlineLookup(query);
      if (fallback) {
        result = fallback;
        offline = true;
        state.error = null;
      }
    }
    if (request !== state.request) return;
    state.loading = false;
    state.result = result;
    state.offline = offline;
    if (!result?.meanings.length && !state.error)
      state.error = `No synonyms found for “${query}”.`;
    host.refresh("thesaurus");
  }

  async function insert() {
    const word = state.chosen;
    if (!word) return;
    if (env.blocksEdits()) return env.blockedEdit();
    const ok = await env.insertText(word, {
      replacing: state.source || state.query,
    });
    if (ok) toast(`Inserted “${word}”.`);
    else {
      await copy();
    }
  }
  async function copy() {
    if (!state.chosen) return;
    try {
      await navigator.clipboard.writeText(state.chosen);
      toast(`Copied “${state.chosen}”.`);
    } catch {
      toast("The word could not be copied.");
    }
  }

  function render() {
    const wrap = el("div", { class: "thesaurus-pane" });
    const field = el("input", {
      class: "input",
      type: "search",
      value: state.query,
      "aria-label": "Word to look up",
      placeholder: "Look up a word",
      "data-focus-key": "thesaurus-query",
      "data-autofocus": "",
    });
    const form = el(
      "form",
      {
        class: "review-search",
        onsubmit: (e) => {
          e.preventDefault();
          state.source = null;
          lookUp(field.value);
        },
      },
      field,
      el(
        "button",
        {
          type: "submit",
          class: "btn secondary small",
          "aria-label": "Look up",
        },
        icon("Search", 16),
      ),
    );
    wrap.append(form);
    if (state.loading)
      wrap.append(
        el("p", { class: "review-status", role: "status" }, "Looking up…"),
      );
    else if (state.error && !state.result?.meanings.length)
      wrap.append(
        el("p", { class: "review-status", role: "status" }, state.error),
      );
    else if (!state.query)
      wrap.append(
        el(
          "p",
          { class: "helper" },
          "Select a word in a text box, then press Shift+F7, or type one above.",
        ),
      );
    const words = (list, label) =>
      list.length
        ? el(
            "div",
            { class: "thesaurus-group" },
            el("p", { class: "review-label" }, label),
            el(
              "div",
              {
                class: "thesaurus-words",
                role: "listbox",
                "aria-label": label,
              },
              list.map((w) =>
                el(
                  "button",
                  {
                    type: "button",
                    role: "option",
                    class: "thesaurus-word",
                    "aria-selected": String(state.chosen === w),
                    "data-focus-key": `word:${label}:${w}`,
                    onclick: () => {
                      state.chosen = w;
                      host.refresh("thesaurus");
                    },
                    ondblclick: () => {
                      state.source = state.source || state.query;
                      lookUp(w);
                    },
                    onkeydown: (e) => {
                      if (e.key === "Enter" && e.shiftKey) {
                        e.preventDefault();
                        lookUp(w);
                      }
                    },
                  },
                  w,
                ),
              ),
            ),
          )
        : null;
    for (const m of state.result?.meanings || [])
      wrap.append(
        el(
          "section",
          { class: "thesaurus-meaning" },
          m.sense && el("h3", { class: "thesaurus-sense" }, m.sense),
          words(m.synonyms, m.sense ? `Synonyms: ${m.sense}` : "Synonyms"),
          words(m.antonyms, m.sense ? `Antonyms: ${m.sense}` : "Antonyms"),
        ),
      );
    if (state.result?.meanings.length) {
      if (state.offline)
        wrap.append(
          el(
            "p",
            { class: "helper" },
            "From the built-in word list (the AI could not be reached).",
          ),
        );
      wrap.append(
        el(
          "div",
          { class: "review-footer" },
          el(
            "span",
            { class: "thesaurus-chosen", "aria-live": "polite" },
            state.chosen ? `Chosen: ${state.chosen}` : "Choose a word",
          ),
          el(
            "button",
            {
              type: "button",
              class: "btn secondary small",
              disabled: !state.chosen || null,
              onclick: copy,
            },
            "Copy",
          ),
          el(
            "button",
            {
              type: "button",
              class: "btn primary small",
              disabled: !state.chosen || null,
              onclick: insert,
            },
            "Insert",
          ),
        ),
      );
    }
    return wrap;
  }

  host.register("thesaurus", { title: "Thesaurus", render });
  return {
    open(word = env.selectedWord()) {
      host.open("thesaurus");
      state.source = word || null;
      if (word) lookUp(word);
    },
    lookUp,
    state,
  };
}
