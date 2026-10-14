// Layout definitions (ECMA-376 21.4.2) written for each authored layout.
//
// The saved drawing is what this app shows; desktop editors ignore it and
// lay the diagram out again from this definition, so each definition states
// the same geometry the layout code draws (layouts-*.ts), with the standard
// layout algorithms: lin, snake, cycle, hierRoot/hierChild, pyra, composite,
// conn, sp and tx. Shared numbers live in geometry.ts.
//
// What these algorithms do, as relied on here:
// - lin scales its children along its direction only when they overflow,
//   keeps their cross size (clamped to its own), and centers them. Size
//   constraints are worked out before that scaling, so shapes that must keep
//   their aspect are sized per item count rather than left to overflow.
// - Spacing in lin and snake comes from sibling-transition spacer nodes (sp);
//   a negative spacer width overlaps neighbors.
// - cycle centers the bounding box of its children (not the circle), honors
//   `diam`, puts a first child mapped with ctrShpMap in the middle, and
//   shrinks nodes that would overlap their neighbors.
// - conn joins the shapes of a transition's source and destination along the
//   line between their centers, from edge to edge less its pads; an arrow's
//   thickness follows its own length.
// - A node's own constraints apply where its parent sets none.
// - choose/if conditions use cnt (counts along an axis, `ch ch` included) and
//   maxDepth; layout node names must be unique across a definition, so nodes
//   shared by several branches are reached through a named `forEach ref`.
import { NS } from "../../../internal/xml/index.ts";
import { xmlAttr } from "./xml.ts";
import {
  ARROW_THICKNESS,
  CONNECTOR_PAD,
  MAX_COUNTED,
  PYRAMID_BASE,
  TARGET_TEXT_X,
  hubSizes,
  nestedCircle,
  quadrantCell,
  RING_TRACK,
  TREE,
  ringAngle,
  ringCenterShift,
  ringNodeFraction,
  ringTrackSizes,
  stepFraction,
  targetRing,
  vennSizes,
  vennTextBox,
  wheelSlice,
} from "./geometry.ts";

export const LAYOUT_URN = "urn:everything:smartart:layout/";

type Attrs = Readonly<Record<string, string | number | undefined>>;
const num = (v: number) => String(+v.toFixed(5));
const el = (name: string, attrs: Attrs = {}, ...children: string[]): string => {
  const a = Object.entries(attrs)
    .filter(([, v]) => v !== undefined)
    .map(
      ([k, v]) =>
        ` ${k}="${xmlAttr(typeof v === "number" ? num(v) : String(v))}"`,
    )
    .join("");
  const body = children.filter(Boolean).join("");
  return body ? `<dgm:${name}${a}>${body}</dgm:${name}>` : `<dgm:${name}${a}/>`;
};
const alg = (type: string, params: Attrs = {}) =>
  el(
    "alg",
    { type },
    ...Object.entries(params)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => el("param", { type: k, val: v })),
  );
interface ShapeOpts {
  /** Preset adjustments by index (1-based), as fractions or degrees. */
  readonly adj?: ReadonlyArray<number | undefined> | undefined;
  readonly rot?: number;
  /** A picture placeholder. */
  readonly picture?: boolean;
  /** Text only: the geometry is not drawn. */
  readonly hidden?: boolean | undefined;
}
const shape = (type?: string, o: ShapeOpts = {}) =>
  el(
    "shape",
    {
      ...(o.rot ? { rot: o.rot } : {}),
      ...(type ? { type } : {}),
      ...(type ? { "r:blip": "" } : {}),
      ...(o.picture ? { blipPhldr: 1 } : {}),
      ...(o.hidden ? { hideGeom: 1 } : {}),
    },
    el(
      "adjLst",
      {},
      ...(o.adj ?? []).flatMap((v, i) =>
        v === undefined ? [] : [el("adj", { idx: i + 1, val: v })],
      ),
    ),
  );
const presOf = (axis?: string, ptType?: string) =>
  el("presOf", { axis, ptType });

interface Ref {
  /** "ch" (default when a name is given), "des" or "self". */
  readonly for?: string;
  readonly forName?: string;
  readonly refType?: string;
  readonly refFor?: string;
  readonly refForName?: string;
  readonly fact?: number;
  readonly val?: number;
  readonly op?: "equ" | "lte" | "gte";
}
/** A constraint; `for` defaults to the children when a name is given. */
const C = (type: string, o: Ref = {}) =>
  el("constr", {
    type,
    for: o.for ?? (o.forName ? "ch" : undefined),
    forName: o.forName,
    refType: o.refType,
    refFor: o.refFor,
    refForName: o.refForName,
    op: o.op,
    fact: o.fact,
    val: o.val,
  });
const constrs = (...items: ReadonlyArray<string | string[]>) =>
  el("constrLst", {}, ...items.flat());
const rules = (...items: string[]) => el("ruleLst", {}, ...items);

/** Unique names for choose/if/else and forEach elements. */
class Names {
  private n = 0;
  next(prefix: string) {
    return `${prefix}${this.n++}`;
  }
}
type Cond = Readonly<{
  axis?: string;
  ptType?: string;
  func: string;
  op: string;
  val: number | string;
}>;
const choose = (
  names: Names,
  branches: ReadonlyArray<readonly [Cond, string]>,
  otherwise?: string,
): string =>
  !branches.length
    ? (otherwise ?? "")
    : el(
        "choose",
        { name: names.next("choose") },
        ...branches.map(([cond, body]) =>
          el("if", { name: names.next("if"), ...cond }, body),
        ),
        otherwise === undefined
          ? ""
          : el("else", { name: names.next("else") }, otherwise),
      );
const count = (n: number, axis = "ch"): Cond => ({
  axis,
  ptType: axis
    .split(" ")
    .map(() => "node")
    .join(" "),
  func: "cnt",
  op: "equ",
  val: n,
});
const atLeast = (n: number, axis = "ch"): Cond => ({
  axis,
  ptType: "node",
  func: "cnt",
  op: "gte",
  val: n,
});
const before = (n: number): Cond => ({
  axis: "precedSib",
  ptType: "node",
  func: "cnt",
  op: "equ",
  val: n,
});
const after = (n: number): Cond => ({
  axis: "followSib",
  ptType: "node",
  func: "cnt",
  op: "equ",
  val: n,
});
/** True when some item has sub-items (from the root). */
const NESTED: Cond = {
  axis: "des",
  ptType: "node",
  func: "maxDepth",
  op: "gte",
  val: 2,
};
const depthIs = (d: number): Cond => ({
  axis: "des",
  ptType: "node",
  func: "maxDepth",
  op: "equ",
  val: d,
});

/** Branches for 1..MAX_COUNTED items (along `axis`), plus a fallback. */
const perCount = (
  names: Names,
  body: (n: number) => string,
  axis = "ch",
  max = MAX_COUNTED,
  offset = 0,
) =>
  choose(
    names,
    Array.from(
      { length: max },
      (_, k) => [count(k + 1 + offset, axis), body(k + 1)] as const,
    ),
    body(max),
  );

/** Branches for 1..`max` items whose bodies create layout nodes: more items
 *  reuse the last branch through a reference, as names must stay unique.
 *  `body` returns a forEach named `name`. */
const perCountNodes = (
  names: Names,
  body: (n: number, name: string) => string,
  axis = "ch",
  max = MAX_COUNTED,
  offset = 0,
) => {
  const last = names.next("most");
  return choose(
    names,
    Array.from({ length: max }, (_, k) => {
      const n = k + 1;
      return [
        count(n + offset, axis),
        body(n, n === max ? last : names.next("count")),
      ] as const;
    }),
    fe({ name: names.next("more"), ref: last }),
  );
};

const fe = (attrs: Attrs, ...children: string[]) =>
  el("forEach", attrs, ...children);
const eachItem = (names: Names, ...children: string[]) =>
  fe({ name: names.next("items"), axis: "ch", ptType: "node" }, ...children);
const afterEach = (names: Names, body: string, wrap = false) =>
  fe(
    {
      name: names.next("trans"),
      axis: "followSib",
      ptType: "sibTrans",
      cnt: 1,
      ...(wrap ? { hideLastTrans: 0 } : {}),
    },
    body,
  );

interface TextOpts {
  /** Which data the node shows: its own text (self), it and its sub-items
   *  (desOrSelf, the default) or only the sub-items (des). */
  readonly axis?: "self" | "desOrSelf" | "des";
  readonly adj?: ShapeOpts["adj"];
  readonly hidden?: boolean;
  readonly anchor?: "t" | "mid" | "b";
  readonly align?: "l" | "ctr" | "r";
  /** Margins as fractions of the node's width (left, right) and height
   *  (top, bottom), replacing the font-relative default. */
  readonly margins?: readonly [number, number, number, number];
  /** Constraints of its own. */
  readonly own?: ReadonlyArray<string>;
  /** Further children (a choose of constraint lists). */
  readonly extra?: string;
  /** Leave the margins to `extra`. */
  readonly noMargins?: boolean;
  /** Turned half way round (mirrored arrows), its text kept upright. */
  readonly turned?: boolean;
}
/** A text node (tx algorithm). */
const tx = (name: string, styleLbl: string, geom: string, o: TextOpts = {}) =>
  el(
    "layoutNode",
    { name, styleLbl },
    el("varLst", {}, el("bulletEnabled", { val: 1 })),
    alg("tx", {
      ...(o.turned ? { autoTxRot: "upr" } : {}),
      txAnchorVert: o.anchor,
      txAnchorVertCh: o.anchor,
      parTxLTRAlign: o.align,
      shpTxLTRAlignCh: o.align,
    }),
    shape(geom, {
      adj: o.adj,
      hidden: o.hidden,
      ...(o.turned ? { rot: 180 } : {}),
    }),
    presOf(o.axis ?? "desOrSelf", "node"),
    constrs(
      o.noMargins
        ? []
        : o.margins
          ? [
              C("lMarg", { refType: "w", fact: o.margins[0] }),
              C("tMarg", { refType: "h", fact: o.margins[1] }),
              C("rMarg", { refType: "w", fact: o.margins[2] }),
              C("bMarg", { refType: "h", fact: o.margins[3] }),
            ]
          : ["tMarg", "bMarg", "lMarg", "rMarg"]
              .filter(
                (type) =>
                  !(o.own ?? []).some((c) => c.includes(`type="${type}"`)),
              )
              .map((type) => C(type, { refType: "primFontSz", fact: 0.3 })),
      [...(o.own ?? [])],
    ),
    rules(el("rule", { type: "primFontSz", val: 5, fact: "NaN", max: "NaN" })),
    o.extra ?? "",
  );
