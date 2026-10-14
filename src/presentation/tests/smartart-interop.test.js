// Layout definitions that desktop editors lay out again when they open a
// file: each must state the geometry the saved drawing shows. These tests
// pin the definitions' structure, the presentation tree built from them, and
// the drawing's geometry against positions measured in a desktop editor.
import { describe, expect, it } from "vitest";
import { P, createDeck } from "../src/model.js";
import { parseXml } from "../lib/pptx/src/internal/xml/index.ts";
import { layoutDefXml } from "../lib/pptx/src/api/fn/smartart/layout-def.ts";
import {
  buildPresTree,
  layoutNodeForRole,
} from "../lib/pptx/src/api/fn/smartart/pres-tree.ts";
import { layoutSmartArt } from "../lib/pptx/src/api/fn/smartart/compute.ts";
import {
  ringCenterShift,
  ringNodeFraction,
  wheelSlice,
} from "../lib/pptx/src/api/fn/smartart/geometry.ts";

const EMU = 914400;
const defOf = (id, rightToLeft = false) => {
  const info = P.SMARTART_LAYOUTS.find((l) => l.id === id);
  return layoutDefXml({
    id,
    name: info.name,
    description: info.description,
    category: info.category,
    rightToLeft,
  });
};
const elements = (root) => {
  const out = [];
  const walk = (e) => {
    out.push(e);
    for (const c of e.children) if (c.kind === "element") walk(c);
  };
  walk(root);
  return out;
};
const attr = (e, name) =>
  e.attrs.find((a) => a.name.localName === name)?.value ?? null;
const algorithms = (xml) =>
  new Set(
    elements(parseXml(xml).root)
      .filter((e) => e.name.localName === "alg")
      .map((e) => attr(e, "type")),
  );

// The sample most screenshots were measured with.
const SAMPLE = [
  { text: "Plan", level: 0 },
  { text: "Detail", level: 1 },
  { text: "Build", level: 0 },
  { text: "Ship", level: 0 },
];
/** Shapes of a layout in a 8.5 x 4 inch frame placed at (0.7, 1.4) inches on
 *  the slide, as slide-inch rectangles. */
const shapesOf = (layout, items = SAMPLE) =>
  layoutSmartArt(
    { layout, items, colors: "accent1", style: "flat" },
    8.5 * EMU,
    4 * EMU,
  ).map((s) => ({
    ...s,
    r: [0.7 + s.x / EMU, 1.4 + s.y / EMU, s.w / EMU, s.h / EMU],
  }));
const expectNear = (rects, measured, tolerance = 0.1) => {
  expect(rects).toHaveLength(measured.length);
  const left = [...rects];
  for (const m of measured) {
    const i = left.findIndex((r) =>
      r.every((v, k) => Math.abs(v - m[k]) <= tolerance),
    );
    expect(
      i,
      `no shape near ${m.join(", ")} in ${JSON.stringify(left)}`,
    ).toBeGreaterThanOrEqual(0);
    left.splice(i, 1);
  }
};

