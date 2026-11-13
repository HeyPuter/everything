// Small preview images of documents for version lists, recovery and the
// start screen's recent files.
import type { Editor } from '../../editor';
import type { DocumentSession } from '../../app/session';

/** A thumbnail (longest side `size`) of a document snapshot in a session. */
export async function documentThumbnail(e: Editor, s: DocumentSession, size = 192, doc = s.doc): Promise<Blob | undefined> {
  if (!e.renderer || !s.hasDocument) return undefined;
  const k = Math.min(1, size / Math.max(doc.width, doc.height));
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(doc.width * k));
  out.height = Math.max(1, Math.round(doc.height * k));
  try {
    await e.renderer.drawFrame(doc, s.assets, (canvas) => {
      const c = out.getContext('2d')!;
      c.imageSmoothingQuality = 'high';
      c.drawImage(canvas, 0, 0, out.width, out.height);
    });
  } finally {
    // The visible canvas drew another state; show the current one again.
    await e.render(e.displayDoc);
  }
  return new Promise((resolve) => out.toBlob((b) => resolve(b ?? undefined), 'image/png'));
}
