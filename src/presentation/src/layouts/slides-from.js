// Slides from elsewhere: Reuse Slides (pick slides of another .pptx and
// insert them, keeping their own formatting or taking this deck's) and
// Slides from Outline (a .txt, .md or .rtf outline: top-level lines become
// slide titles, indented lines the body's bullets).
import { el, dialog, toast } from "../ui.js";
import { P } from "../model.js";
import { createSlide, writeParagraphs } from "../views/outline-model.js";
import { COMMAND_ICONS } from "../chrome/icons.js";
import "./layouts.css";

// Reuse Slides: a slide from another deck arriving in front of this one's.
Object.assign(COMMAND_ICONS, {
  reuseSlides:
    `<rect class="of" x="2.5" y="2.5" width="10.5" height="8" rx="1.4"/>` +
    `<rect class="bf" x="7" y="9" width="10.5" height="8" rx="1.4"/>` +
    `<path class="o thick" d="M5 11.5v2.5h2"/>`,
});

export const SLIDE_LIMIT = 300;
const MAX_LEVEL = 8;

/* ---------- Outlines ---------- */

// Leading whitespace as an indent level: tabs count one each; spaces count
// in steps of the smallest space indent the outline uses.
function indentLevels(lines) {
  const spaces = lines
    .map((l) => /^( *)/.exec(l.replace(/^\t+/, ""))[1].length)
    .filter((n) => n > 0);
  const unit = spaces.length ? Math.min(...spaces) : 4;
  return (line) => {
    const tabs = /^\t*/.exec(line)[0].length;
    const rest = /^ */.exec(line.slice(tabs))[0].length;
    return tabs + Math.round(rest / unit);
  };
}
const BULLET = /^(?:[-*+•▪◦‣]|\d+[.)])\s+/;
const stripMarkdown = (text) =>
  text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(\*|_)(.+?)\1/g, "$2")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\\([\\`*_{}[\]()#+\-.!])/g, "$1")
    .trim();

/** Plain text: each paragraph's text and indent level ("\t" per level). */
export function rtfToText(rtf) {
  const out = [];
  let line = "";
  let indent = null; // \li of the paragraph, in twips
  let outlineLevel = null;
  const stack = [];
  let skip = 0; // depth of a destination being skipped
  let depth = 0;
  let uc = 1;
  let pendingSkip = 0;
  const DESTINATIONS = new Set([
    "fonttbl",
    "colortbl",
    "stylesheet",
    "info",
    "pict",
    "header",
    "footer",
    "listtable",
    "listoverridetable",
    "generator",
    "xmlnstbl",
    "themedata",
    "latentstyles",
    "datastore",
    "rsidtbl",
  ]);
  const emit = (text) => {
    if (skip) return;
    if (pendingSkip > 0) {
      const n = Math.min(pendingSkip, text.length);
      pendingSkip -= n;
      text = text.slice(n);
    }
    line += text;
  };
  const endParagraph = () => {
    const level =
      outlineLevel ?? (indent ? Math.max(0, Math.round(indent / 360)) : 0);
    out.push("\t".repeat(level) + line);
    line = "";
  };
  for (let i = 0; i < rtf.length; i++) {
    const ch = rtf[i];
    if (ch === "{") {
      stack.push({ skip, uc });
      depth++;
      continue;
    }
    if (ch === "}") {
      const top = stack.pop();
      if (top) ({ skip, uc } = top);
      depth--;
      continue;
    }
    if (ch === "\\") {
      const next = rtf[i + 1];
      if (next === "\\" || next === "{" || next === "}") {
        emit(next);
        i++;
        continue;
      }
      if (next === "'") {
        const hex = rtf.slice(i + 2, i + 4);
        emit(String.fromCharCode(parseInt(hex, 16) || 32));
        i += 3;
        continue;
      }
      if (next === "*") {
        skip = depth;
        i++;
        continue;
      }
      if (next === "~") {
        emit(" ");
        i++;
        continue;
      }
      const m = /^([a-z]+)(-?\d+)? ?/i.exec(rtf.slice(i + 1));
      if (!m) {
        i++;
        continue;
      }
      i += m[0].length;
      const word = m[1],
        arg = m[2] === undefined ? null : Number(m[2]);
      if (DESTINATIONS.has(word)) skip = depth;
      else if (word === "par" || word === "sect") endParagraph();
      else if (word === "pard") {
        indent = null;
        outlineLevel = null;
      } else if (word === "li") indent = arg;
      else if (word === "outlinelevel" || word === "ilvl") outlineLevel = arg;
      else if (word === "tab") emit("\t");
      else if (word === "line") emit(" ");
      else if (word === "uc") uc = arg ?? 1;
      else if (word === "u" && arg !== null) {
        emit(String.fromCharCode(arg < 0 ? arg + 65536 : arg));
        pendingSkip = uc;
      } else if (word === "emdash") emit("—");
      else if (word === "endash") emit("–");
      else if (word === "bullet") emit("•");
      else if (word === "lquote" || word === "rquote") emit("'");
      else if (word === "ldblquote" || word === "rdblquote") emit('"');
      continue;
    }
    if (ch === "\r" || ch === "\n") continue;
    emit(ch);
  }
  if (line.trim()) endParagraph();
  return out.join("\n");
}

/**
 * The slides an outline describes: [{ title, body: [{ text, level }] }]
 * with body levels from 0. `format` is "txt", "md" or "rtf".
 */
export function parseOutline(source, format = "txt") {
  const text = format === "rtf" ? rtfToText(source) : String(source);
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const slides = [];
  const add = (title) => {
    const slide = { title, body: [] };
    slides.push(slide);
    return slide;
  };
  if (format === "md") {
    const listLines = lines.filter((l) => BULLET.test(l.trimStart()));
    const levelOf = indentLevels(listLines);
    let current = null;
    let fence = false;
    for (const raw of lines) {
      if (/^\s*(```|~~~)/.test(raw)) {
        fence = !fence;
        continue;
      }
      if (fence || !raw.trim() || /^\s*([-*_])(\s*\1){2,}\s*$/.test(raw))
        continue;
      const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(raw);
      if (heading) {
        current = add(stripMarkdown(heading[1]));
        continue;
      }
      const trimmed = raw.trimStart();
      const isItem = BULLET.test(trimmed);
      const body = stripMarkdown(
        trimmed.replace(BULLET, "").replace(/^>\s?/, ""),
      );
      if (!body) continue;
      if (!current) {
        current = add(isItem ? "" : body);
        if (!isItem) continue;
      }
      current.body.push({
        text: body,
        level: isItem ? Math.min(MAX_LEVEL, levelOf(raw)) : 0,
      });
    }
    return slides;
  }
  const meaningful = lines.filter((l) => l.trim());
  const levelOf = indentLevels(meaningful);
  let current = null;
  for (const raw of meaningful) {
    const level = levelOf(raw);
    const text = raw.trim().replace(BULLET, "");
    if (level === 0 || !current) {
      current = add(level === 0 ? text : "");
      if (level === 0) continue;
    }
    current.body.push({ text, level: Math.min(MAX_LEVEL, level - 1) });
  }
  return slides;
}

