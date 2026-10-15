// Extra right-click menu entries of data-block selectors (e.g. Mark as Asset), given the shown
// data-block id. Filled by feature modules; read by the selectors.
import type { MenuItem } from './menu';

export const idSelectorMenuHooks: ((id: string) => MenuItem[])[] = [];
