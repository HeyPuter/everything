import { describe, expect, it, vi } from "vitest";
import { P, createDeck } from "../src/model.js";
import { createTextFieldCopy } from "../lib/pptx/src/api/fn/text-field-copy.ts";
import { copyPartGraph } from "../lib/pptx/src/internal/parts/copy-graph.ts";
import { OpcPackage } from "../lib/pptx/src/internal/parts/index.ts";
import { readShapeDiagram } from "../lib/pptx/src/api/fn/diagram-read.ts";
import { importSlideTemplates } from "../lib/pptx/src/api/fn/template-import.ts";
import { LAYOUT_PART } from "../lib/pptx/src/api/_internal-symbols.ts";
import { SLD_ID_MAX } from "../lib/pptx/src/api/fn/_helpers.ts";
import {
  NS,
  parseXml,
  serializeFragment,
  getAttrValue,
  qname,
} from "../lib/pptx/src/internal/xml/index.ts";
import {
  copyFieldIds,
  fieldXml,
  fieldToken,
  nativeFields,
  partFields,
  shapeFields,
  textFieldCopyDeck,
} from "./text-field-copy-fixture.js";
import { diagramRangeDeck } from "./diagram-range-fixture.js";

const snapshot = (p) =>
  P._internalPackageOf(p).parts.map((part) => [part.name, part.data.slice()]);
const tokens = (fields) => fields.map(fieldToken);
const normalized = (field) => {
  const copy = structuredClone(field);
  copy.attrs = copy.attrs.filter(
    (a) => a.name.namespaceURI !== "" || a.name.localName !== "id",
  );
  return serializeFragment(copy);
};
const validToken = (id) =>
  expect(id).toMatch(
    /^\{[\dA-F]{8}-[\dA-F]{4}-4[\dA-F]{3}-[89AB][\dA-F]{3}-[\dA-F]{12}\}$/,
  );
