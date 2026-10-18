// Content extraction from PowerPoint, Word, and Excel files (Office Open
// XML). Extractors return plain document models; src/content/layout.js turns
// them into board objects. Nothing here renders markup or fetches anything.
import { readZip, resolvePart, ZipError } from "../unzip.js";
import { truncate } from "../model.js";
import {
  NS,
  parseXML,
  all,
  first,
  children,
  attr,
  relationships,
} from "./xml.js";
import { sniffImage, extension, IMAGE_BYTES } from "./binary.js";
// Spreadsheet text writes characters such as a carriage return as _xHHHH_,
// and an underscore that starts such text as _x005F_. Characters text
// cannot hold stay as written.
const unescapeText = (text) =>
  text.replace(/_x([\dA-Fa-f]{4})_/g, (match, hex) => {
    const code = parseInt(hex, 16);
    return code === 9 ||
      code === 10 ||
      code === 13 ||
      (code >= 0x20 && (code < 0xd800 || code > 0xdfff) && code < 0xfffe)
      ? String.fromCharCode(code)
      : match;
  });

const XML_PART = 20 * 1024 * 1024;
export const SHEET_ROWS = 1000;
export const SHEET_COLUMNS = 120;

function context(bytes, options = {}) {
  // Parts over XML_PART are only ever read from their start, and a
  // workbook's sheets only when chosen.
  const zip = readZip(bytes, {
    start: XML_PART,
    onDemand: (name) => name.startsWith("xl/worksheets/"),
    ...options.limits,
  });
  const Parser = options.DOMParser || globalThis.DOMParser;
  const skipped = {
    images: 0,
    formats: new Set(),
    large: 0,
    damaged: 0,
    charts: 0,
  };
  async function xml(name) {
    if (!zip.has(name)) return null;
    if (zip.size(name) > XML_PART)
      throw Error("A part of this document is too large to import.");
    return parseXML(await zip.text(name), Parser);
  }
  // A part too large to read whole, read from its start through the first
  // `count` complete `tag` elements, or as many as fit, and closed by
  // `close` given the tag's namespace prefix. Reading grows in steps, so the
  // first rows of a huge sheet need only its first megabyte. Returns null
  // when the part is small enough to read whole.
  async function xmlStart(name, tag, close, count) {
    if (!zip.has(name) || zip.size(name) <= XML_PART) return null;
    const pattern = new RegExp(`</([\\w.-]+:)?${tag}\\s*>`, "g"),
      decoder = new TextDecoder();
    for (let size = 1024 * 1024; ; size = Math.min(size * 4, XML_PART)) {
      const text = decoder.decode(await zip.start(name, size));
      let end = -1,
        prefix = "",
        found = 0;
      for (const match of text.matchAll(pattern)) {
        end = match.index + match[0].length;
        prefix = match[1] || "";
        if (++found >= count) break;
      }
      if (end >= 0 && (found >= count || size >= XML_PART))
        return parseXML(text.slice(0, end) + close(prefix), Parser);
      if (size >= XML_PART)
        throw Error("A part of this document is too large to import.");
    }
  }
  async function rels(part) {
    const slash = part.lastIndexOf("/");
    const name = `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`;
    return relationships(await xml(name), (target) =>
      resolvePart(part, target),
    );
  }
  // A picture used on many slides or paragraphs is one part, read once.
  const images = new Map();
  // A picture too large to add, or damaged, is skipped and reported; the
  // rest of the document still imports.
  async function image(target) {
    if (!target || !zip.has(target)) return null;
    if (zip.size(target) > IMAGE_BYTES) {
      skipped.large++;
      return null;
    }
    if (!images.has(target)) images.set(target, zip.bytes(target));
    let bytes;
    try {
      bytes = await images.get(target);
    } catch (error) {
      if (!(error instanceof ZipError)) throw error;
      skipped.damaged++;
      return null;
    }
    const mime = sniffImage(bytes);
    if (!mime) {
      skipped.images++;
      skipped.formats.add(extension(target).toUpperCase() || "?");
      return null;
    }
    return { name: target.split("/").pop(), bytes, mime };
  }
  // A chart's data as a table: its title above the series names, and a row
  // per category with each series' value, from the values the file keeps
  // for showing the chart. A chart without them, or of a kind only newer
  // Office reads (chartex), is counted as skipped.
  async function chart(el, partRels) {
    const target =
      el.namespaceURI === CHART && partRels.get(attr(el, NS.r, "id"))?.target;
    const space = target ? await xml(target).catch(() => null) : null;
    const rows = space ? chartRows(space) : null;
    if (!rows) skipped.charts++;
    return rows;
  }
  const check = () => {
    if (options.signal?.aborted)
      throw new DOMException("Cancelled", "AbortError");
  };
  return { zip, xml, xmlStart, rels, image, chart, skipped, check };
}
const CHART = "http://schemas.openxmlformats.org/drawingml/2006/chart",
  CHART_EX = "http://schemas.microsoft.com/office/drawing/2014/chartex";
