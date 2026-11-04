/**
 * Per-session state that is not part of any document: whether anyone is
 * signed in to Puter, who, and the small settings record (theme, regional
 * format). Views subscribe to 'change' to re-render the pieces that show these.
 *
 * Nobody has to sign in to work: the grid runs in the browser and Puter is
 * where files are saved, so a sign-in is asked for at the first action that
 * needs the cloud (saving, opening a file, listing the spreadsheets). Until
 * init() has asked the SDK the state is 'unknown' and nothing is gated.
 * Settings live in puter.kv for an account and in this browser otherwise, which
 * also keeps a copy of the account's for a boot that cannot reach the store;
 * choices made before signing in carry over to the account.
 */

import { applyTheme } from '../ui/theme.js';
import { setLocale } from '../core/format.js';
import * as P from './puter.js';
import { t } from '../i18n/index.js';
import { setStorageUser, setGuestStorage, storageScope, adoptGuestStorage, adoptStorageFrom, isAccountScope } from './account-storage.js';

// A failed identity look-up is asked again after this long, then at doubling intervals, up to the cap.
const IDENTITY_RETRY_MS = 2000;
const IDENTITY_RETRY_MAX_MS = 5 * 60_000;

class Session extends EventTarget {
  constructor() {
    super();
    this.settings = { theme: 'system' };
    this.user = null;
    /** 'unknown' before the SDK was asked; then 'in' or 'out'. */
    this.state = 'unknown';
    this._signingIn = null;
    this._localChanges = {}; // preferences chosen without the account's record at hand (no session, or a store unreachable at boot), to lay over it
    this._settingsLoaded = false; // has the account's record been read? Until then the settings are this browser's copy of it (see _adoptAccountSettings)
  }

  async init() {
    await this.refresh();
  }

  /** Ask the SDK who is signed in (nobody, possibly), load their settings, and tell the views. */
  async refresh() {
    clearTimeout(this._identityTimer);
    const signedIn = await P.isSignedIn();
    if (signedIn) {
      const [stored, user] = await Promise.all([P.loadSettings(), P.getUser()]);
      this.user = user;
      // Work done before signing in (unsaved sheets, say) follows into the account. When the
      // identity lookup failed the scope is a throwaway one, so the guest records stay put for a
      // sign-in that does resolve to an account.
      const wasGuest = storageScope() === 'guest';
      setStorageUser(user);
      if (wasGuest && isAccountScope(storageScope())) adoptGuestStorage();
      if (!user) this._retryIdentity();
      this._adoptAccountSettings(stored);
    } else {
      this.user = null;
      this._settingsLoaded = false;
      setGuestStorage();
      this._adoptSettings(P.loadLocalSettings());
    }
    this.state = signedIn ? 'in' : 'out';
    this._emit();
  }

  _adoptSettings(settings) {
    const before = this.settings.locale || 'en-US';
    this.settings = settings;
    applyTheme(settings.theme || 'system');
    setLocale(settings.locale || 'en-US');
    // A regional format that arrives mid-session (the account's record, read late) redraws the sheet as a chosen one does.
    if ((settings.locale || 'en-US') !== before && typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('app:locale', { detail: { locale: settings.locale || 'en-US' } }));
  }

  /**
   * The account's record, as read: the truth, and this browser keeps a copy of it for a boot that
   * cannot reach the store. Not readable (offline, a flaky connection), the copy last read stands in,
   * so the theme and regional format stay what they were, and nothing derived from it is written back:
   * a record of the defaults would erase the preferences the account keeps. Choices made before the
   * record was at hand are laid over it and, once it is, persisted with it.
   */
  _adoptAccountSettings(stored) {
    this._settingsLoaded = !!stored;
    if (stored) P.saveLocalSettings(stored);
    this._adoptSettings({ ...(stored ?? P.loadLocalSettings()), ...this._localChanges });
    if (stored && Object.keys(this._localChanges).length) {
      const carried = this._localChanges;
      this._localChanges = {};
      this._persist(carried);
    }
  }

