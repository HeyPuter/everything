// Threaded comments: the modern comment parts, read together with legacy
// ones.
//
// Modern schema ([MS-PPTX], `p188` namespace):
//   * One package-level `/ppt/authors.xml` (`p188:authorLst`) lists every
//     person who wrote a comment, keyed by a GUID.
//   * One `/ppt/comments/modernComment_<sldId hex>_<tag>.xml` per slide
//     (`p188:cmLst`), related from the slide; the slide also points at it
//     from its extension list (`p188:commentRel`).
//   * Each `p188:cm` is a thread: anchored to the slide (`pc:sldMkLst`) or to
//     an object on it (`ac:deMkLst`), with an optional position, a status
//     (active / resolved / closed), the replies in `p188:replyLst`, and its
//     text in `p188:txBody`.
//
// Reading merges the legacy comments (`/ppt/comments/comment{N}.xml`) in as
// threads without replies. Writing a slide's threads always writes the
// modern part and retires that slide's legacy part, so a deck converts as
// it is edited and never carries the same comment twice.

import {
  type PartName,
  emptyRels,
  nextRelId,
  partName,
  resolveTarget,
} from "../../internal/opc/index.ts";
import type { OpcPackage } from "../../internal/parts/index.ts";
import { REL_TYPES } from "../../internal/presentationml/index.ts";
import {
  NS,
  type XmlElement,
  childElements,
  firstChildElement,
  getAttrValue,
  parseFragment,
  parseXml,
  qname,
} from "../../internal/xml/index.ts";
import {
  INTERNAL_PACKAGE,
  type PresentationData,
  SLIDE_DOCUMENT,
  SLIDE_PART_NAME,
  type SlideData,
} from "../_internal-symbols.ts";
import {
  PRES_PART_NAME,
  commitSlideData,
  decode,
  encode,
  refreshSlideData,
} from "./_helpers.ts";
import { readSlideEntries } from "./slide-list.ts";
import { getSlides } from "./slide-query.ts";
import {
  clearSlideComments,
  getCommentAuthors,
  getSlideComments,
} from "./comments.ts";
import { COMMENT_SNAPSHOT } from "../_internal-symbols.ts";

export const NS_P188 =
  "http://schemas.microsoft.com/office/powerpoint/2018/8/main";
const NS_PC =
  "http://schemas.microsoft.com/office/powerpoint/2013/main/command";
const NS_AC = "http://schemas.microsoft.com/office/drawing/2013/main/command";
const NS_A16 = "http://schemas.microsoft.com/office/drawing/2014/main";
export const REL_MODERN_COMMENTS =
  "http://schemas.microsoft.com/office/2018/10/relationships/comments";
export const REL_MODERN_AUTHORS =
  "http://schemas.microsoft.com/office/2018/10/relationships/authors";
const MODERN_COMMENTS_CONTENT_TYPE =
  "application/vnd.ms-powerpoint.comments+xml";
const MODERN_AUTHORS_CONTENT_TYPE = "application/vnd.ms-powerpoint.authors+xml";
const AUTHORS_PART_NAME = partName("/ppt/authors.xml");
const COMMENT_REL_EXT_URI = "{6950BFC3-D8DA-4A85-94F7-54DA5524770B}";

// Earlier writers used other dates in the relationship type; read them all.
const isModernCommentsRel = (type: string): boolean =>
  /^http:\/\/schemas\.microsoft\.com\/office\/\d{4}\/\d+\/relationships\/comments$/.test(
    type,
  ) || type === REL_TYPES.modernComment;
const isModernAuthorsRel = (type: string): boolean =>
  /^http:\/\/schemas\.microsoft\.com\/office\/\d{4}\/\d+\/relationships\/authors$/.test(
    type,
  ) || type === REL_TYPES.authors;

export type CommentStatus = "active" | "resolved" | "closed";

