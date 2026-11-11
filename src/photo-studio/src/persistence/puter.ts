interface FSItem {
  path: string;
  name: string;
  read(): Promise<Blob>;
}
interface Puter {
  env: string;
  auth: {
    isSignedIn(): boolean;
    signIn(): Promise<unknown>;
    signOut(): void;
    getUser(): Promise<{ username: string }>;
  };
  fs: {
    write(path: string, data: Blob, options?: { createMissingParents?: boolean }): Promise<FSItem>;
    read(path: string): Promise<Blob>;
  };
  ui: {
    showOpenFilePicker(options: { accept: string; multiple: boolean }): Promise<FSItem>;
    showSaveFilePicker(content: Blob, name: string): Promise<FSItem>;
  };
}
declare global {
  interface Window {
    puter?: Puter;
  }
}
export function puter(): Puter {
  if (!window.puter)
    throw new Error('Puter is unavailable. Check your connection, or save a local project.');
  return window.puter;
}
// What features keep about the signed-in account (the comment author, the
// libraries' sync state) is dropped when the account signs out.
const signOutListeners = new Set<() => void>();
export function onSignOut(fn: () => void) {
  signOutListeners.add(fn);
}
/** Called by the account controls after signing out. */
export function signedOut() {
  for (const fn of signOutListeners)
    try {
      fn();
    } catch {
      /* One feature does not stop the others. */
    }
}
export function canSignOut(env: string) {
  return env !== 'app';
}
export class PuterStorage {
  path?: string;
  private generation = 0;
  async save(blob: Blob, name: string) {
    const p = puter(),
      generation = this.generation;
    const item = this.path
      ? await p.fs.write(this.path, blob)
      : await p.ui.showSaveFilePicker(blob, `${name}.photo`);
    if (generation === this.generation) this.path = item.path;
    return item;
  }
  async open() {
    const item = await puter().ui.showOpenFilePicker({
      accept: '.photo,.psd,.psb,image/*',
      multiple: false,
    });
    return { blob: await item.read(), name: item.name, path: item.path };
  }
  reset() {
    this.generation++;
    this.path = undefined;
  }
}
// Preferences → File Handling → Append file extension (set by the editor).
export const fileNaming = { extensionCase: 'lower' as 'lower' | 'upper' };
/** A file name with its extension in the preferred case. */
export function preferredFileName(name: string) {
  const m = /^(.*\.)([A-Za-z0-9]{1,8})$/.exec(name);
  if (!m) return name;
  return m[1] + (fileNaming.extensionCase === 'upper' ? m[2].toUpperCase() : m[2].toLowerCase());
}
export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob),
    a = document.createElement('a');
  a.href = url;
  a.download = preferredFileName(name);
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