/** A shape with no text of its own (sp algorithm). */
const sp = (
  name: string,
  styleLbl: string | undefined,
  geom: string | undefined,
  o: ShapeOpts = {},
) =>
  el(
    "layoutNode",
    { name, styleLbl },
    alg("sp"),
    shape(geom, o),
    presOf(),
    constrs(),
    rules(),
  );
/** A spacer between items. */
const gap = (names: Names, name: string) =>
  afterEach(names, sp(name, undefined, undefined));
/** An invisible full-size child: a composite's size is the bounding box
 *  of its children, so this keeps it the size its parent gave it. */
const FRAME = "frame";
const frame = (name = FRAME) => sp(name, undefined, undefined);
const framed = (name = FRAME) =>
  place(name, { l: D(0), t: D(0), w: D(1), h: D(1, "h") });
/** A layout node that arranges children. */
const box = (
  name: string,
  algXml: string,
  cons: ReadonlyArray<string>,
  ...children: string[]
) => {
  const composite = algXml.includes('type="composite"');
  return el(
    "layoutNode",
    { name },
    algXml,
    shape(),
    presOf(),
    constrs(composite ? framed(`${name}Frame`) : [], [...cons]),
    rules(),
    composite ? frame(`${name}Frame`) : "",
    ...children,
  );
};
/** A connector along a transition (sibling arrows, parent-child lines). */
const connector = (
  name: string,
  styleLbl: string,
  params: Attrs,
  geom: string,
  own: ReadonlyArray<string> = [],
) =>
  el(
    "layoutNode",
    { name, styleLbl },
    alg("conn", params),
    shape(geom),
    presOf(),
    constrs([...own]),
    rules(),
  );
const arrowConnector = (name: string) =>
  connector(
    name,
    "sibTrans2D1",
    { begPts: "auto", endPts: "auto" },
    "rightArrow",
    [
      C("begPad", { refType: "connDist", fact: CONNECTOR_PAD }),
      C("endPad", { refType: "connDist", fact: CONNECTOR_PAD }),
    ],
  );

const font = (forName: string, val = 28, forAxis = "ch") =>
  C("primFontSz", { for: forAxis, forName, op: "equ", val });

/** A rectangle in a composite parent: each side a fraction of the parent's
 *  width or height. */
interface Dim {
  readonly f: number;
  readonly of?: "w" | "h";
  /** Added to the side (an `…Off` constraint). */
  readonly plus?: Dim | undefined;
}
const D = (f: number, of: "w" | "h" = "w", plus?: Dim): Dim => ({
  f,
  of,
  plus,
});
const place = (
  name: string,
  r: { l?: Dim; t?: Dim; w?: Dim; h?: Dim; ctrX?: Dim; ctrY?: Dim; b?: Dim },
  rtl = false,
  forAxis = "ch",
): string[] => {
  const out: string[] = [];
  const add = (type: string, d: Dim | undefined) => {
    if (!d) return;
    out.push(
      C(type, { for: forAxis, forName: name, refType: d.of ?? "w", fact: d.f }),
    );
    if (d.plus)
      out.push(
        C(`${type}Off`, {
          for: forAxis,
          forName: name,
          refType: d.plus.of ?? "w",
          fact: d.plus.f,
        }),
      );
  };
  if (rtl && r.l && (r.l.of ?? "w") === "w" && r.w && (r.w.of ?? "w") === "w")
    add("l", D(1 - r.l.f - r.w.f));
  else if (rtl && r.l) {
    // Mirror from the right edge: r = W - l.
    out.push(C("r", { for: forAxis, forName: name, refType: "w", fact: 1 }));
    out.push(
      C("rOff", {
        for: forAxis,
        forName: name,
        refType: r.l.of ?? "w",
        fact: -r.l.f,
      }),
    );
  } else add("l", r.l);
  add("t", r.t);
  add("w", r.w);
  add("h", r.h);
  add(
    "ctrX",
    rtl && r.ctrX
      ? (r.ctrX.of ?? "w") === "w"
        ? D(1 - r.ctrX.f, "w", r.ctrX.plus && D(-r.ctrX.plus.f, r.ctrX.plus.of))
        : r.ctrX
      : r.ctrX,
  );
  add("ctrY", r.ctrY);
  add("b", r.b);
  return out;
};

// ---------------------------------------------------------------- Layouts

interface Build {
  readonly names: Names;
  readonly rtl: boolean;
}
type Def = (b: Build) => string;

const fromStart = (rtl: boolean) => (rtl ? "fromR" : "fromL");

/** Equal tiles that wrap into centered rows. */
const snakeTiles =
  (
    geom: string,
    aspect: number,
    gapRatio: number,
    centered: boolean,
    opts: { adj?: number[]; columns?: number } = {},
  ): Def =>
  ({ names, rtl }) =>
    [
      alg("snake", {
        grDir: rtl ? "tR" : "tL",
        flowDir: "row",
        contDir: "sameDir",
        off: centered ? "ctr" : "off",
        ...(opts.columns ? { bkpt: "fixed", bkPtFixedVal: opts.columns } : {}),
      }),
      shape(),
      presOf(),
      constrs(
        C("w", { forName: "node", refType: "w" }),
        C("h", {
          forName: "node",
          refType: "w",
          refFor: "ch",
          refForName: "node",
          fact: 1 / aspect,
        }),
        C("w", {
          forName: "gap",
          refType: "w",
          refFor: "ch",
          refForName: "node",
          fact: gapRatio,
        }),
        C("sp", { refType: "w", refFor: "ch", refForName: "gap" }),
        font("node"),
      ),
      rules(),
      eachItem(
        names,
        tx("node", "node1", geom, { adj: opts.adj }),
        gap(names, "gap"),
      ),
    ].join("");

const tiles: Def = snakeTiles("rect", 1.6, 0.1, true);

/** Banners stacked top to bottom, each followed by its sub-points. */
const bannerList: Def = ({ names, rtl }) => {
  const bodies = Array.from({ length: MAX_COUNTED }, (_, k) => k + 1);
  return [
    alg("lin", { linDir: "fromT", nodeHorzAlign: rtl ? "l" : "r" }),
    shape(),
    presOf(),
    constrs(
      C("w", { forName: "head", refType: "w" }),
      C("h", { forName: "head", refType: "w", fact: 0.16 }),
      C("h", {
        forName: "gap",
        refType: "h",
        refFor: "ch",
        refForName: "head",
        fact: 0.18,
      }),
      bodies.flatMap((k) => [
        C("w", { forName: `body${k}`, refType: "w", fact: 0.96 }),
        C("h", {
          forName: `body${k}`,
          refType: "h",
          refFor: "ch",
          refForName: "head",
          fact: 0.55 * k,
        }),
      ]),
      font("head"),
      bodies.map((k) => font(`body${k}`, 20)),
    ),
    rules(),
    eachItem(
      names,
      tx("head", "node1", "roundRect", {
        axis: "self",
        align: rtl ? "r" : "l",
      }),
      choose(
        names,
        bodies.slice(0, -1).map(
          (k) =>
            [
              count(k, "des"),
              tx(`body${k}`, "revTx", "rect", {
                axis: "des",
                anchor: "t",
                align: rtl ? "r" : "l",
              }),
            ] as const,
        ),
        choose(names, [
          [
            atLeast(1, "des"),
            tx(`body${MAX_COUNTED}`, "revTx", "rect", {
              axis: "des",
              anchor: "t",
              align: rtl ? "r" : "l",
            }),
          ],
        ]),
      ),
      gap(names, "gap"),
    ),
  ].join("");
};

/** Columns: a heading over a panel of sub-points. With no sub-points
 *  anywhere, headings alone, centered. */