// Charts in the drawing under `node`, of either kind.
const charts = (node) => [
  ...all(node, CHART, "chart"),
  ...all(node, CHART_EX, "chart"),
];
function chartRows(space) {
  const date1904 = attr(first(space, CHART, "date1904"), null, "val") === "1";
  // A cached list of points by index, numbers shown in their format. Of
  // multi-level categories, the level nearest the axis is read.
  const points = (ref) => {
    const cache =
      first(ref, CHART, "strCache") ||
      first(ref, CHART, "numCache") ||
      first(ref, CHART, "multiLvlStrCache") ||
      first(ref, CHART, "strLit") ||
      first(ref, CHART, "numLit");
    if (!cache) return [];
    const code = first(cache, CHART, "formatCode")?.textContent || "";
    const level = first(cache, CHART, "lvl") || cache;
    const list = [];
    for (const pt of children(level, CHART, "pt")) {
      const index = +attr(pt, null, "idx");
      if (!Number.isInteger(index) || index < 0 || index >= SHEET_ROWS)
        continue;
      const v = first(pt, CHART, "v")?.textContent ?? "";
      const kind = formatKind(attr(pt, null, "formatCode") || code);
      list[index] =
        cache.localName !== "numCache" && cache.localName !== "numLit"
          ? v
          : typeof kind === "function"
            ? (kind(Number(v)) ?? number(v))
            : kind
              ? serialDate(v, date1904, kind)
              : number(v);
    }
    return list;
  };
  const series = all(first(space, CHART, "plotArea"), CHART, "ser").map(
    (ser) => {
      const name = first(ser, CHART, "tx");
      return {
        name:
          points(name)[0] ?? clean(first(name, CHART, "v")?.textContent || ""),
        categories: points(
          children(ser, CHART, "cat")[0] || children(ser, CHART, "xVal")[0],
        ),
        values: points(
          children(ser, CHART, "val")[0] || children(ser, CHART, "yVal")[0],
        ),
      };
    },
  );
  const length = Math.max(0, ...series.map((s) => s.values.length));
  if (!length) return null;
  const categories = series.find((s) => s.categories.length)?.categories || [];
  const title = first(first(space, CHART, "chart"), CHART, "title");
  const heading =
    drawingText(first(title, CHART, "rich")) ||
    (points(first(title, CHART, "tx"))[0] ?? "");
  return [
    [heading, ...series.map((s) => s.name)],
    ...Array.from({ length }, (_, n) => [
      categories[n] ?? String(n + 1),
      ...series.map((s) => s.values[n] ?? ""),
    ]),
  ].map((row) => row.map((cell) => clean(String(cell))));
}
const clean = (text) =>
  text
    .replace(/\r\n?/g, "\n")
    .replace(/[\0-\x08\x0b\x0c\x0e-\x1f]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .trim();

// DrawingML paragraph text: runs, fields, and line breaks in order.
function drawingParagraph(p) {
  let text = "";
  const visit = (node) => {
    for (const c of node.childNodes) {
      if (c.nodeType !== 1 || c.namespaceURI !== NS.a) continue;
      if (c.localName === "t") text += c.textContent;
      else if (c.localName === "br") text += "\n";
      else if (["r", "fld"].includes(c.localName)) visit(c);
    }
  };
  visit(p);
  return text;
}
const drawingText = (body) =>
  clean(children(body, NS.a, "p").map(drawingParagraph).join("\n"));
function drawingTable(tbl) {
  return children(tbl, NS.a, "tr").map((tr) =>
    children(tr, NS.a, "tc").map((tc) =>
      drawingText(first(tc, NS.a, "txBody")),
    ),
  );
}

const DIAGRAM = "http://schemas.openxmlformats.org/drawingml/2006/diagram";
export async function extractPptx(bytes, options = {}) {
  const c = context(bytes, options);
  const presentation = await c.xml("ppt/presentation.xml");
  if (!presentation) throw Error("This is not a PowerPoint presentation.");
  const presRels = await c.rels("ppt/presentation.xml");
  // A slide part listed more than once is read once, so a small file cannot
  // make the same large slide count many times over.
  const order = [
    ...new Set(
      all(presentation, NS.p, "sldId")
        .map((s) => presRels.get(attr(s, NS.r, "id"))?.target)
        .filter(Boolean),
    ),
  ];
  const size = first(presentation, NS.p, "sldSz");
  const slides = [];
  // SmartArt data and speaker notes shared by many shapes or slides are
  // read once, so a small file cannot make one large part count many times.
  const shared = new Map();
  const once = (part, read) => {
    if (!shared.has(part)) shared.set(part, read());
    return shared.get(part);
  };
  const diagramText = (part) =>
    once(part, async () => {
      // A damaged one is left out, like a damaged picture.
      const data = await c.xml(part).catch(() => null);
      return clean(
        children(first(data, DIAGRAM, "ptLst"), DIAGRAM, "pt")
          .filter((pt) => ["", "node", "asst"].includes(attr(pt, null, "type")))
          .map((pt) => drawingText(first(pt, DIAGRAM, "t")))
          .filter(Boolean)
          .join("\n"),
      );
    });
  const notesText = (part) =>
    once(part, async () => {
      const notes = await c.xml(part);
      return clean(
        all(notes, NS.p, "sp")
          .filter(
            (sp) =>
              attr(first(first(sp, NS.p, "nvPr"), NS.p, "ph"), null, "type") ===
              "body",
          )
          .map((sp) => drawingText(first(sp, NS.p, "txBody")))
          .join("\n"),
      );
    });
  for (const part of order) {
    c.check();
    const doc = await c.xml(part);
    if (!doc) continue;
    const rels = await c.rels(part);
    const slide = { title: "", texts: [], images: [], tables: [], notes: "" };
    const tree = first(doc, NS.p, "spTree");
    const walk = async (node) => {
      for (const el of Array.from(node?.childNodes || [])) {
        c.check();
        // Shapes with equations, ink, or 3D models come in a preferred form
        // and a fallback; the first form with shapes is read.
        if (el.namespaceURI === MARKUP && el.localName === "AlternateContent") {
          const form =
            children(el, MARKUP, "Choice").find(
              (choice) => children(choice, NS.p).length,
            ) || children(el, MARKUP, "Fallback")[0];
          if (form) await walk(form);
          continue;
        }
        if (el.nodeType !== 1 || el.namespaceURI !== NS.p) continue;
        if (el.localName === "grpSp") await walk(el);
        else if (el.localName === "sp") {
          const ph = first(first(el, NS.p, "nvPr"), NS.p, "ph");
          const type = ph ? attr(ph, null, "type") || "body" : "";
          if (["sldNum", "dt", "ftr", "hdr"].includes(type)) continue;
          const text = drawingText(first(el, NS.p, "txBody"));
          if (!text) continue;
          if (!slide.title && ["title", "ctrTitle"].includes(type))
            slide.title = text.replace(/\n+/g, " ");
          else slide.texts.push(text);
        } else if (el.localName === "pic") {
          const blip = first(el, NS.a, "blip");
          const image = await c.image(
            rels.get(attr(blip, NS.r, "embed"))?.target,
          );
          if (image) slide.images.push(image);
        } else if (el.localName === "graphicFrame") {
          const tbl = first(el, NS.a, "tbl"),
            diagram = first(el, DIAGRAM, "relIds"),
            [graph] = charts(el);
          if (graph) {
            const rows = await c.chart(graph, rels);
            if (rows) slide.tables.push(rows);
          } else if (tbl) {
            const rows = drawingTable(tbl);
            if (rows.length && rows.some((r) => r.some(Boolean)))
              slide.tables.push(rows);
          } else if (diagram) {
            // SmartArt keeps its text in a data part of its own, one point
            // per box; connections and layout points hold none.
            const target = rels.get(attr(diagram, NS.r, "dm"))?.target;
            const text = target ? await diagramText(target) : "";
            if (text) slide.texts.push(text);
          }
        }
      }
    };
    await walk(tree);
    const notesPart = [...rels.values()].find((r) =>
      r.type.endsWith("/notesSlide"),
    )?.target;
    if (notesPart) slide.notes = await notesText(notesPart);
    slides.push(slide);
  }
  return {
    kind: "slides",
    width: +attr(size, null, "cx") || 12192000,
    height: +attr(size, null, "cy") || 6858000,
    slides,
    skipped: c.skipped,
  };
}

// Word paragraph text, including hyperlinks and insertions, excluding
// deleted revisions, field instructions, and hidden text.
const MARKUP = "http://schemas.openxmlformats.org/markup-compatibility/2006";
// A run formatted as hidden, which Word neither shows nor prints. A toggle
// is on unless its value turns it off.
const hidden = (run) => {
  const vanish = children(children(run, NS.w, "rPr")[0], NS.w, "vanish")[0];
  return !!vanish && !["0", "false", "off"].includes(attr(vanish, NS.w, "val"));
};
// An equation as linear text, the way Word writes one as plain text:
// "(a+b)/2", "x^2", "x_i", "√x", "∑_(i=1)^n i". Parts longer than one
// letter or number are put in parentheses.
const MATH = "http://schemas.openxmlformats.org/officeDocument/2006/math";
function mathText(node) {
  const part = (name) => {
    const child = children(node, MATH, name)[0];
    return child ? mathText(child) : "";
  };
  const group = (value) =>
    /^[\p{L}\p{N}.]*$/u.test(value) ? value : `(${value})`;
  const char = (props, name, fallback) => {
    const el = children(children(node, MATH, props)[0], MATH, name)[0];
    return el ? attr(el, MATH, "val") : fallback;
  };
  switch (node.namespaceURI === MATH && node.localName) {
    case "t":
      return node.textContent;
    case "f":
      return `${group(part("num"))}/${group(part("den"))}`;
    case "sSup":
      return `${part("e")}^${group(part("sup"))}`;
    case "sSub":
      return `${part("e")}_${group(part("sub"))}`;
    case "sSubSup":
      return `${part("e")}_${group(part("sub"))}^${group(part("sup"))}`;
    case "rad": {
      const degree = part("deg");
      return degree ? `√(${degree}&${part("e")})` : `√${group(part("e"))}`;
    }
    case "d":
      return (
        char("dPr", "begChr", "(") +
        children(node, MATH, "e")
          .map(mathText)
          .join(char("dPr", "sepChr", "|")) +
        char("dPr", "endChr", ")")
      );
    case "nary": {
      const sub = part("sub"),
        sup = part("sup");
      return `${char("naryPr", "chr", "∫")}${sub && `_${group(sub)}`}${sup && `^${group(sup)}`} ${part("e")}`;
    }
  }
  let text = "";
  for (const c of node.childNodes)
    // Properties hold no text.
    if (
      c.nodeType === 1 &&
      c.namespaceURI === MATH &&
      !c.localName.endsWith("Pr")
    )
      text += mathText(c);
  return text;
}
// A Word symbol (w:sym) names a character of a font, which symbol fonts
// keep at F020 to F0FF. Those whose meaning is clear are shown as Unicode;
// any other stands as a replacement mark, so the text shows something was
// there.
const WINGDINGS = {
  0x4a: "☺",
  0x4c: "☹",
  0x6c: "●",
  0x6e: "■",
  0x6f: "☐",
  0x76: "❖",
  0x9f: "•",
  0xa1: "○",
  0xa7: "▪",
  0xd8: "➢",
  0xdf: "←",
  0xe0: "→",
  0xe1: "↑",
  0xe2: "↓",
  0xe8: "➔",
  0xef: "⇦",
  0xf0: "⇨",
  0xf1: "⇧",
  0xf2: "⇩",
  0xfb: "✗",
  0xfc: "✓",
  0xfd: "☒",
  0xfe: "☑",
};
// The Symbol font's Greek letters, A to Z and a to z, and its common signs.
const SYMBOL_UPPER = "ΑΒΧΔΕΦΓΗΙϑΚΛΜΝΟΠΘΡΣΤΥςΩΞΨΖ",
  SYMBOL_LOWER = "αβχδεφγηιϕκλμνοπθρστυϖωξψζ";
const SYMBOL = {
  0x22: "∀",
  0x24: "∃",
  0x27: "∋",
  0x2a: "∗",
  0x2d: "−",
  0x40: "≅",
  0x5c: "∴",
  0x5e: "⊥",
  0x7e: "∼",
  0xa3: "≤",
  0xa5: "∞",
  0xab: "↔",
  0xac: "←",
  0xad: "↑",
  0xae: "→",
  0xaf: "↓",
  0xb0: "°",
  0xb1: "±",
  0xb3: "≥",
  0xb4: "×",
  0xb7: "•",
  0xb8: "÷",
  0xb9: "≠",
  0xbb: "≈",
  0xd6: "√",
  0xdb: "⇔",
  0xdc: "⇐",
  0xde: "⇒",
  0xe5: "∑",
};
function wordSymbol(sym) {
  const code = parseInt(attr(sym, NS.w, "char") || "", 16);
  if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff) return "";
  if (code < 0xf000 || code > 0xf0ff)
    return code < 0xd800 || code > 0xdfff ? String.fromCodePoint(code) : "";
  const font = (attr(sym, NS.w, "font") || "").trim().toLowerCase(),
    low = code & 0xff;
  let text;
  if (font === "wingdings") text = WINGDINGS[low];
  else if (font === "symbol") {
    text = SYMBOL[low];
    if (low >= 0x41 && low <= 0x5a) text = SYMBOL_UPPER[low - 0x41];
    else if (low >= 0x61 && low <= 0x7a) text = SYMBOL_LOWER[low - 0x61];
    // Its other characters in the plain range, digits and most
    // punctuation, are themselves.
    else if (!text && low >= 0x20 && low < 0x7f && low !== 0x60)
      text = String.fromCharCode(low);
  }
  return text || "\ufffd";
}
function wordText(node) {
  let text = "";
  const visit = (n) => {
    for (const c of n.childNodes) {
      if (c.nodeType !== 1) continue;
      if (c.namespaceURI === MATH) {
        text += mathText(c);
        continue;
      }
      // Word can save runs in two forms; the preferred one is read.
      if (c.namespaceURI === MARKUP && c.localName === "AlternateContent") {
        const form =
          children(c, MARKUP, "Choice")[0] ||
          children(c, MARKUP, "Fallback")[0];
        if (form) visit(form);
        continue;
      }
      if (c.namespaceURI !== NS.w) continue;
      const name = c.localName;
      if (name === "r" && hidden(c)) continue;
      if (name === "t") text += c.textContent;
      else if (name === "tab") text += "\t";
      else if (name === "br" || name === "cr") text += "\n";
      else if (name === "noBreakHyphen") text += "-";
      else if (name === "sym") text += wordSymbol(c);
      // Tracked deletions and the old place of moved text are not content,
      // nor is the reading guide shown above ruby text.
      else if (
        [
          "del",
          "moveFrom",
          "instrText",
          "delText",
          "pPr",
          "rPr",
          "rt",
        ].includes(name)
      )
        continue;
      else visit(c);
    }
  };
  visit(node);
  return text;
}

