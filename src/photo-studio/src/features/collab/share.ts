// Invite to Edit, Share for Review, access management, Stop Sharing and
// opening invitation links. Sharing deploys (or reuses) a room worker in the
// owner's Puter account, uploads the document there and turns the tab into
// a shared document.
import * as Y from 'yjs';
import type { Editor } from '../../editor';
import { svg } from '../../app/icons';
import { escapeXML } from '../../model/assets';
import { formDialog } from '../../ui/dialog';
import { call, deploy } from '../../collab/api';
import { RoomClient } from '../../collab/client';
import { TileIndex } from '../../collab/tile-index';
import { INVITE_ROLES, roleLabel, shareLink, type RoomLink } from '../../collab/protocol';
import { collabPuter } from '../../collab/puter-types';
import { commentsOf, shared, sharedOf } from './state';
import { CollabSession, openShared, outboxStore, renderBar, type Member } from './session';

const activeShared = (e: Editor) => {
  const sh = sharedOf(e.session);
  return sh instanceof CollabSession ? sh : undefined;
};
const bytes = (n: number) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);

export async function inviteToEdit(e: Editor) {
  const cs = activeShared(e) ?? (await startSharing(e, 'edit'));
  if (cs) await accessDialog(e, cs, 'edit');
}
export async function shareForReview(e: Editor) {
  const cs = activeShared(e) ?? (await startSharing(e, 'review'));
  if (cs) await accessDialog(e, cs, 'review');
}

async function startSharing(e: Editor, purpose: 'edit' | 'review'): Promise<CollabSession | undefined> {
  const s = e.session;
  const tiles = s.assets.tiles;
  const ok = await formDialog(
    purpose === 'edit' ? 'Invite to Edit' : 'Share for Review',
    [],
    'Start Sharing',
    `${purpose === 'edit' ? 'People you invite edit this document with you live; each person undoes only their own changes.' : 'Reviewers see this document with zoom and pan and can leave comments; they cannot change it.'}\n\nSharing sets up a collaboration server in your Puter account and stores the document there (about ${bytes(tiles.bytes)} of pixels before compression). Everyone who opens a link signs in with Puter.\n\nThis tab becomes the shared document, and its earlier undo steps are cleared.`,
  );
  if (!ok) return;
  const puter = collabPuter();
  if (!puter.auth.isSignedIn()) await puter.auth.signIn();
  e.transform.apply();
  e.modal?.apply();
  const user = await puter.auth.getUser();
  const server = await deploy(puter, (text) => e.message(text));
  const ydoc = new Y.Doc();
  const index = new TileIndex(tiles);
  // Comments made here before sharing become the owner's.
  const me = { id: user.uuid, name: user.username };
  const comments = structuredClone(commentsOf(e, s).threads()).map((t) => ({
    ...t,
    author: t.author.id.startsWith('local:') ? me : t.author,
    resolved: t.resolved ? { ...t.resolved, by: t.resolved.by.id.startsWith('local:') ? me : t.resolved.by } : null,
    messages: t.messages.map((m) => (m.author.id.startsWith('local:') ? { ...m, author: me } : m)),
  }));
  const room = await RoomClient.create({ puter, server, tiles: index, assets: s.assets, doc: s.doc, comments, ydoc }, (f) => e.message(`Uploading the document… ${Math.round(f * 100)}%`));
  const client = new RoomClient({ puter, server, room, tiles: index, assets: s.assets, store: outboxStore(), ydoc });
  await client.join();
  return openShared(e, { server, room }, { target: s, client });
}

