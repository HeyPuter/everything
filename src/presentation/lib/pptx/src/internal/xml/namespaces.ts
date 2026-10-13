// Canonical OOXML / PPTX namespace URIs. Keep both the URI and the prefix
// seen in the wild — code that re-serializes XML must use the same
// prefix the input file used (or, for fresh output, the conventional prefix)
// to maximize compatibility with downstream readers that string-match the prefix
// rather than resolving by URI.

export const NS = {
  // Open Packaging Conventions
  contentTypes: "http://schemas.openxmlformats.org/package/2006/content-types",
  relationships: "http://schemas.openxmlformats.org/package/2006/relationships",
  // OOXML — relationship target type
  officeDocRels:
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  // PresentationML
  pml: "http://schemas.openxmlformats.org/presentationml/2006/main",
  // DrawingML
  dml: "http://schemas.openxmlformats.org/drawingml/2006/main",
  // DrawingML — diagram (SmartArt)
  diagram: "http://schemas.openxmlformats.org/drawingml/2006/diagram",
  diagramDrawing: "http://schemas.microsoft.com/office/drawing/2008/diagram",
  dgm1612: "http://schemas.microsoft.com/office/drawing/2016/12/diagram",
  // DrawingML — chart
  chart: "http://schemas.openxmlformats.org/drawingml/2006/chart",
  // DrawingML — chart drawing
  chartDrawing: "http://schemas.openxmlformats.org/drawingml/2006/chartDrawing",
  // SpreadsheetML (embedded xlsx for chart data)
  sml: "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
  // WordprocessingML (embedded in some PPTX parts)
  wml: "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  // Markup Compatibility & Extensibility
  mc: "http://schemas.openxmlformats.org/markup-compatibility/2006",
  // Extension namespaces (a14, p14, p15, p16, etc.)
  // These appear inside mc:AlternateContent blocks; we list a few here for
  // canonical prefix mapping. Others get auto-prefixed by their declaration.
  a14: "http://schemas.microsoft.com/office/drawing/2010/main",
  a15: "http://schemas.microsoft.com/office/drawing/2012/main",
  a16: "http://schemas.microsoft.com/office/drawing/2014/main",
  asvg: "http://schemas.microsoft.com/office/drawing/2016/SVG/main",
  p14: "http://schemas.microsoft.com/office/powerpoint/2010/main",
  p15: "http://schemas.microsoft.com/office/powerpoint/2012/main",
  p16: "http://schemas.microsoft.com/office/powerpoint/2015/main",
  // 2015/09 extension carrying the morph slide transition.
  p159: "http://schemas.microsoft.com/office/powerpoint/2015/09/main",
  // Reserved XML namespaces
  xml: "http://www.w3.org/XML/1998/namespace",
  xmlns: "http://www.w3.org/2000/xmlns/",
} as const;

// Suggested prefix for each known namespace URI, using the conventional
// prefixes. Used as a fallback when authoring fresh XML and no prefix has been
// declared yet. The parser preserves whatever prefix was actually in the input.
export const SUGGESTED_PREFIX: Readonly<Record<string, string>> = {
  [NS.contentTypes]: "",
  [NS.relationships]: "",
  [NS.officeDocRels]: "r",
  [NS.pml]: "p",
  [NS.dml]: "a",
  [NS.diagram]: "dgm",
  [NS.diagramDrawing]: "dsp",
  [NS.dgm1612]: "dgm1612",
  [NS.chart]: "c",
  [NS.chartDrawing]: "cdr",
  [NS.sml]: "",
  [NS.wml]: "w",
  [NS.mc]: "mc",
  [NS.a14]: "a14",
  [NS.a15]: "a15",
  [NS.a16]: "a16",
  [NS.asvg]: "asvg",
  [NS.p14]: "p14",
  [NS.p15]: "p15",
  [NS.p16]: "p16",
  [NS.p159]: "p159",
  [NS.xml]: "xml",
};
