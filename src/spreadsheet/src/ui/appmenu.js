/**
 * The account menu shared by the home screen and the editor: theme,
 * shortcuts, about, and (outside the Puter desktop) sign in or out. Inside a
 * Puter app window the desktop owns the session, so neither is offered there.
 */

import { el } from './dom.js';
import { icon } from './icons.js';
import { openMenu } from './menu.js';
import { openModal, confirmDialog } from './modal.js';
import { openShortcuts } from './shortcuts.js';
import { openOptionsDialog } from './options-dialog.js';
import { currentTheme } from './theme.js';
import { session } from '../lib/session.js';
import { toast } from './toast.js';
import * as P from '../lib/puter.js';
import { LOCALES, getLocale, formatValue, formatGeneral, formatDate, setLocale } from '../core/format.js';
import { clearAccountStorage } from '../lib/account-storage.js';
import { clearOutbox } from '../collab/outbox.js';
// Emit the full licenses as readable files alongside the production assets.
import sheetjsLicenseUrl from '../vendor/SHEETJS-LICENSE.txt?url&no-inline';
// Keep this copy of lucide/LICENSE in sync when updating Lucide.
import lucideLicenseUrl from '../vendor/LUCIDE-LICENSE.txt?url&no-inline';
import poiLicenseUrl from '../vendor/POI-LICENSE.txt?url&no-inline';
import nobleHashesLicenseUrl from '../vendor/NOBLE-HASHES-LICENSE.txt?url&no-inline';
import dotnetLicenseUrl from '../vendor/DOTNET-LICENSE.txt?url&no-inline';
import unicodeLicenseUrl from '../vendor/UNICODE-LICENSE.txt?url&no-inline';
import xmldomLicenseUrl from '../vendor/XMLDOM-LICENSE.txt?url&no-inline';
import scowlLicenseUrl from '../vendor/SCOWL-LICENSE.txt?url&no-inline';
import { version as APP_VERSION } from '../../package.json';
import { t } from '../i18n/index.js';

/** `onOptions` opens File ▸ Options from the editor, which knows the workbook; elsewhere the options open on their own. */
export function openAppMenu(anchor, { onOptions = null } = {}) {
  const theme = currentTheme();
  // Three radios in a row are a radio group, named, so a screen reader announces one choice of three
  // and not three loose radios; the menu moves between them with Left and Right as well as Up and Down.
  const themeRow = el('div.menu-theme', {},
    el('div.segmented', { role: 'radiogroup', 'aria-label': t('appmenu.appearance') },
      ...[['system', 'monitor', 'appmenu.theme.system', 'appmenu.theme.systemName'], ['light', 'sun', 'appmenu.theme.light', 'appmenu.theme.lightName'], ['dark', 'moon', 'appmenu.theme.dark', 'appmenu.theme.darkName']].map(([mode, ic, label, name]) =>
        el('button', {
          type: 'button', role: 'radio', 'aria-checked': String(theme === mode), 'aria-label': t(name),
          onclick: (e) => {
            session.setTheme(mode);
            for (const b of e.currentTarget.parentElement.children) b.setAttribute('aria-checked', String(b === e.currentTarget));
          },
        }, el('span', { html: icon(ic, 15, 2) }), t(label)))));

  // The locale is the muted detail beside the label, in the slot the shortcut hints use, rather
  // than a parenthesis nested in one; the spoken name carries both.
  const localeName = LOCALES.find(([c]) => c === getLocale())?.[1] || getLocale();
  const items = [
    { header: session.signedOut ? t('appmenu.notSignedIn') : session.username },
    { custom: themeRow },
    { separator: true },
    { label: t('appmenu.regionalFormatMenu'), icon: 'monitor', shortcut: localeName, ariaLabel: t('appmenu.regionalFormatAria', { locale: localeName }), onSelect: openLocaleDialog },
    { label: t('appmenu.options'), icon: 'options', onSelect: () => (onOptions ? onOptions() : openOptionsDialog({ accountName: () => session.user?.username || '', openLocale: openLocaleDialog })) },
    // Both open a dialog, which the ellipsis says, as it does on the same two items in the Help menu.
    { label: t('appmenu.keyboardShortcuts'), icon: 'keyboard', onSelect: openShortcuts },
    { label: t('appmenu.about'), icon: 'info', onSelect: openAbout },
  ];
  if (!P.isApp()) {
    items.push({ separator: true });
    if (session.signedOut) items.push({ label: t('appmenu.signIn'), icon: 'login', hint: t('appmenu.signInHint'), onSelect: () => session.signIn() });
    else items.push({ label: t('appmenu.signOut'), icon: 'logout', onSelect: confirmSignOut });
  }
  openMenu({ anchor, items, align: 'end', label: t('appmenu.account'), minWidth: 240 });
}