function inspect(slide) {
  const shapes = P.getSlideShapes(slide),
    fields = shapes.flatMap(shapeFields),
    diagram = readShapeDiagram(shapes.find(P.isDiagramShape));
  const data = partFields(diagram.data.part),
    drawing = partFields(diagram.drawing.part);
  expect(data).toHaveLength(1);
  expect(drawing).toHaveLength(1);
  expect(fieldToken(drawing[0]).toUpperCase()).toBe(
    fieldToken(data[0]).toUpperCase(),
  );
  return [...fields, ...data];
}
describe("native field identities during copying", () => {
  it("preserves every source field and its cache through unchanged export/reopen", async () => {
    const { p, slide } = await textFieldCopyDeck(),
      expected = inspect(slide).map(serializeFragment),
      before = snapshot(p),
      loaded = await P.loadPresentation(await P.savePresentation(p));
    expect(inspect(P.getSlides(loaded)[0]).map(serializeFragment)).toEqual(
      expected,
    );
    expect(snapshot(p)).toEqual(before);
  });
  it.each(["text", "table", "group"])(
    "rebases all native fields in a copied %s without changing their content or source",
    async (kind) => {
      const { p, slide } = await textFieldCopyDeck({ group: kind === "group" }),
        source = P.getSlideShapes(slide)[kind === "table" ? 2 : 1],
        original = shapeFields(source),
        before = P.getShapeXmlString(source),
        copied = P.copyShape(slide, source),
        fields = shapeFields(copied);
      expect(fields).toHaveLength(kind === "group" ? 2 : 1);
      fields.forEach((field, i) => {
        validToken(fieldToken(field));
        expect(fieldToken(field)).not.toBe(fieldToken(original[i]));
        expect(normalized(field)).toBe(normalized(original[i]));
      });
      expect(new Set(tokens(fields))).toHaveLength(fields.length);
      expect(P.getShapeXmlString(source)).toBe(before);
      const loaded = await P.loadPresentation(await P.savePresentation(p));
      expect(
        shapeFields(
          P.getSlideShapes(P.getSlides(loaded)[0]).find(
            (shape) => P.getShapeId(shape) === P.getShapeId(copied),
          ),
        ).map(serializeFragment),
      ).toEqual(fields.map(serializeFragment));
    },
  );
  it("duplicates a slide with independent field identities and matching diagram cache tokens", async () => {
    const { p, slide } = await textFieldCopyDeck(),
      originals = inspect(slide),
      before = snapshot(p),
      duplicate = P.duplicateSlide(p, slide),
      copies = inspect(duplicate);
    expect(copies).toHaveLength(3);
    copies.forEach((field, i) => {
      validToken(fieldToken(field));
      expect(fieldToken(field)).not.toBe(fieldToken(originals[i]));
      expect(normalized(field)).toBe(normalized(originals[i]));
    });
    expect(new Set([...tokens(originals), ...tokens(copies)])).toHaveLength(6);
    const pkg = P._internalPackageOf(p);
    for (const [name, bytes] of before.filter(
      ([name]) =>
        name.includes("assets/") || name === P.getSlidePartName(slide),
    ))
      expect(pkg.getPart(name).data).toEqual(bytes);
    const loaded = await P.loadPresentation(await P.savePresentation(p));
    expect(tokens(inspect(P.getSlides(loaded).at(-1)))).toEqual(tokens(copies));
  });
  it("rejects exhausted slide identities before copying any diagram dependencies", async () => {
    const { p } = await textFieldCopyDeck(),
      part = P._internalPackageOf(p).getPart("/ppt/presentation.xml");
    part.data = new TextEncoder().encode(
      new TextDecoder()
        .decode(part.data)
        .replace(/<p:sldId id="\d+"/, `<p:sldId id="${SLD_ID_MAX}"`),
    );
    const loaded = await P.loadPresentation(await P.savePresentation(p)),
      before = snapshot(loaded);
    expect(() => P.duplicateSlide(loaded, P.getSlides(loaded)[0])).toThrow(
      "allocator exhausted",
    );
    expect(snapshot(loaded)).toEqual(before);
  });
  it.each([false, true])(
    "imports and returns fields with consistent native identity, preservation=%s",
    async (preserve) => {
      const { p, slide } = await textFieldCopyDeck(),
        before = snapshot(p),
        original = inspect(slide),
        target = createDeck("blank"),
        forward = P.importSlide(target, slide, P.getSlideLayouts(target)[0], {
          preserveTextFormatting: preserve,
          preservePaintFormatting: preserve,
        });
      expect(tokens(inspect(forward))).toEqual(tokens(original));
      const forwardFields = inspect(forward);
      expect(snapshot(p)).toEqual(before);
      const returned = P.importSlide(p, forward, P.getSlideLayouts(p)[0], {
          preserveTextFormatting: preserve,
          preservePaintFormatting: preserve,
        }),
        copies = inspect(returned);
      copies.forEach((field, i) => {
        validToken(fieldToken(field));
        expect(fieldToken(field)).not.toBe(fieldToken(original[i]));
        expect(normalized(field)).toBe(normalized(forwardFields[i]));
      });
      expect(new Set([...tokens(original), ...tokens(copies)])).toHaveLength(6);
      const loaded = await P.loadPresentation(await P.savePresentation(p));
      expect(tokens(inspect(P.getSlides(loaded).at(-1)))).toEqual(
        tokens(copies),
      );
    },
  );
  it("keeps diagram data and saved drawing identities synchronized on repeated shape copies", async () => {
    const { p, slide } = await textFieldCopyDeck(),
      frame = P.getSlideShapes(slide)[0],
      source = snapshot(p),
      original = readShapeDiagram(frame);
    const copied = [
      frame,
      P.copyShape(slide, frame),
      P.copyShape(slide, frame),
    ].map(readShapeDiagram);
    const ids = copied.map((diagram) => {
      const data = partFields(diagram.data.part)[0],
        drawing = partFields(diagram.drawing.part)[0];
      expect(fieldToken(data).toUpperCase()).toBe(
        fieldToken(drawing).toUpperCase(),
      );
      expect(normalized(data)).toBe(
        normalized(partFields(original.data.part)[0]),
      );
      return fieldToken(data);
    });
    expect(new Set(ids)).toHaveLength(3);
    expect(original.data.part.data).toEqual(
      source.find(([name]) => name === original.data.part.name)[1],
    );
  });
  it("detaches shared diagram fields when editing, preserving the unedited source identity", async () => {
    const { p, frame } = await diagramRangeDeck(),
      slide = P.getSlides(p)[0],
      peer = P.copyShape(slide, frame),
      original = readShapeDiagram(frame),
      copied = readShapeDiagram(peer),
      pkg = P._internalPackageOf(p),
      rels = pkg.getRels(P.getSlidePartName(slide));
    rels.items.find((r) => r.target === copied.data.part.name).target =
      original.data.part.name;
    pkg.setRels(P.getSlidePartName(slide), rels);
    const loaded = await P.loadPresentation(await P.savePresentation(p)),
      [a, b] = P.getSlideShapes(P.getSlides(loaded)[0]),
      source = readShapeDiagram(a).data.part.data.slice();
    P.replaceShapeDiagramText(b, [
      {
        modelId: "node0",
        text: "Title!\nBody 1 line\nTail",
        edits: [{ start: 5, end: 5, text: "!" }],
      },
    ]);
    const first = partFields(readShapeDiagram(a).data.part)[0],
      second = partFields(readShapeDiagram(b).data.part)[0];
    expect(fieldToken(second)).not.toBe(fieldToken(first));
    validToken(fieldToken(second));
    expect(normalized(second)).toBe(normalized(first));
    expect(readShapeDiagram(a).data.part.data).toEqual(source);
  });
  it("rebases template fields against destination tokens and keeps returned layout models current", async () => {
    const { p, slide } = await textFieldCopyDeck(),
      pkg = P._internalPackageOf(p),
      layoutName = P.getSlideLayoutPartName(P.getSlideLayout(slide)),
      part = pkg.getPart(layoutName),
      box = serializeFragment(
        parseXml(P.getShapeXmlString(P.getSlideShapes(slide)[1])).root,
      );
    const templateId = "{01369490-6323-4C60-9441-1AEC41729A4F}",
      masterId = "{53969266-3F9D-49AE-98B6-B14B53FD521D}",
      // The layout and master carry their own date and number fields; the
      // field added here is the last one in each.
      layoutFields = partFields(part).length,
      master = pkg.getPart(P.getSlideMasterPartName(slide));
    part.data = new TextEncoder().encode(
      new TextDecoder()
        .decode(part.data)
        .replace(
          "</p:spTree>",
          box.replace(copyFieldIds[0], templateId) + "</p:spTree>",
        ),
    );
    master.data = new TextEncoder().encode(
      new TextDecoder()
        .decode(master.data)
        .replace(
          "</p:spTree>",
          box.replace(copyFieldIds[0], masterId) + "</p:spTree>",
        ),
    );
    const before = snapshot(p),
      [layout, repeated] = importSlideTemplates(p, [slide, slide]),
      copied = partFields(pkg.getPart(P.getSlideLayoutPartName(layout)));
    expect(copied).toHaveLength(layoutFields + 1);
    expect(fieldToken(copied.at(-1))).not.toBe(templateId);
    validToken(fieldToken(copied.at(-1)));
    expect(normalized(copied.at(-1))).toBe(normalized(partFields(part).at(-1)));
    expect(tokens(nativeFields(layout[LAYOUT_PART].root))).toEqual(
      tokens(copied),
    );
    expect(P.getSlideLayoutPartName(repeated)).toBe(
      P.getSlideLayoutPartName(layout),
    );
    const imported = P.importSlide(p, slide, layout, {
        preserveGeometry: false,
      }),
      masterCopy = partFields(pkg.getPart(P.getSlideMasterPartName(imported)));
    expect(masterCopy).toHaveLength(partFields(master).length);
    validToken(fieldToken(masterCopy.at(-1)));
    expect(fieldToken(masterCopy.at(-1))).not.toBe(masterId);
    expect(fieldToken(masterCopy.at(-1))).not.toBe(fieldToken(copied.at(-1)));
    expect(normalized(masterCopy.at(-1))).toBe(
      normalized(partFields(master).at(-1)),
    );
    expect(part.data).toEqual(before.find(([name]) => name === layoutName)[1]);
  });
});