const headingColumns =
  (headStyle: string, bodyStyle: string, headH = 0.26, gapRatio = 0.08): Def =>
  ({ names, rtl }) =>
    [
      alg("lin", { linDir: fromStart(rtl) }),
      shape(),
      presOf(),
      choose(
        names,
        [
          [
            NESTED,
            constrs(
              C("w", { forName: "column", refType: "w" }),
              C("h", { forName: "column", refType: "h" }),
              C("w", {
                forName: "gap",
                refType: "w",
                refFor: "ch",
                refForName: "column",
                fact: gapRatio,
              }),
              font("head", 28, "des"),
              font("body", 20, "des"),
            ),
          ],
        ],
        perCount(names, (n) => {
          const cell = 1 / (n + (n - 1) * gapRatio);
          return constrs(
            C("w", { forName: "heading", refType: "w", fact: cell }),
            C("h", { forName: "heading", refType: "w", fact: cell * 0.65 }),
            C("h", { forName: "heading", refType: "h", op: "lte" }),
            C("w", { forName: "gapOnly", refType: "w", fact: cell * gapRatio }),
            font("heading"),
          );
        }),
      ),
      rules(),
      choose(
        names,
        [
          [
            NESTED,
            eachItem(
              names,
              box(
                "column",
                alg("composite"),
                [
                  ...place("head", {
                    l: D(0),
                    t: D(0),
                    w: D(1),
                    h: D(headH, "h"),
                  }),
                  ...place("body", {
                    l: D(0),
                    t: D(headH, "h"),
                    w: D(1),
                    b: D(1, "h"),
                  }),
                ],
                tx("head", headStyle, "rect", { axis: "self" }),
                tx("body", bodyStyle, "rect", {
                  axis: "des",
                  anchor: "t",
                  align: rtl ? "r" : "l",
                }),
              ),
              gap(names, "gap"),
            ),
          ],
        ],
        eachItem(
          names,
          tx("heading", headStyle, "rect", { axis: "self" }),
          gap(names, "gapOnly"),
        ),
      ),
    ].join("");

/** Rows with a colored tab for the heading and a card for its sub-points. */
const stackedCards: Def = ({ names, rtl }) =>
  [
    alg("lin", { linDir: "fromT" }),
    shape(),
    presOf(),
    constrs(
      C("w", { forName: "row", refType: "w" }),
      C("h", { forName: "row", refType: "w", fact: 0.3 }),
      C("h", {
        forName: "gap",
        refType: "h",
        refFor: "ch",
        refForName: "row",
        fact: 0.12,
      }),
      font("tab", 28, "des"),
      font("tabOnly", 28, "des"),
      font("cardText", 20, "des"),
    ),
    rules(),
    eachItem(
      names,
      box(
        "row",
        alg("composite"),
        [],
        choose(
          names,
          [
            [
              atLeast(1),
              [
                constrs(
                  place(
                    "card",
                    {
                      l: D(0.27),
                      t: D(0.08, "h"),
                      w: D(0.73),
                      h: D(0.84, "h"),
                    },
                    rtl,
                  ),
                  place(
                    "cardText",
                    {
                      l: D(0.31),
                      t: D(0.08, "h"),
                      w: D(0.69),
                      h: D(0.84, "h"),
                    },
                    rtl,
                  ),
                  place(
                    "tab",
                    { l: D(0), t: D(0), w: D(0.3), h: D(1, "h") },
                    rtl,
                  ),
                ),
                sp("card", "alignAccFollowNode1", "rect"),
                tx("cardText", "revTx", "rect", {
                  axis: "des",
                  align: rtl ? "r" : "l",
                  hidden: true,
                }),
                tx("tab", "node1", "roundRect", { axis: "self" }),
              ].join(""),
            ],
          ],
          [
            constrs(
              place("tabOnly", { l: D(0), t: D(0), w: D(1), h: D(1, "h") }),
            ),
            tx("tabOnly", "node1", "roundRect", { axis: "self" }),
          ].join(""),
        ),
      ),
      gap(names, "gap"),
    ),
  ].join("");

/** Text rows under thin rules: headings left, details right. */
const ruledList: Def = ({ names, rtl }) => {
  const row = (split: number) =>
    box(
      split < 1 ? "row" : "rowOnly",
      alg("composite"),
      [
        ...place(split < 1 ? "rule" : "ruleOnly", {
          l: D(0),
          t: D(0),
          w: D(1),
          h: D(0, "h"),
        }),
        ...place(
          split < 1 ? "head" : "headOnly",
          { l: D(0), t: D(0.06, "h"), w: D(split), h: D(0.88, "h") },
          rtl,
        ),
        ...(split < 1
          ? place(
              "body",
              {
                l: D(split),
                t: D(0.06, "h"),
                w: D(1 - split),
                h: D(0.88, "h"),
              },
              rtl,
            )
          : []),
      ],
      sp(split < 1 ? "rule" : "ruleOnly", "parChTrans1D2", "line"),
      tx(split < 1 ? "head" : "headOnly", "revTx", "rect", {
        axis: "self",
        anchor: "t",
        align: rtl ? "r" : "l",
      }),
      split < 1
        ? tx("body", "revTx", "rect", {
            axis: "des",
            anchor: "t",
            align: rtl ? "r" : "l",
          })
        : "",
    );
  return [
    alg("lin", { linDir: "fromT" }),
    shape(),
    presOf(),
    constrs(
      ["row", "rowOnly"].flatMap((r) => [
        C("w", { forName: r, refType: "w" }),
        C("h", { forName: r, refType: "h" }),
      ]),
      font("head", 28, "des"),
      font("headOnly", 28, "des"),
      font("body", 18, "des"),
    ),
    rules(),
    choose(
      names,
      [[NESTED, eachItem(names, row(0.32))]],
      eachItem(names, row(1)),
    ),
  ].join("");
};

/** Light panels gathering each item's sub-items as boxes. */
const groupedBoxes: Def = ({ names, rtl }) => {
  const kidsEach = names.next("kids");
  return [
    alg("lin", { linDir: fromStart(rtl) }),
    shape(),
    presOf(),
    constrs(
      C("w", { forName: "group", refType: "w" }),
      C("h", { forName: "group", refType: "h" }),
      C("w", {
        forName: "gap",
        refType: "w",
        refFor: "ch",
        refForName: "group",
        fact: 0.08,
      }),
      font("panel", 28, "des"),
      font("panelOnly", 28, "des"),
      font("box", 20, "des"),
    ),
    rules(),
    eachItem(
      names,
      box(
        "group",
        alg("composite"),
        [],
        choose(
          names,
          [
            [
              atLeast(1),
              [
                constrs(
                  place("panel", { l: D(0), t: D(0), w: D(1), h: D(1, "h") }),
                  place("boxes", {
                    l: D(0.08),
                    t: D(0.24, "h"),
                    w: D(0.84),
                    h: D(0.73, "h"),
                  }),
                ),
                tx("panel", "trBgShp", "roundRect", {
                  axis: "self",
                  anchor: "t",
                  adj: [0.06],
                }),
                box(
                  "boxes",
                  alg("lin", { linDir: "fromT" }),
                  [
                    C("w", { forName: "box", refType: "w" }),
                    C("h", { forName: "box", refType: "h" }),
                    C("h", {
                      forName: "boxGap",
                      refType: "h",
                      refFor: "ch",
                      refForName: "box",
                      fact: 0.1,
                    }),
                  ],
                  fe(
                    { name: kidsEach, axis: "ch", ptType: "node" },
                    tx("box", "node1", "roundRect"),
                    gap(names, "boxGap"),
                  ),
                ),
              ].join(""),
            ],
          ],
          [
            constrs(
              place("panelOnly", { l: D(0), t: D(0), w: D(1), h: D(1, "h") }),
            ),
            tx("panelOnly", "trBgShp", "roundRect", {
              axis: "self",
              adj: [0.06],
            }),
          ].join(""),
        ),
      ),
      gap(names, "gap"),
    ),
  ].join("");
};

// ---------------------------------------------------------------- Processes

/** Boxes in a row (or column) with an arrow in each gap. */
const arrowFlow =
  (vertical: boolean): Def =>
  ({ names, rtl }) => {
    const gapRatio = vertical ? 0.35 : 0.32;
    const main = vertical ? "h" : "w",
      cross = vertical ? "w" : "h";
    const sizes = (n: number, nested: boolean) => {
      const cell = 1 / (n + (n - 1) * gapRatio);
      return constrs(
        C(main, { forName: "step", refType: main, fact: cell }),
        nested
          ? C(cross, {
              forName: "step",
              refType: cross,
              fact: vertical ? 1 : 0.9,
            })
          : [
              C(cross, {
                forName: "step",
                refType: main,
                fact: cell * (vertical ? 4 : 0.7),
              }),
              C(cross, { forName: "step", refType: cross, op: "lte" }),
            ],
        C(main, { forName: "slot", refType: main, fact: cell * gapRatio }),
        C(cross, { forName: "slot", refType: cross }),
        font("step"),
      );
    };
    // The arrow inside its slot: 70% of the gap (75% down a column).
    const arrow = vertical
      ? place("arrow", {
          t: D(0.125, "h"),
          h: D(0.75, "h"),
          w: D(0.825, "h"),
          ctrX: D(0.5),
        })
      : place(
          "arrow",
          { l: D(0.15), w: D(0.7), h: D(0.77), ctrY: D(0.5, "h") },
          rtl,
        );
    return [
      alg("lin", { linDir: vertical ? "fromT" : fromStart(rtl) }),
      shape(),
      presOf(),
      choose(
        names,
        [[NESTED, perCount(names, (n) => sizes(n, true))]],
        perCount(names, (n) => sizes(n, false)),
      ),
      rules(),
      eachItem(
        names,
        tx("step", "node1", "roundRect", { adj: [0.1] }),
        afterEach(
          names,
          box(
            "slot",
            alg("composite"),
            arrow,
            sp(
              "arrow",
              "sibTrans2D1",
              vertical ? "downArrow" : rtl ? "leftArrow" : "rightArrow",
              { adj: [0.6, 0.5] },
            ),
          ),
        ),
      ),
    ].join("");
  };