/** A person who wrote a comment or a reply. */
export interface CommentPerson {
  /** A GUID for modern authors; `legacy:<n>` for legacy ones. */
  readonly id: string;
  readonly name: string;
  readonly initials: string;
  readonly userId: string;
  readonly providerId: string;
}

export interface CommentReplyInfo {
  readonly id: string;
  readonly author: CommentPerson;
  /** ISO-8601, or null when the file gives none. */
  readonly created: string | null;
  readonly text: string;
}

export interface CommentThreadInfo {
  readonly id: string;
  readonly author: CommentPerson;
  readonly created: string | null;
  readonly text: string;
  readonly status: CommentStatus;
  /** The id (`cNvPr/@id`) of the object it is anchored to, or null. */
  readonly shapeId: string | null;
  /** Where its marker sits, in EMU from the slide's top left. */
  readonly pos: { readonly x: number; readonly y: number } | null;
  readonly replies: ReadonlyArray<CommentReplyInfo>;
  /** Read from a legacy comments part. */
  readonly legacy: boolean;
}

/** An author as a caller gives one: an existing id, or who they are. */
export interface CommentPersonInput {
  readonly id?: string;
  readonly name: string;
  readonly initials?: string;
  readonly userId?: string;
  readonly providerId?: string;
}

export interface CommentReplyInput {
  readonly id?: string;
  readonly author: CommentPersonInput;
  readonly created?: string | null;
  readonly text: string;
}

export interface CommentThreadInput {
  readonly id?: string;
  readonly author: CommentPersonInput;
  readonly created?: string | null;
  readonly text: string;
  readonly status?: CommentStatus;
  readonly shapeId?: string | null;
  readonly pos?: { readonly x: number; readonly y: number } | null;
  readonly replies?: ReadonlyArray<CommentReplyInput>;
}

// ---------------------------------------------------------------------------
// Helpers.

const xmlEscape = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    // Characters XML 1.0 cannot carry at all.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, "");

const hex = (n: number, width: number): string =>
  n.toString(16).toUpperCase().padStart(width, "0");

/** A GUID in braces, as the comment parts write them. */
export const newCommentGuid = (): string => {
  const bytes = new Uint8Array(16);
  const c = globalThis.crypto as Crypto | undefined;
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const h = [...bytes].map((b) => hex(b, 2)).join("");
  return `{${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}}`;
};

const initialsOf = (name: string): string => {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  return words
    .slice(0, 2)
    .map((w) => [...w][0]!.toUpperCase())
    .join("");
};

const local = (e: XmlElement): string => e.name.localName;
const attrOf = (e: XmlElement, name: string): string | null =>
  getAttrValue(e, qname("", name, ""));

// The text of a `txBody`: its paragraphs on lines of their own, line breaks
// kept.
const bodyText = (body: XmlElement | null): string => {
  if (!body) return "";
  const lines: string[] = [];
  for (const p of childElements(body)) {
    if (local(p) !== "p" || p.name.namespaceURI !== NS.dml) continue;
    let line = "";
    const walk = (e: XmlElement) => {
      for (const c of childElements(e)) {
        if (local(c) === "t" && c.name.namespaceURI === NS.dml)
          line += c.children
            .map((n) => (n.kind === "text" || n.kind === "cdata" ? n.data : ""))
            .join("");
        else if (local(c) === "br") line += "\n";
        else if (local(c) === "r" || local(c) === "fld") walk(c);
      }
    };
    walk(p);
    lines.push(line);
  }
  return lines.join("\n");
};

const bodyXml = (value: string): string => {
  const paragraphs = value.split("\n");
  return `<p188:txBody><a:bodyPr/><a:lstStyle/>${paragraphs
    .map((line) =>
      line
        ? `<a:p><a:r><a:rPr lang="en-US"/><a:t>${xmlEscape(line)}</a:t></a:r></a:p>`
        : '<a:p><a:endParaRPr lang="en-US"/></a:p>',
    )
    .join("")}</p188:txBody>`;
};

