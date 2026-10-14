// The Format pane's frame: the same layout for every kind of object and for
// the slide background. Up to three top-level tabs (Shape Options, Text
// Options, ...) each hold a row of icon tabs (Fill & Line, Effects, Size &
// Properties, ...), and each icon tab holds collapsible sections whose open
// state is remembered. A search box above the tabs finds a setting in any
// tab. The chosen tabs are remembered for each kind of object, across
// sessions, so the pane opens where it was last used.
//
// A model describes what the frame shows:
//   { family,                   which remembered tabs apply ("shape", ...)
//     lead?: Node[],            shown above the tabs (a chart element picker)
//     tops: [{ id, label,
//              subs: [{ id, label, icon, build: () => Node[] }] }] }
// `build` returns sections (from `section()` in controls.js) and any other
// nodes. Every tab is built when the frame is made, so a setting can be found
// and revealed in a tab that is not showing, but only the chosen tab's nodes
// are in the document.
import { el, icon } from "../ui.js";
import { restoreSection, section } from "./controls.js";
import "./pane-icons.js";
import "./pane-frame.css";

const STORE = "presentation:format-pane";
let remembered = load();
let query = "";
// The frame on screen, for revealing a section from a menu command.
let current = null;
let uid = 0;

function load() {
  try {
    const value = JSON.parse(localStorage.getItem(STORE) || "{}");
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}
function save() {
  try {
    localStorage.setItem(STORE, JSON.stringify(remembered));
  } catch {}
}

/** The tab a family last showed, as [topId, subId]. */
function chosen(family) {
  const entry = remembered[family] || {};
  return [entry.top, entry.subs?.[entry.top]];
}
function remember(family, top, sub) {
  const entry = (remembered[family] ||= { subs: {} });
  entry.subs ||= {};
  entry.top = top;
  if (sub) entry.subs[top] = sub;
  save();
}

/** Picks a starting tab for a family that has none remembered yet. */
export function preferTab(family, top, sub) {
  if (!remembered[family]?.top) {
    remembered[family] = { top, subs: sub ? { [top]: sub } : {} };
  }
}

/**
 * Turns nodes laid out under h3 headings into collapsible sections, one per
 * heading. Nodes before the first heading are returned first, as they are.
 */
export function sectionsFromHeadings(nodes, prefix, { open = true } = {}) {
  const out = [];
  let title = null,
    body = [];
  const flush = () => {
    if (title == null) out.push(...body);
    else
      out.push(
        section(title, body, {
          key: `${prefix}:${title
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "")}`,
          open,
        }),
      );
    body = [];
  };
  for (const node of nodes.flat(Infinity)) {
    if (!node) continue;
    if (node.tagName === "H3") {
      flush();
      title = node.textContent;
    } else body.push(node);
  }
  flush();
  return out;
}

const sectionsIn = (nodes) =>
  nodes.filter((n) => n?.matches?.("details.fmt-section"));
const keysOf = (nodes) => sectionsIn(nodes).map((d) => d.dataset.section);

// The words a section can be found by: its title, and the labels, names and
// options of its controls.
function wordsOf(node) {
  const parts = [node.querySelector("summary")?.textContent || ""];
  for (const n of node.querySelectorAll(
    "label, .fmt-label, .field > span, button, [aria-label], [title]",
  ))
    parts.push(
      n.getAttribute("aria-label") || "",
      n.getAttribute("title") || "",
      n.matches("label, .fmt-label, .field > span, button")
        ? n.textContent
        : "",
    );
  return parts.join(" ").toLowerCase();
}

/** Builds the frame for a model. Returns the node to put in the panel. */
export function formatFrame(model) {
  const id = `fmt-frame-${++uid}`;
  const tops = model.tops.filter((t) => t.subs.length);
  // Build every tab now: the search and the menus' "Options…" items reach
  // settings in tabs that are not showing.
  for (const top of tops)
    for (const sub of top.subs) {
      sub.nodes = (sub.build() || []).flat(Infinity).filter(Boolean);
      sub.keys = keysOf(sub.nodes);
    }
  let [topId, subId] = chosen(model.family);
  let top = tops.find((t) => t.id === topId) || tops[0];
  let sub = top?.subs.find((s) => s.id === subId) || top?.subs[0];

  const root = el("div", {
    class: "inspector-content fmt-frame",
    "data-family": model.family,
  });
  if (!top) {
    root.append(...(model.lead || []));
    return root;
  }

  const search = el("input", {
    type: "search",
    class: "input fmt-search",
    placeholder: "Search options",
    "aria-label": "Search format options",
    autocomplete: "off",
    spellcheck: "false",
    value: query,
  });
  const topBar = el("div", {
    class: "fmt-top-tabs",
    role: "tablist",
    "aria-label": "Format options",
  });
  const subBar = el("div", { class: "fmt-sub-tabs", role: "tablist" });
  const caption = el("div", {
    class: "fmt-sub-caption",
    "aria-hidden": "true",
  });
  const panelNode = el("div", {
    class: "fmt-frame-panel",
    role: "tabpanel",
    id: `${id}-panel`,
    tabindex: -1,
  });
  const resultsNode = el("div", {
    class: "fmt-search-results",
    role: "region",
    "aria-label": "Search results",
  });
  const statusNode = el("p", {
    class: "fmt-search-status",
    role: "status",
    "aria-live": "polite",
  });

  const topButtons = tops.map((t) =>
    el(
      "button",
      {
        type: "button",
        role: "tab",
        id: `${id}-top-${t.id}`,
        class: "fmt-top-tab",
        "aria-controls": panelNode.id,
        "data-tab": t.id,
        "data-sections": t.subs.flatMap((s) => s.keys).join(" "),
        onclick: () => choose(t, null, { focus: "top" }),
      },
      t.label,
    ),
  );
  let subButtons = [];

  function paintSubBar() {
    subButtons = top.subs.map((s) =>
      el(
        "button",
        {
          type: "button",
          role: "tab",
          id: `${id}-sub-${top.id}-${s.id}`,
          class: "fmt-sub-tab",
          "aria-controls": panelNode.id,
          "aria-label": s.label,
          title: s.label,
          "data-tab": s.id,
          "data-sections": s.keys.join(" "),
          onclick: () => choose(top, s, { focus: "sub" }),
        },
        icon(s.icon || "o:formatPane", 20),
      ),
    );
    subBar.setAttribute("aria-label", top.label);
    subBar.replaceChildren(...subButtons);
    subBar.hidden = top.subs.length < 2;
    caption.hidden = top.subs.length < 2;
  }

  function paint() {
    for (const b of topButtons) {
      const on = b.dataset.tab === top.id;
      b.setAttribute("aria-selected", String(on));
      b.tabIndex = on ? 0 : -1;
    }
    for (const b of subButtons) {
      const on = b.dataset.tab === sub.id;
      b.setAttribute("aria-selected", String(on));
      b.tabIndex = on ? 0 : -1;
    }
    caption.textContent = sub.label;
    // A refresh around a control being used keeps that control's ancestors
    // (this frame's panel or results, from an earlier build) and moves the
    // rest of a new build in beside them: work on the ones on the page.
    const host = head.parentElement || root;
    const pick = (node, selector) =>
      host.querySelector(`:scope > ${selector}`) || node;
    const panel = pick(panelNode, ".fmt-frame-panel");
    const results = pick(resultsNode, ".fmt-search-results");
    const status = pick(statusNode, ".fmt-search-status");
    panel.id = panelNode.id;
    panel.setAttribute(
      "aria-labelledby",
      top.subs.length > 1
        ? `${id}-sub-${top.id}-${sub.id}`
        : `${id}-top-${top.id}`,
    );
    const q = query.trim().toLowerCase();
    host.classList.toggle("searching", !!q);
    if (!q) {
      results.replaceChildren();
      status.textContent = "";
      panel.hidden = false;
      results.hidden = true;
      for (const d of sectionsIn(sub.nodes)) restoreSection(d);
      panel.replaceChildren(...sub.nodes);
      return;
    }
    // Searching: every matching section of every tab, under its tab's name.
    panel.hidden = true;
    panel.replaceChildren();
    results.hidden = false;
    const seen = new Set();
    const groups = [];
    let count = 0;
    for (const t of tops)
      for (const s of t.subs) {
        const found = sectionsIn(s.nodes).filter((d) => {
          const key = d.dataset.section;
          if (seen.has(key) || !wordsOf(d).includes(q)) return false;
          seen.add(key);
          return true;
        });
        if (!found.length) continue;
        count += found.length;
        for (const d of found) d.open = true;
        groups.push(
          el(
            "div",
            { class: "fmt-search-group" },
            el(
              "div",
              { class: "fmt-search-where" },
              tops.length > 1 ? `${t.label} · ${s.label}` : s.label,
            ),
            ...found,
          ),
        );
      }
    status.textContent = count
      ? `${count} ${count === 1 ? "section" : "sections"} match`
      : "No settings match";
    results.replaceChildren(...groups);
  }

  function choose(t, s, { focus = null } = {}) {
    const topChanged = t !== top;
    top = t;
    if (s) sub = s;
    else {
      const saved = remembered[model.family]?.subs?.[top.id];
      sub = top.subs.find((x) => x.id === saved) || top.subs[0];
    }
    remember(model.family, top.id, sub.id);
    if (query) {
      query = "";
      search.value = "";
    }
    if (topChanged) paintSubBar();
    paint();
    if (focus === "top")
      topButtons.find((b) => b.dataset.tab === top.id)?.focus();
    if (focus === "sub")
      subButtons.find((b) => b.dataset.tab === sub.id)?.focus();
  }

  // Arrow keys move along a row of tabs and show the tab they land on.
  function arrows(e, buttons, pick) {
    const at = buttons.indexOf(document.activeElement);
    if (at < 0) return;
    const n = buttons.length;
    const next = {
      ArrowRight: (at + 1) % n,
      ArrowLeft: (at - 1 + n) % n,
      Home: 0,
      End: n - 1,
    }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    pick(next);
  }
  topBar.addEventListener("keydown", (e) =>
    arrows(e, topButtons, (i) => choose(tops[i], null, { focus: "top" })),
  );
  subBar.addEventListener("keydown", (e) =>
    arrows(e, subButtons, (i) => choose(top, top.subs[i], { focus: "sub" })),
  );
  // Ctrl+PageDown / PageUp step through the icon tabs from anywhere in the
  // pane, as tabbed dialogs do. The frame's heading on the page does it, as
  // it may be from a later build than this frame.
  root.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey && (e.key === "PageDown" || e.key === "PageUp"))) return;
    const live = e.currentTarget.querySelector(":scope > .fmt-frame-head");
    if (!live?.stepTab) return;
    e.preventDefault();
    live.stepTab(e.key === "PageDown" ? 1 : -1);
  });
  function stepTab(step) {
    const all = tops.flatMap((t) => t.subs.map((s) => [t, s]));
    const at = all.findIndex(([t, s]) => t === top && s === sub);
    const [t, s] = all[(at + step + all.length) % all.length];
    choose(t, s, { focus: t.subs.length > 1 ? "sub" : "top" });
  }
  search.addEventListener("input", () => {
    query = search.value;
    paint();
  });
  search.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && search.value) {
      e.preventDefault();
      e.stopPropagation();
      query = "";
      search.value = "";
      paint();
    }
  });

  topBar.append(...topButtons);
  topBar.hidden = tops.length < 2;
  paintSubBar();
  const head = el(
    "div",
    { class: "fmt-frame-head" },
    el("div", { class: "fmt-search-wrap" }, icon("Search", 14), search),
    topBar,
    el("div", { class: "fmt-sub-row" }, subBar, caption),
  );
  head.stepTab = stepTab;
  root.append(...(model.lead || []), head, statusNode, panelNode, resultsNode);
  paint();
  current = {
    root,
    family: model.family,
    reveal(key) {
      if (!head.isConnected) return false;
      for (const t of tops)
        for (const s of t.subs)
          if (s.keys.includes(key)) {
            if (t !== top || s !== sub || query) choose(t, s);
            return true;
          }
      return false;
    },
  };
  return root;
}