describe("field copy token reservation", () => {
  const put = (p, name, xml, type = "application/xml") =>
    p.addPart(name, type, new TextEncoder().encode(xml));
  const body = (content) => `<a:p xmlns:a="${NS.dml}">${content}</a:p>`;
  it("reserves case-insensitive GUID values and maps repeated representations only once", () => {
    const p = OpcPackage.empty();
    put(p, "/old.xml", body(fieldXml(copyFieldIds[0].toLowerCase())));
    const context = createTextFieldCopy(p),
      roots = [
        parseXml(body(fieldXml(copyFieldIds[0]))).root,
        parseXml(body(fieldXml(copyFieldIds[0].toLowerCase()))).root,
      ];
    roots.forEach((root) => expect(context.rewrite(root)).toBe(true));
    const ids = roots.map((root) => fieldToken(nativeFields(root)[0]));
    validToken(ids[0]);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[0]).not.toBe(copyFieldIds[0]);
  });
  it("retries generated tokens that collide with other destination fields", () => {
    const p = OpcPackage.empty();
    put(
      p,
      "/old.xml",
      body(
        fieldXml(copyFieldIds[0]) +
          fieldXml("{00000000-0000-4000-8000-000000000000}"),
      ),
    );
    let calls = 0;
    const random = vi
      .spyOn(crypto, "getRandomValues")
      .mockImplementation((array) => {
        array.fill(0);
        if (calls++) array[0] = 1;
        return array;
      });
    try {
      const doc = parseXml(body(fieldXml(copyFieldIds[0])));
      createTextFieldCopy(p).rewrite(doc.root);
      expect(fieldToken(nativeFields(doc.root)[0])).toBe(
        "{01000000-0000-4000-8000-000000000000}",
      );
      expect(calls).toBe(2);
    } finally {
      random.mockRestore();
    }
  });
  it("keeps binary, malformed, missing-ID and foreign fields opaque and byte-identical", () => {
    const p = OpcPackage.empty(),
      input = [
        put(
          p,
          "/binary.bin",
          body(fieldXml(copyFieldIds[0])),
          "application/octet-stream",
        ),
        put(p, "/broken.xml", "<a:fld>"),
        put(
          p,
          "/foreign.xml",
          `<x:fld xmlns:x="urn:foreign" id="${copyFieldIds[0]}"/>`,
        ),
        put(p, "/invalid.xml", body('<a:fld id="not-a-guid"/><a:fld/>')),
      ],
      context = createTextFieldCopy(p);
    for (const part of input) expect(context.bytes(part)).toBe(part.data);
  });
  it("retains non-conflicting IDs and snapshots the destination before copied parts are added", () => {
    const p = OpcPackage.empty(),
      context = createTextFieldCopy(p),
      part = put(p, "/copied.xml", body(fieldXml(copyFieldIds[0])));
    expect(context.bytes(part)).toBe(part.data);
    const doc = parseXml(body(fieldXml(copyFieldIds[0])));
    expect(context.rewrite(doc.root)).toBe(false);
    expect(fieldToken(nativeFields(doc.root)[0])).toBe(copyFieldIds[0]);
  });
  it("prepares copy transforms atomically and keeps binary dependencies and source buffers independent", () => {
    const source = OpcPackage.empty(),
      target = OpcPackage.empty(),
      a = put(source, "/a.xml", body(fieldXml(copyFieldIds[0])));
    put(source, "/b.bin", "binary", "application/octet-stream");
    source.setRels(a.name, {
      items: [
        {
          id: "dep",
          type: "urn:owned",
          target: "b.bin",
          targetMode: "Internal",
        },
      ],
    });
    const before = target.save();
    expect(() =>
      copyPartGraph(source, target, [a.name], (part) => {
        if (part.name === "/b.bin") throw new Error("owned transform failure");
        return part.data;
      }),
    ).toThrow("owned transform failure");
    expect(target.save()).toEqual(before);
    const context = createTextFieldCopy(target),
      names = copyPartGraph(source, target, [a.name], context.bytes);
    expect(target.getPart(names.get(a.name)).data).toEqual(a.data);
    expect(target.getPart(names.get(a.name)).data).not.toBe(a.data);
    expect(
      new TextDecoder().decode(target.getPart(names.get("/b.bin")).data),
    ).toBe("binary");
  });
  it("rewrites qualified fields without changing foreign field elements or qualified id attributes", () => {
    const p = OpcPackage.empty();
    put(p, "/old.xml", body(fieldXml(copyFieldIds[0])));
    const doc = parseXml(
        `<a:p xmlns:a="${NS.dml}" xmlns:x="urn:foreign">${fieldXml(copyFieldIds[0]).replace(" type=", ' x:id="opaque" type=')}<x:fld id="${copyFieldIds[0]}"/></a:p>`,
      ),
      foreign = serializeFragment(doc.root.children.at(-1));
    expect(createTextFieldCopy(p).rewrite(doc.root)).toBe(true);
    expect(serializeFragment(doc.root.children.at(-1))).toBe(foreign);
    expect(
      getAttrValue(nativeFields(doc.root)[0], qname("x", "id", "urn:foreign")),
    ).toBe("opaque");
  });
  it("reserves a large field set once and assigns unique tokens across copied parts", () => {
    const p = OpcPackage.empty(),
      ids = Array.from({ length: 2048 }, (_, i) =>
        `{${i.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111}`.toUpperCase(),
      ),
      part = put(p, "/large.xml", body(ids.map((id) => fieldXml(id)).join(""))),
      context = createTextFieldCopy(p),
      first = context.bytes(part),
      second = context.bytes(part),
      copiedIds = tokens(
        nativeFields(parseXml(new TextDecoder().decode(first)).root),
      );
    expect(copiedIds).toHaveLength(ids.length);
    expect(new Set(copiedIds)).toHaveLength(ids.length);
    expect(copiedIds.some((id) => ids.includes(id))).toBe(false);
    expect(first).toEqual(second);
  });
});