/** Interlocking chevrons with each item's details beneath. */
const chevrons: Def = ({ names, rtl }) => {
  const overlap = 0.12;
  const variant = (nested: boolean) => {
    const sfx = nested ? "" : "Only";
    const first = `first${sfx}`,
      chevron = `chevron${sfx}`,
      stage = `stage${sfx}`,
      gapName = `gap${sfx}`;
    const head = nested
      ? { l: D(0), t: D(0), w: D(1) }
      : { l: D(0), ctrY: D(0.5, "h"), w: D(1) };
    const heads = [first, chevron].flatMap((name) => [
      ...place(name, head, rtl),
      C("h", { forName: name, refType: "w", fact: 0.45 }),
      C("h", {
        forName: name,
        refType: "h",
        fact: nested ? 0.3 : 1,
        op: "lte",
      }),
    ]);
    const shapes = choose(
      names,
      [
        [
          before(0),
          tx(first, "node1", "homePlate", {
            axis: "self",
            adj: [0.4],
            turned: rtl,
          }),
        ],
      ],
      tx(chevron, "node1", "chevron", {
        axis: "self",
        adj: [0.4],
        turned: rtl,
        ...(rtl ? {} : {}),
      }),
    );
    const item = nested
      ? box(
          stage,
          alg("composite"),
          [
            ...heads,
            ...place(
              "details",
              { l: D(0.05), t: D(0.33, "h"), w: D(0.836), b: D(1, "h") },
              rtl,
            ),
          ],
          shapes,
          tx("details", "revTx", "rect", {
            axis: "des",
            anchor: "t",
            align: rtl ? "r" : "l",
          }),
        )
      : box(stage, alg("composite"), heads, shapes);
    const sizes = (n: number) => {
      const cw = 1 / (1 + (n - 1) * (1 - overlap));
      return constrs(
        C("w", { forName: stage, refType: "w", fact: cw }),
        C("h", { forName: stage, refType: "h" }),
        C("w", { forName: gapName, refType: "w", fact: -cw * overlap }),
        font(first, 28, "des"),
        font(chevron, 28, "des"),
        nested ? font("details", 18, "des") : [],
      );
    };
    return {
      sizes: perCount(names, sizes),
      items: eachItem(names, item, gap(names, gapName)),
    };
  };
  const a = variant(true),
    b = variant(false);
  return [
    alg("lin", { linDir: fromStart(rtl) }),
    shape(),
    presOf(),
    choose(names, [[NESTED, a.sizes]], b.sizes),
    rules(),
    choose(names, [[NESTED, a.items]], b.items),
  ].join("");
};

/** Blocks that climb (or, as a pyramid, widen) item by item. */
const steps =
  (vertical: boolean): Def =>
  ({ names, rtl }) => {
    const gapRatio = vertical ? 0.04 : 0.05;
    const main = vertical ? "h" : "w",
      cross = vertical ? "w" : "h";
    const stepNames = Array.from(
      { length: MAX_COUNTED },
      (_, k) => `step${k + 1}`,
    );
    const sizes = (n: number) => {
      const cell = 1 / (n + (n - 1) * gapRatio);
      return constrs(
        stepNames.flatMap((name, k) => [
          C(main, { forName: name, refType: main, fact: cell }),
          C(cross, {
            forName: name,
            refType: cross,
            fact: k < n ? stepFraction(k, n) : 1,
          }),
        ]),
        C(main, { forName: "gap", refType: main, fact: cell * gapRatio }),
        stepNames.map((name) => font(name)),
      );
    };
    const node = (name: string) =>
      tx(name, "node1", "rect", vertical ? {} : { anchor: "t" });
    return [
      alg(
        "lin",
        vertical
          ? { linDir: "fromT", nodeHorzAlign: "ctr" }
          : { linDir: fromStart(rtl), nodeVertAlign: "b" },
      ),
      shape(),
      presOf(),
      perCount(names, sizes),
      rules(),
      eachItem(
        names,
        choose(
          names,
          stepNames
            .slice(0, -1)
            .map((name, k) => [before(k), node(name)] as const),
          node(stepNames[stepNames.length - 1]!),
        ),
        gap(names, "gap"),
      ),
    ].join("");
  };

/** Markers on an arrow with labels alternately above and below. */
const timeline: Def = ({ names, rtl }) => {
  const marker = 0.112;
  const labelH = 0.5 - marker * 0.7;
  const aboveEach = names.next("above");
  const belowEach = names.next("below");
  const label = (name: string, above: boolean) =>
    fe(
      { name: above ? aboveEach : belowEach, axis: "self" },
      tx(name, "revTx", "rect", { anchor: above ? "b" : "t" }),
    );
  return [
    alg("composite"),
    shape(),
    presOf(),
    constrs(
      place("bar", { l: D(0), w: D(1), ctrY: D(0.5, "h"), h: D(0.14, "h") }),
      place("track", { l: D(0), t: D(0), w: D(0.94), h: D(1, "h") }, rtl),
      font("above", 28, "des"),
      font("below", 28, "des"),
    ),
    rules(),
    sp("bar", "trBgShp", rtl ? "leftArrow" : "rightArrow", { adj: [0.5, 0.6] }),
    box(
      "track",
      alg("lin", { linDir: fromStart(rtl) }),
      [
        C("w", { forName: "mark", refType: "w" }),
        C("h", { forName: "mark", refType: "h" }),
      ],
      eachItem(
        names,
        box(
          "mark",
          alg("composite"),
          [
            ...place("dot", {
              ctrX: D(0.5),
              ctrY: D(0.5, "h"),
              w: D(marker, "h"),
              h: D(marker, "h"),
            }),
            C("w", { forName: "dot", refType: "w", fact: 0.4, op: "lte" }),
            C("h", { forName: "dot", refType: "w", fact: 0.4, op: "lte" }),
            ...place("above", { l: D(0), w: D(1), t: D(0), h: D(labelH, "h") }),
            ...place("below", {
              l: D(0),
              w: D(1),
              t: D(1 - labelH, "h"),
              h: D(labelH, "h"),
            }),
          ],
          sp("dot", "node1", "ellipse"),
          choose(
            names,
            Array.from({ length: 2 * MAX_COUNTED }, (_, k) => k)
              .filter((k) => k % 2 === 0)
              .map(
                (k, j) =>
                  [
                    before(k),
                    j
                      ? fe({ name: names.next("aboveRef"), ref: aboveEach })
                      : label("above", true),
                  ] as const,
              ),
            label("below", false),
          ),
        ),
      ),
    ),
  ].join("");
};

/** Steps set on one broad arrow. */
const blocksOnArrow: Def = ({ names, rtl }) =>
  [
    alg("composite"),
    shape(),
    presOf(),
    constrs(
      place("arrow", { l: D(0), t: D(0), w: D(1), h: D(1, "h") }),
      place("blocks", { l: D(0.03), t: D(0), w: D(0.79), h: D(1, "h") }, rtl),
      font("block", 28, "des"),
    ),
    rules(),
    sp("arrow", "trBgShp", rtl ? "leftArrow" : "rightArrow", {
      adj: [0.7, 0.5],
    }),
    box(
      "blocks",
      alg("lin", { linDir: fromStart(rtl) }),
      [
        C("w", { forName: "block", refType: "w" }),
        C("h", { forName: "block", refType: "h", fact: 0.5 }),
        C("w", {
          forName: "gap",
          refType: "w",
          refFor: "ch",
          refForName: "block",
          fact: 0.06,
        }),
      ],
      eachItem(names, tx("block", "node1", "roundRect"), gap(names, "gap")),
    ),
  ].join("");

// ---------------------------------------------------------------- Cycles

/** Items around a ring, joined by arrows (or none). */
const ring =
  (
    geom: string,
    style: string,
    ratio: number,
    fill: number,
    arrows: boolean,
  ): Def =>
  ({ names, rtl }) =>
    [
      alg("cycle", { stAng: 0, spanAng: rtl ? -360 : 360 }),
      shape(),
      presOf(),
      perCount(names, (n) => {
        const k = ringNodeFraction(n, ratio, fill);
        return constrs(
          C("w", { forName: "node", refType: "h", fact: k * ratio }),
          C("h", { forName: "node", refType: "h", fact: k }),
          C("diam", { refType: "h", fact: n > 1 ? 1 - k : 0 }),
          arrows
            ? [
                C("w", { forName: "arrow", refType: "h", fact: k }),
                C("h", {
                  forName: "arrow",
                  refType: "h",
                  // A connector's thickness is its height constraint.
                  fact: k * ARROW_THICKNESS,
                }),
              ]
            : [],
          font("node"),
        );
      }),
      rules(),
      eachItem(
        names,
        tx("node", style, geom),
        arrows ? afterEach(names, arrowConnector("arrow"), true) : "",
      ),
    ].join("");

/** A circle cut into equal slices, each label near its slice's middle. */
const wheel: Def = ({ names, rtl }) => {
  // Mirrored, slices run counterclockwise from the top.
  const sliceOf = (k: number, n: number) => {
    const s = wheelSlice(k, n);
    return rtl
      ? {
          start: (540 - s.end) % 360,
          end: (540 - s.start) % 360,
          text: { ...s.text, x: 1 - s.text.x - s.text.w },
        }
      : s;
  };
  const slice = (n: number, k: number) => `slice${n}_${k + 1}`;
  const label = (n: number, k: number) => `label${n}_${k + 1}`;
  const nodes = (n: number, k: number) => {
    if (n === 1) return tx(slice(n, k), "node1", "ellipse");
    const s = sliceOf(k, n);
    return (
      sp(slice(n, k), "node1", "pie", { adj: [s.start, s.end] }) +
      tx(label(n, k), "sibTrans2D1", "rect", { hidden: true })
    );
  };
  return [
    alg("composite"),
    shape(),
    presOf(),
    perCount(names, (n) =>
      constrs(
        Array.from({ length: n }, (_, k) => {
          const t = sliceOf(k, n).text;
          return [
            ...place(slice(n, k), {
              ctrX: D(0.5),
              ctrY: D(0.5, "h"),
              w: D(1, "h"),
              h: D(1, "h"),
            }),
            ...(n > 1
              ? [
                  ...place(label(n, k), {
                    l: D(0.5, "w", D(t.x - 0.5, "h")),
                    t: D(t.y, "h"),
                    w: D(t.w, "h"),
                    h: D(t.h, "h"),
                  }),
                  font(label(n, k)),
                ]
              : [font(slice(n, k))]),
          ];
        }).flat(),
      ),
    ),
    rules(),
    perCountNodes(names, (n, each) =>
      fe(
        { name: each, axis: "ch", ptType: "node" },
        choose(
          names,
          Array.from(
            { length: n - 1 },
            (_, k) => [before(k), nodes(n, k)] as const,
          ),
          nodes(n, n - 1),
        ),
      ),
    ),
  ].join("");
};

