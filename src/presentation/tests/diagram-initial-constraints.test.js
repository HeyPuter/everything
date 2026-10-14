import { describe, expect, it } from "vitest";
import native from "./data/diagram-initial-constraints-native.json";
import { sample } from "./diagram-layout-fixture.js";
import { evaluateDiagramInitialConstraints } from "../lib/pptx/src/internal/diagram/initial-constraints.ts";
import { expandDiagramLayout } from "../lib/pptx/src/internal/diagram/layout.ts";
import {
  arrangeDiagramChildren,
  readDiagramArrangement,
} from "../lib/pptx/src/internal/diagram/arrange.ts";
import {
  NS,
  parseXml,
  serializeXml,
} from "../lib/pptx/src/internal/xml/index.ts";

const available = { w: 400, h: 100 };
const property = (
  type,
  relationship = "self",
  name = "",
  pointType = "all",
) => ({
  type,
  selector: { relationship, name, pointType },
});
const document = (body, algorithm = "lin") =>
  parseXml(
    `<d:layoutNode xmlns:d="${NS.diagram}" xmlns:dgm="${NS.diagram}" name="root">
  <d:alg type="${algorithm}"><d:param type="horzAlign" val="none"/><d:param type="vertAlign" val="none"/></d:alg>
  ${body}</d:layoutNode>`,
  );
const expand = (body, algorithm = "lin") =>
  expandDiagramLayout(document(body, algorithm).root, sample().tree);
const child = (name, body = "", algorithm = "sp") =>
  `<d:layoutNode name="${name}"><d:alg type="${algorithm}"/>${body}</d:layoutNode>`;
const list = (constraints) => `<d:constrLst>${constraints}</d:constrLst>`;
const c = (type, rest) => `<d:constr type="${type}" ${rest}/>`;

it("keeps customized font slots separate from an adjusted ancestor ruler", () => {
  const root = expand(
      list(
        c("primFontSz", 'for="ch" forName="query" val="65"') +
          c(
            "h",
            'for="ch" forName="query" refFor="ch" refForName="query" refType="primFontSz" fact="0.6"',
          ),
      ) +
        child(
          "query",
          list(c("lMarg", 'refType="primFontSz" fact="0.1"')),
          "tx",
        ),
    ),
    query = root.children[0],
    before = evaluateDiagramInitialConstraints(root, available),
    result = evaluateDiagramInitialConstraints(root, available, {
      quantizeFonts: true,
      adjustments: [
        {
          owner: root,
          property: property("primFontSz", "ch", "query"),
          value: 16,
        },
      ],
      primaryFontOverrides: new Map([[query, 21.4]]),
    }),
    state = result.get(query);
  expect(
    result.get(root).reference(property("primFontSz", "ch", "query")),
  ).toBe(16);
  expect(state.size.h).toBe(9.6);
  expect(state.values.get("primFontSz")).toBe(21);
  expect(state.values.get("secFontSz")).toBe(17);
  expect(state.values.get("lMarg")).toBe(2.1);
  const scoped = state.evaluateScope().get(query);
  expect(scoped.values.get("primFontSz")).toBe(21);
  expect(scoped.size.h).toBe(9.6);
  expect(before.get(query).values.get("primFontSz")).toBe(65);
});

