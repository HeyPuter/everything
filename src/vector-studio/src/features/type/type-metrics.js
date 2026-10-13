/**
 * Document Setup > Type settings that change layout: superscript,
 * subscript and small caps sizes and positions. Layouts read them through
 * textHooks.typeMetrics; a change (or its undo) drops cached bounds.
 */
import { textHooks } from '../../model/text-layout.js';
import { clearGeometryCache } from '../../model/geometry.js';
import { typeMetricsOf } from '../files/type-setup.js';
import { docForNode } from './threads.js';

export function installTypeMetrics(app) {
  textHooks.typeMetrics = (node) => typeMetricsOf(docForNode(app, node)?.root);
  const seen = new WeakMap(); // doc -> root.typeOptions last laid out
  const wire = (ed) => {
    if (!ed || seen.has(ed.doc)) return;
    const doc = ed.doc;
    seen.set(doc, doc.root.typeOptions);
    doc.on('change', () => {
      if (doc.root.typeOptions === seen.get(doc)) return;
      seen.set(doc, doc.root.typeOptions);
      clearGeometryCache();
    });
  };
  app.on('active-editor', wire);
  if (app.editor) wire(app.editor);
}
