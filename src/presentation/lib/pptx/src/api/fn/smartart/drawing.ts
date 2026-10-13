// The saved drawing of an authored SmartArt graphic, and the DrawingML for
// each of its shapes (shared with Convert to Shapes).
import { NS } from "../../../internal/xml/index.ts";
import { type ArtShape, PT, insetOf, paraPt } from "./kit.ts";
import { type Fill, type Paint, colorXml, paintFor } from "./paint.ts";
import type { SmartArtModel } from "./model.ts";
import { xmlText } from "./xml.ts";

const emu = (v: number) => Math.round(v);

export const xfrmXml = (s: ArtShape, tag = "a:xfrm"): string => {
  const attrs = [
    s.rot ? ` rot="${Math.round((((s.rot % 360) + 360) % 360) * 60000)}"` : "",
    s.flipH ? ` flipH="1"` : "",
    s.flipV ? ` flipV="1"` : "",
  ].join("");
  return `<${tag}${attrs}><a:off x="${emu(s.x)}" y="${emu(s.y)}"/><a:ext cx="${emu(s.w)}" cy="${emu(s.h)}"/></${tag}>`;
};

export const geometryXml = (s: ArtShape): string => {
  if (s.geom === "custom") {
    const paths = (s.path ?? [])
      .map((line) => {
        const [first, ...rest] = line;
        if (!first) return "";
        return (
          `<a:path w="${emu(s.w)}" h="${emu(s.h)}"${s.closed ? "" : ` fill="none"`}>` +
          `<a:moveTo><a:pt x="${emu(first[0])}" y="${emu(first[1])}"/></a:moveTo>` +
          rest
            .map(
              ([x, y]) =>
                `<a:lnTo><a:pt x="${emu(x)}" y="${emu(y)}"/></a:lnTo>`,
            )
            .join("") +
          (s.closed ? "<a:close/>" : "") +
          `</a:path>`
        );
      })
      .join("");
    return `<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="l" t="t" r="r" b="b"/><a:pathLst>${paths}</a:pathLst></a:custGeom>`;
  }
  const adj = s.adj
    ? Object.entries(s.adj)
        .map(
          ([name, v]) => `<a:gd name="${name}" fmla="val ${Math.round(v)}"/>`,
        )
        .join("")
    : "";
  return `<a:prstGeom prst="${s.geom}"><a:avLst>${adj}</a:avLst></a:prstGeom>`;
};

const fillXml = (fill: Fill | null): string => {
  if (!fill) return "<a:noFill/>";
  if (fill.kind === "solid")
    return `<a:solidFill>${colorXml(fill.color)}</a:solidFill>`;
  return (
    `<a:gradFill rotWithShape="1"><a:gsLst>` +
    `<a:gs pos="0">${colorXml(fill.from)}</a:gs>` +
    `<a:gs pos="100000">${colorXml(fill.to)}</a:gs>` +
    `</a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill>`
  );
};

/** Shape properties: transform, geometry, fill, outline and effects. */
export const shapePropertiesXml = (
  s: ArtShape,
  paint: Paint,
  tag: string,
): string => {
  const line = paint.line
    ? `<a:ln w="${paint.line.w}"><a:solidFill>${colorXml(paint.line.color)}</a:solidFill>${s.geom === "custom" && !s.closed ? "<a:round/>" : ""}</a:ln>`
    : "<a:ln><a:noFill/></a:ln>";
  const effects = paint.shadow
    ? `<a:effectLst><a:outerShdw blurRad="${paint.shadow.blur}" dist="${paint.shadow.dist}" dir="5400000" algn="ctr" rotWithShape="0"><a:srgbClr val="000000"><a:alpha val="${Math.round(paint.shadow.alpha * 100000)}"/></a:srgbClr></a:outerShdw></a:effectLst>`
    : "";
  const fill =
    s.geom === "custom" && !s.closed ? "<a:noFill/>" : fillXml(paint.fill);
  return `<${tag}>${xfrmXml(s)}${geometryXml(s)}${fill}${line}${effects}</${tag}>`;
};

const BULLET = 0.9; // ems of indent per bullet level