describe("DiagramML initial constraint evaluation", () => {
  it.each(native.cases)("matches the native reference: $name", (row) => {
    const { tree, document: data } = sample();
    const xml = parseXml(`<dgm:layoutNode xmlns:dgm="${NS.diagram}" name="root">
      <dgm:alg type="${row.algorithm}">${row.algorithm === "composite" || row.alignment === "none" ? '<dgm:param type="horzAlign" val="none"/><dgm:param type="vertAlign" val="none"/>' : ""}</dgm:alg>
      <dgm:constrLst>${row.constraints}</dgm:constrLst>${row.body}</dgm:layoutNode>`);
    const before = [serializeXml(xml), serializeXml(data)];
    const root = expandDiagramLayout(xml.root, tree);
    if (row.rejected) {
      expect(() => evaluateDiagramInitialConstraints(root, available)).toThrow(
        /duplicate|cyclic|unresolved|unavailable/,
      );
    } else {
      const initial = evaluateDiagramInitialConstraints(root, available);
      const preferred = root.children.map((node) => {
        const state = initial.get(node);
        return {
          x: state.coordinates?.l ?? 0,
          y: state.coordinates?.t ?? 0,
          w: state.values.get("w"),
          h: state.values.get("h"),
        };
      });
      const arranged = arrangeDiagramChildren(
        Object.fromEntries(initial.get(root).values),
        preferred,
        readDiagramArrangement(root.algorithm),
      );
      const actual = arranged
        .map((bounds, i) => ({
          name: root.children[i].name,
          context: root.children[i].context.point.id,
          bounds,
        }))
        .filter((r) => r.bounds.w !== 0 || r.bounds.h !== 0);
      expect(actual).toHaveLength(row.expected.length);
      for (const [i, expected] of row.expected.entries()) {
        expect([actual[i].name, actual[i].context]).toEqual([
          expected.name,
          expected.context,
        ]);
        for (const key of ["x", "y", "w", "h"])
          expect(
            Math.abs(
              Math.trunc(actual[i].bounds[key] * 36000) - expected.bounds[key],
            ),
          ).toBeLessThanOrEqual(1);
      }
    }
    expect([serializeXml(xml), serializeXml(data)]).toEqual(before);
  });

  it("retains equality groups, bounds and ordered rules without treating them as base assignments", () => {
    const root = expand(
      child(
        "item",
        list(
          c("w", 'val="30"') +
            c("w", 'op="equ"') +
            c("w", 'op="gte" val="40"') +
            c("w", 'op="lte" val="20"'),
        ) +
          '<d:ruleLst><d:rule type="h" val="INF"/><d:rule type="primFontSz" val="5"/></d:ruleLst>',
      ),
    );
    const state = evaluateDiagramInitialConstraints(root, available).get(
      root.children[0],
    );
    expect(state.values.get("w")).toBe(30);
    expect(state.constraints.map((c) => [c.operator, c.value])).toEqual([
      ["none", 30],
      ["equ", 0],
      ["gte", 40],
      ["lte", 20],
    ]);
    expect(state.rules.map((r) => [r.target.type, r.value])).toEqual([
      ["h", Infinity],
      ["primFontSz", 5],
    ]);
  });

  it("uses caller-supplied defaults and permits explicit constraints to replace them", () => {
    const root = expand(
      child(
        "text",
        list(c("w", 'val="50"') + c("h", 'refType="primFontSz" fact="2"')),
        "tx",
      ),
    );
    const defaults = new Map([["primFontSz", 17]]);
    const result = evaluateDiagramInitialConstraints(root, available, {
      defaults: (node) => (node.name === "text" ? defaults : new Map()),
    });
    defaults.set("primFontSz", 99);
    const state = result.get(root.children[0]);
    expect(state.values.get("h")).toBe(34);
    expect(state.reference(property("primFontSz"))).toBe(17);
    const explicit = expand(
      child(
        "text",
        list(c("primFontSz", 'val="23"') + c("h", 'refType="primFontSz"')),
        "tx",
      ),
    );
    expect(
      evaluateDiagramInitialConstraints(explicit, available, {
        defaults: (node) => (node.name === "text" ? defaults : new Map()),
      })
        .get(explicit.children[0])
        .values.get("h"),
    ).toBe(23);
  });

  it.each(["ch", "des"])(
    "reserves wildcard %s names without inventing reference declarations",
    (relationship) => {
      for (const type of ["w", "h", "userA", "primFontSz"]) {
        const declaration = c(type, `for="${relationship}" val="23"`);
        const root = expand(list(declaration) + child("item", "", "tx"));
        const result = evaluateDiagramInitialConstraints(root, available);
        expect(result.get(root.children[0]).values.get(type)).toBe(23);
        expect(result.get(root).reference(property(type, relationship))).toBe(
          23,
        );
        expect(() =>
          result.get(root).reference(property(type, relationship, "item")),
        ).toThrow("unresolved diagram constraint");
        expect(() =>
          evaluateDiagramInitialConstraints(root, available, {
            changes: [
              {
                owner: root,
                property: property(type, relationship, "item"),
                value: 19,
              },
            ],
          }),
        ).toThrow("unresolved diagram change variable");
        const duplicate = expand(
          list(
            declaration +
              c(type, `for="${relationship}" forName="item" val="19"`),
          ) + child("item", "", "tx"),
        );
        expect(() =>
          evaluateDiagramInitialConstraints(duplicate, available),
        ).toThrow("duplicate diagram constraint binding");
      }
    },
  );

  it("supplies the TX font default without exposing unavailable algorithm properties", () => {
    const root = expand(
      child("text", list(c("h", 'refType="primFontSz"')), "tx"),
    );
    expect(
      evaluateDiagramInitialConstraints(root, available).get(root.children[0])
        .size.h,
    ).toBe(36);
    expect(() =>
      evaluateDiagramInitialConstraints(expand(""), available, {
        defaults: () => new Map([["primFontSz", 17]]),
      }),
    ).toThrow("unavailable diagram default");
  });

  it("separates horizontal, vertical and dimension dependencies to avoid false cycles", () => {
    const constraints = list(
      c("w", 'for="ch" forName="a" val="20"') +
        c("h", 'for="ch" forName="a" refType="w" refFor="ch" refForName="b"') +
        c("l", 'for="ch" forName="a" refType="r" refFor="ch" refForName="b"') +
        c(
          "w",
          'for="ch" forName="b" refType="w" refFor="ch" refForName="a" fact="0.5"',
        ) +
        c("h", 'for="ch" forName="b" val="5"') +
        c("l", 'for="ch" forName="b" val="7"'),
    );
    const root = expand(constraints + child("a") + child("b"), "composite");
    const result = evaluateDiagramInitialConstraints(root, available);
    expect(result.get(root.children[0]).coordinates).toMatchObject({
      l: 17,
      r: 20,
      w: 20,
      h: 10,
    });
    expect(result.get(root.children[1]).coordinates).toMatchObject({
      l: 7,
      w: 10,
      h: 5,
    });
  });

  it("captures preferred dimensions before later children publish their implicit geometry", () => {
    const constraints = list(
      c("l", 'for="ch" forName="a" val="30"') +
        c(
          "h",
          'for="ch" forName="b" refType="w" refFor="ch" refForName="a" fact="0.1"',
        ),
    );
    const root = expand(constraints + child("b") + child("a"), "composite");
    const result = evaluateDiagramInitialConstraints(root, available);
    const first = result.get(root.children[0]);
    expect(first.values.get("h")).toBe(0);
    expect(first.size.h).toBe(0);
    expect(first.coordinates.h).toBe(37);
    expect(result.get(root).reference(property("w", "ch", "a"))).toBe(370);
    const reversed = expand(constraints + child("a") + child("b"), "composite");
    expect(
      evaluateDiagramInitialConstraints(reversed, available)
        .get(reversed.children[1])
        .values.get("h"),
    ).toBe(37);
  });

  it("resolves composite bottom-edge references from the nearest parent's dimension", () => {
    const body =
      list(
        c("h", 'for="des" forName="header" val="32"') +
          c("primFontSz", 'for="des" forName="header" val="16"'),
      ) +
      child(
        "group",
        list(
          c("w", 'val="120"') +
            c("h", 'val="80"') +
            c("h", 'for="ch" forName="header" val="8"') +
            c("t", 'for="ch" forName="header" val="3"') +
            c(
              "t",
              'for="ch" forName="body" refType="b" refFor="ch" refForName="header"',
            ),
        ) +
          child(
            "header",
            list(c("lMarg", 'refType="primFontSz" fact="0.1"')),
            "tx",
          ) +
          child("body", "", "tx"),
        "composite",
      );
    const root = expand(body),
      group = root.children[0];
    const result = evaluateDiagramInitialConstraints(root, available);
    expect(result.get(group.children[0]).coordinates).toMatchObject({
      t: 3,
      h: 8,
      b: 11,
    });
    expect(result.get(group.children[0]).values.get("lMarg")).toBe(1.6);
    expect(result.get(group.children[1]).coordinates).toMatchObject({
      t: 11,
      h: 69,
      b: 80,
    });
  });

  it("diagnoses real cycles and permits valid reference queries after a missing query", () => {
    const cyclic = expand(
      child("item", list(c("w", 'refType="h"') + c("h", 'refType="w"'))),
    );
    expect(() => evaluateDiagramInitialConstraints(cyclic, available)).toThrow(
      "cyclic diagram constraint reference",
    );
    const root = expand(child("item", list(c("w", 'val="12"'))));
    const state = evaluateDiagramInitialConstraints(root, available).get(
      root.children[0],
    );
    expect(() => state.reference(property("userZ"))).toThrow(
      "unresolved diagram constraint",
    );
    expect(state.reference(property("w"))).toBe(12);
  });

  it("handles long forward dependency chains without recursion or repeated name scans", () => {
    const count = 8_000,
      constraints = [],
      children = [];
    for (let i = 0; i < count; ++i) {
      constraints.push(
        c(
          "w",
          `for="ch" forName="item${i}" ${i === 0 ? 'val="12"' : `refType="w" refFor="ch" refForName="item${i - 1}"`}`,
        ),
      );
      children.push(child(`item${i}`));
    }
    const root = expand(
      list(constraints.reverse().join("")) + children.reverse().join(""),
    );
    const initial = evaluateDiagramInitialConstraints(root, available);
    expect(initial.size).toBe(count + 1);
    expect(initial.get(root.children[0]).values.get("w")).toBe(12);
    expect(initial.get(root.children.at(-1)).values.get("w")).toBe(12);
  }, 30_000);

  it("rejects unsupported algorithms and property families explicitly", () => {
    expect(() =>
      evaluateDiagramInitialConstraints(expand("", "cycle"), available),
    ).toThrow("unsupported diagram constraint algorithm");
    expect(() =>
      evaluateDiagramInitialConstraints(
        expand(list(c("bendDist", 'val="5"'))),
        available,
      ),
    ).toThrow("unsupported initial diagram constraint");
  });

  it("rejects invalid sizes, nonfinite results and invalid or exhausted operation budgets", () => {
    const root = expand(
      child(
        "item",
        list(c("w", 'val="1e308"') + c("h", 'refType="w" fact="10"')),
      ),
    );
    expect(() => evaluateDiagramInitialConstraints(root, available)).toThrow(
      "non-finite diagram constraint value",
    );
    for (const value of [NaN, Infinity, -Infinity, -1])
      expect(() =>
        evaluateDiagramInitialConstraints(expand(""), { w: value, h: 100 }),
      ).toThrow();
    for (const value of [0, -1, 0.5, Infinity])
      expect(() =>
        evaluateDiagramInitialConstraints(expand(""), available, {
          maxOperations: value,
        }),
      ).toThrow("invalid diagram constraint operation budget");
    expect(() =>
      evaluateDiagramInitialConstraints(expand(child("item")), available, {
        maxOperations: 1,
      }),
    ).toThrow("diagram constraint operation budget exceeded");
  });
});