describe("SmartArt layout definitions", () => {
  for (const layout of P.SMARTART_LAYOUTS)
    for (const rtl of [false, true])
      it(`${layout.id}${rtl ? " (right to left)" : ""}: unique layout node names and resolvable references`, () => {
        const all = elements(parseXml(defOf(layout.id, rtl)).root);
        const names = all
          .filter((e) => e.name.localName === "layoutNode")
          .map((e) => attr(e, "name"));
        // Desktop editors refuse a definition that names two layout nodes
        // alike, even in different branches of a choice.
        expect(new Set(names).size).toBe(names.length);
        const forEach = all.filter((e) => e.name.localName === "forEach");
        const defined = new Set(
          forEach.filter((e) => !attr(e, "ref")).map((e) => attr(e, "name")),
        );
        for (const e of forEach.filter((x) => attr(x, "ref")))
          expect(defined.has(attr(e, "ref"))).toBe(true);
        for (const ch of all.filter((e) => e.name.localName === "choose"))
          expect(
            ch.children.some(
              (c) => c.kind === "element" && c.name.localName === "if",
            ),
          ).toBe(true);
        // Text margins are left to the font: desktop editors ignore others,
        // so text that must sit elsewhere gets a text-only node.
        for (const c of all.filter((e) => e.name.localName === "constr"))
          if (/Marg$/.test(attr(c, "type")))
            expect(attr(c, "refType")).toBe("primFontSz");
      });

  it("uses the standard algorithm each layout calls for", () => {
    const expected = {
      tiles: ["snake", "tx", "sp"],
      "arrow-steps": ["lin", "composite", "sp", "tx"],
      chevrons: ["lin", "composite"],
      ring: ["cycle", "conn", "tx"],
      "block-ring": ["cycle", "conn"],
      "hub-spokes": ["cycle", "conn"],
      "ring-track": ["composite", "cycle", "sp"],
      wheel: ["composite", "sp", "tx"],
      "org-chart": ["hierChild", "hierRoot", "conn"],
      "sideways-tree": ["hierChild", "hierRoot", "conn"],
      "bubble-tree": ["hierChild", "hierRoot", "conn"],
      "layered-blocks": ["lin", "composite"],
      venn: ["composite", "sp", "tx"],
      pyramid: ["pyra", "tx"],
      "inverted-pyramid": ["pyra"],
      quadrants: ["snake"],
      petals: ["snake"],
      "picture-tiles": ["snake", "composite"],
      "rising-steps": ["lin"],
      "stepped-pyramid": ["lin"],
    };
    for (const [id, types] of Object.entries(expected)) {
      const found = algorithms(defOf(id));
      for (const t of types) expect(found, `${id} uses ${t}`).toContain(t);
    }
  });

  it("sizes ring arrows by height and pads them along the gap", () => {
    const xml = defOf("ring");
    // A connector's thickness comes from its parent's height constraint.
    expect(xml).toMatch(
      /<dgm:constr type="h" for="ch" forName="arrow" refType="h" fact="[\d.]+"\/>/,
    );
    expect(xml).toContain(
      '<dgm:constr type="begPad" refType="connDist" fact="0.1"/>',
    );
    // The last item's arrow closes the ring.
    expect(xml).toMatch(
      /axis="followSib" ptType="sibTrans" cnt="1" hideLastTrans="0"/,
    );
    // Node size and ring diameter per item count: three items.
    const k = ringNodeFraction(3);
    expect(xml).toContain(
      `<dgm:constr type="diam" refType="h" fact="${+(1 - k).toFixed(5)}"/>`,
    );
  });

  it("turns mirrored chevrons half way round with upright text", () => {
    const xml = defOf("chevrons", true);
    expect(xml).toContain('<dgm:param type="autoTxRot" val="upr"/>');
    expect(xml).toContain('<dgm:shape rot="180" type="chevron"');
    expect(defOf("chevrons")).not.toContain('rot="180"');
  });
});