// A list number in one of Word's formats; others are shown as decimals.
const ROMAN = [
  [1000, "m"],
  [900, "cm"],
  [500, "d"],
  [400, "cd"],
  [100, "c"],
  [90, "xc"],
  [50, "l"],
  [40, "xl"],
  [10, "x"],
  [9, "ix"],
  [5, "v"],
  [4, "iv"],
  [1, "i"],
];
function listNumber(n, format) {
  if (format === "none") return "";
  if (format === "decimalZero") return String(n).padStart(2, "0");
  // Past z, Word repeats the letter: aa, bb.
  if (/^(lower|upper)Letter$/.test(format) && n >= 1 && n <= 780) {
    const letter = String.fromCharCode(97 + ((n - 1) % 26)).repeat(
      Math.ceil(n / 26),
    );
    return format === "upperLetter" ? letter.toUpperCase() : letter;
  }
  if (/^(lower|upper)Roman$/.test(format) && n >= 1 && n < 4000) {
    let rest = n,
      roman = "";
    for (const [value, digits] of ROMAN)
      for (; rest >= value; rest -= value) roman += digits;
    return format === "upperRoman" ? roman.toUpperCase() : roman;
  }
  return String(n);
}
// Bullets drawn from symbol fonts are private-use characters elsewhere.
const bullet = (text) =>
  text === "\uf0a7"
    ? "\u25aa"
    : /^[\uf000-\uf0ff]$/.test(text)
      ? "\u2022"
      : text === "o"
        ? "\u25e6"
        : text;
