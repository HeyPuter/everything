// Semantic data, color and style definition parts of an authored SmartArt
// graphic (ECMA-376 21.4). The layout definition is in layout-def.ts and the
// saved drawing in drawing.ts.
import { NS } from "../../../internal/xml/index.ts";
import { layoutEntry } from "./catalog.ts";
import { LAYOUT_URN } from "./layout-def.ts";
import {
  type ColorRef,
  SMARTART_COLOR_SCHEMES,
  SMARTART_STYLES,
  colorXml,
  schemeColors,
  styleOf,
} from "./paint.ts";
import {
  type SmartArtModel,
  type SmartArtNode,
  smartArtTree,
} from "./model.ts";
import { xmlAttr, xmlText } from "./xml.ts";
import {
  type PresDataNode,
  buildPresTree,
  layoutNodeForRole,
} from "./pres-tree.ts";
import {
  type SmartArtShapeFormat,
  type SmartArtTextStyle,
  formatSpPrXml,
  textStyleRunXml,
} from "./format.ts";

export const COLORS_URN = "urn:everything:smartart:colors/";
export const STYLE_URN = "urn:everything:smartart:style/";

const guid = (prefix: string, i: number) =>
  `{${prefix}-0000-4000-8000-${i.toString(16).padStart(12, "0").toUpperCase()}}`;
const DOC_ID = guid("D0C00000", 0);

const textXml = (text: string, style?: SmartArtTextStyle): string => {
  const paras = text.split(/\r\n|[\r\n]/);
  const run = textStyleRunXml(style);
  const rPr =
    run.line || run.fill || run.effects
      ? `<a:rPr lang="en-US">${run.line}${run.fill}${run.effects}</a:rPr>`
      : `<a:rPr lang="en-US"/>`;
  return (
    `<dgm:t><a:bodyPr/><a:lstStyle/>` +
    paras
      .map((p) => {
        const runs = p
          .split("\u000B")
          .map(
            (line, i) =>
              (i ? `<a:br><a:rPr lang="en-US"/></a:br>` : "") +
              (line ? `<a:r>${rPr}<a:t>${xmlText(line)}</a:t></a:r>` : ""),
          )
          .join("");
        return `<a:p>${runs}<a:endParaRPr lang="en-US"/></a:p>`;
      })
      .join("") +
    `</dgm:t>`
  );
};

const STYLE_CATEGORY: Record<string, string> = {
  flat: "simple",
  subtle: "simple",
  outlined: "simple",
  shadow: "simple",
  polished: "3D",
  intense: "3D",
};

/** The `dgm:dataModel` part: the outline as a tree of points. With the
 *  layout definition, shapes' own formatting is written on presentation
 *  points of the definition's tree (see pres-tree.ts). */
