/**
 * Everything that touches Puter directly for identity: environment, sign-in
 * state, user and profile picture. The app works without signing in; cloud
 * files and settings sync need an account.
 */
const PIC_KEY = 'cad.profilePicture';

export function puterAvailable() {
  return typeof globalThis.puter !== 'undefined';
}

let ready = null;

/**
 * Resolves true once the Puter SDK has loaded. It loads asynchronously so a
 * slow network never blocks drawing; there is no time limit, and a failed load
 * (offline) is retried when the browser is back online.
 */
export function whenPuter() {
  if (puterAvailable()) return Promise.resolve(true);
  if (ready) return ready;
  ready = new Promise((resolve) => {
    const first = document.getElementById('puter-sdk');
    if (!first) return resolve(false);
    const watch = (script) => {
      script.addEventListener('load', () => puterAvailable() && resolve(true), { once: true });
      script.addEventListener('error', retry, { once: true });
    };
    const retry = () => {
      const again = () => {
        const s = document.createElement('script');
        s.src = first.src;
        s.async = true;
        watch(s);
        document.head.append(s);
      };
      if (navigator.onLine === false) window.addEventListener('online', again, { once: true });
      else setTimeout(again, 30000);
    };
    // The script may have failed before this module ran (see index.html).
    if (globalThis.__puterFailed) retry();
    else watch(first);
  });
  return ready;
}

export function puterEnv() {
  try {
    return globalThis.puter?.env || 'web';
  } catch {
    return 'web';
  }
}

/** Inside the Puter desktop the user is always signed in and cannot sign out. */
export function canSignOut() {
  return puterEnv() !== 'app';
}

export async function isSignedIn() {
  if (!puterAvailable()) return false;
  try {
    return (await Promise.resolve(puter.auth.isSignedIn())) === true;
  } catch {
    return false;
  }
}

/** Must be called from a user gesture (opens a popup). */
export async function signIn() {
  await puter.auth.signIn();
}

export function signOut() {
  try {
    puter.auth.signOut();
  } catch {
    /* ignore */
  }
}

export async function getUser() {
  try {
    return await puter.auth.getUser();
  } catch {
    return null;
  }
}

/** Profile picture as a data URL, cached per user so it shows instantly next time. */
export function cachedProfilePicture(username) {
  try {
    const raw = JSON.parse(localStorage.getItem(PIC_KEY) || 'null');
    return raw && raw.user === username ? raw.url : null;
  } catch {
    return null;
  }
}

export async function fetchProfilePicture(username) {
  try {
    const url = await puter.auth.getProfilePicture?.();
    if (typeof url === 'string' && url.startsWith('data:image/') && url.length < 2_000_000) {
      try {
        localStorage.setItem(PIC_KEY, JSON.stringify({ user: username, url }));
      } catch {
        /* ignore quota */
      }
      return url;
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function clearProfilePicture() {
  try {
    localStorage.removeItem(PIC_KEY);
  } catch {
    /* ignore */
  }
}
