// Relationship type URIs used inside PPTX packages. Subset of what
// ECMA-376 Part 1 §13.2 documents, limited to types we model directly.
//
// All values are exactly the published URIs. Matching them character-for-
// character matters: some PPTX consumers compare by string rather than by
// semantic equivalence.

const OFFICE_DOC =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PACKAGE = "http://schemas.openxmlformats.org/package/2006/relationships";
const MS_2018 = "http://schemas.microsoft.com/office/2018/10/relationships";

export const REL_TYPES = {
  // Package-root → presentation
  officeDocument: `${OFFICE_DOC}/officeDocument`,

  // Core / extended properties
  coreProperties: `${PACKAGE}/metadata/core-properties`,
  extendedProperties: `${OFFICE_DOC}/extended-properties`,
  customProperties: `${OFFICE_DOC}/custom-properties`,

  // Presentation → first-class parts
  slideMaster: `${OFFICE_DOC}/slideMaster`,
  notesMaster: `${OFFICE_DOC}/notesMaster`,
  handoutMaster: `${OFFICE_DOC}/handoutMaster`,
  slide: `${OFFICE_DOC}/slide`,
  presProps: `${OFFICE_DOC}/presProps`,
  viewProps: `${OFFICE_DOC}/viewProps`,
  theme: `${OFFICE_DOC}/theme`,
  tableStyles: `${OFFICE_DOC}/tableStyles`,
  customXmlProps: `${OFFICE_DOC}/customXmlProps`,
  customXml: `${OFFICE_DOC}/customXml`,
  thumbnail: `${PACKAGE}/metadata/thumbnail`,

  // SlideMaster / SlideLayout / Slide → siblings
  slideLayout: `${OFFICE_DOC}/slideLayout`,
  notesSlide: `${OFFICE_DOC}/notesSlide`,

  // Within a slide
  hyperlink: `${OFFICE_DOC}/hyperlink`,
  image: `${OFFICE_DOC}/image`,
  chart: `${OFFICE_DOC}/chart`,
  oleObject: `${OFFICE_DOC}/oleObject`,
  package: `${OFFICE_DOC}/package`,
  diagramData: `${OFFICE_DOC}/diagramData`,
  diagramLayout: `${OFFICE_DOC}/diagramLayout`,
  diagramQuickStyle: `${OFFICE_DOC}/diagramQuickStyle`,
  diagramColors: `${OFFICE_DOC}/diagramColors`,
  diagramDrawing:
    "http://schemas.microsoft.com/office/2007/relationships/diagramDrawing",
  // ISO 29500 audio/video references and MS-PPTX §2.1.1 media references.
  // The media extension predates its p14 DrawingML consumer namespace.
  media: "http://schemas.microsoft.com/office/2007/relationships/media",
  video: `${OFFICE_DOC}/video`,
  audio: `${OFFICE_DOC}/audio`,
  font: `${OFFICE_DOC}/font`,

  // Authors list for modern comments
  authors: `${MS_2018}/authors`,
  // Modern comments per slide
  modernComment: `${MS_2018}/comments`,

  // Legacy comments — universally supported by every PPTX consumer.
  // Authors list lives at /ppt/commentAuthors.xml (one per package);
  // per-slide comments at /ppt/comments/comment{N}.xml.
  comments: `${OFFICE_DOC}/comments`,
  commentAuthors: `${OFFICE_DOC}/commentAuthors`,
} as const;

export type RelType = (typeof REL_TYPES)[keyof typeof REL_TYPES];