// Numbers paragraphs as Word does, from numbering.xml: a counter per list
// and level, deeper levels restarting after a higher one, and a level text
// such as "%1.%2" filled in with each level's number. Returns a function
// giving a paragraph's label from its list, level, and style.
function listLabels(numbering) {
  const abstracts = new Map();
  for (const definition of all(numbering, NS.w, "abstractNum")) {
    const levels = [];
    for (const lvl of children(definition, NS.w, "lvl")) {
      const ilvl = +attr(lvl, NS.w, "ilvl");
      if (!(Number.isInteger(ilvl) && ilvl >= 0 && ilvl < 9)) continue;
      const val = (name) => attr(children(lvl, NS.w, name)[0], NS.w, "val");
      const start = parseInt(val("start"), 10);
      levels[ilvl] = {
        start: Number.isInteger(start) ? start : 1,
        format: val("numFmt") || "decimal",
        text: val("lvlText"),
        style: val("pStyle"),
        legal:
          !!children(lvl, NS.w, "isLgl").length &&
          !["0", "false", "off"].includes(val("isLgl")),
      };
    }
    abstracts.set(attr(definition, NS.w, "abstractNumId"), levels);
  }
  const lists = new Map();
  for (const num of all(numbering, NS.w, "num")) {
    const starts = new Map();
    for (const override of children(num, NS.w, "lvlOverride")) {
      const start = parseInt(
        attr(children(override, NS.w, "startOverride")[0], NS.w, "val"),
        10,
      );
      if (Number.isInteger(start))
        starts.set(+attr(override, NS.w, "ilvl"), start);
    }
    lists.set(attr(num, NS.w, "numId"), {
      abstract: attr(children(num, NS.w, "abstractNumId")[0], NS.w, "val"),
      starts,
    });
  }
  // Lists made from one definition continue each other's numbers, unless
  // a list restarts a level the first time it is used.
  const counters = new Map(),
    begun = new Set();
  return (numId, ilvl, styleId) => {
    const list = lists.get(numId),
      levels = list && abstracts.get(list.abstract);
    if (!levels) return "";
    if (ilvl == null) {
      const linked = levels.findIndex((l) => l?.style === styleId);
      ilvl = linked < 0 ? 0 : linked;
    }
    const level = levels[ilvl];
    if (!level) return "";
    if (!counters.has(list.abstract)) counters.set(list.abstract, []);
    const count = counters.get(list.abstract);
    if (!begun.has(numId)) {
      begun.add(numId);
      for (const l of list.starts.keys()) count[l] = undefined;
    }
    const start = (l) => list.starts.get(l) ?? levels[l]?.start ?? 1;
    count[ilvl] = count[ilvl] === undefined ? start(ilvl) : count[ilvl] + 1;
    count.length = ilvl + 1;
    if (level.format === "bullet") return bullet(level.text);
    return level.text.replace(/%([1-9])/g, (_, digit) => {
      const l = digit - 1;
      return listNumber(
        count[l] ?? start(l),
        level.legal ? "decimal" : levels[l]?.format || "decimal",
      );
    });
  };
}