  /** Signed in, but the record was not readable at boot: ask again, once at a time, and adopt it when it is. */
  _readAccountSettings() {
    this._settingsRead ??= P.loadSettings().then((stored) => {
      if (stored && this.state !== 'out' && !this._settingsLoaded) { this._adoptAccountSettings(stored); this._emit(); }
      return this._settingsWrite;
    }).finally(() => { this._settingsRead = null; });
    return this._settingsRead;
  }

  /**
   * Signed in, but the look-up of who failed (a flaky connection at boot): local records
   * are being kept under a throwaway scope meanwhile, where a reload could not find them.
   * Keep asking, with growing pauses, and once the account is known move them into it, the
   * way a guest's records follow a sign-in. After the cap the next refresh (a sign-in, a
   * reload) asks again.
   */
  _retryIdentity(delay = IDENTITY_RETRY_MS) {
    clearTimeout(this._identityTimer);
    if (delay > IDENTITY_RETRY_MAX_MS) return;
    this._identityTimer = setTimeout(async () => {
      if (this.state !== 'in' || this.user) return;
      const user = await P.getUser();
      if (this.state !== 'in' || this.user) return;
      if (!user) { this._retryIdentity(delay * 2); return; }
      const from = storageScope();
      this.user = user;
      setStorageUser(user);
      if (isAccountScope(storageScope())) adoptStorageFrom(from);
      this._emit();
    }, delay);
  }

  /** The SDK signed the user in on its own (before an AI request, say). */
  signedInAs(user) {
    if (this.state === 'in') return;
    this.refresh().catch(() => {
      this.user = user || this.user;
      this.state = 'in';
      this._emit();
    });
  }

  get signedIn() {
    return this.state === 'in';
  }

  /** Known to have no Puter session: cloud actions ask for a sign-in first. */
  get signedOut() {
    return this.state === 'out';
  }

  /**
   * Open Puter's sign-in dialog. Resolves true once signed in, false when the
   * dialog was dismissed. Concurrent callers share one dialog.
   */
  signIn() {
    if (this.state === 'in') return Promise.resolve(true);
    if (!this._signingIn) {
      this._signingIn = (async () => {
        try { await P.signIn(); } catch { return false; }
        await this.refresh();
        return this.state === 'in';
      })().finally(() => { this._signingIn = null; });
    }
    return this._signingIn;
  }

  /** Regional format: how numbers and dates are shown and read (en-US, de-DE, ...). */
  async setLocale(code) {
    setLocale(code);
    window.dispatchEvent(new CustomEvent('app:locale', { detail: { locale: code } }));
    await this.update({ locale: code });
  }

  /** The name to show. */
  get username() {
    return this.user?.username || (this.state === 'out' ? t('session.guest') : t('session.puterUser'));
  }

  async update(patch) {
    // Merge immediately so a second preference change sees the first one.
    const next = this.settings = { ...this.settings, ...patch };
    this._emit();
    if (this.state === 'out' || !this._settingsLoaded) {
      // No account record to lay the choice over yet (no session, or the store could not be reached at
      // boot): this browser keeps it, and it moves into the account once the record is read.
      this._localChanges = { ...this._localChanges, ...patch };
      P.saveLocalSettings(next);
      if (this.state !== 'out') await this._readAccountSettings();
      return;
    }
    await this._persist(patch);
  }

  /** Serialize writes so a slower request cannot persist an older choice last; this browser's copy follows each. */
  _persist(patch) {
    const next = { ...this.settings, ...patch };
    this._settingsWrite = (this._settingsWrite || Promise.resolve()).catch(() => {}).then(() => P.saveSettings({}, next)).then(() => P.saveLocalSettings(next));
    return this._settingsWrite;
  }

  async setTheme(mode) {
    applyTheme(mode);
    await this.update({ theme: mode });
  }

  _emit() {
    this.dispatchEvent(new CustomEvent('change'));
  }
}

export const session = new Session();
