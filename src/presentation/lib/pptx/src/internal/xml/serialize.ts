// XML serializer for the AST in `./ast.ts`.
//
// Goals:
//
//   - Round-trip fidelity. Element/attribute order and prefix choices on the
//     way out match the way in (provided the AST hasn't been mutated to break
//     that). Existing declarations and attribute order are preserved. Added
//     or moved names get missing declarations or a non-conflicting prefix;
//     their namespace URI must survive serialization.
//   - Predictable output for hand-built ASTs. Authoring-time code can assume
//     the same input element produces the same byte sequence.
//   - Escape rules tight enough for .pptx readers to accept the output: the
//     predefined entities, numeric references for the whitespace controls that
//     attribute-value normalization would otherwise eat (tab / LF / CR), and a
//     hard reject for the C0 control characters XML 1.0 forbids outright.
//
// Out of scope:
//
//   - Pretty-printing. OOXML files are usually compact-on-write because most
//     producers don't pretty-print. A future option could add indent if
//     someone really wants it, but the round-trip story is cleaner without.

import type { QName, XmlDocument, XmlElement, XmlNode } from "./ast.ts";
import { NS } from "./namespaces.ts";

// XML 1.0 forbids the C0 control characters except tab (0x09), LF (0x0A), and
// CR (0x0D). Unlike most escapable characters these cannot be rescued with a
// numeric reference either — `&#0;` … `&#8;` are themselves illegal because the
// referenced code point is not a legal `Char` (XML 1.0 §2.2). A value carrying
// one can only have entered through authoring input (text pasted from a PDF
// carries form feeds between its pages, say; a parsed document could not have
// held it). Emitting it raw would corrupt the entire .pptx, and refusing it
// would lose the whole edit, so the separators that end a page or a line
// (form feed, vertical tab) become a space and the others, which show
// nothing, are left out.
const forbiddenControlChar = (c: number): boolean =>
  c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d;
const replaceForbiddenControlChar = (c: number): string =>
  c === 0x0b || c === 0x0c ? " " : "";

const escapeAttr = (s: string): string => {
  // Attribute values: escape <, &, and the quote char we use. We always use
  // double quotes, so single quotes pass through. CR and LF must be encoded
  // numerically because XML parsers normalize whitespace in attribute values.
  if (!/[\x00-\x1f<>&"]/.test(s)) return s;
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (forbiddenControlChar(c)) out += replaceForbiddenControlChar(c);
    else if (c === 38) out += "&amp;";
    else if (c === 60) out += "&lt;";
    else if (c === 62) out += "&gt;";
    else if (c === 34) out += "&quot;";
    else if (c === 9) out += "&#9;";
    else if (c === 10) out += "&#10;";
    else if (c === 13) out += "&#13;";
    else out += s[i];
  }
  return out;
};

const escapeText = (s: string): string => {
  if (!/[\x00-\x08\x0b\x0c\x0e-\x1f\r<>&]/.test(s)) return s;
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (forbiddenControlChar(c)) out += replaceForbiddenControlChar(c);
    else if (c === 38) out += "&amp;";
    else if (c === 60) out += "&lt;";
    else if (c === 62) out += "&gt;";
    else if (c === 13) out += "&#13;";
    else out += s[i];
  }
  return out;
};

const rawName = (prefix: string, localName: string): string =>
  prefix === "" ? localName : `${prefix}:${localName}`;

interface NamespaceState {
  bindings: Map<string, string>;
  nextPrefix: number;
}
const namespaceState = (): NamespaceState => ({
  bindings: new Map([
    ["xml", NS.xml],
    ["", ""],
  ]),
  nextPrefix: 1,
});

const boundName = (
  name: QName,
  state: NamespaceState,
  attribute = false,
): boolean =>
  attribute && !name.prefix
    ? !name.namespaceURI
    : state.bindings.get(name.prefix) === name.namespaceURI;

