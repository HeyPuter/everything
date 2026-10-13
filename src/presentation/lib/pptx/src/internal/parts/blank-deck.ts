// Minimal "blank deck" scaffolding for `createPresentation`.
//
// A slide cannot be authored without a slide master, at least one
// slide layout, a theme, and a slide size — `addSlide({ layout })` reads
// the layout's placeholders, and the layout inherits geometry / text
// styles from the master + theme. An OPC package with only the OPC
// defaults (what `OpcPackage.empty()` produces) has none of that, so
// `getSlideLayouts()` returns `[]` and from-scratch authoring is
// impossible.
//
// This module emits the smallest set of parts that yields an
// immediately-authorable deck: a single master, a theme, and the full set
// of built-in layouts (see `builtin-layouts.ts`). The XML is held as
// string templates rather than built through the DrawingML element
// builders because these parts are static boilerplate — there is exactly
// one canonical default master/theme and reproducing it byte-for-byte
// through builders would be far more code for zero flexibility. The
// strings are validated against the ECMA-376 XSDs in
// `test/fn-create-presentation.test.ts`.
//
// Tree-shaking: this module is imported only by `createPresentation`, so
// the load+save / template-editing paths never pull it in. Keep it that
// way — do not import it from any read or template-edit module.

import { partName } from "../opc/index.ts";
import { OpcPackage } from "./package.ts";
import {
  BUILTIN_LAYOUTS,
  masterXml,
  newFieldIds,
  withFieldIds,
} from "./builtin-layouts.ts";

/** Slide canvas aspect ratio. `'16:9'` is the widescreen size. */
export type BlankDeckAspect = "16:9" | "4:3";

// Slide canvas dimensions in EMU. 914400 EMU = 1 inch.
const SLIDE_SIZE: Record<
  BlankDeckAspect,
  { cx: number; cy: number; type: string }
> = {
  "16:9": { cx: 12192000, cy: 6858000, type: "screen16x9" },
  "4:3": { cx: 9144000, cy: 6858000, type: "screen4x3" },
};

const RELS_CONTENT_TYPE =
  "application/vnd.openxmlformats-package.relationships+xml";
const PRESENTATION_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml";
const PRES_PROPS_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.presProps+xml";
const VIEW_PROPS_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml";
const SLIDE_MASTER_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml";
const SLIDE_LAYOUT_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml";
const THEME_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.theme+xml";
const TABLE_STYLES_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml";
const CORE_PROPS_CONTENT_TYPE =
  "application/vnd.openxmlformats-package.core-properties+xml";
const EXTENDED_PROPS_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.extended-properties+xml";

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';

const RT =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const RT_PACKAGE =
  "http://schemas.openxmlformats.org/package/2006/relationships";

