// Slide comments.
import { getSlides } from "./slide-query.ts";

import {
  type PartName,
  emptyRels,
  nextRelId,
  partName,
} from "../../internal/opc/index.ts";
import type { OpcPackage } from "../../internal/parts/index.ts";
import {
  REL_TYPES,
  type CommentAuthor,
  type CommentPosition,
  type SlideComment,
  buildCommentAuthorListDoc,
  buildCommentListDoc,
  readCommentAuthorList,
  readCommentList,
} from "../../internal/presentationml/index.ts";
import { parseXml, serializeXml } from "../../internal/xml/index.ts";
import {
  COMMENT_SLIDE,
  COMMENT_SNAPSHOT,
  INTERNAL_PACKAGE,
  type PresentationData,
  SLIDE_PART_NAME,
  type SlideCommentData,
  type SlideData,
} from "../_internal-symbols.ts";
import { PRES_PART_NAME, decode, encode } from "./_helpers.ts";
// ---------------------------------------------------------------------------
// Comments.
//
// Legacy schema (ECMA-376 Part 1 §19.4):
//   * One package-level `/ppt/commentAuthors.xml` holds every author.
//   * One `/ppt/comments/comment{N}.xml` per slide that has comments;
//     N matches the slide's part name.
//   * Slide rels reference the slide's comments part; presentation rels
//     reference the author list.
//
// Authors are deduped by (name, initials). `idx` allocation is per-author
// monotonic; we read each author's `lastIdx` and bump it on add.

const COMMENT_AUTHORS_PART_NAME = partName("/ppt/commentAuthors.xml");
const COMMENT_AUTHORS_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.commentAuthors+xml";
const COMMENTS_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.comments+xml";

const slideNumberFromPartName = (name: PartName): number => {
  const m = name.match(/^\/ppt\/slides\/slide(\d+)\.xml$/);
  if (!m?.[1]) {
    throw new Error(`comments: cannot derive slide number from ${name}`);
  }
  return Number.parseInt(m[1], 10);
};

const commentsPartNameForSlide = (slide: SlideData): PartName => {
  const slideN = slideNumberFromPartName(slide[SLIDE_PART_NAME]);
  return partName(`/ppt/comments/comment${slideN}.xml`);
};

const loadAuthorList = (pkg: OpcPackage): CommentAuthor[] => {
  const part = pkg.getPart(COMMENT_AUTHORS_PART_NAME);
  if (part === null) return [];
  const list = readCommentAuthorList(parseXml(decode(part.data)).root);
  return list.authors.slice();
};

const writeAuthorList = (
  pkg: OpcPackage,
  authors: ReadonlyArray<CommentAuthor>,
): void => {
  const doc = buildCommentAuthorListDoc(authors);
  const bytes = encode(serializeXml(doc));
  const existing = pkg.getPart(COMMENT_AUTHORS_PART_NAME);
  if (existing !== null) {
    existing.data = bytes;
    return;
  }
  pkg.addPart(COMMENT_AUTHORS_PART_NAME, COMMENT_AUTHORS_CONTENT_TYPE, bytes);
  // presentation → commentAuthors rel.
  const presRels = pkg.getRels(PRES_PART_NAME) ?? emptyRels();
  const exists = presRels.items.some(
    (r) =>
      r.type === REL_TYPES.commentAuthors &&
      r.target.endsWith("commentAuthors.xml"),
  );
  if (!exists) {
    presRels.items.push({
      id: nextRelId(presRels.items.map((r) => r.id)),
      type: REL_TYPES.commentAuthors,
      target: "commentAuthors.xml",
      targetMode: "Internal",
    });
    pkg.setRels(PRES_PART_NAME, presRels);
  }
};

const loadCommentsForSlide = (slide: SlideData): SlideComment[] => {
  const pkg = slide[INTERNAL_PACKAGE];
  const partNameValue = commentsPartNameForSlide(slide);
  const part = pkg.getPart(partNameValue);
  if (part === null) return [];
  const list = readCommentList(parseXml(decode(part.data)).root);
  return list.comments.slice();
};