export async function extractDocx(bytes, options = {}) {
  const c = context(bytes, options);
  const doc = await c.xml("word/document.xml");
  if (!doc) throw Error("This is not a Word document.");
  const rels = await c.rels("word/document.xml");
  const styles = await c.xml("word/styles.xml");
  const levels = new Map(),
    listStyles = new Set(),
    basedOn = new Map(),
    styleNumbers = new Map();
  for (const style of all(styles, NS.w, "style")) {
    const id = attr(style, NS.w, "styleId");
    const numPr = first(first(style, NS.w, "pPr"), NS.w, "numPr");
    if (numPr) styleNumbers.set(id, numPr);
    const name = attr(first(style, NS.w, "name"), NS.w, "val").toLowerCase();
    const outline = first(first(style, NS.w, "pPr"), NS.w, "outlineLvl");
    let m;
    if (name === "title") levels.set(id, 0);
    else if ((m = /^heading (\d)$/.exec(name))) levels.set(id, +m[1]);
    else if (outline) levels.set(id, +attr(outline, NS.w, "val") + 1);
    if (/list/.test(name)) listStyles.add(id);
    const parent = attr(first(style, NS.w, "basedOn"), NS.w, "val");
    if (parent) basedOn.set(id, parent);
  }
  // A style based on a heading, such as a numbered Heading 1 in a company
  // template, has that heading's level unless it sets its own.
  for (const id of basedOn.keys()) {
    const seen = new Set();
    let n = id;
    while (!levels.has(n) && basedOn.has(n) && !seen.has(n)) {
      seen.add(n);
      n = basedOn.get(n);
    }
    if (levels.has(n)) levels.set(id, levels.get(n));
  }
  const numberingPart =
    [...rels.values()].find((r) => r.type.endsWith("/numbering"))?.target ||
    "word/numbering.xml";
  const numbering = await c.xml(numberingPart).catch(() => null);
  const label = numbering ? listLabels(numbering) : () => "";
  // A paragraph's list and level: its own, or else its style's or a style
  // it is based on. A list number of 0 takes numbering away.
  const listOf = (pPr, styleId) => {
    const value = (numPr, name) => {
      const el = children(numPr, NS.w, name)[0];
      return el ? attr(el, NS.w, "val") : null;
    };
    const own = children(pPr, NS.w, "numPr")[0];
    let numId = value(own, "numId"),
      ilvl = value(own, "ilvl");
    const seen = new Set();
    for (let id = styleId; id && !seen.has(id); id = basedOn.get(id)) {
      seen.add(id);
      const numPr = styleNumbers.get(id);
      numId ??= value(numPr, "numId");
      ilvl ??= value(numPr, "ilvl");
    }
    if (!numId || numId === "0") return null;
    return { numId, ilvl: ilvl === null ? null : +ilvl };
  };
  const blocks = [];
  // Shapes can carry a DrawingML picture and a VML fallback of the same
  // picture; the fallback is used only when the preferred form has none.
  const MC = "http://schemas.openxmlformats.org/markup-compatibility/2006";
  const fallback = (el, root) => {
    for (let n = el.parentNode; n && n !== root; n = n.parentNode)
      if (n.namespaceURI === MC && n.localName === "Fallback")
        return children(n.parentNode, MC, "Choice").some(
          (choice) =>
            all(choice, NS.a, "blip").length ||
            choice.getElementsByTagNameNS("*", "imagedata").length,
        );
    return false;
  };
  // Whether `el` is inside a text box within `root`; text boxes are read
  // as paragraphs of their own.
  const boxed = (el, root) => {
    for (let n = el.parentNode; n && n !== root; n = n.parentNode)
      if (n.namespaceURI === NS.w && n.localName === "txbxContent") return true;
    return false;
  };
  // Whether `el` is in a tracked deletion or the old place of moved content.
  const deleted = (el, root) => {
    for (let n = el.parentNode; n && n !== root; n = n.parentNode)
      if (
        n.namespaceURI === NS.w &&
        (n.localName === "del" || n.localName === "moveFrom")
      )
        return true;
    return false;
  };
  // Text boxes in a paragraph, outermost first, and only once when a shape
  // carries both a DrawingML and a VML form.
  const textBoxes = (node) =>
    Array.from(node.getElementsByTagNameNS(NS.w, "txbxContent")).filter(
      (box) => {
        if (boxed(box, node) || deleted(box, node)) return false;
        for (let n = box.parentNode; n && n !== node; n = n.parentNode)
          if (n.namespaceURI === MC && n.localName === "Fallback")
            return !children(n.parentNode, MC, "Choice").some(
              (choice) =>
                choice.getElementsByTagNameNS(NS.w, "txbxContent").length,
            );
        return true;
      },
    );
  // Pictures in text boxes a paragraph's own boxes read are left to them.
  const images = async (node, boxes = false) => {
    const found = [];
    for (const blip of all(node, NS.a, "blip")) {
      if (
        fallback(blip, node) ||
        deleted(blip, node) ||
        (boxes && boxed(blip, node))
      )
        continue;
      const image = await c.image(rels.get(attr(blip, NS.r, "embed"))?.target);
      if (image) found.push(image);
    }
    // Legacy VML pictures.
    for (const data of Array.from(
      node.getElementsByTagNameNS("*", "imagedata"),
    )) {
      if (
        fallback(data, node) ||
        deleted(data, node) ||
        (boxes && boxed(data, node))
      )
        continue;
      const image = await c.image(rels.get(attr(data, NS.r, "id"))?.target);
      if (image) found.push(image);
    }
    return found;
  };
  // Rows and cells can sit in content controls, such as a repeating
  // section, or in custom XML.
  const within = (node, name) =>
    children(node, NS.w).flatMap((el) =>
      el.localName === name
        ? [el]
        : el.localName === "sdt"
          ? within(first(el, NS.w, "sdtContent"), name)
          : el.localName === "customXml"
            ? within(el, name)
            : [],
    );
  // A cell's paragraphs, reading a text box once when a shape carries both
  // a DrawingML and a VML form of it.
  const cellText = (tc) => {
    const boxes = new Set(textBoxes(tc));
    const read = all(tc, NS.w, "p").filter((p) => {
      let box = null;
      for (let n = p.parentNode; n && n !== tc; n = n.parentNode)
        if (n.namespaceURI === NS.w && n.localName === "txbxContent") box = n;
      return !box || boxes.has(box);
    });
    return clean(read.map(wordText).join("\n"));
  };
  const visit = async (parent) => {
    for (const el of Array.from(parent.childNodes)) {
      if (el.nodeType !== 1 || el.namespaceURI !== NS.w) continue;
      c.check();
      if (el.localName === "sdt") {
        const content = first(el, NS.w, "sdtContent");
        if (content) await visit(content);
      } else if (el.localName === "customXml") {
        await visit(el);
      } else if (el.localName === "p") {
        // Only the paragraph's own properties count, not those of a
        // paragraph in a text box it anchors or of a tracked older version.
        const pPr = children(el, NS.w, "pPr")[0];
        const styleId = attr(children(pPr, NS.w, "pStyle")[0], NS.w, "val");
        const outline = children(pPr, NS.w, "outlineLvl")[0];
        let level = levels.has(styleId)
          ? levels.get(styleId)
          : /^heading(\d)$/i.test(styleId)
            ? +styleId.slice(7)
            : /^title$/i.test(styleId)
              ? 0
              : null;
        if (level == null && outline) level = +attr(outline, NS.w, "val") + 1;
        // An empty numbered paragraph still takes its number.
        const list = listOf(pPr, styleId),
          number = list ? label(list.numId, list.ilvl, styleId).trim() : "";
        let text = clean(wordText(el));
        if (text && number) text = `${number} ${text}`;
        if (text) {
          if (level != null && level < 10)
            blocks.push({
              type: "heading",
              level,
              text: text.replace(/\n+/g, " "),
            });
          else
            blocks.push({
              type: "paragraph",
              text,
              list:
                !!children(pPr, NS.w, "numPr").length ||
                listStyles.has(styleId),
            });
        }
        for (const graph of charts(el)) {
          if (deleted(graph, el) || boxed(graph, el)) continue;
          const rows = await c.chart(graph, rels);
          if (rows) blocks.push({ type: "table", rows });
        }
        for (const image of await images(el, true))
          blocks.push({ type: "image", image });
        for (const box of textBoxes(el)) await visit(box);
      } else if (el.localName === "tbl") {
        // A merged cell spans grid columns without placeholder cells, so
        // it is padded to keep later cells under their own columns. Only a
        // row's or cell's own properties count, not a nested table's.
        const span = (node, props, name) => {
          const prop = children(children(node, NS.w, props)[0], NS.w, name)[0];
          return Math.min(
            100,
            Math.max(0, parseInt(attr(prop, NS.w, "val")) || 0),
          );
        };
        const rows = within(el, "tr").map((tr) => {
          const cells = Array(span(tr, "trPr", "gridBefore")).fill("");
          for (const tc of within(tr, "tc")) {
            cells.push(cellText(tc));
            for (let n = span(tc, "tcPr", "gridSpan"); n > 1; n--)
              cells.push("");
          }
          return cells;
        });
        if (rows.some((r) => r.some(Boolean)))
          blocks.push({ type: "table", rows });
        for (const image of await images(el))
          blocks.push({ type: "image", image });
      }
    }
  };
  await visit(first(doc, NS.w, "body") || doc.documentElement);
  return { kind: "document", blocks, skipped: c.skipped };
}

