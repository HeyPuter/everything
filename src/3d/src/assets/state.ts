// What asset operators need to know about the Asset Browser they run in (kept separate from the
// editor class so operators, menus and drop handling do not import the editor module).
import type { OpContext } from '../app/app';
import type { AssetEntry, ImportMethod } from './library';

export type ImportSetting = 'FOLLOW_PREFS' | ImportMethod;

export interface AssetBrowserLike {
  library: string;
  /** selected catalog path; null shows all, UNASSIGNED the assets without a catalog */
  catalogPath: string | null;
  importMethod: ImportSetting;
  instanceCollections: boolean;
  selected: Set<string>;
  active: string | null;
  /** the selected assets as shown */
  selection(): AssetEntry[];
  activeAsset(): AssetEntry | null;
  draw(): void;
  selectAll(action: 'SELECT' | 'DESELECT' | 'INVERT' | 'TOGGLE'): void;
  walk(dir: 'UP' | 'DOWN' | 'LEFT' | 'RIGHT', extend: boolean, fill: boolean): void;
  viewSelected(): void;
  startFilter(): void;
  toggleSidebar(): void;
  toggleDetails(): void;
  startRename(): void;
  boxPending: boolean;
  setLibrary(id: string): void;
}

export const UNASSIGNED = '\u0000unassigned';

export function browserOf(ctx: OpContext | { area: { type: string; editor: unknown } | null }): AssetBrowserLike | null {
  const a = ctx.area as { type?: string; editor?: unknown } | null;
  return a?.type === 'ASSETS' ? (a.editor as AssetBrowserLike) : null;
}