const relsFor = (pkg: OpcPackage, owner: PartName) =>
  pkg.getRels(owner) ?? emptyRels();

const targetOf = (owner: PartName, target: string): PartName =>
  target.startsWith("/") ? partName(target) : resolveTarget(owner, target);

// ---------------------------------------------------------------------------
// Authors.

const readModernAuthors = (pkg: OpcPackage): CommentPerson[] => {
  const rel = pkg
    .getRels(PRES_PART_NAME)
    ?.items.find((r) => isModernAuthorsRel(r.type));
  const name = rel ? targetOf(PRES_PART_NAME, rel.target) : AUTHORS_PART_NAME;
  const part = pkg.getPart(name);
  if (!part) return [];
  const root = parseXml(decode(part.data)).root;
  return childElements(root)
    .filter((e) => local(e) === "author")
    .map((e) => {
      const nm = attrOf(e, "name") ?? "";
      return {
        id: attrOf(e, "id") ?? "",
        name: nm,
        initials: attrOf(e, "initials") ?? initialsOf(nm),
        userId: attrOf(e, "userId") ?? nm,
        providerId: attrOf(e, "providerId") ?? "None",
      };
    })
    .filter((a) => a.id);
};

const legacyPerson = (a: {
  id: number;
  name: string;
  initials: string;
}): CommentPerson => ({
  id: `legacy:${a.id}`,
  name: a.name,
  initials: a.initials || initialsOf(a.name),
  userId: a.name,
  providerId: "None",
});

/**
 * Everyone the deck knows as a comment author: the modern author list, then
 * legacy authors whose names it does not already have.
 */
export const getCommentPeople = (
  pres: PresentationData,
): ReadonlyArray<CommentPerson> => {
  const pkg = pres[INTERNAL_PACKAGE];
  const out = readModernAuthors(pkg);
  const names = new Set(out.map((a) => a.name));
  for (const a of getCommentAuthors(pres))
    if (!names.has(a.name)) {
      names.add(a.name);
      out.push(legacyPerson(a));
    }
  return out;
};