const writeCommentsForSlide = (
  slide: SlideData,
  comments: ReadonlyArray<SlideComment>,
): void => {
  const pkg = slide[INTERNAL_PACKAGE];
  const commentsName = commentsPartNameForSlide(slide);

  if (comments.length === 0) {
    // Drop the comments part + slide → comments rel when no comments
    // remain. Leaves an empty part orphaned otherwise.
    if (pkg.getPart(commentsName) !== null) {
      pkg.removePart(commentsName);
    }
    const slideRels = pkg.getRels(slide[SLIDE_PART_NAME]);
    if (slideRels !== null) {
      const before = slideRels.items.length;
      slideRels.items = slideRels.items.filter(
        (r) => r.type !== REL_TYPES.comments,
      );
      if (slideRels.items.length !== before) {
        pkg.setRels(slide[SLIDE_PART_NAME], slideRels);
      }
    }
    return;
  }

  const doc = buildCommentListDoc(comments);
  const bytes = encode(serializeXml(doc));
  const existing = pkg.getPart(commentsName);
  if (existing !== null) {
    existing.data = bytes;
    return;
  }
  pkg.addPart(commentsName, COMMENTS_CONTENT_TYPE, bytes);

  const slideRels = pkg.getRels(slide[SLIDE_PART_NAME]) ?? emptyRels();
  const hasRel = slideRels.items.some((r) => r.type === REL_TYPES.comments);
  if (!hasRel) {
    const slideN = slideNumberFromPartName(slide[SLIDE_PART_NAME]);
    slideRels.items.push({
      id: nextRelId(slideRels.items.map((r) => r.id)),
      type: REL_TYPES.comments,
      target: `../comments/comment${slideN}.xml`,
      targetMode: "Internal",
    });
    pkg.setRels(slide[SLIDE_PART_NAME], slideRels);
  }
};

const asCommentData = (
  slide: SlideData,
  snap: SlideComment,
  author: CommentAuthor,
): SlideCommentData => ({
  [COMMENT_SLIDE]: slide,
  [COMMENT_SNAPSHOT]: snap,
  author,
});

/**
 * Every author known to the package's `commentAuthors.xml`.
 * Returns an empty array when no author list exists.
 */
export const getCommentAuthors = (
  pres: PresentationData,
): ReadonlyArray<CommentAuthor> => loadAuthorList(pres[INTERNAL_PACKAGE]);

/**
 * Returns every slide that has at least one comment by the given
 * author name. Accepts a literal string (exact-equality) or a
 * `RegExp` for pattern matches. Sibling of `findCommentsByAuthor`
 * (which returns the comments themselves).
 */
export const findSlidesWithCommentsByAuthor = (
  pres: PresentationData,
  authorName: string | RegExp,
): ReadonlyArray<SlideData> => {
  const matches =
    typeof authorName === "string"
      ? (n: string) => n === authorName
      : (n: string) => authorName.test(n);
  const out: SlideData[] = [];
  for (const slide of getSlides(pres)) {
    if (getSlideComments(slide).some((c) => matches(c.author.name)))
      out.push(slide);
  }
  return out;
};

/**
 * Returns every distinct author who has at least one comment
 * anywhere in the deck. Deduplicates by author id; preserves
 * first-seen order. Differs from `getCommentAuthors(pres)`, which
 * surfaces every author registered in `commentAuthors.xml` even
 * when no comments reference them.
 */
export const getPresentationCommenters = (
  pres: PresentationData,
): ReadonlyArray<CommentAuthor> => {
  const seen = new Set<number>();
  const out: CommentAuthor[] = [];
  for (const slide of getSlides(pres)) {
    for (const c of getSlideComments(slide)) {
      if (seen.has(c.author.id)) continue;
      seen.add(c.author.id);
      out.push(c.author);
    }
  }
  return out;
};

/**
 * Histogram of comment counts by author display name across the whole
 * deck. Useful for "who reviewed this deck the most?" audits.
 * Authors with the same display name (a real-world case for shared
 * mailbox identities) get merged into the same bucket; pair with
 * `getPresentationCommenters` when you need to keep authors with
 * identical names separate by `id`.
 */
