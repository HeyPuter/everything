// Small XML-building conveniences for authoring code that writes larger
// fixed structures (media timing, OLE frames): parse a fragment written with
// the conventional prefixes, then drop the declarations so the serializer
// binds each prefix once, where it is first needed.

import {
  NS,
  parseFragment,
  type XmlElement,
} from "../../internal/xml/index.ts";

const DECLARATIONS = [
  ["p", NS.pml],
  ["a", NS.dml],
  ["r", NS.officeDocRels],
  ["p14", NS.p14],
  ["a14", NS.a14],
  ["mc", NS.mc],
] as const;

export const escapeXmlAttr = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

const stripDeclarations = (element: XmlElement): XmlElement => {
  element.prefixDecls = new Map();
  for (const child of element.children)
    if (child.kind === "element") stripDeclarations(child);
  return element;
};

/** Parses one element written with p:, a:, r:, p14:, a14: or mc: prefixes. */
export const xmlFragment = (source: string): XmlElement => {
  const wrapped = `<w ${DECLARATIONS.map(([p, uri]) => `xmlns:${p}="${uri}"`).join(" ")}>${source}</w>`;
  const root = parseFragment(wrapped);
  const first = root.children.find((c) => c.kind === "element");
  if (!first || first.kind !== "element")
    throw new Error("xmlFragment: no element");
  return stripDeclarations(first);
};

/** Depth-first search for the first descendant (or self) matching `pred`. */
export const findElement = (
  root: XmlElement,
  pred: (e: XmlElement) => boolean,
): XmlElement | null => {
  if (pred(root)) return root;
  for (const c of root.children)
    if (c.kind === "element") {
      const found = findElement(c, pred);
      if (found) return found;
    }
  return null;
};

export const isNamed = (e: XmlElement, ns: string, local: string): boolean =>
  e.name.namespaceURI === ns && e.name.localName === local;
