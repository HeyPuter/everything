// Script directories (Preferences ▸ File Paths): folders on disk opened through the browser's
// folder picker. Add-on files found in their "addons" folder (or at their top level) are
// installed into Preferences ▸ Add-ons (not enabled), and installed again on Refresh.
import { app } from '../app/app';
import { kvGet, kvSet } from '../io/session';
import { installAddon, addons } from './addons';
import { addonId } from './addons_core';

interface DirHandle {
  kind: 'directory';
  name: string;
  values(): AsyncIterable<DirHandle | { kind: 'file'; name: string; getFile(): Promise<File> }>;
  queryPermission?(o: { mode: 'read' }): Promise<PermissionState>;
  requestPermission?(o: { mode: 'read' }): Promise<PermissionState>;
}

export const scriptDirs: { name: string; handle: DirHandle }[] = [];
const KEY = 'script-dirs';
const ADDON_FILE = /\.(py|js|mjs)$/i;

void (async () => {
  try {
    const list = (await kvGet<{ name: string; handle: DirHandle }[]>(KEY)) ?? [];
    scriptDirs.push(...list.filter((d) => d?.handle));
  } catch {
    // storage unavailable
  }
})();

const save = () => void kvSet(KEY, scriptDirs).catch(() => {});

/** Add-on files of a script folder: its "addons" folder, else its top level. */
async function addonFiles(dir: DirHandle): Promise<File[]> {
  const out: File[] = [];
  let sub: DirHandle | null = null;
  for await (const e of dir.values()) if (e.kind === 'directory' && e.name === 'addons') sub = e;
  for await (const e of (sub ?? dir).values()) if (e.kind === 'file' && ADDON_FILE.test(e.name)) out.push(await e.getFile());
  return out;
}

/** Install the add-ons found in a script folder that are not installed yet (or changed). */
export async function scanScriptDirectory(dir: DirHandle): Promise<number> {
  if (dir.queryPermission && (await dir.queryPermission({ mode: 'read' })) !== 'granted' && (await dir.requestPermission?.({ mode: 'read' })) !== 'granted') {
    app.report('WARNING', `No access to the folder "${dir.name}"`);
    return 0;
  }
  let n = 0;
  for (const f of await addonFiles(dir)) {
    const src = await f.text();
    const cur = addons.get(addonId(f.name));
    if (cur && cur.source === src) continue;
    await installAddon(f.name, src, !!cur?.enabled);
    n++;
  }
  return n;
}

/** Pick a folder and add it as a script directory. */
export async function addScriptDirectory() {
  const picker = (window as unknown as { showDirectoryPicker?: (o?: unknown) => Promise<DirHandle> }).showDirectoryPicker;
  if (!picker) {
    app.report('ERROR', 'This browser cannot open folders; install add-on files in Preferences ▸ Add-ons instead');
    return;
  }
  let dir: DirHandle;
  try {
    dir = await picker({ mode: 'read' });
  } catch (e) {
    if ((e as Error)?.name !== 'AbortError') app.report('ERROR', `Cannot open the folder: ${(e as Error).message}`);
    return;
  }
  scriptDirs.push({ name: dir.name, handle: dir });
  save();
  const n = await scanScriptDirectory(dir);
  app.report('INFO', `Script directory "${dir.name}" added${n ? `: ${n} add-on${n === 1 ? '' : 's'} installed` : ''}`);
  app.changed('ui');
}

export function removeScriptDirectory(i: number): boolean {
  if (i < 0 || i >= scriptDirs.length) return false;
  scriptDirs.splice(i, 1);
  save();
  app.changed('ui');
  return true;
}

/** Scan every script directory again. */
export async function refreshScriptDirectories(): Promise<number> {
  let n = 0;
  for (const d of scriptDirs) n += await scanScriptDirectory(d.handle).catch(() => 0);
  return n;
}
