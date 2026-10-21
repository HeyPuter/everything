/**
 * Share for review: render the project (or its in/out range) as a review
 * copy, save it in the owner's Puter files and publish it as the next
 * version of this project's review. Below that, access: invite links with
 * a role and an expiry (revocable), and the people who joined, with their
 * role and a way to remove them.
 */
import '../../styles/export.css';
import '../../styles/review.css';
import { h, announce } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { clock } from '../../lib/time.js';
import { formatBytes } from '../../engine/exporter.js';
import { projectDuration } from '../../model/timeline.js';
import { ensureWorker as ensureWorkerDefault, call as callDefault } from '../../review/api.js';
import { shareForReview as shareDefault, reviewSource } from '../../review/share.js';
import { reviewLink, GUEST_ROLES, ROLE_LABELS, INVITE_DAYS, cleanTitle } from '../../review/protocol.js';
import { openDialog, confirmDialog, toast } from '../dialog.js';

let seq = 0;

/** The address reviewers open: this app without its query (Puter adds its own parameters). */
export function appBase(href = location.href) {
  const u = new URL(href);
  return `${u.origin}${u.pathname}`;
}

export function reviewAvailable(ctx) {
  return ctx.library?.backend?.kind === 'puter' && Boolean(ctx.puter || (typeof puter !== 'undefined' && puter));
}

function dateLabel(ts) {
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

async function copyText(text, input) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    input?.select();
    try {
      return document.execCommand('copy');
    } catch {
      return false;
    }
  }
}

