// Start screen and account menu.

import { UNIT_SYSTEMS } from '../model/units';
import type { UnitSystem } from '../model/types';
import { locationLabel, recentParts } from '../platform/files';
import { canSignOut, cloudAvailable, env, getProfilePicture, getUser, isSignedIn, puter, signIn, signOut } from '../platform/puter';
import { getThemeChoice, setThemeChoice } from '../platform/theme';
import { h } from '../ui/dom';
import { icon } from '../ui/icons';
import { dropdown, type MenuItem } from '../ui/menu';
import { toast } from '../ui/overlay';
import type { App } from './app';
import { EXAMPLES } from './examples';
import type { FileOps } from './fileops';
import { REPO_URL } from './shell';

export class StartScreen {
  el: HTMLElement | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(private app: App, private files: FileOps) {}

  show() {
    this.hide();
    const app = this.app;
    let units: UnitSystem = app.settings.defaultUnits;
    const unitSel = h('select', { class: 'input', 'aria-label': 'Units for the new part', style: { width: 'auto' } }) as HTMLSelectElement;
    for (const u of Object.values(UNIT_SYSTEMS)) {
      const o = h('option', { value: u.id }, u.label) as HTMLOptionElement;
      if (u.id === units) o.selected = true;
      unitSel.append(o);
    }
    unitSel.addEventListener('change', () => { units = unitSel.value as UnitSystem; app.settings.defaultUnits = units; app.saveSettings(); });
    const action = (ic: string, t: string, d: string, run: () => void) => {
      const b = h('button', { class: 'start-action', type: 'button' }, h('span', { style: { color: 'var(--accent)' } }, icon(ic, 24)), h('span', { class: 't' }, t), h('span', { class: 'd' }, d));
      b.addEventListener('click', run);
      return b;
    };
    const recents = recentParts().slice(0, 6);
    // The part can have changed behind the start screen (assistant, ribbon): ask before replacing it.
    const examples = h('div', { class: 'start-actions' }, EXAMPLES.map((ex) => action('part', ex.name, ex.description, async () => {
      if (!(await this.files.confirmDiscard('open an example'))) return;
      this.hide();
      app.loadDocument(ex.make(), null);
    })));
    const card = h('div', { class: 'start-card', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'start-title' },
      h('h1', { id: 'start-title' }, h('img', { src: './icon-128.png', alt: '' }), 'Parametric'),
      h('div', { class: 'sub' }, 'Feature-based 3D part modeling in your browser.'),
      h('div', { class: 'start-actions' },
        action('new', 'New part', 'Start from a blank part', async () => {
          if (!(await this.files.confirmDiscard('start a new part'))) return;
          this.hide();
          app.settings.defaultUnits = units;
          app.newDocument('Part1');
        }),
        action('open', 'Open', cloudAvailable() ? 'Open a part from your Puter cloud or this browser' : 'Open a part saved in this browser', () => { this.hide(); void this.files.open(); }),
        action('upload', 'Open from device', 'Open a part file, or a STEP or SolidWorks file', () => { this.hide(); void this.files.openFromDevice(); }),
      ),
      h('div', { class: 'row' }, h('label', { class: 'field-label' }, 'Units for new parts'), unitSel),
      recents.length ? h('div', { class: 'start-section' }, h('h2', {}, 'Recent'), h('div', { class: 'file-list' }, recents.map((r) => {
        const b = h('button', { class: 'file-item', type: 'button' }, icon(r.location.type === 'cloud' ? 'cloud' : 'device', 16),
          h('span', { class: 'txt' }, h('span', { class: 'n' }, r.name), h('span', { class: 'meta' }, locationLabel(r.location))));
        b.addEventListener('click', () => { this.hide(); void this.files.openLocation(r.location, r.name); });
        return b;
      }))) : null,
      h('div', { class: 'start-section' }, h('h2', {}, 'Examples'), examples),
      h('div', { class: 'start-foot' },
        !isSignedIn() && env() !== 'app' && puter() ? h('button', { class: 'btn small', type: 'button', onclick: () => void doSignIn(app) }, icon('signIn', 14), 'Sign in to save to the cloud') : null,
        h('span', {}, 'You can use Parametric without an account; parts are then saved in this browser.'),
        h('a', { href: REPO_URL, target: '_blank', rel: 'noopener noreferrer' }, 'Open source on GitHub')),
    );
    this.el = h('div', { class: 'start' }, card);
    // Work started elsewhere (the assistant, the ribbon) needs the graphics area.
    this.unsubscribe = app.store.on((reason) => { if (reason !== 'load') this.hide(); });
    app.shell.viewport.append(this.el);
    requestAnimationFrame(() => card.querySelector<HTMLElement>('.start-action')?.focus());
    this.el.addEventListener('keydown', (e) => { if (e.key === 'Escape') { this.hide(); } });
  }