/** A hub joined to the items around it. One top-level item is the hub with
 *  its sub-items around it; otherwise the first item is the hub. */
const hubSpokes: Def = ({ names, rtl }) => {
  const sizes = (n: number, hub: string, sat: string) => {
    const s = hubSizes(n);
    return constrs(
      C("w", { forName: hub, refType: "h", fact: s.hub }),
      C("h", { forName: hub, refType: "h", fact: s.hub }),
      C("w", { forName: sat, refType: "h", fact: s.sat }),
      C("h", { forName: sat, refType: "h", fact: s.sat }),
      C("diam", { refType: "h", fact: n ? 1 - s.sat : 0 }),
      font(hub),
      font(sat),
    );
  };
  const cycle = alg("cycle", {
    stAng: 0,
    spanAng: rtl ? -360 : 360,
    ctrShpMap: "fNode",
  });
  const single = [
    cycle,
    shape(),
    presOf(),
    choose(
      names,
      [[count(0, "ch ch"), sizes(0, "hub", "satellite")]],
      perCount(names, (n) => sizes(n, "hub", "satellite"), "ch ch"),
    ),
    rules(),
    eachItem(
      names,
      tx("hub", "node0", "ellipse", { axis: "self" }),
      eachItem(
        names,
        fe(
          {
            name: names.next("spoke"),
            axis: "precedSib",
            ptType: "parTrans",
            st: -1,
            cnt: 1,
          },
          connector(
            "spoke",
            "parChTrans1D2",
            {
              dim: "1D",
              endSty: "noArr",
              connRout: "stra",
              begPts: "auto",
              endPts: "auto",
            },
            "conn",
          ),
        ),
        tx("satellite", "node1", "ellipse"),
      ),
    ),
  ].join("");
  // Several top-level items: no data joins the hub to the others, so there
  // are no spokes.
  const several = [
    cycle,
    shape(),
    presOf(),
    perCount(names, (n) => sizes(n - 1, "center", "around")),
    rules(),
    fe(
      { name: names.next("center"), axis: "ch", ptType: "node", cnt: 1 },
      tx("center", "node0", "ellipse"),
    ),
    fe(
      { name: names.next("around"), axis: "ch", ptType: "node", st: 2 },
      tx("around", "node1", "ellipse"),
    ),
  ].join("");
  return choose(names, [[count(1), single]], several);
};

/** Labels riding on a continuous ring. */
const ringTrack: Def = ({ names, rtl }) =>
  [
    alg("composite"),
    shape(),
    presOf(),
    perCount(names, (n) => {
      const s = ringTrackSizes(n);
      return constrs(
        place(`track${n}`, {
          ctrX: D(0.5),
          ctrY: D(s.cy, "h"),
          w: D(s.track, "h"),
          h: D(s.track, "h"),
        }),
        place("ring", { l: D(0), t: D(0), w: D(1), h: D(1, "h") }),
      );
    }),
    rules(),
    perCountNodes(names, (n, each) => {
      const s = ringTrackSizes(n);
      return fe(
        { name: each, axis: "self" },
        sp(`track${n}`, "trBgShp", "donut", {
          adj: [(s.k * RING_TRACK.band) / s.track],
        }),
      );
    }),
    box(
      "ring",
      alg("cycle", { stAng: 0, spanAng: rtl ? -360 : 360 }),
      [],
      perCount(names, (n) => {
        const s = ringTrackSizes(n);
        return constrs(
          C("w", {
            forName: "node",
            refType: "h",
            fact: s.k * RING_TRACK.ratio,
          }),
          C("h", { forName: "node", refType: "h", fact: s.k }),
          C("diam", { refType: "h", fact: 2 * s.r }),
          font("node"),
        );
      }),
      eachItem(names, tx("node", "node1", "roundRect")),
    ),
  ].join("");

// ---------------------------------------------------------------- Hierarchies

const tree =
  (opts: { horizontal?: boolean; round?: boolean }): Def =>
  ({ names, rtl }) => {
    const geom = opts.round ? "ellipse" : "rect";
    const h = !!opts.horizontal;
    const link = fe(
      {
        name: names.next("link"),
        axis: "precedSib",
        ptType: "parTrans",
        st: -1,
        cnt: 1,
      },
      connector(
        "link",
        "parChTrans1D2",
        opts.round
          ? {
              dim: "1D",
              endSty: "noArr",
              connRout: "stra",
              begPts: "auto",
              endPts: "auto",
            }
          : {
              dim: "1D",
              endSty: "noArr",
              connRout: "bend",
              begPts: h ? (rtl ? "midL" : "midR") : "bCtr",
              endPts: h ? (rtl ? "midR" : "midL") : "tCtr",
            },
        "conn",
      ),
    );
    const branchAlg = alg("hierChild", {
      linDir: h ? "fromT" : fromStart(rtl),
      chAlign: h ? (rtl ? "r" : "l") : "t",
    });
    const rootAlg = alg("hierRoot", {
      hierAlign: h ? (rtl ? "rCtrCh" : "lCtrCh") : "tCtrCh",
    });
    const memberEach = names.next("members");
    const member = (name: string, style: string, nested: string) =>
      box(
        name,
        rootAlg,
        [],
        tx(`${name}Text`, style, geom, { axis: "self" }),
        box(`${name}Branch`, branchAlg, [], nested),
      );
    const recurse = fe(
      { name: memberEach, axis: "ch", ptType: "node" },
      link,
      member(
        "member",
        "node1",
        fe({ name: names.next("again"), ref: memberEach }),
      ),
    );
    const nodeW = opts.round ? TREE.round : h ? TREE.w : TREE.w;
    const nodeH = opts.round ? TREE.round : TREE.h;
    return [
      branchAlg,
      shape(),
      presOf(),
      constrs(
        ["topText", "memberText"].flatMap((forName) => [
          C("w", { for: "des", forName, refType: "w", fact: nodeW }),
          C("h", { for: "des", forName, refType: "w", fact: nodeH }),
          font(forName, 28, "des"),
        ]),
        ["top", "member"].map((forName) =>
          C("sp", { for: "des", forName, refType: "w", fact: TREE.level }),
        ),
        ["topBranch", "memberBranch"].map((forName) =>
          C("sibSp", { for: "des", forName, refType: "w", fact: TREE.sibling }),
        ),
        C("sibSp", { refType: "w", fact: TREE.sibling }),
      ),
      rules(),
      eachItem(names, member("top", "node0", recurse)),
    ].join("");
  };

/** Each item spans the items below it; leaves reach the bottom. Siblings
 *  share their parent's width equally. A block spans the rows from its own
 *  level down, so its heading takes 1/(rows) of it. */
const layeredBlocks: Def = ({ names, rtl }) => {
  const levels = 6;
  const kidsEach = names.next("blocks");
  const block = (top: boolean): string => {
    const nm = (s: string) => (top ? `top${s}` : s.toLowerCase());
    const style = top ? "node0" : "node1";
    const rows = choose(
      names,
      Array.from({ length: levels }, (_, k) => k + 1).map(
        (d) =>
          [
            { ...depthIs(d), axis: "root des", ptType: "doc node" },
            choose(
              names,
              Array.from({ length: top ? 1 : d }, (_, j) => j + 1).map(
                (level) =>
                  [
                    { axis: "self", func: "depth", op: "equ", val: level },
                    constrs(
                      place(nm("Head"), {
                        l: D(0),
                        t: D(0),
                        w: D(1),
                        h: D(1 / (d - level + 1), "h"),
                      }),
                      place(nm("Kids"), {
                        l: D(0),
                        t: D(1 / (d - level + 1), "h"),
                        w: D(1),
                        b: D(1, "h"),
                      }),
                    ),
                  ] as const,
              ),
            ),
          ] as const,
      ),
    );
    return box(
      nm("Block"),
      alg("composite"),
      [],
      choose(
        names,
        [
          [
            atLeast(1),
            [
              rows,
              tx(nm("Head"), style, "rect", { axis: "self" }),
              box(
                nm("Kids"),
                alg("lin", { linDir: fromStart(rtl) }),
                [
                  C("w", { forName: "block", refType: "w" }),
                  C("h", { forName: "block", refType: "h" }),
                ],
                top
                  ? fe(
                      { name: kidsEach, axis: "ch", ptType: "node" },
                      block(false),
                    )
                  : fe({ name: names.next("again"), ref: kidsEach }),
              ),
            ].join(""),
          ],
        ],
        [
          constrs(
            place(nm("Leaf"), { l: D(0), t: D(0), w: D(1), h: D(1, "h") }),
          ),
          tx(nm("Leaf"), style, "rect", { axis: "self" }),
        ].join(""),
      ),
    );
  };
  return [
    alg("lin", { linDir: fromStart(rtl) }),
    shape(),
    presOf(),
    constrs(
      C("w", { forName: "topBlock", refType: "w" }),
      C("h", { forName: "topBlock", refType: "h" }),
      ["topHead", "head", "topLeaf", "leaf"].map((forName) =>
        font(forName, 28, "des"),
      ),
    ),
    rules(),
    eachItem(names, block(true)),
  ].join("");
};