const accountButtons = new WeakMap();
const accountFaceKey = () => `${session.state}:${session.user?.uuid || ''}:${session.username}`;

/** The account button's face: a picture when available, otherwise an initial or plain figure. */
export function renderAccountButton(button) {
  const signedOut = session.signedOut;
  button.title = signedOut ? t('appmenu.notSignedIn') : session.username;
  button.setAttribute('aria-label', signedOut ? t('appmenu.accountMenuSignedOut') : t('appmenu.accountMenuFor', { name: session.username }));
  const key = accountFaceKey();
  let face = accountButtons.get(button);
  if (face?.key !== key) {
    const avatar = signedOut
      ? el('span.user-avatar.user-avatar-anon', { html: icon('user', 17, 2) })
      : el('span.user-avatar', {}, session.username.charAt(0));
    face = { key, avatar, initial: session.username.charAt(0), picture: null, request: null };
    accountButtons.set(button, face);
    button.replaceChildren(avatar);
  }
  // The header renders immediately. Only a known account asks for its own picture.
  if (!session.signedIn || !session.user) return;
  const request = P.getProfilePicture(session.user);
  if (face.request === request) return;
  face.request = request;
  const current = () => accountButtons.get(button) === face && accountFaceKey() === key;
  request.then((picture) => {
    if (!current() || face.request !== request || face.picture === picture) return;
    face.picture = picture;
    if (!picture) { face.avatar.replaceChildren(face.initial); return; }
    // Keep the current face until the image loads; malformed images retain the initial.
    // Reusing the same face on settings changes avoids repeated image loads and flicker.
    const image = el('img.user-avatar-picture', {
      alt: '', width: 32, height: 32, decoding: 'async',
      onload: () => { if (current() && face.picture === picture) face.avatar.replaceChildren(image); },
      onerror: () => { if (current() && face.picture === picture) face.avatar.replaceChildren(face.initial); },
    });
    image.src = picture;
  });
}

export async function confirmSignOut() {
  const ok = await confirmDialog({
    title: t('appmenu.signOutConfirm.title'),
    message: t('appmenu.signOutConfirm.message'),
    confirmLabel: t('appmenu.signOut'), danger: false,
  });
  if (!ok) return;
  const pending = [];
  window.dispatchEvent(new CustomEvent('app:before-signout', {
    detail: { waitUntil: (operation) => pending.push(Promise.resolve(operation)) },
  }));
  const saved = await Promise.all(pending).then((results) => results.every((result) => result !== false), () => false);
  if (!saved) {
    toast(t('appmenu.signOutNotSaved'), { icon: 'alert', duration: 5000 });
    return;
  }
  // After the save, so a draft written by it goes too, and before the sign-out, while the account's scope
  // is still the one its records are filed under.
  clearAccountStorage();
  // And the account's changes to shared workbooks that never reached their rooms (closed while offline).
  await clearOutbox(session.user?.uuid).catch(() => {});
  await P.signOut();
  location.hash = '';
  location.reload();
}

/** Pick how numbers and dates are written and read; a sample line shows the effect. */
export function openLocaleDialog() {
  const current = getLocale();
  const select = el('select.select', { 'aria-label': t('appmenu.regionalFormat') }, LOCALES.map(([code, label]) => el('option', { value: code, selected: code === current }, t('appmenu.localeOption', { label, code }))));
  const sample = el('div.numfmt-preview', { 'aria-live': 'polite' });
  const refresh = () => {
    const was = getLocale();
    setLocale(select.value);
    sample.textContent = `${formatValue(1234567.891, { fmt: 'number', dec: 2 })} · ${formatValue(0.125, { fmt: 'percent', dec: 1 })} · ${formatGeneral(3.5)} · ${formatDate(46262, 'medium')}`;
    setLocale(was);
  };
  select.addEventListener('change', refresh);
  const content = el('form', {
    onsubmit: (e) => { e.preventDefault(); modal.close(); session.setLocale(select.value); },
  },
    el('label.field', {}, el('span.field-label', {}, t('appmenu.locale.writtenIn')), el('div.select-wrap', {}, select)),
    sample,
    el('p.field-hint', {}, t('appmenu.locale.hint')),
    el('div.row.row-end', { style: { marginTop: '14px' } },
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, t('common.cancel')),
      el('button.btn.btn-primary', { type: 'submit' }, t('common.apply'))));
  const modal = openModal({ title: t('appmenu.regionalFormat'), content });
  refresh();
  return modal;
}