const writeModernAuthors = (
  pkg: OpcPackage,
  authors: ReadonlyArray<CommentPerson>,
): void => {
  const xml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<p188:authorLst xmlns:a="${NS.dml}" xmlns:r="${NS.officeDocRels}" xmlns:p188="${NS_P188}">` +
    authors
      .map(
        (a) =>
          `<p188:author id="${xmlEscape(a.id)}" name="${xmlEscape(a.name)}" initials="${xmlEscape(a.initials)}" userId="${xmlEscape(a.userId)}" providerId="${xmlEscape(a.providerId)}"/>`,
      )
      .join("") +
    `</p188:authorLst>`;
  const rels = relsFor(pkg, PRES_PART_NAME);
  const rel = rels.items.find((r) => isModernAuthorsRel(r.type));
  const name = rel ? targetOf(PRES_PART_NAME, rel.target) : AUTHORS_PART_NAME;
  const part = pkg.getPart(name);
  if (part) part.data = encode(xml);
  else pkg.addPart(name, MODERN_AUTHORS_CONTENT_TYPE, encode(xml));
  if (!rel) {
    rels.items.push({
      id: nextRelId(rels.items.map((r) => r.id)),
      type: REL_MODERN_AUTHORS,
      target: "authors.xml",
      targetMode: "Internal",
    });
    pkg.setRels(PRES_PART_NAME, rels);
  }
};

// ---------------------------------------------------------------------------
// Reading.

const modernRel = (slide: SlideData) =>
  slide[INTERNAL_PACKAGE].getRels(slide[SLIDE_PART_NAME])?.items.find((r) =>
    isModernCommentsRel(r.type),
  ) ?? null;

const anchorShapeId = (cm: XmlElement): string | null => {
  for (const list of childElements(cm)) {
    if (!local(list).endsWith("MkLst") || local(list) === "sldMkLst") continue;
    // The innermost object moniker names the object; text monikers sit
    // inside one.
    let found: string | null = null;
    const walk = (e: XmlElement) => {
      for (const c of childElements(e)) {
        const n = local(c);
        if (n === "docMk" || n === "sldMk" || n === "sldLayoutMk") continue;
        if (n.endsWith("Mk") && attrOf(c, "id") !== null && !found)
          found = attrOf(c, "id");
        else walk(c);
      }
    };
    walk(list);
    if (found) return found;
  }
  return null;
};

const readPos = (e: XmlElement): { x: number; y: number } | null => {
  const pos = childElements(e).find((c) => local(c) === "pos");
  if (!pos) return null;
  const x = Number(attrOf(pos, "x")),
    y = Number(attrOf(pos, "y"));
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
};

// Dates written without a zone are UTC.
const readDate = (value: string | null): string | null =>
  value && /T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(value) ? `${value}Z` : value;

const statusOf = (value: string | null): CommentStatus =>
  value === "resolved" || value === "closed" ? value : "active";

const readModernThreads = (
  slide: SlideData,
  people: Map<string, CommentPerson>,
): CommentThreadInfo[] => {
  const rel = modernRel(slide);
  if (!rel) return [];
  const pkg = slide[INTERNAL_PACKAGE];
  const part = pkg.getPart(targetOf(slide[SLIDE_PART_NAME], rel.target));
  if (!part) return [];
  const root = parseXml(decode(part.data)).root;
  const person = (id: string | null): CommentPerson =>
    people.get(id ?? "") ?? {
      id: id ?? "",
      name: "",
      initials: "?",
      userId: "",
      providerId: "None",
    };
  const body = (e: XmlElement) =>
    bodyText(childElements(e).find((c) => local(c) === "txBody") ?? null);
  return childElements(root)
    .filter((e) => local(e) === "cm")
    .map((cm) => {
      const replyLst = childElements(cm).find((c) => local(c) === "replyLst");
      return {
        id: attrOf(cm, "id") ?? newCommentGuid(),
        author: person(attrOf(cm, "authorId")),
        created: readDate(attrOf(cm, "created")),
        text: body(cm),
        status: statusOf(attrOf(cm, "status")),
        shapeId: anchorShapeId(cm),
        pos: readPos(cm),
        replies: (replyLst ? childElements(replyLst) : [])
          .filter((r) => local(r) === "reply")
          .map((r) => ({
            id: attrOf(r, "id") ?? newCommentGuid(),
            author: person(attrOf(r, "authorId")),
            created: readDate(attrOf(r, "created")),
            text: body(r),
          })),
        legacy: false,
      };
    });
};

/**
 * Every comment thread on the slide: the modern threads, then the legacy
 * comments as threads without replies.
 */
export const getSlideCommentThreads = (
  slide: SlideData,
): ReadonlyArray<CommentThreadInfo> => {
  const pkg = slide[INTERNAL_PACKAGE];
  const people = new Map(readModernAuthors(pkg).map((a) => [a.id, a]));
  const modern = readModernThreads(slide, people);
  let legacyComments: ReturnType<typeof getSlideComments> = [];
  try {
    legacyComments = getSlideComments(slide);
  } catch {
    // Only slides in /ppt/slides have legacy comments parts.
  }
  const legacy = legacyComments.map((c) => {
    const snap = c[COMMENT_SNAPSHOT];
    return {
      id: `legacy:${snap.authorId}:${snap.idx}`,
      author: legacyPerson(c.author),
      created: snap.dt,
      text: snap.text,
      status: "active" as const,
      shapeId: null,
      pos: snap.position ? { x: snap.position.x, y: snap.position.y } : null,
      replies: [],
      legacy: true,
    };
  });
  return [...modern, ...legacy];
};

/** How many threads the slide has (replies not counted). */
export const countSlideCommentThreads = (slide: SlideData): number =>
  getSlideCommentThreads(slide).length;

/** Whether any slide of the deck has a comment. */
export const hasPresentationComments = (pres: PresentationData): boolean =>
  getSlides(pres).some((s) => getSlideCommentThreads(s).length > 0);

// ---------------------------------------------------------------------------
// Writing.

const slideIds = (slide: SlideData): { sldId: string; cId: string } => {
  const pkg = slide[INTERNAL_PACKAGE];
  let sldId = "256";
  const presPart = pkg.getPart(PRES_PART_NAME);
  const presRels = pkg.getRels(PRES_PART_NAME);
  if (presPart && presRels) {
    try {
      const { entries } = readSlideEntries(
        pkg,
        parseXml(decode(presPart.data)).root,
        presRels,
      );
      const entry = entries.find((e) => e.part.name === slide[SLIDE_PART_NAME]);
      const id = entry && getAttrValue(entry.element, qname("", "id", ""));
      if (id) sldId = id;
    } catch {
      // An unreadable slide list leaves the default id.
    }
  }
  let cId = "0";
  const cSld = firstChildElement(
    slide[SLIDE_DOCUMENT].root,
    qname("p", "cSld", NS.pml),
  );
  const walk = (e: XmlElement): void => {
    for (const c of childElements(e)) {
      if (local(c) === "creationId" && c.name.namespaceURI === NS.p14) {
        const v = attrOf(c, "val");
        if (v) cId = v;
      } else if (local(c) === "extLst" || local(c) === "ext") walk(c);
    }
  };
  if (cSld) walk(cSld);
  return { sldId, cId };
};

// The moniker for an object on the slide: its kind and, when it has one, the
// creation id other editors track it by.
const shapeMoniker = (slide: SlideData, id: string): string => {
  let kind = "spMk";
  let creationId: string | null = null;
  const find = (e: XmlElement): boolean => {
    for (const c of childElements(e)) {
      const n = local(c);
      if (["sp", "pic", "grpSp", "graphicFrame", "cxnSp"].includes(n)) {
        const nv = childElements(c).find((x) => local(x).startsWith("nv"));
        const cNvPr = nv && childElements(nv).find((x) => local(x) === "cNvPr");
        if (cNvPr && attrOf(cNvPr, "id") === id) {
          kind =
            {
              pic: "picMk",
              grpSp: "grpSpMk",
              graphicFrame: "graphicFrameMk",
              cxnSp: "cxnSpMk",
            }[n] ?? "spMk";
          const ext = (x: XmlElement): void => {
            for (const y of childElements(x)) {
              if (local(y) === "creationId" && y.name.namespaceURI === NS_A16)
                creationId = attrOf(y, "id");
              else ext(y);
            }
          };
          ext(cNvPr);
          return true;
        }
        if (n === "grpSp" && find(c)) return true;
      } else if (n === "spTree" || n === "cSld") {
        if (find(c)) return true;
      }
    }
    return false;
  };
  find(slide[SLIDE_DOCUMENT].root);
  return `<ac:${kind} id="${xmlEscape(id)}"${creationId ? ` creationId="${xmlEscape(creationId)}"` : ""}/>`;
};

const NAME_EXT_LST = qname("p", "extLst", NS.pml);

// The slide's pointer at its modern comments, in its extension list.
const setCommentRelExtension = (slide: SlideData, rId: string | null) => {
  const root = slide[SLIDE_DOCUMENT].root;
  let extLst = firstChildElement(root, NAME_EXT_LST);
  if (extLst) {
    extLst.children = extLst.children.filter(
      (n) =>
        !(
          n.kind === "element" &&
          local(n) === "ext" &&
          attrOf(n, "uri") === COMMENT_REL_EXT_URI
        ),
    );
    if (!rId && !childElements(extLst).length)
      root.children = root.children.filter((n) => n !== extLst);
  }
  if (rId) {
    if (!extLst) {
      extLst = parseFragment(`<p:extLst xmlns:p="${NS.pml}"/>`);
      extLst.prefixDecls = new Map();
      root.children.push(extLst);
    }
    const ext = parseFragment(
      `<p:ext xmlns:p="${NS.pml}" uri="${COMMENT_REL_EXT_URI}"><p188:commentRel xmlns:p188="${NS_P188}" xmlns:r="${NS.officeDocRels}" r:id="${rId}"/></p:ext>`,
    );
    ext.prefixDecls = new Map();
    extLst.children.push(ext);
  }
  commitSlideData(slide);
  refreshSlideData(slide);
};

// A slide's legacy comments, once written again as modern ones.
const removeLegacyComments = (slide: SlideData) => {
  try {
    if (getSlideComments(slide).length) clearSlideComments(slide);
  } catch {
    // A slide outside /ppt/slides has no legacy comments part of its own.
  }
};

const resolvePerson = (
  input: CommentPersonInput,
  authors: CommentPerson[],
): CommentPerson => {
  if (input.id && !input.id.startsWith("legacy:")) {
    const known = authors.find((a) => a.id === input.id);
    if (known) return known;
  }
  const userId = input.userId || input.name;
  const known = authors.find(
    (a) => a.name === input.name && a.userId === userId,
  );
  if (known) return known;
  const person: CommentPerson = {
    id:
      input.id &&
      !input.id.startsWith("legacy:") &&
      /^\{[0-9A-F-]{36}\}$/i.test(input.id)
        ? input.id
        : newCommentGuid(),
    name: input.name,
    initials: input.initials || initialsOf(input.name),
    userId,
    providerId: input.providerId || "None",
  };
  authors.push(person);
  return person;
};

const isoDate = (value: string | null | undefined): string => {
  const t = value ? Date.parse(value) : NaN;
  // Written without a zone, in UTC, as other editors write it.
  return new Date(Number.isFinite(t) ? t : Date.now())
    .toISOString()
    .replace(/Z$/, "");
};

const guid = (id: string | undefined): string =>
  id && /^\{[0-9A-F-]{36}\}$/i.test(id) ? id.toUpperCase() : newCommentGuid();

/**
 * Replaces every comment thread on the slide. Threads are written to the
 * slide's modern comments part (created when needed, removed when the list
 * is empty) and the slide's legacy comments are retired. Authors are added
 * to `/ppt/authors.xml` as needed.
 */
export const setSlideCommentThreads = (
  slide: SlideData,
  threads: ReadonlyArray<CommentThreadInput>,
): void => {
  const pkg = slide[INTERNAL_PACKAGE];
  const owner = slide[SLIDE_PART_NAME];
  removeLegacyComments(slide);
  const rels = relsFor(pkg, owner);
  const rel = rels.items.find((r) => isModernCommentsRel(r.type)) ?? null;
  if (!threads.length) {
    if (rel) {
      const target = targetOf(owner, rel.target);
      if (pkg.getPart(target)) pkg.removePart(target);
      rels.items = rels.items.filter((r) => r !== rel);
      pkg.setRels(owner, rels);
    }
    setCommentRelExtension(slide, null);
    return;
  }
  const authors = readModernAuthors(pkg);
  const before = authors.length;
  const { sldId, cId } = slideIds(slide);
  const slideMk = `<pc:docMk/><pc:sldMk cId="${xmlEscape(cId)}" sldId="${xmlEscape(sldId)}"/>`;
  const thread = (t: CommentThreadInput): string => {
    const author = resolvePerson(t.author, authors);
    const anchor = t.shapeId
      ? `<ac:deMkLst xmlns:ac="${NS_AC}" xmlns:pc="${NS_PC}">${slideMk}${shapeMoniker(slide, t.shapeId)}</ac:deMkLst>`
      : `<pc:sldMkLst xmlns:pc="${NS_PC}">${slideMk}</pc:sldMkLst>`;
    const pos = t.pos
      ? `<p188:pos x="${Math.round(t.pos.x)}" y="${Math.round(t.pos.y)}"/>`
      : "";
    const replies = (t.replies ?? []).length
      ? `<p188:replyLst>${(t.replies ?? [])
          .map((r) => {
            const by = resolvePerson(r.author, authors);
            return `<p188:reply id="${guid(r.id)}" authorId="${xmlEscape(by.id)}" created="${isoDate(r.created)}">${bodyXml(r.text)}</p188:reply>`;
          })
          .join("")}</p188:replyLst>`
      : "";
    const status =
      t.status && t.status !== "active" ? ` status="${t.status}"` : "";
    return `<p188:cm id="${guid(t.id)}" authorId="${xmlEscape(author.id)}"${status} created="${isoDate(t.created)}">${anchor}${pos}${replies}${bodyXml(t.text)}</p188:cm>`;
  };
  const xml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<p188:cmLst xmlns:a="${NS.dml}" xmlns:r="${NS.officeDocRels}" xmlns:p188="${NS_P188}">` +
    threads.map(thread).join("") +
    `</p188:cmLst>`;
  if (authors.length !== before || !pkg.getPart(AUTHORS_PART_NAME))
    writeModernAuthors(pkg, authors);
  let target: PartName;
  if (rel) {
    target = targetOf(owner, rel.target);
    const part = pkg.getPart(target);
    if (part) part.data = encode(xml);
    else pkg.addPart(target, MODERN_COMMENTS_CONTENT_TYPE, encode(xml));
    setCommentRelExtension(slide, rel.id);
    return;
  }
  // A name no other part has: the slide's id, then a tag.
  let n = 0;
  do {
    const tag = hex((Date.now() + n * 7919) % 0xffffffff, 8);
    target = partName(
      `/ppt/comments/modernComment_${hex(Number(sldId) || 256, 0)}_${tag}.xml`,
    );
    n++;
  } while (pkg.getPart(target));
  pkg.addPart(target, MODERN_COMMENTS_CONTENT_TYPE, encode(xml));
  const id = nextRelId(rels.items.map((r) => r.id));
  rels.items.push({
    id,
    type: REL_MODERN_COMMENTS,
    target: `../comments/${target.split("/").pop()}`,
    targetMode: "Internal",
  });
  pkg.setRels(owner, rels);
  setCommentRelExtension(slide, id);
};

