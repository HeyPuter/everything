import { describe, expect, it } from "vitest";
import {
  NS,
  XmlParseError,
  allChildElements,
  attr,
  cdata,
  comment,
  elem,
  firstChildElement,
  getAttrValue,
  parseFragment,
  parseXml,
  pi,
  qname,
  serializeFragment,
  serializeXml,
  text,
  textContent,
  walkElements,
} from "./index.ts";

describe("parseXml", () => {
  it("parses the XML declaration", () => {
    const doc = parseXml(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><root/>',
    );
    expect(doc.decl).toEqual({
      version: "1.0",
      encoding: "UTF-8",
      standalone: "yes",
    });
    expect(doc.root.name.localName).toBe("root");
    expect(doc.root.children).toEqual([]);
  });

  it("handles a missing declaration", () => {
    const doc = parseXml("<root/>");
    expect(doc.decl).toBeNull();
  });

  it("resolves prefix declarations on the same element", () => {
    const doc = parseXml('<p:root xmlns:p="urn:p"/>');
    expect(doc.root.name).toEqual({
      prefix: "p",
      localName: "root",
      namespaceURI: "urn:p",
    });
    expect(doc.root.prefixDecls.get("p")).toBe("urn:p");
  });

  it("resolves default namespace for unqualified elements", () => {
    const doc = parseXml('<root xmlns="urn:default"><child/></root>');
    expect(doc.root.name.namespaceURI).toBe("urn:default");
    const child = doc.root.children[0];
    if (child?.kind !== "element") throw new Error("expected child element");
    expect(child.name.namespaceURI).toBe("urn:default");
  });

  it("does NOT apply default namespace to unqualified attributes", () => {
    const doc = parseXml('<root xmlns="urn:default" attr="v"/>');
    expect(doc.root.attrs[0]?.name.namespaceURI).toBe("");
  });

  it("resolves nested prefix scopes correctly", () => {
    const doc = parseXml(
      '<a:r xmlns:a="urn:a"><a:c xmlns:b="urn:b"><b:c/></a:c></a:r>',
    );
    const ac = doc.root.children[0];
    if (ac?.kind !== "element") throw new Error("expected element");
    const bc = ac.children[0];
    if (bc?.kind !== "element") throw new Error("expected element");
    expect(bc.name.namespaceURI).toBe("urn:b");
  });

  it("throws on unbound prefix", () => {
    expect(() => parseXml("<a:r/>")).toThrow(XmlParseError);
  });

  it("throws on mismatched closing tag", () => {
    expect(() => parseXml("<a></b>")).toThrow(XmlParseError);
  });

  it("preserves attribute order", () => {
    const doc = parseXml('<r a="1" b="2" c="3"/>');
    expect(doc.root.attrs.map((x) => x.name.localName)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("decodes the five predefined entities", () => {
    const doc = parseXml("<r>&amp;&lt;&gt;&quot;&apos;</r>");
    expect(textContent(doc.root)).toBe("&<>\"'");
  });

  it("decodes numeric character references", () => {
    const doc = parseXml("<r>&#65;&#x41;&#x1F600;</r>");
    expect(textContent(doc.root)).toBe("AA\u{1F600}");
  });

  it("parses CDATA sections", () => {
    const doc = parseXml('<r><![CDATA[<not an="element"/>]]></r>');
    const c = doc.root.children[0];
    if (c?.kind !== "cdata") throw new Error("expected CDATA");
    expect(c.data).toBe('<not an="element"/>');
  });

  it("parses comments and processing instructions", () => {
    const doc = parseXml(
      "<!-- before --><?greet hello?><r><!-- inside --></r>",
    );
    expect(doc.prolog.length).toBe(2);
    expect(doc.prolog[0]?.kind).toBe("comment");
    expect(doc.prolog[1]?.kind).toBe("pi");
    expect(doc.root.children[0]?.kind).toBe("comment");
  });

  it("rejects unsupported DOCTYPE internal subset", () => {
    expect(() => parseXml("<!DOCTYPE r [<!ELEMENT r EMPTY>]><r/>")).toThrow(
      XmlParseError,
    );
  });

  it("skips a leading BOM", () => {
    const doc = parseXml(`﻿<?xml version="1.0"?><r/>`);
    expect(doc.root.name.localName).toBe("r");
  });

  it("handles empty elements with attributes", () => {
    const doc = parseXml('<r a="1"/>');
    expect(doc.root.children).toEqual([]);
    expect(doc.root.attrs[0]?.value).toBe("1");
  });

  it("parses an OOXML-style multi-namespace fragment", () => {
    const xml =
      '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"' +
      ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"' +
      ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      "<p:cSld><p:spTree><a:r/></p:spTree></p:cSld></p:sld>";
    const sld = parseFragment(xml);
    expect(sld.name.namespaceURI).toBe(NS.pml);
    const cSld = firstChildElement(sld, qname("p", "cSld", NS.pml));
    expect(cSld?.name.localName).toBe("cSld");
  });
});

describe("serializeXml", () => {
  it("round-trips a minimal document", () => {
    const src = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><r/>';
    expect(serializeXml(parseXml(src))).toBe(src);
  });

  it("preserves prefix declarations on the element where they appeared", () => {
    const src = '<p:r xmlns:p="urn:p"><p:c/></p:r>';
    expect(serializeFragment(parseFragment(src))).toBe(src);
  });

  it("escapes special characters in text content", () => {
    const e = elem(qname("", "r", ""), {
      children: [text("a & b < c > \"d\" 'e'")],
    });
    expect(serializeFragment(e)).toBe("<r>a &amp; b &lt; c &gt; \"d\" 'e'</r>");
  });

  it("escapes attribute values strictly", () => {
    const e = elem(qname("", "r", ""), {
      attrs: [attr(qname("", "v", ""), 'a"b<c&d\tnewline\nhere')],
    });
    expect(serializeFragment(e)).toBe(
      '<r v="a&quot;b&lt;c&amp;d&#9;newline&#10;here"/>',
    );
  });

  it("writes well-formed XML for text holding control characters", () => {
    // Text pasted from a PDF separates its pages with form feeds.
    const e = elem(qname("", "r", ""), {
      attrs: [attr(qname("", "v", ""), "Alt\vtext\u0007")],
      children: [text("Page one\fPage two\u0000\u001b")],
    });
    const xml = serializeFragment(e);
    expect(xml).toBe('<r v="Alt text">Page one Page two</r>');
    expect(textContent(parseFragment(xml))).toBe("Page one Page two");
  });

  it("emits self-closing tags only when there are no children", () => {
    const empty = elem(qname("", "r", ""));
    expect(serializeFragment(empty)).toBe("<r/>");
    const withTextChild = elem(qname("", "r", ""), { children: [text("")] });
    expect(serializeFragment(withTextChild)).toBe("<r></r>");
  });

  it("round-trips CDATA, comments, and PIs", () => {
    const src = "<r><![CDATA[<x/>]]><!-- c --><?t d?></r>";
    expect(serializeFragment(parseFragment(src))).toBe(src);
  });

  it("inserts a default declaration when none was present", () => {
    const doc = parseXml("<r/>");
    const out = serializeXml(doc);
    expect(
      out.startsWith('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'),
    ).toBe(true);
  });

  it("splits CDATA containing the close sequence", () => {
    const e = elem(qname("", "r", ""), { children: [cdata("foo ]]> bar")] });
    const out = serializeFragment(e);
    expect(parseFragment(out).children.length).toBeGreaterThan(0);
    // Re-parse and concatenate cdata content to confirm semantics are preserved.
    const reparsed = parseFragment(out);
    let combined = "";
    for (const c of reparsed.children) {
      if (c.kind === "cdata") combined += c.data;
    }
    expect(combined).toBe("foo ]]> bar");
  });
});

describe("query helpers", () => {
  const src = `<p:sld xmlns:p="${NS.pml}" xmlns:a="${NS.dml}"><p:cSld><p:spTree><a:r><a:t>hello</a:t></a:r><a:r><a:t> world</a:t></a:r></p:spTree></p:cSld></p:sld>`;

  it("finds a child element by QName", () => {
    const sld = parseFragment(src);
    const cSld = firstChildElement(sld, qname("p", "cSld", NS.pml));
    expect(cSld?.name.localName).toBe("cSld");
  });

  it("reads attributes ignoring prefix", () => {
    const root = parseFragment('<r xmlns:a="urn:a" a:k="v"/>');
    expect(getAttrValue(root, qname("a", "k", "urn:a"))).toBe("v");
    // Querying with a different prefix but the same URI must still match.
    expect(getAttrValue(root, qname("other", "k", "urn:a"))).toBe("v");
  });

  it("concatenates text content across nested elements", () => {
    const sld = parseFragment(src);
    expect(textContent(sld)).toBe("hello world");
  });

  it("lists all matching child elements", () => {
    const tree = parseFragment(src);
    const cSld = firstChildElement(tree, qname("p", "cSld", NS.pml));
    const spTree = firstChildElement(
      cSld ?? tree,
      qname("p", "spTree", NS.pml),
    );
    const runs = allChildElements(spTree ?? tree, qname("a", "r", NS.dml));
    expect(runs.length).toBe(2);
  });

  it("walks elements depth-first", () => {
    const sld = parseFragment(src);
    const visited: string[] = [];
    walkElements(sld, (e) => {
      visited.push(e.name.localName);
    });
    expect(visited).toEqual(["sld", "cSld", "spTree", "r", "t", "r", "t"]);
  });

  it("supports skipping descent", () => {
    const sld = parseFragment(src);
    const visited: string[] = [];
    walkElements(sld, (e) => {
      visited.push(e.name.localName);
      return e.name.localName !== "spTree";
    });
    expect(visited).toEqual(["sld", "cSld", "spTree"]);
  });
});

describe("round-trip property", () => {
  // For real OOXML-ish inputs, parsing then serializing then parsing again
  // must yield a structurally identical document.
  const cases: string[] = [
    "<r/>",
    '<r a="1" b="2"/>',
    '<r xmlns="urn:default"><c/></r>',
    '<r xmlns:p="urn:p"><p:c p:k="v">text</p:c></r>',
    "<r><![CDATA[<x/>]]></r>",
    "<r>multi  spaces   matter</r>",
    `<mc:AlternateContent xmlns:mc="${NS.mc}" xmlns:p14="urn:p14"><mc:Choice Requires="p14"><p14:newThing/></mc:Choice><mc:Fallback><legacy/></mc:Fallback></mc:AlternateContent>`,
  ];

  for (const src of cases) {
    it(`is idempotent for: ${src.slice(0, 60)}${src.length > 60 ? "..." : ""}`, () => {
      const once = serializeFragment(parseFragment(src));
      const twice = serializeFragment(parseFragment(once));
      expect(twice).toBe(once);
    });
  }

  it("preserves the unknown extension wrapped in mc:AlternateContent", () => {
    const src = `<mc:AlternateContent xmlns:mc="${NS.mc}" xmlns:p14="urn:p14"><mc:Choice Requires="p14"><p14:unknownThing custom="yes"/></mc:Choice><mc:Fallback><legacy/></mc:Fallback></mc:AlternateContent>`;
    const out = serializeFragment(parseFragment(src));
    expect(out).toContain("p14:unknownThing");
    expect(out).toContain("Fallback");
  });

  it("round-trips a comment node and a processing instruction inside content", () => {
    const e = elem(qname("", "r", ""), {
      children: [
        comment(" note "),
        pi("xml-stylesheet", 'href="x"'),
        text("after"),
      ],
    });
    const serialized = serializeFragment(e);
    expect(serialized).toBe(
      '<r><!-- note --><?xml-stylesheet href="x"?>after</r>',
    );
    const reparsed = parseFragment(serialized);
    expect(reparsed.children.length).toBe(3);
    expect(reparsed.children[0]?.kind).toBe("comment");
    expect(reparsed.children[1]?.kind).toBe("pi");
    expect(reparsed.children[2]?.kind).toBe("text");
  });
});
