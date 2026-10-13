// The Translate pane: the selected text, or every text on the slide,
// translated by Puter's AI into the language chosen. Insert puts the
// translation in place of the selection, or of each object's text for the
// whole slide (marking it with the new language for proofing).
import { el, icon, toast } from "../ui.js";
import { aiAvailable, askJson } from "./ai.js";

export const TRANSLATE_LANGUAGES = [
  ["ar-SA", "Arabic"],
  ["zh-CN", "Chinese (Simplified)"],
  ["zh-TW", "Chinese (Traditional)"],
  ["cs-CZ", "Czech"],
  ["da-DK", "Danish"],
  ["nl-NL", "Dutch"],
  ["en-US", "English"],
  ["fi-FI", "Finnish"],
  ["fr-FR", "French"],
  ["de-DE", "German"],
  ["el-GR", "Greek"],
  ["he-IL", "Hebrew"],
  ["hi-IN", "Hindi"],
  ["hu-HU", "Hungarian"],
  ["id-ID", "Indonesian"],
  ["it-IT", "Italian"],
  ["ja-JP", "Japanese"],
  ["ko-KR", "Korean"],
  ["nb-NO", "Norwegian"],
  ["fa-IR", "Persian"],
  ["pl-PL", "Polish"],
  ["pt-BR", "Portuguese (Brazil)"],
  ["pt-PT", "Portuguese (Portugal)"],
  ["ro-RO", "Romanian"],
  ["ru-RU", "Russian"],
  ["es-ES", "Spanish"],
  ["sv-SE", "Swedish"],
  ["th-TH", "Thai"],
  ["tr-TR", "Turkish"],
  ["uk-UA", "Ukrainian"],
  ["vi-VN", "Vietnamese"],
];
const PREF = "presentation:translate-to";

const SYSTEM =
  "You translate presentation text. Answer only with JSON of the form " +
  '{"detected": string, "translations": string[]} where "detected" is the English name of the source language and "translations" has one entry per input string, in order. ' +
  "Keep line breaks, list structure, numbers, names and placeholders like {0} as they are. Do not add explanations.";

export function createTranslate(env, host) {
  let to = "fr-FR";
  try {
    const saved = localStorage.getItem(PREF);
    if (TRANSLATE_LANGUAGES.some(([c]) => c === saved)) to = saved;
  } catch {}
  const state = {
    scope: "selection",
    items: [],
    result: null,
    detected: "",
    loading: false,
    error: null,
    request: 0,
  };

  // What would be translated: [{ part, id, text, kind }].
  const gather = () =>
    state.scope === "slide" ? env.slideTexts() : env.selectionTexts();

  async function translate() {
    const items = gather().filter((i) => i.text.trim());
    state.items = items;
    state.result = null;
    state.error = null;
    if (!items.length) {
      state.error =
        state.scope === "slide"
          ? "This slide has no text to translate."
          : "Select some text, or an object with text, to translate.";
      host.refresh("translate");
      return;
    }
    if (!aiAvailable()) {
      state.error =
        "Translation needs Puter's AI, which is not available here.";
      host.refresh("translate");
      return;
    }
    const request = ++state.request;
    state.loading = true;
    host.refresh("translate");
    const name = TRANSLATE_LANGUAGES.find(([c]) => c === to)?.[1] || to;
    try {
      const data = await askJson(
        SYSTEM,
        `Translate into ${name}.\n${JSON.stringify(items.map((i) => i.text))}`,
        { maxTokens: 4000 },
      );
      if (request !== state.request) return;
      const list = Array.isArray(data?.translations) ? data.translations : [];
      if (
        list.length !== items.length ||
        list.some((t) => typeof t !== "string")
      )
        throw new Error("The translation came back incomplete. Try again.");
      state.result = list;
      state.detected = typeof data.detected === "string" ? data.detected : "";
    } catch (e) {
      if (request !== state.request) return;
      state.error = e.message || "The translation failed.";
    }
    state.loading = false;
    host.refresh("translate");
  }

  async function insert() {
    if (!state.result) return;
    if (env.blocksEdits()) return env.blockedEdit();
    const ok = await env.replaceTexts(
      state.items.map((item, i) => ({ ...item, text: state.result[i] })),
      to,
    );
    if (ok) toast("Translation inserted.");
  }
  async function copy() {
    if (!state.result) return;
    try {
      await navigator.clipboard.writeText(state.result.join("\n\n"));
      toast("Translation copied.");
    } catch {
      toast("The translation could not be copied.");
    }
  }

  function render() {
    const wrap = el("div", { class: "translate-pane" });
    const select = el(
      "select",
      {
        class: "input",
        "aria-label": "Translate to",
        "data-focus-key": "translate-to",
        onchange: (e) => {
          to = e.target.value;
          try {
            localStorage.setItem(PREF, to);
          } catch {}
          state.result = null;
          host.refresh("translate");
        },
      },
      TRANSLATE_LANGUAGES.map(([code, name]) =>
        el("option", { value: code, selected: code === to || null }, name),
      ),
    );
    select.value = to;
    const scope = (value, label) =>
      el(
        "label",
        { class: "check-field" },
        el("input", {
          type: "radio",
          name: "translate-scope",
          value,
          checked: state.scope === value,
          onchange: () => {
            state.scope = value;
            state.result = null;
            host.refresh("translate");
          },
        }),
        el("span", {}, label),
      );
    wrap.append(
      el(
        "label",
        { class: "review-field" },
        el("span", { class: "review-label" }, "From"),
        el(
          "span",
          {},
          state.detected ? `${state.detected} (detected)` : "Detect language",
        ),
      ),
      el(
        "label",
        { class: "review-field" },
        el("span", { class: "review-label" }, "To"),
        select,
      ),
      el(
        "fieldset",
        { class: "review-choices" },
        el("legend", { class: "review-label" }, "Translate"),
        scope("selection", "Selected text"),
        scope("slide", "All text on this slide"),
      ),
      el(
        "button",
        {
          type: "button",
          class: "btn primary",
          "data-autofocus": "",
          disabled: state.loading || null,
          onclick: translate,
        },
        icon("o:translate", 16),
        el("span", {}, state.loading ? "Translating…" : "Translate"),
      ),
    );
    if (state.error)
      wrap.append(
        el("p", { class: "review-status", role: "status" }, state.error),
      );
    if (state.result) {
      const out = el("div", {
        class: "translate-results",
        "aria-live": "polite",
      });
      state.items.forEach((item, i) =>
        out.append(
          el(
            "div",
            { class: "translate-item" },
            state.items.length > 1 &&
              el("p", { class: "review-label" }, item.label || `Text ${i + 1}`),
            el("p", { class: "translate-source", lang: "" }, item.text),
            el("p", { class: "translate-target", lang: to }, state.result[i]),
          ),
        ),
      );
      wrap.append(
        out,
        el(
          "div",
          { class: "review-footer" },
          el(
            "button",
            { type: "button", class: "btn secondary small", onclick: copy },
            "Copy",
          ),
          el(
            "button",
            { type: "button", class: "btn primary small", onclick: insert },
            "Insert",
          ),
        ),
      );
    }
    return wrap;
  }

  host.register("translate", { title: "Translator", render });
  return {
    open() {
      state.scope = env.selectionTexts().some((i) => i.text.trim())
        ? "selection"
        : "slide";
      state.result = null;
      state.error = null;
      state.detected = "";
      host.open("translate");
    },
    state,
  };
}
