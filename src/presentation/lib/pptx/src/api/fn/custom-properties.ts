// Custom document properties (`/docProps/custom.xml`) and the "final"
// marking built on them.
//
// A presentation marked as final carries a boolean custom property
// `_MarkAsFinal` and the core property `cp:contentStatus` "Final"; editors
// open it read-only until the reader chooses to edit it anyway.

import { emptyRels, nextRelId, partName } from "../../internal/opc/index.ts";
import {
  type XmlElement,
  childElements,
  elem,
  firstChildElement,
  getAttrValue,
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

const NS_CUSTOM =
  "http://schemas.openxmlformats.org/officeDocument/2006/custom-properties";
const NS_VT =
  "http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes";
const NS_CORE =
  "http://schemas.openxmlformats.org/package/2006/metadata/core-properties";
const CUSTOM_PART = partName("/docProps/custom.xml");
const CORE_PART = partName("/docProps/core.xml");
const CUSTOM_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.custom-properties+xml";
const CUSTOM_REL =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties";
// The format id every custom property is written with.
const FMTID = "{D5CDD505-2E9C-101B-9397-08002B2CF9AE}";
const MARK_AS_FINAL = "_MarkAsFinal";

export type CustomPropertyValue = string | number | boolean;

const xmlEscape = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const valueOf = (property: XmlElement): CustomPropertyValue | null => {
  const v = childElements(property)[0];
  if (!v) return null;
  const raw = v.children
    .map((n) => (n.kind === "text" || n.kind === "cdata" ? n.data : ""))
    .join("");
  switch (v.name.localName) {
    case "bool":
      return raw.trim() === "true" || raw.trim() === "1";
    case "i1":
    case "i2":
    case "i4":
    case "i8":
    case "int":
    case "ui1":
    case "ui2":
    case "ui4":
    case "ui8":
    case "uint":
    case "r4":
    case "r8":
    case "decimal": {
      const n = Number(raw);
      return Number.isFinite(n) ? n : raw;
    }
    default:
      return raw;
  }
};

/** Every custom property, by name. */
export const getCustomProperties = (
  pres: PresentationData,
): Readonly<Record<string, CustomPropertyValue>> => {
  const part = pres[INTERNAL_PACKAGE].getPart(CUSTOM_PART);
  const out: Record<string, CustomPropertyValue> = {};
  if (!part) return out;
  const root = parseXml(decode(part.data)).root;
  for (const p of childElements(root)) {
    if (p.name.localName !== "property") continue;
    const name = getAttrValue(p, qname("", "name", ""));
    const value = valueOf(p);
    if (name && value !== null) out[name] = value;
  }
  return out;
};

const vtElement = (value: CustomPropertyValue): string =>
  typeof value === "boolean"
    ? `<vt:bool>${value}</vt:bool>`
    : typeof value === "number"
      ? Number.isInteger(value)
        ? `<vt:i4>${value}</vt:i4>`
        : `<vt:r8>${value}</vt:r8>`
      : `<vt:lpwstr>${xmlEscape(value)}</vt:lpwstr>`;

/**
 * Sets a custom property, or removes it with `null`. Other properties keep
 * their place, id and type.
 */
export const setCustomProperty = (
  pres: PresentationData,
  name: string,
  value: CustomPropertyValue | null,
): void => {
  const pkg = pres[INTERNAL_PACKAGE];
  const part = pkg.getPart(CUSTOM_PART);
  const doc = part
    ? parseXml(decode(part.data))
    : parseXml(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Properties xmlns="${NS_CUSTOM}" xmlns:vt="${NS_VT}"></Properties>`,
      );
  const root = doc.root;
  const props = childElements(root).filter(
    (p) => p.name.localName === "property",
  );
  const existing = props.find(
    (p) => getAttrValue(p, qname("", "name", "")) === name,
  );
  if (value === null) {
    if (!existing) return;
    root.children = root.children.filter((n) => n !== existing);
  } else {
    const fresh = parseXml(
      `<property xmlns="${NS_CUSTOM}" xmlns:vt="${NS_VT}" fmtid="${FMTID}" pid="0" name="${xmlEscape(name)}">${vtElement(value)}</property>`,
    ).root;
    fresh.prefixDecls = new Map();
    if (existing) {
      existing.children = fresh.children;
    } else {
      // Property ids start at 2 and stay unique.
      const pid =
        Math.max(
          1,
          ...props.map(
            (p) => Number(getAttrValue(p, qname("", "pid", ""))) || 1,
          ),
        ) + 1;
      fresh.attrs = fresh.attrs.map((a) =>
        a.name.localName === "pid" ? { ...a, value: String(pid) } : a,
      );
      root.children.push(fresh);
    }
  }
  const bytes = encode(serializeXml(doc));
  if (part) {
    part.data = bytes;
    return;
  }
  pkg.addPart(CUSTOM_PART, CUSTOM_CONTENT_TYPE, bytes);
  const rels = pkg.rootRels() ?? emptyRels();
  if (!rels.items.some((r) => r.type === CUSTOM_REL)) {
    rels.items.push({
      id: nextRelId(rels.items.map((r) => r.id)),
      type: CUSTOM_REL,
      target: "docProps/custom.xml",
      targetMode: "Internal",
    });
    pkg.setRootRels(rels);
  }
};

/** The core property `cp:contentStatus` ("Draft", "Final", ...), or null. */
export const getContentStatus = (pres: PresentationData): string | null => {
  const part = pres[INTERNAL_PACKAGE].getPart(CORE_PART);
  if (!part) return null;
  const root = parseXml(decode(part.data)).root;
  const el = firstChildElement(root, qname("cp", "contentStatus", NS_CORE));
  if (!el) return null;
  const value = el.children
    .map((n) => (n.kind === "text" ? n.data : ""))
    .join("")
    .trim();
  return value || null;
};

/** Sets `cp:contentStatus`, or removes it with `null`. */
export const setContentStatus = (
  pres: PresentationData,
  value: string | null,
): void => {
  const pkg = pres[INTERNAL_PACKAGE];
  const part = pkg.getPart(CORE_PART);
  if (!part) {
    if (value === null) return;
    // No core properties yet: the standard writer creates the part.
    throw new Error("the presentation has no core properties part");
  }
  const doc = parseXml(decode(part.data));
  const name = qname("cp", "contentStatus", NS_CORE);
  const existing = firstChildElement(doc.root, name);
  if (value === null) {
    if (!existing) return;
    doc.root.children = doc.root.children.filter((n) => n !== existing);
  } else if (existing) existing.children = [textNode(value)];
  else doc.root.children.push(elem(name, { children: [textNode(value)] }));
  part.data = encode(serializeXml(doc));
};

/** Whether the presentation is marked as final. */
export const isMarkedFinal = (pres: PresentationData): boolean =>
  getCustomProperties(pres)[MARK_AS_FINAL] === true;

/**
 * Marks the presentation as final, or clears the mark. A cleared mark also
 * clears a "Final" content status; any other status is left alone.
 */
export const setMarkedFinal = (pres: PresentationData, on: boolean): void => {
  setCustomProperty(pres, MARK_AS_FINAL, on ? true : null);
  const hasCore = !!pres[INTERNAL_PACKAGE].getPart(CORE_PART);
  if (on && hasCore) setContentStatus(pres, "Final");
  else if (!on && hasCore && getContentStatus(pres) === "Final")
    setContentStatus(pres, null);
};