// ---------------------------------------------------------------- Relationships

/** Overlapping circles around a center, their text pushed outward. */
const venn: Def = ({ names, rtl }) => {
  const max = 8;
  const circle = (n: number, k: number) => `circle${n}_${k + 1}`;
  const label = (n: number, k: number) => `label${n}_${k + 1}`;
  const nodes = (n: number, k: number) =>
    sp(circle(n, k), "vennNode1", "ellipse") +
    tx(label(n, k), "sibTrans2D1", "rect", { hidden: true });
  return [
    alg("composite"),
    shape(),
    presOf(),
    perCount(
      names,
      (n) => {
        const s = vennSizes(n);
        const r = s.diam / 2;
        const cy = 0.5 + r * ringCenterShift(n);
        return constrs(
          Array.from({ length: n }, (_, i) => {
            const a = ringAngle(i, n);
            const x = (rtl ? -1 : 1) * r * Math.cos(a),
              y = cy + r * Math.sin(a);
            const t = vennTextBox(i, n);
            const tx0 = x - s.d / 2 + (rtl ? 1 - t.x - t.w : t.x) * s.d;
            return [
              ...place(circle(n, i), {
                ctrX: D(0.5, "w", D(x, "h")),
                ctrY: D(y, "h"),
                w: D(s.d, "h"),
                h: D(s.d, "h"),
              }),
              ...place(label(n, i), {
                l: D(0.5, "w", D(tx0, "h")),
                t: D(y - s.d / 2 + t.y * s.d, "h"),
                w: D(t.w * s.d, "h"),
                h: D(t.h * s.d, "h"),
              }),
              font(label(n, i)),
            ];
          }).flat(),
        );
      },
      "ch",
      max,
    ),
    rules(),
    perCountNodes(
      names,
      (n, each) =>
        fe(
          { name: each, axis: "ch", ptType: "node" },
          choose(
            names,
            Array.from(
              { length: n - 1 },
              (_, k) => [before(k), nodes(n, k)] as const,
            ),
            nodes(n, n - 1),
          ),
        ),
      "ch",
      max,
    ),
  ].join("");
};

/** A row of overlapping circles. */
const linkedCircles: Def = ({ names, rtl }) =>
  [
    alg("lin", { linDir: fromStart(rtl) }),
    shape(),
    presOf(),
    perCount(names, (n) => {
      const d = 1 / (n - (n - 1) * 0.22);
      return constrs(
        C("w", { forName: "circle", refType: "w", fact: d }),
        C("w", { forName: "circle", refType: "h", op: "lte" }),
        C("h", { forName: "circle", refType: "w", fact: d }),
        C("h", { forName: "circle", refType: "h", op: "lte" }),
        C("w", { forName: "gap", refType: "w", fact: -0.22 * d }),
        C("w", { forName: "gap", refType: "h", fact: -0.22, op: "gte" }),
        font("circle"),
      );
    }),
    rules(),
    eachItem(names, tx("circle", "vennNode1", "ellipse"), gap(names, "gap")),
  ].join("");

/** Circles inside one another, sharing their bottom. */
const nestedCircles: Def = ({ names }) => {
  const max = 8;
  const ring = (k: number, n: number) => `ring${n}_${k + 1}`;
  const label = (k: number, n: number) => `label${n}_${k + 1}`;
  const nodes = (k: number, n: number) =>
    sp(ring(k, n), "vennNode1", "ellipse") +
    tx(label(k, n), "node1", "rect", { hidden: true });
  return [
    alg("composite"),
    shape(),
    presOf(),
    perCount(
      names,
      (n) =>
        constrs(
          Array.from({ length: n }, (_, k) => {
            const c = nestedCircle(k, n);
            return [
              ...place(ring(k, n), {
                ctrX: D(0.5),
                b: D(1, "h"),
                w: D(c.d, "h"),
                h: D(c.d, "h"),
              }),
              ...place(label(k, n), {
                ctrX: D(0.5),
                t: D(1 - c.d + c.text.y * c.d, "h"),
                w: D(c.text.w * c.d, "h"),
                h: D(c.text.h * c.d, "h"),
              }),
              font(label(k, n)),
            ];
          }).flat(),
        ),
      "ch",
      max,
    ),
    rules(),
    perCountNodes(
      names,
      (n, each) =>
        fe(
          { name: each, axis: "ch", ptType: "node" },
          choose(
            names,
            Array.from(
              { length: n - 1 },
              (_, k) => [before(k), nodes(k, n)] as const,
            ),
            nodes(n - 1, n),
          ),
        ),
      "ch",
      max,
    ),
  ].join("");
};

/** Concentric rings with a label for each on the right, joined by leaders. */
const target: Def = ({ names }) => {
  const max = 8;
  const nm = (s: string, k: number, n: number) => `${s}${n}_${k + 1}`;
  const nodes = (k: number, n: number) =>
    sp(nm("ring", k, n), "node1", "ellipse") +
    sp(nm("leader", k, n), "parChTrans1D2", "line") +
    tx(nm("label", k, n), "revTx", "rect", { align: "l" });
  return [
    alg("composite"),
    shape(),
    presOf(),
    perCount(
      names,
      (n) =>
        constrs(
          Array.from({ length: n }, (_, k) => {
            const t = targetRing(k, n);
            return [
              ...place(nm("ring", k, n), {
                ctrX: D(0.5, "h"),
                ctrY: D(0.5, "h"),
                w: D(t.d, "h"),
                h: D(t.d, "h"),
              }),
              ...place(nm("leader", k, n), {
                l: D(0.5, "h"),
                t: D(t.y, "h"),
                w: D(TARGET_TEXT_X - 0.5, "h"),
                h: D(0, "h"),
              }),
              ...place(nm("label", k, n), {
                l: D(TARGET_TEXT_X, "h"),
                ctrY: D(t.y, "h"),
                h: D(t.labelH, "h"),
              }),
              C("r", { forName: nm("label", k, n), refType: "w" }),
              font(nm("label", k, n)),
            ];
          }).flat(),
        ),
      "ch",
      max,
    ),
    rules(),
    perCountNodes(
      names,
      (n, each) =>
        fe(
          { name: each, axis: "ch", ptType: "node" },
          choose(
            names,
            Array.from(
              { length: n - 1 },
              (_, k) => [before(k), nodes(k, n)] as const,
            ),
            nodes(n - 1, n),
          ),
        ),
      "ch",
      max,
    ),
  ].join("");
};

/** Arrows that alternate direction, stacked. */
const counterArrows: Def = ({ names }) => {
  const forthEach = names.next("forth");
  return [
    alg("lin", { linDir: "fromT" }),
    shape(),
    presOf(),
    constrs(
      C("w", { forName: "lane", refType: "w" }),
      C("h", { forName: "lane", refType: "h" }),
      C("h", {
        forName: "gap",
        refType: "h",
        refFor: "ch",
        refForName: "lane",
        fact: 0.1,
      }),
      font("forth", 28, "des"),
      font("back", 28, "des"),
    ),
    rules(),
    eachItem(
      names,
      box(
        "lane",
        alg("composite"),
        [
          ...place("forth", { l: D(0), t: D(0), w: D(0.88), h: D(1, "h") }),
          ...place("back", { l: D(0.12), t: D(0), w: D(0.88), h: D(1, "h") }),
        ],
        choose(
          names,
          Array.from(
            { length: MAX_COUNTED },
            (_, j) =>
              [
                before(2 * j),
                j
                  ? fe({ name: names.next("forthRef"), ref: forthEach })
                  : fe(
                      { name: forthEach, axis: "self" },
                      tx("forth", "node1", "rightArrow", { adj: [0.7, 0.6] }),
                    ),
              ] as const,
          ),
          tx("back", "node1", "leftArrow", { adj: [0.7, 0.6] }),
        ),
      ),
      gap(names, "gap"),
    ),
  ].join("");
};

/** Arrows from both sides pointing at the first item. */
const convergingArrows: Def = ({ names }) => {
  const side = (name: string, st: number, geom: string) =>
    box(
      `${name}s`,
      alg("lin", { linDir: "fromT" }),
      [
        C("w", { forName: name, refType: "w" }),
        C("h", { forName: name, refType: "h" }),
      ],
      fe(
        { name: names.next(name), axis: "ch", ptType: "node", st, step: 2 },
        box(
          name,
          alg("composite"),
          place(`${name}Arrow`, {
            l: D(0),
            w: D(1),
            ctrY: D(0.5, "h"),
            h: D(1 / 1.12, "h"),
          }),
          tx(`${name}Arrow`, "node1", geom, { adj: [0.7, 0.45] }),
        ),
      ),
    );
  return [
    alg("composite"),
    shape(),
    presOf(),
    constrs(
      place("hub", { ctrX: D(0.5), ctrY: D(0.5, "h"), w: D(0.28), h: D(0.28) }),
      C("w", { forName: "hub", refType: "h", fact: 0.7, op: "lte" }),
      C("h", { forName: "hub", refType: "h", fact: 0.7, op: "lte" }),
      place("lefts", { l: D(0), t: D(0), w: D(0.34), h: D(1, "h") }),
      place("rights", { l: D(0.66), t: D(0), w: D(0.34), h: D(1, "h") }),
      font("leftArrow", 28, "des"),
      font("rightArrow", 28, "des"),
      font("hub"),
    ),
    rules(),
    side("left", 2, "rightArrow"),
    side("right", 3, "leftArrow"),
    fe(
      { name: names.next("hub"), axis: "ch", ptType: "node", cnt: 1 },
      tx("hub", "node0", "ellipse"),
    ),
  ].join("");
};