describe("SmartArt presentation trees", () => {
  const data = (outline) => {
    let n = 0;
    const node = (t) => {
      const i = n++;
      return {
        id: `n${i}`,
        parTrans: `p${i}`,
        sibTrans: `s${i}`,
        depth: t.depth,
        children: (t.children ?? []).map((c) =>
          node({ ...c, depth: t.depth + 1 }),
        ),
      };
    };
    return outline.map((t) => node({ ...t, depth: 0 }));
  };
  const tree = (layout, outline) => {
    let id = 0;
    return buildPresTree(defOf(layout), "doc", data(outline), () => `x${id++}`);
  };
  const named = (t, name) => t.points.filter((p) => p.name === name);

  it("closes a ring with an arrow after the last item", () => {
    const t = tree("ring", [{}, {}, {}]);
    expect(named(t, "node")).toHaveLength(3);
    expect(named(t, "arrow")).toHaveLength(3);
    // Arrow steps have one fewer arrow than steps.
    const steps = tree("arrow-steps", [{}, {}, {}]);
    expect(named(steps, "arrow")).toHaveLength(2);
  });

  it("follows choices on item counts, positions and depths", () => {
    // Rising steps name each step by its position among the items.
    const steps = tree("rising-steps", [{}, {}, {}]);
    expect(steps.points.map((p) => p.name)).toEqual(
      expect.arrayContaining(["step1", "step2", "step3"]),
    );
    // Layered blocks: a heading for an item with sub-items, leaves for the
    // rest, at every depth.
    const blocks = tree("layered-blocks", [
      { children: [{ children: [{}] }, {}] },
      {},
    ]);
    expect(named(blocks, "topHead")).toHaveLength(1);
    expect(named(blocks, "topLeaf")).toHaveLength(1);
    expect(named(blocks, "head")).toHaveLength(1);
    expect(named(blocks, "leaf")).toHaveLength(2);
    // A hub with sub-items: spokes join it to each of them.
    const hub = tree("hub-spokes", [{ children: [{}, {}, {}] }]);
    expect(named(hub, "hub")).toHaveLength(1);
    expect(named(hub, "satellite")).toHaveLength(3);
    expect(named(hub, "spoke")).toHaveLength(3);
    // Several top-level items: the first is the center, no spokes.
    const several = tree("hub-spokes", [{}, {}, {}]);
    expect(named(several, "center")).toHaveLength(1);
    expect(named(several, "around")).toHaveLength(2);
    expect(named(several, "spoke")).toHaveLength(0);
  });

  it("puts each item's shape formatting on a point of the tree", async () => {
    const { unzipSync, strFromU8 } = await import("fflate");
    for (const layout of P.SMARTART_LAYOUTS) {
      const shapes = layoutSmartArt(
        { layout: layout.id, items: SAMPLE, colors: "accent1", style: "flat" },
        8 * EMU,
        4 * EMU,
      );
      const own = shapes.find(
        (s) =>
          s.item === 0 &&
          s.key &&
          !s.key.includes(":") &&
          layoutNodeForRole(layout.id, s.role),
      );
      if (!own) continue;
      const name = own.key.split("/")[1];
      const pres = createDeck("blank");
      P.addSlideSmartArt(P.getSlides(pres)[0], {
        model: {
          layout: layout.id,
          colors: "accent1",
          style: "flat",
          items: SAMPLE.map((it, i) =>
            i === 0 ? { ...it, format: { [name]: { fill: "#C00000" } } } : it,
          ),
        },
        x: 0,
        y: 0,
        w: 8 * EMU,
        h: 4 * EMU,
      });
      const files = unzipSync(await P.savePresentation(pres));
      const xml = strFromU8(
        files[
          Object.keys(files).find((f) => /diagrams\/data\d+\.xml$/.test(f))
        ],
      );
      const point =
        /<dgm:pt modelId="([^"]+)" type="pres"><dgm:prSet [^>]*presName="([^"]+)"[^>]*>(?:(?!<\/dgm:pt>).)*C00000/.exec(
          xml,
        );
      expect(point, layout.id).not.toBeNull();
      // On the tree: some presParOf connection leads to it.
      expect(xml, layout.id).toContain(`destId="${point[1]}"`);
      expect(layoutNodeForRole(layout.id, own.role)(point[2]), layout.id).toBe(
        true,
      );
    }
  });
});