/**
 * Shows the tab holding the section `key` and opens it, focusing its first
 * control. Returns whether the section was found.
 */
export function revealFormatSection(key) {
  current?.reveal(key);
  const node = document.querySelector(
    `#inspector details[data-section="${key}"]`,
  );
  if (!node) return false;
  node.open = true;
  node.scrollIntoView({ block: "start" });
  node.querySelector("input,select,button")?.focus({ preventScroll: true });
  return true;
}

/** Shows a tab of the frame on screen by its top and icon tab ids. */
export function showFormatTab(family, top, sub) {
  remember(family, top, sub);
}

/**
 * On a phone the pane is a sheet over the lower part of the screen; its
 * heading is a handle that drags the sheet taller or shorter.
 */
export function sheetHandle(heading) {
  heading.classList.add("fmt-sheet-handle");
  heading.addEventListener("pointerdown", (e) => {
    if (!matchMedia("(max-width: 760px)").matches) return;
    if (e.target.closest("button, input, select, textarea")) return;
    const panel = heading.closest(".inspector");
    const host = panel?.offsetParent || panel?.parentElement;
    if (!host) return;
    e.preventDefault();
    const startY = e.clientY;
    const startH = panel.getBoundingClientRect().height;
    const max = host.getBoundingClientRect().height;
    heading.setPointerCapture?.(e.pointerId);
    const move = (ev) => {
      const h = Math.max(140, Math.min(max, startH + startY - ev.clientY));
      panel.style.setProperty("--fmt-sheet-height", `${Math.round(h)}px`);
    };
    const up = () => {
      heading.removeEventListener("pointermove", move);
      heading.removeEventListener("pointerup", up);
      heading.removeEventListener("pointercancel", up);
    };
    heading.addEventListener("pointermove", move);
    heading.addEventListener("pointerup", up);
    heading.addEventListener("pointercancel", up);
  });
}