const boundAttributes = (e: XmlElement, state: NamespaceState): boolean => {
  for (const a of e.attrs) if (!boundName(a.name, state, true)) return false;
  return true;
};

interface ElementStart {
  name: string;
  changes: [string, string | undefined][] | undefined;
}

const writeElementStart = (
  e: XmlElement,
  parts: string[],
  state: NamespaceState,
): ElementStart => {
  // Most nodes in an existing part already have valid inherited bindings.
  // Avoid allocating a namespace-repair frame or attribute buffer for them.
  if (
    e.prefixDecls.size === 0 &&
    boundName(e.name, state) &&
    boundAttributes(e, state)
  ) {
    const name = rawName(e.name.prefix, e.name.localName);
    parts.push("<", name);
    for (const a of e.attrs)
      parts.push(
        ` ${rawName(a.name.prefix, a.name.localName)}="${escapeAttr(a.value)}"`,
      );
    return { name, changes: undefined };
  }
  let declarations = e.prefixDecls;
  let changes: [string, string | undefined][] | undefined;
  const bind = (prefix: string, uri: string): void => {
    const previous = state.bindings.get(prefix);
    if (previous === uri) return;
    (changes ??= []).push([prefix, previous]);
    state.bindings.set(prefix, uri);
  };
  for (const [prefix, uri] of declarations) {
    if (
      (prefix === "xml") !== (uri === NS.xml) ||
      prefix === "xmlns" ||
      uri === NS.xmlns
    )
      throw new Error("Reserved XML namespace bindings cannot be changed");
    if (prefix && !uri)
      throw new Error("A namespace prefix cannot be bound to an empty URI");
    bind(prefix, uri);
  }
  const declare = (prefix: string, uri: string): void => {
    if (declarations === e.prefixDecls) declarations = new Map(declarations);
    declarations.set(prefix, uri);
    bind(prefix, uri);
  };
  const nameOf = (q: QName, attribute = false): string => {
    const uri = q.namespaceURI;
    let prefix = q.prefix;
    if (!uri) {
      if (prefix) throw new Error("A prefixed XML name needs a namespace URI");
      if (!attribute && state.bindings.get("")) {
        if (e.prefixDecls.get(""))
          throw new Error(
            "An unqualified element conflicts with its default namespace",
          );
        declare("", "");
      }
      return q.localName;
    }
    if (uri === NS.xml) return rawName("xml", q.localName);
    if (uri === NS.xmlns || prefix === "xmlns")
      throw new Error("Namespace declarations cannot be ordinary XML names");
    if ((!attribute || prefix) && state.bindings.get(prefix) === uri)
      return rawName(prefix, q.localName);
    if (
      (!attribute || prefix) &&
      !state.bindings.get(prefix) &&
      prefix !== "xml"
    ) {
      declare(prefix, uri);
      return rawName(prefix, q.localName);
    }
    // Do not rebind a conflicting prefix: extension attribute values can use
    // it as a QName or prefix list (for example mc:Ignorable and Requires).
    const existing = [...state.bindings].find(
      ([p, bound]) => p && bound === uri,
    );
    if (existing) prefix = existing[0];
    else {
      do {
        prefix = `ns${state.nextPrefix++}`;
      } while (state.bindings.has(prefix));
      declare(prefix, uri);
    }
    return rawName(prefix, q.localName);
  };
  const name = nameOf(e.name);
  const attributes = e.attrs.map(
    (a) => ` ${nameOf(a.name, true)}="${escapeAttr(a.value)}"`,
  );
  parts.push("<");
  parts.push(name);
  for (const [prefix, uri] of declarations) {
    const decl = prefix === "" ? "xmlns" : `xmlns:${prefix}`;
    parts.push(` ${decl}="${escapeAttr(uri)}"`);
  }
  for (const a of attributes) parts.push(a);
  return { name, changes };
};

