import type { Editor } from '../editor';
import type { CanvasPointer } from './pointer';

// Features plug into the workspace through these registries, so menus, the
// toolbar, panels and shortcuts are generated from one description and never
// show controls without an implementation.
export type Command = {
  id: string;
  label: string;
  // Display/match form such as "Mod+Shift+N"; Mod is Command on macOS, Ctrl elsewhere.
  shortcut?: string | string[];
  run: (e: Editor, arg?: unknown) => void | Promise<void>;
  enabled?: (e: Editor) => boolean;
  checked?: (e: Editor) => boolean;
  // Hidden commands stay callable (shortcuts, actions) but never appear in menus.
  hidden?: boolean;
  // Recorded by the Actions panel when true (default for document edits).
  recordable?: boolean;
  // Append to a dynamic submenu by its ID (for example "filter.blur").
  menu?: string;
  // Sort key within a dynamic submenu; ties keep registration order.
  order?: number;
  // Short help shown in tooltips and the command search.
  description?: string;
  // Starts loading a lazily loaded implementation (menu hover, see app/lazy.ts).
  prefetch?: () => void;
};
export const commands = new Map<string, Command>();
// Old ID -> current ID for renamed commands, so recorded actions and custom
// shortcuts from earlier versions keep working.
export const renamedCommands = new Map<string, string>();
export const findCommand = (id: string) => commands.get(renamedCommands.get(id) ?? id);
/** Commands that only run from a person's own click or key press, never from
 * a script or a replayed action: the Assistant (asking sends a request that
 * may use the person's AI credits at once) and Generation History. */
export const interactiveOnly = (id: string) => /^(assistant|generations)\./.test(id);
export function registerCommand(...list: Command[]) {
  for (const c of list) commands.set(c.id, c);
}

export type ToolOptionsContext = { e: Editor; el: HTMLElement };
export interface Tool {
  id: string;
  label: string;
  // Single key; Shift+key cycles through the tools of a group.
  key?: string;
  icon: string;
  // Toolbar slot; tools sharing a group share a slot with a flyout.
  group: string;
  cursor?: (e: Editor) => string;
  // HTML for the options bar; `bindOptions` wires it after insertion.
  options?: (e: Editor) => string;
  bindOptions?: (ctx: ToolOptionsContext) => void;
  activate?: (e: Editor) => void;
  deactivate?: (e: Editor) => void;
  pointerDown?: (e: Editor, p: CanvasPointer) => void | Promise<void>;
  pointerMove?: (e: Editor, p: CanvasPointer) => void;
  pointerUp?: (e: Editor, p: CanvasPointer) => void | Promise<void>;
  // Pointer movement without buttons (brush outline, live wire previews).
  hover?: (e: Editor, p: CanvasPointer) => void;
  doubleClick?: (e: Editor, p: CanvasPointer) => void;
  keyDown?: (e: Editor, event: KeyboardEvent) => boolean;
  // SVG markup in document coordinates drawn above the canvas.
  overlay?: (e: Editor) => string;
  // Tools that do not change the document can run without one.
  needsDocument?: boolean;
  // Brush-like tools: Alt + right-drag (Ctrl + Alt drag on a Mac) changes
  // size horizontally and hardness or opacity vertically.
  brush?: {
    get(e: Editor): { size: number; hardness: number; opacity: number; roundness: number };
    set(e: Editor, v: { size?: number; hardness?: number; opacity?: number }): void;
  };
  // Starts loading a lazily loaded implementation (toolbar hover, see app/lazy.ts).
  prefetch?: () => void;
}
export const tools = new Map<string, Tool>();
export function registerTool(...list: Tool[]) {
  for (const t of list) tools.set(t.id, t);
}

// 'bottom' panels dock horizontally under the canvas (see app/bottom-dock.ts).
export type PanelLocation = 'dock-top' | 'dock-middle' | 'dock-bottom' | 'strip' | 'bottom';
export interface Panel {
  id: string;
  title: string;
  icon: string;
  location: PanelLocation;
  // Panels that start hidden are opened from the Window menu.
  hidden?: boolean;
  shortcut?: string;
  mount: (e: Editor, el: HTMLElement) => void;
  // Called after document or selection changes while the panel is visible.
  update?: (e: Editor, el: HTMLElement) => void;
  menu?: (e: Editor) => MenuItem[];
}
export const panels = new Map<string, Panel>();
export function registerPanel(...list: Panel[]) {
  for (const p of list) panels.set(p.id, p);
}

export type MenuItem =
  | string // command ID
  | '-'
  | { label: string; items: MenuItem[]; id?: string };

// Overlay providers draw document-space SVG independent of the active tool
// (marching ants, guides, grid, path outlines).
export const overlays = new Map<string, (e: Editor) => string>();
export function registerOverlay(id: string, draw: (e: Editor) => string) {
  overlays.set(id, draw);
}
// Contributions to existing menus: after a command ID within a top-level menu.
export const menuContributions: { menu: string; after?: string; items: MenuItem[] }[] = [];
export function contributeMenu(menu: string, items: MenuItem[], after?: string) {
  menuContributions.push({ menu, after, items });
}
