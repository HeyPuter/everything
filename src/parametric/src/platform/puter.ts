// Every Puter SDK call goes through this module so the app works the same
// with or without Puter (signed out, offline, or in tests).

export interface PuterFSItem {
  id?: string;
  uid?: string;
  name: string;
  path: string;
  is_dir?: boolean;
  isDir?: boolean;
  size?: number | null;
  modified?: number;
  read?: () => Promise<Blob>;
}

export interface PuterSDK {
  env?: string;
  appID?: string;
  /** Closes the app's window (inside the Puter desktop). */
  exit?(): void;
  auth: {
    isSignedIn(): boolean;
    signIn(opts?: Record<string, unknown>): Promise<unknown>;
    signOut(): Promise<void> | void;
    getUser(): Promise<{ username: string; uuid: string }>;
    getProfilePicture?(): Promise<string | null>;
  };
  fs: {
    write(path: string, data: Blob | string, opts?: Record<string, unknown>): Promise<PuterFSItem>;
    read(path: string): Promise<Blob>;
    readdir(path: string, opts?: Record<string, unknown>): Promise<PuterFSItem[]>;
    delete(path: string, opts?: Record<string, unknown>): Promise<void>;
    rename(path: string, name: string): Promise<PuterFSItem>;
    stat(path: string): Promise<PuterFSItem>;
    mkdir(path: string, opts?: Record<string, unknown>): Promise<PuterFSItem>;
  };
  kv: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<boolean>;
    del(key: string): Promise<boolean>;
  };
  ui?: {
    showOpenFilePicker?(opts?: Record<string, unknown>): Promise<PuterFSItem | PuterFSItem[]> & { undefinedOnCancel?: Promise<PuterFSItem | PuterFSItem[] | undefined> };
    showSaveFilePicker?(data?: Blob | string, name?: string): Promise<PuterFSItem> & { undefinedOnCancel?: Promise<PuterFSItem | undefined> };
    onLaunchedWithItems?(fn: (items: PuterFSItem[]) => void): void;
    wasLaunchedWithItems?(): boolean;
    setWindowTitle?(title: string): void;
    onWindowClose?(fn: () => void): void;
  };
}

declare global {
  interface Window {
    puter?: PuterSDK;
  }
}

let sdk: PuterSDK | null = null;

/** Waits briefly for the SDK script (loaded with defer) and returns it or null. */
export async function loadPuter(timeoutMs = 5000): Promise<PuterSDK | null> {
  if (sdk) return sdk;
  const start = Date.now();
  while (typeof window !== 'undefined' && !window.puter && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 40));
  }
  sdk = typeof window !== 'undefined' && window.puter ? window.puter : null;
  return sdk;
}

export const puter = () => sdk;
export function setPuterForTests(p: PuterSDK | null) {
  sdk = p;
}

/** 'app' inside the Puter desktop, 'web' on a normal website, 'none' without the SDK. */
export function env(): string {
  return sdk?.env || 'none';
}

/** Inside the Puter desktop the session belongs to the desktop: no sign-out. */
export const canSignOut = () => env() !== 'app' && isSignedIn();

export function isSignedIn(): boolean {
  try {
    return !!sdk?.auth?.isSignedIn?.();
  } catch {
    return false;
  }
}

/** Cloud storage is usable without triggering a sign-in prompt. */
export const cloudAvailable = () => !!sdk?.fs && (env() === 'app' || isSignedIn());

let pictureCache: { value: string | null; at: number } | null = null;

export async function getUser(): Promise<{ username: string } | null> {
  if (!sdk || !cloudAvailable()) return null;
  try {
    return await sdk.auth.getUser();
  } catch {
    return null;
  }
}

/** Profile picture as a data URL, or null. Cached briefly in memory only. */
export async function getProfilePicture(): Promise<string | null> {
  if (!sdk?.auth?.getProfilePicture || !cloudAvailable()) return null;
  if (pictureCache && Date.now() - pictureCache.at < (pictureCache.value ? 300_000 : 60_000)) return pictureCache.value;
  let value: string | null = null;
  try {
    const pic = await sdk.auth.getProfilePicture();
    value = typeof pic === 'string' && pic.startsWith('data:image/') && pic.length < 2_000_000 ? pic : null;
  } catch {
    value = null;
  }
  pictureCache = { value, at: Date.now() };
  return value;
}

export async function signIn(): Promise<boolean> {
  if (!sdk) throw new Error('Puter is not available right now. Check your connection and try again.');
  pictureCache = null;
  try {
    await sdk.auth.signIn();
  } catch (e) {
    const code = (e as { error?: string })?.error;
    if (code === 'auth_window_closed') return false;
    if (code === 'popup_blocked') throw new Error('The sign-in window was blocked. Allow pop-ups for this site and try again.');
    throw e;
  }
  return isSignedIn();
}

export async function signOut(): Promise<void> {
  if (!sdk) return;
  pictureCache = null;
  await sdk.auth.signOut();
}

/** True when an error from puter.fs means the path does not exist. */
export function isMissing(err: unknown): boolean {
  const e = err as { code?: string; error?: { code?: string }; message?: string; status?: number; name?: string };
  const code = e?.code || e?.error?.code || e?.message || '';
  // NotFoundError: a file missing from browser storage (OPFS).
  return /subject_does_not_exist|not_found|does not exist|404/i.test(String(code)) || e?.status === 404 || e?.name === 'NotFoundError';
}

/** Human readable error text for storage failures. */
export function storageError(err: unknown): string {
  const e = err as { code?: string; message?: string; status?: number; name?: string };
  if (e?.code === 'storage_limit_reached' || e?.status === 413) return 'Your Puter storage is full. Free up space or upgrade your plan, then save again.';
  if (e?.status === 429 || e?.code === 'too_many_requests') return 'Too many requests right now. Wait a moment and try again.';
  // fetch() failures: Chrome, Firefox and Safari wording.
  if (err instanceof TypeError && /failed to fetch|networkerror|load failed/i.test(e.message ?? '')) return 'Puter could not be reached. Check your connection and try again.';
  if (e?.name === 'QuotaExceededError') return 'This browser has run out of storage space for parts. Delete parts you no longer need, download this one, or sign in to save it to your Puter cloud.';
  return e?.message || 'Something went wrong while talking to Puter.';
}

/** Puter timestamps are Unix seconds; normalise to milliseconds. */
export const toMs = (t?: number) => (!t ? 0 : t < 1e12 ? t * 1000 : t);

// Settings live in one small KV entry read on load and written on change:
// never one key per setting, to keep reads and writes minimal.
export const KV_SETTINGS_KEY = 'parametric:settings:v1';

export async function kvGet<T>(key: string): Promise<T | undefined> {
  if (!sdk?.kv || !cloudAvailable()) return undefined;
  try {
    const v = await sdk.kv.get(key);
    return (v ?? undefined) as T | undefined;
  } catch {
    return undefined;
  }
}

export async function kvSet(key: string, value: unknown): Promise<boolean> {
  if (!sdk?.kv || !cloudAvailable()) return false;
  try {
    await sdk.kv.set(key, value);
    return true;
  } catch {
    return false;
  }
}