export const dataModelXml = (
  model: SmartArtModel,
  drawingRelId: string,
  pictureRel: (part: string) => string | null = () => null,
  layoutDef: string | null = null,
  /** Names of the shapes the layout draws for the item at an index. */
  itemShapes: (item: number) => ReadonlySet<string> = () => new Set(),
): string => {
  const entry = layoutEntry(model.layout);
  const points: string[] = [];
  const connections: string[] = [];
  let n = 0;
  let presCount = 0;
  const newPresId = () => guid("3E000000", presCount++);
  const owned: {
    owner: string;
    item: number;
    depth: number;
    formats: Readonly<Record<string, SmartArtShapeFormat>> | undefined;
  }[] = [];
  const formatXml = (f: SmartArtShapeFormat) => {
    const spPr = formatSpPrXml(f, pictureRel);
    const scale =
      f.scale && f.scale !== 1
        ? ` custScaleX="${Math.round(f.scale * 100000)}" custScaleY="${Math.round(f.scale * 100000)}"`
        : "";
    return spPr || scale ? { spPr, scale } : null;
  };
  // A formatted shape with no place in the definition's tree: a free
  // presentation point, which this app reads back.
  const loosePoint = (
    owner: string,
    name: string,
    x: { spPr: string; scale: string },
  ) =>
    points.push(
      `<dgm:pt modelId="${newPresId()}" type="pres"><dgm:prSet presAssocID="${owner}" presName="${xmlAttr(name)}" presStyleCnt="0"${x.scale}/><dgm:spPr>${x.spPr}</dgm:spPr></dgm:pt>`,
    );
  const visit = (
    nodes: ReadonlyArray<SmartArtNode>,
    parent: string,
    depth: number,
  ): PresDataNode[] =>
    nodes.map((node, order) => {
      const i = n++;
      const id = guid("1D000000", i),
        cxn = guid("C0000000", i),
        par = guid("2A000000", i),
        sib = guid("5B000000", i);
      points.push(
        `<dgm:pt modelId="${id}"><dgm:prSet phldrT="[Text]"/><dgm:spPr/>${textXml(node.text, node.textStyle)}</dgm:pt>`,
        `<dgm:pt modelId="${par}" type="parTrans" cxnId="${cxn}"><dgm:prSet/><dgm:spPr/>${textXml("")}</dgm:pt>`,
        `<dgm:pt modelId="${sib}" type="sibTrans" cxnId="${cxn}"><dgm:prSet/><dgm:spPr/>${textXml("")}</dgm:pt>`,
      );
      connections.push(
        `<dgm:cxn modelId="${cxn}" srcId="${parent}" destId="${id}" srcOrd="${order}" destOrd="0" parTransId="${par}" sibTransId="${sib}"/>`,
      );
      owned.push({ owner: id, item: node.item, depth, formats: node.format });
      return {
        id,
        parTrans: par,
        sibTrans: sib,
        depth,
        children: visit(node.children, id, depth + 1),
      };
    });
  const roots = visit(smartArtTree(model.items), DOC_ID, 0);
  // Item formatting goes on the definition's own points when it has one
  // for the shape; the whole tree is written only when something needs it.
  const formatted = owned.filter((o) =>
    Object.values(o.formats ?? {}).some((f) => formatXml(f)),
  );
  const tree =
    formatted.length && layoutDef && entry
      ? buildPresTree(layoutDef, DOC_ID, roots, newPresId)
      : null;
  const onTree = new Map<string, { spPr: string; scale: string }>();
  for (const { owner, item, depth, formats } of owned)
    for (const [name, f] of Object.entries(formats ?? {})) {
      const x = formatXml(f);
      if (!x) continue;
      const target =
        tree && !name.includes(":") && itemShapes(item).has(name)
          ? layoutNodeForRole(entry!.family, name, depth)
          : null;
      const point = target
        ? tree!.points.find(
            (p) => p.assoc === owner && p.name === target && !onTree.has(p.id),
          )
        : undefined;
      if (point) onTree.set(point.id, x);
      else loosePoint(owner, name, x);
    }
  for (const [name, f] of Object.entries(model.format ?? {})) {
    const x = formatXml(f);
    if (x) loosePoint(DOC_ID, name, x);
  }
  if (tree) {
    for (const p of tree.points) {
      const x = onTree.get(p.id);
      const style = p.styleLbl
        ? ` presStyleLbl="${xmlAttr(p.styleLbl)}" presStyleIdx="${p.styleIdx}" presStyleCnt="${p.styleCnt}"`
        : ` presStyleCnt="0"`;
      const vars = p.vars
        ? `<dgm:presLayoutVars>${p.vars}</dgm:presLayoutVars>`
        : "";
      points.push(
        `<dgm:pt modelId="${p.id}" type="pres"><dgm:prSet presAssocID="${p.assoc}" presName="${xmlAttr(p.name)}"${style}${x?.scale ?? ""}${vars ? `>${vars}</dgm:prSet>` : "/>"}${x?.spPr ? `<dgm:spPr>${x.spPr}</dgm:spPr>` : "<dgm:spPr/>"}</dgm:pt>`,
      );
    }
    tree.connections.forEach((c, i) =>
      connections.push(
        `<dgm:cxn modelId="${guid("CE000000", i)}" type="${c.type}" srcId="${c.src}" destId="${c.dest}" srcOrd="${c.srcOrd}" destOrd="${c.destOrd}" presId="${xmlAttr(tree.uniqueId)}"/>`,
      ),
    );
  }
  const doc =
    `<dgm:pt modelId="${DOC_ID}" type="doc">` +
    `<dgm:prSet loTypeId="${xmlAttr(LAYOUT_URN + model.layout)}" loCatId="${entry?.category ?? "list"}" ` +
    `qsTypeId="${xmlAttr(STYLE_URN + model.style)}" qsCatId="${STYLE_CATEGORY[model.style] ?? "simple"}" ` +
    `csTypeId="${xmlAttr(COLORS_URN + model.colors)}" csCatId="${xmlAttr(model.colors)}" phldr="1"` +
    (model.rightToLeft
      ? `><dgm:presLayoutVars><dgm:dir val="rev"/></dgm:presLayoutVars></dgm:prSet>`
      : `/>`) +
    `<dgm:spPr/>${textXml("")}</dgm:pt>`;
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<dgm:dataModel xmlns:dgm="${NS.diagram}" xmlns:a="${NS.dml}" xmlns:r="${NS.officeDocRels}">` +
    `<dgm:ptLst>${doc}${points.join("")}</dgm:ptLst>` +
    `<dgm:cxnLst>${connections.join("")}</dgm:cxnLst>` +
    `<dgm:bg/><dgm:whole/>` +
    `<dgm:extLst><a:ext uri="${NS.diagramDrawing}"><dsp:dataModelExt xmlns:dsp="${NS.diagramDrawing}" relId="${xmlAttr(drawingRelId)}" minVer="${NS.diagram}"/></a:ext></dgm:extLst>` +
    `</dgm:dataModel>`
  );
};

// Style labels used by the authored layout definitions.
const LABELS = [
  "node0",
  "node1",
  "node2",
  "sibTrans2D1",
  "parChTrans1D2",
  "alignAccFollowNode1",
  "revTx",
  "vennNode1",
  "trBgShp",
  "alignImgPlace1",
];

/** The `dgm:colorsDef` part for a color scheme. */
export const colorsDefXml = (schemeId: string): string => {
  const info = SMARTART_COLOR_SCHEMES.find((s) => s.id === schemeId)!;
  const scheme = schemeColors(schemeId);
  const sample = scheme.sample(6);
  const varies = sample.some(
    (c) => c.val !== sample[0]!.val || c.lumMod !== sample[0]!.lumMod,
  );
  const spans = varies && sample.every((c) => c.val === sample[0]!.val);
  const list = (tag: string, colors: ColorRef[], meth = "repeat") =>
    `<dgm:${tag} meth="${meth}">${colors.map(colorXml).join("")}</dgm:${tag}>`;
  const mains = spans
    ? [sample[0]!, sample[5]!]
    : varies
      ? sample
      : [sample[0]!];
  const meth = spans ? "span" : "repeat";
  const light: ColorRef = { val: "lt1" };
  const dark: ColorRef = { val: "dk1" };
  const label = (name: string) => {
    const tints = mains.map((c) => scheme.tint(c, 0.8));
    const [fill, line, text] =
      name === "sibTrans2D1"
        ? [mains.map((c) => scheme.tint(c, 0.4)), [light], [light]]
        : name === "parChTrans1D2"
          ? [mains, mains, [dark]]
          : name === "alignAccFollowNode1" || name === "trBgShp"
            ? [tints, mains, [dark]]
            : name === "revTx"
              ? [
                  [{ val: "lt1", alpha: 0 }],
                  [{ val: "dk1", alpha: 0 }],
                  [{ val: "tx1" }],
                ]
              : name === "vennNode1"
                ? [
                    mains.map((c) => ({ ...c, alpha: 50000 })),
                    [light],
                    [scheme.outline ? dark : light],
                  ]
                : name === "alignImgPlace1"
                  ? [mains.map((c) => scheme.tint(c, 0.6)), [light], [dark]]
                  : scheme.outline
                    ? [[light], mains, [dark]]
                    : [mains, [light], [light]];
    return (
      `<dgm:styleLbl name="${name}">` +
      list("fillClrLst", fill as ColorRef[], meth) +
      list("linClrLst", line as ColorRef[], meth) +
      `<dgm:effectClrLst/><dgm:txLinClrLst/>` +
      list("txFillClrLst", text as ColorRef[], meth) +
      `<dgm:txEffectClrLst/></dgm:styleLbl>`
    );
  };
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<dgm:colorsDef xmlns:dgm="${NS.diagram}" xmlns:a="${NS.dml}" uniqueId="${xmlAttr(COLORS_URN + schemeId)}">` +
    `<dgm:title val="${xmlAttr(info.name)}"/><dgm:desc val=""/>` +
    `<dgm:catLst><dgm:cat type="${/^accent\d/.test(schemeId) ? schemeId.slice(0, 7) : schemeId.startsWith("colorful") ? "colorful" : "mainScheme"}" pri="10000"/></dgm:catLst>` +
    LABELS.map(label).join("") +
    `</dgm:colorsDef>`
  );
};