// --- Theme ----------------------------------------------------------------
// The default theme. DrawingML requires a complete fmtScheme
// (3 fill / 3 line / 3 effect styles + 2 bg fills) and a full clrScheme;
// trimming any of it fails XSD validation, so every part is kept.
export const DEFAULT_THEME_XML = `${XML_DECL}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office Theme"><a:themeElements><a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F497D"/></a:dk2><a:lt2><a:srgbClr val="EEECE1"/></a:lt2><a:accent1><a:srgbClr val="4F81BD"/></a:accent1><a:accent2><a:srgbClr val="C0504D"/></a:accent2><a:accent3><a:srgbClr val="9BBB59"/></a:accent3><a:accent4><a:srgbClr val="8064A2"/></a:accent4><a:accent5><a:srgbClr val="4BACC6"/></a:accent5><a:accent6><a:srgbClr val="F79646"/></a:accent6><a:hlink><a:srgbClr val="0000FF"/></a:hlink><a:folHlink><a:srgbClr val="800080"/></a:folHlink></a:clrScheme><a:fontScheme name="Office"><a:majorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="50000"/><a:satMod val="300000"/></a:schemeClr></a:gs><a:gs pos="35000"><a:schemeClr val="phClr"><a:tint val="37000"/><a:satMod val="300000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:tint val="15000"/><a:satMod val="350000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="16200000" scaled="1"/></a:gradFill><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="100000"/><a:shade val="100000"/><a:satMod val="130000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:tint val="50000"/><a:shade val="100000"/><a:satMod val="350000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="16200000" scaled="0"/></a:gradFill></a:fillStyleLst><a:lnStyleLst><a:ln w="9525" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"><a:shade val="95000"/><a:satMod val="105000"/></a:schemeClr></a:solidFill><a:prstDash val="solid"/></a:ln><a:ln w="25400" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln><a:ln w="38100" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst><a:outerShdw blurRad="40000" dist="20000" dir="5400000" rotWithShape="0"><a:srgbClr val="000000"><a:alpha val="38000"/></a:srgbClr></a:outerShdw></a:effectLst></a:effectStyle><a:effectStyle><a:effectLst><a:outerShdw blurRad="40000" dist="23000" dir="5400000" rotWithShape="0"><a:srgbClr val="000000"><a:alpha val="35000"/></a:srgbClr></a:outerShdw></a:effectLst></a:effectStyle><a:effectStyle><a:effectLst><a:outerShdw blurRad="40000" dist="23000" dir="5400000" rotWithShape="0"><a:srgbClr val="000000"><a:alpha val="35000"/></a:srgbClr></a:outerShdw></a:effectLst><a:scene3d><a:camera prst="orthographicFront"><a:rot lat="0" lon="0" rev="0"/></a:camera><a:lightRig rig="threePt" dir="t"><a:rot lat="0" lon="0" rev="1200000"/></a:lightRig></a:scene3d><a:sp3d><a:bevelT w="63500" h="25400"/></a:sp3d></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="40000"/><a:satMod val="350000"/></a:schemeClr></a:gs><a:gs pos="40000"><a:schemeClr val="phClr"><a:tint val="45000"/><a:shade val="99000"/><a:satMod val="350000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:shade val="20000"/><a:satMod val="255000"/></a:schemeClr></a:gs></a:gsLst><a:path path="circle"><a:fillToRect l="50000" t="-80000" r="50000" b="180000"/></a:path></a:gradFill><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="80000"/><a:satMod val="300000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:shade val="30000"/><a:satMod val="200000"/></a:schemeClr></a:gs></a:gsLst><a:path path="circle"><a:fillToRect l="50000" t="50000" r="50000" b="50000"/></a:path></a:gradFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`;

// --- Slide master and layouts --------------------------------------------
// Built per slide size by `builtin-layouts.ts`: one master and the full set
// of built-in layouts, each with real placeholders.

// --- Presentation ---------------------------------------------------------
const buildPresentationXml = (size: {
  cx: number;
  cy: number;
  type: string;
}): string =>
  `${XML_DECL}<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldSz cx="${size.cx}" cy="${size.cy}" type="${size.type}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`;

const PRES_PROPS_XML = `${XML_DECL}<p:presentationPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>`;

const VIEW_PROPS_XML = `${XML_DECL}<p:viewPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>`;

// Table styles. Native decks always ship this part, and a table's
// `<a:tableStyleId>` resolves against the `def` GUID here. We ship the
// "No Style, Table Grid" default that PptxGenJS and our template fixtures
// also use, so `addSlideTable` output renders as a clean ruled grid rather
// than an unstyled block. (See `table-builder.ts` DEFAULT_TABLE_STYLE_ID.)
const TABLE_STYLES_XML = `${XML_DECL}<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`;

const CORE_PROPS_XML = `${XML_DECL}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title></dc:title><dc:creator>@office-kit/pptx</dc:creator><cp:lastModifiedBy>@office-kit/pptx</cp:lastModifiedBy></cp:coreProperties>`;

const EXTENDED_PROPS_XML = `${XML_DECL}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>@office-kit/pptx</Application></Properties>`;

// --- .rels ----------------------------------------------------------------
const ROOT_RELS_XML = `${XML_DECL}<Relationships xmlns="${RT_PACKAGE}"><Relationship Id="rId1" Type="${RT}/officeDocument" Target="ppt/presentation.xml"/><Relationship Id="rId2" Type="${RT_PACKAGE}/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="${RT}/extended-properties" Target="docProps/app.xml"/></Relationships>`;

// Presentation rels: master + theme + presProps + viewProps. The master's
// rId1 must match the `<p:sldMasterId r:id="rId1">` in presentation.xml.
const PRES_RELS_XML = `${XML_DECL}<Relationships xmlns="${RT_PACKAGE}"><Relationship Id="rId1" Type="${RT}/slideMaster" Target="slideMasters/slideMaster1.xml"/><Relationship Id="rId2" Type="${RT}/theme" Target="theme/theme1.xml"/><Relationship Id="rId3" Type="${RT}/presProps" Target="presProps.xml"/><Relationship Id="rId4" Type="${RT}/viewProps" Target="viewProps.xml"/><Relationship Id="rId5" Type="${RT}/tableStyles" Target="tableStyles.xml"/></Relationships>`;

