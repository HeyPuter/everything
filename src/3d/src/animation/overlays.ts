// Extra drawing and View menu entries shared by the time editors (Timeline, Dope Sheet): modules
// such as the physics caches register here (e.g. the cache bars along the bottom and View ▸ Cache).
import type { MenuItem } from '../ui/menu';
import type { AnimEditor } from './animeditor';

// method syntax keeps the editor parameter bivariant (overlays may expect a Timeline)
type Overlay = { draw(g: CanvasRenderingContext2D, ed: AnimEditor, W: number): void }['draw'];
type ViewHook = { items(ed: AnimEditor): MenuItem[] }['items'];

/** Drawing over the content of the time editors (after the rows, before the playhead). */
export const timelineOverlays: Overlay[] = [];
/** View menu entries of the time editors (e.g. Cache ▸). */
export const timelineViewMenuHooks: ViewHook[] = [];

/** The registered View entries followed by a separator (nothing when none are registered). */
export function cacheMenuItems(ed: AnimEditor): MenuItem[] {
  const items = timelineViewMenuHooks.flatMap((f) => f(ed));
  return items.length ? [...items, { separator: true }] : [];
}
