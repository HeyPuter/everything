// SVG as Curves registration: File ▸ Import ▸ SVG as Curves (.svg)
import { app } from '../../app/app';
import { activeCollection, setMode } from '../../ops/object';
import { defineFormat } from './glue';
import { importSvgCurves } from './svgcurves';

defineFormat({
  id: 'svg_curves',
  label: 'SVG as Curves (.svg)',
  extensions: ['.svg'],
  description: 'Paths and shapes of an SVG drawing as Bézier curves (filled shapes as filled 2D curves)',
  importOps: ['import_curve.svg'],
  importOpLabel: 'Import SVG as Curves',
  multiFile: true,
  importOptions: [],
  importData(src) {
    const doc = app.doc;
    if (doc.mode !== 'OBJECT') setMode(doc, 'OBJECT');
    const objects = importSvgCurves(doc, new TextDecoder().decode(src.bytes), src.name, activeCollection(doc));
    if (!objects.length) app.report('WARNING', `"${src.name}" has no paths or shapes to import`);
    for (const ob of Object.values(doc.objects)) ob.select = false;
    for (const ob of objects) ob.select = true;
    if (objects.length) doc.scene.active_object = objects[objects.length - 1].id;
    app.changed('doc', 'select');
  },
});
