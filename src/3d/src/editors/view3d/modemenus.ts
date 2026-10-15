// Mode-specific header menus registered by mode modules (edit mesh, sculpt, pose...).
import type { MenuItem } from '../../ui/menu';

export interface ModeMenus {
  /** menus shown in the header after View / Select / Add, e.g. [['Mesh', fn], ['Vertex', fn]] */
  header?: () => [string, () => MenuItem[]][];
  select?: () => MenuItem[];
  add?: () => MenuItem[];
  context?: () => MenuItem[];
  /** header widgets right after the mode selector (e.g. select mode buttons) */
  headerLead?: () => import('../../ui/h').Child;
  /** extra header widgets after the menus */
  headerExtra?: () => import('../../ui/h').Child;
}

export const modeMenus: Record<string, ModeMenus> = {};