/** The text body of a shape, with its fitted sizes made explicit. */
export const textBodyXml = (s: ArtShape, paint: Paint, tag: string): string => {
  const inset = insetOf(s);
  const anchor = s.anchor ?? "ctr";
  const body = `<a:bodyPr spcFirstLastPara="0" vert="horz" wrap="square" lIns="${inset}" tIns="${inset}" rIns="${inset}" bIns="${inset}" numCol="1" spcCol="1270" anchor="${anchor}" anchorCtr="0"><a:noAutofit/></a:bodyPr><a:lstStyle/>`;
  const pt = s.pt ?? 18;
  const color = `<a:solidFill>${colorXml(paint.text)}</a:solidFill>`;
  const paras = (s.paras ?? []).map((para) => {
    const size = Math.max(100, Math.round(paraPt(para, pt, s) * 2) * 50);
    const indent = Math.round((size / 100) * PT * BULLET);
    const align = para.bullet ? "l" : (s.align ?? "ctr");
    const pPr = para.bullet
      ? `<a:pPr marL="${indent * (para.level + 1)}" lvl="${Math.min(8, para.level + 1)}" indent="${-indent}" algn="${align}" defTabSz="${indent * 2}"><a:lnSpc><a:spcPct val="90000"/></a:lnSpc><a:spcBef><a:spcPct val="0"/></a:spcBef><a:spcAft><a:spcPct val="15000"/></a:spcAft><a:buFont typeface="Arial" panose="020B0604020202020204" pitchFamily="34" charset="0"/><a:buChar char="&#8226;"/></a:pPr>`
      : `<a:pPr marL="0" lvl="0" indent="0" algn="${align}" defTabSz="${Math.round(pt * PT * 1.5)}"><a:lnSpc><a:spcPct val="90000"/></a:lnSpc><a:spcBef><a:spcPct val="0"/></a:spcBef><a:spcAft><a:spcPct val="35000"/></a:spcAft><a:buNone/></a:pPr>`;
    const rPr = (end = false) =>
      `<a:${end ? "endParaRPr" : "rPr"} lang="en-US" sz="${size}" kern="1200">${color}</a:${end ? "endParaRPr" : "rPr"}>`;
    const lines = para.text.split(/\r\n|[\r\n\u000B]/);
    const runs = lines
      .map(
        (line, i) =>
          (i ? `<a:br>${rPr()}</a:br>` : "") +
          (line ? `<a:r>${rPr()}<a:t>${xmlText(line)}</a:t></a:r>` : ""),
      )
      .join("");
    return `<a:p>${pPr}${runs}${rPr(true)}</a:p>`;
  });
  return `<${tag}>${body}${paras.join("") || `<a:p><a:endParaRPr lang="en-US"/></a:p>`}</${tag}>`;
};

const styleXml = (paint: Paint): string =>
  `<dsp:style><a:lnRef idx="${paint.line ? 1 : 0}"><a:scrgbClr r="0" g="0" b="0"/></a:lnRef><a:fillRef idx="${paint.fill ? 1 : 0}"><a:scrgbClr r="0" g="0" b="0"/></a:fillRef><a:effectRef idx="0"><a:scrgbClr r="0" g="0" b="0"/></a:effectRef><a:fontRef idx="minor">${colorXml(paint.text)}</a:fontRef></dsp:style>`;

/** A model id for the drawing shape at `i`; never one of the data points. */
export const drawingShapeId = (i: number) =>
  `{DA000000-0000-4000-8000-${i.toString(16).padStart(12, "0").toUpperCase()}}`;

export const paintOf = (model: SmartArtModel, s: ArtShape): Paint =>
  paintFor(model.colors, model.style, s.role, s.index, s.count);

/** The `dsp:drawing` part for laid-out shapes. */
export const drawingXml = (
  model: SmartArtModel,
  shapes: ReadonlyArray<ArtShape>,
): string => {
  const body = shapes
    .map((s, i) => {
      const paint = paintOf(model, s);
      const text = s.paras?.length ? textBodyXml(s, paint, "dsp:txBody") : "";
      const tx =
        s.textBox && text
          ? xfrmXml(
              { ...s, ...s.textBox, rot: 0, flipH: false, flipV: false },
              "dsp:txXfrm",
            )
          : "";
      return (
        `<dsp:sp modelId="${drawingShapeId(i)}"><dsp:nvSpPr><dsp:cNvPr id="0" name=""/><dsp:cNvSpPr/></dsp:nvSpPr>` +
        shapePropertiesXml(s, paint, "dsp:spPr") +
        styleXml(paint) +
        text +
        tx +
        `</dsp:sp>`
      );
    })
    .join("");
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<dsp:drawing xmlns:dgm="${NS.diagram}" xmlns:dsp="${NS.diagramDrawing}" xmlns:a="${NS.dml}">` +
    `<dsp:spTree><dsp:nvGrpSpPr><dsp:cNvPr id="0" name=""/><dsp:cNvGrpSpPr/></dsp:nvGrpSpPr><dsp:grpSpPr/>` +
    body +
    `</dsp:spTree></dsp:drawing>`
  );
};