  hide() {
    // Chosen with the keyboard: focus goes to the graphics area, not back to the page start.
    const hadFocus = !!this.el?.contains(document.activeElement);
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.el?.remove();
    this.el = null;
    if (hadFocus) this.app.viewport.canvas.focus({ preventScroll: true });
  }

  get visible() {
    return !!this.el;
  }
}

/** Signs in with Puter and updates the account button; resolves to whether it worked. */
export async function doSignIn(app: App): Promise<boolean> {
  try {
    const ok = await signIn();
    if (ok) {
      toast({ kind: 'success', message: 'Signed in. Your parts will now be saved to your Puter cloud.' });
      await refreshAccount(app);
      app.loadRemoteSettings();
    }
    return ok;
  } catch (e) {
    toast({ kind: 'error', title: 'Sign-in failed', message: (e as Error).message });
    return false;
  }
}

/** Updates the account button (profile picture or initial). */
export async function refreshAccount(app: App) {
  const btn = app.shell.account;
  btn.textContent = '';
  if (!isSignedIn() && env() !== 'app') {
    btn.append(icon('signIn', 16));
    btn.setAttribute('aria-label', 'Account: not signed in');
    return;
  }
  const [user, pic] = await Promise.all([getUser(), getProfilePicture()]);
  if (pic) btn.append(h('img', { src: pic, alt: '' }));
  else btn.append((user?.username?.[0] ?? '?').toUpperCase());
  btn.setAttribute('aria-label', `Account: ${user?.username ?? 'signed in'}`);
  btn.title = user?.username ?? '';
}

export function bindAccountMenu(app: App) {
  const btn = app.shell.account;
  btn.addEventListener('click', async () => {
    const signedIn = isSignedIn() || env() === 'app';
    const user = signedIn ? await getUser() : null;
    const theme = getThemeChoice();
    const items: MenuItem[] = [];
    if (signedIn) items.push({ group: user?.username ? `Signed in as ${user.username}` : 'Signed in' });
    else if (puter()) items.push({ label: 'Sign in with Puter', icon: 'signIn', run: () => void doSignIn(app) });
    else items.push({ group: 'Cloud storage is unavailable offline' });
    items.push(
      { separator: true },
      { group: 'Theme' },
      { label: 'System', icon: 'system', checked: theme === 'system', radio: true, run: () => setThemeChoice('system') },
      { label: 'Light', icon: 'light', checked: theme === 'light', radio: true, run: () => setThemeChoice('light') },
      { label: 'Dark', icon: 'dark', checked: theme === 'dark', radio: true, run: () => setThemeChoice('dark') },
      { separator: true },
      { label: 'Options...', icon: 'settings', run: () => app.commands.run('options') },
      { label: 'Keyboard Shortcuts', icon: 'keyboard', run: () => app.commands.run('shortcuts') },
      { label: 'Source code on GitHub', icon: 'github', run: () => window.open(REPO_URL, '_blank', 'noopener') },
    );
    if (canSignOut()) {
      items.push({ separator: true }, {
        label: 'Sign out', icon: 'signOut', run: async () => {
          await signOut();
          await refreshAccount(app);
          toast({ message: 'Signed out. New parts will be saved in this browser.' });
        },
      });
    }
    dropdown(btn, items, { label: 'Account' });
  });
}
