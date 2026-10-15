// Which node tree a node editor shows. A provider resolves the root tree (material, world,
// geometry node group, compositor) and draws the tree-specific part of the header; group
// editing (Tab) is handled generically by the editor through a path of group ids.
import type { Child } from '../../ui/h';
import type { NodeData, NodeTreeData } from '../../data/types';
import type { TreeType } from '../types';
import type { EditorTypeId } from '../../ui/screen';

export interface TreeRoot {
  tree: NodeTreeData;
  /** stable key for per-tree view state */
  key: string;
  /** breadcrumb items: [icon, name] */
  crumbs: [string, string][];
  /** the root tree is this node group (it must not be added into itself) */
  groupId?: string;
}

export interface NodeEditorProvider {
  id: EditorTypeId;
  label: string;
  icon: string;
  /** tree type of the root (for Add menus and group compatibility) */
  treeType(ed: { shaderType: 'OBJECT' | 'WORLD' }): TreeType;
  root(ed: { shaderType: 'OBJECT' | 'WORLD' }): TreeRoot | null;
  /** header part after the editor-type button and before View/Select/Add/Node */
  headerLeft?(ed: unknown): Child;
  /** header part after the menus (data-block selectors etc.) */
  headerRight?(ed: unknown): Child;
  /** message shown when there is no tree */
  emptyMessage?(ed: unknown): string;
  /** per-entry Add-menu filter */
  menuPoll?(idname: string, ed: { shaderType: 'OBJECT' | 'WORLD' }): boolean;
  /** draw behind the links and nodes, over the grid (e.g. the compositor backdrop) */
  drawBackdrop?(ed: unknown, g: CanvasRenderingContext2D, width: number, height: number): void;
  /** link a node (or one of its outputs) to the tree's viewer (Ctrl Shift click); without this, trees connect to the output */
  linkViewer?(ed: unknown, node: NodeData, socket?: string): boolean;
  /** panels of the sidebar's View tab (the tab is shown only when this exists) */
  viewPanels?(ed: unknown): Child;
  /** panels of the sidebar's Options tab, e.g. material settings (shown only when this exists) */
  optionsPanels?(ed: unknown): Child;
  /** messages reported by a node when the tree was last evaluated (shown on its header) */
  nodeWarnings?(ed: unknown, node: NodeData): string[] | undefined;
}

export const providers = new Map<string, NodeEditorProvider>();
export function registerNodeEditorProvider(p: NodeEditorProvider) {
  providers.set(p.id, p);
}
