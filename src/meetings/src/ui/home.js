import { el, clear } from './dom.js';
import { icon } from './icons.js';
import { toast } from './toast.js';
import { toggleTheme, effectiveTheme } from './theme.js';
import { extractCode, buildMeetingURL } from '../lib/codes.js';
import { mintRoomCode } from '../lib/rooms.js';
import { copyText } from './panels.js';
import { formatClock, formatDay } from '../lib/time.js';
import { accountAvatar, loadAccountAvatar } from './account-avatar.js';
import { hasPuter } from '../lib/env.js';
import { mountAgenda } from './agenda.js';
import { clearAgendaCaches } from '../lib/agenda.js';
import { brandLockup } from './brand.js';
import { openHomeSettings } from './nickname.js';
import { userMenu } from './user-menu.js';

/**
 * Home screen: start or join a meeting.
 * @param {HTMLElement} root
 * @param {object} ctx  app context (openPrejoin, getUserName, ...)
 * @returns {() => void} cleanup
 */
export function mountHome(root, ctx) {
  clear(root);

  let mounted = true; // false once the view unmounts (async work may outlive it)

  // The signed-in user, fetched once per sign-in state: the header and the
  // meetings panel both want it, and /whoami is a network call.
  let userPromise = null;
  const currentUser = () => (userPromise ??= fetchUser());
  const forgetUser = () => {
    userPromise = null;
  };

  const clock = el('span', { class: 'home-clock' }, clockText());
  const themeBtn = el(
    'button',
    { class: 'icon-btn', 'aria-label': 'Toggle theme', title: 'Toggle light/dark theme', onclick: onThemeToggle },
    icon(effectiveTheme() === 'dark' ? 'sun' : 'moon')
  );

  const userSlot = el('div', { class: 'home-user' });
  // puter.js's <puter-user-menu> where the SDK has it (src/ui/user-menu.js):
  // made once, since it loads the account each time it joins the page.
  const accountMenu = userMenu({ onSignOut: signOut, onSignIn: onSignedIn, onSignedOut });
  let closeSettings = null;
  const settingsBtn = el('button', {
    class: 'icon-btn', 'aria-label': 'Settings', title: 'Settings',
    onclick: () => {
      closeSettings?.();
      closeSettings = openHomeSettings(root, ctx, settingsBtn);
    },
  }, icon('settings'));

  const joinInput = el('input', {
    type: 'text',
    placeholder: 'Enter a code or link',
    'aria-label': 'Meeting code or link',
    autocomplete: 'off',
    autocorrect: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
    onkeydown: (e) => {
      if (e.key === 'Enter') onJoin();
    },
    oninput: () => {
      joinBtn.disabled = !joinInput.value.trim();
    },
  });
  const joinBtn = el('button', { class: 'btn home-join-btn', disabled: true, onclick: onJoin }, 'Join');
  const newMeetingLabel = el('span', {}, 'New meeting');
  const newMeetingBtn = el(
    'button',
    { class: 'btn btn-primary', 'aria-haspopup': 'menu', 'aria-expanded': 'false', onclick: toggleNewMenu },
    icon('videoCall'),
    newMeetingLabel
  );

  const view = el(
    'div',
    { class: 'home' },
    el(
      'header',
      { class: 'home-header' },
      brandLockup(),
      el('div', { class: 'home-header-actions' }, clock, settingsBtn, themeBtn, userSlot)
    ),
    el(
      'main',
      { class: 'home-main' },
      el(
        'section',
        { class: 'home-hero' },
        el('h1', {}, 'Video meetings, ', el('span', { class: 'home-hero-accent' }, 'right in your browser.')),
        el('p', { class: 'home-lede' }, 'Start a call in seconds, or create a link to share for later. It all runs in your browser.'),
        el(
          'div',
          { class: 'home-actions' },
          el('div', { class: 'home-new' }, newMeetingBtn),
          el('div', { class: 'home-join' }, el('div', { class: 'text-field' }, icon('keyboard'), joinInput, joinBtn))
        ),
        el(
          'ul',
          { class: 'home-features' },
          feature('Nothing to install'),
          feature('Links never expire'),
          feature('No account needed to join')
        ),
        hasPuter() && !ctx.calendar?.supported()
          ? el(
              'p',
              { class: 'home-art-hint' },
              icon('calendar'),
              'Open Meetings from your Puter desktop to see the day’s meetings from Calendar here.'
            )
          : null
      ),
      // Inside the Puter desktop the day's meetings from the Calendar app
      // sit beside the hero, each one click from joining. On the open web
      // there is no Calendar to ask (see lib/calendar.js), so the hero stands
      // alone — with a line saying where the list lives.
      ctx.calendar?.supported() ? el('aside', { class: 'home-agenda' }) : null
    )
  );

  root.append(view);
  renderUser();

  let unmountAgenda = null;
  const agendaHost = view.querySelector('.home-agenda');
  mountAgendaPanel();

  /**
   * The meetings panel is scoped to the signed-in account — its snapshot is
   * keyed by it, and what it shows is theirs. So it is mounted afresh when
   * the account changes: the one that was there would otherwise keep
   * showing the last account's meetings, and write its next answer under
   * that account's key.
   */
  function mountAgendaPanel() {
    unmountAgenda?.();
    unmountAgenda = null;
    if (!agendaHost) return;
    unmountAgenda = mountAgenda(agendaHost, {
      calendar: ctx.calendar,
      ctx,
      // Scopes the panel's local snapshot to this account, so a shared
      // device never paints one person's meetings for the next.
      userKey: currentUser().then((user) => user?.uuid ?? user?.id ?? user?.username ?? ''),
      openCalendar: () => {
        try {
          void window.puter.ui.launchApp({ name: 'calendar' });
        } catch {
          toast('Could not open Calendar.', { icon: 'info' });
        }
      },
    });
  }

  const clockTimer = setInterval(() => {
    clock.textContent = clockText();
  }, 10_000);

  function clockText() {
    const now = new Date();
    return `${formatClock(now)} • ${formatDay(now)}`;
  }

  function onThemeToggle() {
    const next = toggleTheme();
    clear(themeBtn).append(icon(next === 'dark' ? 'sun' : 'moon'));
  }

  let newMenu = null;
  let menuDismissTimer = null;

  function toggleNewMenu() {
    if (newMenu) {
      closeNewMenu();
      return;
    }
    newMenu = el(
      'div',
      { class: 'menu home-new-menu', role: 'menu' },
      menuItem('videoCall', 'Start an instant meeting', () => {
        closeNewMenu();
        newMeetingBtn.focus();
        void onStartInstant();
      }),
      menuItem('link', 'Create a meeting for later', () => {
        closeNewMenu();
        // Removing the focused menu item drops focus to <body>; return it to
        // the trigger while creation runs (the dialog takes focus when ready).
        newMeetingBtn.focus();
        onCreateForLater();
      })
    );
    newMeetingBtn.parentElement.append(newMenu);
    newMeetingBtn.setAttribute('aria-expanded', 'true');
    newMenu.querySelector('.menu-item')?.focus();
    document.addEventListener('keydown', onMenuKeydown);
    // Dismiss on any click outside the menu. Registration is deferred past
    // the opening click; closeNewMenu cancels it if the menu closes first
    // (e.g. via Escape), so no stale listener survives to kill the next open.
    menuDismissTimer = setTimeout(() => document.addEventListener('click', onDocClick), 0);
  }

  function onDocClick(e) {
    if (newMenu && !newMenu.contains(e.target)) closeNewMenu();
  }

  function onMenuKeydown(e) {
    if (!newMenu) return;
    if (e.key === 'Escape') {
      closeNewMenu();
      newMeetingBtn.focus();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const items = [...newMenu.querySelectorAll('.menu-item')];
      const step = e.key === 'ArrowDown' ? 1 : -1;
      const next = (items.indexOf(document.activeElement) + step + items.length) % items.length;
      items[next]?.focus();
    } else if (e.key === 'Tab') {
      // Hand focus back to the trigger so the default Tab lands on the
      // control after (or before) it, not on document.body.
      closeNewMenu();
      newMeetingBtn.focus();
    }
  }

  function closeNewMenu() {
    clearTimeout(menuDismissTimer);
    document.removeEventListener('click', onDocClick);
    document.removeEventListener('keydown', onMenuKeydown);
    newMeetingBtn.setAttribute('aria-expanded', 'false');
    newMenu?.remove();
    newMenu = null;
  }

  function menuItem(name, label, onclick) {
    return el('button', { class: 'menu-item', role: 'menuitem', onclick }, icon(name), label);
  }

  let starting = false; // an instant meeting is on its way

  /**
   * Straight into a meeting when the app already knows who this is
   * (src/main.js startInstantMeeting); otherwise the pre-join screen, which
   * replaces this view at once. Starting can take a moment — a permission
   * prompt, the room's entry being written — so the button says so, and
   * takes no second click meanwhile.
   */
  async function onStartInstant() {
    if (starting) return;
    starting = true;
    newMeetingBtn.disabled = true;
    newMeetingLabel.textContent = 'Starting…';
    try {
      await ctx.startInstantMeeting();
    } finally {
      starting = false;
      newMeetingBtn.disabled = false;
      newMeetingLabel.textContent = 'New meeting';
    }
  }

  let closeLinkDialog = null; // active meeting-link dialog's close(), if open

  /**
   * Mint a room code now. Nothing is created anywhere — a room exists from
   * the moment someone with the link starts a meeting on it (lib/rooms.js)
   * — so this needs no account and no network, and can never fail.
   */
  function onCreateForLater() {
    showMeetingLinkDialog(mintRoomCode());
  }

  function showMeetingLinkDialog(code) {
    const url = buildMeetingURL(code);
    const close = () => {
      window.removeEventListener('keydown', onDialogKeydown);
      closeLinkDialog = null;
      backdrop.remove();
      if (newMeetingBtn.isConnected) newMeetingBtn.focus();
    };
    const onDialogKeydown = (e) => {
      if (e.key === 'Escape') {
        close();
      } else if (e.key === 'Tab') {
        // aria-modal promises focus stays inside — enforce it by wrapping
        // at the edges (and pulling focus in from the container itself).
        const focusables = [...dialog.querySelectorAll('button')];
        if (!focusables.length) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const current = document.activeElement;
        const inside = dialog.contains(current) && current !== dialog;
        if (e.shiftKey && (!inside || current === first)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (!inside || current === last)) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    const dialog = el(
      'div',
      { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Meeting link', tabindex: '-1' },
      el(
        'div',
        { class: 'dialog-header' },
        el('h2', {}, 'Here’s your meeting link'),
        el('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: close }, icon('close'))
      ),
      el(
        'div',
        { class: 'dialog-body' },
        el(
          'p',
          { class: 'home-link-note' },
          'Send this link to people you want to meet with, or drop it in a calendar invite. It never expires. When it’s time, open it to start the meeting — you, or anyone else holding the link, can. Guests who arrive early wait until someone does.'
        ),
        el('div', { class: 'info-link-box' }, url),
        el(
          'button',
          {
            class: 'btn btn-primary',
            style: { alignSelf: 'flex-start' },
            onclick: () => copyText(url, 'Meeting link copied'),
          },
          icon('copy'),
          'Copy meeting link'
        )
      )
    );
    // Only a click that both starts and ends on the backdrop dismisses.
    // A drag that starts inside the dialog (e.g. selecting the link text)
    // and ends outside still fires a click targeting the backdrop.
    let pressedBackdrop = false;
    const backdrop = el(
      'div',
      {
        class: 'dialog-backdrop',
        onpointerdown: (e) => {
          pressedBackdrop = e.target === backdrop;
        },
        onclick: (e) => {
          if (pressedBackdrop && e.target === backdrop) close();
        },
      },
      dialog
    );
    closeLinkDialog = close;
    window.addEventListener('keydown', onDialogKeydown);
    root.append(backdrop);
    dialog.focus();
  }

  function onJoin() {
    const code = extractCode(joinInput.value);
    if (!code) {
      toast('Enter a meeting code or paste a meeting link.', { icon: 'info' });
      return;
    }
    ctx.openPrejoin({ mode: 'join', code });
  }

  /** The signed-in Puter user, or null. */
  async function fetchUser() {
    if (!hasPuter()) return null;
    try {
      const puter = window.puter;
      if (!puter.auth?.isSignedIn?.()) return null;
      return (await puter.auth.getUser()) ?? null;
    } catch {
      return null;
    }
  }

  async function signOut() {
    try {
      await window.puter.auth.signOut();
    } catch {
      /* noop */
    }
    onSignedOut();
  }

  function onSignedOut() {
    forgetUser();
    // Whoever signs in next must not be shown this account's
    // meetings from the panel's snapshot — nor by the panel
    // itself, which is mounted afresh for the account now here.
    clearAgendaCaches();
    renderUser();
    mountAgendaPanel();
  }

  function onSignedIn() {
    forgetUser();
    renderUser();
    mountAgendaPanel();
  }

  async function renderUser() {
    if (accountMenu) {
      // The element shows the account by itself; the app still takes the
      // username as the fallback display name.
      if (!userSlot.contains(accountMenu)) clear(userSlot).append(accountMenu);
      const user = await currentUser();
      if (mounted && user && !ctx.getUserName?.()) ctx.setUserName?.(user.username ?? 'You');
      return;
    }
    clear(userSlot);
    if (!hasPuter()) return;
    const puter = window.puter;
    try {
      if (puter.auth?.isSignedIn?.()) {
        const avatar = accountAvatar();
        userSlot.append(avatar);
        const user = await currentUser();
        if (!mounted || !userSlot.contains(avatar)) return;
        const name = user?.username ?? 'You';
        userSlot.append(
          avatar,
          el(
            'button',
            {
              class: 'icon-btn',
              title: 'Sign out',
              'aria-label': 'Sign out',
              onclick: signOut,
            },
            icon('logout')
          )
        );
        void loadAccountAvatar(avatar, user, puter.auth);
        // The account username is only a fallback — never clobber a
        // display name the user chose earlier.
        if (!ctx.getUserName?.()) ctx.setUserName?.(name);
      } else {
        userSlot.append(
          el(
            'button',
            {
              class: 'btn btn-outline home-signin',
              onclick: async () => {
                try {
                  await puter.auth.signIn();
                  onSignedIn();
                } catch {
                  /* user dismissed */
                }
              },
            },
            'Sign in'
          )
        );
      }
    } catch {
      /* auth unavailable */
    }
  }

  return () => {
    mounted = false;
    clearInterval(clockTimer);
    closeNewMenu();
    closeLinkDialog?.();
    closeSettings?.();
    unmountAgenda?.();
  };
}

function feature(text) {
  return el('li', {}, icon('check'), text);
}
