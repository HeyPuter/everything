import { el, clear } from '../lib/dom.js';
import { icon } from './icons.js';
import { openModal, confirmDialog } from './modal.js';
import { toast } from './toast.js';
import { store } from '../lib/store.js';
import { inviteLink } from '../lib/collab.js';

/**
 * Share a list, two ways:
 *  - Collaborate: invite people who can add and edit tasks — by Puter
 *    username (KV shares), or where those aren't available through the
 *    two-link handshake (invite out, confirmation back). See collab.js.
 *  - Read-only link: publishes a live snapshot anyone can view.
 */
export function openShareSheet(list) {
  const body = el('div');
  const modal = openModal({ title: `Share "${list.name}"`, content: body });

  function copyRow(value, label, id) {
    const input = el('input.input', {
      id, value, readonly: true, 'aria-label': label,
      onclick: (e) => e.target.select(),
    });
    return el('div.row', {},
      input,
      el('button.icon-btn', {
        html: icon('copy', 17), 'aria-label': `Copy ${label}`,
        onclick: async () => {
          try {
            await navigator.clipboard.writeText(input.value);
            toast('Link copied');
          } catch {
            input.select();
            toast('Press Ctrl+C to copy', { icon: 'copy' });
          }
        },
      })
    );
  }

  function render() {
    const fresh = store.listById(list.id);
    clear(body);
    if (!fresh) { modal.close(); return; }
    renderCollab(fresh);
    renderReadonly(fresh);
  }

  /* ---------- collaborate (edit together) ---------- */

  function renderCollab(fresh) {
    const section = el('div', { style: { marginBottom: '22px' } });
    body.append(el('div.section-label', {}, 'Work on it together'), section);

    if (!fresh.collab) {
      const byName = store.collabMode() === 'kv';
      section.append(el('div.card', { style: { padding: '16px' } },
        el('p.small.muted', { style: { marginBottom: '12px' } }, byName
          ? 'Invite people by their Puter username to add, edit, and complete tasks with you. You can remove anyone at any time.'
          : 'Invite people who can add, edit, and complete tasks with you. You approve each person before their changes join the list.'),
        el('button.btn.btn-primary.btn-block', {
          html: icon('users', 15, 2.2),
          onclick: async (e) => {
            e.currentTarget.disabled = true;
            try {
              const res = await store.enableCollab(fresh.id);
              if (res.invite) toast('Collaboration is on', { icon: 'users' });
            } catch (err) {
              console.error(err);
              toast(err.message || 'Could not start. Check your connection',
                { icon: err.code === 'consent_denied' ? 'alert' : 'wifiOff' });
            }
            render();
            body.querySelector('#invite-name')?.focus();
          },
        }, ' Invite people to edit')
      ));
      return;
    }

    if (fresh.collab.mode === 'kv') {
      renderKvCollab(fresh, section);
      return;
    }

    if (fresh.collab.role === 'member') {
      const owner = fresh.collab.ownerName || 'the owner';
      const status = fresh.collab.approved
        ? 'Your edits sync with everyone in the list.'
        : `Waiting for ${owner} to approve you. Lost the confirmation link? Copy a fresh one below and send it to them.`;
      const card = el('div.card', { style: { padding: '16px' } },
        el('p.small.muted', {}, `Shared by ${owner}. ${status}`)
      );
      if (!fresh.collab.approved) {
        const holder = el('div', { style: { marginTop: '12px' } },
          el('button.btn.btn-ghost.btn-block', {
            html: icon('link', 15, 2.2),
            onclick: async (e) => {
              // currentTarget is null once dispatch ends — capture it now,
              // or the error path throws instead of re-enabling the button.
              const btn = e.currentTarget;
              btn.disabled = true;
              try {
                const link = await store.confirmLinkFor(fresh.id);
                clear(holder);
                holder.append(copyRow(link, 'confirmation link', 'confirm-link'));
              } catch (err) {
                console.error(err);
                btn.disabled = false;
                toast('Could not create the link. Check your connection', { icon: 'wifiOff' });
              }
            },
          }, ' Get my confirmation link')
        );
        card.append(holder);
      }
      card.append(leaveButton(fresh));
      section.append(card);
      return;
    }

    /* owner */
    section.append(
      el('p.small.muted', { style: { margin: '0 2px 8px' } },
        'Anyone with this invite can ask to join; they send you a confirmation link and you approve them.'),
      el('div.field', {},
        el('label', { for: 'invite-link' }, 'Invite link'),
        copyRow(inviteLink(fresh.collab.manifestUrl), 'invite link', 'invite-link')
      ),
      membersCard(fresh, {
        removeMessage: 'Their changes stop syncing and the list becomes a private copy on their side.',
        emptyMessage: 'No members yet. Send the invite link to get started.',
      }),
      stopButton(fresh, 'Members keep a private copy of the list as it is now, and nothing syncs anymore.')
    );
  }

  /* KV shares: invite by username, no links to pass around. */
  function renderKvCollab(fresh, section) {
    if (fresh.collab.role === 'member') {
      const owner = fresh.collab.ownerName || 'the owner';
      section.append(el('div.card', { style: { padding: '16px' } },
        el('p.small.muted', {}, `Shared by ${owner}. Your edits sync with everyone in the list.`),
        leaveButton(fresh)
      ));
      return;
    }

    const input = el('input.input', {
      id: 'invite-name', placeholder: 'Puter username', autocomplete: 'off', autocapitalize: 'none',
    });
    const submit = el('button.btn.btn-primary', { type: 'submit' }, 'Invite');
    const form = el('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        if (!input.value.trim()) { input.focus(); return; }
        submit.disabled = true;
        try {
          const res = await store.inviteMember(fresh.id, input.value);
          if (res.fallback) {
            toast('Inviting by username is not available here. Send the invite link instead', { icon: 'link', duration: 6000 });
          } else {
            toast(`${res.member.name} can now edit`, { icon: 'users' });
          }
          render();
          body.querySelector('#invite-name')?.focus();
        } catch (err) {
          console.error(err);
          submit.disabled = false;
          toast(err.message || 'Could not invite. Check your connection', { icon: 'alert' });
          input.focus();
        }
      },
    }, el('div.field', {},
      el('label', { for: 'invite-name' }, 'Invite by Puter username'),
      el('div.row', {}, input, submit)
    ));

    section.append(
      el('p.small.muted', { style: { margin: '0 2px 8px' } },
        'People you invite see every task in this list and can add, edit, and complete tasks. Changes sync as they happen.'),
      form,
      membersCard(fresh, {
        removeMessage: 'They lose access right away and keep a private copy of the list as it is now.',
        emptyMessage: 'No one yet. Invite someone by their Puter username.',
      }),
      stopButton(fresh, 'Everyone loses access right away and keeps a private copy of the list as it is now.')
    );
  }

  function leaveButton(fresh) {
    return el('button.btn.btn-ghost.btn-block', {
      style: { marginTop: '12px', color: 'var(--danger)' },
      onclick: async () => {
        const ok = await confirmDialog({
          title: 'Leave this list?',
          message: 'The list and its tasks are removed from your account. Everyone else keeps working.',
          confirmLabel: 'Leave list',
        });
        if (!ok) return;
        await store.leaveCollab(fresh.id);
        modal.close();
        location.hash = '#/lists';
        toast('You left the list');
      },
    }, 'Leave list');
  }

  function stopButton(fresh, message) {
    return el('button.btn.btn-ghost.btn-block', {
      style: { marginTop: '12px', color: 'var(--danger)' },
      onclick: async () => {
        const ok = await confirmDialog({ title: 'Stop collaborating?', message, confirmLabel: 'Stop collaborating' });
        if (!ok) return;
        await store.disableCollab(fresh.id);
        toast('Collaboration stopped');
        render();
      },
    }, 'Stop collaborating');
  }

  /** Owner's member list, loaded from the store (manifest or live shares). */
  function membersCard(fresh, { removeMessage, emptyMessage }) {
    const membersHolder = el('div.card', { style: { marginTop: '12px' } },
      el('div.empty', { style: { padding: '14px' } }, el('div.spinner', { role: 'status', 'aria-label': 'Loading members' })));
    store.collabMembers(fresh.id).then(({ members }) => {
      if (!membersHolder.isConnected) return;
      clear(membersHolder);
      membersHolder.append(el('div.setting-row', {},
        el('span.s-icon', { html: icon('user', 19) }),
        el('div.grow', {},
          el('div.s-label', {}, `${fresh.collab.memberId} (you)`),
          el('div.s-sub', {}, 'Owner')
        )
      ));
      for (const m of members) {
        membersHolder.append(el('div.setting-row', {},
          el('span.s-icon', { html: icon('user', 19) }),
          el('div.grow', {},
            el('div.s-label', {}, m.name),
            el('div.s-sub', {}, 'Can edit')
          ),
          el('button.icon-btn', {
            html: icon('x', 17), 'aria-label': `Remove ${m.name}`,
            onclick: async () => {
              const ok = await confirmDialog({
                title: `Remove ${m.name}?`,
                message: removeMessage,
                confirmLabel: 'Remove',
              });
              if (!ok) return;
              try {
                await store.removeMember(fresh.id, m.id);
                toast(`${m.name} removed`);
              } catch (err) {
                console.error(err);
                toast('Could not remove. Check your connection', { icon: 'wifiOff' });
              }
              render();
            },
          })
        ));
      }
      if (!members.length) {
        membersHolder.append(el('p.small.muted', { style: { padding: '0 16px 14px' } }, emptyMessage));
      }
    }).catch(() => {
      if (!membersHolder.isConnected) return;
      clear(membersHolder);
      membersHolder.append(el('p.small.muted', { style: { padding: '14px 16px' } },
        'Could not load members. Check your connection.'));
    });
    return membersHolder;
  }

  /* ---------- read-only link ---------- */

  function renderReadonly(fresh) {
    const section = el('div');
    body.append(el('div.section-label', {}, 'Read-only link'), section);

    if (!fresh.shared) {
      section.append(el('div.card', { style: { padding: '16px' } },
        el('p.small.muted', { style: { marginBottom: '12px' } },
          'A live, view-only copy for anyone with the link. No account needed, and you can stop sharing at any time.'),
        el('button.btn.btn-ghost.btn-block', {
          html: icon('eye', 15, 2.2),
          onclick: async (e) => {
            e.currentTarget.disabled = true;
            try {
              await store.enableShare(fresh.id);
              toast('Sharing is on', { icon: 'share' });
            } catch (err) {
              console.error(err);
              toast('Could not create the link. Check your connection', { icon: 'wifiOff' });
            }
            render();
          },
        }, ' Create view-only link')
      ));
      return;
    }

    const linkInput = el('input.input', {
      id: 'share-link', value: fresh.shared.link, readonly: true,
      onclick: (e) => e.target.select(),
    });
    const previewLink = el('a.btn.btn-ghost', {
      href: fresh.shared.link, target: '_blank', rel: 'noopener',
      html: icon('external', 15, 2.2),
    }, ' Preview');

    section.append(
      el('p.small.muted', { style: { margin: '0 2px 8px' } },
        'Shows a live, read-only copy. The link stays valid for a year; opening this sheet renews it.'),
      el('div.field', {},
        el('label', { for: 'share-link' }, 'View-only link'),
        el('div.row', {},
          linkInput,
          el('button.icon-btn', {
            html: icon('copy', 17), 'aria-label': 'Copy link',
            onclick: async () => {
              try {
                await navigator.clipboard.writeText(fresh.shared.link);
                toast('Link copied');
              } catch {
                linkInput.select();
                toast('Press Ctrl+C to copy', { icon: 'copy' });
              }
            },
          })
        )
      ),
      el('div.row', { style: { justifyContent: 'space-between', marginTop: '12px' } },
        el('button.btn.btn-ghost', {
          html: icon('x', 15, 2.2),
          onclick: async () => {
            const ok = await confirmDialog({
              title: 'Stop sharing?',
              message: 'The link stops working and the shared copy is removed from your cloud.',
              confirmLabel: 'Stop sharing',
            });
            if (!ok) return;
            await store.disableShare(fresh.id);
            toast('Sharing stopped');
            render();
          },
        }, ' Stop sharing'),
        previewLink
      )
    );

    // Renew on open: rewrite the snapshot and mint a fresh year-long URL so
    // the link shown here is always far from expiry. Links copied earlier
    // keep their original expiry date.
    store.enableShare(fresh.id).then((shared) => {
      if (!shared || !linkInput.isConnected) return;
      if (document.activeElement !== linkInput) linkInput.value = shared.link;
      previewLink.href = shared.link;
    }).catch(() => {});
  }

  render();
  return modal;
}