export function openShareDialog(ctx, { deps = {} } = {}) {
  const d = { ensureWorker: ensureWorkerDefault, call: callDefault, shareForReview: shareDefault, base: () => appBase(), ...deps };
  const P = ctx.puter || globalThis.puter;
  const { store, library } = ctx;
  const project = store.project;
  let server = null;
  let review = null;
  let controller = null;
  let running = false;

  const body = h('div.rv-share');
  const footerInfo = h('div.rv-share-info');
  const footerButtons = h('div.rv-share-buttons');
  const dlg = openDialog({
    title: 'Share for review',
    body,
    actions: [h('div.rv-share-footer', footerInfo, footerButtons)],
    className: 'rv-share-dialog',
    closeOnBackdrop: false,
    onClose: () => controller?.abort(),
  });
  const closeBtn = h('button.btn', { type: 'button' }, 'Close');
  closeBtn.addEventListener('click', () => dlg.close());

  const callOwner = (op, fields = {}) => d.call(P, server, { op, review: review?.id, ...fields });

  if (!reviewAvailable(ctx)) {
    const signIn = ctx.account?.onSignIn ? h('button.btn.primary', { type: 'button' }, 'Sign in to Puter') : null;
    signIn?.addEventListener('click', () => ctx.account.onSignIn());
    body.replaceChildren(h('div.rv-share-message', icon('cloudOff', 28), h('p', 'Sharing for review needs a Puter account: the review copy is saved in your Puter files and reviewers sign in with theirs.')));
    footerButtons.replaceChildren(...[closeBtn, signIn].filter(Boolean));
    return dlg;
  }

  /* Share a version --------------------------------------------------------- */
  const titleId = `rv-title-${++seq}`;
  const titleInput = h('input.input', { id: titleId, type: 'text', maxLength: 120, value: project.name, autocomplete: 'off' });
  const scopeId = `rv-scope-${++seq}`;
  const scopeSelect = h('select.select', { id: scopeId },
    h('option', { value: 'all' }, 'Whole timeline'),
    project.range ? h('option', { value: 'range' }, 'In to out points') : null);
  scopeSelect.value = project.range ? 'range' : 'all';
  const intro = h('p.rv-share-intro');
  const lengthNote = h('p.rv-hint');
  const shareBtn = h('button.btn.primary', { type: 'button' }, icon('shareReview', 16), 'Share');
  const updateIntro = () => {
    const next = review ? review.versions.length + 1 : 1;
    intro.textContent = review
      ? `This adds version ${next} to the review "${review.title}". Everyone you invited sees it the next time they open the review, and earlier versions keep their comments.`
      : 'Makes a 720p review copy, saves it in your Puter files, and creates a review you can invite people to.';
    shareBtn.lastChild.textContent = review ? `Share version ${next}` : 'Share';
    const { project: src } = reviewSource(store.project, scopeSelect.value);
    const len = projectDuration(src);
    lengthNote.textContent = len > 0 ? `Length ${clock(len)}. Rendering takes about as long as an export.` : 'The timeline is empty. Add something before sharing.';
    shareBtn.disabled = len <= 0 || running;
  };
  scopeSelect.addEventListener('change', updateIntro);
  const shareSection = h('section.rv-share-section', { 'aria-labelledby': `${titleId}-h` },
    h('h3.rv-share-h', { id: `${titleId}-h` }, 'New version'),
    intro,
    h('div.export-row', h('label.export-label', { for: titleId }, 'Title'), titleInput),
    project.range ? h('div.export-row', h('label.export-label', { for: scopeId }, 'Share'), scopeSelect) : null,
    lengthNote);

  const progressPhase = h('p.rv-progress-phase');
  const bar = h('div.export-bar-fill');
  const barEl = h('div.export-bar', { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0', 'aria-label': 'Share progress' }, bar);
  const progress = h('div.rv-progress', { hidden: true }, progressPhase, barEl);
  shareSection.append(progress);

  async function share() {
    if (running) return;
    running = true;
    controller = new AbortController();
    updateIntro();
    progress.hidden = false;
    const stop = h('button.btn', { type: 'button' }, 'Cancel');
    stop.addEventListener('click', () => controller.abort());
    footerButtons.replaceChildren(stop);
    let lastPct = -1;
    const setBar = (f) => {
      const pct = Math.floor(f * 100);
      bar.style.width = `${f * 100}%`;
      barEl.setAttribute('aria-valuenow', String(pct));
      if (pct >= lastPct + 25) {
        lastPct = pct - (pct % 25);
        announce(`Rendering ${lastPct}%`);
      }
    };
    try {
      const r = await d.shareForReview({
        puter: P,
        project: store.project,
        library,
        scope: scopeSelect.value,
        title: cleanTitle(titleInput.value || project.name),
        signal: controller.signal,
        onPhase: (phase, info = {}) => {
          if (phase === 'server') progressPhase.textContent = info.text || 'Preparing the review server...';
          else if (phase === 'render') {
            progressPhase.textContent = `Rendering the review copy... ${Math.floor((info.fraction || 0) * 100)}%`;
            setBar((info.fraction || 0) * 0.85);
            info.preview?.close?.();
          } else if (phase === 'save') {
            progressPhase.textContent = `Saving to your Puter files (${formatBytes(info.bytes)})...`;
            setBar(0.9);
          } else if (phase === 'publish') {
            // Too late to take back: the version is being published.
            stop.disabled = true;
            progressPhase.textContent = 'Publishing...';
            setBar(0.97);
          }
        },
      });
      server = r.server;
      review = r.review;
      setBar(1);
      progressPhase.textContent = `Version ${r.version} is shared.`;
      toast(`Version ${r.version} shared for review.`, { kind: 'success' });
      ctx.review?.refresh?.();
      await showAccess();
    } catch (err) {
      if (err?.name === 'AbortError') progressPhase.textContent = 'Canceled.';
      else {
        console.error(err);
        progressPhase.textContent = '';
        toast(err?.message || 'Could not share for review.', { kind: 'error' });
      }
      progress.hidden = err?.name === 'AbortError' ? false : true;
    } finally {
      running = false;
      controller = null;
      showFooter();
      updateIntro();
    }
  }
  shareBtn.addEventListener('click', share);

  /* Access ---------------------------------------------------------------- */
  const accessSection = h('section.rv-share-section.rv-access', { hidden: true });
  const roleId = `rv-role-${++seq}`;
  const daysId = `rv-days-${++seq}`;
  const roleSelect = h('select.select', { id: roleId }, GUEST_ROLES.map((r) => h('option', { value: r }, ROLE_LABELS[r])));
  const daysSelect = h('select.select', { id: daysId }, INVITE_DAYS.map((n) => h('option', { value: String(n) }, n === 1 ? '1 day' : `${n} days`)));
  daysSelect.value = '7';
  const createBtn = h('button.btn', { type: 'button' }, icon('link', 15), 'Create link');
  const linkOut = h('div.rv-link-out', { hidden: true });
  const invitesList = h('ul.rv-rows', { 'aria-label': 'Invite links' });
  const peopleList = h('ul.rv-rows', { 'aria-label': 'People' });
  accessSection.append(
    h('h3.rv-share-h', 'Invite people'),
    h('p.rv-hint', 'Anyone with a link can join after signing in to Puter; their Puter username is shown with their comments. A link is shown only when it is made, so make a new one whenever you need it.'),
    h('div.rv-invite-row',
      h('label.rv-field', h('span', 'Role'), roleSelect),
      h('label.rv-field', h('span', 'Expires after'), daysSelect),
      createBtn),
    linkOut,
    h('h3.rv-share-h', 'Links'),
    invitesList,
    h('h3.rv-share-h', icon('people', 15), 'People'),
    peopleList);

  createBtn.addEventListener('click', async () => {
    createBtn.disabled = true;
    try {
      const r = await callOwner('invite.create', { role: roleSelect.value, days: Number(daysSelect.value) });
      const link = reviewLink(d.base(), server, review.id, r.token);
      const input = h('input.input.rv-link', { type: 'text', readOnly: true, value: link, 'aria-label': 'Invite link' });
      const copy = h('button.btn.primary', { type: 'button' }, icon('copy', 15), 'Copy');
      copy.addEventListener('click', async () => {
        const ok = await copyText(link, input);
        toast(ok ? 'Link copied.' : 'Select the link and copy it.', { kind: ok ? 'success' : 'info' });
      });
      linkOut.replaceChildren(h('p.rv-hint', `New link for people who ${r.invite.role === 'commenter' ? 'can comment' : 'can view'}, until ${dateLabel(r.invite.expires)}:`), h('div.rv-link-row', input, copy));
      linkOut.hidden = false;
      input.focus();
      input.select();
      await renderInvites();
    } catch (err) {
      toast(err?.message || 'Could not create a link.', { kind: 'error' });
    } finally {
      createBtn.disabled = false;
    }
  });

  async function renderInvites() {
    const { invites } = await callOwner('invite.list');
    if (!invites.length) {
      invitesList.replaceChildren(h('li.rv-row.empty', 'No links yet.'));
      return;
    }
    invitesList.replaceChildren(...invites.map((i) => {
      const state = i.revoked ? 'Turned off' : i.expired ? 'Expired' : `Until ${dateLabel(i.expires)}`;
      const revoke = !i.revoked && !i.expired ? h('button.btn.small', { type: 'button', 'aria-label': `Turn off link created ${dateLabel(i.created)}` }, 'Turn off') : null;
      revoke?.addEventListener('click', async () => {
        revoke.disabled = true;
        try {
          await callOwner('invite.revoke', { invite: i.id });
          announce('Link turned off');
          await renderInvites();
        } catch (err) {
          toast(err?.message || 'Could not turn off the link.', { kind: 'error' });
          revoke.disabled = false;
        }
      });
      return h(`li.rv-row${i.revoked || i.expired ? '.off' : ''}`,
        h('span.rv-row-main', icon('link', 14), ROLE_LABELS[i.role]),
        h('span.rv-row-meta', `${state}. ${i.uses} joined.`),
        revoke);
    }));
  }

  async function renderPeople() {
    const { members } = await callOwner('members');
    if (!members.length) {
      peopleList.replaceChildren(h('li.rv-row.empty', 'Nobody has joined yet.'));
      return;
    }
    peopleList.replaceChildren(...members.map((m) => {
      const sel = h('select.select.small', { 'aria-label': `Role for ${m.username}` }, GUEST_ROLES.map((r) => h('option', { value: r }, ROLE_LABELS[r])));
      sel.value = m.role;
      sel.addEventListener('change', async () => {
        try {
          await callOwner('member.role', { uuid: m.uuid, role: sel.value });
          announce(`${m.username}: ${ROLE_LABELS[sel.value]}`);
        } catch (err) {
          sel.value = m.role;
          toast(err?.message || 'Could not change the role.', { kind: 'error' });
        }
      });
      const remove = h('button.icon-btn', { type: 'button', 'aria-label': `Remove ${m.username}`, 'data-tip': 'Remove' }, icon('removePerson', 16));
      remove.addEventListener('click', async () => {
        if (!(await confirmDialog({ title: 'Remove from review', message: `${m.username} will lose access to this review and its comments. Their comments stay.`, confirm: 'Remove', danger: true }))) return;
        try {
          await callOwner('member.remove', { uuid: m.uuid });
          announce(`${m.username} removed`);
          await renderPeople();
        } catch (err) {
          toast(err?.message || 'Could not remove them.', { kind: 'error' });
        }
      });
      return h('li.rv-row', h('span.rv-row-main', icon('user', 14), m.username), h('span.rv-row-meta', `Joined ${dateLabel(m.joined)}`), sel, remove);
    }));
  }

  async function showAccess() {
    accessSection.hidden = false;
    footerInfo.textContent = review ? `${review.versions.length} version${review.versions.length === 1 ? '' : 's'} shared` : '';
    await Promise.all([renderInvites(), renderPeople()]).catch((err) => toast(err?.message || 'Could not load who has access.', { kind: 'error' }));
  }

  function showFooter() {
    const comments = ctx.review ? h('button.btn', { type: 'button' }, icon('comment', 15), 'Open comments') : null;
    comments?.addEventListener('click', () => {
      dlg.close();
      ctx.review.toggle(true);
    });
    footerButtons.replaceChildren(...[review ? comments : null, closeBtn, shareBtn].filter(Boolean));
  }

  /* Start: make sure the review server runs and find this project's review. */
  const loading = h('div.rv-share-message', { role: 'status' }, h('div.spinner'), h('p', 'Preparing the review server...'));
  body.replaceChildren(loading);
  footerButtons.replaceChildren(closeBtn);
  (async () => {
    try {
      server = await d.ensureWorker(P, { progress: (text) => (loading.querySelector('p').textContent = text) });
      const found = await d.call(P, server, { op: 'review.find', projectId: project.id });
      review = found.review;
    } catch (err) {
      const retry = h('button.btn.primary', { type: 'button' }, 'Try again');
      retry.addEventListener('click', () => {
        dlg.close();
        openShareDialog(ctx, { deps });
      });
      body.replaceChildren(h('div.rv-share-message', { role: 'alert' }, icon('alert', 28), h('p', err?.message || 'Could not reach the review server.')));
      footerButtons.replaceChildren(closeBtn, retry);
      return;
    }
    if (!dlg.el.isConnected) return;
    if (review) titleInput.value = review.title;
    body.replaceChildren(shareSection, accessSection);
    updateIntro();
    showFooter();
    if (review) await showAccess();
    titleInput.focus();
  })();
  return dlg;
}