export const getPresentationCommentCountsByAuthor = (
  pres: PresentationData,
): Readonly<Record<string, number>> => {
  const counts: Record<string, number> = {};
  for (const slide of getSlides(pres)) {
    for (const c of getSlideComments(slide)) {
      const name = c.author.name;
      counts[name] = (counts[name] ?? 0) + 1;
    }
  }
  return counts;
};

/**
 * Dense histogram of comment counts by 0-based slide index. Every
 * slide in the deck appears as an element (count `0` when the slide
 * has no comments), so the array shape is dense — handy for charting
 * comment density per slide without re-indexing.
 */
export const getPresentationCommentCountsBySlide = (
  pres: PresentationData,
): ReadonlyArray<number> => {
  const slides = getSlides(pres);
  return slides.map((s) => getSlideComments(s).length);
};

/**
 * Looks up a `CommentAuthor` from `commentAuthors.xml` by display
 * name. Accepts a literal string (exact equality) or a `RegExp` for
 * pattern matches. Returns `null` when no author matches. Sibling of
 * `findCommentsByAuthor` — the latter returns the matching comments;
 * this returns the author handle for downstream metadata reads (id,
 * initials, color).
 */
export const findCommentAuthorByName = (
  pres: PresentationData,
  authorName: string | RegExp,
): CommentAuthor | null => {
  for (const a of getCommentAuthors(pres)) {
    const hit =
      typeof authorName === "string"
        ? a.name === authorName
        : authorName.test(a.name);
    if (hit) return a;
  }
  return null;
};

/**
 * Returns every comment whose author name matches `authorName`
 * across every slide in the deck. Accepts a literal string (exact-
 * equality) or a `RegExp` for pattern matches — useful for reviewer-
 * specific filters ("show me all of Alice's notes" / `/^review-bot/`).
 */
export const findCommentsByAuthor = (
  pres: PresentationData,
  authorName: string | RegExp,
): ReadonlyArray<SlideCommentData> => {
  const out: SlideCommentData[] = [];
  for (const slide of getSlides(pres)) {
    for (const c of getSlideComments(slide)) {
      const hit =
        typeof authorName === "string"
          ? c.author.name === authorName
          : authorName.test(c.author.name);
      if (hit) out.push(c);
    }
  }
  return out;
};

/**
 * Returns every comment whose text matches `needle` (substring or
 * `RegExp`) across the whole deck. Sibling of `findCommentsByAuthor`
 * — useful for "find every comment that mentions X" reviewer flows.
 */
export const findCommentsByText = (
  pres: PresentationData,
  needle: string | RegExp,
): ReadonlyArray<SlideCommentData> => {
  const out: SlideCommentData[] = [];
  for (const slide of getSlides(pres)) {
    for (const c of getSlideComments(slide)) {
      const text = c[COMMENT_SNAPSHOT].text;
      const hit =
        typeof needle === "string" ? text.includes(needle) : needle.test(text);
      if (hit) out.push(c);
    }
  }
  return out;
};

/**
 * Returns every comment whose `@dt` timestamp is **strictly after**
 * `since` (an ISO-8601 string or `Date`). Comments missing a `dt`
 * are skipped. Sibling of `findCommentsByText` / `findCommentsByAuthor`
 * — useful for "what's new since my last review?" surfaces.
 */
export const findCommentsAfter = (
  pres: PresentationData,
  since: string | Date,
): ReadonlyArray<SlideCommentData> => {
  const threshold =
    typeof since === "string" ? Date.parse(since) : since.getTime();
  if (Number.isNaN(threshold)) return [];
  const out: SlideCommentData[] = [];
  for (const slide of getSlides(pres)) {
    for (const c of getSlideComments(slide)) {
      const dt = c[COMMENT_SNAPSHOT].dt;
      if (dt === null) continue;
      const t = Date.parse(dt);
      if (Number.isNaN(t)) continue;
      if (t > threshold) out.push(c);
    }
  }
  return out;
};

