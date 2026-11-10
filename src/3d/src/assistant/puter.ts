// The Puter SDK. index.html loads it with the page (deferred), so the top bar can show
// puter.js's account menu (src/ui/usermenu.ts); the rest of the app works without Puter, offline
// included, so a load that failed is not an error. The assistant loads it again here the first
// time it needs it, and says so (PUTER_LOADED) for the top bar.

const SDK_URL = 'https://js.puter.com/v2/';

interface PuterSDK {
  env?: string;
  auth?: { isSignedIn(): boolean; signIn(opts?: Record<string, unknown>): Promise<unknown> };
  ai?: { chat: (messages: unknown, opts?: Record<string, unknown>) => Promise<unknown> };
}

const sdk = () => (globalThis as unknown as { puter?: PuterSDK }).puter ?? null;
/** Fired on window when the SDK arrived after the page had started without it. */
export const PUTER_LOADED = 'puter-loaded';
let loading: Promise<PuterSDK | null> | null = null;

/** The SDK, loading it once; null when it cannot be reached. */
export function loadPuter(timeoutMs = 15000): Promise<PuterSDK | null> {
  if (sdk()) return Promise.resolve(sdk());
  if (loading) return loading;
  loading = new Promise<PuterSDK | null>((resolve) => {
    if (typeof document === 'undefined') return resolve(null);
    const done = () => {
      clearTimeout(timer);
      resolve(sdk());
      if (!sdk()) loading = null;
      else if (typeof dispatchEvent === 'function') dispatchEvent(new Event(PUTER_LOADED));
    };
    const timer = setTimeout(done, timeoutMs);
    const s = document.createElement('script');
    s.src = SDK_URL;
    s.async = true;
    s.onload = done;
    s.onerror = () => {
      s.remove();
      done();
    };
    document.head.append(s);
  });
  return loading;
}

/** Inside the Puter desktop the session belongs to the desktop. */
export const inPuterDesktop = () => sdk()?.env === 'app';

export function isSignedIn(): boolean {
  try {
    return inPuterDesktop() || !!sdk()?.auth?.isSignedIn?.();
  } catch {
    return false;
  }
}

/** Opens Puter's sign-in window (call from a click). Resolves whether the user is now signed in. */
export async function signIn(): Promise<boolean> {
  const p = sdk();
  if (!p?.auth) throw new Error('Puter is not available right now. Check your connection and try again.');
  try {
    await p.auth.signIn();
  } catch (e) {
    const code = (e as { error?: string })?.error;
    if (code === 'auth_window_closed') return false;
    if (code === 'popup_blocked') throw new Error('The sign-in window was blocked. Allow pop-ups for this site and try again.');
    throw e;
  }
  return isSignedIn();
}