it.each(["w", "h"])(
  "rebuilds local %s preferences without discarding cross-axis or variable inheritance",
  (axis) => {
    const cross = axis === "w" ? "h" : "w";
    const root = expand(
      list(
        c(axis, 'for="ch" forName="item" val="80"') +
          c(cross, 'for="ch" forName="item" val="30"') +
          c("userA", 'for="ch" forName="item" val="0.2"'),
      ) + child("item", list(c(axis, `refType="${cross}" fact="0.2"`))),
    );
    const node = root.children[0];
    const state = evaluateDiagramInitialConstraints(root, available).get(node);
    const local = state.evaluateScope({ localDimensions: [axis] }).get(node);
    expect(local.size[axis]).toBe(6);
    expect(local.size[cross]).toBe(30);
    expect(local.values.get("userA")).toBe(0.2);
    expect(state.size[axis]).toBe(80);
    expect(state.evaluateScope().get(node).size).toEqual(state.size);
  },
);

it.each(["w", "h"])(
  "uses the algorithm default when resetting inherited %s without a local base",
  (axis) => {
    const root = expand(
      list(c(axis, 'for="ch" val="80"')) +
        child("space", list(c(axis, 'val="3" op="gte"'))) +
        child("text", "", "tx"),
    );
    const initial = evaluateDiagramInitialConstraints(root, available);
    for (const [index, node] of root.children.entries()) {
      const state = initial.get(node);
      expect(state.size[axis]).toBe(80);
      const local = state.evaluateScope({ localDimensions: [axis] }).get(node);
      expect(local.size[axis]).toBe(index === 0 ? 0 : 100);
    }
  },
);

