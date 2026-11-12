import type { Editor } from '../../editor';
import { insertLayerAt, type Layer, type PhotoDocument } from '../../model/document';

/** Add a layer above the selected layer (or at the top) as one undo step and
 * select it. Inside a clipping group the layer joins the group. `also` makes
 * further changes in the same step (Paste drops the selection). */
export function insertAboveSelection(e: Editor, l: Layer, label: string, also?: (d: PhotoDocument) => void) {
  const anchor = e.selected;
  e.command(label, (d) => {
    const find = (layers: Layer[]): boolean => {
      const i = layers.findIndex((x) => x.id === anchor);
      if (i >= 0) {
        insertLayerAt(layers, i + 1, l);
        return true;
      }
      return layers.some((x) => find(x.children));
    };
    if (!anchor || !find(d.layers)) d.layers.push(l);
    also?.(d);
  });
  e.selected = l.id;
  e.update();
}
