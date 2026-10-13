// Running filters from menus, actions and the Live Filter rows: loads with
// the first filter used (with the operation catalog, dialogs and Liquify).
import type { Editor } from '../../editor';
import { defaults, type ParamValues } from '../../imaging/types';
import { isBlendMode, type BlendMode } from '../../imaging/blend';
import { GALLERY_ID, RESTORE_ID, filterOp, normalizeFor } from './catalog';
import { applyDirect, filterState } from './apply';
import { filterDialog, lastUsed } from './dialog';
import { galleryDialog } from './gallery';
import { fade } from './fade';
import { convertForLiveFilters, toggleLiveMask } from './live';
import { installWideAngle } from './wide-angle';

export { liquify } from './liquify';
export { perspectivePlanes } from './perspective-planes';
export { convertForLiveFilters, toggleLiveMask };

// Adaptive Wide Angle opens its own workspace instead of the generic dialog.
installWideAngle();

export function paramsOf(arg: unknown): Record<string, unknown> | undefined {
  if (!arg || typeof arg !== 'object') return undefined;
  const p = (arg as { params?: unknown }).params;
  return p && typeof p === 'object' ? (p as Record<string, unknown>) : undefined;
}
/** Run a filter: with settings it applies directly, otherwise its dialog opens. */
export async function runFilter(e: Editor, opId: string, arg?: unknown) {
  const given = paramsOf(arg);
  if (opId === GALLERY_ID) {
    if (given) await applyDirect(e, opId, normalizeFor(opId, given));
    else await galleryDialog(e);
    return;
  }
  if (opId === RESTORE_ID) {
    // Settings (actions, scripts) apply directly; otherwise the workspace opens.
    if (given) {
      // Pixel-dependent parts (AI results, depth layers) cannot be replayed.
      const { normalizeRestore, replayable } = await import('../../imaging/restore/defs');
      await applyDirect(e, opId, replayable(normalizeRestore(given)) as unknown as ParamValues);
    } else await (await import('../restore/workspace')).openRestore(e);
    return;
  }
  const op = filterOp(opId);
  if (!op) return;
  if (given || op.immediate) {
    const params = normalizeFor(opId, given ?? defaults(op));
    if (await applyDirect(e, opId, params)) lastUsed.set(opId, params);
  } else await filterDialog(e, opId);
}
export function editLive(e: Editor, layerId: string, index: number, id: string) {
  void e.run(async () => {
    if (id === GALLERY_ID) await galleryDialog(e, { edit: { layerId, index } });
    else if (id === RESTORE_ID) await (await import('../restore/workspace')).openRestore(e, { edit: { layerId, index } });
    else await filterDialog(e, id, { edit: { layerId, index } });
  });
}

export async function runLastFilter(e: Editor) {
  const last = filterState.last;
  if (last) await applyDirect(e, last.opId, last.params);
}
export async function runFade(e: Editor, arg?: unknown) {
  const p = paramsOf(arg);
  const opacity = typeof p?.opacity === 'number' ? Math.max(0, Math.min(1, p.opacity)) : 1;
  const mode = isBlendMode(p?.mode) ? (p!.mode as BlendMode) : 'normal';
  await fade(e, p ? { opacity, mode } : undefined);
}
