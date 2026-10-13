import { emptyDockLayout, sanitizeDockLayout, type DockLayout } from '../../app/dock';
import type { PanelLocation } from '../../app/registry';
import { sanitizeToolbarLayout, type ToolbarLayout } from '../../app/toolbar-layout';
import { sanitizeMenuCustomization, type MenuCustomization } from '../../app/menu-custom';

// Workspaces: named arrangements of the dock plus the visibility of the
// options bar and tools panel. Saved workspaces may also carry keyboard
// shortcuts and toolbar/menu customizations. Pure data, no DOM.

export type WorkspaceSnapshot = {
  dock: DockLayout;
  optionsBar: boolean;
  toolsPanel: boolean;
  shortcuts?: Record<string, string>;
  toolbar?: ToolbarLayout;
  menus?: MenuCustomization;
};
export type SavedWorkspace = { id: string; name: string; snapshot: WorkspaceSnapshot };
export type WorkspaceState = {
  current: string;
  locked: boolean;
  saved: SavedWorkspace[];
  // Changes made while a workspace was current, restored when switching back
  // to it and discarded by Reset.
  modified: Record<string, WorkspaceSnapshot>;
};

type GroupLocation = Exclude<PanelLocation, 'strip'>;
export type WorkspacePreset = {
  id: string;
  name: string;
  // Panels per dock group, first one active. Unlisted panels go to the strip.
  // An omitted `groups` keeps every panel where it registered.
  groups?: Partial<Record<GroupLocation, string[]>>;
  // Strip order (panels listed first, the rest follow).
  strip?: string[];
  collapsed?: GroupLocation[];
  sizes?: Partial<Record<GroupLocation, number>>;
};
// Original arrangements tuned for common kinds of work.
export const workspacePresets: WorkspacePreset[] = [
  { id: 'essentials', name: 'Essentials' },
  {
    id: 'photography',
    name: 'Photography',
    groups: {
      'dock-top': ['histogram', 'navigator', 'info'],
      'dock-middle': ['adjustments', 'properties'],
      'dock-bottom': ['layers', 'channels', 'paths', 'history'],
    },
    strip: ['assistant', 'generations', 'color', 'swatches', 'actions', 'tool-presets'],
    sizes: { 'dock-middle': 260, 'dock-bottom': 380 },
  },
  {
    id: 'painting',
    name: 'Painting',
    groups: {
      'dock-top': ['color', 'swatches'],
      'dock-middle': ['brush-settings', 'brushes', 'tool-presets'],
      'dock-bottom': ['layers', 'channels', 'history'],
    },
    strip: ['navigator', 'properties', 'adjustments', 'gradients', 'patterns'],
  },
  {
    id: 'graphic-web',
    name: 'Graphic and Web',
    groups: {
      'dock-top': ['properties', 'character', 'paragraph'],
      'dock-middle': ['styles', 'swatches', 'gradients', 'patterns'],
      'dock-bottom': ['layers', 'paths', 'info'],
    },
    strip: ['color', 'history', 'navigator', 'actions'],
  },
  {
    id: 'motion',
    name: 'Motion',
    groups: {
      'dock-top': ['properties', 'navigator'],
      'dock-middle': ['adjustments', 'styles', 'actions'],
      'dock-bottom': ['timeline', 'layers', 'history'],
    },
    strip: ['color', 'swatches', 'info', 'histogram'],
    sizes: { 'dock-middle': 200, 'dock-bottom': 420 },
  },
];
export const defaultWorkspace = 'essentials';

/** The dock layout a preset describes, given the registered panels
 * (ID → registered location, in registration order). */
export function presetDockLayout(preset: WorkspacePreset, registered: [string, PanelLocation][]): DockLayout {
  const layout = emptyDockLayout();
  if (!preset.groups) return layout;
  const known = new Map(registered);
  const placement: Record<string, PanelLocation> = {};
  const order: string[] = [];
  const place = (id: string, loc: PanelLocation) => {
    if (!known.has(id) || order.includes(id)) return;
    order.push(id);
    if (known.get(id) !== loc) placement[id] = loc;
  };
  for (const [loc, ids] of Object.entries(preset.groups) as [GroupLocation, string[]][]) {
    for (const id of ids) place(id, loc);
    const first = ids.find((id) => known.has(id));
    if (first) layout.active[loc] = first;
  }
  for (const id of preset.strip ?? []) place(id, 'strip');
  for (const [id] of registered) place(id, 'strip');
  layout.placement = placement;
  layout.order = order;
  if (preset.collapsed?.length) layout.collapsed = [...preset.collapsed];
  for (const [loc, size] of Object.entries(preset.sizes ?? {})) if (size) layout.sizes[loc] = size;
  return layout;
}
export function presetSnapshot(preset: WorkspacePreset, registered: [string, PanelLocation][]): WorkspaceSnapshot {
  return { dock: presetDockLayout(preset, registered), optionsBar: true, toolsPanel: true };
}