/**
 * Returns every comment whose `@dt` timestamp is **strictly before**
 * `until` (an ISO-8601 string or `Date`). Comments missing a `dt`
 * are skipped. Sibling of `findCommentsAfter`.
 */
export const findCommentsBefore = (
  pres: PresentationData,
  until: string | Date,
): ReadonlyArray<SlideCommentData> => {
  const threshold =
    typeof until === "string" ? Date.parse(until) : until.getTime();
  if (Number.isNaN(threshold)) return [];
  const out: SlideCommentData[] = [];
  for (const slide of getSlides(pres)) {
    for (const c of getSlideComments(slide)) {
      const dt = c[COMMENT_SNAPSHOT].dt;
      if (dt === null) continue;
      const t = Date.parse(dt);
      if (Number.isNaN(t)) continue;
      if (t < threshold) out.push(c);
    }
  }
  return out;
};

const datedComments = (
  pres: PresentationData,
): ReadonlyArray<{ comment: SlideCommentData; t: number }> => {
  const out: { comment: SlideCommentData; t: number }[] = [];
  for (const slide of getSlides(pres)) {
    for (const c of getSlideComments(slide)) {
      const dt = c[COMMENT_SNAPSHOT].dt;
      if (dt === null) continue;
      const t = Date.parse(dt);
      if (!Number.isNaN(t)) out.push({ comment: c, t });
    }
  }
  return out;
};

/**
 * Returns every comment carrying a parseable `@dt`, sorted oldest
 * to newest. Comments without a date are omitted. Use `.at(0)` for
 * the oldest and `.at(-1)` for the newest.
 */
export const getCommentsSortedByDate = (
  pres: PresentationData,
): ReadonlyArray<SlideCommentData> => {
  const dated = [...datedComments(pres)];
  dated.sort((a, b) => a.t - b.t);
  return dated.map((d) => d.comment);
};

/**
 * Returns the distinct authors who commented on this slide, in
 * first-seen order. Dedupes by author id. Sibling of
 * `getPresentationCommenters` for a slide-scoped reviewer roster.
 */
export const getSlideCommentAuthors = (
  slide: SlideData,
): ReadonlyArray<CommentAuthor> => {
  const seen = new Set<number>();
  const out: CommentAuthor[] = [];
  for (const c of getSlideComments(slide)) {
    if (seen.has(c.author.id)) continue;
    seen.add(c.author.id);
    out.push(c.author);
  }
  return out;
};

/**
 * Returns every comment attached to the slide, with the author already
 * resolved. The list is read-only — use `addSlideComment` /
 * `removeSlideComment` to mutate.
 */
export const getSlideComments = (
  slide: SlideData,
): ReadonlyArray<SlideCommentData> => {
  const pkg = slide[INTERNAL_PACKAGE];
  const comments = loadCommentsForSlide(slide);
  // The deck's author list is read only for a slide with comments.
  if (!comments.length) return [];
  const authors = loadAuthorList(pkg);
  const authorById = new Map<number, CommentAuthor>();
  for (const a of authors) authorById.set(a.id, a);

  const out: SlideCommentData[] = [];
  for (const snap of comments) {
    const author = authorById.get(snap.authorId);
    if (!author) {
      // Comment references an unknown author — surface a synthetic
      // placeholder rather than dropping the comment silently.
      out.push(
        asCommentData(slide, snap, {
          id: snap.authorId,
          name: "",
          initials: "",
          lastIdx: snap.idx,
          clrIdx: null,
        }),
      );
      continue;
    }
    out.push(asCommentData(slide, snap, author));
  }
  return out;
};

/**
 * Adds a comment to the slide. Returns the new comment handle.
 *
 * Author handling: if an author with the given `name`+`initials` already
 * exists in `commentAuthors.xml`, the existing record is reused (and its
 * `lastIdx` is bumped). Otherwise a new author is allocated. `initials`
 * defaults to the first character of `name`.
 *
 * `position` is in EMU; pass `null` to omit the `<p:pos>` element.
 * `date` defaults to the current time.
 */
