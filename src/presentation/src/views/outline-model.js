// The outline's model: the deck read as a flat list of rows, one for each
// slide's title (level 0) and one for each paragraph of its body (levels 1
// to 9), and the edits made to those rows written back to the slides.
//
// A row is { level, text, part }. Only title rows carry a part: the slide
// they stand for, or null for a slide the outline has just made. The body
// rows after a title belong to its slide. A line break inside a paragraph
// reads as "\n" in a row.
import {
  P,
  textRuns,
  setRichText,
  SOFT_BREAK,
  removeSlides,
} from "../model.js";

export const MAX_LEVEL = 9;

const runText = (paragraph) =>
  paragraph.runs
    .map((r) => r.text)
    .join("")
    .replaceAll(SOFT_BREAK, "\n");

function shapeParagraphs(pres, shape) {
  if (!shape) return [];
  try {
    return textRuns(pres, shape);
  } catch {
    return [];
  }
}

// The deck's outline, slide by slide.
export function readOutline(pres) {
  return P.getSlides(pres).map((slide) => {
    const { title, body } = P.getSlideOutlineShapes(slide);
    const titleParagraphs = shapeParagraphs(pres, title);
    const bodyParagraphs = shapeParagraphs(pres, body);
    const bodyRows = bodyParagraphs.map((p) => ({
      text: runText(p),
      level: Math.min(MAX_LEVEL, (p.level || 0) + 1),
    }));
    return {
      part: P.getSlidePartName(slide),
      hidden: P.isSlideHidden(slide),
      hasTitle: !!title,
      hasBody: !!body,
      // A title's paragraphs read as lines of one title.
      title: titleParagraphs.map(runText).join("\n"),
      // An empty body (one paragraph with no text) has nothing to outline.
      body: bodyRows.length === 1 && !bodyRows[0].text.trim() ? [] : bodyRows,
    };
  });
}

export function rowsFromOutline(outline) {
  const rows = [];
  for (const slide of outline) {
    rows.push({ level: 0, text: slide.title, part: slide.part });
    for (const p of slide.body) rows.push({ level: p.level, text: p.text });
  }
  return rows;
}

// Rows grouped back into slides. Body rows ahead of the first title (which
// the outline never leaves) would have no slide; they start one.
export function structureFromRows(rows) {
  const slides = [];
  for (const row of rows) {
    if (row.level === 0 || !slides.length)
      slides.push({
        part: row.level === 0 ? (row.part ?? null) : null,
        title: row.level === 0 ? row.text : "",
        body: row.level === 0 ? [] : [{ text: row.text, level: row.level }],
      });
    else slides.at(-1).body.push({ text: row.text, level: row.level });
  }
  return slides;
}

const sameBody = (a, b) =>
  a.length === b.length &&
  a.every((p, i) => p.text === b[i].text && p.level === b[i].level);

// The structural edits on rows. Each returns the new rows and where the
// caret goes: { rows, focus: { row, offset } }, or null when the edit does
// not apply.
const clone = (rows) => rows.map((r) => ({ ...r }));
// The last row of the slide whose title is at `i` (or that holds row i).
function slideEnd(rows, i) {
  let end = i;
  while (end + 1 < rows.length && rows[end + 1].level !== 0) end++;
  return end;
}
export function splitRow(rows, i, offset) {
  const next = clone(rows);
  const row = next[i];
  const before = row.text.slice(0, offset);
  const after = row.text.slice(offset);
  row.text = before;
  if (row.level === 0) {
    // A new slide follows this one, after its body.
    const at = slideEnd(next, i) + 1;
    next.splice(at, 0, { level: 0, text: after, part: null });
    return { rows: next, focus: { row: at, offset: 0 } };
  }
  next.splice(i + 1, 0, { level: row.level, text: after });
  return { rows: next, focus: { row: i + 1, offset: 0 } };
}
// Tab: a title becomes the previous slide's first-level paragraph, the
// slide's own paragraphs going one level deeper with it; a paragraph goes a
// level deeper.
export function demoteRow(rows, i, offset = 0) {
  const row = rows[i];
  if (!row) return null;
  if (row.level === 0) {
    if (i === 0) return null;
    const next = clone(rows);
    const end = slideEnd(next, i);
    for (let k = i; k <= end; k++)
      next[k] = {
        level: Math.min(MAX_LEVEL, next[k].level + 1),
        text: next[k].text,
      };
    return { rows: next, focus: { row: i, offset } };
  }
  if (row.level >= MAX_LEVEL) return null;
  const next = clone(rows);
  next[i].level++;
  return { rows: next, focus: { row: i, offset } };
}
// Shift+Tab: a first-level paragraph becomes the title of a new slide that
// takes the paragraphs after it; a deeper one comes up a level.
export function promoteRow(rows, i, offset = 0) {
  const row = rows[i];
  if (!row || row.level === 0) return null;
  const next = clone(rows);
  if (row.level === 1) next[i] = { level: 0, text: row.text, part: null };
  else next[i].level--;
  return { rows: next, focus: { row: i, offset } };
}
// Backspace at the start of a row joins it to the row above.
export function mergeWithPrevious(rows, i) {
  if (i <= 0) return null;
  const next = clone(rows);
  const previous = next[i - 1];
  const offset = previous.text.length;
  previous.text += next[i].text;
  next.splice(i, 1);
  return { rows: next, focus: { row: i - 1, offset } };
}