const writeElement = (
  element: XmlElement,
  parts: string[],
  state: NamespaceState,
): void => {
  const stack: (ElementStart & { element: XmlElement; index: number })[] = [];
  const active = new Set<XmlElement>();
  const restore = (changes: ElementStart["changes"]): void => {
    for (let i = (changes?.length ?? 0) - 1; i >= 0; i--) {
      const [prefix, previous] = changes![i]!;
      if (previous === undefined) state.bindings.delete(prefix);
      else state.bindings.set(prefix, previous);
    }
  };
  const enter = (element: XmlElement): void => {
    if (active.has(element)) throw new Error("Cyclic XML element tree");
    const start = writeElementStart(element, parts, state);
    if (!element.children.length) {
      parts.push("/>");
      restore(start.changes);
    } else {
      parts.push(">");
      active.add(element);
      stack.push({ ...start, element, index: 0 });
    }
  };
  enter(element);
  while (stack.length) {
    const frame = stack[stack.length - 1]!;
    const child = frame.element.children[frame.index++];
    if (child) {
      if (child.kind === "element") enter(child);
      else writeNode(child, parts, state);
    } else {
      parts.push("</", frame.name, ">");
      restore(frame.changes);
      active.delete(frame.element);
      stack.pop();
    }
  }
};

const writeNode = (
  n: XmlNode,
  parts: string[],
  state: NamespaceState,
): void => {
  switch (n.kind) {
    case "element":
      writeElement(n, parts, state);
      return;
    case "text":
      parts.push(escapeText(n.data));
      return;
    case "cdata":
      // CDATA may not contain `]]>`. The canonical workaround is to break the
      // illegal sequence by ending one CDATA section and starting another:
      // replace `]]>` with `]]]]><![CDATA[>` (which re-parses as `]]` followed
      // by `>`). The result is two adjacent CDATA sections whose concatenated
      // content equals the original. CR also needs a reference outside CDATA
      // so XML input normalization cannot change an authored CR to LF.
      parts.push("<![CDATA[");
      parts.push(
        n.data
          .split("]]>")
          .join("]]]]><![CDATA[>")
          .replace(/\r/g, "]]>&#13;<![CDATA["),
      );
      parts.push("]]>");
      return;
    case "comment":
      parts.push("<!--");
      parts.push(n.data);
      parts.push("-->");
      return;
    case "pi":
      parts.push("<?");
      parts.push(n.target);
      if (n.data.length > 0) {
        parts.push(" ");
        parts.push(n.data);
      }
      parts.push("?>");
      return;
  }
};

const writeDeclaration = (doc: XmlDocument, parts: string[]): void => {
  if (!doc.decl) return;
  parts.push('<?xml version="');
  parts.push(escapeAttr(doc.decl.version));
  parts.push('"');
  if (doc.decl.encoding !== undefined) {
    parts.push(' encoding="');
    parts.push(escapeAttr(doc.decl.encoding));
    parts.push('"');
  }
  if (doc.decl.standalone !== undefined) {
    parts.push(' standalone="');
    parts.push(doc.decl.standalone);
    parts.push('"');
  }
  parts.push("?>");
};

export const serializeXml = (
  doc: XmlDocument,
  options: { standaloneDeclaration?: boolean } = {},
): string => {
  const parts: string[] = [];
  if (doc.decl) {
    writeDeclaration(doc, parts);
  } else if (options.standaloneDeclaration ?? true) {
    // OOXML parts MUST start with an XML declaration. Add a sensible default
    // when the AST doesn't carry one (typical for hand-built trees).
    parts.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
  }
  const state = namespaceState();
  for (const p of doc.prolog) writeNode(p, parts, state);
  writeElement(doc.root, parts, state);
  for (const e of doc.epilog) writeNode(e, parts, state);
  return parts.join("");
};

// Serialize a single element with no declaration / document wrapper. Useful in
// tests and when emitting fragments that get inlined into a larger document.
export const serializeFragment = (element: XmlElement): string => {
  const parts: string[] = [];
  writeElement(element, parts, namespaceState());
  return parts.join("");
};

export const _internalsForTest = { escapeAttr, escapeText };