export const addSlideComment = (
  slide: SlideData,
  opts: {
    author: { name: string; initials?: string };
    text: string;
    position?: CommentPosition | null;
    date?: Date;
  },
): SlideCommentData => {
  const pkg = slide[INTERNAL_PACKAGE];
  const initials =
    opts.author.initials ??
    (opts.author.name.length > 0 ? opts.author.name.charAt(0) : "?");

  const authors = loadAuthorList(pkg);
  let author = authors.find(
    (a) => a.name === opts.author.name && a.initials === initials,
  );
  if (!author) {
    let maxId = -1;
    for (const a of authors) if (a.id > maxId) maxId = a.id;
    author = {
      id: maxId + 1,
      name: opts.author.name,
      initials,
      lastIdx: 0,
      clrIdx: null,
    };
    authors.push(author);
  }
  const newIdx = author.lastIdx + 1;
  // Bump lastIdx on the author for the persisted list.
  const updatedAuthor: CommentAuthor = { ...author, lastIdx: newIdx };
  const persistedAuthors = authors.map((a) =>
    a.id === author!.id ? updatedAuthor : a,
  );
  writeAuthorList(pkg, persistedAuthors);

  const dt = (opts.date ?? new Date()).toISOString();
  const snap: SlideComment = {
    authorId: updatedAuthor.id,
    idx: newIdx,
    dt,
    text: opts.text,
    position: opts.position ?? null,
  };

  const comments = loadCommentsForSlide(slide);
  comments.push(snap);
  writeCommentsForSlide(slide, comments);

  return asCommentData(slide, snap, updatedAuthor);
};

/**
 * Removes the comment from its slide's comments part. If the comment
 * was the last one on the slide, the comments part and the
 * slide → comments rel are also removed. The author entry in
 * `commentAuthors.xml` is left intact (an author may have comments on
 * other slides).
 */
export const removeSlideComment = (comment: SlideCommentData): void => {
  const slide = comment[COMMENT_SLIDE];
  const target = comment[COMMENT_SNAPSHOT];
  const remaining = loadCommentsForSlide(slide).filter(
    (c) => !(c.authorId === target.authorId && c.idx === target.idx),
  );
  writeCommentsForSlide(slide, remaining);
};

/**
 * Strips every comment from every slide in the deck. Returns the
 * number of comments removed. Built on `writeCommentsForSlide`,
 * so each slide's modern comment part is rewritten with an empty
 * list. The `commentAuthors.xml` registry is left intact for any
 * caller that still needs author identity.
 *
 * Useful as a sanitizer before sharing a draft externally — pairs
 * with `clearAllSlideNotes` for a "remove reviewer chatter" pass.
 */
export const clearAllSlideComments = (pres: PresentationData): number => {
  let n = 0;
  for (const slide of getSlides(pres)) n += clearSlideComments(slide);
  return n;
};

/**
 * Slide-scoped sibling of `clearAllSlideComments`. Removes every
 * comment on the given slide and returns the number removed.
 */
export const clearSlideComments = (slide: SlideData): number => {
  const comments = loadCommentsForSlide(slide);
  if (comments.length === 0) return 0;
  writeCommentsForSlide(slide, []);
  return comments.length;
};

// Accessors over CommentAuthor / SlideCommentData for tree-shake convenience.

export const getCommentAuthor = (comment: SlideCommentData): CommentAuthor =>
  comment.author;
export const getCommentText = (comment: SlideCommentData): string =>
  comment[COMMENT_SNAPSHOT].text;
export const getCommentDate = (comment: SlideCommentData): string | null =>
  comment[COMMENT_SNAPSHOT].dt;
export const getCommentPosition = (
  comment: SlideCommentData,
): CommentPosition | null => comment[COMMENT_SNAPSHOT].position;

/**
 * Returns the slide that owns this comment. Counterpart to
 * `getShapeSlide(shape)` — handy when filtering across the deck
 * with `findCommentsByAuthor` and the caller needs to know which
 * slide each hit came from.
 */
export const getCommentSlide = (comment: SlideCommentData): SlideData =>
  comment[COMMENT_SLIDE];