// Excel: workbook sheet list first; rows are read for the chosen sheet.
// Built-in formats that show a date, a time of day, or an elapsed time.
// Times note whether they show seconds, and minutes:seconds show no hours.
const BUILTIN_FORMATS = new Map([
  ...[14, 15, 16, 17, 22, 27, 30, 36, 50, 57].map((id) => [id, "date"]),
  ...[18, 20].map((id) => [id, "time"]),
  ...[19, 21].map((id) => [id, "time:s"]),
  ...[45, 47].map((id) => [id, "minutes"]),
  [46, "duration:s"],
]);
// Built-in number formats, which a workbook names by number only.
const BUILTIN_NUMBERS = new Map([
  [1, "0"],
  [2, "0.00"],
  [3, "#,##0"],
  [4, "#,##0.00"],
  [9, "0%"],
  [10, "0.00%"],
  [37, "#,##0_);(#,##0)"],
  [38, "#,##0_);(#,##0)"],
  [39, "#,##0.00_);(#,##0.00)"],
  [40, "#,##0.00_);(#,##0.00)"],
  // Accounting, as Excel shows them in an English (United States) locale.
  [41, '_(* #,##0_);_(* \\(#,##0\\);_(* "-"_);_(@_)'],
  [42, '_("$"* #,##0_);_("$"* \\(#,##0\\);_("$"* "-"_);_(@_)'],
  [43, '_(* #,##0.00_);_(* \\(#,##0.00\\);_(* "-"??_);_(@_)'],
  [44, '_("$"* #,##0.00_);_("$"* \\(#,##0.00\\);_("$"* "-"??_);_(@_)'],
]);
// A format's sections (positive;negative;zero;text), split outside quotes,
// brackets and escapes.
function sections(code) {
  const parts = [""];
  for (let n = 0; n < code.length; n++) {
    const ch = code[n];
    if (ch === ";") parts.push("");
    else {
      let end = n;
      if (ch === '"') end = code.indexOf('"', n + 1);
      else if (ch === "[") end = code.indexOf("]", n + 1);
      else if (ch === "\\" || ch === "_" || ch === "*") end = n + 1;
      if (end < n) end = code.length - 1;
      parts[parts.length - 1] += code.slice(n, end + 1);
      n = end;
    }
  }
  return parts;
}
// Shows a number as an Excel number format does: digit placeholders (0, #
// and ?), thousands separators and scaling commas, percentages, literal text
// and currency symbols, with sections for negative numbers and zero.
// Formats it does not cover (scientific, fractions, conditions, text) give
// null, and the number is shown as General shows it. A fourth section shows
// text, which a number never uses, as in Excel's Accounting formats.
function numberFormat(code) {
  const parts = sections(code);
  if (
    parts.slice(0, 3).some((part) => {
      const plain = part.replace(/"[^"]*"|\\.|_.|\*./g, "");
      return /\[[<>=]|[eE][+-]|\/|@|general/i.test(plain);
    })
  )
    return null;
  // A French currency or locale tag, such as [$€-40C] or [$-C0C], shows
  // French grouping and decimal comma, as Excel does in a French locale.
  const french = /\[\$[^\]]*-([0-9a-f]+)\]/i.exec(code);
  const [group, point] =
    french && (parseInt(french[1], 16) & 0x3ff) === 0x0c
      ? ["\u00a0", ","]
      : [",", "."];
  const tokenize = (part) => {
    const tokens = [];
    for (let n = 0; n < part.length; n++) {
      const ch = part[n];
      if (ch === '"') {
        const end = part.indexOf('"', n + 1);
        tokens.push({ text: part.slice(n + 1, end < 0 ? undefined : end) });
        n = end < 0 ? part.length : end;
      } else if (ch === "[") {
        const end = part.indexOf("]", n + 1),
          inner = part.slice(n + 1, end < 0 ? undefined : end);
        // [$€-40C] shows its symbol; colours and locales show nothing.
        if (inner[0] === "$")
          tokens.push({ text: inner.slice(1).split("-")[0] });
        n = end < 0 ? part.length : end;
      } else if (ch === "\\") tokens.push({ text: part[++n] ?? "" });
      // Padding to a character's width is a space; a fill is left out.
      else if (ch === "_") {
        tokens.push({ text: " " });
        n++;
      } else if (ch === "*") n++;
      else if ("0#?".includes(ch)) tokens.push({ digit: ch });
      else if (ch === ".") tokens.push({ point: true });
      else if (ch === ",") tokens.push({ comma: true });
      else tokens.push({ text: ch, percent: ch === "%" });
    }
    return tokens;
  };
  const show = (tokens, value) => {
    const digitAt = tokens.map((t) => !!t.digit),
      pointAt = tokens.findIndex((t) => t.point),
      lastInteger = (
        pointAt < 0 ? digitAt : digitAt.slice(0, pointAt)
      ).lastIndexOf(true);
    if (!digitAt.includes(true))
      return tokens.map((t) => t.text ?? "").join("");
    // Commas between integer digits group thousands; commas after the last
    // one divide by a thousand each.
    let grouped = false,
      scale = 0;
    tokens.forEach((t, n) => {
      if (!t.comma || (pointAt >= 0 && n > pointAt)) return;
      if (n < lastInteger) grouped = true;
      else scale++;
    });
    const percents = tokens.filter((t) => t.percent).length;
    const decimals = tokens.filter(
      (t, n) => t.digit && pointAt >= 0 && n > pointAt,
    ).length;
    // Rounded from the decimal digits, as Excel shows 2.675 as 2.68. A tiny
    // or huge value prints with its own exponent, which the shift adds to.
    const scaled = Number(
      Number((value * 100 ** percents) / 1000 ** scale).toPrecision(15),
    );
    const [mantissa, exponent = 0] = String(scaled).split("e");
    const rounded = Math.round(Number(`${mantissa}e${+exponent + decimals}`));
    if (!Number.isSafeInteger(rounded)) return null;
    const whole = String(Math.floor(rounded / 10 ** decimals)),
      fraction = String(rounded % 10 ** decimals).padStart(decimals, "0");
    let digits = whole === "0" ? "" : whole,
      out = "",
      shown = 0;
    const integer = pointAt < 0 ? tokens : tokens.slice(0, pointAt),
      firstDigit = integer.findIndex((t) => t.digit);
    for (let n = integer.length - 1; n >= 0; n--) {
      const t = integer[n];
      if (t.text !== undefined) out = t.text + out;
      if (!t.digit) continue;
      // The first placeholder takes every digit left over.
      let chunk = n === firstDigit ? digits : digits.slice(-1);
      digits = n === firstDigit ? "" : digits.slice(0, -1);
      if (!chunk) chunk = t.digit === "0" ? "0" : t.digit === "?" ? " " : "";
      for (const ch of [...chunk].reverse()) {
        if (ch !== " " && grouped && shown && shown % 3 === 0)
          out = group + out;
        out = ch + out;
        if (ch !== " ") shown++;
      }
    }
    if (pointAt >= 0) {
      const after = tokens.slice(pointAt + 1),
        places = [...fraction];
      // Optional places (# and ?) drop or blank trailing zeros.
      for (let n = after.length - 1, d = decimals - 1; n >= 0; n--) {
        if (!after[n].digit) continue;
        if (after[n].digit === "0" || places[d] !== "0") break;
        places[d--] = after[n].digit === "?" ? " " : "";
      }
      out += point;
      let d = 0;
      for (const t of after) out += t.digit ? places[d++] : (t.text ?? "");
    }
    return out;
  };
  const tokens = parts.map(tokenize);
  return (value) => {
    const section =
      value < 0 && parts.length > 1
        ? 1
        : value === 0 && parts.length > 2
          ? 2
          : 0;
    const text = show(tokens[section], Math.abs(value));
    if (text === null) return null;
    // Padding that aligns a column's digits has no place on a board.
    const tidy = text.replace(/ {2,}/g, " ").trim();
    return value < 0 && section === 0 ? "-" + tidy : tidy;
  };
}
function formatKind(code) {
  const plain = code
    .replace(/"[^"]*"/g, "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\\./g, "");
  const seconds = /s/i.test(plain) || /\[s+\]/i.test(code) ? ":s" : "";
  // An elapsed time counts its bracketed unit past the next larger one:
  // [h]:mm shows 36:00, [mm]:ss 90:00, and [ss] 5400.
  const elapsed = /\[(h+|m+|s+)\]/i.exec(code)?.[1][0].toLowerCase();
  if (elapsed === "m") return "elapsed-minutes" + seconds;
  if (elapsed === "s") return "elapsed-seconds";
  if (elapsed) return "duration" + seconds;
  if (!code.trim() || /^general$/i.test(plain.trim())) return null;
  if (!/[dmyhs]/i.test(plain)) return numberFormat(code);
  // Without a day or year, m is minutes in a time such as h:mm.
  if (/[dy]/i.test(plain) || !/[hs]/i.test(plain)) return "date";
  if (!/h/i.test(plain)) return "minutes";
  // AM/PM shows a 12-hour clock.
  return (/am\/pm|a\/p/i.test(plain) ? "time12" : "time") + seconds;
}
const pad = (n) => String(n).padStart(2, "0");
function serialDate(value, date1904, kind = "date") {
  const serial = Number(value);
  // The last day Excel can show, 9999-12-31, in each date system.
  if (
    !Number.isFinite(serial) ||
    serial < 0 ||
    serial > (date1904 ? 2957003 : 2958465)
  )
    return value;
  if (kind !== "date") {
    const elapsed = /^(duration|elapsed)/.test(kind);
    const total = Math.round((elapsed ? serial : serial % 1) * 86400);
    const hours = Math.floor(total / 3600) % (elapsed ? Infinity : 24),
      minutes = pad(Math.floor(total / 60) % 60),
      seconds = pad(total % 60);
    if (kind === "minutes") return `${minutes}:${seconds}`;
    if (kind === "elapsed-seconds") return pad(total);
    if (kind.startsWith("elapsed-minutes"))
      return `${pad(Math.floor(total / 60))}${kind.endsWith(":s") ? `:${seconds}` : ""}`;
    if (kind.startsWith("time12"))
      return `${hours % 12 || 12}:${minutes}${kind.endsWith(":s") ? `:${seconds}` : ""} ${hours < 12 ? "AM" : "PM"}`;
    return `${pad(hours)}:${minutes}${kind.endsWith(":s") ? `:${seconds}` : ""}`;
  }
  // The 1900 date system counts a 29 February 1900 that never was, so
  // serials before it are a day later than a plain count from 1899-12-30.
  const early = !date1904 && serial < 61;
  const ms = Math.round(
    (serial + (date1904 ? 1462 : 0) + (early && serial < 60 ? 1 : 0) - 25569) *
      86400000,
  );
  const iso = new Date(ms).toISOString();
  const day = early && serial >= 60 ? "1900-02-29" : iso.slice(0, 10);
  return serial % 1 ? `${day} ${iso.slice(11, 16)}` : day;
}
const number = (value) => {
  const n = Number(value);
  // Fifteen digits, as Excel shows them, keep long IDs and amounts intact.
  return Number.isFinite(n) ? String(Number(n.toPrecision(15))) : value;
};
function column(ref) {
  const m = /^([A-Z]{1,3})(\d+)$/.exec(ref || "");
  if (!m) return null;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + ch.charCodeAt(0) - 64;
  return { col: n - 1, row: +m[2] - 1 };
}

