export { CanvasEditor } from '../engine/canvas-editor.js';
export { DocxPackage, createDocx, DOCX_TYPE, WRITING_STYLES } from '../engine/docx.js';
export { paragraph } from '../engine/model.js';
export { htmlFragment, pasteFragment } from '../engine/clipboard-fragment.js';
export { decodeImages } from '../engine/images.js';
export { validateCanvasTextSupport, loadCanvasFonts } from '../engine/canvas-text.js';

export { openCanvasDocument } from '../engine/open-document.js';

// Editor view features that need layout, drawing or codec code (see engine-api.js).
export { selectionRects } from '../engine/layout.js';
export { setFormattingMarks, formattingMarksVisible } from '../engine/formatting-marks.js';
export { insertShape, insertTextBox, updateShape, selectedShape, attachShapeEditing } from '../engine/shape-editing.js';
export { openShapeGallery } from '../ui/shape-controls.js';

// Review: protection, permissions and document comparison (see engine/review-api.js).
export * from '../engine/review-api.js';