describe("SmartArt drawing geometry", () => {
  const main = (layout, roles = ["node", "hub", "text", "venn"]) =>
    shapesOf(layout)
      .filter((s) => roles.includes(s.role) && s.paras?.length)
      .map((s) => s.r);

  // Positions (slide inches) a desktop editor gave the same diagram from
  // its layout definition.
  it("rings center their bounding box and join neighbors edge to edge", () => {
    expectNear(main("ring"), [
      [4.19, 1.71, 1.5, 1.5],
      [3.08, 3.62, 1.5, 1.5],
      [5.27, 3.62, 1.5, 1.5],
    ]);
    const arrows = shapesOf("ring").filter((s) => s.role === "trans");
    expect(arrows).toHaveLength(3);
    // The arrow from Build back to Ship runs leftward between them.
    const back = arrows[1];
    expect(back.rot).toBeCloseTo(180, 5);
    expect(back.r[0] + back.r[2] / 2).toBeCloseTo(4.95, 1);
    expect(ringCenterShift(3)).toBeCloseTo(0.25, 5);
  });

  it("lays trees out as the hierarchy algorithms do", () => {
    expectNear(main("org-chart"), [
      [2.1, 2.23, 1.71, 0.94],
      [4.1, 2.23, 1.71, 0.94],
      [6.06, 2.23, 1.71, 0.94],
      [2.1, 3.62, 1.71, 0.94],
    ]);
    expectNear(main("sideways-tree"), [
      [3.02, 1.73, 1.71, 0.94],
      [5.19, 1.73, 1.71, 0.94],
      [3.02, 2.94, 1.71, 0.94],
      [3.02, 4.17, 1.71, 0.94],
    ]);
    // A childless sibling tucks in beside its elder's subtree.
    const org = layoutSmartArt(
      {
        layout: "org-chart",
        items: [
          ["CEO", 0],
          ["Ops", 1],
          ["A", 2],
          ["B", 2],
          ["Sales", 1],
        ].map(([text, level]) => ({ text, level })),
        colors: "accent1",
        style: "flat",
      },
      8.5 * EMU,
      4 * EMU,
    ).filter((s) => s.paras?.length);
    const at = (t) => org.find((s) => s.paras[0].text === t);
    const gap = at("Sales").x - (at("Ops").x + at("Ops").w);
    expect(gap / at("Ops").w).toBeCloseTo(0.03 / 0.2, 2);
    expect(at("Sales").x).toBeLessThan(at("B").x + at("B").w);
  });

  it("matches measured hub, ring track, steps and tiles", () => {
    expectNear(main("hub-spokes"), [
      [4.31, 1.4, 1.21, 1.2],
      [4.23, 2.73, 1.37, 1.35],
      [4.31, 4.23, 1.21, 1.21],
    ]);
    expectNear(main("ring-track"), [
      [4.02, 1.54, 1.77, 1.08],
      [2.75, 3.75, 1.75, 1.1],
      [5.31, 3.75, 1.79, 1.1],
    ]);
    expectNear(main("rising-steps"), [
      [6.48, 1.4, 2.77, 4.04],
      [3.54, 2.27, 2.77, 3.15],
      [0.62, 3.12, 2.78, 2.3],
    ]);
    // Tiles come out a few hundredths of an inch narrower.
    expectNear(main("tiles"), [
      [1.73, 1.4, 3.02, 1.85],
      [5.06, 1.4, 3.04, 1.85],
      [3.4, 3.56, 3.02, 1.86],
    ], 0.12);
  });

  it("cuts wheels into slices with labels inside the wheel", () => {
    const s = wheelSlice(0, 3);
    expect([s.start, s.end]).toEqual([270, 30]);
    for (let i = 0; i < 6; i++) {
      const t = wheelSlice(i, 6).text;
      expect(t.x).toBeGreaterThanOrEqual(0);
      expect(t.y).toBeGreaterThanOrEqual(0);
      expect(t.x + t.w).toBeLessThanOrEqual(1);
      expect(t.y + t.h).toBeLessThanOrEqual(1);
    }
  });

  it("starts text with sub-points at the top left", async () => {
    const pres = createDeck("blank");
    P.addSlideSmartArt(P.getSlides(pres)[0], {
      model: {
        layout: "tiles",
        items: SAMPLE,
        colors: "accent1",
        style: "flat",
      },
      x: 0,
      y: 0,
      w: 8 * EMU,
      h: 4 * EMU,
    });
    const { unzipSync, strFromU8 } = await import("fflate");
    const files = unzipSync(await P.savePresentation(pres));
    const drawing = strFromU8(
      files[
        Object.keys(files).find((f) => /diagrams\/drawing\d+\.xml$/.test(f))
      ],
    );
    const plan = drawing.slice(0, drawing.indexOf(">Plan<"));
    const body = plan.slice(plan.lastIndexOf("<a:bodyPr"));
    expect(body).toContain('anchor="t"');
    expect(body).toMatch(/<a:pPr marL="0" lvl="0" indent="0" algn="l"/);
    const build = drawing.slice(0, drawing.indexOf(">Build<"));
    expect(build.slice(build.lastIndexOf("<a:bodyPr"))).toContain(
      'anchor="ctr"',
    );
  });
});
