// Place extra panels among the panels a Properties tab draws, next to a panel found by its id.
import type { Child, VNode } from '../../../ui/h';
import { onAppReady } from '../../../app/app';
import { propertiesTabs, type Properties } from '../properties';

function flat(c: Child, out: Child[] = []): Child[] {
  if (Array.isArray(c)) c.forEach((x) => flat(x, out));
  else if (c !== null && c !== undefined && c !== false) out.push(c);
  return out;
}

const panelId = (c: Child) => (c && typeof c === 'object' && !Array.isArray(c) ? ((c as VNode).attrs?.['data-panel'] as string | undefined) : undefined);

/**
 * Insert `add` before or after the panel `anchor` (the first anchor found of a list); when none
 * of the anchors is drawn the panels go at the end (`'end'`) or the start (`'start'`).
 */
export function insertPanels(out: Child, anchor: string | string[], where: 'before' | 'after', add: Child[], fallback: 'end' | 'start' = 'end'): Child[] {
  const list = flat(out);
  const extra = flat(add);
  if (!extra.length) return list;
  const anchors = Array.isArray(anchor) ? anchor : [anchor];
  for (const a of anchors) {
    const i = list.findIndex((c) => panelId(c) === a);
    if (i >= 0) {
      list.splice(where === 'before' ? i : i + 1, 0, ...extra);
      return list;
    }
  }
  if (fallback === 'start') {
    // keep header rows (data-block selectors, context paths) above the panels
    const first = list.findIndex((c) => panelId(c));
    list.splice(first < 0 ? list.length : first, 0, ...extra);
  } else list.push(...extra);
  return list;
}

/** Move the panel `id` right after the panel `after` (when both are drawn). */
export function movePanelAfter(list: Child[], id: string, after: string): Child[] {
  const i = list.findIndex((c) => panelId(c) === id);
  if (i < 0 || list.findIndex((c) => panelId(c) === after) < 0) return list;
  const [p] = list.splice(i, 1);
  list.splice(list.findIndex((c) => panelId(c) === after) + 1, 0, p);
  return list;
}

/** Move the panel `id` before the panel `before` (when both are drawn). */
export function movePanel(list: Child[], id: string, before: string): Child[] {
  const i = list.findIndex((c) => panelId(c) === id);
  if (i < 0) return list;
  const [p] = list.splice(i, 1);
  const j = list.findIndex((c) => panelId(c) === before);
  list.splice(j < 0 ? i : j, 0, p);
  return list;
}

/** Wrap a Properties tab's drawing once the app is ready (after the modules that wrap it first). */
export function extendTab(id: string, f: (out: Child, p: Properties) => Child) {
  onAppReady(() => {
    const tab = propertiesTabs.find((t) => t.id === id);
    if (!tab) return;
    const draw = tab.draw;
    tab.draw = (p) => f(draw(p), p);
  });
}
