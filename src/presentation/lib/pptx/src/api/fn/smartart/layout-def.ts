// Layout definitions (ECMA-376 21.4.2) written for each authored layout.
//
// The saved drawing is what this app shows; the definition is what lets any
// other editor lay the same data out again when it is edited there. Each
// layout maps to one of a few families of standard layout algorithms.
import { NS } from "../../../internal/xml/index.ts";
import { xmlAttr } from "./xml.ts";

export type LayoutFamily =
  | { kind: "snake"; shape: string; aspect: number; columns?: number }
  | {
      kind: "linear";
      direction: "row" | "column";
      shape: string;
      aspect: number;
      arrow?: string;
      overlap?: boolean;
    }
  | {
      kind: "composite";
      direction: "row" | "column";
      head: string;
      split: "above" | "beside";
      picture?: boolean;
    }
  | {
      kind: "cycle";
      shape: string;
      arrows: boolean;
      hub?: boolean;
      venn?: boolean;
    }
  | { kind: "tree"; shape: string; horizontal?: boolean }
  | { kind: "pyramid"; inverted?: boolean }
  | { kind: "picture"; direction: "row" | "column"; frame: string };

export const LAYOUT_URN = "urn:everything:smartart:layout/";

const el = (
  name: string,
  attrs: Readonly<Record<string, string | number | undefined>> = {},
  ...children: string[]
): string => {
  const a = Object.entries(attrs)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => ` ${k}="${xmlAttr(String(v))}"`)
    .join("");
  return children.length
    ? `<dgm:${name}${a}>${children.join("")}</dgm:${name}>`
    : `<dgm:${name}${a}/>`;
};
const alg = (type: string, params: Record<string, string> = {}) =>
  el(
    "alg",
    { type },
    ...Object.entries(params).map(([k, v]) => el("param", { type: k, val: v })),
  );
const shape = (type?: string, extra: Record<string, string | number> = {}) =>
  el("shape", { ...(type ? { type } : {}), ...extra }, el("adjLst"));
const presOf = (axis?: string, ptType?: string) =>
  el("presOf", { axis, ptType });
const constr = (
  attrs: Readonly<Record<string, string | number | undefined>>,
): string => el("constr", attrs);
const constrLst = (...items: string[]) => el("constrLst", {}, ...items);
const fontRule = el(
  "ruleLst",
  {},
  el("rule", { type: "primFontSz", val: 5, fact: "NaN", max: "NaN" }),
);
const margins = constrLst(
  ...["tMarg", "bMarg", "lMarg", "rMarg"].map((type) =>
    constr({ type, refType: "primFontSz", fact: 0.3 }),
  ),
);
const node = (
  name: string,
  styleLbl: string,
  shapeType: string,
  presAxis = "desOrSelf",
  extra: string[] = [],
) =>
  el(
    "layoutNode",
    { name, styleLbl },
    el("varLst", {}, el("bulletEnabled", { val: 1 })),
    alg("tx"),
    shape(shapeType, { "r:blip": "" }),
    presOf(presAxis, "node"),
    margins,
    fontRule,
    ...extra,
  );
const spacer = (name: string) =>
  el(
    "forEach",
    { name: `${name}Each`, axis: "followSib", ptType: "sibTrans", cnt: 1 },
    el(
      "layoutNode",
      { name },
      alg("sp"),
      shape(),
      presOf(),
      constrLst(),
      el("ruleLst"),
    ),
  );
const arrowNode = (type: string) =>
  el(
    "forEach",
    { name: "arrowEach", axis: "followSib", ptType: "sibTrans", cnt: 1 },
    el(
      "layoutNode",
      { name: "arrow", styleLbl: "sibTrans2D1" },
      alg("sp"),
      shape(type),
      presOf(),
      constrLst(),
      el("ruleLst"),
    ),
  );
const rootVars = (rtl: boolean) =>
  el(
    "varLst",
    {},
    el("dir", rtl ? { val: "rev" } : {}),
    el("resizeHandles", { val: "exact" }),
  );