// Writes paragraphs into a text placeholder, keeping each unchanged
// paragraph's runs and properties, and giving a changed or new paragraph
// the formatting of the paragraph it replaces or of its nearest neighbour
// at the same level.
export function writeParagraphs(pres, shape, wanted) {
  const old = shapeParagraphs(pres, shape);
  const lists = wanted.length ? wanted : [{ text: "", level: 0 }];
  const strip = (ppr) => {
    if (!ppr) return null;
    const copy = structuredClone(ppr);
    copy.attrs = copy.attrs.filter(
      (a) => !["lvl", "marL", "indent"].includes(a.name.localName),
    );
    return copy;
  };
  const paragraphs = lists.map((p, i) => {
    const same = old[i];
    const text = p.text.replaceAll("\n", SOFT_BREAK);
    if (same && runText(same) === p.text && (same.level || 0) === p.level)
      return { ...same, runs: same.runs.map((r) => ({ ...r, changes: {} })) };
    const model =
      same ||
      [...old].reverse().find((o) => (o.level || 0) === p.level) ||
      old.at(-1);
    const keepPpr = model && (model.level || 0) === p.level;
    return {
      runs: [
        {
          text,
          rpr: model?.runs[0]?.rpr ? structuredClone(model.runs[0].rpr) : null,
          changes: {},
        },
      ],
      ppr: keepPpr ? model.ppr : strip(model?.ppr),
      level: p.level,
    };
  });
  setRichText(shape, paragraphs);
}

const titleLines = (text) =>
  text.split("\n").map((t) => ({ text: t, level: 0 }));

export function createSlide(pres, after) {
  // A new slide takes the layout of the slide before it when that layout
  // has a title and a body, and otherwise a title-and-content layout.
  const layoutOf = (slide) => {
    try {
      return P.getSlideLayout(slide);
    } catch {
      return null;
    }
  };
  const prior = after && layoutOf(after);
  const fits =
    prior &&
    P.getSlideLayoutPlaceholders(prior).some(
      (p) => p.type === "title" || p.type === "ctrTitle",
    ) &&
    P.getSlideLayoutPlaceholders(prior).some(
      (p) => p.type === null || p.type === "body" || p.type === "obj",
    );
  if (fits) return P.addSlide(pres, { layout: prior });
  try {
    return P.addContentSlide(pres, {});
  } catch {
    return P.addBlankSlide(pres);
  }
}

// Applies an outline (from structureFromRows) to the deck. Slides whose
// title rows are gone are removed (their paragraphs now belong to the slide
// before them), new title rows become new slides, and every slide's title
// and body take the outline's text. Returns whether anything changed.
export function applyOutline(pres, structure, { maxSlides = 300 } = {}) {
  const current = readOutline(pres);
  const byPart = new Map(current.map((s) => [s.part, s]));
  const kept = new Set(structure.map((s) => s.part).filter(Boolean));
  let changed = false;
  if (structure.length > maxSlides)
    throw new Error(`The slide limit is ${maxSlides}.`);
  const gone = P.getSlides(pres).filter(
    (slide) => !kept.has(P.getSlidePartName(slide)),
  );
  // At least one slide stays.
  if (gone.length >= P.getSlides(pres).length) gone.pop();
  if (gone.length) {
    removeSlides(pres, gone);
    changed = true;
  }
  const parts = [];
  structure.forEach((entry, i) => {
    let slide =
      entry.part &&
      P.getSlides(pres).find((s) => P.getSlidePartName(s) === entry.part);
    if (!slide) {
      slide = createSlide(pres, i > 0 ? P.getSlides(pres)[i - 1] : null);
      changed = true;
    }
    if (P.getSlides(pres).indexOf(slide) !== i) {
      P.moveSlide(pres, slide, i);
      slide = P.getSlides(pres)[i];
      changed = true;
    }
    parts.push(P.getSlidePartName(slide));
    const before = entry.part ? byPart.get(entry.part) : null;
    let { title, body } = P.getSlideOutlineShapes(slide);
    const titleChanged = before ? before.title !== entry.title : !!entry.title;
    if (titleChanged && (title || entry.title)) {
      title ??= P.addSlideOutlinePlaceholder(slide, "title");
      writeParagraphs(pres, title, titleLines(entry.title));
      changed = true;
    }
    const wantedBody = entry.body.map((p) => ({
      text: p.text,
      level: p.level - 1,
    }));
    const beforeBody = before
      ? before.body.map((p) => ({ text: p.text, level: p.level - 1 }))
      : [];
    if (!sameBody(beforeBody, wantedBody) && (body || wantedBody.length)) {
      body ??= P.addSlideOutlinePlaceholder(slide, "body");
      writeParagraphs(pres, body, wantedBody);
      changed = true;
    }
  });
  return { changed, parts };
}
