import { CAP_KINDS } from "./connector-caps.js";
import {
  canEditText,
  canAutoFitText,
  textStyle,
  textValign,
  VERTICAL_ALIGNMENTS,
} from "./text.js";
import { appendRun } from "./rich-text.js";
import { fontFamily, validFontFamily } from "./fonts.js";
import { tableTextAlign } from "./table-sizing.js";
import { hasBorder } from "./shape-specs.js";
import { FRAME_FORMATS } from "./frame-formats.js";

export const STYLE_STORAGE_KEY = "whiteboard-copied-style";
const colored = new Set([
  "note",
  "rect",
  "ellipse",
  "arrow",
  "pen",
  "table",
  "link",
  "file",
]);
const sized = new Set(["table", "link", "file"]);
const emphasis = ["bold", "italic", "underline", "strike"];
const lineDefaults = {
  lineType: "straight",
  lineStyle: "solid",
  lineWidth: 2.5,
  startCap: "none",
  endCap: "arrow",
};
// A shape's border, from the same fields as a line's.
const borderDefaults = { lineStyle: "solid", lineWidth: 1 };
const LINE_STYLES = ["solid", "dashed", "dotted"];
const lineWidth = (value) =>
  Number.isFinite(value) && value >= 1 && value <= 12;
const color = (value) =>
  typeof value === "string" && /^#[\da-f]{6}$/i.test(value);
const size = (value) => Number.isFinite(value) && value >= 8 && value <= 100;
const keysOnly = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).every((k) => keys.includes(k));

export const canCopyStyle = (i) =>
  !!i && (colored.has(i.type) || canEditText(i));
export function canPasteStyle(i, style) {
  return !!(
    i &&
    style &&
    ((style.color !== undefined && colored.has(i.type)) ||
      (style.text && (canEditText(i) || sized.has(i.type))) ||
      (style.line && i.type === "arrow") ||
      (style.border && hasBorder(i)))
  );
}

// A small, content-free snapshot can be reused across boards and tabs. Mixed
// text uses the first character's formatting; hyperlinks are never copied.
export function copyObjectStyle(i) {
  if (!canCopyStyle(i)) return null;
  const result = { version: 1 };
  if (colored.has(i.type))
    result.color =
      i.color ||
      (["table", "link", "file"].includes(i.type) ? "#ffffff" : "#f6e7a4");
  if (canEditText(i)) {
    const first = i.textRuns?.[0],
      range = first?.start === 0 ? first.style : {},
      source = { ...i, ...range, link: undefined },
      style = textStyle(source);
    result.text = {
      fontSize: style.size,
      fontFamily: fontFamily(i),
      textAlign: style.align,
      ...Object.fromEntries(emphasis.map((k) => [k, style[k]])),
      textColor: source.textColor || null,
      highlight: source.highlight || null,
    };
    if (canAutoFitText(i)) {
      result.autoFontSize = !!i.autoFontSize;
      result.text.textValign = textValign(i);
    }
  } else if (sized.has(i.type)) {
    result.text = {
      fontSize: i.fontSize || (i.type === "table" ? 15 : 18),
      fontFamily: fontFamily(i),
    };
    // A table's weight, slant and alignment apply to all its cells.
    if (i.type === "table")
      Object.assign(result.text, {
        textAlign: tableTextAlign(i),
        bold: !!i.bold,
        italic: !!i.italic,
      });
  }
  if (hasBorder(i))
    result.border = Object.fromEntries(
      Object.entries(borderDefaults).map(([k, fallback]) => [
        k,
        i[k] ?? fallback,
      ]),
    );
  if (i.type === "arrow")
    result.line = Object.fromEntries(
      Object.entries(lineDefaults).map(([k, fallback]) => [
        k,
        i[k] ?? fallback,
      ]),
    );
  return result;
}

export function readObjectStyle(value) {
  try {
    if (typeof value !== "string" || value.length > 2048) return null;
    const s = JSON.parse(value);
    if (
      !keysOnly(s, [
        "version",
        "color",
        "text",
        "line",
        "border",
        "autoFontSize",
      ]) ||
      s.version !== 1 ||
      (!s.color && !s.text && !s.line && !s.border)
    )
      return null;
    if (s.color !== undefined && !color(s.color)) return null;
    if (s.autoFontSize !== undefined && typeof s.autoFontSize !== "boolean")
      return null;
    if (s.text !== undefined) {
      if (
        !keysOnly(s.text, [
          "fontSize",
          "fontFamily",
          "textAlign",
          "textValign",
          ...emphasis,
          "textColor",
          "highlight",
        ]) ||
        !size(s.text.fontSize)
      )
        return null;
      if (
        s.text.fontFamily !== undefined &&
        !validFontFamily(s.text.fontFamily)
      )
        return null;
      for (const key of emphasis)
        if (s.text[key] !== undefined && typeof s.text[key] !== "boolean")
          return null;
      for (const key of ["textColor", "highlight"])
        if (
          s.text[key] !== undefined &&
          s.text[key] !== null &&
          !color(s.text[key])
        )
          return null;
      if (
        s.text.textAlign !== undefined &&
        !["left", "center", "right"].includes(s.text.textAlign)
      )
        return null;
      if (
        s.text.textValign !== undefined &&
        !VERTICAL_ALIGNMENTS.includes(s.text.textValign)
      )
        return null;
    }
    if (s.line !== undefined) {
      if (
        !keysOnly(s.line, Object.keys(lineDefaults)) ||
        !lineWidth(s.line.lineWidth)
      )
        return null;
      for (const [key, values] of [
        ["lineType", ["straight", "elbow", "curved"]],
        ["lineStyle", LINE_STYLES],
        ["startCap", CAP_KINDS],
        ["endCap", CAP_KINDS],
      ])
        if (!values.includes(s.line[key])) return null;
    }
    if (
      s.border !== undefined &&
      (!keysOnly(s.border, Object.keys(borderDefaults)) ||
        !lineWidth(s.border.lineWidth) ||
        !LINE_STYLES.includes(s.border.lineStyle))
    )
      return null;
    return s;
  } catch {
    return null;
  }
}