/** Invitation links, invitations by username and the people with access. */
async function accessDialog(e: Editor, cs: CollabSession, purpose: 'edit' | 'review') {
  if (cs.role !== 'owner') {
    e.message('Only the owner can invite people to this document.');
    return;
  }
  const dialog = document.querySelector<HTMLDialogElement>('#dialog')!;
  const req = <T,>(input: Record<string, unknown>) => call<T>(cs.client.o.puter, cs.link.server, { room: cs.link.room, ...input });
  const roles = purpose === 'edit' ? INVITE_ROLES : INVITE_ROLES.filter((r) => r !== 'editor');
  const roleOptions = (selected: string, list = roles) => list.map((r) => `<option value="${r}" ${r === selected ? 'selected' : ''}>${escapeXML(roleLabel(r))}</option>`).join('');
  const days = `<option value="1">1 day</option><option value="7" selected>7 days</option><option value="30">30 days</option>`;
  dialog.innerHTML = `<form method="dialog" class="collab-dialog"><h2>${purpose === 'edit' ? 'Invite to Edit' : 'Share for Review'}</h2>
<p class="muted">${purpose === 'edit' ? 'Anyone with an invitation link joins with the access it gives. People need a Puter account.' : 'A review link opens a review view: the image with zoom, pan and comments, without editing tools. Reviewers sign in with Puter.'}</p>
<section aria-labelledby="collab-link-title"><h3 id="collab-link-title">Invitation link</h3>
<div class="collab-row"><label>Access <select name="role">${roleOptions(purpose === 'edit' ? 'editor' : 'commenter')}</select></label><label>Expires after <select name="days">${days}</select></label><button type="button" data-act="link">${svg('link', 14)}Create Link</button></div>
<div class="collab-row collab-link" hidden><input readonly aria-label="Invitation link" spellcheck="false"><button type="button" data-act="copy">${svg('copy', 14)}Copy</button></div></section>
${purpose === 'edit' ? `<section aria-labelledby="collab-user-title"><h3 id="collab-user-title">Invite by Puter username</h3><div class="collab-row"><input name="username" placeholder="username" aria-label="Puter username" spellcheck="false" autocomplete="off"><select name="userrole" aria-label="Access">${roleOptions('editor')}</select><button type="button" data-act="user" disabled>Invite</button></div><p class="muted collab-small">Then send them the document’s link (Copy Link, in the people list beside the sharing status); they open it after signing in.</p></section>` : ''}
<section aria-labelledby="collab-members-title"><h3 id="collab-members-title">People with access</h3><ul class="collab-members"><li class="muted">Loading…</li></ul><div class="collab-row"><span class="muted collab-invites"></span><span class="panel-tabs-spacer"></span><button type="button" data-act="revoke">Revoke Invitation Links</button></div></section>
<p class="collab-error" role="alert" hidden></p>
<div class="dialog-actions"><button class="primary" value="done">Done</button></div></form>`;
  const form = dialog.querySelector('form')!;
  const error = (text = '') => {
    const p = form.querySelector<HTMLElement>('.collab-error')!;
    p.textContent = text;
    p.hidden = !text;
  };
  const value = (name: string) => form.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${name}"]`)?.value ?? '';
  const refresh = async () => {
    const res = await req<{ members: (Member & { expires?: number | null })[]; named: { username: string; role: string; expires: number }[]; invites: number }>({ op: 'members' });
    cs.members = res.members;
    const expiry = (m: { expires?: number | null }) => {
      const left = m.expires ? Math.round((m.expires - Date.now()) / 86_400_000) : null;
      const opt = (v: string, label: string, sel = false) => `<option value="${v}" ${sel ? 'selected' : ''}>${label}</option>`;
      return `${opt('', 'No expiry', !m.expires)}${m.expires ? opt('keep', `Until ${new Date(m.expires).toLocaleDateString()}`, true) : ''}${opt('1', '1 day', false)}${opt('7', '7 days', false)}${opt('30', '30 days', false)}${left !== null && left < 0 ? '' : ''}`;
    };
    form.querySelector('.collab-members')!.innerHTML =
      res.members
        .map((m) =>
          m.role === 'owner'
            ? `<li><span class="collab-member-name">${escapeXML(m.username)}</span><span class="muted">Owner</span></li>`
            : `<li data-member="${m.uuid}"><span class="collab-member-name">${escapeXML(m.username)}</span><select data-member-role aria-label="Access for ${escapeXML(m.username)}">${roleOptions(m.role, INVITE_ROLES)}</select><select data-member-expiry aria-label="Access of ${escapeXML(m.username)} expires">${expiry(m)}</select><button type="button" class="icon-button" data-act="remove" aria-label="Remove ${escapeXML(m.username)}" title="Remove access">${svg('trash-2', 14)}</button></li>`,
        )
        .join('') + res.named.map((n) => `<li><span class="collab-member-name">${escapeXML(n.username)}</span><span class="muted">${escapeXML(roleLabel(n.role))} · invited, not joined yet</span></li>`).join('');
    form.querySelector('.collab-invites')!.textContent = res.invites ? `${res.invites} active invitation link${res.invites === 1 ? '' : 's'}` : 'No active invitation links';
    // Nothing to revoke without active links (the text beside it says so).
    form.querySelector<HTMLButtonElement>('[data-act="revoke"]')!.disabled = !res.invites;
    renderBar(e);
  };
  const act = async (fn: () => Promise<unknown>) => {
    error();
    try {
      await fn();
    } catch (err) {
      error(err instanceof Error ? err.message : String(err));
    }
  };
  form.addEventListener('click', (ev) => {
    const t = ev.target as HTMLElement;
    const a = t.closest<HTMLElement>('[data-act]')?.dataset.act;
    if (!a) return;
    if (a === 'link')
      void act(async () => {
        const role = value('role');
        const res = await req<{ token: string }>({ op: 'invite', role, review: purpose === 'review', days: Number(value('days')) });
        const link: RoomLink = { server: cs.link.server, room: cs.link.room, token: res.token, review: purpose === 'review' };
        const row = form.querySelector<HTMLElement>('.collab-link')!;
        row.hidden = false;
        const input = row.querySelector('input')!;
        input.value = shareLink(location.href, link);
        input.select();
        await refresh();
      });
    if (a === 'copy') {
      const input = form.querySelector<HTMLInputElement>('.collab-link input')!;
      void navigator.clipboard?.writeText(input.value).then(
        () => e.message('Invitation link copied.'),
        () => input.select(),
      );
    }
    if (a === 'user')
      void act(async () => {
        await req({ op: 'invite-user', username: value('username').trim(), role: value('userrole') });
        form.querySelector<HTMLInputElement>('[name="username"]')!.value = '';
        form.querySelector<HTMLButtonElement>('[data-act="user"]')!.disabled = true;
        await refresh();
      });
    if (a === 'revoke')
      void act(async () => {
        await req({ op: 'revoke-invites' });
        form.querySelector<HTMLElement>('.collab-link')!.hidden = true;
        await refresh();
      });
    if (a === 'remove') {
      const uuid = t.closest<HTMLElement>('[data-member]')!.dataset.member!;
      void act(async () => {
        await req({ op: 'role', uuid, role: 'removed' });
        await refresh();
      });
    }
  });
  // Invite by username needs a name.
  form.addEventListener('input', (ev) => {
    const t = ev.target as HTMLInputElement;
    if (t.name === 'username') form.querySelector<HTMLButtonElement>('[data-act="user"]')!.disabled = !t.value.trim();
  });
  form.addEventListener('keydown', (ev) => {
    // Enter in the username field invites (rather than closing the dialog).
    const t = ev.target as HTMLInputElement;
    if (ev.key === 'Enter' && t.name === 'username') {
      ev.preventDefault();
      form.querySelector<HTMLButtonElement>('[data-act="user"]:not(:disabled)')?.click();
    }
  });
  form.addEventListener('change', (ev) => {
    const t = ev.target as HTMLSelectElement;
    const uuid = t.closest<HTMLElement>('[data-member]')?.dataset.member;
    if (!uuid) return;
    if (t.matches('[data-member-role]')) void act(async () => req({ op: 'role', uuid, role: t.value }));
    if (t.matches('[data-member-expiry]') && t.value !== 'keep') void act(async () => req({ op: 'role', uuid, expires: t.value ? Date.now() + Number(t.value) * 86_400_000 : null }).then(refresh));
  });
  const closed = new Promise<void>((resolve) => dialog.addEventListener('close', () => resolve(), { once: true }));
  dialog.showModal();
  void act(refresh);
  await closed;
}

export async function stopSharing(e: Editor) {
  const cs = activeShared(e);
  if (!cs || cs.role !== 'owner') return;
  if (!(await formDialog('Stop Sharing?', [], 'Stop Sharing', 'Everyone loses access and their open copies stop updating.\n\nThis tab keeps the document as a local copy, with its comments; save it to keep it.'))) return;
  await call(cs.client.o.puter, cs.link.server, { op: 'stop', room: cs.link.room });
  cs.toLocal('Sharing stopped. This tab keeps a local copy.');
}

/** Open an invitation or review link (Photo Studio was opened with one). */
export async function openLink(e: Editor, link: RoomLink) {
  for (const [s, h] of shared)
    if (h instanceof CollabSession && h.link.room === link.room) {
      await e.switchSession(s);
      return;
    }
  const puter = collabPuter();
  if (!puter.auth.isSignedIn()) {
    const ok = await formDialog(link.review ? 'Open for Review' : 'Open Shared Document', [], 'Sign In', 'This link opens a shared document. Sign in with your Puter account to join.');
    if (!ok) return;
    await puter.auth.signIn();
  }
  await openShared(e, link, { review: link.review });
}
