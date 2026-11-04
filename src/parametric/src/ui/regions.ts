// F6 / Shift+F6 move focus between the major regions of the window (title
// bar, CommandManager, left pane, graphics area, task pane, status bar), as
// in desktop apps, instead of tabbing through every control on the way.

export interface FocusRegion {
  el: HTMLElement;
  /** The region's preferred tab stop when it has no remembered focus. */
  target?: () => HTMLElement | null | undefined;
}

const TABBABLE = 'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]';

const shown = (el: HTMLElement) => el.isConnected && !el.closest('[hidden], [inert]') && el.getClientRects().length > 0;

/** Whether the keyboard can stop on an element (a roving item that is not the current stop cannot). */
export const isTabStop = (el: HTMLElement) => el.tabIndex >= 0 && el.matches(TABBABLE) && shown(el);

export const firstTabStop = (box: ParentNode) => [...box.querySelectorAll<HTMLElement>(TABBABLE)].find(isTabStop) ?? null;

/** The element last focused in each region, so coming back returns there. */
const lastFocus = new WeakMap<HTMLElement, HTMLElement>();

export function trackRegionFocus(regions: () => FocusRegion[]) {
  window.addEventListener('focusin', (e) => {
    const t = e.target as HTMLElement;
    const r = regions().find((x) => x.el.contains(t));
    if (r && t !== r.el) lastFocus.set(r.el, t);
  }, true);
}

/** Focuses the next (or previous) visible region's tab stop. Returns whether focus moved. */
export function cycleRegion(regions: FocusRegion[], from: Element | null, dir: 1 | -1): boolean {
  const live = regions.filter((r) => shown(r.el));
  if (!live.length) return false;
  const at = live.findIndex((r) => from && r.el.contains(from));
  for (let step = 1; step <= live.length; step++) {
    const i = at < 0 ? (dir > 0 ? step - 1 : live.length - step) : (at + dir * step + live.length * step) % live.length;
    const r = live[i];
    const last = lastFocus.get(r.el);
    const pref = r.target?.();
    const el = (last && r.el.contains(last) && isTabStop(last) ? last : null)
      ?? (pref && shown(pref) ? pref : null)
      ?? firstTabStop(r.el);
    if (el) {
      el.focus();
      if (document.activeElement === el) return true;
    }
  }
  return false;
}