/** Terms joined by plus signs, then an equals sign and the result. */
const equation: Def = ({ names, rtl }) => {
  const operator = (name: string, geom: string) =>
    afterEach(
      names,
      box(
        name,
        alg("composite"),
        place(`${name}Sign`, {
          l: D(0.1),
          w: D(0.8),
          h: D(0.8),
          ctrY: D(0.5, "h"),
        }),
        sp(`${name}Sign`, "sibTrans2D1", geom),
      ),
    );
  return [
    alg("lin", { linDir: fromStart(rtl) }),
    shape(),
    presOf(),
    perCount(names, (n) => {
      const d = 1 / (n + (n - 1) * 0.6);
      return constrs(
        ["term", "result", "only"].flatMap((name) => [
          C("w", { forName: name, refType: "w", fact: d }),
          C("w", { forName: name, refType: "h", op: "lte" }),
          C("h", { forName: name, refType: "w", fact: d }),
          C("h", { forName: name, refType: "h", op: "lte" }),
          font(name),
        ]),
        ["plus", "equals"].flatMap((name) => [
          C("w", { forName: name, refType: "w", fact: d * 0.6 }),
          C("w", { forName: name, refType: "h", fact: 0.6, op: "lte" }),
          C("h", { forName: name, refType: "h" }),
        ]),
      );
    }),
    rules(),
    eachItem(
      names,
      choose(
        names,
        [
          [
            after(0),
            choose(
              names,
              [[before(0), tx("only", "node1", "ellipse")]],
              tx("result", "node0", "ellipse"),
            ),
          ],
        ],
        tx("term", "node1", "ellipse"),
      ),
      choose(
        names,
        [[after(1), operator("equals", "mathEqual")]],
        operator("plus", "mathPlus"),
      ),
    ),
  ].join("");
};

// ---------------------------------------------------------------- Matrices

/** Quadrants around a centered label. One top-level item is the center
 *  with its sub-items around it; otherwise the first item is the center. */
const centeredQuadrants: Def = ({ names, rtl }) => {
  const max = 8;
  const variant = (single: boolean) => {
    const prefix = single ? "sub" : "quad";
    const hub = single ? "hub" : "center";
    const nm = (i: number, n: number) => `${prefix}${n}_${i + 1}`;
    const label = (i: number, n: number) => `${prefix}Text${n}_${i + 1}`;
    const quad = (i: number, n: number) => {
      const q = quadrantCell(i, n);
      const right = rtl ? !q.col : !!q.col;
      return (
        sp(nm(i, n), "node1", "rect") +
        tx(label(i, n), "sibTrans2D1", "rect", {
          anchor: q.top ? "t" : "b",
          align: right ? "r" : "l",
          hidden: true,
        })
      );
    };
    const hubBox = (n: number) => {
      const hd = n ? 0.4 : 0.8;
      return [
        ...place(hub, {
          ctrX: D(0.5),
          ctrY: D(0.5, "h"),
          w: D(hd, "h"),
          h: D(hd * 0.7, "h"),
        }),
        font(hub),
      ];
    };
    const sizes = (n: number) =>
      constrs(
        hubBox(n),
        Array.from({ length: n }, (_, i) => {
          const q = quadrantCell(i, n);
          const x = rtl ? 1 - q.x - q.w : q.x;
          const tx0 = rtl ? 1 - q.text.x - q.text.w : q.text.x;
          return [
            ...place(nm(i, n), {
              l: D(0.5, "w", D(x - 0.5, "h")),
              t: D(q.y, "h"),
              w: D(q.w, "h"),
              h: D(q.h, "h"),
            }),
            ...place(label(i, n), {
              l: D(0.5, "w", D(x + tx0 * q.w - 0.5, "h")),
              t: D(q.y + q.text.y * q.h, "h"),
              w: D(q.text.w * q.w, "h"),
              h: D(q.text.h * q.h, "h"),
            }),
            font(label(i, n)),
          ];
        }).flat(),
      );
    const quads = (axisOffset: number) =>
      perCountNodes(
        names,
        (n, each) =>
          fe(
            {
              name: each,
              axis: "ch",
              ptType: "node",
              ...(axisOffset ? { st: 2 } : {}),
            },
            choose(
              names,
              Array.from(
                { length: n - 1 },
                (_, i) => [before(i + axisOffset), quad(i, n)] as const,
              ),
              quad(n - 1, n),
            ),
          ),
        "ch",
        max,
        axisOffset,
      );
    return { hub, sizes, quads };
  };
  const one = variant(true),
    several = variant(false);
  return choose(
    names,
    [
      [
        count(1),
        [
          alg("composite"),
          shape(),
          presOf(),
          choose(
            names,
            [[count(0, "ch ch"), one.sizes(0)]],
            perCount(names, one.sizes, "ch ch", max),
          ),
          rules(),
          eachItem(
            names,
            choose(names, [[atLeast(1), one.quads(0)]]),
            tx(one.hub, "node0", "roundRect", { axis: "self", adj: [0.2] }),
          ),
        ].join(""),
      ],
    ],
    [
      alg("composite"),
      shape(),
      presOf(),
      perCount(names, several.sizes, "ch", max, 1),
      rules(),
      several.quads(1),
      fe(
        { name: names.next("center"), axis: "ch", ptType: "node", cnt: 1 },
        tx(several.hub, "node0", "roundRect", { adj: [0.2] }),
      ),
    ].join(""),
  );
};

/** Column headings with a stack of cells beneath each. */
const headerGrid: Def = ({ names, rtl }) => {
  const headH = 0.3;
  return [
    alg("lin", { linDir: fromStart(rtl) }),
    shape(),
    presOf(),
    constrs(
      C("w", { forName: "column", refType: "w" }),
      C("h", { forName: "column", refType: "h" }),
      C("w", {
        forName: "gap",
        refType: "w",
        refFor: "ch",
        refForName: "column",
        fact: 0.04,
      }),
      font("head", 28, "des"),
      font("cell", 28, "des"),
    ),
    rules(),
    eachItem(
      names,
      box(
        "column",
        alg("composite"),
        [
          ...place("head", { l: D(0), t: D(0), w: D(1), h: D(headH, "h") }),
          ...place("cells", {
            l: D(0),
            t: D(headH * 1.08, "h"),
            w: D(1),
            b: D(1, "h"),
          }),
        ],
        tx("head", "node0", "rect", { axis: "self" }),
        box(
          "cells",
          alg("lin", { linDir: "fromT" }),
          [
            C("w", { forName: "cell", refType: "w" }),
            C("h", { forName: "cell", refType: "h" }),
            C("h", {
              forName: "cellGap",
              refType: "h",
              refFor: "ch",
              refForName: "cell",
              fact: 0.05,
            }),
          ],
          fe(
            { name: names.next("cells"), axis: "ch", ptType: "node" },
            tx("cell", "alignAccFollowNode1", "rect"),
            gap(names, "cellGap"),
          ),
        ),
      ),
      gap(names, "gap"),
    ),
  ].join("");
};

/** Leaf-shaped quarters facing one another. */
const petals: Def = ({ names, rtl }) => {
  const altEach = names.next("alt");
  // Positions whose (column + row) is odd in two columns: 1, 2, 5, 6, ...
  const odd = Array.from({ length: 2 * MAX_COUNTED }, (_, k) => k).filter(
    (k) => k % 4 === 1 || k % 4 === 2,
  );
  const petal = (name: string, flipped: boolean) =>
    tx(name, "node1", "round2DiagRect", {
      adj: flipped !== rtl ? [0, 0.45] : [0.45, 0],
    });
  return [
    alg("snake", {
      grDir: rtl ? "tR" : "tL",
      flowDir: "row",
      contDir: "sameDir",
      off: "off",
      bkpt: "fixed",
      bkPtFixedVal: 2,
    }),
    shape(),
    presOf(),
    constrs(
      ["petal", "petalAlt"].flatMap((name) => [
        C("w", { forName: name, refType: "w" }),
        C("h", { forName: name, refType: "w", refFor: "ch", refForName: name }),
      ]),
      C("w", {
        forName: "gap",
        refType: "w",
        refFor: "ch",
        refForName: "petal",
        fact: 0.0526,
      }),
      C("sp", { refType: "w", refFor: "ch", refForName: "gap" }),
      font("petal"),
      font("petalAlt"),
    ),
    rules(),
    eachItem(
      names,
      choose(
        names,
        odd.map(
          (k, j) =>
            [
              before(k),
              j
                ? fe({ name: names.next("altRef"), ref: altEach })
                : fe({ name: altEach, axis: "self" }, petal("petalAlt", true)),
            ] as const,
        ),
        petal("petal", false),
      ),
      gap(names, "gap"),
    ),
  ].join("");
};

// ---------------------------------------------------------------- Pyramids

/** Levels of a pyramid: apex first. */
const pyramid =
  (inverted: boolean): Def =>
  ({ names }) =>
    [
      // The pyramid algorithm widens its levels away from the end it starts
      // at: starting from the bottom gives the apex at the top, with the
      // first item there (as desktop editors lay it out).
      alg("pyra", { linDir: inverted ? "fromT" : "fromB", txDir: "fromT" }),
      shape(),
      presOf(),
      constrs(
        C("w", { forName: "level", refType: "w" }),
        C("h", { forName: "level", refType: "h" }),
        font("level"),
      ),
      rules(),
      eachItem(names, tx("level", "node1", "trapezoid")),
    ].join("");