const COMPANY = 'Puter Technologies Inc.';

/** Puter's own pages, for the row of links under the description. */
const ABOUT_LINKS = [
  ['appmenu.links.website', 'https://puter.com'],
  ['appmenu.links.privacy', 'https://puter.com/privacy'],
  ['appmenu.links.terms', 'https://puter.com/terms'],
];

/**
 * The open-source work the app is built on, each with the license it came under. Every license is shipped
 * in full beside the app (the vendor copies are emitted as files; the fonts keep theirs in public/fonts).
 */
const ACKNOWLEDGEMENTS = [
  { name: 'SheetJS Community Edition', use: 'appmenu.credits.use.readExcel', license: 'Apache-2.0', url: sheetjsLicenseUrl },
  { name: 'xmldom', use: 'appmenu.credits.use.xml', license: 'MIT', url: xmldomLicenseUrl },
  { name: 'Apache POI', use: 'appmenu.credits.use.poi', license: 'Apache-2.0', url: poiLicenseUrl },
  { name: '.NET Runtime', use: 'appmenu.credits.use.calendar', license: 'MIT', url: dotnetLicenseUrl },
  { name: 'Unicode Character Database', use: 'appmenu.credits.use.caseless', license: 'Unicode-3.0', url: unicodeLicenseUrl },
  { name: 'noble-hashes', use: 'appmenu.credits.use.sha', license: 'MIT', url: nobleHashesLicenseUrl },
  { name: 'SCOWL and the Hunspell English dictionaries', use: 'appmenu.credits.use.spelling', license: 'MIT, BSD', url: scowlLicenseUrl },
  { name: 'Lucide and Feather', use: 'appmenu.credits.use.icons', license: 'ISC, MIT', url: lucideLicenseUrl },
  { name: 'Open Sans', use: 'appmenu.credits.use.font', license: 'Apache-2.0', url: './fonts/opensans/LICENSE.txt' },
  { name: 'Carlito', use: 'appmenu.credits.use.carlito', license: 'OFL-1.1', url: './fonts/carlito/OFL.txt' },
  { name: 'Caladea', use: 'appmenu.credits.use.caladea', license: 'Apache-2.0', url: './fonts/caladea/LICENSE.txt' },
];

export function openAbout() {
  const external = { target: '_blank', rel: 'noopener' };
  const opensNew = el('span.about-go', { html: icon('external', 13, 2), 'aria-hidden': 'true' });
  // The acknowledgements are folded away: they are there for whoever looks, not in the way of the rest.
  const credits = el('details.about-credits', {},
    el('summary.about-credits-summary', {},
      el('span', {}, t('appmenu.credits.title')),
      el('span.about-count', {}, String(ACKNOWLEDGEMENTS.length)),
      el('span.about-chevron', { html: icon('chevD', 16, 2), 'aria-hidden': 'true' })),
    el('ul.about-credits-list', {}, ACKNOWLEDGEMENTS.map(({ name, use, license, url }) =>
      el('li', {}, el('a.about-credit', { href: url, ...external, 'aria-label': t('appmenu.credits.aria', { name, use: t(use), license }) },
        el('span.about-credit-text', {},
          el('span.about-credit-name', {}, name),
          el('span.about-credit-use', {}, t(use))),
        el('span.about-license', {}, license),
        opensNew.cloneNode(true))))));
  openModal({
    // The dialog is named in full for a screen reader; on screen the app's name heads it, under its icon.
    title: t('appmenu.aboutTitle'),
    className: 'about',
    content: el('div', {},
      el('div.about-hero', { 'aria-hidden': 'true' },
        el('div.about-icon', { html: icon('brand', 80) }),
        el('p.about-name', {}, t('common.spreadsheet'))),
      el('p.about-meta', {}, t('appmenu.version', { version: APP_VERSION }), el('span.about-dot', { 'aria-hidden': 'true' }, ' · '), t('appmenu.byCompany', { company: COMPANY })),
      el('p.modal-text.about-tagline', {}, t('appmenu.tagline')),
      el('nav.about-links', { 'aria-label': 'Puter' }, ABOUT_LINKS.map(([label, href]) =>
        el('a.about-link', { href, ...external, 'aria-label': t('appmenu.opensInNewTab', { label: t(label) }) }, t(label), opensNew.cloneNode(true)))),
      credits,
      el('p.about-legal', {}, t('appmenu.copyright', { year: new Date().getFullYear(), company: COMPANY }))),
  });
}
