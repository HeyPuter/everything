// Outline View: the slide pane becomes the deck's outline, each slide's
// title beside its number and icon, its body's paragraphs indented by level
// under it. Typing edits the slides as the outline is written; Enter starts
// a paragraph (or, in a title, a new slide), Tab and Shift+Tab move a line
// down or up a level, and a slide folds away to its title. Each burst of
// typing and each structural change is one undo step.
import { el, icon, openMenu, IS_MAC } from "../ui.js";
import {
  readOutline,
  rowsFromOutline,
  structureFromRows,
  applyOutline,
  splitRow,
  demoteRow,
  promoteRow,
  mergeWithPrevious,
} from "./outline-model.js";

const TYPING_PAUSE = 500;

export function createOutlineView(ctx) {
  const { P } = ctx;
  let pane = null;
  let rows = [];
  let collapsed = new Set();
  let dirty = false;
  let typing = false;
  let inflight = 0;
  let titleHints = new Map();
  let timer = null;
  let committing = Promise.resolve();
  // The deck's outline as the rows were last read from or written to it.
  let base = null;
  const pres = () => ctx.doc().pres;
  // The deck's outline, read again only when a slide changed: choosing a
  // slide redraws the editor without changing any.
  let cached = { xml: [], outline: null };
  function outlineOfDeck() {
    const xml = P.getSlides(pres()).map(
      (s) => P.getSlidePartName(s) + "\u0000" + P.getSlideXmlString(s),
    );
    if (
      cached.outline &&
      xml.length === cached.xml.length &&
      xml.every((x, i) => x === cached.xml[i])
    )
      return cached.outline;
    cached = { xml, outline: readOutline(pres()) };
    return cached.outline;
  }
  const plaintext = (() => {
    const probe = document.createElement("div");
    try {
      probe.contentEditable = "plaintext-only";
    } catch {}
    return probe.contentEditable === "plaintext-only";
  })();

  function enter() {
    collapsed = new Set(ctx.settings().outlineCollapsed || []);
    const sidebar = document.querySelector("#slide-navigator");
    pane =
      sidebar.querySelector("#outline-pane") ||
      el("div", {
        id: "outline-pane",
        class: "outline-pane",
        role: "tree",
        "aria-label": "Outline",
        onkeydown: keydown,
        oninput: input,
        onfocusin: focusin,
        onfocusout: (e) => {
          if (!pane.contains(e.relatedTarget)) commitNow();
        },
        onpaste: paste,
      });
    if (!pane.isConnected)
      sidebar.insertBefore(pane, sidebar.querySelector("#slide-list"));
    load();
    render();
  }
  function leave() {
    commitNow();
    pane?.remove();
    pane = null;
  }
  function load() {
    base = outlineOfDeck();
    rows = rowsFromOutline(base);
  }

  // The slide each row belongs to: the index of its title row.
  const slideIndexOf = (i) => {
    let n = -1;
    for (let k = 0; k <= i; k++) if (rows[k].level === 0) n++;
    return n;
  };
  const titleRowOf = (i) => {
    let k = i;
    while (k > 0 && rows[k].level !== 0) k--;
    return k;
  };
  const isFolded = (i) => {
    const t = titleRowOf(i);
    return t !== i && rows[t].part && collapsed.has(rows[t].part);
  };

  function render(focus = null) {
    if (!pane) return;
    const slides = new Map(outlineOfDeck().map((s) => [s.part, s]));
    const hidden = new Map([...slides].map(([part, s]) => [part, s.hidden]));
    // A slide without a title placeholder gets one when a title is typed.
    titleHints = new Map(
      [...slides].map(([part, s]) => [
        part,
        s.hasTitle ? "Slide title" : "Add a title",
      ]),
    );
    const current = P.getSlidePartName(ctx.currentSlide());
    const nodes = [];
    let slideNode = null;
    let group = null;
    rows.forEach((row, i) => {
      if (row.level === 0) {
        const n = slideIndexOf(i) + 1;
        const folded = !!row.part && collapsed.has(row.part);
        const hasBody = rows[i + 1] && rows[i + 1].level > 0;
        group = el("div", { role: "group" });
        slideNode = el(
          "div",
          {
            class: `outline-slide ${row.part === current ? "current" : ""} ${row.part && hidden.get(row.part) ? "hidden-slide" : ""}`,
            role: "treeitem",
            "aria-level": "1",
            "aria-expanded": hasBody ? String(!folded) : null,
            "data-part": row.part || "",
          },
          el(
            "div",
            { class: "outline-row outline-title", "data-row": String(i) },
            el("span", { class: "outline-number" }, String(n)),
            el(
              "button",
              {
                type: "button",
                class: "outline-icon",
                tabindex: -1,
                "aria-label": `Slide ${n}${folded ? ", collapsed" : ""}`,
                title: "Double-click to collapse or expand",
                onclick: () => row.part && ctx.choose(row.part, []),
                ondblclick: () => toggle(row.part),
                oncontextmenu: (e) => {
                  e.preventDefault();
                  slideMenu(e, i);
                },
              },
              icon("o:normalViewSmall", 14),
            ),
            editable(row, i, `Slide ${n} title`),
          ),
          folded ? null : group,
        );
        nodes.push(slideNode);
        return;
      }
      if (isFolded(i)) return;
      group?.append(
        el(
          "div",
          {
            class: "outline-row outline-body",
            role: "treeitem",
            "aria-level": String(row.level + 1),
            "data-row": String(i),
            "data-level": String(row.level),
            style: `--outline-level:${row.level}`,
          },
          editable(
            row,
            i,
            `Slide ${slideIndexOf(i) + 1}, level ${row.level} text`,
          ),
        ),
      );
    });
    pane.replaceChildren(...nodes);
    if (focus) place(focus.row, focus.offset);
  }
  function editable(row, i, label) {
    return el(
      "div",
      {
        class: "outline-text",
        contenteditable: plaintext ? "plaintext-only" : "true",
        role: "textbox",
        "aria-multiline": "false",
        "aria-label": label,
        spellcheck: "true",
        "data-row": String(i),
        "data-placeholder":
          row.level === 0 ? titleHints.get(row.part) || "Slide title" : "",
      },
      row.text,
    );
  }

  // The caret, as a row and an offset into its text.
  function caret() {
    const sel = getSelection();
    if (!sel?.rangeCount) return null;
    const node = sel.anchorNode;
    const box = (node?.nodeType === 1 ? node : node?.parentElement)?.closest(
      ".outline-text",
    );
    if (!box || !pane?.contains(box)) return null;
    const range = sel.getRangeAt(0);
    const before = document.createRange();
    before.selectNodeContents(box);
    before.setEnd(range.startContainer, range.startOffset);
    const start = before.toString().length;
    return {
      row: Number(box.dataset.row),
      offset: start,
      end: start + range.toString().length,
      box,
    };
  }
  function place(rowIndex, offset) {
    const box = pane?.querySelector(`.outline-text[data-row="${rowIndex}"]`);
    if (!box) return;
    box.focus({ preventScroll: true });
    const text = box.firstChild;
    const range = document.createRange();
    if (text && text.nodeType === 3) {
      range.setStart(text, Math.min(offset, text.length));
    } else range.setStart(box, 0);
    range.collapse(true);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    box.scrollIntoView({ block: "nearest" });
  }
  const textOf = (box) => box.innerText.replace(/\n$/, "");

  function input(e) {
    const box = e.target.closest?.(".outline-text");
    if (!box) return;
    const i = Number(box.dataset.row);
    if (!rows[i]) return;
    rows[i].text = textOf(box);
    dirty = true;
    clearTimeout(timer);
    typing = true;
    timer = setTimeout(commitNow, TYPING_PAUSE);
  }
  function paste(e) {
    // Pasted text arrives as plain text; its lines become paragraphs at
    // the level of the line pasted into.
    const box = e.target.closest?.(".outline-text");
    const text = e.clipboardData?.getData("text/plain");
    if (!box || text == null) return;
    e.preventDefault();
    const at = caret();
    if (!at) return;
    const row = rows[at.row];
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    const head = row.text.slice(0, at.offset);
    const tail = row.text.slice(at.end);
    const next = rows.map((r) => ({ ...r }));
    next[at.row].text = head + lines[0];
    const extra = lines.slice(1).map((line) => ({
      level: row.level || 1,
      text: line,
    }));
    if (extra.length) extra.at(-1).text += tail;
    else next[at.row].text += tail;
    next.splice(at.row + 1, 0, ...extra);
    // Lines pasted into a folded slide show, as typing would.
    if (extra.length && isFolded(at.row + 1))
      toggle(rows[titleRowOf(at.row + 1)].part);
    const last = at.row + extra.length;
    structural(next, {
      row: last,
      offset:
        (extra.length ? extra.at(-1).text : next[at.row].text).length -
        tail.length,
    });
  }
  function focusin(e) {
    const box = e.target.closest?.(".outline-text");
    if (!box) return;
    const t = titleRowOf(Number(box.dataset.row));
    const part = rows[t]?.part;
    if (part && part !== P.getSlidePartName(ctx.currentSlide()))
      ctx.choose(part, [], { keepFocus: true });
  }

  function keydown(e) {
    if (e.isComposing) return;
    const mod = e.ctrlKey || e.metaKey;
    const at = caret();
    if (!at) return;
    // Undo and redo reach the presentation, not the browser's own history
    // of the line.
    if (mod && !e.altKey && ["z", "y"].includes(e.key.toLowerCase())) {
      e.preventDefault();
      e.stopPropagation();
      commitNow().then(() =>
        e.key.toLowerCase() === "y" || e.shiftKey ? ctx.redo() : ctx.undo(),
      );
      return;
    }
    if (mod) return;
    const collapsedSel = at.offset === at.end;
    if (e.key === "Enter" && e.shiftKey) {
      // A line break inside the paragraph.
      e.preventDefault();
      const row = rows[at.row];
      const next = rows.map((r) => ({ ...r }));
      next[at.row].text =
        row.text.slice(0, at.offset) + "\n" + row.text.slice(at.end);
      structural(next, { row: at.row, offset: at.offset + 1 });
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const trimmed = rows.map((r) => ({ ...r }));
      trimmed[at.row].text =
        rows[at.row].text.slice(0, at.offset) + rows[at.row].text.slice(at.end);
      // Enter in a folded title opens a slide after the folded body.
      const result = splitRow(trimmed, at.row, at.offset);
      structural(result.rows, result.focus);
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      const result = e.shiftKey
        ? promoteRow(rows, at.row, at.offset)
        : demoteRow(rows, at.row, at.offset);
      if (result) structural(result.rows, result.focus);
      return;
    }
    if (e.key === "Backspace" && collapsedSel && at.offset === 0) {
      const row = rows[at.row];
      // A deeper paragraph steps up a level before it joins the one above.
      if (row.level > 1) {
        e.preventDefault();
        const result = promoteRow(rows, at.row, 0);
        if (result) structural(result.rows, result.focus);
        return;
      }
      const result = mergeWithPrevious(rows, at.row);
      if (!result) return;
      e.preventDefault();
      if (isFolded(at.row - 1)) toggle(rows[titleRowOf(at.row - 1)].part);
      structural(result.rows, result.focus);
      return;
    }
    if (
      e.key === "Delete" &&
      collapsedSel &&
      at.offset === rows[at.row].text.length &&
      rows[at.row + 1]
    ) {
      e.preventDefault();
      const result = mergeWithPrevious(rows, at.row + 1);
      if (isFolded(at.row + 1)) toggle(rows[titleRowOf(at.row + 1)].part);
      structural(result.rows, result.focus);
      return;
    }
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      const up = e.key === "ArrowUp";
      if (!atEdgeLine(at.box, up)) return;
      const boxes = [...pane.querySelectorAll(".outline-text")];
      const k = boxes.indexOf(at.box) + (up ? -1 : 1);
      if (!boxes[k]) return;
      e.preventDefault();
      place(Number(boxes[k].dataset.row), up ? Infinity : 0);
      return;
    }
    if (e.altKey && e.shiftKey && (e.key === "-" || e.key === "_")) {
      e.preventDefault();
      const part = rows[titleRowOf(at.row)].part;
      if (part && !collapsed.has(part)) toggle(part, at.row);
    }
    if (e.altKey && e.shiftKey && (e.key === "+" || e.key === "=")) {
      e.preventDefault();
      const part = rows[titleRowOf(at.row)].part;
      if (part && collapsed.has(part)) toggle(part, at.row);
    }
  }
  // Whether the caret is on the first (or last) line of its box.
  function atEdgeLine(box, up) {
    const sel = getSelection();
    if (!sel.rangeCount) return true;
    const rects = sel.getRangeAt(0).getClientRects();
    const r = rects[0] || box.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    const line = parseFloat(getComputedStyle(box).lineHeight) || 18;
    return up ? r.top - b.top < line * 0.8 : b.bottom - r.bottom < line * 0.8;
  }

  // A change to the outline's structure: shown at once, and written to the
  // slides as its own step.
  function structural(next, focus) {
    // Typing not yet saved goes first, as its own step.
    if (dirty && typing) commitNow();
    clearTimeout(timer);
    rows = next;
    dirty = true;
    render(focus);
    commitNow();
  }
  // Typing that follows typing joins its undo step; a change to the
  // outline's structure is a step of its own.
  function commitNow() {
    clearTimeout(timer);
    if (!dirty || !pane) return committing;
    dirty = false;
    const coalesce = typing ? "outline-typing" : null;
    typing = false;
    const structure = structureFromRows(rows);
    inflight++;
    committing = ctx
      .mutate(
        () => {
          const { changed } = applyOutline(pres(), structure, { base });
          if (!changed) return ctx.SKIP;
          base = outlineOfDeck();
          // The slide being written in stays current.
          const at = caret();
          const t = at ? titleRowOf(at.row) : 0;
          const n = rows.slice(0, t + 1).filter((r) => r.level === 0).length;
          ctx.settleIndex(Math.max(0, n - 1));
        },
        { coalesce },
      )
      .finally(() => inflight--)
      .then(() => undefined);
    return committing;
  }

  // The deck changed (an edit here, elsewhere, undo or redo): the outline
  // reads it again unless typing here is still to be saved.
  function refresh() {
    if (!pane) return;
    // Typing still to be saved, or a later save of the outline already on
    // its way, is newer than the deck shown.
    if (dirty || inflight > 1) return;
    // A save on its way sets the base itself once it is written.
    if (!inflight) base = outlineOfDeck();
    const next = rowsFromOutline(outlineOfDeck());
    // The deck reads a body holding one empty paragraph as no body; the
    // empty line just started here is kept.
    const local = rows.filter(
      (r, i) =>
        !(
          r.level > 0 &&
          !r.text &&
          rows[i - 1]?.level === 0 &&
          (!rows[i + 1] || rows[i + 1].level === 0)
        ),
    );
    const same =
      next.length === local.length &&
      next.every(
        (r, i) =>
          r.level === local[i].level &&
          r.text === local[i].text &&
          (r.level !== 0 || !local[i].part || r.part === local[i].part),
      );
    // Slides just made take their part names.
    if (same) {
      const titles = next.filter((r) => r.level === 0);
      rows
        .filter((r) => r.level === 0)
        .forEach((r, i) => {
          if (!r.part && titles[i]) r.part = titles[i].part;
        });
    }
    const at = caret();
    if (!same) {
      rows = next;
      render(
        at
          ? { row: Math.min(at.row, rows.length - 1), offset: at.offset }
          : null,
      );
    } else {
      const current = P.getSlidePartName(ctx.currentSlide());
      const nodes = pane.querySelectorAll(".outline-slide");
      rows
        .filter((r) => r.level === 0)
        .forEach((r, i) => {
          if (nodes[i] && r.part) nodes[i].dataset.part = r.part;
        });
      for (const node of nodes)
        node.classList.toggle("current", node.dataset.part === current);
    }
    pane
      .querySelector(".outline-slide.current")
      ?.scrollIntoView({ block: "nearest" });
  }

  function toggle(part, focusRow = null) {
    if (!part) return;
    commitNow();
    if (collapsed.has(part)) collapsed.delete(part);
    else collapsed.add(part);
    ctx.saveSettings({ outlineCollapsed: [...collapsed] });
    const t = rows.findIndex((r) => r.level === 0 && r.part === part);
    render({
      row: focusRow != null && !isFolded(focusRow) ? focusRow : t,
      offset: 0,
    });
  }
  function setAll(on) {
    collapsed = new Set(
      on ? rows.filter((r) => r.part).map((r) => r.part) : [],
    );
    ctx.saveSettings({ outlineCollapsed: [...collapsed] });
    render();
  }
  function slideMenu(e, i) {
    const part = rows[i].part;
    const s = P.getSlides(pres()).find((x) => P.getSlidePartName(x) === part);
    openMenu({
      x: e.clientX,
      y: e.clientY,
      contextual: true,
      label: "Outline",
      items: [
        {
          label: collapsed.has(part) ? "Expand" : "Collapse",
          icon: collapsed.has(part) ? "ChevronDown" : "ChevronUp",
          shortcut: IS_MAC ? "⌥⇧+" : "Alt+Shift+",
          onSelect: () => toggle(part),
        },
        {
          label: "Collapse All",
          icon: "ChevronUp",
          onSelect: () => setAll(true),
        },
        {
          label: "Expand All",
          icon: "ChevronDown",
          onSelect: () => setAll(false),
        },
        { separator: true },
        {
          label: "New Slide",
          icon: "o:newSlide",
          disabled: !s,
          onSelect: () => ctx.addSlideAfter(s),
        },
        {
          label: "Delete Slide",
          icon: "Trash2",
          danger: true,
          disabled: !s,
          onSelect: () => ctx.deleteSlides([s]),
        },
      ],
    });
  }
  function focus() {
    const t = rows.findIndex(
      (r) => r.level === 0 && r.part === P.getSlidePartName(ctx.currentSlide()),
    );
    place(Math.max(0, t), 0);
  }

  return { enter, leave, refresh, focus, commit: commitNow };
}
