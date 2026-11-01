/**
 * Puter Cloud Authentication and User Profile service.
 */

export class AuthService {
  constructor() {
    this.user = null;
    this.signedIn = false;
    this.listeners = new Set();
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  notify() {
    for (const fn of this.listeners) {
      try {
        fn(this);
      } catch (e) {
        console.error(e);
      }
    }
  }

  async checkAuth() {
    if (typeof puter === 'undefined' || !puter.auth) {
      this.signedIn = false;
      this.user = null;
      this.notify();
      return;
    }

    try {
      this.signedIn = await Promise.resolve(puter.auth.isSignedIn());
      if (this.signedIn) {
        this.user = await Promise.resolve(puter.auth.getUser());
      } else {
        this.user = null;
      }
    } catch {
      this.signedIn = false;
      this.user = null;
    }

    this.notify();
  }

  async signIn() {
    if (typeof puter === 'undefined' || !puter.auth) return;
    try {
      await puter.auth.signIn();
      await this.checkAuth();
    } catch (e) {
      console.warn('Sign-in cancelled or failed:', e);
    }
  }

  async signOut() {
    if (typeof puter === 'undefined' || !puter.auth) return;
    try {
      await puter.auth.signOut();
      this.signedIn = false;
      this.user = null;
      this.notify();
    } catch (e) {
      console.warn('Sign-out failed:', e);
    }
  }

  async openDownloadsInPuter() {
    if (typeof puter !== 'undefined' && puter.ui && puter.ui.showInFiles) {
      try {
        await puter.ui.showInFiles('/Downloads');
        return true;
      } catch {}
    }
    return false;
  }
}

export const auth = new AuthService();
