// The application shell, reachable from modules that must not import shell.ts (import cycles:
// shell.ts pulls in the editors). Set by setShell().
import type { Workspace } from './screen';

export interface ShellRef {
  workspaces: Workspace[];
  active: string;
}

export const shellRef: { current: ShellRef | null } = { current: null };