it("resets only the rebuilt root, retaining its declarations for descendants", () => {
  const root = expand(
    list(c("w", 'for="ch" forName="group" val="80"')) +
      child(
        "group",
        list(c("w", 'val="12"') + c("w", 'for="ch" val="5"')) +
          child("nested", list(c("w", 'val="2"'))),
        "lin",
      ),
  );
  const group = root.children[0],
    nested = group.children[0];
  const state = evaluateDiagramInitialConstraints(root, available).get(group);
  const local = state.evaluateScope({ localDimensions: ["w"] });
  expect(local.get(group).size.w).toBe(12);
  expect(local.get(nested).size.w).toBe(5);
  expect(state.size.w).toBe(80);
});

it("retains explicit fitted equality values when rebuilding a local dimension", () => {
  const root = expand(
    list(
      c("h", 'for="ch" forName="text" val="1"') +
        c(
          "w",
          'for="ch" forName="space" refType="h" refFor="ch" refForName="text" fact="0.1" op="equ"',
        ),
    ) +
      child("text", "", "tx") +
      child("space", list(c("w", 'val="3"'))),
  );
  const [text, space] = root.children;
  const initial = evaluateDiagramInitialConstraints(root, available);
  const changes = initial.get(text).equalityChanges("h", 2);
  const state = evaluateDiagramInitialConstraints(root, available, {
    adjustments: changes,
  }).get(space);
  expect(state.size.w).toBe(0.2);
  expect(
    state.evaluateScope({ localDimensions: ["w"] }).get(space).size.w,
  ).toBe(3);
  const local = state.evaluateScope({
    localDimensions: ["w"],
    adjustments: changes.filter((c) => c.owner === space),
  });
  expect(local.get(space).size.w).toBe(0.2);
});