export function sanitizeSnapshot(v: unknown): WorkspaceSnapshot | undefined {
  if (!v || typeof v !== 'object') return;
  const o = v as Record<string, unknown>;
  const out: WorkspaceSnapshot = { dock: sanitizeDockLayout(o.dock), optionsBar: o.optionsBar !== false, toolsPanel: o.toolsPanel !== false };
  if (o.shortcuts && typeof o.shortcuts === 'object' && !Array.isArray(o.shortcuts))
    out.shortcuts = Object.fromEntries(Object.entries(o.shortcuts).filter(([, s]) => typeof s === 'string')) as Record<string, string>;
  if (o.toolbar !== undefined) out.toolbar = sanitizeToolbarLayout(o.toolbar);
  if (o.menus !== undefined) out.menus = sanitizeMenuCustomization(o.menus);
  return out;
}
export function sanitizeWorkspaceState(v: unknown): WorkspaceState {
  const out: WorkspaceState = { current: defaultWorkspace, locked: false, saved: [], modified: {} };
  if (!v || typeof v !== 'object') return out;
  const o = v as Record<string, unknown>;
  if (Array.isArray(o.saved))
    for (const s of o.saved) {
      const snapshot = s && typeof s === 'object' ? sanitizeSnapshot((s as SavedWorkspace).snapshot) : undefined;
      if (snapshot && typeof s.id === 'string' && typeof s.name === 'string' && s.name.trim() && !out.saved.some((x) => x.id === s.id))
        out.saved.push({ id: s.id, name: s.name.trim(), snapshot });
    }
  if (typeof o.current === 'string' && workspaceExists(out, o.current)) out.current = o.current;
  out.locked = o.locked === true;
  if (o.modified && typeof o.modified === 'object')
    for (const [id, snap] of Object.entries(o.modified as Record<string, unknown>)) {
      const s = sanitizeSnapshot(snap);
      if (s && workspaceExists(out, id)) out.modified[id] = s;
    }
  return out;
}
export function workspaceExists(state: Pick<WorkspaceState, 'saved'>, id: string) {
  return workspacePresets.some((p) => p.id === id) || state.saved.some((s) => s.id === id);
}
export function workspaceName(state: Pick<WorkspaceState, 'saved'>, id: string) {
  return workspacePresets.find((p) => p.id === id)?.name ?? state.saved.find((s) => s.id === id)?.name ?? 'Workspace';
}
/** The arrangement a workspace starts from (what Reset restores). */
export function baseSnapshot(state: Pick<WorkspaceState, 'saved'>, id: string, registered: [string, PanelLocation][]): WorkspaceSnapshot {
  const saved = state.saved.find((s) => s.id === id);
  if (saved) return structuredClone(saved.snapshot);
  return presetSnapshot(workspacePresets.find((p) => p.id === id) ?? workspacePresets[0], registered);
}
/** Switch workspaces: remember the current arrangement under the old
 * workspace and return the one to show for the new one. */
export function switchWorkspace(state: WorkspaceState, live: WorkspaceSnapshot, id: string, registered: [string, PanelLocation][]) {
  const next: WorkspaceState = structuredClone(state);
  if (id === state.current) return { state: next, show: structuredClone(live) };
  next.modified[state.current] = structuredClone({ dock: live.dock, optionsBar: live.optionsBar, toolsPanel: live.toolsPanel });
  next.current = id;
  const show = next.modified[id] ?? baseSnapshot(next, id, registered);
  return { state: next, show: structuredClone(show) };
}
/** Save the live arrangement under a name (replacing a saved workspace of the same name). */
export function saveWorkspace(state: WorkspaceState, name: string, snapshot: WorkspaceSnapshot, newId: string): WorkspaceState {
  const next: WorkspaceState = structuredClone(state);
  const trimmed = name.trim();
  const existing = next.saved.find((s) => s.name.toLowerCase() === trimmed.toLowerCase());
  const id = existing?.id ?? newId;
  const entry = { id, name: trimmed, snapshot: structuredClone(snapshot) };
  if (existing) next.saved[next.saved.indexOf(existing)] = entry;
  else next.saved.push(entry);
  delete next.modified[id];
  next.current = id;
  return next;
}
export function deleteWorkspace(state: WorkspaceState, id: string): WorkspaceState {
  const next: WorkspaceState = structuredClone(state);
  next.saved = next.saved.filter((s) => s.id !== id);
  delete next.modified[id];
  if (next.current === id) next.current = defaultWorkspace;
  return next;
}
