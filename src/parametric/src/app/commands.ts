// Command registry: every action reachable from menus, toolbars, the command
// search box, context menus and keyboard shortcuts is a command.

export interface Command {
  id: string;
  label: string;
  icon?: string;
  /**
   * Shortcut in "Ctrl+Shift+K" form. Ctrl means Cmd on macOS; Control means
   * the Control key everywhere, for keys the browser keeps with Cmd (Cmd+Q quits).
   */
  shortcut?: string;
  description?: string;
  /** Extra words for the command search. */
  keywords?: string;
  run: () => void | Promise<void>;
  enabled?: () => boolean;
  checked?: () => boolean;
  /** Hidden from the command search. */
  hidden?: boolean;
}

export class CommandRegistry {
  private map = new Map<string, Command>();
  private listeners = new Set<() => void>();
  lastRun: string | null = null;

  register(...cmds: Command[]) {
    for (const c of cmds) this.map.set(c.id, c);
  }

  get(id: string): Command | undefined {
    return this.map.get(id);
  }

  all(): Command[] {
    return [...this.map.values()];
  }

  isEnabled(id: string): boolean {
    const c = this.map.get(id);
    return !!c && (c.enabled ? c.enabled() : true);
  }

  isChecked(id: string): boolean {
    return !!this.map.get(id)?.checked?.();
  }

  run(id: string): boolean {
    const c = this.map.get(id);
    if (!c || (c.enabled && !c.enabled())) return false;
    if (!['repeat', 'undo', 'redo'].includes(id)) this.lastRun = id;
    void Promise.resolve(c.run()).catch((e) => console.error(e));
    this.changed();
    return true;
  }

  /** Notifies toolbars/menus that enabled/checked states may have changed. */
  changed() {
    for (const fn of this.listeners) fn();
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Finds the command bound to a keyboard event. */
  match(e: KeyboardEvent): Command | undefined {
    const key = eventShortcut(e);
    if (!key) return undefined;
    for (const c of this.map.values()) if (c.shortcut && normalize(c.shortcut) === key) return c;
    return undefined;
  }

  search(q: string): Command[] {
    const s = q.trim().toLowerCase();
    if (!s) return [];
    const words = s.split(/\s+/);
    return this.all()
      .filter((c) => !c.hidden)
      .map((c) => {
        const hay = `${c.label} ${c.keywords ?? ''} ${c.description ?? ''}`.toLowerCase();
        if (!words.every((w) => hay.includes(w))) return null;
        const score = c.label.toLowerCase().startsWith(s) ? 0 : c.label.toLowerCase().includes(s) ? 1 : 2;
        return { c, score };
      })
      .filter((x): x is { c: Command; score: number } => !!x)
      .sort((a, b) => a.score - b.score || a.c.label.localeCompare(b.c.label))
      .map((x) => x.c)
      .slice(0, 12);
  }
}

const isMacPlatform = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

function normalize(s: string): string {
  const parts = s.split('+');
  const key = parts.pop()!;
  const mods = new Set(parts.map((p) => p.toLowerCase()));
  // On macOS the Control key is a modifier of its own ("K"); elsewhere it is Ctrl.
  const ctrl = mods.has('ctrl') || (!isMacPlatform && mods.has('control'));
  const control = isMacPlatform && mods.has('control');
  return `${ctrl ? 'C' : ''}${control ? 'K' : ''}${mods.has('alt') ? 'A' : ''}${mods.has('shift') ? 'S' : ''}:${key.toLowerCase()}`;
}

export function eventShortcut(e: KeyboardEvent): string | null {
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return null;
  const ctrl = isMacPlatform ? e.metaKey : e.ctrlKey;
  let key = e.key;
  if (key === ' ') key = 'Space';
  // Use the physical digit for Ctrl+1..9 on any layout.
  if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  // Control on macOS does not fall through to the plain key's command (Control+L is not L).
  const control = isMacPlatform && e.ctrlKey;
  return `${ctrl ? 'C' : ''}${control ? 'K' : ''}${e.altKey ? 'A' : ''}${e.shiftKey ? 'S' : ''}:${key.toLowerCase()}`;
}
