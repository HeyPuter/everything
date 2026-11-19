// Toolbar customization: the order of the slots and which slot each tool sits
// in. Tools moved to the "extra" slot leave the toolbar and are listed in the
// Extra Tools flyout at its end. Kept free of DOM code so it can be tested.

export const EXTRA_SLOT = 'extra';
export type ToolbarLayout = {
  // Slot (group) IDs in display order; unknown or missing slots keep their default place.
  order?: string[];
  // Tool ID → slot ID (or EXTRA_SLOT) for tools moved out of their own slot.
  assign?: Record<string, string>;
};
type ToolLike = { id: string; group: string };

/** The slot a tool is shown in under a layout. */
export function toolSlot(t: ToolLike, layout: ToolbarLayout) {
  return layout.assign?.[t.id] ?? t.group;
}
/** Slot order: the layout's order for known slots, with any slot it does not
 * mention inserted after its default predecessor. */
export function slotOrder(defaults: string[], layout: ToolbarLayout): string[] {
  const out = (layout.order ?? []).filter((g, i, all) => defaults.includes(g) && all.indexOf(g) === i);
  defaults.forEach((g, i) => {
    if (out.includes(g)) return;
    const prev = defaults.slice(0, i).reverse().find((p) => out.includes(p));
    out.splice(prev ? out.indexOf(prev) + 1 : 0, 0, g);
  });
  return out;
}
/** Tools of a slot in registration order. */
export function slotTools<T extends ToolLike>(tools: T[], slot: string, layout: ToolbarLayout): T[] {
  return tools.filter((t) => toolSlot(t, layout) === slot);
}
/** Move a tool to a slot (or the extra list); returns a new layout with
 * redundant entries removed so a reset tool leaves no trace. */
export function assignTool(layout: ToolbarLayout, tool: ToolLike, slot: string): ToolbarLayout {
  const assign = { ...(layout.assign ?? {}) };
  if (slot === tool.group) delete assign[tool.id];
  else assign[tool.id] = slot;
  return normalizeToolbarLayout({ ...layout, assign });
}
export function normalizeToolbarLayout(layout: ToolbarLayout): ToolbarLayout {
  const out: ToolbarLayout = {};
  if (layout.order?.length) out.order = [...layout.order];
  if (layout.assign && Object.keys(layout.assign).length) out.assign = { ...layout.assign };
  return out;
}
/** Accept stored data, dropping anything malformed. */
export function sanitizeToolbarLayout(v: unknown): ToolbarLayout {
  if (!v || typeof v !== 'object') return {};
  const o = v as Record<string, unknown>;
  const order = Array.isArray(o.order) ? o.order.filter((g): g is string => typeof g === 'string') : undefined;
  const assign: Record<string, string> = {};
  if (o.assign && typeof o.assign === 'object')
    for (const [k, s] of Object.entries(o.assign as Record<string, unknown>)) if (typeof s === 'string') assign[k] = s;
  return normalizeToolbarLayout({ order, assign });
}

const storageKey = 'photo-studio-toolbar';
let current: ToolbarLayout = (() => {
  try {
    return sanitizeToolbarLayout(JSON.parse(localStorage.getItem(storageKey) ?? 'null'));
  } catch {
    return {};
  }
})();
export const toolbarLayout = () => current;
export function setToolbarLayout(layout: ToolbarLayout) {
  current = normalizeToolbarLayout(layout);
  try {
    if (current.order || current.assign) localStorage.setItem(storageKey, JSON.stringify(current));
    else localStorage.removeItem(storageKey);
  } catch {
    /* Optional. */
  }
}

// Assisted mode shows a smaller set of slots; the tools of the other slots
// stay one click away in the Extra Tools flyout. Null: every slot.
let simplified: ReadonlySet<string> | null = null;
export const simplifiedSlots = () => simplified;
export function setSimplifiedSlots(slots: Iterable<string> | null) {
  simplified = slots ? new Set(slots) : null;
}
/** Slots shown: all of `order`, or only the simplified set. */
export function shownSlots(order: string[]): string[] {
  return simplified ? order.filter((g) => simplified!.has(g)) : order;
}