// Master rels: one slideLayout per shipped layout (matching the master's
// `<p:sldLayoutIdLst>` rIds, in gallery order) + the theme.
const masterRelsXml = (): string =>
  `${XML_DECL}<Relationships xmlns="${RT_PACKAGE}">${BUILTIN_LAYOUTS.map(
    (layout, i) =>
      `<Relationship Id="rId${i + 1}" Type="${RT}/slideLayout" Target="../slideLayouts/slideLayout${layout.file}.xml"/>`,
  ).join(
    "",
  )}<Relationship Id="rId${BUILTIN_LAYOUTS.length + 1}" Type="${RT}/theme" Target="../theme/theme1.xml"/></Relationships>`;

// Each layout points back at the single master.
const LAYOUT_RELS_XML = `${XML_DECL}<Relationships xmlns="${RT_PACKAGE}"><Relationship Id="rId1" Type="${RT}/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`;

const TEXT_ENCODER = new TextEncoder();
const encode = (s: string): Uint8Array => TEXT_ENCODER.encode(s);

/**
 * Builds an OPC package for an immediately-authorable blank deck: one
 * slide master, the built-in default theme, the built-in layouts (Title
 * Slide, Title and Content, Section Header, Two Content, Comparison, Title
 * Only, Blank, Content with Caption, Picture with Caption, Title and Vertical
 * Text, Vertical Title and Text), and the chosen slide size. The deck has no slides
 * yet — call `addSlide({ layout })` (or `addBlankSlide` / `addTitleSlide`
 * / `addContentSlide`) to add one.
 */
export const buildBlankDeck = (aspect: BlankDeckAspect): OpcPackage => {
  const pkg = OpcPackage.empty();
  const size = SLIDE_SIZE[aspect];

  // Register the Content_Types overrides for every XML part we add. The
  // `.rels` Default is already present from `OpcPackage.empty()`; the
  // parts below need explicit overrides because their content types are
  // not extension defaults.
  const add = (name: string, contentType: string, xml: string): void => {
    pkg.addPart(partName(name), contentType, encode(xml));
  };
  const addRels = (name: string, xml: string): void => {
    pkg.addPart(partName(name), RELS_CONTENT_TYPE, encode(xml));
  };

  add(
    "/ppt/presentation.xml",
    PRESENTATION_CONTENT_TYPE,
    buildPresentationXml(size),
  );
  add("/ppt/presProps.xml", PRES_PROPS_CONTENT_TYPE, PRES_PROPS_XML);
  add("/ppt/viewProps.xml", VIEW_PROPS_CONTENT_TYPE, VIEW_PROPS_XML);
  add("/ppt/theme/theme1.xml", THEME_CONTENT_TYPE, DEFAULT_THEME_XML);
  add("/ppt/tableStyles.xml", TABLE_STYLES_CONTENT_TYPE, TABLE_STYLES_XML);
  // The master and its layouts share one pair of date / number field ids.
  withFieldIds(newFieldIds(), () => {
    add(
      "/ppt/slideMasters/slideMaster1.xml",
      SLIDE_MASTER_CONTENT_TYPE,
      masterXml(
        size,
        BUILTIN_LAYOUTS.map((_, i) => ({
          id: 2147483649 + i,
          rId: `rId${i + 1}`,
        })),
      ),
    );
    // Part order follows the file numbers, so `getSlideLayouts` lists Blank,
    // Title Slide and Title and Content first as it always has.
    for (const layout of [...BUILTIN_LAYOUTS].sort((a, b) => a.file - b.file))
      add(
        `/ppt/slideLayouts/slideLayout${layout.file}.xml`,
        SLIDE_LAYOUT_CONTENT_TYPE,
        layout.xml(size),
      );
  });
  add("/docProps/core.xml", CORE_PROPS_CONTENT_TYPE, CORE_PROPS_XML);
  add("/docProps/app.xml", EXTENDED_PROPS_CONTENT_TYPE, EXTENDED_PROPS_XML);

  addRels("/_rels/.rels", ROOT_RELS_XML);
  addRels("/ppt/_rels/presentation.xml.rels", PRES_RELS_XML);
  addRels("/ppt/slideMasters/_rels/slideMaster1.xml.rels", masterRelsXml());
  for (const layout of [...BUILTIN_LAYOUTS].sort((a, b) => a.file - b.file))
    addRels(
      `/ppt/slideLayouts/_rels/slideLayout${layout.file}.xml.rels`,
      LAYOUT_RELS_XML,
    );

  return pkg;
};