it.each(
  ["w", "h"].flatMap((axis) => [0, 3, 80].map((limit) => ({ axis, limit }))),
)(
  "bounds drawn $axis by $limit while retaining preferences and local expressions",
  ({ axis, limit }) => {
    const root = expand(
      child(
        "text",
        list(c("w", 'val="20"') + c("h", 'val="30"')) +
          `<d:ruleLst><d:rule type="${axis}" val="100"/></d:ruleLst>`,
        "tx",
      ),
    );
    const text = root.children[0];
    const state = evaluateDiagramInitialConstraints(root, available, {
      canvases: new Map([[text, { [axis]: limit }]]),
    }).get(text);
    const preference = axis === "w" ? 20 : 30;
    const cross = axis === "w" ? "h" : "w";
    expect(state.values.get(axis)).toBe(preference);
    expect(state.reference(property(axis))).toBe(preference);
    expect(state.size[axis]).toBe(Math.min(preference, limit));
    expect(state.rulePlan(state.rules[0]).limit).toBe(limit);
    const trial = state
      .evaluateScope({
        adjustments: [
          { owner: text, property: property(axis), value: 50 },
          { owner: text, property: property(cross), value: 70 },
        ],
      })
      .get(text);
    expect(trial.values.get(axis)).toBe(50);
    expect(trial.size[axis]).toBe(Math.min(50, limit));
    expect(trial.size[cross]).toBe(70);
    expect(trial.rulePlan(trial.rules[0]).limit).toBe(limit);
    expect(state.size[axis]).toBe(Math.min(preference, limit));
  },
);

it.each([-1, NaN, Infinity, -Infinity])(
  "rejects an invalid canvas dimension %s",
  (value) => {
    const root = expand(child("space"));
    expect(() =>
      evaluateDiagramInitialConstraints(root, available, {
        canvases: new Map([[root.children[0], { w: value }]]),
      }),
    ).toThrow(/negative diagram canvas size|non-finite/);
  },
);

it.each([-1, NaN, Infinity, -Infinity])(
  "rejects an invalid composite projection scale %s",
  (value) => {
    const root = expand(child("space"), "composite");
    expect(() =>
      evaluateDiagramInitialConstraints(root, available, {
        coordinateScales: new Map([[root.children[0], { w: value }]]),
      }),
    ).toThrow(/negative diagram coordinate projection|non-finite/);
  },
);

it.each([NaN, Infinity, -Infinity])(
  "rejects a non-finite captured coordinate %s",
  (value) => {
    const root = expand(child("space"), "composite");
    const coordinates = evaluateDiagramInitialConstraints(root, available)
      .get(root.children[0])
      .captureCompositeCoordinates();
    expect(() =>
      evaluateDiagramInitialConstraints(root, available, {
        coordinateScales: new Map([[root.children[0], { w: 0.5 }]]),
        coordinateOrigins: new Map([
          [root.children[0], { ...coordinates, l: value }],
        ]),
      }),
    ).toThrow(/non-finite/);
  },
);
