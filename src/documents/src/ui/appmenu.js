/**
 * The account menu shared by the home screen and the editor: theme,
 * shortcuts, about, and (outside the Puter desktop) sign in or out. Inside a
 * Puter app window the desktop owns the session, so neither is offered there.
 */

import { el } from './dom.js';
import { icon } from './icons.js';
import { openMenu } from './menu.js';
import { openModal, confirmDialog } from './modal.js';
import { toast } from './toast.js';
import { openShortcuts } from './shortcuts.js';
import { segmented } from './segmented.js';
import { currentTheme, isDark, darkPage, setDarkPage } from './theme.js';
import { UNITS, recallUnit, rememberUnit, unitLabel } from '../lib/units.js';
import { autocorrectEnabled, setAutocorrectEnabled, capitalizeSentencesEnabled, setCapitalizeSentencesEnabled } from '../lib/autocorrect.js';
import { autolinkEnabled, setAutolinkEnabled } from '../lib/linkify.js';
import { session } from '../lib/session.js';
import * as P from '../lib/puter.js';

export function openAppMenu(anchor, { extraItems = [] } = {}) {
  let opened = null;
  // One radio group, like the dialogs' choices: Left and Right move between the themes.
  const themeRow = el('div.menu-theme', {},
    segmented([['system', 'monitor', 'System'], ['light', 'sun', 'Light'], ['dark', 'moon', 'Dark']]
      .map(([mode, ic, label]) => [mode, [el('span', { html: icon(ic, 15, 2) }), label]]),
    currentTheme(), (mode) => {
      session.setTheme(mode);
      // The dark page option follows the theme picked here without reopening the menu.
      darkPageItem.disabled = !isDark();
      const button = [...(opened?.menu?.querySelectorAll('.menu-item') || [])].find((node) => node.querySelector('.menu-label')?.firstChild?.textContent === darkPageItem.label);
      if (button) button.disabled = darkPageItem.disabled;
    }, 'Appearance'));
  const darkPageItem = { label: 'Dark page', icon: 'brand', checked: darkPage(), disabled: !isDark(), hint: 'Dark paper with the dark theme', onSelect: () => setDarkPage(!darkPage()) };

  const items = [
    { header: session.signedOut ? 'Not signed in' : session.username },
    { custom: themeRow },
    darkPageItem,
    { separator: true },
    ...extraItems,
    { label: 'Measurement units', icon: 'ruler', hint: unitLabel(recallUnit()), onSelect: () => openUnitsMenu(anchor) },
    { label: 'Autocorrect as you type', checked: autocorrectEnabled(), hint: 'Smart quotes, dashes, ellipses, symbols, fractions', onSelect: () => setAutocorrectEnabled(!autocorrectEnabled()) },
    { label: 'Capitalize the first letter of sentences', checked: capitalizeSentencesEnabled(), onSelect: () => setCapitalizeSentencesEnabled(!capitalizeSentencesEnabled()) },
    { label: 'Link web addresses as you type', checked: autolinkEnabled(), hint: 'URLs and emails become links on space or return', onSelect: () => setAutolinkEnabled(!autolinkEnabled()) },
    { label: 'Keyboard shortcuts', icon: 'keyboard', onSelect: openShortcuts },
    { label: 'About Documents', icon: 'info', onSelect: openAbout },
  ];
  if (!P.isApp()) {
    items.push({ separator: true });
    if (session.signedOut) items.push({ label: 'Sign in to Puter', icon: 'login', hint: 'Save documents to your own cloud', onSelect: () => session.signIn() });
    else items.push({ label: 'Sign out', icon: 'logout', onSelect: confirmSignOut });
  }
  opened = openMenu({ anchor, items: items.filter(Boolean), align: 'end', label: 'Account', minWidth: 250 });
}

const accountFaces = new WeakMap();

