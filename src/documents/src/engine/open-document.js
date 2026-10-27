import { DocxPackage } from './docx.js';
import { validateCanvasLayout } from './canvas-text.js';
import { decodeImages } from './images.js';
import { TextDocument } from './model.js';
import { recordPreviewIssue } from './preview-issues.js';
import { refreshPageReferences } from './page-reference-refresh.js';

function refreshOpeningReferences(pkg, preparation) {
  if (pkg.readOnly || !pkg.paragraphs.some(p => p.fieldMarkers?.some(m => m.type === 'start' && m.field.type === 'PAGEREF' && (pkg.updateFields || m.field.dirty)))) return;
  // Recalculation failures are isolated from the successful structured import.
  // The original package and its caches remain usable and editable.
  try {
    const model = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
    let initial = true;
    const result = refreshPageReferences(model, current => { if (initial) { initial = false; return preparation.body; } return preparation.layoutOf(current); }, pkg.pageStories, { dirtyOnly: !pkg.updateFields, checkpoint: false });
    pkg.fieldRefreshIssues = result.issues.map(issue => issue.message);
    if (result.changed) { pkg.paragraphs = model.paragraphs; pkg.tables = model.tables; pkg.fieldsRecalculated = true; }
  } catch (error) { pkg.fieldRefreshIssues = [error.message]; }
}

async function decodedDocument(pkg, measure) {
  const missing = new Set();
  const issues = new Set(pkg.previewIssues || []);
  const images = await decodeImages(pkg.assets, pkg.styles.fontAlternatives, family => missing.add(family), (id, error) => {
    pkg.readOnly = true;
    const detail = new Set(); recordPreviewIssue(detail, error);
    issues.add(`Image ${id}: ${[...detail].join('; ') || 'could not be decoded'}`);
    pkg.previewIssues = [...issues];
  });
  pkg.missingPictureFonts = [...missing];
  return { pkg, images, measure };
}

/**
 * Open for display even when the editing or layout subset is insufficient. `measure` is the
 * measurer that validated the layout; an editor of `pkg` can start from its measurements.
 * `beforeLayout(pkg)` sets up what the editor's layout reads (its reviewers' colors) beforehand, so
 * those measurements stay usable.
 */
export async function openCanvasDocument(input, { beforeLayout } = {}) {
  let pkg = await DocxPackage.open(input, { bestEffort: true });
  beforeLayout?.(pkg);
  try {
    if (pkg.readOnly) new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets, { displayOnly: true });
    const preparation = await validateCanvasLayout(pkg);
    refreshOpeningReferences(pkg, preparation);
    return await decodedDocument(pkg, preparation.measure);
  } catch (error) {
    const issues = new Set(pkg.previewIssues || []);
    recordPreviewIssue(issues, error);
    pkg.previewIssues = [...issues];
    // An editing-layout limit can still have a useful structured preview.
    // Retry with the same display-only path used for unsupported XML features.
    if (!pkg.readOnly) {
      pkg.readOnly = true;
      try {
        new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets, { displayOnly: true });
        const preparation = await validateCanvasLayout(pkg);
        return await decodedDocument(pkg, preparation.measure);
      } catch (fallbackError) {
        recordPreviewIssue(issues, fallbackError);
      }
    }
    // Measurement and bitmap decoding can reveal limitations after XML import.
    pkg = DocxPackage.preview(pkg.parts);
    pkg.previewIssues = [...issues];
    await validateCanvasLayout(pkg);
    return { pkg, images: new Map() };
  }
}
