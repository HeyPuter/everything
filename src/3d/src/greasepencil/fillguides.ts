// Fill guides: helper lines drawn with Alt in the Fill tool. They bound fills like any stroke,
// show in the viewport only (never rendered or exported) and are removed with Remove Fill Guides.
import { app, registerOperators } from '../app/app';
import { gpOf, frameAt, toStrokes, fromStrokes, normalizeDrawing } from './data';
import type { GPDrawing } from './types';

/** The drawing without its fill guides, or null when it has none. */
export function withoutGuides(d: GPDrawing): GPDrawing | null {
  const g = d.is_fill_guide;
  if (!g || !g.some((x) => x)) return null;
  return fromStrokes(toStrokes(normalizeDrawing(d)).filter((s) => !s.is_fill_guide));
}

registerOperators([
  {
    idname: 'grease_pencil.remove_fill_guides',
    label: 'Remove Fill Guides',
    description: 'Delete the helper lines drawn for the Fill tool',
    props: [
      {
        id: 'mode',
        label: 'Mode',
        type: 'enum',
        default: 'ALL_FRAMES',
        items: [
          ['ACTIVE_FRAME', 'Active Frame', 'Only the drawings shown at the current frame'],
          ['ALL_FRAMES', 'All Frames', 'Every drawing of the object'],
        ],
      },
    ],
    poll: () => !!gpOf(app.doc, app.activeObject),
    exec: (_c, p) => {
      const gp = gpOf(app.doc, app.activeObject)!;
      const idx = new Set<number>();
      if (p.mode === 'ACTIVE_FRAME') {
        for (const l of gp.layers) {
          const fr = frameAt(l, app.doc.scene.frame_current);
          if (fr && !l.lock) idx.add(fr.drawing);
        }
      } else gp.drawings.forEach((_, i) => idx.add(i));
      let n = 0;
      for (const i of idx) {
        const d = gp.drawings[i];
        if (!d) continue;
        const out = withoutGuides(d);
        if (!out) continue;
        n += d.offsets.length - out.offsets.length;
        gp.drawings[i] = out;
      }
      if (!n) {
        app.report('INFO', 'No fill guides to remove');
        return 'CANCELLED';
      }
      app.report('INFO', `Removed ${n} fill guide${n === 1 ? '' : 's'}`);
    },
  },
]);
