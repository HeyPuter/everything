// Start screen, account menu and the one-time alpha notice.

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

const ALPHA_KEY = 'parametric:alpha-notice-seen';

export function showAlphaNotice() {
  let seen = false;
  try { seen = localStorage.getItem(ALPHA_KEY) === '1'; } catch { /* storage unavailable */ }
  if (seen) return;
  toast({
    kind: 'info',
    title: 'Early alpha',
    message: 'Parametric is in early development. Features may change and work could be lost, so please do not use it for production designs yet, and keep a downloaded copy of anything important.',
    timeout: 0,
    actions: [{ label: 'I understand', primary: true, run: () => {} }],
    onClose: () => { try { localStorage.setItem(ALPHA_KEY, '1'); } catch { /* ignore */ } },
  });
}

export class StartScreen {
  el: HTMLElement | null = null;

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
    const examples = h('div', { class: 'start-actions' }, EXAMPLES.map((ex) => action('part', ex.name, ex.description, () => {
      this.hide();
      app.loadDocument(ex.make(), null);
    })));
    const card = h('div', { class: 'start-card', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'start-title' },
      h('h1', { id: 'start-title' }, h('img', { src: './icon-128.png', alt: '' }), 'Parametric'),
      h('div', { class: 'sub' }, 'Feature-based 3D part modeling in your browser.'),
      h('div', { class: 'start-actions' },
        action('new', 'New part', 'Start from a blank part', () => { this.hide(); app.settings.defaultUnits = units; app.newDocument('Part1'); }),
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
    app.shell.viewport.append(this.el);
    requestAnimationFrame(() => card.querySelector<HTMLElement>('.start-action')?.focus());
    this.el.addEventListener('keydown', (e) => { if (e.key === 'Escape') { this.hide(); } });
  }

  hide() {
    this.el?.remove();
    this.el = null;
  }

  get visible() {
    return !!this.el;
  }
}

export async function doSignIn(app: App) {
  try {
    const ok = await signIn();
    if (ok) {
      toast({ kind: 'success', message: 'Signed in. Your parts will now be saved to your Puter cloud.' });
      await refreshAccount(app);
      app.loadRemoteSettings();
    }
  } catch (e) {
    toast({ kind: 'error', title: 'Sign-in failed', message: (e as Error).message });
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
