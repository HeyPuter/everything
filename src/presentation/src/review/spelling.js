// The Spelling pane: walks the deck's text from the current slide on (the
// runs of every text box and shape, table cells, and speaker notes), stops
// at each word the dictionary does not know, and offers Ignore, Ignore All,
// Add to Dictionary, Change and Change All. A change edits the run the word
// is in, so its formatting stays.
import { el, icon } from "../ui.js";
import { P, visibleSlideShapes } from "../model.js";
import { checkableWords, loadSpeller } from "./speller.js";

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wholeWord = (word) =>
  new RegExp(`(?<![\\p{L}\\p{N}'’])${escapeRe(word)}(?![\\p{L}\\p{N}])`, "gu");
const english = (lang) => !lang || /^en(-|$)/i.test(lang);

export function createSpelling(env, host) {
  const state = {
    speller: null,
    error: null,
    issue: null,
    suggestions: [],
    chosen: 0,
    // Words skipped once, by place; words skipped everywhere this session.
    ignoredOnce: new Set(),
    ignoredAll: new Set(),
    done: false,
    // Where the walk started, so it can say when it has gone all the way
    // round.
    startPart: null,
    skippedOther: false,
  };

  // Every piece of text of the deck, slide by slide from `from`.
  function* units(from) {
    const all = P.getSlides(env.pres());
    for (let k = 0; k < all.length; k++) {
      const i = (from + k) % all.length;
      const slide = all[i];
      const part = P.getSlidePartName(slide);
      for (const shape of visibleSlideShapes(slide)) {
        const id = P.getShapeId(shape);
        if (env.isTable(shape)) {
          let cells = [];
          try {
            cells = P.getTableCells(shape);
          } catch {}
          for (const row of cells)
            for (const cell of row) {
              const { row: r, col: c } = P.getTableCellPosition(cell);
              yield {
                kind: "cell",
                index: i,
                slide,
                part,
                id,
                row: r,
                col: c,
                text: P.getTableCellText(cell) || "",
              };
            }
          continue;
        }
        let paragraphs = 0;
        try {
          paragraphs = P.getShapeParagraphCount(shape);
        } catch {}
        for (let p = 0; p < paragraphs; p++)
          for (let r = 0; r < P.getShapeRunCount(shape, p); r++) {
            let lang = null;
            try {
              lang = P.getShapeRunFormatEffective(
                env.pres(),
                shape,
                p,
                r,
              )?.language;
            } catch {}
            yield {
              kind: "run",
              index: i,
              slide,
              part,
              id,
              p,
              r,
              lang,
              text: P.getShapeRunText(shape, p, r) || "",
            };
          }
      }
      const notes = P.getSlideNotes(slide);
      if (notes) yield { kind: "notes", index: i, slide, part, text: notes };
    }
  }
  const unitKey = (u) =>
    [u.part, u.kind, u.id ?? "", u.p ?? u.row ?? "", u.r ?? u.col ?? ""].join(
      ":",
    );

  function findNext(from = env.index()) {
    state.skippedOther = false;
    for (const u of units(from)) {
      if (u.kind === "run" && !english(u.lang)) {
        state.skippedOther = true;
        continue;
      }
      for (const w of checkableWords(u.text)) {
        if (state.ignoredAll.has(w.word.toLowerCase())) continue;
        if (state.ignoredOnce.has(`${unitKey(u)}:${w.start}:${w.word}`))
          continue;
        if (state.speller.correct(w.word)) continue;
        return { unit: u, ...w };
      }
    }
    return null;
  }

  async function check({ from } = {}) {
    if (!env.pres()) return;
    state.error = null;
    if (!state.speller) {
      host.refresh("spelling");
      try {
        state.speller = await loadSpeller();
      } catch (e) {
        state.error = e.message || "The dictionary could not be loaded.";
        host.refresh("spelling");
        return;
      }
    }
    await env.settled?.();
    state.issue = findNext(from);
    state.done = !state.issue;
    state.suggestions = state.issue
      ? state.speller.suggest(state.issue.word)
      : [];
    state.chosen = 0;
    host.refresh("spelling");
    if (state.issue) await show(state.issue);
    host.el
      .querySelector(
        ".spell-suggestions [aria-selected=true], .spell-actions button",
      )
      ?.focus({ preventScroll: true });
  }

  async function show(issue) {
    const u = issue.unit;
    if (P.getSlidePartName(env.slide()) !== u.part)
      await env.chooseSlide(u.slide);
    if (u.id != null) env.showObjects(u.part, [u.id]);
  }

  // Replaces the issue's word in its own piece of text.
  function changeOne(issue, replacement) {
    const u = issue.unit;
    return env.mutateSlide(u.slide, (slide) => {
      if (u.kind === "notes") {
        const text = P.getSlideNotes(slide) || "";
        if (
          text.slice(issue.start, issue.end) !==
          u.text.slice(issue.start, issue.end)
        )
          return env.SKIP;
        P.setSlideNotes(
          slide,
          text.slice(0, issue.start) + replacement + text.slice(issue.end),
        );
        return;
      }
      const shape = P.findShapeById(slide, u.id);
      if (!shape) return env.SKIP;
      if (u.kind === "cell") {
        const cell = P.getTableCell(shape, u.row, u.col);
        const text = P.getTableCellText(cell) || "";
        const before = [
          ...text.slice(0, issue.start).matchAll(wholeWord(issue.word)),
        ].length;
        return env.replaceInCell(
          cell,
          wholeWord(issue.word),
          replacement,
          before,
        )
          ? undefined
          : env.SKIP;
      }
      const text = P.getShapeRunText(shape, u.p, u.r) || "";
      const original = u.text.slice(issue.start, issue.end);
      if (text.slice(issue.start, issue.end) !== original) return env.SKIP;
      P.setShapeRunText(
        shape,
        u.p,
        u.r,
        text.slice(0, issue.start) + replacement + text.slice(issue.end),
      );
    });
  }
  // Every whole-word occurrence, everywhere.
  function changeAll(word, replacement) {
    const re = wholeWord(word);
    return env.mutate(() => {
      let changed = false;
      for (const slide of P.getSlides(env.pres())) {
        for (const shape of visibleSlideShapes(slide)) {
          if (env.isTable(shape)) {
            let cells = [];
            try {
              cells = P.getTableCells(shape);
            } catch {}
            for (const row of cells)
              for (const cell of row)
                if (env.replaceInCell(cell, re, replacement)) changed = true;
            continue;
          }
          try {
            if (
              P.getShapeParagraphCount(shape) &&
              env.replaceInShape(shape, re, replacement)
            )
              changed = true;
          } catch {}
        }
        const notes = P.getSlideNotes(slide);
        if (notes && re.test(notes)) {
          re.lastIndex = 0;
          P.setSlideNotes(slide, notes.replace(re, replacement));
          changed = true;
        }
        re.lastIndex = 0;
      }
      if (!changed) return env.SKIP;
    });
  }

  const replacement = () => state.suggestions[state.chosen];
  const actions = {
    ignore: () => {
      const i = state.issue;
      if (!i) return;
      state.ignoredOnce.add(`${unitKey(i.unit)}:${i.start}:${i.word}`);
      check({ from: i.unit.index });
    },
    ignoreAll: () => {
      const i = state.issue;
      if (!i) return;
      state.ignoredAll.add(i.word.toLowerCase());
      check({ from: i.unit.index });
    },
    add: () => {
      const i = state.issue;
      if (!i) return;
      state.speller.add(i.word);
      check({ from: i.unit.index });
    },
    change: async () => {
      const i = state.issue;
      const to = replacement();
      if (!i || !to) return;
      if (env.blocksEdits()) return env.blockedEdit();
      await changeOne(i, to);
      check({ from: i.unit.index });
    },
    changeAll: async () => {
      const i = state.issue;
      const to = replacement();
      if (!i || !to) return;
      if (env.blocksEdits()) return env.blockedEdit();
      await changeAll(i.word, to);
      check({ from: i.unit.index });
    },
  };

  function render() {
    const wrap = el("div", { class: "spelling-pane" });
    if (state.error) {
      wrap.append(
        el("p", { class: "review-error", role: "alert" }, state.error),
        el(
          "button",
          { type: "button", class: "btn secondary", onclick: () => check() },
          "Try Again",
        ),
      );
      return wrap;
    }
    if (!state.speller) {
      wrap.append(
        el(
          "p",
          { class: "review-status", role: "status" },
          "Loading the dictionary…",
        ),
      );
      return wrap;
    }
    if (state.done || !state.issue) {
      wrap.append(
        el(
          "div",
          { class: "review-empty", role: "status" },
          icon("o:spelling", 32),
          el("p", {}, "Spelling check complete. No more words to review."),
          state.skippedOther &&
            el(
              "p",
              { class: "helper" },
              "Text marked as another language was skipped: the dictionary here is English (United States).",
            ),
          el(
            "button",
            {
              type: "button",
              class: "btn secondary",
              onclick: () => {
                state.ignoredOnce.clear();
                check({ from: 0 });
              },
            },
            "Check Again",
          ),
        ),
      );
      return wrap;
    }
    const i = state.issue;
    const text = i.unit.text;
    const from = Math.max(0, i.start - 40);
    const to = Math.min(text.length, i.end + 40);
    const where =
      i.unit.kind === "notes"
        ? `Speaker notes, slide ${i.unit.index + 1}`
        : `Slide ${i.unit.index + 1}`;
    const list = el("div", {
      class: "spell-suggestions",
      role: "listbox",
      "aria-label": "Suggestions",
      tabindex: state.suggestions.length ? null : 0,
      onkeydown: (e) => {
        const n = state.suggestions.length;
        if (!n) return;
        if (["ArrowDown", "ArrowUp"].includes(e.key)) {
          e.preventDefault();
          state.chosen =
            (state.chosen + (e.key === "ArrowDown" ? 1 : -1) + n) % n;
          host.refresh("spelling");
          host.el
            .querySelector(".spell-suggestions [aria-selected=true]")
            ?.focus();
        } else if (e.key === "Enter") {
          e.preventDefault();
          actions.change();
        }
      },
    });
    if (!state.suggestions.length)
      list.append(el("p", { class: "helper" }, "No suggestions."));
    state.suggestions.forEach((s, k) =>
      list.append(
        el(
          "div",
          {
            role: "option",
            class: "spell-option",
            "aria-selected": String(k === state.chosen),
            tabindex: k === state.chosen ? 0 : -1,
            "data-focus-key": k === state.chosen ? "spell-chosen" : null,
            onclick: () => {
              state.chosen = k;
              host.refresh("spelling");
            },
            ondblclick: () => {
              state.chosen = k;
              actions.change();
            },
          },
          s,
        ),
      ),
    );
    const btn = (label, run, attrs = {}) =>
      el(
        "button",
        {
          type: "button",
          class: "btn secondary small",
          onclick: run,
          ...attrs,
        },
        label,
      );
    wrap.append(
      el("p", { class: "review-label" }, "Not in dictionary"),
      el("p", { class: "spell-word", "aria-live": "polite" }, i.word),
      el(
        "p",
        { class: "spell-context" },
        from > 0 ? "…" : "",
        text.slice(from, i.start),
        el("mark", {}, text.slice(i.start, i.end)),
        text.slice(i.end, to),
        to < text.length ? "…" : "",
      ),
      el("p", { class: "helper" }, where),
      el(
        "div",
        { class: "spell-actions" },
        btn("Ignore", actions.ignore),
        btn("Ignore All", actions.ignoreAll),
        btn("Add to Dictionary", actions.add),
      ),
      el("p", { class: "review-label" }, "Suggestions"),
      list,
      el(
        "div",
        { class: "spell-actions" },
        btn("Change", actions.change, {
          class: "btn primary small",
          disabled: !state.suggestions.length || null,
        }),
        btn("Change All", actions.changeAll, {
          disabled: !state.suggestions.length || null,
        }),
      ),
      el(
        "p",
        { class: "spell-language helper" },
        icon("o:language", 14),
        "Dictionary: English (United States)",
      ),
    );
    return wrap;
  }

  host.register("spelling", { title: "Spelling", render });
  return {
    open: () => {
      host.open("spelling");
      check();
    },
    // The checker without the pane, for tests and the status of the pane.
    state,
  };
}