/** Removes every comment thread from every slide; returns how many. */
export const clearAllCommentThreads = (pres: PresentationData): number => {
  let n = 0;
  for (const slide of getSlides(pres)) {
    const count = getSlideCommentThreads(slide).length;
    if (count) {
      setSlideCommentThreads(slide, []);
      n += count;
    }
  }
  return n;
};

/**
 * Drops the comment relationships a copied slide brought along, and the
 * slide's pointer at them: a copy starts without comments, and never shares
 * its source's comments part.
 */
export const detachCopiedSlideComments = (slide: SlideData): void => {
  const pkg = slide[INTERNAL_PACKAGE];
  const owner = slide[SLIDE_PART_NAME];
  const rels = pkg.getRels(owner);
  if (
    rels?.items.some(
      (r) => isModernCommentsRel(r.type) || r.type === REL_TYPES.comments,
    )
  ) {
    rels.items = rels.items.filter(
      (r) => !isModernCommentsRel(r.type) && r.type !== REL_TYPES.comments,
    );
    pkg.setRels(owner, rels);
  }
  const extLst = firstChildElement(slide[SLIDE_DOCUMENT].root, NAME_EXT_LST);
  if (
    extLst &&
    childElements(extLst).some((e) => attrOf(e, "uri") === COMMENT_REL_EXT_URI)
  )
    setCommentRelExtension(slide, null);
};

/** The slide's `p:sldId/@id` in presentation.xml (256 when unreadable). */
export const getSlideNumericId = (slide: SlideData): number =>
  Number(slideIds(slide).sldId) || 256;