/** A pyramid backdrop with a bar for each level beside it. */
const pyramidLedger: Def = ({ names, rtl }) =>
  [
    alg("composite"),
    shape(),
    presOf(),
    constrs(
      place(
        "backdrop",
        { l: D(0), t: D(0), w: D(1.2, "h"), h: D(1, "h") },
        rtl,
      ),
      C("w", { forName: "backdrop", refType: "w", fact: 0.6, op: "lte" }),
      place("bars", { l: D(0.66, "h"), t: D(0.1, "h"), b: D(1, "h") }, rtl),
      C(rtl ? "l" : "r", { forName: "bars", refType: "w", fact: rtl ? 0 : 1 }),
      font("barText", 28, "des"),
    ),
    rules(),
    sp("backdrop", "trBgShp", "triangle"),
    box(
      "bars",
      alg("lin", { linDir: "fromT" }),
      [
        C("w", { forName: "bar", refType: "w" }),
        C("h", { forName: "bar", refType: "h" }),
        C("h", {
          forName: "gap",
          refType: "h",
          refFor: "ch",
          refForName: "bar",
          fact: 0.15,
        }),
      ],
      eachItem(
        names,
        tx("bar", "node1", "roundRect", { align: rtl ? "r" : "l" }),
        gap(names, "gap"),
      ),
    ),
  ].join("");

// ---------------------------------------------------------------- Pictures

const picture = (name: string, geom: string) =>
  el(
    "layoutNode",
    { name, styleLbl: "alignImgPlace1" },
    alg("sp"),
    shape(geom, { picture: true }),
    presOf(),
    constrs(),
    rules(),
  );

/** Pictures side by side with captions under them. */
const captionedPictures =
  (geom: "rect" | "ellipse"): Def =>
  ({ names, rtl }) => {
    const round = geom === "ellipse";
    const gapRatio = round ? 0.15 : 0.1;
    // The picture's share of the item's height.
    const share = round ? 0.62 : 0.68;
    return [
      alg("lin", { linDir: fromStart(rtl) }),
      shape(),
      presOf(),
      perCount(names, (n) => {
        const cell = 1 / (n + (n - 1) * gapRatio);
        return constrs(
          C("w", { forName: "item", refType: "w", fact: cell }),
          C("h", {
            forName: "item",
            refType: "w",
            fact: (cell * (round ? 1 : 0.9)) / share,
          }),
          C("h", { forName: "item", refType: "h", op: "lte" }),
          C("w", { forName: "gap", refType: "w", fact: cell * gapRatio }),
          font("caption", 28, "des"),
        );
      }),
      rules(),
      eachItem(
        names,
        box(
          "item",
          alg("composite"),
          round
            ? [
                ...place("image", {
                  ctrX: D(0.5),
                  t: D(0),
                  w: D(share, "h"),
                  h: D(share, "h"),
                }),
                C("w", { forName: "image", refType: "w", op: "lte" }),
                C("h", { forName: "image", refType: "w", op: "lte" }),
                ...place("caption", {
                  l: D(0),
                  w: D(1),
                  t: D(share * 1.04, "h"),
                  b: D(1, "h"),
                }),
              ]
            : [
                ...place("image", {
                  l: D(0),
                  w: D(1),
                  t: D(0),
                  h: D(share, "h"),
                }),
                ...place("caption", {
                  l: D(0),
                  w: D(1),
                  t: D(share, "h"),
                  b: D(1, "h"),
                }),
              ],
          picture("image", geom),
          tx("caption", "revTx", "rect", { anchor: "t" }),
        ),
        gap(names, "gap"),
      ),
    ].join("");
  };

/** A grid of pictures with a caption band across each foot. */
const pictureTiles: Def = ({ names, rtl }) =>
  [
    alg("snake", {
      grDir: rtl ? "tR" : "tL",
      flowDir: "row",
      contDir: "sameDir",
      off: "ctr",
    }),
    shape(),
    presOf(),
    constrs(
      C("w", { forName: "tile", refType: "w" }),
      C("h", {
        forName: "tile",
        refType: "w",
        refFor: "ch",
        refForName: "tile",
        fact: 1 / 1.3,
      }),
      C("w", {
        forName: "gap",
        refType: "w",
        refFor: "ch",
        refForName: "tile",
        fact: 0.1,
      }),
      C("sp", { refType: "w", refFor: "ch", refForName: "gap" }),
      font("caption", 28, "des"),
    ),
    rules(),
    eachItem(
      names,
      box(
        "tile",
        alg("composite"),
        [
          ...place("image", { l: D(0), t: D(0), w: D(1), h: D(1, "h") }),
          ...place("caption", {
            l: D(0),
            w: D(1),
            t: D(0.7, "h"),
            h: D(0.3, "h"),
          }),
        ],
        picture("image", "rect"),
        tx("caption", "node1", "rect"),
      ),
      gap(names, "gap"),
    ),
  ].join("");

/** A list where each item leads with a round picture. */
const pictureBullets: Def = ({ names, rtl }) =>
  [
    alg("lin", { linDir: "fromT" }),
    shape(),
    presOf(),
    constrs(
      C("w", { forName: "row", refType: "w" }),
      C("h", { forName: "row", refType: "h" }),
      C("h", {
        forName: "gap",
        refType: "h",
        refFor: "ch",
        refForName: "row",
        fact: 0.15,
      }),
      font("barText", 28, "des"),
    ),
    rules(),
    eachItem(
      names,
      box(
        "row",
        alg("composite"),
        [
          ...place(
            "bar",
            { l: D(0.5, "h"), t: D(0.12, "h"), h: D(0.76, "h") },
            rtl,
          ),
          C(rtl ? "l" : "r", {
            forName: "bar",
            refType: "w",
            fact: rtl ? 0 : 1,
          }),
          ...place(
            "image",
            { l: D(0), ctrY: D(0.5, "h"), w: D(1, "h"), h: D(1, "h") },
            rtl,
          ),
          C("w", { forName: "image", refType: "w", fact: 0.25, op: "lte" }),
          C("h", { forName: "image", refType: "w", fact: 0.25, op: "lte" }),
          ...place(
            "barText",
            { l: D(1.15, "h"), t: D(0.12, "h"), h: D(0.76, "h") },
            rtl,
          ),
          C(rtl ? "l" : "r", {
            forName: "barText",
            refType: "w",
            fact: rtl ? 0 : 1,
          }),
        ],
        sp("bar", "node1", "roundRect"),
        tx("barText", "sibTrans2D1", "rect", {
          align: rtl ? "r" : "l",
          hidden: true,
        }),
        picture("image", "ellipse"),
      ),
      gap(names, "gap"),
    ),
  ].join("");

// ---------------------------------------------------------------- Catalog

const DEFS: Record<string, Def> = {
  tiles,
  "banner-list": bannerList,
  "heading-columns": headingColumns("node1", "alignAccFollowNode1"),
  "stacked-cards": stackedCards,
  "ruled-list": ruledList,
  "grouped-boxes": groupedBoxes,
  "arrow-steps": arrowFlow(false),
  chevrons,
  "downward-flow": arrowFlow(true),
  "rising-steps": steps(false),
  timeline,
  "blocks-on-arrow": blocksOnArrow,
  ring: ring("ellipse", "node1", 1, 0.38, true),
  "text-ring": ring("rect", "revTx", 1.5, 0.38, true),
  "block-ring": ring("roundRect", "node1", 1.5, 0.3, true),
  wheel,
  "hub-spokes": hubSpokes,
  "ring-track": ringTrack,
  "org-chart": tree({}),
  "sideways-tree": tree({ horizontal: true }),
  "bubble-tree": tree({ round: true }),
  "layered-blocks": layeredBlocks,
  venn,
  "linked-circles": linkedCircles,
  "nested-circles": nestedCircles,
  target,
  "counter-arrows": counterArrows,
  "converging-arrows": convergingArrows,
  equation,
  quadrants: snakeTiles("roundRect", 1, 0.0417, false, {
    adj: [0.08],
    columns: 2,
  }),
  "centered-quadrants": centeredQuadrants,
  "header-grid": headerGrid,
  petals,
  pyramid: pyramid(false),
  "inverted-pyramid": pyramid(true),
  "pyramid-ledger": pyramidLedger,
  "stepped-pyramid": steps(true),
  "captioned-pictures": captionedPictures("rect"),
  "picture-tiles": pictureTiles,
  "picture-bullets": pictureBullets,
  "portrait-circles": captionedPictures("ellipse"),
};

/** The layout definition part for a layout, as XML text. */
export const layoutDefXml = (opts: {
  id: string;
  name: string;
  description: string;
  category: string;
  rightToLeft: boolean;
}): string => {
  const def = DEFS[opts.id] ?? tiles;
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<dgm:layoutDef xmlns:dgm="${NS.diagram}" xmlns:a="${NS.dml}" xmlns:r="${NS.officeDocRels}" uniqueId="${xmlAttr(LAYOUT_URN + opts.id)}">` +
    el("title", { val: opts.name }) +
    el("desc", { val: opts.description }) +
    el("catLst", {}, el("cat", { type: opts.category, pri: 100000 })) +
    el(
      "layoutNode",
      { name: "diagram" },
      el(
        "varLst",
        {},
        el("dir", opts.rightToLeft ? { val: "rev" } : {}),
        el("resizeHandles", { val: "exact" }),
      ),
      def({ names: new Names(), rtl: opts.rightToLeft }),
    ) +
    `</dgm:layoutDef>`
  );
};