/** The `dgm:styleDef` part for a style. */
export const styleDefXml = (styleId: string): string => {
  const info = SMARTART_STYLES.find((s) => s.id === styleId)!;
  const style = styleOf(styleId);
  const scene = `<dgm:scene3d><a:camera prst="orthographicFront"/><a:lightRig rig="threePt" dir="t"/></dgm:scene3d>`;
  const ref = (name: string, idx: number) =>
    `<a:${name} idx="${idx}"><a:scrgbClr r="0" g="0" b="0"/></a:${name}>`;
  const label = (name: string) => {
    const connector = name === "parChTrans1D2";
    const text = name === "revTx";
    const line = text
      ? 0
      : style.line === "none"
        ? 0
        : style.line === "bold"
          ? 3
          : connector
            ? 2
            : 2;
    const fill = text || connector ? 0 : style.gradient ? 3 : 1;
    const effect =
      text || connector
        ? 0
        : style.shadow === "none"
          ? 0
          : style.shadow === "soft"
            ? 2
            : 3;
    return (
      `<dgm:styleLbl name="${name}">${scene}<dgm:sp3d/><dgm:txPr/><dgm:style>` +
      ref("lnRef", line) +
      ref("fillRef", fill) +
      ref("effectRef", effect) +
      `<a:fontRef idx="minor"/>` +
      `</dgm:style></dgm:styleLbl>`
    );
  };
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<dgm:styleDef xmlns:dgm="${NS.diagram}" xmlns:a="${NS.dml}" uniqueId="${xmlAttr(STYLE_URN + styleId)}">` +
    `<dgm:title val="${xmlAttr(info.name)}"/><dgm:desc val=""/>` +
    `<dgm:catLst><dgm:cat type="${STYLE_CATEGORY[styleId] ?? "simple"}" pri="10000"/></dgm:catLst>` +
    scene +
    LABELS.map(label).join("") +
    `</dgm:styleDef>`
  );
};
