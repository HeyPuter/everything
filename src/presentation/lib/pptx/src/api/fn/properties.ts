// Core properties and extended properties.

import { emptyRels, nextRelId, partName } from "../../internal/opc/index.ts";
import { REL_TYPES } from "../../internal/presentationml/index.ts";
import {
  type XmlElement,
  attr,
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

// ---------------------------------------------------------------------------
// Core properties (`/docProps/core.xml`).

const NS_CORE_PROPS =
  "http://schemas.openxmlformats.org/package/2006/metadata/core-properties";
const NS_DC = "http://purl.org/dc/elements/1.1/";
const NS_DCTERMS = "http://purl.org/dc/terms/";
const NS_XSI = "http://www.w3.org/2001/XMLSchema-instance";
const CORE_PROPS_PART_NAME = partName("/docProps/core.xml");

/**
 * Document-level metadata from `/docProps/core.xml` (Open Packaging
 * Conventions). Surfaces the fields presentation apps and
 * everyone else exchange via OPC core-properties — these are the
 * values shown in a document-properties panel.
 */
export interface CoreProperties {
  readonly title: string | null;
  readonly subject: string | null;
  readonly creator: string | null;
  readonly keywords: string | null;
  readonly description: string | null;
  readonly lastModifiedBy: string | null;
  readonly revision: string | null;
  /** ISO-8601 timestamp string when set; `null` otherwise. */
  readonly created: string | null;
  /** ISO-8601 timestamp string when set; `null` otherwise. */
  readonly modified: string | null;
  readonly category: string | null;
}

/**
 * Reads `/docProps/core.xml`. Returns `null` when the package has
 * no core-properties part. Each field is `null` when the
 * corresponding element is absent or empty.
 */
/**
 * Convenience: bumps core-properties' `cp:revision` by one (treating
 * an unset / unparseable value as 0). Returns the new revision
 * number. Useful right before `savePresentation` so consumers can
 * tell decks apart.
 */
export const incrementRevision = (pres: PresentationData): number => {
  const props = getCoreProperties(pres);
  const current =
    props?.revision === null || props?.revision === undefined
      ? 0
      : Number.parseInt(props.revision, 10);
  const next = (Number.isFinite(current) ? current : 0) + 1;
  setCoreProperties(pres, { revision: String(next) });
  return next;
};

/**
 * Convenience: writes `new Date().toISOString()` to
 * `dcterms:modified`. Useful right before `savePresentation` so
 * "last edited" shows the actual save time. Pass an explicit
 * `Date` to set a specific value.
 */
export const touchModified = (
  pres: PresentationData,
  at: Date = new Date(),
): void => {
  setCoreProperties(pres, { modified: at.toISOString() });
};

/**
 * Convenience: the timestamp from core-properties' `dcterms:created`,
 * parsed as a `Date`. Returns `null` when no created field is set
 * or the value isn't a recognizable W3C-DTF / ISO-8601 string.
 */
export const getPresentationCreated = (pres: PresentationData): Date | null => {
  const props = getCoreProperties(pres);
  if (!props || props.created === null) return null;
  const d = new Date(props.created);
  return Number.isFinite(d.getTime()) ? d : null;
};

/**
 * Convenience: the timestamp from core-properties' `dcterms:modified`,
 * parsed as a `Date`. Returns `null` when no modified field is set
 * or the value isn't a recognizable W3C-DTF / ISO-8601 string.
 */
export const getPresentationModified = (
  pres: PresentationData,
): Date | null => {
  const props = getCoreProperties(pres);
  if (!props || props.modified === null) return null;
  const d = new Date(props.modified);
  return Number.isFinite(d.getTime()) ? d : null;
};

export const getCoreProperties = (
  pres: PresentationData,
): CoreProperties | null => {
  const pkg = pres[INTERNAL_PACKAGE];
  const part = pkg.getPart(CORE_PROPS_PART_NAME);
  if (!part) return null;
  const root = parseXml(decode(part.data)).root;
  const read = (uri: string, local: string): string | null => {
    const el = firstChildElement(root, qname("", local, uri));
    if (!el) return null;
    let s = "";
    for (const c of el.children) if (c.kind === "text") s += c.data;
    return s.length === 0 ? null : s;
  };
  return {
    title: read(NS_DC, "title"),
    subject: read(NS_DC, "subject"),
    creator: read(NS_DC, "creator"),
    keywords: read(NS_CORE_PROPS, "keywords"),
    description: read(NS_DC, "description"),
    lastModifiedBy: read(NS_CORE_PROPS, "lastModifiedBy"),
    revision: read(NS_CORE_PROPS, "revision"),
    created: read(NS_DCTERMS, "created"),
    modified: read(NS_DCTERMS, "modified"),
    category: read(NS_CORE_PROPS, "category"),
  };
};

const CORE_PROPS_CONTENT_TYPE =
  "application/vnd.openxmlformats-package.core-properties+xml";

const CORE_PROP_FIELDS: ReadonlyArray<{
  key: keyof CoreProperties;
  uri: string;
  prefix: string;
  local: string;
}> = [
  { key: "title", uri: NS_DC, prefix: "dc", local: "title" },
  { key: "subject", uri: NS_DC, prefix: "dc", local: "subject" },
  { key: "creator", uri: NS_DC, prefix: "dc", local: "creator" },
  { key: "keywords", uri: NS_CORE_PROPS, prefix: "cp", local: "keywords" },
  { key: "description", uri: NS_DC, prefix: "dc", local: "description" },
  {
    key: "lastModifiedBy",
    uri: NS_CORE_PROPS,
    prefix: "cp",
    local: "lastModifiedBy",
  },
  { key: "revision", uri: NS_CORE_PROPS, prefix: "cp", local: "revision" },
  { key: "created", uri: NS_DCTERMS, prefix: "dcterms", local: "created" },
  { key: "modified", uri: NS_DCTERMS, prefix: "dcterms", local: "modified" },
  { key: "category", uri: NS_CORE_PROPS, prefix: "cp", local: "category" },
];

const buildEmptyCorePropsRoot = (): XmlElement => {
  const prefixDecls = new Map<string, string>([
    ["cp", NS_CORE_PROPS],
    ["dc", NS_DC],
    ["dcterms", NS_DCTERMS],
  ]);
  return {
    kind: "element",
    name: qname("cp", "coreProperties", NS_CORE_PROPS),
    attrs: [],
    prefixDecls,
    children: [],
  };
};

// A W3CDTF timestamp (ISO-8601 to the second, UTC) from a Date, a time
// value or a date string; other strings are kept as they are.
const w3cdtf = (value: unknown): string => {
  const date =
    value instanceof Date
      ? value
      : typeof value === "number"
        ? new Date(value)
        : null;
  if (date && !Number.isNaN(date.getTime()))
    return date.toISOString().replace(/\.\d{3}Z$/, "Z");
  return String(value);
};

/**
 * Writes selected fields on `/docProps/core.xml`. Unspecified fields
 * are left as-is; pass `null` to clear a field that's currently set.
 * Bootstraps the part (and the `/_rels/.rels` entry + content-type
 * override) if the package didn't have one.
 *
 * `created` / `modified` take an ISO-8601 timestamp string (e.g.
 * `'2026-05-15T12:34:56Z'`) or a Date, and are written with the
 * `xsi:type="dcterms:W3CDTF"` attribute desktop readers expect.
 */
export const setCoreProperties = (
  pres: PresentationData,
  values: Partial<CoreProperties>,
): void => {
  const pkg = pres[INTERNAL_PACKAGE];
  let part = pkg.getPart(CORE_PROPS_PART_NAME);
  let root: XmlElement;
  let doc: ReturnType<typeof parseXml>;
  if (part) {
    doc = parseXml(decode(part.data));
    root = doc.root;
  } else {
    root = buildEmptyCorePropsRoot();
    doc = { kind: "document", decl: null, prolog: [], root, epilog: [] };
  }

  for (const field of CORE_PROP_FIELDS) {
    if (!(field.key in values)) continue;
    const raw: unknown = values[field.key] ?? null;
    const dated = field.uri === NS_DCTERMS;
    const value = raw === null ? null : dated ? w3cdtf(raw) : String(raw);
    const name = qname(field.prefix, field.local, field.uri);
    const existing = firstChildElement(root, name);
    if (value === null) {
      if (existing) {
        existing.children = [];
      }
      continue;
    }
    const target = existing ?? elem(name);
    target.children = [textNode(value)];
    if (!existing) root.children.push(target);
    if (dated) {
      // Desktop readers expect the dates typed as W3CDTF, as the package
      // schema has it; without the type a file is offered for repair.
      for (const [p, u] of [
        ["dcterms", NS_DCTERMS],
        ["xsi", NS_XSI],
      ] as const)
        if (![...root.prefixDecls.values()].includes(u))
          root.prefixDecls.set(p, u);
      const xsi = [...root.prefixDecls].find(([, u]) => u === NS_XSI)![0];
      const dcterms = [...root.prefixDecls].find(
        ([, u]) => u === NS_DCTERMS,
      )![0];
      target.attrs = [
        ...target.attrs.filter(
          (a) =>
            !(a.name.namespaceURI === NS_XSI && a.name.localName === "type"),
        ),
        attr(qname(xsi, "type", NS_XSI), `${dcterms}:W3CDTF`),
      ];
    }
  }

  const bytes = encode(serializeXml(doc));
  if (part) {
    part.data = bytes;
    return;
  }

  // Bootstrap: register override, add part, wire root rel.
  pkg.contentTypes.overrides.push({
    partName: CORE_PROPS_PART_NAME,
    contentType: CORE_PROPS_CONTENT_TYPE,
  });
  pkg.addPart(CORE_PROPS_PART_NAME, CORE_PROPS_CONTENT_TYPE, bytes);

  const rootRels = pkg.rootRels() ?? emptyRels();
  const rId = nextRelId(rootRels.items.map((r) => r.id));
  rootRels.items.push({
    id: rId,
    type: REL_TYPES.coreProperties,
    target: "docProps/core.xml",
    targetMode: "Internal",
  });
  pkg.setRootRels(rootRels);
};

// ---------------------------------------------------------------------------
// Extended properties (`/docProps/app.xml`).

const NS_EXT_PROPS =
  "http://schemas.openxmlformats.org/officeDocument/2006/extended-properties";
const EXT_PROPS_PART_NAME = partName("/docProps/app.xml");

/**
 * Selected string fields from `/docProps/app.xml`
 * (extended-properties / "app props"). Presentation apps expose these
 * as document metadata (origin and related people).
 *
 * Numeric / derived fields (`Slides`, `Words`, `Paragraphs`, …) are
 * intentionally omitted — they're recomputed by the authoring app on
 * save and reading them tends to lie about decks edited elsewhere.
 */
export interface ExtendedProperties {
  readonly application: string | null;
  readonly appVersion: string | null;
  readonly company: string | null;
  readonly manager: string | null;
  readonly presentationFormat: string | null;
  readonly hyperlinkBase: string | null;
}

/**
 * Reads `/docProps/app.xml`. Returns `null` if the package has no
 * extended-properties part. Each field is `null` when the
 * corresponding element is absent or empty.
 */
export const getExtendedProperties = (
  pres: PresentationData,
): ExtendedProperties | null => {
  const pkg = pres[INTERNAL_PACKAGE];
  const part = pkg.getPart(EXT_PROPS_PART_NAME);
  if (!part) return null;
  const root = parseXml(decode(part.data)).root;
  const read = (local: string): string | null => {
    const el = firstChildElement(root, qname("", local, NS_EXT_PROPS));
    if (!el) return null;
    let s = "";
    for (const c of el.children) if (c.kind === "text") s += c.data;
    return s.length === 0 ? null : s;
  };
  return {
    application: read("Application"),
    appVersion: read("AppVersion"),
    company: read("Company"),
    manager: read("Manager"),
    presentationFormat: read("PresentationFormat"),
    hyperlinkBase: read("HyperlinkBase"),
  };
};

const EXT_PROP_FIELDS: ReadonlyArray<{
  key: keyof ExtendedProperties;
  local: string;
}> = [
  { key: "application", local: "Application" },
  { key: "appVersion", local: "AppVersion" },
  { key: "company", local: "Company" },
  { key: "manager", local: "Manager" },
  { key: "presentationFormat", local: "PresentationFormat" },
  { key: "hyperlinkBase", local: "HyperlinkBase" },
];

/**
 * Writes selected fields on `/docProps/app.xml`. Throws when the
 * package has no extended-properties part — unlike core-properties,
 * we don't bootstrap app.xml from scratch because its schema
 * requires several derived `<vt:*>` elements (`HeadingPairs`,
 * `TitlesOfParts`, …) that aren't user-facing.
 *
 * Pass `null` to clear an existing field's text. Unspecified keys
 * are left untouched.
 */
export const setExtendedProperties = (
  pres: PresentationData,
  values: Partial<ExtendedProperties>,
): void => {
  const pkg = pres[INTERNAL_PACKAGE];
  const part = pkg.getPart(EXT_PROPS_PART_NAME);
  if (!part) {
    throw new Error(
      "setExtendedProperties: /docProps/app.xml not present; cannot bootstrap",
    );
  }
  const doc = parseXml(decode(part.data));
  for (const field of EXT_PROP_FIELDS) {
    if (!(field.key in values)) continue;
    const value = values[field.key] ?? null;
    const name = qname("", field.local, NS_EXT_PROPS);
    const existing = firstChildElement(doc.root, name);
    if (value === null) {
      if (existing) existing.children = [];
      continue;
    }
    if (existing) {
      existing.children = [textNode(value)];
    } else {
      doc.root.children.push(elem(name, { children: [textNode(value)] }));
    }
  }
  part.data = encode(serializeXml(doc));
};