// A shared or inline string's text, without the phonetic reading guides
// (rPh) that Excel stores beside Japanese text.
const cellString = (string) =>
  unescapeText(
    all(string, NS.s, "t")
      .filter((t) => t.parentNode.localName !== "rPh")
      .map((t) => t.textContent)
      .join(""),
  );

export async function openXlsx(bytes, options = {}) {
  const c = context(bytes, options);
  const workbook = await c.xml("xl/workbook.xml");
  if (!workbook) throw Error("This is not an Excel workbook.");
  const rels = await c.rels("xl/workbook.xml");
  const date1904 = ["1", "true"].includes(
    attr(first(workbook, NS.s, "workbookPr"), null, "date1904"),
  );
  const listed = new Set();
  const sheets = all(workbook, NS.s, "sheet")
    .map((s) => ({
      name: truncate(attr(s, null, "name"), 200) || "Sheet",
      part: rels.get(attr(s, NS.r, "id"))?.target,
      hidden:
        attr(s, null, "state") !== "" && attr(s, null, "state") !== "visible",
    }))
    // A sheet part listed twice is offered once.
    .filter((s) => s.part && !listed.has(s.part) && listed.add(s.part));
  let shared = null,
    sharedCut = false,
    dateStyles = null;
  // `need` is the highest shared string number a sheet uses.
  async function prepare(need) {
    if (shared && (!sharedCut || need < shared.length)) return;
    // Strings are numbered as they first appear, so the start of a very
    // large list holds the strings of a sheet's first rows.
    const cut = await c.xmlStart(
      "xl/sharedStrings.xml",
      "si",
      (p) => `</${p}sst>`,
      need + 1,
    );
    sharedCut = !!cut;
    const strings = cut || (await c.xml("xl/sharedStrings.xml"));
    shared = all(strings, NS.s, "si").map(cellString);
    const styles = await c.xml("xl/styles.xml");
    const custom = new Map(
      all(styles, NS.s, "numFmt").map((f) => [
        +attr(f, null, "numFmtId"),
        attr(f, null, "formatCode"),
      ]),
    );
    dateStyles = children(first(styles, NS.s, "cellXfs"), NS.s, "xf").map(
      (xf) => {
        const id = +attr(xf, null, "numFmtId");
        return (
          BUILTIN_FORMATS.get(id) ||
          formatKind(custom.get(id) || BUILTIN_NUMBERS.get(id) || "")
        );
      },
    );
  }
  // A workbook opens before the import starts, so each read takes the
  // signal of the import it belongs to.
  async function read(index, { signal } = {}) {
    const sheet = sheets[index];
    if (!sheet) throw Error("Choose a sheet to import.");
    const check = () => {
      c.check();
      if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
    };
    check();
    // Only the first rows are imported, so a sheet too large to read whole
    // is read up to its last complete row within the limit.
    const cut = await c.xmlStart(
      sheet.part,
      "row",
      (p) => `</${p}sheetData></${p}worksheet>`,
      SHEET_ROWS,
    );
    const doc = cut || (await c.xml(sheet.part));
    let need = -1;
    if (c.zip.size("xl/sharedStrings.xml") > XML_PART)
      for (const row of all(doc, NS.s, "row").slice(0, SHEET_ROWS))
        for (const cell of children(row, NS.s, "c"))
          if (attr(cell, null, "t") === "s")
            need = Math.max(need, +first(cell, NS.s, "v")?.textContent || 0);
    await prepare(need);
    const rows = [];
    // Excel keeps formatting on empty cells and rows, often far past the
    // content; only cells holding a value are left out.
    const filled = (node) =>
      node.getElementsByTagNameNS(NS.s, "v").length > 0 ||
      node.getElementsByTagNameNS(NS.s, "is").length > 0;
    let truncated = !!cut,
      nextRow = 0;
    const list = all(doc, NS.s, "row");
    for (const [index, row] of list.entries()) {
      check();
      // A row number that is not a positive integer follows the row before.
      const numbered = parseInt(attr(row, null, "r"), 10),
        r =
          Number.isInteger(numbered) && numbered >= 1 ? numbered - 1 : nextRow;
      nextRow = r + 1;
      if (r >= SHEET_ROWS) {
        truncated ||= list.slice(index).some(filled);
        break;
      }
      let nextCol = 0;
      for (const cell of children(row, NS.s, "c")) {
        const ref = column(attr(cell, null, "r"));
        const col = ref ? ref.col : nextCol;
        nextCol = col + 1;
        if (col >= SHEET_COLUMNS) {
          truncated ||= filled(cell);
          continue;
        }
        const type = attr(cell, null, "t");
        const v = first(cell, NS.s, "v")?.textContent ?? "";
        let value;
        if (type === "s") {
          value = v === "" ? "" : (shared[+v] ?? "");
          if (sharedCut && +v >= shared.length) truncated = true;
        } else if (type === "inlineStr")
          value = cellString(first(cell, NS.s, "is") || cell);
        else if (type === "b") value = v === "1" ? "TRUE" : "FALSE";
        // A formula's text result is escaped as a shared string is.
        else if (type === "str") value = unescapeText(v);
        else if (type === "e" || type === "d") value = v;
        else if (v === "") value = "";
        else if (typeof dateStyles[+attr(cell, null, "s") || 0] === "function")
          value = Number.isFinite(Number(v))
            ? (dateStyles[+attr(cell, null, "s") || 0](Number(v)) ?? number(v))
            : v;
        else if (dateStyles[+attr(cell, null, "s") || 0])
          value = serialDate(
            v,
            date1904,
            dateStyles[+attr(cell, null, "s") || 0],
          );
        else value = number(v);
        if (value === "") continue;
        (rows[r] ||= [])[col] = String(value);
      }
    }
    return {
      name: sheet.name,
      rows: Array.from(rows, (row) => Array.from(row || [], (v) => v ?? "")),
      truncated,
    };
  }
  return { kind: "workbook", sheets, read, skipped: c.skipped };
}