// The position after `after` (by part, as slide handles are remade), or
// the end.
const positionAfter = (slides, after) => {
  const part = after ? P.getSlidePartName(after) : null;
  const i = slides.findIndex((s) => P.getSlidePartName(s) === part);
  return i < 0 ? slides.length : i + 1;
};

/** Adds slides for an outline after `after` (or at the end). */
export function insertOutline(pres, outline, after = null) {
  const slides = P.getSlides(pres);
  if (slides.length + outline.length > SLIDE_LIMIT)
    throw new Error(`The slide limit is ${SLIDE_LIMIT}.`);
  let at = positionAfter(slides, after);
  let previous = after;
  const added = [];
  for (const entry of outline) {
    const slide = createSlide(pres, previous);
    P.moveSlide(pres, slide, at);
    const placed = P.getSlides(pres)[at];
    if (entry.title) {
      const title = P.addSlideOutlinePlaceholder(placed, "title");
      writeParagraphs(pres, title, [{ text: entry.title, level: 0 }]);
    }
    if (entry.body.length) {
      const body = P.addSlideOutlinePlaceholder(placed, "body");
      writeParagraphs(pres, body, entry.body);
    }
    added.push(P.getSlidePartName(placed));
    previous = placed;
    at++;
  }
  return added;
}

const formatOf = (name) => {
  const ext = /\.([a-z0-9]+)$/i.exec(name || "")?.[1]?.toLowerCase();
  return ext === "rtf"
    ? "rtf"
    : ext === "md" || ext === "markdown"
      ? "md"
      : "txt";
};

/* ---------- Reusing slides ---------- */

// A layout of this deck for a slide coming from another: the one with the
// same name, else the same kind, else the current slide's.
function destinationLayout(pres, source, fallback) {
  const from = P.getSlideLayout(source);
  const layouts = P.getSlideLayouts(pres);
  if (from) {
    const name = P.getSlideLayoutName(from);
    const byName = layouts.find((l) => P.getSlideLayoutName(l) === name);
    if (byName) return byName;
    const type = P.getSlideLayoutType(from);
    const byType =
      type && layouts.find((l) => P.getSlideLayoutType(l) === type);
    if (byType) return byType;
  }
  return (fallback && P.getSlideLayout(fallback)) || layouts[0];
}

/**
 * Inserts slides of another presentation after `after`. With
 * `keepSource`, their layouts, masters and themes come along and they look
 * as they did; otherwise they take this deck's matching layouts.
 */
