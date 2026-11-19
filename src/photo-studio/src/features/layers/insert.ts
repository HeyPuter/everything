import type { Editor } from '../../editor';
import { insertLayerAt, type Layer, type PhotoDocument } from '../../model/document';
import { ownLock } from '../../model/locks';

/** Add a layer above the selected layer (or at the top) as one undo step and
 * select it. Inside a clipping group the layer joins the group. `also` makes
 * further changes in the same step (Paste drops the selection). A locked
 * group takes no new layers: the layer goes above the outermost locked group
 * around the selected layer instead. */
export function insertAboveSelection(
  e: Editor,
  l: Layer,
  label: string,
  also?: (d: PhotoDocument) => void,
) {
  const anchor = e.selected;
  e.command(label, (d) => {
    const find = (layers: Layer[]): Layer[] | undefined => {
      for (const x of layers) {
        if (x.id === anchor) return [x];
        const path = find(x.children);
        if (path) return [x, ...path];
      }
    };
    const path = anchor ? find(d.layers) : undefined;
    if (!path) d.layers.push(l);
    else {
      const locked = path.findIndex((x, i) => i < path.length - 1 && ownLock(x));
      const at = locked < 0 ? path.length - 1 : locked;
      const list = at ? path[at - 1].children : d.layers;
      insertLayerAt(list, list.indexOf(path[at]) + 1, l);
    }
    also?.(d);
  });
  e.selected = l.id;
  e.update();
}
