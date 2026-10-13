/**
 * Recent colors: the last solid colors applied to artwork (fill or stroke,
 * from any panel or tool that goes through applyStyle), newest first,
 * kept in the user's preferences. A drag that applies many colors in one
 * undo step (same coalesce key) records only its final color.
 */
import { h } from '../../lib/dom.js';
import { isHex, normalizeHex } from '../../lib/color.js';
import { paintHooks } from '../../ops/paint-ops.js';
import { focusedPaint, setFocusedColor } from './ui-common.js';
import { isGradient } from '../../model/gradients.js';

export const RECENT_MAX = 10;
const KEY = 'recentColors';

let hookApp = null;
let installed = false;
let lastKey = null;

export function recentColors(app) {
  const list = app.prefs.get(KEY);
  return Array.isArray(list) ? list.filter((c) => isHex(c)) : [];
}

/** Record a color; with the same `coalesce` key as the last call it replaces that entry. */
export function pushRecentColor(app, hex, coalesce = null) {
  if (!isHex(hex)) return;
  const c = normalizeHex(hex).toLowerCase();
  const old = recentColors(app);
  let list = old;
  if (coalesce && coalesce === lastKey && list.length) list = list.slice(1);
  lastKey = coalesce;
  list = [c, ...list.filter((x) => x !== c)].slice(0, RECENT_MAX);
  if (list.join() === old.join()) return;
  app.prefs.set(KEY, list);
  app.emit?.('recent-colors', list);
}

export function clearRecentColors(app) {
  app.prefs.set(KEY, []);
  app.emit?.('recent-colors', []);
}

/** Record solid colors applied through applyStyle (one hook for every app instance; the newest app records). */
export function installRecentColors(app) {
  hookApp = app;
  if (installed) return;
  installed = true;
  const prev = paintHooks.applyStyle;
  paintHooks.applyStyle = (editor, patch, label, coalesce) => {
    if (hookApp && patch) {
      for (const key of ['fill', 'stroke']) {
        const p = patch[key];
        if (p && p.type === 'solid' && p.color) pushRecentColor(hookApp, p.color, coalesce ? `${key}:${coalesce}` : null);
      }
    }
    return prev ? prev(editor, patch, label, coalesce) : false;
  };
}

/**
 * The Recent Colors row: a label and up to RECENT_MAX color buttons. A
 * click applies the color to the focused fill or stroke (the selected stop
 * when that is a gradient).
 */
export function recentColorsRow(app) {
  const cells = h('div.rc-cells', { role: 'group', 'aria-label': 'Recent colors' });
  const el = h('div.recent-colors', h('span.rc-label', { 'aria-hidden': 'true' }, 'Recent Colors'), cells);
  let key = null;
  const apply = (hex) => {
    const ed = app.editor;
    if (!ed) return;
    const p = focusedPaint(ed).paint;
    setFocusedColor(ed, hex, null, { forceSolid: !(isGradient(p) || p?.type === 'freeform') });
  };
  const refresh = () => {
    const list = recentColors(app);
    const k = list.join();
    if (k === key) return;
    key = k;
    const btns = list.map((c) => h('button.rc-cell', { type: 'button', style: { background: c }, 'aria-label': `Recent color ${c.toUpperCase()}`, 'data-tip': c.toUpperCase(), onclick: () => apply(c) }));
    for (let i = list.length; i < RECENT_MAX; i++) btns.push(h('span.rc-cell.empty', { 'aria-hidden': 'true' }));
    cells.replaceChildren(...btns);
  };
  refresh();
  return { el, refresh };
}