const body = (family: LayoutFamily, rtl: boolean): string => {
  const fromStart = rtl ? "fromR" : "fromL";
  switch (family.kind) {
    case "snake":
      return [
        alg("snake", {
          grDir: rtl ? "tR" : "tL",
          flowDir: "row",
          contDir: "sameDir",
          off: "ctr",
          ...(family.columns
            ? { bkpt: "fixed", bkPtFixedVal: String(family.columns) }
            : {}),
        }),
        shape(),
        presOf(),
        constrLst(
          constr({ type: "w", for: "ch", forName: "node", refType: "w" }),
          constr({
            type: "h",
            for: "ch",
            forName: "node",
            refType: "w",
            refFor: "ch",
            refForName: "node",
            fact: +(1 / family.aspect).toFixed(3),
          }),
          constr({
            type: "w",
            for: "ch",
            forName: "gap",
            refType: "w",
            refFor: "ch",
            refForName: "node",
            fact: 0.1,
          }),
          constr({
            type: "sp",
            refType: "w",
            refFor: "ch",
            refForName: "gap",
          }),
          constr({
            type: "primFontSz",
            for: "ch",
            forName: "node",
            op: "equ",
            val: 65,
          }),
        ),
        el("ruleLst"),
        el(
          "forEach",
          { name: "nodeEach", axis: "ch", ptType: "node" },
          node("node", "node1", family.shape),
          spacer("gap"),
        ),
      ].join("");
    case "linear": {
      const row = family.direction === "row";
      return [
        alg("lin", {
          linDir: row ? fromStart : "fromT",
          nodeVertAlign: "mid",
        }),
        shape(),
        presOf(),
        constrLst(
          constr({
            type: row ? "w" : "h",
            for: "ch",
            forName: "node",
            refType: row ? "w" : "h",
          }),
          constr({
            type: row ? "h" : "w",
            for: "ch",
            forName: "node",
            refType: row ? "w" : "h",
            refFor: "ch",
            refForName: "node",
            fact: +(row ? 1 / family.aspect : family.aspect).toFixed(3),
          }),
          constr({
            type: row ? "w" : "h",
            for: "ch",
            forName: "arrow",
            refType: row ? "w" : "h",
            refFor: "ch",
            refForName: "node",
            fact: 0.25,
          }),
          constr({
            type: row ? "h" : "w",
            for: "ch",
            forName: "arrow",
            refType: row ? "w" : "h",
            refFor: "ch",
            refForName: "arrow",
            fact: 1,
          }),
          ...(family.overlap
            ? [
                constr({
                  type: "sp",
                  refType: row ? "w" : "h",
                  refFor: "ch",
                  refForName: "node",
                  fact: -0.1,
                }),
              ]
            : []),
          constr({
            type: "primFontSz",
            for: "ch",
            forName: "node",
            op: "equ",
            val: 65,
          }),
        ),
        el("ruleLst"),
        el(
          "forEach",
          { name: "nodeEach", axis: "ch", ptType: "node" },
          node("node", "node1", family.shape),
          family.arrow ? arrowNode(family.arrow) : spacer("gap"),
        ),
      ].join("");
    }
    case "composite":
    case "picture": {
      const row = family.direction === "row";
      const above =
        family.kind === "composite" ? family.split === "above" : !row;
      const parts =
        family.kind === "picture"
          ? [
              el(
                "layoutNode",
                { name: "image", styleLbl: "alignImgPlace1" },
                alg("sp"),
                shape(family.frame, { "r:blip": "", blipPhldr: 1 }),
                presOf(),
                constrLst(),
                el("ruleLst"),
              ),
              node("caption", "revTx", "rect"),
            ]
          : [
              node("head", "node1", family.head, "self"),
              node("body", "alignAccFollowNode1", "rect", "des"),
            ];
      const [first, second] =
        family.kind === "picture" ? ["image", "caption"] : ["head", "body"];
      const split = family.kind === "picture" ? 0.7 : 0.3;
      const place = (name: string, start: number, size: number) =>
        above
          ? [
              constr({ type: "l", for: "ch", forName: name }),
              constr({ type: "w", for: "ch", forName: name, refType: "w" }),
              constr({
                type: "t",
                for: "ch",
                forName: name,
                refType: "h",
                fact: start,
              }),
              constr({
                type: "h",
                for: "ch",
                forName: name,
                refType: "h",
                fact: size,
              }),
            ]
          : [
              constr({ type: "t", for: "ch", forName: name }),
              constr({ type: "h", for: "ch", forName: name, refType: "h" }),
              constr({
                type: "l",
                for: "ch",
                forName: name,
                refType: "w",
                fact: start,
              }),
              constr({
                type: "w",
                for: "ch",
                forName: name,
                refType: "w",
                fact: size,
              }),
            ];
      const item = el(
        "layoutNode",
        { name: "item" },
        alg("composite"),
        shape(),
        presOf(),
        constrLst(
          ...place(first, 0, split),
          ...place(second, split, 1 - split),
        ),
        el("ruleLst"),
        ...parts,
      );
      return [
        alg("lin", { linDir: row ? fromStart : "fromT" }),
        shape(),
        presOf(),
        constrLst(
          constr({
            type: row ? "w" : "h",
            for: "ch",
            forName: "item",
            refType: row ? "w" : "h",
          }),
          constr({
            type: row ? "h" : "w",
            for: "ch",
            forName: "item",
            refType: row ? "w" : "h",
            refFor: "ch",
            refForName: "item",
            fact: row ? 1.6 : 4,
          }),
          constr({
            type: row ? "w" : "h",
            for: "ch",
            forName: "gap",
            refType: row ? "w" : "h",
            refFor: "ch",
            refForName: "item",
            fact: 0.1,
          }),
          constr({
            type: "primFontSz",
            for: "des",
            forName: first,
            op: "equ",
            val: 65,
          }),
          constr({
            type: "primFontSz",
            for: "des",
            forName: second,
            op: "equ",
            val: 65,
          }),
        ),
        el("ruleLst"),
        el(
          "forEach",
          { name: "itemEach", axis: "ch", ptType: "node" },
          item,
          spacer("gap"),
        ),
      ].join("");
    }
    case "cycle":
      return [
        alg("cycle", {
          stAng: "0",
          spanAng: "360",
          ...(family.hub ? { ctrShpMap: "fNode" } : {}),
        }),
        shape(),
        presOf(),
        constrLst(
          constr({
            type: "w",
            for: "ch",
            forName: "node",
            refType: "w",
            fact: family.venn ? 0.5 : 0.25,
          }),
          constr({
            type: "h",
            for: "ch",
            forName: "node",
            refType: "w",
            refFor: "ch",
            refForName: "node",
          }),
          constr({
            type: "w",
            for: "ch",
            forName: "arrow",
            refType: "w",
            refFor: "ch",
            refForName: "node",
            fact: 0.3,
          }),
          constr({
            type: "h",
            for: "ch",
            forName: "arrow",
            refType: "w",
            refFor: "ch",
            refForName: "arrow",
            fact: 0.6,
          }),
          ...(family.venn
            ? [
                constr({
                  type: "sp",
                  refType: "w",
                  refFor: "ch",
                  refForName: "node",
                  fact: -0.4,
                }),
              ]
            : []),
          constr({
            type: "primFontSz",
            for: "ch",
            forName: "node",
            op: "equ",
            val: 65,
          }),
        ),
        el("ruleLst"),
        el(
          "forEach",
          { name: "nodeEach", axis: "ch", ptType: "node" },
          node("node", family.venn ? "vennNode1" : "node1", family.shape),
          family.arrows ? arrowNode("rightArrow") : spacer("gap"),
        ),
      ].join("");
    case "tree": {
      const connector = el(
        "forEach",
        {
          name: "linkEach",
          axis: "precedSib",
          ptType: "parTrans",
          st: -1,
          cnt: 1,
        },
        el(
          "layoutNode",
          { name: "link", styleLbl: "parChTrans1D2" },
          alg("conn", {
            dim: "1D",
            endSty: "noArr",
            connRout: "bend",
            begPts: family.horizontal ? "midR" : "bCtr",
            endPts: family.horizontal ? "midL" : "tCtr",
          }),
          shape("conn"),
          presOf("self"),
          constrLst(),
          el("ruleLst"),
        ),
      );
      const branchAlg = alg("hierChild", {
        linDir: family.horizontal ? "fromT" : rtl ? "fromR" : "fromL",
        chAlign: family.horizontal ? "l" : "t",
      });
      const rootAlg = alg("hierRoot", {
        hierAlign: family.horizontal ? (rtl ? "rCtrCh" : "lCtrCh") : "tCtrCh",
      });
      const member = (name: string, style: string, nested: string) =>
        el(
          "layoutNode",
          { name },
          rootAlg,
          shape(),
          presOf(),
          constrLst(),
          el("ruleLst"),
          node(`${name}Text`, style, family.shape, "self"),
          el(
            "layoutNode",
            { name: `${name}Branch` },
            branchAlg,
            shape(),
            presOf(),
            constrLst(),
            el("ruleLst"),
            nested,
          ),
        );
      const recurse = el(
        "forEach",
        { name: "memberEach", axis: "ch", ptType: "node" },
        connector,
        member(
          "member",
          "node2",
          el("forEach", { name: "memberRepeat", ref: "memberEach" }),
        ),
      );
      return [
        branchAlg,
        shape(),
        presOf(),
        constrLst(
          ...["topText", "memberText"].flatMap((forName) => [
            constr({ type: "w", for: "des", forName, refType: "w", fact: 0.2 }),
            constr({
              type: "h",
              for: "des",
              forName,
              refType: "w",
              refFor: "des",
              refForName: forName,
              fact: 0.55,
            }),
            constr({
              type: "primFontSz",
              for: "des",
              forName,
              op: "equ",
              val: 65,
            }),
          ]),
          constr({
            type: "sp",
            for: "des",
            forName: "topBranch",
            refType: "w",
            fact: 0.04,
          }),
          constr({
            type: "sibSp",
            for: "des",
            forName: "topBranch",
            refType: "w",
            fact: 0.03,
          }),
          constr({
            type: "sp",
            for: "des",
            forName: "memberBranch",
            refType: "w",
            fact: 0.04,
          }),
          constr({
            type: "sibSp",
            for: "des",
            forName: "memberBranch",
            refType: "w",
            fact: 0.03,
          }),
        ),
        el("ruleLst"),
        el(
          "forEach",
          { name: "topEach", axis: "ch", ptType: "node" },
          member("top", "node1", recurse),
        ),
      ].join("");
    }
    case "pyramid":
      return [
        alg("pyra", {
          linDir: family.inverted ? "fromB" : "fromT",
          txDir: "fromT",
        }),
        shape(),
        presOf(),
        constrLst(
          constr({ type: "w", for: "ch", forName: "level", refType: "w" }),
          constr({ type: "h", for: "ch", forName: "level", refType: "h" }),
          constr({
            type: "primFontSz",
            for: "ch",
            forName: "level",
            op: "equ",
            val: 65,
          }),
        ),
        el("ruleLst"),
        el(
          "forEach",
          { name: "levelEach", axis: "ch", ptType: "node" },
          el(
            "layoutNode",
            { name: "level", styleLbl: "trBgShp" },
            el("varLst", {}, el("bulletEnabled", { val: 1 })),
            alg("tx"),
            shape("trapezoid", {
              ...(family.inverted ? { rot: 180 } : {}),
              "r:blip": "",
            }),
            presOf("desOrSelf", "node"),
            margins,
            fontRule,
          ),
        ),
      ].join("");
  }
};

/** The layout definition part for a layout, as XML text. */
export const layoutDefXml = (opts: {
  id: string;
  name: string;
  description: string;
  category: string;
  family: LayoutFamily;
  rightToLeft: boolean;
}): string =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
  `<dgm:layoutDef xmlns:dgm="${NS.diagram}" xmlns:a="${NS.dml}" xmlns:r="${NS.officeDocRels}" uniqueId="${xmlAttr(LAYOUT_URN + opts.id)}">` +
  el("title", { val: opts.name }) +
  el("desc", { val: opts.description }) +
  el("catLst", {}, el("cat", { type: opts.category, pri: 100000 })) +
  el(
    "layoutNode",
    { name: "diagram" },
    rootVars(opts.rightToLeft),
    body(opts.family, opts.rightToLeft),
  ) +
  `</dgm:layoutDef>`;
