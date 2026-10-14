// Document statistics in `/docProps/app.xml`, and the package's kind
// (presentation or template) as its main part's content type declares it.

import { emptyRels, nextRelId, partName } from "../../internal/opc/index.ts";
import { REL_TYPES } from "../../internal/presentationml/index.ts";
import {
  elem,
  firstChildElement,
  parseXml,
  qname,
  serializeXml,
  text as textNode,
} from "../../internal/xml/index.ts";
import {
  INTERNAL_PACKAGE,
  type PresentationData,
} from "../_internal-symbols.ts";
import { decode, encode } from "./_helpers.ts";
import { getSlides, isSlideHidden } from "./slide-query.ts";
import { getPresentationText } from "./slide-query.ts";
import { getSlideNotes } from "./slide-notes.ts";

const NS_EXT_PROPS =
  "http://schemas.openxmlformats.org/officeDocument/2006/extended-properties";
const NS_VT =
  "http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes";
const EXT_PROPS_PART_NAME = partName("/docProps/app.xml");
const EXT_PROPS_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.extended-properties+xml";

/** Counts a document-properties panel shows for a presentation. */
export interface DocumentStatistics {
  /** Every slide, hidden ones included. */
  readonly slides: number;
  readonly hiddenSlides: number;
  /** Slides that carry speaker notes. */
  readonly notes: number;
  /** Words in the slides' text (notes are not counted). */
  readonly words: number;
  /** Non-empty paragraphs in the slides' text. */
  readonly paragraphs: number;
  /** Words in the speaker notes. */
  readonly notesWords: number;
  /** Embedded audio and video parts. */
  readonly multimediaClips: number;
}

// A word is a run of letters, digits or marks; a run of ideographs counts a
// word per character, as East Asian text has no spaces to split on.
const IDEOGRAPH =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
export const countWords = (value: string): number => {
  let n = 0;
  for (const token of value.split(/[\s ​]+/u)) {
    if (!token) continue;
    let ideographs = 0;
    let other = false;
    for (const ch of token) {
      if (IDEOGRAPH.test(ch)) ideographs++;
      else if (/[\p{L}\p{N}]/u.test(ch)) other = true;
    }
    n += ideographs + (other ? 1 : 0);
  }
  return n;
};

/** Counts slides, notes, words and media clips across the presentation. */
export const getDocumentStatistics = (
  pres: PresentationData,
): DocumentStatistics => {
  const slides = getSlides(pres);
  let hiddenSlides = 0;
  let notes = 0;
  let notesWords = 0;
  for (const slide of slides) {
    if (isSlideHidden(slide)) hiddenSlides++;
    const text = getSlideNotes(slide);
    if (text && text.trim()) {
      notes++;
      notesWords += countWords(text);
    }
  }
  const all = getPresentationText(pres, "\n");
  const paragraphs = all.split(/\n/).filter((p) => p.trim()).length;
  const multimediaClips = pres[INTERNAL_PACKAGE].parts.filter(
    (p) =>
      p.name.startsWith("/ppt/media/") &&
      /^(audio|video)\//.test(p.contentType),
  ).length;
  return {
    slides: slides.length,
    hiddenSlides,
    notes,
    words: countWords(all),
    paragraphs,
    notesWords,
    multimediaClips,
  };
};

/** The statistic elements `/docProps/app.xml` carries, by element name. */
export interface ExtendedStatistics {
  readonly slides: number | null;
  readonly hiddenSlides: number | null;
  readonly notes: number | null;
  readonly words: number | null;
  readonly paragraphs: number | null;
  readonly multimediaClips: number | null;
}

const STAT_FIELDS: ReadonlyArray<{
  key: keyof ExtendedStatistics;
  local: string;
}> = [
  { key: "words", local: "Words" },
  { key: "paragraphs", local: "Paragraphs" },
  { key: "slides", local: "Slides" },
  { key: "notes", local: "Notes" },
  { key: "hiddenSlides", local: "HiddenSlides" },
  { key: "multimediaClips", local: "MMClips" },
];

/** Reads the statistics `/docProps/app.xml` records; null when absent. */
export const getExtendedStatistics = (
  pres: PresentationData,
): ExtendedStatistics | null => {
  const part = pres[INTERNAL_PACKAGE].getPart(EXT_PROPS_PART_NAME);
  if (!part) return null;
  const root = parseXml(decode(part.data)).root;
  const out: Record<string, number | null> = {};
  for (const { key, local } of STAT_FIELDS) {
    const node = firstChildElement(root, qname("", local, NS_EXT_PROPS));
    let s = "";
    for (const c of node?.children ?? []) if (c.kind === "text") s += c.data;
    const n = Number.parseInt(s, 10);
    out[key] = node && Number.isFinite(n) ? n : null;
  }
  return out as unknown as ExtendedStatistics;
};