// Return only actual changes so reapplying an identical style preserves redo.
// Target text, links, lists, geometry, grouping and connection IDs stay intact.
export function objectStylePatch(i, copied) {
  if (!canPasteStyle(i, copied)) return null;
  const patch = {};
  const put = (key, value, before = i[key]) => {
    if (before !== value) patch[key] = value;
  };
  if (copied.color !== undefined && colored.has(i.type))
    put(
      "color",
      copied.color,
      copyObjectStyle({ ...i, textRuns: undefined }).color,
    );
  if (copied.text && (canEditText(i) || sized.has(i.type))) {
    const style = textStyle(i);
    put(
      "fontSize",
      copied.text.fontSize,
      canEditText(i)
        ? style.size
        : i.fontSize || (i.type === "table" ? 15 : 18),
    );
    if (copied.text.fontFamily !== undefined)
      put("fontFamily", copied.text.fontFamily, fontFamily(i));
    if (i.type === "table")
      for (const key of ["textAlign", "bold", "italic"])
        if (copied.text[key] !== undefined)
          put(
            key,
            copied.text[key],
            key === "textAlign" ? tableTextAlign(i) : !!i[key],
          );
    if (canEditText(i)) {
      for (const [key, value] of Object.entries(copied.text)) {
        if (["fontSize", "fontFamily"].includes(key)) continue;
        // Only sticky notes and shapes place their text vertically.
        if (key === "textValign") {
          if (canAutoFitText(i)) put(key, value, textValign(i));
          continue;
        }
        put(
          key,
          value,
          key === "textAlign"
            ? style.align
            : emphasis.includes(key)
              ? style[key]
              : i[key] || null,
        );
      }
      const cleared = new Set(Object.keys(copied.text));
      if (
        i.textRuns?.some((r) =>
          Object.keys(r.style).some((k) => cleared.has(k)),
        )
      ) {
        const runs = [];
        for (const r of i.textRuns)
          appendRun(
            runs,
            r.start,
            r.end,
            Object.fromEntries(
              Object.entries(r.style).filter(([k]) => !cleared.has(k)),
            ),
          );
        patch.textRuns = runs.length ? runs : null;
      }
    }
  }
  if (copied.autoFontSize !== undefined && canAutoFitText(i))
    put("autoFontSize", copied.autoFontSize, !!i.autoFontSize);
  if (copied.line && i.type === "arrow")
    for (const [key, value] of Object.entries(copied.line))
      put(key, value, i[key] ?? lineDefaults[key]);
  // The usual border is the absence of one set.
  if (copied.border && hasBorder(i))
    for (const [key, value] of Object.entries(copied.border))
      if (value !== (i[key] ?? borderDefaults[key]))
        patch[key] = value === borderDefaults[key] ? null : value;
  return Object.keys(patch).length ? patch : null;
}
export function applyObjectStyle(i, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete i[key];
    else i[key] = value;
  }
}

// The look new sticky notes, shapes, lines and drawings take: the last one
// given to each kind on this device, as in Miro, and the format new frames
// take.
// Anything else in storage is ignored.
export const LAST_STYLE_KEY = "whiteboard-last-style";
const LINE_CHOICES = {
  lineType: ["straight", "elbow", "curved"],
  lineStyle: ["solid", "dashed", "dotted"],
  startCap: CAP_KINDS,
  endCap: CAP_KINDS,
};
export function readLastStyle(value) {
  const result = {};
  try {
    const saved = typeof value === "string" ? JSON.parse(value) : null;
    if (!saved || typeof saved !== "object") return result;
    for (const type of ["note", "rect", "ellipse", "pen"])
      if (color(saved[type]?.color))
        result[type] = { color: saved[type].color };
    const line = saved.arrow;
    if (line && typeof line === "object") {
      const kept = {};
      for (const [key, values] of Object.entries(LINE_CHOICES))
        if (values.includes(line[key])) kept[key] = line[key];
      if (
        Number.isFinite(line.lineWidth) &&
        line.lineWidth >= 1 &&
        line.lineWidth <= 12
      )
        kept.lineWidth = line.lineWidth;
      if (color(line.color)) kept.color = line.color;
      if (Object.keys(kept).length) result.arrow = kept;
    }
    if (FRAME_FORMATS.some((f) => f.id === saved.frame?.format))
      result.frame = { format: saved.frame.format };
  } catch {}
  return result;
}