export function reuseSlides(
  pres,
  sources,
  { after = null, keepSource = false, sourcePres = null } = {},
) {
  const slides = P.getSlides(pres);
  if (slides.length + sources.length > SLIDE_LIMIT)
    throw new Error(`The slide limit is ${SLIDE_LIMIT}.`);
  let at = positionAfter(slides, after);
  const layouts = keepSource ? P.importSlideTemplates(pres, sources) : null;
  const added = [];
  sources.forEach((source, i) => {
    const layout = keepSource
      ? layouts[i]
      : destinationLayout(pres, source, after);
    const slide = P.importSlide(
      pres,
      source,
      layout,
      keepSource ? { preserveGeometry: false } : {},
    );
    P.moveSlide(pres, slide, at);
    added.push(P.getSlidePartName(P.getSlides(pres)[at]));
    at++;
  });
  // Fonts the source deck carries come along with its formatting.
  if (keepSource && sourcePres)
    try {
      P.importEmbeddedFonts(
        pres,
        sourcePres,
        P.getEmbeddedFonts(sourcePres).map((font) => font.typeface),
      );
    } catch {}
  return added;
}

export function createSlidesFrom(host) {
  // host: {
  //   pres(), current(), mutate(fn), commitText(), chooseFile(accept),
  //   parseDeck(bytes), preview(pres, slide), afterAdd(position), fail(e),
  //   available()
  // }

  async function reuseSlidesDialog() {
    if (!host.available()) return;
    host.commitText();
    const file = await host.chooseFile(
      ".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation",
    );
    if (!file) return;
    let source;
    try {
      source = await host.parseDeck(new Uint8Array(await file.arrayBuffer()));
    } catch (error) {
      host.fail(error);
      return;
    }
    const slides = P.getSlides(source);
    const picks = slides.map(() => false);
    const keep = el("input", { type: "checkbox" });
    const grid = el("div", {
      class: "reuse-grid",
      role: "group",
      "aria-label": `Slides of ${file.name}`,
    });
    slides.forEach((s, i) => {
      const box = el("input", {
        type: "checkbox",
        class: "reuse-check",
        "aria-label": `Slide ${i + 1}`,
        onchange: (e) => {
          picks[i] = e.target.checked;
          card.classList.toggle("picked", picks[i]);
        },
      });
      let src = "";
      try {
        src = host.preview(source, s);
      } catch {}
      const card = el(
        "label",
        { class: "reuse-card" },
        el("img", { src, alt: "", class: "reuse-thumb", draggable: false }),
        el("span", { class: "reuse-caption" }, box, `${i + 1}`),
      );
      grid.append(card);
    });
    const body = el(
      "div",
      { class: "dialog-body reuse-body" },
      el("p", { class: "reuse-file" }, file.name),
      grid,
      el(
        "label",
        { class: "check-field" },
        keep,
        el("span", {}, "Keep source formatting"),
      ),
    );
    const choice = await dialog({
      title: "Reuse Slides",
      body,
      actions: [
        { label: "Cancel", value: null },
        { label: "Insert All", value: "all" },
        { label: "Insert", value: "selected", kind: "primary" },
      ],
    });
    if (!choice) return;
    const chosen =
      choice === "all" ? slides : slides.filter((_, i) => picks[i]);
    if (!chosen.length) {
      toast("Choose the slides to insert first.");
      return;
    }
    const after = host.current();
    const afterPart = after ? P.getSlidePartName(after) : null;
    return host.mutate(() => {
      const pres = host.pres();
      const target =
        P.getSlides(pres).find((s) => P.getSlidePartName(s) === afterPart) ??
        null;
      const added = reuseSlides(pres, chosen, {
        after: target,
        keepSource: keep.checked,
        sourcePres: source,
      });
      host.afterAdd(
        P.getSlides(pres).findIndex((s) => P.getSlidePartName(s) === added[0]),
      );
    });
  }

  async function outlineDialog() {
    if (!host.available()) return;
    host.commitText();
    const file = await host.chooseFile(
      ".txt,.md,.markdown,.rtf,text/plain,text/markdown,application/rtf",
    );
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      host.fail(new Error("Please choose an outline smaller than 5 MB."));
      return;
    }
    const outline = parseOutline(await file.text(), formatOf(file.name));
    if (!outline.length) {
      toast("That file has no outline to make slides from.");
      return;
    }
    const after = host.current();
    const afterPart = after ? P.getSlidePartName(after) : null;
    return host.mutate(() => {
      const pres = host.pres();
      const target =
        P.getSlides(pres).find((s) => P.getSlidePartName(s) === afterPart) ??
        null;
      const added = insertOutline(pres, outline, target);
      host.afterAdd(
        P.getSlides(pres).findIndex((s) => P.getSlidePartName(s) === added[0]),
      );
    });
  }

  /** Menu entries: Reuse Slides… and Slides from Outline…. */
  function menuItems() {
    return [
      {
        label: "Reuse Slides…",
        icon: "o:reuseSlides",
        disabled: !host.available(),
        onSelect: () => reuseSlidesDialog().catch(host.fail),
      },
      {
        label: "Slides from Outline…",
        icon: "o:outlineView",
        disabled: !host.available(),
        onSelect: () => outlineDialog().catch(host.fail),
      },
    ];
  }

  return { reuseSlidesDialog, outlineDialog, menuItems };
}