const ensureExtendedPropertiesPart = (pres: PresentationData) => {
  const pkg = pres[INTERNAL_PACKAGE];
  const existing = pkg.getPart(EXT_PROPS_PART_NAME);
  if (existing) return existing;
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Properties xmlns="${NS_EXT_PROPS}" xmlns:vt="${NS_VT}"></Properties>`;
  const part = pkg.addPart(
    EXT_PROPS_PART_NAME,
    EXT_PROPS_CONTENT_TYPE,
    encode(xml),
  );
  const rootRels = pkg.rootRels() ?? emptyRels();
  if (!rootRels.items.some((r) => r.type === REL_TYPES.extendedProperties)) {
    rootRels.items.push({
      id: nextRelId(rootRels.items.map((r) => r.id)),
      type: REL_TYPES.extendedProperties,
      target: "docProps/app.xml",
      targetMode: "Internal",
    });
    pkg.setRootRels(rootRels);
  }
  return part;
};

/**
 * Records statistics in `/docProps/app.xml`, creating the part when the
 * package has none. Fields left out stay as they are; other content of the
 * part (application name, heading pairs, titles of parts…) is preserved.
 * The part's schema is an unordered `xsd:all`, so new elements append.
 */
export const setExtendedStatistics = (
  pres: PresentationData,
  values: Partial<ExtendedStatistics>,
): void => {
  const part = ensureExtendedPropertiesPart(pres);
  const doc = parseXml(decode(part.data));
  for (const { key, local } of STAT_FIELDS) {
    if (!(key in values)) continue;
    const value = values[key];
    const name = qname("", local, NS_EXT_PROPS);
    const node = firstChildElement(doc.root, name);
    if (value === null || value === undefined) {
      if (node) doc.root.children = doc.root.children.filter((c) => c !== node);
      continue;
    }
    const content = [textNode(String(Math.max(0, Math.round(value))))];
    if (node) node.children = content;
    else doc.root.children.push(elem(name, { children: content }));
  }
  part.data = encode(serializeXml(doc));
};

/** Counts the presentation and records the counts in `/docProps/app.xml`. */
export const updateExtendedStatistics = (
  pres: PresentationData,
): DocumentStatistics => {
  const stats = getDocumentStatistics(pres);
  setExtendedStatistics(pres, stats);
  return stats;
};

// ---------------------------------------------------------------------------
// Presentation or template.

const MAIN_CONTENT_TYPES = {
  presentation:
    "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
  template:
    "application/vnd.openxmlformats-officedocument.presentationml.template.main+xml",
  slideshow:
    "application/vnd.openxmlformats-officedocument.presentationml.slideshow.main+xml",
} as const;
export type PresentationKind = keyof typeof MAIN_CONTENT_TYPES;

/** The file MIME type for each package kind. */
export const PRESENTATION_FILE_TYPES: Readonly<
  Record<PresentationKind, string>
> = {
  presentation:
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  template:
    "application/vnd.openxmlformats-officedocument.presentationml.template",
  slideshow:
    "application/vnd.openxmlformats-officedocument.presentationml.slideshow",
};

const mainPartName = (pres: PresentationData) => {
  const pkg = pres[INTERNAL_PACKAGE];
  const rel = pkg
    .rootRels()
    ?.items.find((r) => r.type === REL_TYPES.officeDocument);
  const target = rel?.target ?? "ppt/presentation.xml";
  return partName(target.startsWith("/") ? target : `/${target}`);
};

/** Whether the package is a presentation, a template or a slide show. */
export const getPresentationKind = (
  pres: PresentationData,
): PresentationKind | null => {
  const part = pres[INTERNAL_PACKAGE].getPart(mainPartName(pres));
  if (!part) return null;
  for (const [kind, type] of Object.entries(MAIN_CONTENT_TYPES))
    if (part.contentType === type) return kind as PresentationKind;
  return null;
};

/**
 * Declares the package a presentation (.pptx), a template (.potx) or a
 * slide show (.ppsx). Only the main part's content type differs between
 * them; every other part is unchanged.
 */
export const setPresentationKind = (
  pres: PresentationData,
  kind: PresentationKind,
): void => {
  const contentType = MAIN_CONTENT_TYPES[kind];
  if (!contentType) throw new Error(`Unknown presentation kind: ${kind}`);
  const pkg = pres[INTERNAL_PACKAGE];
  const name = mainPartName(pres);
  const part = pkg.getPart(name);
  if (!part) throw new Error("The package has no main presentation part.");
  part.contentType = contentType;
  const lower = name.toLowerCase();
  const override = pkg.contentTypes.overrides.find(
    (o) => o.partName.toLowerCase() === lower,
  );
  if (override) override.contentType = contentType;
  else pkg.contentTypes.overrides.push({ partName: name, contentType });
};