/** Keep the initial visible until an optional profile picture has actually loaded. */
export function renderAccountButton(button) {
  const signedOut = session.signedOut;
  button.title = signedOut ? 'Not signed in' : session.username;
  button.setAttribute('aria-label', signedOut ? 'Account menu. Not signed in' : `Account menu for ${session.username}`);
  const id = session.accountId;
  const key = `${session.state}:${id}:${session.username}`;
  let face = accountFaces.get(button);
  if (face?.key !== key || button.firstElementChild !== face.avatar) {
    face = { key, avatar: signedOut
      ? el('span.user-avatar.user-avatar-anon', { html: icon('user', 17, 2), 'aria-hidden': 'true' })
      : el('span.user-avatar', { 'aria-hidden': 'true' }, session.username.charAt(0)) };
    accountFaces.set(button, face);
    button.replaceChildren(face.avatar);
  }
  if (!id) return;
  const current = () => accountFaces.get(button) === face && button.firstElementChild === face.avatar && session.accountId === id && button.isConnected;
  session.getProfilePicture().then((picture) => {
    if (!current() || face.picture === picture) return;
    face.picture = picture;
    const initial = session.username.charAt(0);
    if (!picture) { face.avatar.replaceChildren(initial); return; }
    const image = el('img', { alt: '', width: 32, height: 32, decoding: 'async', draggable: false,
      onload: () => { if (current() && face.picture === picture) face.avatar.replaceChildren(image); },
      onerror: () => { if (current() && face.picture === picture) face.avatar.replaceChildren(initial); },
    });
    image.src = picture;
  });
}

/** Inches or centimeters, for the ruler and every dialog that measures. */
export function openUnitsMenu(anchor) {
  const current = recallUnit();
  openMenu({
    anchor, align: 'end', label: 'Measurement units', minWidth: 220,
    items: [
      { header: 'Measurement units' },
      ...UNITS.map((u) => ({ label: u.label, radio: true, checked: current === u.id, onSelect: () => rememberUnit(u.id) })),
      { separator: true },
      { note: 'Used by the ruler, page setup, indentation, and tables' },
    ],
  });
}

export async function confirmSignOut() {
  const ok = await confirmDialog({
    title: 'Sign out?',
    message: 'Your documents stay in your Puter account. Any unsaved change in an open document is saved first.',
    confirmLabel: 'Sign out', danger: false,
  });
  if (!ok) return;
  const pending = [];
  window.dispatchEvent(new CustomEvent('app:before-signout', {
    detail: { waitUntil: (promise) => pending.push(Promise.resolve(promise)) },
  }));
  try {
    // Signing out would lose what the open document could not save: stay, and say why.
    if ((await Promise.all(pending)).some((saved) => saved === false)) {
      toast('The open document could not be saved, so you are still signed in. Save or download it first', { icon: 'alert', duration: 8000 });
      return;
    }
    await P.signOut();
    location.hash = '';
    location.reload();
  } catch (e) {
    toast(e?.message || 'Could not sign out. Please try again', { icon: 'alert', duration: 8000 });
  }
}

export function openAbout() {
  openModal({
    title: 'Documents',
    content: el('div', {},
      el('p.modal-text', {}, 'A private word processor with an original canvas editor. Files are saved as .docx in your own Puter cloud.'),
      el('p.modal-text', {}, 'This version supports text and paragraph formatting, selection, undo, and DOCX downloads. Advanced document features are not supported yet.'),
      el('p.small.muted', {}, 'Built with vanilla JavaScript, Vite, Lucide icons, fflate, Noto Sans, and ',
        el('a', { href: 'https://developer.puter.com', target: '_blank', rel: 'noopener' }, 'Puter'), '.'),
      el('p.small.muted', {}, el('a', { href: `${import.meta.env.BASE_URL}licenses/THIRD_PARTY.txt`, target: '_blank', rel: 'noopener' }, 'Third-party licenses')),
      el('p.small.muted', { lang: 'ko' }, '본 제품은 한글과컴퓨터의 한글 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.')),
  });
}
