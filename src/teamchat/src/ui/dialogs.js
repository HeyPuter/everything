/**
 * Every dialog in the app: channels, invites, direct messages, members,
 * workspace settings, and personal settings.
 */
import { el, fieldId, rerender, focusMemo, keepFocus, composing, coarsePointer, radioNav, pressOnce, listKeyNav } from './dom.js';
import { icon, channelIcon } from './icons.js';
import { avatar, groupAvatar, statusChip, rolePill, workspaceMark } from './avatar.js';
import { prepareAvatar } from '../lib/avatars.js';
import { openEmojiPicker } from './emojipicker.js';
import { PRESENCE_LABELS } from '../lib/time.js';
import { openModal, confirmDialog } from './modal.js';
import { openPopover, openMenu } from './menu.js';
import { toast } from './toast.js';
import { applyTheme, currentTheme } from './theme.js';
import { store } from '../lib/store.js';
import { api, ApiError } from '../lib/api.js';
import { navigate, parseHash, inviteLink, connectLink, parseInviteInput, parseConnectInput } from '../lib/router.js';
import { parseRef, makeRef, makeInviteToken, serverKeyOf } from '../lib/refs.js';
import { organizationsOf } from './shared.js';
import { normalize } from '../shared/search.js';
import { SHARED_WORKER_URL } from '../config.js';
import { LIMITS, INVITE_TTLS, POST_POLICIES, THREAD_POLICIES, BROADCAST_POLICIES, cleanChannelName, extractMentionNames, broadcastKind } from '../shared/limits.js';
import { evGrantPermission } from '../shared/events.js';
import { notificationsSupported, requestNotificationPermission, notificationsGranted, playNotificationSound } from '../lib/notify.js';
import { relativeLong, untilText } from '../lib/time.js';
import { initials } from '../lib/format.js';
import { previewWords } from './applink.js';
import { aroundText, toLocalInput, DELIVERY_NOTE } from '../lib/schedule.js';
import { exportWorkspace, writeArchiveToDrive, importArchive, transferWorkspace, progressText, leftBehindText } from '../lib/archive.js';
import { canInstall, promptInstall, isIos, isStandalone, pushSupported } from '../lib/pwa.js';
import { emailAvailable, parseEmails, sendInviteEmails } from '../lib/email.js';
import { copyToClipboard } from './clipboard.js';

/* ---- helpers ------------------------------------------------------------- */

function field(label, input, hint) {
  // `input` may be a wrapper (an icon beside the box): the label, the
  // description, and the error focus belong to the control inside it.
  const control = input.matches('input, textarea, select') ? input : input.querySelector('input, textarea, select') || input;
  const id = control.id || fieldId();
  control.id = id;
  // Announced when shown: the control has focus already when validation
  // fails on Enter, so focusing it again reads nothing out.
  const err = el('p.field-error', { hidden: true, id: `${id}-err`, role: 'alert' });
  const hintNode = hint ? el('p.field-hint', { id: `${id}-hint` }, hint) : null;
  control.setAttribute('aria-describedby', `${id}-err${hint ? ` ${id}-hint` : ''}`);
  const node = el('div.field', {},
    el('label.field-label', { for: id }, label),
    input,
    hintNode,
    err);
  node.showError = (msg) => {
    err.textContent = msg || '';
    err.hidden = !msg;
    control.setAttribute('aria-invalid', msg ? 'true' : 'false');
    if (msg) control.focus();
  };
  /** Replace the hint for a moment, e.g. to preview what will be saved. */
  node.showHint = (msg) => {
    if (hintNode) hintNode.textContent = msg || hint;
  };
  return node;
}

/**
 * Keep a channel-name field honest: the name is tidied (lowercased, spaces
 * to hyphens) when it is saved, so say what it will become while it is
 * being typed rather than changing the box under the cursor.
 */
function previewChannelName(input, fieldNode, hint) {
  const update = () => {
    const clean = cleanChannelName(input.value);
    fieldNode.showHint(clean && clean !== input.value.trim() ? `Will be saved as #${clean}` : hint);
  };
  input.addEventListener('input', update);
  update();
}

function busy(btn, label) {
  // The whole markup is kept, not only the text: several of these buttons
  // carry an icon before their label, which a textContent swap would drop.
  const prev = btn.innerHTML;
  // Disabled, not merely busy, while the request is out: for a submit
  // button that is what keeps Enter in a field of the form from sending it
  // again meanwhile. A focused button that is disabled hands its focus to
  // the page body, though, so a keyboard user who pressed the button and
  // had the request refused (offline, a name taken) found it enabled again
  // with nobody on it: the keyboard goes back to it when it comes back,
  // unless something else took the keyboard meanwhile (an error shown under
  // a field takes it there).
  const had = document.activeElement === btn;
  btn.disabled = true;
  btn.textContent = label;
  return () => {
    btn.disabled = false;
    btn.innerHTML = prev;
    if (had && btn.isConnected && document.activeElement === document.body) btn.focus({ preventScroll: true });
  };
}

/**
 * The same for a button outside any form (Replace, Deactivate, Revoke, the
 * button that makes a link): busy rather than disabled while its request is
 * out, so the keyboard stays on it (see pressOnce). Where busy() serves a
 * form's submit, disabling is what keeps Enter in a field from sending the
 * form twice; here there is no form, and the dialog is drawn again from the
 * answer without the button ever coming back, so a keyboard dropped by a
 * disabled button was left on the page body for good: the redraw puts a
 * keyboard back on the control now standing at its place, and finds none
 * on the body. Callers refuse a second press while `aria-busy` stands.
 */
function hold(btn, label) {
  const prev = btn.innerHTML;
  btn.setAttribute('aria-busy', 'true');
  btn.textContent = label;
  return () => {
    btn.removeAttribute('aria-busy');
    btn.innerHTML = prev;
  };
}

/** A labelled group of radio-style choices: options are [value, label, sub]. */
function choiceRow({ label, options, value, onChange, hint }) {
  const group = el('div.choice-group', { role: 'radiogroup', 'aria-label': label });
  const rove = radioNav(group);
  let current = value;
  const render = () => {
    rerender(group, ...options.map(([v, text, sub]) => el('button.choice', {
      type: 'button', role: 'radio', 'aria-checked': String(v === current),
      onclick: () => {
        current = v;
        render();
        onChange(v);
      },
    }, el('span.choice-mark', { 'aria-hidden': 'true' }), el('span.choice-text', {}, el('span', {}, text), sub && el('small', {}, sub)))));
    rove();
  };
  render();
  return el('div.field', {}, el('span.field-label', {}, label), group, hint && el('p.field-hint', {}, hint));
}

function switchRow({ label, sub, checked, onChange }) {
  const btn = el('button.switch', { type: 'button', role: 'switch', 'aria-checked': String(!!checked) },
    el('span.switch-text', {}, el('span', {}, label), sub && el('small', {}, sub)),
    el('span.switch-track', { 'aria-hidden': 'true' }));
  // One change at a time: a second click while the first is still being
  // saved (a permission prompt up, a slow worker) would flip the switch
  // again, and the two saves could land in either order, leaving the switch
  // and the saved setting disagreeing.
  let busy = false;
  btn.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    btn.setAttribute('aria-busy', 'true');
    const next = btn.getAttribute('aria-checked') !== 'true';
    btn.setAttribute('aria-checked', String(next));
    try {
      const ok = await onChange(next);
      if (ok === false) btn.setAttribute('aria-checked', String(!next));
    } finally {
      busy = false;
      btn.removeAttribute('aria-busy');
    }
  });
  return btn;
}

/**
 * What to say when the worker added nobody to a channel: everyone picked was
 * in it already, or some (or all) of them have left the workspace since the
 * dialog opened (the worker leaves them out and answers with nobody added,
 * as it does for people already in, and the dialog used to say the latter
 * for both). Read against the workspace as refreshed after the answer.
 */
/** People one request to add channel members may carry; the worker keeps the first fifty of a longer list and says nothing of the rest. */
const MEMBERS_PER_ADD = 50;

/**
 * Add people to a channel, as many requests as the list needs (see
 * MEMBERS_PER_ADD), in the workspace open when the adding began. Everyone the
 * worker says it added, over all of them.
 */
async function addMembersInBatches(channelId, uuids) {
  const wsId = store.wsId;
  const added = [];
  for (let i = 0; i < uuids.length; i += MEMBERS_PER_ADD) {
    const res = await api.addChannelMembers(wsId, channelId, uuids.slice(i, i + MEMBERS_PER_ADD));
    added.push(...(res.added || []));
  }
  return added;
}

function nobodyAddedWords(uuids) {
  const gone = uuids.filter((u) => !store.ws?.members?.[u]).length;
  if (!gone) return 'Everyone was already in the channel';
  if (gone === uuids.length) return uuids.length === 1 ? 'Nobody was added: they are no longer in this workspace' : 'Nobody was added: none of them are in this workspace any more';
  return 'Nobody was added: some are no longer in this workspace, and the rest were already in the channel';
}

/* ---- channels ------------------------------------------------------------ */

/**
 * Is leaving this channel offered to the member at all? Not a default
 * channel, not one they are not in, and not a guest's only channel: a guest
 * is in the workspace for the channels they were let into and can join none
 * on their own, so out of the last of them they would be a guest of nothing,
 * and the worker refuses (last_channel) with what to do instead. The door is
 * not offered rather than offered and then refused.
 */
export function leaveOffered(channel) {
  if (!channel || channel.def || !store.isJoined(channel.id)) return false;
  if (store.isGuest() && !(store.me?.channels || []).some((c) => c !== channel.id && store.channel(c))) return false;
  return true;
}

/** Leave a channel after confirming; lands on the first remaining channel. */
export async function leaveChannelFlow(channel) {
  // The last one in a private channel cannot leave it: nobody, admins
  // included, could reach the channel again, so the worker refuses. Said
  // here, in place of a question whose answer would only be refused. Not
  // for a guest: they can neither add anyone to the channel nor delete it,
  // so held in they were stuck in a channel nobody else could reach, and the
  // worker lets them go; the channel is then listed to admins for deletion.
  // (Someone from a connected workspace is in shared channels alone, which
  // never come this way.)
  if (channel.private && !channel.shared && !store.isGuest() && Array.isArray(channel.members) && !channel.members.some((u) => u !== store.uuid)) {
    toast(`You are the last person in #${channel.name}; add someone before you leave, or delete the channel`, { icon: 'alert' });
    return false;
  }
  const ok = await confirmDialog({
    title: `Leave #${channel.name}?`,
    message: channel.shared && channel.lost?.code === 'removed' ? `An admin of ${channel.shared.host || 'the workspace that hosts it'} removed you from it, so there is nothing left to read here; leaving takes it out of your sidebar.`
      : channel.shared && channel.lost ? 'It is no longer shared with this workspace, so there is nothing left to read here; leaving takes it out of your sidebar.'
      : channel.shared ? `You leave the channel on ${channel.shared.host || 'the workspace that hosts it'} too. You can rejoin from Browse channels.`
        // A guest cannot browse channels or be let back in by the channel's members.
        : store.isGuest() ? 'An admin will have to add you back.'
          : channel.private ? 'Someone in the channel will have to add you back.' : 'You can rejoin from Browse channels.',
    confirmLabel: 'Leave',
  });
  if (!ok) return false;
  try {
    await store.leaveChannel(channel.id);
    toast(`Left #${channel.name}`);
    // The reader moves on, to the first channel they are still in, only when
    // the channel left is the one on screen (its messages, or a thread of
    // them): left from a sidebar row's menu while reading elsewhere, what
    // they were reading stays where it is.
    if (parseHash(location.hash).conv === channel.id) navigate({ ws: store.wsId, conv: store.joinedChannels()[0]?.id });
    return true;
  } catch (e) {
    toast(e.message, { icon: 'alert' });
    return false;
  }
}

/**
 * What to say when store.joinChannel threw. Joined here all the same, when
 * the channel is hosted elsewhere and its host did not answer (the store
 * keeps such a join, since the channel opens when the host does, and undoes
 * it only for a refusal): the network's own words ("Failed to fetch") read
 * as the join having failed over a channel now in the sidebar. Otherwise
 * the refusal's words, or that the connection has ended.
 */
export function joinFailed(channel, e) {
  if (store.isJoined(channel.id)) {
    if (channel.shared) toast(`Joined #${channel.name} here. ${channel.shared.host || 'The workspace that hosts it'} could not be reached; the channel opens when it answers.`, { icon: 'info', duration: 6000 });
    else toast(`Joined #${channel.name}`);
    return;
  }
  toast(e?.code === 'connection_ended' ? 'This channel is no longer shared with your workspace' : e?.message || 'Could not join the channel', { icon: 'alert' });
}

export function createChannelDialog() {
  const nameInput = el('input.input', { placeholder: 'e.g. design-reviews', maxlength: LIMITS.channelName, autocapitalize: 'off', spellcheck: false });
  const topicInput = el('input.input', { placeholder: 'What is this channel about?', maxlength: LIMITS.channelTopic });
  const nameHint = 'Lowercase letters, numbers, hyphens, and underscores.';
  const nameField = field('Name', el('div.input-prefix', {}, el('span', { html: icon('hash', 16) }), nameInput), nameHint);
  let isPrivate = false;
  const privacy = switchRow({
    label: 'Make private', sub: 'Only invited people can find and join',
    checked: false, onChange: (v) => { isPrivate = v; },
  });
  const submit = el('button.btn.btn-primary', { type: 'submit' }, 'Create channel');
  const form = el('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      const name = cleanChannelName(nameInput.value);
      if (!name) return nameField.showError('Give the channel a name');
      // The name is fine now: a word left under it by an earlier press (an
      // empty name) came off only when the name was faulted again, so it
      // stood over a good name beside the toast for a failure of another
      // kind (the network, the workspace full).
      nameField.showError('');
      const done = busy(submit, 'Creating');
      try {
        const { channel } = await api.createChannel(store.wsId, { name, topic: topicInput.value.trim(), private: isPrivate });
        await store.refreshAfterChange();
        modal.close();
        toast(`Created #${channel.name}`);
        navigate({ ws: store.wsId, conv: channel.id });
        // The next step: the channel exists, now put
        // people in it (or skip; the channel is already usable).
        addPeopleToChannelDialog(store.ws?.channels?.[channel.id] || channel, { created: true });
      } catch (err) {
        done();
        // A problem with the name belongs under the name; anything else
        // (a policy, the workspace being full, the network) does not.
        if (err.code === 'invalid' || err.code === 'exists') nameField.showError(err.message);
        else toast(err.message, { icon: 'alert' });
      }
    },
  },
  nameField,
  field('Topic (optional)', topicInput),
  privacy,
  el('div.modal-actions', {}, el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'), submit));
  previewChannelName(nameInput, nameField, nameHint);
  const modal = openModal({ title: 'Create a channel', content: form });
}

/**
 * Put people into a channel in one move, offered right after creating one
 * (as the second step) and from the channel intro. A public channel offers
 * the whole workspace at once; a private one takes specific people. In a
 * workspace with nobody else yet, the useful next step is inviting people at
 * all, so that is what it offers instead.
 */
export function addPeopleToChannelDialog(channel, { created = false } = {}) {
  const wsName = store.ws?.name || 'this workspace';
  const already = new Set([...(channel.members || []), store.uuid]);
  // Only an admin adds a guest to a public channel; the worker drops a guest a
  // member picks there, silently. Keep them out of the picker in that case, so
  // "Specific people" cannot offer someone the request will quietly refuse —
  // the "Everyone" list already leaves guests out.
  if (!channel.private && !store.isAdmin()) {
    for (const [uuid, m] of Object.entries(store.ws?.members || {})) if (m.role === 'guest') already.add(uuid);
  }
  const candidates = Object.entries(store.ws?.members || {})
    .filter(([uuid, m]) => !already.has(uuid) && m.role !== 'guest' && m.role !== 'external')
    .map(([uuid]) => uuid);
  if (!candidates.length) {
    // Nobody to add. Either the workspace has no one else yet — the useful
    // next step is inviting people at all (offered to admins, the ones who
    // can) — or everyone who could is already in the channel. Both used to
    // dead-end: a public channel showed a non-admin nothing at all, and a
    // private one opened a picker onto an empty list ("Nobody matches") with
    // a permanently disabled Add. Now each says what is going on.
    const admin = store.isAdmin();
    const hasOthers = Object.entries(store.ws?.members || {}).some(([uuid, m]) => uuid !== store.uuid && m.role !== 'guest' && m.role !== 'external');
    const content = el('div', {},
      el('p.muted', {}, hasOthers
        ? `Everyone in ${wsName} is already in #${channel.name}.`
        : admin
          ? `Nobody else is in ${wsName} yet. Invite people, and #${channel.name} is here waiting for them.`
          : `Nobody else is in ${wsName} yet. Ask an admin to invite people, and #${channel.name} is here waiting for them.`),
      // Everyone here is in already; the one person left to add is someone
      // from outside. (With nobody else here at all, "Invite people" below
      // is the step, and a second invitation beside it would only compete.)
      hasOthers && guestInviteFoot(channel, () => modal.close()),
      el('div.modal-actions', {},
        el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, hasOthers ? 'Done' : 'Not now'),
        !hasOthers && admin && el('button.btn.btn-primary', { type: 'button', html: icon('userPlus', 16), onclick: () => { modal.close(); inviteDialog(); } }, ' Invite people')));
    const modal = openModal({ title: `Add people to #${channel.name}`, content });
    return;
  }
  let mode = channel.private ? 'some' : 'all';
  const submit = el('button.btn.btn-primary', { type: 'button' }, 'Add');
  const picker = peoplePicker({
    exclude: already, externals: false,
    onChange: (sel) => { submit.disabled = mode === 'some' && !sel.size; },
  });
  picker.el.hidden = mode !== 'some';
  const count = candidates.length;
  const choice = channel.private ? null : choiceRow({
    label: 'Who joins now', value: mode,
    options: [
      ['all', `Everyone in ${wsName}`, `${count} ${count === 1 ? 'person joins' : 'people join'} right away`],
      ['some', 'Specific people'],
    ],
    onChange: (v) => {
      mode = v;
      picker.el.hidden = v !== 'some';
      submit.disabled = v === 'some' && !picker.selected.size;
    },
  });
  submit.disabled = mode === 'some';
  submit.addEventListener('click', async () => {
    const uuids = mode === 'all' ? candidates : [...picker.selected];
    const done = busy(submit, 'Adding');
    try {
      const added = (await addMembersInBatches(channel.id, uuids)).length;
      await store.refreshAfterChange();
      modal.close();
      toast(added ? `Added ${added === 1 ? 'one person' : `${added} people`} to #${channel.name}` : nobodyAddedWords(uuids));
    } catch (err) {
      done();
      toast(err.message, { icon: 'alert' });
    }
  });
  const content = el('div', {},
    el('p.small.muted', { style: { marginBottom: '12px' } }, channel.private
      ? 'It is private: only the people you add can find and read it.'
      : 'They see it in their sidebar right away; anyone in the workspace can also join on their own.'),
    choice, picker.el,
    guestInviteFoot(channel, () => modal.close()),
    el('div.modal-actions', {},
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, created ? 'Skip for now' : 'Cancel'),
      submit));
  const modal = openModal({ title: `Add people to #${channel.name}`, content });
}

export function editChannelDialog(channel) {
  // Any member of the channel edits its topic and description (see
  // canCurate), so the dialog opens for them on the default channel too;
  // its name is an admin's to change (the worker's rule).
  const locked = channel.def && !store.isAdmin();
  const nameInput = el('input.input', { value: channel.name, maxlength: LIMITS.channelName, autocapitalize: 'off', spellcheck: false, disabled: locked });
  const topicInput = el('textarea.textarea', { value: channel.topic || '', maxlength: LIMITS.channelTopic, rows: 2, placeholder: 'What is being talked about right now?' });
  topicInput.value = channel.topic || '';
  const descInput = el('textarea.textarea', { maxlength: LIMITS.channelDescription, rows: 3, placeholder: 'What is this channel for?' });
  descInput.value = channel.description || '';
  // Under a box that is off, why it is, where the naming rule would stand:
  // a disabled box says nothing of itself, and the rule under it read as if
  // the box were theirs to type in.
  const editHint = locked ? 'Only an admin can rename the default channel.' : 'Lowercase letters, numbers, hyphens, and underscores.';
  const nameField = field('Name', el('div.input-prefix', {}, el('span', { html: icon('hash', 16) }), nameInput), editHint);
  const submit = el('button.btn.btn-primary', { type: 'submit' }, 'Save');
  // Posting rules are an admin decision; members only see name and topic.
  let postPolicy = channel.postPolicy || 'members';
  let threadPolicy = channel.threadPolicy || 'everyone';
  const broadcastDefault = channel.broadcast || (channel.def ? 'admins' : 'everyone');
  let broadcast = broadcastDefault;
  const admin = store.isAdmin();
  const policies = admin && !channel.archived ? el('div', {},
    choiceRow({
      label: 'Who can post', value: postPolicy,
      options: [['members', 'Everyone in the channel'], ['admins', 'Admins only', 'For announcements: everyone reads and reacts, admins write']],
      onChange: (v) => { postPolicy = v; },
    }),
    choiceRow({
      label: 'Who can use @channel and @here', value: broadcast,
      options: [['everyone', 'Everyone in the channel'], ['admins', 'Admins only', channel.def ? 'The default for #general, where @everyone also works' : 'Keeps a busy channel from being paged by anyone']],
      onChange: (v) => { broadcast = v; },
    }),
    choiceRow({
      label: 'Thread replies', value: threadPolicy,
      options: [['everyone', 'Everyone in the channel'], ['admins', 'Admins only'], ['off', 'Off', 'No threads under messages here']],
      onChange: (v) => { threadPolicy = v; },
    })) : null;
  const form = el('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      const name = cleanChannelName(nameInput.value);
      if (!name) return nameField.showError('Give the channel a name');
      nameField.showError(''); // the name is fine now: no word from an earlier press stands under it (see createChannelDialog)
      const done = busy(submit, 'Saving');
      try {
        // Only what changed here: a topic written back as it was read would
        // undo one another curator set meanwhile, and a save with nothing
        // changed still made every member refetch the workspace.
        const patch = {};
        if (topicInput.value.trim() !== (channel.topic || '')) patch.topic = topicInput.value.trim();
        if (descInput.value.trim() !== (channel.description || '')) patch.description = descInput.value.trim();
        if (name !== channel.name) patch.name = name;
        if (admin && postPolicy !== (channel.postPolicy || 'members')) patch.postPolicy = postPolicy;
        if (admin && threadPolicy !== (channel.threadPolicy || 'everyone')) patch.threadPolicy = threadPolicy;
        if (admin && broadcast !== broadcastDefault) patch.broadcast = broadcast;
        // Nothing changed (the name retyped as it was, a space added to the
        // topic): closed as Cancel closes. Sent, the empty patch was a no-op
        // the worker answered without writing, and the dialog had the
        // workspace read again and said "Channel updated" over no change.
        if (!Object.keys(patch).length) {
          done();
          modal.close();
          return;
        }
        await api.updateChannel(store.wsId, channel.id, patch);
        await store.refreshAfterChange();
        modal.close();
        toast('Channel updated');
      } catch (err) {
        done();
        if (err.code === 'invalid' || err.code === 'exists') nameField.showError(err.message);
        else toast(err.message, { icon: 'alert' });
      }
    },
  },
  nameField,
  field('Topic', topicInput, 'Shown in the header; what is going on right now.'),
  field('Description', descInput, 'Shown in the channel details and at the very beginning of the channel.'),
  policies,
  el('div.modal-actions', {}, el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'), submit));
  // Enter in the topic saves, as Enter in the name does: the topic is shown
  // on one line, in the header and in the details, and its box took Enter
  // for a line break, so a topic confirmed with Enter sat unsaved with a
  // break in it. Shift+Enter still breaks a line; an input method's Enter
  // takes the candidate. The description is a paragraph and keeps Enter.
  topicInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || composing(e)) return;
    e.preventDefault();
    // Not while the save is out. The button is disabled meanwhile (see
    // busy), which keeps Enter in the name box from sending the form again:
    // a form is not submitted implicitly through a disabled button. A form
    // asked to submit by name makes no such check, so a second Enter here
    // sent the same save a second time, and a second "Channel updated" came
    // after the first.
    if (submit.disabled) return;
    if (typeof form.requestSubmit === 'function') form.requestSubmit();
    else form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  previewChannelName(nameInput, nameField, editHint);
  const modal = openModal({ title: `Edit #${channel.name}`, content: form });
}

/** Name (or rename) a sidebar section; resolves to the name, or null when dismissed. */
/**
 * One text value asked for in a dialog, a line or a paragraph, in place of
 * the browser's prompt(): styled, multi-line where the text is, with a
 * length limit and Escape to cancel. Resolves the trimmed text, or null.
 */
export function textDialog({ title, label = 'Text', initial = '', confirmLabel = 'Save', multiline = false, maxlength = 200, hint = null, placeholder = '', required = 'Write something first' } = {}) {
  return new Promise((resolve) => {
    let result = null;
    const input = multiline
      ? el('textarea.textarea', { rows: 4, maxlength, placeholder, 'aria-label': label })
      : el('input.input', { type: 'text', maxlength, placeholder, autocomplete: 'off' });
    input.value = initial;
    const box = field(label, input, hint);
    const submit = el('button.btn.btn-primary', { type: 'submit' }, confirmLabel);
    const form = el('form', {
      onsubmit: (e) => {
        e.preventDefault();
        const value = input.value.trim();
        if (!value) return box.showError(required);
        result = value;
        modal.close();
        return undefined;
      },
    }, box, el('div.modal-actions', {}, el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'), submit));
    // In a paragraph, Enter saves and Shift+Enter breaks a line, as in the composer.
    if (multiline) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !composing(e)) {
          e.preventDefault();
          form.requestSubmit();
        }
      });
    }
    const modal = openModal({ title, content: form, onClose: () => resolve(result) });
    setTimeout(() => {
      input.focus();
      if (multiline) input.setSelectionRange(input.value.length, input.value.length);
      else input.select();
    }, 0);
  });
}

/** How many sections a reader may make for one workspace's sidebar: each is a line of it (see sectionNameDialog). */
export const MAX_SECTIONS = 20;

/**
 * The name for a new section, or a new name for one (`rename`). A name
 * another section has, however it is cased, is refused, since two sections
 * called the same could be told apart neither in the sidebar nor in a row's
 * "Move to" menu; a rename may keep the section's own name, in any case. At
 * the cap a new section is refused as the dialog opens, said in it.
 */
export function sectionNameDialog({ title = 'Create a new section', initial = '', confirmLabel = 'Create', rename = false } = {}) {
  return new Promise((resolve) => {
    let result = null;
    const input = el('input.input', { value: initial, maxlength: 40, placeholder: 'e.g. Projects, Customers, Reading', autocomplete: 'off' });
    const nameField = field('Name', input, 'Sections are yours alone: they order your sidebar and nobody else sees them.');
    const submit = el('button.btn.btn-primary', { type: 'submit' }, confirmLabel);
    const full = !rename && store.sections().length >= MAX_SECTIONS;
    const fullNote = `You have ${MAX_SECTIONS} sections, the most there can be. Delete one to make room.`;
    const own = String(initial).trim().toLowerCase();
    const taken = (name) => store.sections().find((s) => s.name.toLowerCase() === name.toLowerCase() && s.name.toLowerCase() !== own);
    const form = el('form', {
      onsubmit: (e) => {
        e.preventDefault();
        const name = input.value.trim();
        if (full) return nameField.showError(fullNote);
        if (!name) return nameField.showError('Give the section a name');
        const other = taken(name);
        if (other) return nameField.showError(`There is already a section called “${other.name}”`);
        result = name;
        modal.close();
        return undefined;
      },
    }, nameField, el('div.modal-actions', {}, el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'), submit));
    const modal = openModal({ title, content: form, onClose: () => resolve(result) });
    setTimeout(() => {
      input.focus();
      input.select();
      if (full) nameField.showError(fullNote);
    }, 0);
  });
}

export function browseChannelsDialog() {
  const body = el('div');
  const search = el('input.input', { type: 'search', placeholder: 'Search channels', 'aria-label': 'Search channels' });
  const list = el('div.pick-list', { role: 'list' });

  // Redrawn in place (a Join pressed, a change from the poll): the control
  // under the keyboard is found again by its label, or focus would fall to
  // the document with the dialog still open. Over the whole body: the
  // private channels nobody is left in are listed under the public ones, in
  // a box of their own, and a Delete pressed there is redrawn too.
  function render() {
    keepFocus(body, draw);
  }
  function draw() {
    // A name typed the way the app writes it ("#ops") finds the channel, as
    // it does in the sidebar's filter and the directory: the leading mark is
    // not part of any name.
    const q = normalize(search.value.trim().replace(/^[#@]+/, ''));
    const joined = new Set(store.me?.channels || []);
    // The channels the member is in (public, open ones) and the ones they
    // could join, as the store lists them: the rows offering Join are then
    // the ones the count beside "Browse channels" and the sidebar's filter
    // offer, and an entry for a channel hosted elsewhere whose connection is
    // over is not offered (the host would only refuse; see
    // browsableChannels), while one the member is in is still here to open.
    const all = [...store.joinedChannels().filter((c) => !c.private && !c.archived), ...store.browsableChannels()]
      .filter((c) => !q || c.name.includes(q) || normalize(c.topic).includes(q))
      .sort((a, b) => Number(joined.has(a.id)) - Number(joined.has(b.id)) || a.name.localeCompare(b.name));
    list.replaceChildren(...all.map((c) => {
      const isIn = joined.has(c.id);
      const action = el(`button.btn.btn-sm.${isIn ? 'btn-ghost' : 'btn-outline'}`, {
        type: 'button', 'aria-label': `${isIn ? 'Open' : 'Join'} #${c.name}`,
        onclick: async () => {
          if (isIn) {
            modal.close();
            navigate({ ws: store.wsId, conv: c.id });
            return;
          }
          const done = busy(action, 'Joining');
          try {
            await store.joinChannel(c.id);
            modal.close();
            toast(`Joined #${c.name}`);
            navigate({ ws: store.wsId, conv: c.id });
          } catch (err) {
            // Joined here all the same when the channel is hosted elsewhere
            // and its host did not answer (the store keeps such a join; see
            // joinFailed): the channel is in the sidebar now, and this row
            // is not drawn again while the dialog stands, so a Join left
            // live over it, with the network's words beside, read as a join
            // that had failed. It goes as a join that went through goes.
            if (store.isJoined(c.id)) {
              modal.close();
              joinFailed(c, err);
              navigate({ ws: store.wsId, conv: c.id });
              return;
            }
            done();
            joinFailed(c, err);
          }
        },
      }, isIn ? 'Open' : 'Join');
      return el('div.pick-item', { role: 'listitem' },
        el('span', { html: icon(channelIcon(c), 18), style: { color: 'var(--ink-3)' }, title: c.lost ? 'No longer shared with this workspace' : c.postPolicy === 'admins' ? 'Only admins post here' : c.shared ? `Hosted by ${c.shared.host}` : null }),
        el('span.pick-text', {}, el('strong', {}, c.name, c.postPolicy === 'admins' && el('span.pill.pill-inline', {}, 'Admins post'), c.shared && el('span.pill.pill-org.pill-inline', {}, c.shared.host || 'Shared')),
          el('span', {}, c.lost ? 'No longer shared with this workspace' : c.topic || (c.shared ? `Shared with your workspace by ${c.shared.host || 'another workspace'}` : `${c.count || 0} member${c.count === 1 ? '' : 's'}`))),
        action);
    }));
    if (!all.length) list.append(el('div.empty', {}, el('p', {}, q ? 'No channels match' : 'No public channels yet')));
    drawOrphans(q);
  }
  // Private channels nobody is left in: the workspace lists them to admins
  // (and to nobody else) for the one thing that can be done with them, which
  // is deleting them, since nothing can open them and their history would
  // otherwise sit in the owner's store for good. Under the public list, each
  // with the lock, its name, why it is here, and Delete.
  const orphanBox = el('div.orphan-channels', { hidden: true });
  function drawOrphans(q) {
    const orphans = store.isAdmin() ? store.orphanChannels().filter((c) => !q || normalize(c.name).includes(q)) : [];
    orphanBox.hidden = !orphans.length;
    if (!orphans.length) { orphanBox.replaceChildren(); return; }
    orphanBox.replaceChildren(
      el('h3.field-label', { style: { margin: '18px 0 8px' } }, 'Private channels nobody is left in'),
      el('div.pick-list', { role: 'list', 'aria-label': 'Private channels nobody is left in' }, ...orphans.map((c) => {
        // Busy, not disabled, while the question is up and the worker
        // answers: a disabled button under the keyboard hands its focus to
        // the page body, and a Cancel left the keyboard on nothing.
        const del = el('button.btn.btn-sm.btn-danger', {
          type: 'button', 'aria-label': `Delete #${c.name}`,
          onclick: async () => {
            if (del.getAttribute('aria-busy') === 'true') return;
            del.setAttribute('aria-busy', 'true');
            try {
              if (await deleteOrphanChannelFlow(c)) render();
            } finally {
              del.removeAttribute('aria-busy');
            }
          },
        }, 'Delete');
        return el('div.pick-item', { role: 'listitem' },
          el('span', { html: icon('lock', 18), style: { color: 'var(--ink-3)' } }),
          el('span.pick-text', {}, el('strong', {}, c.name), el('span.pick-wrap', {}, 'Nobody is in this channel; its last member left the workspace.')),
          del);
      })));
  }
  search.addEventListener('input', render);
  body.append(el('div.field', {}, search), list, orphanBox,
    el('div.modal-actions', { style: { justifyContent: 'space-between' } },
      el('button.btn.btn-ghost', { type: 'button', html: icon('plus', 16), onclick: () => { modal.close(); createChannelDialog(); } }, ' Create a channel'),
      el('button.btn', { type: 'button', onclick: () => modal.close() }, 'Done')));
  const modal = openModal({ title: 'Browse channels', content: body });
  render();
}

/**
 * Delete a private channel nobody is left in, after asking: the one thing an
 * admin can do with it (the worker refuses everything else for it). Answers
 * whether it went; a refusal or a failure is said in a toast and leaves the
 * caller's row as it was.
 */
export async function deleteOrphanChannelFlow(ch) {
  const ok = await confirmDialog({
    title: `Delete #${ch.name}?`,
    message: 'Nobody can open it any more: its last member left the workspace. Its messages and files are removed for good.',
    confirmLabel: 'Delete',
  });
  if (!ok) return false;
  try {
    await api.deleteChannel(store.wsId, ch.id);
    await store.refreshAfterChange();
    toast(`#${ch.name} deleted`, { icon: 'trash' });
    return true;
  } catch (e) {
    toast(e.message, { icon: 'alert' });
    return false;
  }
}

/**
 * Multi-select people picker shared by DMs and private channel invites.
 * People from connected workspaces are labelled with theirs, and left out
 * (`externals: false`) where they cannot go: they are in the channel shared
 * with their workspace and nowhere else.
 */
function peoplePicker({ exclude = new Set(), max = Infinity, guestsOnly = false, externals = true, onChange }) {
  const selected = new Set();
  const search = el('input.input', { type: 'search', placeholder: 'Search people', 'aria-label': 'Search people' });
  const chips = el('div.chips', { style: { marginBottom: '10px' } });
  const list = el('div.pick-list', { role: 'listbox', 'aria-multiselectable': 'true', 'aria-label': 'People' });
  // The arrows step through the people, Home and End to the first and the
  // last, as through any list (the listbox pattern); Tab still walks them
  // one by one as before. A long list had only Tab, a press per person.
  listKeyNav(list, '.pick-item');

  function people() {
    // Read as search reads names (lowercase, accents and other marks
    // stripped, see shared/search.js): "jose" finds José, as the mention list
    // does; and "@ana" finds her as "ana" does, the leading mark being no
    // part of a name (the sidebar's and the directory's rule).
    const q = normalize(search.value.trim().replace(/^[#@]+/, ''));
    return Object.entries(store.ws?.members || {})
      .map(([uuid, m]) => ({ uuid, ...m }))
      .filter((m) => !exclude.has(m.uuid))
      .filter((m) => !guestsOnly || m.role === 'guest')
      .filter((m) => externals || m.role !== 'external')
      .filter((m) => !q || normalize(m.name).includes(q) || normalize(m.username).includes(q) || normalize(m.org?.name).includes(q))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  function render() {
    rerender(chips, ...[...selected].map((uuid) => {
      const m = store.member(uuid);
      return el('span.chip', {}, m.name, el('button', {
        type: 'button', html: icon('x', 14, 2.4), 'aria-label': `Remove ${m.name}`,
        // The second click of a double click is not another removal: the
        // chips close up as the first takes its person, and it landed on the
        // next chip's Remove (the message box's chips keep the same rule).
        onclick: (e) => { if (e.detail > 1) return; selected.delete(uuid); render(); onChange?.(selected); },
      }));
    }));
    // The last chip removed from the keyboard leaves no chip to land on: the
    // search box, then, where there is a keyboard to Tab from. Not on a
    // phone: a tap focuses nothing there, so the focus stands on the page
    // body after every pick, and a focused search box would raise the
    // on-screen keyboard over the list at each tap (the composer's chips
    // make the same exception).
    if (document.activeElement === document.body && !coarsePointer()) search.focus({ preventScroll: true });
    chips.hidden = !selected.size;
    // Nobody more can be picked once the cap is reached (a direct message
    // takes eight): the rest are dimmed and inert, and stay in the arrows'
    // walk (the listbox pattern, as a menu item that cannot be used stays
    // in the menu's). Disabled buttons, they looked as live as the others,
    // lit under the pointer, took no press without a word, and the arrows
    // stuck on the last picked person, since a disabled button cannot take
    // the keyboard.
    const full = selected.size >= max;
    rerender(list, ...people().map((m) => el('button.pick-item', {
      type: 'button', role: 'option', 'aria-checked': String(selected.has(m.uuid)), 'aria-selected': String(selected.has(m.uuid)),
      'aria-disabled': !selected.has(m.uuid) && full ? 'true' : null,
      onclick: () => {
        if (!selected.has(m.uuid) && full) return;
        if (selected.has(m.uuid)) selected.delete(m.uuid);
        else selected.add(m.uuid);
        render();
        onChange?.(selected);
      },
    },
    avatar(m, { size: 'sm', state: store.presenceOf(m.uuid) }),
    el('span.pick-text', {}, el('strong.name-line', {}, el('span.name-text', { dir: 'auto' }, m.name), (m.role === 'guest' || m.role === 'external') && rolePill(m.uuid, { compact: true }), statusChip(m.uuid, { compact: true })), el('span', {}, m.title || `@${m.username}`)),
    el('span.pick-check', { html: icon('check', 14, 3) }))));
    if (!list.children.length) list.append(el('div.empty', {}, el('p', {}, 'Nobody matches')));
  }
  search.addEventListener('input', render);
  render();
  return { el: el('div', {}, el('div.field', {}, search), chips, list), selected };
}

/**
 * Under a picker of the workspace's own people, the way to bring in someone
 * who is not in the workspace at all: a guest invite to this channel, which
 * the guest dialog mints and emails. Admins only (they are the ones who can
 * mint one), and never for a channel that takes no guests: a default channel
 * (guests are invited to a single channel, and a default is every member's),
 * an archived one, or one hosted by another workspace. `close` shuts the
 * dialog this sits in before the guest dialog opens over the same spot.
 */
function guestInviteFoot(channel, close) {
  if (!store.isAdmin() || channel.def || channel.archived || channel.shared) return null;
  return el('div.row', { style: { marginTop: '12px', gap: '8px', flexWrap: 'wrap', alignItems: 'center' } },
    el('span.small.muted', {}, `Someone who is not in ${store.ws?.name || 'this workspace'}?`),
    el('button.btn.btn-ghost.btn-sm', {
      type: 'button', html: icon(emailAvailable() ? 'mail' : 'link', 15),
      onclick: () => { close(); guestInviteDialog(channel, { tab: 'email' }); },
    }, emailAvailable() ? ' Invite them as a guest by email' : ' Invite them as a guest'));
}

export function addChannelMembersDialog(channel, { guestsOnly = false, exclude = [] } = {}) {
  return new Promise((resolve) => {
    const already = new Set([...(channel.members || []), ...exclude]);
    const submit = el('button.btn.btn-primary', { type: 'button', disabled: true }, 'Add');
    // People from connected workspaces are never added to another channel (the worker would drop them quietly).
    const picker = peoplePicker({ exclude: already, guestsOnly, externals: false, onChange: (sel) => { submit.disabled = !sel.size; } });
    submit.addEventListener('click', async () => {
      const done = busy(submit, 'Adding');
      try {
        const picked = [...picker.selected];
        const added = await addMembersInBatches(channel.id, picked);
        await store.refreshAfterChange();
        modal.close();
        toast(added.length ? `Added ${added.length} ${added.length === 1 ? 'person' : 'people'}` : nobodyAddedWords(picked));
      } catch (err) {
        done();
        toast(err.message, { icon: 'alert' });
      }
    });
    const content = el('div', {}, picker.el,
      guestInviteFoot(channel, () => modal.close()),
      el('div.modal-actions', {}, el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'), submit));
    const modal = openModal({ title: guestsOnly ? `Add guests to #${channel.name}` : `Add people to #${channel.name}`, content, onClose: () => resolve() });
  });
}

/* ---- times --------------------------------------------------------------- */

/**
 * Pick a date and time in the user's own zone. Resolves the epoch ms, or
 * null when dismissed. Says plainly how delivery works; `verb` is what
 * happens at that time ("Sends" a message, "Reminds you" of one).
 */
/** How far ahead the worker takes a scheduled message or a reminder (its SCHED_HORIZON_MS): "more than a year away" is refused. */
const SCHED_HORIZON_MS = 400 * 86400_000;

export function pickTimeDialog({ title = 'Pick a time', initial = Date.now() + 3600_000, confirmLabel = 'Schedule', note = DELIVERY_NOTE, verb = 'Sends' } = {}) {
  return new Promise((resolve) => {
    const input = el('input.input', { type: 'datetime-local', value: toLocalInput(initial), min: toLocalInput(Date.now()), max: toLocalInput(Date.now() + SCHED_HORIZON_MS), step: 60 });
    const f = field('Date and time', input, `Your local time, ${Intl.DateTimeFormat().resolvedOptions().timeZone || 'this device\u2019s zone'}.`);
    const preview = el('p.small.muted', { role: 'status' });
    const update = () => {
      const t = new Date(input.value).getTime();
      preview.textContent = Number.isFinite(t) ? `${verb} ${aroundText(t)}.` : '';
    };
    input.addEventListener('input', update);
    update();
    const ok = el('button.btn.btn-primary', { type: 'submit' }, confirmLabel);
    const form = el('form', {
      onsubmit: (e) => {
        e.preventDefault();
        const t = new Date(input.value).getTime();
        if (!Number.isFinite(t)) return f.showError('Pick a date and time');
        if (t < Date.now() + 30_000) return f.showError('Pick a time in the future');
        // The worker's own rule, said here under the field rather than as a
        // toast after the dialog has closed and the time must be typed again.
        if (t > Date.now() + SCHED_HORIZON_MS) return f.showError('Pick a time within the next year');
        resolve(t);
        modal.close();
      },
    }, f, preview, note && el('p.field-hint', { style: { marginTop: '8px' } }, note),
    el('div.modal-actions', {}, el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'), ok));
    const modal = openModal({ title, content: form, onClose: () => resolve(null) });
  });
}

/**
 * Forward a message somewhere else, from the share arrow: pick a
 * channel or conversation, add a note if you like, and it is posted as a
 * quote of the original with a link back to it (and its attachments, which
 * belong to the workspace, come along by reference, so long as the target
 * is in it too: a file of one workspace cannot be attached in another, and
 * a message forwarded from a shared channel into a channel here, or the
 * other way round, says its files stayed where they are; the link leads to
 * them). Resolves the target conversation id when sent, null when cancelled.
 */
export function forwardMessageDialog(msg, { permalink, author, conv = null, gone = null }) {
  return new Promise((resolve) => {
    let target = null;
    const files = msg.attachments || [];
    // Where the original's files live: the workspace whose worker holds the
    // conversation it was posted in (a shared channel's host).
    const from = conv ? store.hostRef(conv) : store.wsId;
    const carries = (id) => !files.length || store.hostRef(id) === from;
    const fromName = () => (conv && store.hostOf(conv).link?.ws?.name) || store.ws?.name || 'the workspace they were posted in';
    const search = el('input.input', { type: 'search', placeholder: 'Search channels and people', 'aria-label': 'Search channels and people', autocomplete: 'off' });
    const list = el('div.pick-list', { role: 'listbox', 'aria-label': 'Forward to' });
    // The arrows step through the places, Home and End to the first and the last (the listbox pattern); Tab still walks them as before.
    listKeyNav(list, '.pick-item');
    const note = el('textarea.textarea', { rows: 2, placeholder: 'Add a message, if you like', 'aria-label': 'Your message', maxlength: LIMITS.messageText });
    const submit = el('button.btn.btn-primary', { type: 'button', disabled: true }, 'Forward');

    function options() {
      // "#general" and "@ana" find their conversation as the bare names do (see the sidebar's filter).
      const q = normalize(search.value.trim().replace(/^[#@]+/, ''));
      const hit = (s) => !q || normalize(s).includes(q);
      const channels = store.joinedChannels().filter((c) => !c.archived && store.postAccess(c.id).ok && hit(c.name))
        .map((c) => ({ id: c.id, label: c.name, icon: channelIcon(c) }));
      // Not a direct message with people who have all left the workspace
      // (those the workspace remembers as having left, the rule of the
      // conversation's own box): nothing forwarded there would reach anyone.
      const departed = (d) => d.others.length > 0 && d.others.every((u) => !!store.ws?.former?.[u]);
      const dms = store.dms().filter((d) => !departed(d) && hit(store.dmTitle(d)))
        .map((d) => ({ id: d.id, label: store.dmTitle(d), members: d.others }));
      return [...channels, ...dms];
    }
    function render() {
      rerender(list, ...options().map((o) => el('button.pick-item', {
        type: 'button', role: 'option', 'aria-selected': String(target === o.id), dataset: { id: o.id },
        onclick: () => { target = o.id; submit.disabled = false; render(); noteFiles(); },
      },
      o.icon ? el('span.pick-emoji', { html: icon(o.icon, 18, 2), style: { color: 'var(--ink-3)' } })
        : o.members.length === 1 ? avatar(store.member(o.members[0]), { size: 'sm' })
          : o.members.length ? groupAvatar(o.members.map((u) => store.member(u)), { size: 'sm' }) : avatar(store.member(store.uuid), { size: 'sm' }),
      el('span.pick-text', {}, el('strong', { dir: 'auto' }, o.label)),
      el('span.pick-check', { html: icon('check', 14, 3) }))));
      if (!list.children.length) list.append(el('div.empty', {}, el('p', {}, 'Nothing matches')));
    }
    search.addEventListener('input', render);
    render();
    // The places follow the workspace while the dialog stands, as the other
    // long-lived dialogs' lists do: a channel the sender leaves meanwhile (or
    // one archived, or closed to them) goes from the list, and the pick with
    // it, so Forward waits for another; picked as it stood at open, the
    // forward went to the worker and came back refused. A pick still there
    // stays picked. Redrawn only when the places themselves have changed
    // (their set, or a name), the way the Guests dialog gates on its guests:
    // the workspace is announced with every poll, and a list drawn afresh
    // each time took the keyboard from the option it was on every few
    // seconds, and flickered under the pointer. When it is redrawn, the
    // keyboard goes back to the option it was on, or, that one gone, to the
    // first, else to the search box; never to the page.
    const placesKey = () => JSON.stringify(options().map((o) => [o.id, o.label]));
    let placesSig = placesKey();
    const off = store.on('workspace', () => {
      const next = placesKey();
      if (next === placesSig) return;
      placesSig = next;
      if (target && !options().some((o) => o.id === target)) {
        target = null;
        submit.disabled = true;
      }
      const held = list.contains(document.activeElement) ? document.activeElement.closest('.pick-item')?.dataset.id ?? null : null;
      render();
      noteFiles();
      if (held !== null) {
        const again = [...list.querySelectorAll('.pick-item')].find((b) => b.dataset.id === held);
        (again || list.querySelector('.pick-item') || search).focus({ preventScroll: true });
      }
    });

    // Quoted text must not ping anyone again: a zero-width space after each
    // @ keeps the name readable and stops it resolving to a mention.
    const quoted = msg.text ? String(msg.text).replace(/@(?=[a-z0-9])/gi, '@\u200b').split('\n').map((l) => `> ${l}`).join('\n') : '';
    const filesNote = el('p.forward-files-note.small.muted', { hidden: true, role: 'status' });
    const preview = el('div.forward-preview', {},
      el('div.forward-preview-head', {}, el('strong', {}, author.name), el('span.muted.small', {}, relativeLong(msg.ts))),
      // In its own direction, as the message reads in the conversation.
      el('div.forward-preview-text', { dir: 'auto' }, previewWords(msg.text, 240) || `${files.length} file${files.length === 1 ? '' : 's'}`),
      filesNote);
    function noteFiles() {
      const stay = !!target && !carries(target);
      filesNote.hidden = !stay;
      filesNote.textContent = stay ? `${files.length === 1 ? 'The file stays' : `The ${files.length} files stay`} in ${fromName()}; the link in the forwarded message leads to ${files.length === 1 ? 'it' : 'them'}.` : '';
    }

    submit.addEventListener('click', async () => {
      if (!target) return;
      // The message deleted while the dialog stood (`gone`, the caller's
      // word for it): a quote of it, with a link that leads nowhere, is not
      // sent, and the dialog closes on the word.
      if (gone?.()) {
        toast('That message is no longer here; nothing was forwarded', { icon: 'alert' });
        modal.close();
        return;
      }
      const head = note.value.trim();
      const tail = `> \u2014 ${author.name}, ${permalink}`;
      // Everything must fit the message cap with the attribution intact (the
      // worker cuts what does not fit from the end, which is that line): a
      // long note is refused, a long quote gives way and ends in an ellipsis.
      const room = LIMITS.messageText - tail.length - (head ? head.length + 2 : 0) - 1;
      if (room < 40) {
        toast('Your note is too long to fit with the quoted message', { icon: 'alert' });
        return;
      }
      const quote = quoted.length > room ? `${quoted.slice(0, room - 1).replace(/\s+\S*$/, '')}\u2026` : quoted;
      const body = `${quote ? `${quote}\n` : ''}${tail}`;
      const text = head ? `${head}\n\n${body}` : body;
      // The note is a message like any other: an @channel in it is confirmed
      // (or refused where the sender may not broadcast) before it goes, as
      // the composer does. The quote's own mentions were made inert above.
      if (!(await confirmBroadcast(target, text))) return;
      const done = busy(submit, 'Forwarding');
      try {
        await store.send(target, { text, attachments: carries(target) ? files.map(({ id, name, size, type }) => ({ id, name, size, type })) : [] });
        // Answered before the dialog closes: closing runs onClose, which
        // answers null for a dialog dismissed, and a promise answers once,
        // so answered after the close the target was never heard and the
        // caller took the forward for a dismissal.
        resolve(target);
        modal.close();
      } catch (e) {
        done();
        toast(e.message || 'Could not forward', { icon: 'alert' });
      }
    });
    const content = el('div', {},
      el('div.field', {}, search),
      list,
      el('div.field', { style: { marginTop: '12px' } }, note),
      preview,
      el('div.modal-actions', {}, el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'), submit));
    const modal = openModal({ title: 'Forward this message', content, onClose: () => { off(); resolve(null); } });
  });
}

/** A date to jump to; resolves the start of that day in local time, or null. */
export function pickDateDialog({ title = 'Jump to a specific date', confirmLabel = 'Jump' } = {}) {
  return new Promise((resolve) => {
    const today = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const iso = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
    const input = el('input.input', { type: 'date', value: iso, max: iso });
    const f = field('Date', input);
    const form = el('form', {
      onsubmit: (e) => {
        e.preventDefault();
        const [y, m, d] = String(input.value || '').split('-').map(Number);
        if (!y || !m || !d) return f.showError('Pick a date');
        resolve(new Date(y, m - 1, d).getTime());
        modal.close();
      },
    }, f, el('div.modal-actions', {}, el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'), el('button.btn.btn-primary', { type: 'submit' }, confirmLabel)));
    const modal = openModal({ title, content: form, onClose: () => resolve(null) });
  });
}

/* ---- broadcasts ---------------------------------------------------------- */

/**
 * Before a message with @channel, @here or @everyone goes out, say how many
 * people it will notify and ask. Resolves true to send. Skippable with a
 * preference, and the answer is "no" when the sender may not broadcast
 * here, with the reason, rather than a refusal from the worker after the
 * fact.
 */
export async function confirmBroadcast(convId, text) {
  const kind = broadcastKind(extractMentionNames(text));
  if (!kind) return true;
  const access = store.broadcastAccess(convId);
  const ch = store.channel(convId);
  if (!access.channel || (kind === 'everyone' && !access.everyone)) {
    toast(kind === 'everyone' && access.channel
      ? '@everyone only works in the default channel. Use @channel here.'
      : `Only admins can notify everyone in #${ch?.name || 'this channel'}`, { icon: 'alert', duration: 5000 });
    return false;
  }
  if (store.profile?.prefs?.skipBroadcastConfirm) return true;
  const reach = store.broadcastReach(convId, kind);
  const where = kind === 'everyone' ? 'in the workspace' : ch ? `in #${ch.name}` : 'in this conversation';
  const who = kind === 'here' ? `${reach.exact ? '' : 'about '}${reach.count} ${reach.count === 1 ? 'person' : 'people'} active now` : `${reach.count} ${reach.count === 1 ? 'person' : 'people'}`;
  // @here with nobody active reaches nobody: said so, rather than "Notify 0".
  const nobody = kind === 'here' && reach.count === 0;
  return new Promise((resolve) => {
    let skip = false;
    const content = el('div', {},
      el('p', { style: { color: 'var(--ink-2)', marginBottom: '14px', fontSize: '14px' } },
        nobody ? `Nobody is active ${where} right now, so @here will notify no one; the message is posted like any other.`
          : `@${kind} will notify ${who} ${where}, including anyone who muted ${ch ? 'the channel' : 'the conversation'} or is away from Teamchat.`),
      switchRow({ label: 'Don\u2019t ask again', checked: false, onChange: (v) => { skip = v; } }),
      el('div.modal-actions', {},
        el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'),
        el('button.btn.btn-primary', {
          type: 'button',
          onclick: () => {
            if (skip) store.updatePrefs({ skipBroadcastConfirm: true }).catch(() => {});
            resolve(true);
            modal.close();
          },
        }, nobody ? 'Post anyway' : `Notify ${reach.count}`)));
    const modal = openModal({ title: nobody ? 'Nobody to notify' : `Notify everyone ${where}?`, content, onClose: () => resolve(false) });
  });
}

/* ---- direct messages ----------------------------------------------------- */

export function newDmDialog() {
  const submit = el('button.btn.btn-primary', { type: 'button', disabled: true }, 'Go');
  const picker = peoplePicker({
    exclude: new Set([store.uuid]), max: LIMITS.dmMembers - 1,
    onChange: (sel) => { submit.disabled = !sel.size; },
  });
  submit.addEventListener('click', async () => {
    const done = busy(submit, 'Opening');
    try {
      const { conv } = await api.openDm(store.wsId, [...picker.selected]);
      await store.refreshAfterChange();
      modal.close();
      navigate({ ws: store.wsId, conv });
    } catch (err) {
      done();
      toast(err.message, { icon: 'alert' });
    }
  });
  const content = el('div', {},
    el('p.small.muted', { style: { marginBottom: '12px' } }, `Pick up to ${LIMITS.dmMembers - 1} people for a direct message.`),
    picker.el,
    el('div.modal-actions', {}, el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'), submit));
  const modal = openModal({ title: 'New message', content });
}

/** Open (or create) a 1:1 DM with someone, here or on the host of a channel shared with them (in the host itself for a member of both). */
export async function openDmWith(uuid) {
  // The workspace this was asked from, taken before the wait: switched to
  // another meanwhile, the reader stays where they went rather than being
  // pulled back to the one they left. Compared with the remembered
  // workspace, not with the answer's, since a conversation on the host of a
  // shared channel legitimately answers with the host's reference.
  const from = store.wsId;
  try {
    const { ws, conv } = await store.openDmWith(uuid);
    if (store.wsId !== from) return;
    navigate({ ws, conv });
  } catch (err) {
    toast(err.message, { icon: 'alert' });
  }
}

/* ---- member card --------------------------------------------------------- */

export function showMemberCard(uuid, anchor) {
  const m = store.member(uuid);
  const state = store.presenceOf(uuid);
  const lastSeen = store.act.p[uuid];
  const status = store.statusOf(uuid);
  const content = el('div', { style: { padding: '6px', minWidth: '240px' } },
    el('div.row', { style: { alignItems: 'flex-start', gap: '12px' } },
      avatar(m, { size: 'lg', state }),
      // A name or a title of sixty letters and no space wraps within the
      // card rather than running out of it (the card is 320px at most).
      el('div', { style: { minWidth: 0, overflowWrap: 'anywhere' } },
        el('div', { style: { fontWeight: 700, fontSize: '16px' } }, el('span', { dir: 'auto' }, m.name), uuid === store.uuid ? ' (you)' : ''),
        el('div.small.muted', {}, `@${m.username}`),
        m.title && el('div.small', { style: { marginTop: '4px' } }, m.title),
        status && el('div.small', { style: { marginTop: '6px' } }, statusChip(uuid), status.until && el('span.muted', {}, ` · until ${untilText(status.until)}`)),
        el('div.small.muted.presence-line', { style: { marginTop: '4px' } }, el(`span.presence-dot.${state}`),
          m.gone ? 'No longer in this workspace' : state === 'offline' && m.sample && !lastSeen ? 'Sample teammate'
            : state === 'active' || state === 'dnd' ? PRESENCE_LABELS[state] : lastSeen ? `${PRESENCE_LABELS[state]} · last seen ${relativeLong(lastSeen)}` : 'Offline'))),
    el('div.row', { style: { marginTop: '12px', gap: '8px' } },
      uuid !== store.uuid && !m.gone && !m.sample && el('button.btn.btn-primary.btn-sm', {
        type: 'button', html: icon('message', 15), onclick: () => { pop.close(); openDmWith(uuid); },
      }, ' Message'),
      uuid !== store.uuid && m.sample && el('button.btn.btn-primary.btn-sm', {
        type: 'button', html: icon('message', 15), onclick: () => { pop.close(); openDmWith(uuid); },
      }, ' Message'),
      uuid === store.uuid && el('button.btn.btn-sm', { type: 'button', onclick: () => { pop.close(); settingsDialog(); } }, 'Edit profile'),
      rolePill(uuid)));
  const pop = openPopover(anchor, content, { label: `${m.name}` });
}

/* ---- invites & workspace ------------------------------------------------- */

/** How long a code has left, worded the same for every kind of invite: days from two days up, hours below. */
function inviteExpiryText(exp) {
  if (!exp) return 'Never expires';
  const left = exp - Date.now();
  if (left <= 0) return 'Expired';
  const days = Math.ceil(left / 86400000);
  if (days >= 2) return `Expires in ${days} days`;
  const hours = Math.max(1, Math.ceil(left / 3600000));
  return `Expires in ${hours} hour${hours === 1 ? '' : 's'}`;
}

/**
 * A dialog opened straight onto its Email tab is there to take addresses:
 * put the caret in the address box. openModal() found an empty panel when
 * it opened (these dialogs draw after), and its later pass would settle on
 * the first control, which is the tab switch. Phones keep focus on the
 * panel, as every dialog does, so the keyboard does not open over a sheet
 * that is still sliding in.
 */
function focusEmailField(content) {
  if (!matchMedia('(min-width: 640px)').matches) return;
  content.querySelector('textarea')?.focus({ preventScroll: true });
}

/**
 * What to say under the address field when some of a batch did not send.
 * Recipients past the account's daily email budget come back skipped for
 * the daily limit, and "still here to try again" would only meet the same
 * wall on the retry (a 429 then, with this same explanation): they get the
 * budget's own message straight away. Anything else is left in the field
 * to be tried again, as before.
 */
function unsentHint(res, stuck) {
  const capped = (res.results || []).some((r) => r.status === 'skipped' && r.reason === 'daily_limit');
  if (capped) return `${stuck.length === 1 ? `${stuck[0]} was` : `${stuck.join(', ')} were`} not sent: you have sent as many invitation emails as one account can in a day. Try again tomorrow, or share the link directly.`;
  return res.sent
    ? `Could not send to ${stuck.join(', ')} — still here to try again.`
    : 'Those invitations could not be sent. Try again, or copy the link and share it directly.';
}

/**
 * The tabbed part of an invite dialog keeps the height of its taller tab.
 * The panel is centred on a wide screen (and anchored at the bottom on a
 * phone), so a body that grew or shrank with the tab moved the tab strip
 * under the pointer by half the difference, or all of it. The other tab is
 * drawn into a hidden, inert probe alongside, measured, and taken off again;
 * the body then takes at least that height whichever tab shows. Measured
 * rather than fixed: the link tab has two shapes (a link to copy, or the
 * button to make one), and the fonts and widths are the reader's.
 */
function holdTabHeight(body, drawOther) {
  const probe = el('div', { 'aria-hidden': 'true', inert: true, style: { position: 'absolute', left: 0, right: 0, top: 0, visibility: 'hidden', pointerEvents: 'none' } });
  drawOther(probe);
  body.style.position = 'relative';
  body.append(probe);
  const other = probe.offsetHeight;
  probe.remove();
  body.style.minHeight = other ? `${other}px` : '';
}

/**
 * The "Invite link | Email" switch the invite dialogs share (workspace and
 * guest alike). Nothing when the app cannot send email: the link is then the
 * only way, and a switch with one side is no switch.
 */
function inviteTabsRow(tab, onChange) {
  if (!emailAvailable()) return null;
  const seg = el('div.seg', { role: 'radiogroup', 'aria-label': 'How to invite', style: { marginBottom: '14px' } },
    ...[['link', 'link', 'Invite link'], ['email', 'mail', 'Email']].map(([key, ic, label]) => el('button', {
      type: 'button', role: 'radio', 'aria-checked': String(tab === key),
      html: icon(ic, 15, 2),
      onclick: () => { if (tab !== key) onChange(key); },
    }, ` ${label}`)));
  // The row is built anew with the dialog on every switch (keepFocus puts
  // the keyboard back on the radio just chosen), so the roving is set here.
  radioNav(seg);
  return seg;
}

/**
 * Invite people to the workspace two ways: a link to share
 * anywhere, and (when the app's email worker is deployed) email invitations
 * composed and sent for you. `fresh` is the onboarding variant, opened right
 * after creating a workspace.
 */
export function inviteDialog({ fresh = false } = {}) {
  const content = el('div');
  let off = null;
  const modal = openModal({ title: fresh ? 'Invite your teammates' : 'Invite people', content, onClose: () => off?.() });
  let code = store.ws?.invite || null;
  let exp = store.ws?.inviteExp || null;
  let tab = fresh && emailAvailable() ? 'email' : 'link';
  // The Email tab is rebuilt on every redraw (a tab switch, a link rotation),
  // so what was typed lives here rather than on the throwaway inputs.
  let draftEmails = '';
  let draftNote = '';

  const expiryText = () => inviteExpiryText(exp);

  async function rotate(ttl, btn) {
    if (btn.getAttribute('aria-busy') === 'true') return;
    const done = hold(btn, 'Creating');
    try {
      const res = await api.updateWorkspace(store.wsId, { rotateInvite: true, inviteTtl: ttl });
      code = res.workspace.invite;
      exp = res.workspace.inviteExp;
      if (store.ws) Object.assign(store.ws, { invite: code, inviteExp: exp });
      toast(`New invite ready, valid for ${INVITE_TTLS[ttl].label}`);
      render();
    } catch (err) {
      done();
      toast(err.message, { icon: 'alert' });
    }
  }

  function rotateMenu(btn, confirmFirst) {
    if (btn.getAttribute('aria-busy') === 'true') return; // a link is being made from this button already
    openMenu(btn, [
      { header: confirmFirst ? 'New link, valid for' : 'Valid for' },
      ...Object.entries(INVITE_TTLS).map(([key, t]) => ({
        label: t.label, icon: 'link',
        onSelect: async () => {
          if (confirmFirst) {
            const ok = await confirmDialog({ title: 'Replace the invite link?', message: 'The current code and link stop working immediately.', confirmLabel: 'Replace', danger: false });
            if (!ok) return;
          }
          rotate(key, btn);
        },
      })),
    ], { align: 'end', label: 'Invite duration' });
  }

  /** The email needs a live link to carry; mint a month-long one quietly. */
  async function ensureCode() {
    if (code && (!exp || exp > Date.now())) return;
    const res = await api.updateWorkspace(store.wsId, { rotateInvite: true, inviteTtl: '30d' });
    code = res.workspace.invite;
    exp = res.workspace.inviteExp;
    if (store.ws) Object.assign(store.ws, { invite: code, inviteExp: exp });
  }

  function render() {
    keepFocus(content, draw);
  }

  const tabsRow = () => inviteTabsRow(tab, (key) => { tab = key; render(); });

  function drawEmail(into) {
    const emailsInput = el('textarea.textarea', { rows: 3, placeholder: 'ellis@example.com, maria@example.com', autocapitalize: 'off', spellcheck: false, autocomplete: 'off' });
    emailsInput.value = draftEmails;
    emailsInput.addEventListener('input', () => { draftEmails = emailsInput.value; });
    const emailsField = field('Email addresses', emailsInput, 'Up to 10 at a time, separated by commas or new lines.');
    const noteInput = el('input.input', { maxlength: 400, placeholder: 'What to say above the join button' });
    noteInput.value = draftNote;
    noteInput.addEventListener('input', () => { draftNote = noteInput.value; });
    const send = el('button.btn.btn-primary', { type: 'submit', html: icon('send', 15) }, ' Send invitations');
    const form = el('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        const { emails, bad } = parseEmails(emailsInput.value);
        if (bad.length) return emailsField.showError(`Not an email address: ${bad.join(', ')}`);
        if (!emails.length) return emailsField.showError('Add at least one email address');
        if (emails.length > 10) return emailsField.showError('Send to 10 people at a time');
        const done = busy(send, 'Sending');
        try {
          await ensureCode();
          const res = await sendInviteEmails({
            kind: 'workspace', server: parseRef(store.wsId)?.server, code, exp,
            workspace: store.ws?.name, inviter: store.profile?.name || store.profile?.username,
            note: noteInput.value.trim(), emails,
          });
          if (res.sent === emails.length) {
            modal.close();
            toast(`Invitation${res.sent === 1 ? '' : 's'} sent to ${res.sent === 1 ? emails[0] : `${res.sent} people`}`);
            return;
          }
          // Some (or none) went out. Keep the dialog and leave only the
          // addresses that did not send, so the rest can be tried again
          // rather than retyped — as the share dialog's "Or email it" row does.
          done();
          const stuck = (res.results || []).filter((r) => r.status !== 'sent').map((r) => r.email);
          draftEmails = stuck.join(', ');
          emailsInput.value = draftEmails;
          toast(res.sent ? `Sent ${res.sent} of ${emails.length}` : 'Nothing was sent', res.sent ? {} : { icon: 'alert' });
          emailsField.showError(unsentHint(res, stuck));
        } catch (err) {
          done();
          // The send itself failed (the email service, not the addresses), and
          // every such message points at the link to share instead. When a
          // link exists, show it — otherwise, on the email-first onboarding
          // view, the message names a link that is nowhere on screen. The
          // typed addresses are kept, so switching back finds them.
          if (code && tab === 'email') {
            tab = 'link';
            render();
            toast(err.message, { icon: 'alert', duration: 6000 });
          } else {
            emailsField.showError(err.message);
          }
        }
      },
    },
    emailsField,
    field('Add a note (optional)', noteInput, 'Goes into the email, above the join button.'),
    el('p.small.muted', {}, `Each person gets an email with a link to join ${store.ws?.name || 'the workspace'} as a member. For a guest who should see a single channel, use that channel's Members tab instead.`),
    el('div.modal-actions', {},
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, fresh ? 'Skip for now' : 'Cancel'),
      send));
    into.append(form);
  }

  function draw() {
    content.replaceChildren();
    if (!store.isAdmin()) {
      content.append(el('p.muted', {}, 'Only admins can see the invite code. Ask an admin to invite people.'));
      return;
    }
    if (fresh) {
      content.append(el('div.callout', { html: icon('sparkle', 16), style: { marginBottom: '14px' } },
        el('span', {}, 'Teamchat is better with your team here. You can always invite people later, from the workspace menu.')));
    }
    const tabs = tabsRow();
    if (!tabs) {
      drawLink(content);
      return;
    }
    // Both tabs draw into one body under the strip, which keeps the taller
    // tab's height so the strip stands still as they are switched.
    const body = el('div');
    content.append(tabs, body);
    if (tab === 'email') drawEmail(body);
    else drawLink(body);
    holdTabHeight(body, tab === 'email' ? drawLink : drawEmail);
  }

  function drawLink(into) {
    const expired = !!exp && exp <= Date.now();
    if (!code || expired) {
      const btn = el('button.btn.btn-primary', { type: 'button', html: icon('link', 16), 'aria-haspopup': 'menu', onclick: (e) => rotateMenu(e.currentTarget, false) }, ' Create an invite link');
      into.append(
        el('div.callout', { html: icon('info', 16) }, el('span', {}, expired ? 'The previous invite link has expired. Create a new one to invite more people.' : 'Create a link to invite people. Anyone with it can join until it expires.')),
        el('div.row', { style: { marginTop: '14px', justifyContent: 'center' } }, btn),
        el('div.modal-actions', {}, el('button.btn', { type: 'button', onclick: () => modal.close() }, 'Done')));
      return;
    }
    const server = parseRef(store.wsId)?.server;
    const link = inviteLink(server, code);
    const token = makeInviteToken(code, server);
    const copyBtn = (text, label) => {
      const btn = el('button.btn.btn-sm', { type: 'button', 'aria-label': `Copy ${label.toLowerCase()}` }, 'Copy');
      btn.addEventListener('click', async () => {
        // Hold the element: event.currentTarget is null once the click has
        // finished dispatching, which is before the clipboard promise settles.
        try {
          await copyToClipboard(text);
        } catch {
          toast('Could not copy. Select the text and copy it manually', { icon: 'alert' });
          return;
        }
        toast(`${label} copied`);
        btn.textContent = 'Copied';
        setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
      });
      return btn;
    };
    into.append(
      el('p.small.muted', { style: { marginBottom: '14px' } }, 'Anyone with this link or code can join the workspace. Replace it to invalidate old invites.'),
      el('div.field', {},
        el('div.row', { style: { justifyContent: 'space-between' } }, el('span.field-label', {}, 'Invite link'), el('span.pill', {}, expiryText())),
        el('div.code-box', { style: { fontSize: '13px', letterSpacing: 0, fontFamily: 'var(--font)', fontWeight: 500 } },
          el('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, link), copyBtn(link, 'Link'))),
      el('div.field', {}, el('span.field-label', {}, 'Invite code'),
        el('div.code-box', { style: { fontSize: '14px', letterSpacing: '0.02em' } },
          el('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, token), copyBtn(token, 'Code')),
        el('p.field-hint', {}, 'The part after @ names the server this workspace lives on.')),
      el('div.modal-actions', { style: { justifyContent: 'space-between' } },
        el('div.row', {},
          el('button.btn.btn-ghost', {
            type: 'button', html: icon('refresh', 15), 'aria-haspopup': 'menu',
            onclick: (e) => rotateMenu(e.currentTarget, true),
          }, ' Replace'),
          el('button.btn.btn-ghost', {
            type: 'button', html: icon('x', 15),
            onclick: async (e) => {
              const btn = e.currentTarget;
              if (btn.getAttribute('aria-busy') === 'true') return;
              const ok = await confirmDialog({ title: 'Deactivate the invite link?', message: 'Nobody can join with it anymore, and there is no link until an admin creates a new one.', confirmLabel: 'Deactivate' });
              if (!ok) return;
              const done = hold(btn, 'Deactivating');
              try {
                await api.updateWorkspace(store.wsId, { revokeInvite: true });
                code = null;
                exp = null;
                if (store.ws) Object.assign(store.ws, { invite: null, inviteExp: null });
                await store.refreshAfterChange();
                toast('Invite link deactivated');
                render();
              } catch (err) {
                done();
                toast(err.message, { icon: 'alert' });
              }
            },
          }, ' Deactivate')),
        el('button.btn', { type: 'button', onclick: () => modal.close() }, fresh ? 'Skip for now' : 'Done')));
  }
  // A rotate, deactivate, or new link made elsewhere (another admin, another
  // tab) reaches here through the workspace poll: re-sync and redraw only when
  // the invite itself changed, so a stale code is never left on screen to be
  // copied — but an unrelated workspace change does not rebuild a half-typed
  // email form.
  off = store.on('workspace', () => {
    const nextCode = store.ws?.invite ?? null;
    const nextExp = store.ws?.inviteExp ?? null;
    if (nextCode === code && nextExp === exp) return;
    code = nextCode;
    exp = nextExp;
    render();
  });
  render();
  if (tab === 'email') focusEmailField(content);
}

/**
 * The next onboarding step after naming a workspace: invite the team.
 * The invite dialog needs the workspace loaded (the link, the admin role),
 * which navigate() is doing asynchronously — open it once that lands, and
 * give up quietly if the user has moved on.
 */
function inviteTeammatesWhenReady(wsId) {
  const started = Date.now();
  const timer = setInterval(() => {
    if (store.wsId === wsId && store.ws) {
      clearInterval(timer);
      inviteDialog({ fresh: true });
    } else if (Date.now() - started > 15000) clearInterval(timer);
  }, 400);
}

export function createWorkspaceDialog({ onCreated } = {}) {
  const nameInput = el('input.input', { placeholder: 'e.g. Northwind Studio', maxlength: LIMITS.workspaceName, autocomplete: 'organization' });
  const nameField = field('Workspace name', nameInput, 'The company, team, or project this space is for.');
  const submit = el('button.btn.btn-primary', { type: 'submit' }, 'Create workspace');
  const status = el('p.small.muted', { hidden: true, role: 'status', 'aria-live': 'polite' });
  const form = el('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      const name = nameInput.value.trim();
      if (!name) return nameField.showError('Give your workspace a name');
      const done = busy(submit, 'Creating');
      try {
        const { workspace } = await store.createWorkspace(name, (text) => {
          submit.textContent = `${text}\u2026`;
          status.textContent = text;
          status.hidden = false;
        });
        modal.close();
        toast(`Welcome to ${workspace.name}`);
        onCreated?.(workspace);
        navigate({ ws: workspace.id });
        inviteTeammatesWhenReady(workspace.id);
      } catch (err) {
        done();
        status.hidden = true;
        nameField.showError(err.message);
      }
    },
  }, nameField, status, el('div.modal-actions', {}, el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'), submit));
  const modal = openModal({ title: 'Create a workspace', content: form });
}

export function joinWorkspaceDialog({ code: initial = '' } = {}) {
  const input = el('input.input', { placeholder: 'Invite link, or XXXX-XXXX-XXXX@server', value: initial, autocapitalize: 'off', spellcheck: false, autocomplete: 'off' });
  const f = field('Invite link or code', input, 'A share link for a channel from another workspace works here too.');
  const submit = el('button.btn.btn-primary', { type: 'submit' }, 'Join');
  const form = el('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      // A share link (a channel from another workspace) is accepted for one
      // of the user's workspaces, which is a different conversation.
      const shareLink = /#\/connect\//.test(input.value);
      const connect = shareLink ? parseConnectInput(input.value) : null;
      if (connect?.code && connect.server) {
        modal.close();
        acceptConnectDialog(connect);
        return;
      }
      // A share link that lost its server part on the way (cut short in a
      // paste): said as what it is, as the app says of such a link followed
      // directly, rather than read on as an invite and refused as one
      // ("That does not look like an invite"), which sent the reader looking
      // for an invite they never had.
      if (shareLink) return f.showError('That share link is not valid: it is missing the part that names the server. Paste the whole link, or the code with its server (XXXX-XXXX-XXXX@server)');
      const parsed = parseInviteInput(input.value);
      if (!parsed || !parsed.code) return f.showError('That does not look like an invite');
      const server = parsed.server || (SHARED_WORKER_URL ? serverKeyOf(SHARED_WORKER_URL) : null);
      if (!server) return f.showError('Paste the whole invite link, or the code with its server (XXXX-XXXX-XXXX@server)');
      const done = busy(submit, 'Joining');
      try {
        const res = await store.join(server, parsed.code);
        modal.close();
        // An old code for a workspace since moved to another server: the
        // answer says where it went, and the dialog takes the turn a join
        // link followed in the address bar takes (see shell.js handleJoin).
        // Read as a plain join, it said "Joined" and opened the read-only
        // copy left behind at the old address.
        if (res.movedTo) {
          toast(`${res.workspace.name} moved to another server; opening it there`, { duration: 6000 });
          navigate({ ws: res.movedTo });
          return;
        }
        toast(res.promoted ? `You are now a full member of ${res.workspace.name}` : res.already ? `You are already in ${res.workspace.name}` : res.guest ? `Joined ${res.workspace.name} as a guest` : `Joined ${res.workspace.name}`);
        navigate({ ws: res.workspace.id });
      } catch (err) {
        done();
        f.showError(err.code === 'too_many_attempts' ? err.message
          : err.code === 'invite_not_found' ? 'That invite is not valid or has expired. Ask for a new link.'
            : err.code === 'no_backend' || err.code === 'network' ? 'The server behind this invite is not reachable right now.'
              : err.message);
      }
    },
  }, f, el('div.modal-actions', {}, el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'), submit));
  const modal = openModal({ title: 'Join a workspace', content: form });
}

/**
 * What the "Live updates" row in Workspace settings shows, and whether it
 * has anything for the owner to press: a pure function of GET /api/server's
 * body and the caller's own app uid, so every row of the table below can be
 * checked without standing a dialog up. The first match wins.
 *
 * app_mismatch is checked before a delegated "on": a tab running as a
 * different app than the server is refused altogether, every member's tab
 * and not only this one's (see eventsBlock's caller check), so calling it
 * "on" here would be a lie. It comes after no_app_uid and platform_off
 * because those name a blocker no app could ever get past, whatever it is.
 * 'unknown' (nothing has tripped a refusal yet) shares the consent branch
 * with a real one on purpose: the owner's action is the same either way, and
 * whether some member has already hit the refusal is nothing worth making
 * them read about.
 */
export function liveUpdatesState(info, appUid) {
  const ev = info?.events;
  if (!ev) {
    return { state: 'old_worker', detail: 'Unavailable: this server is an older build. It turns on when the server is updated.', canTurnOn: false };
  }
  if (ev.why === 'no_app_uid') {
    return { state: 'no_app_uid', detail: 'Unavailable: this server was not created by Teamchat, so it cannot reach anyone’s tabs. Deploying a new server from Teamchat is what turns this on.', canTurnOn: false };
  }
  if (ev.why === 'events_disabled' || ev.why === 'events_kv_handles_disabled') {
    return { state: 'platform_off', detail: 'Unavailable: Puter does not offer this where this server runs. Tabs keep checking for themselves.', canTurnOn: false };
  }
  if (appUid && ev.appUid && appUid !== ev.appUid) {
    return { state: 'app_mismatch', detail: 'Unavailable: this server and this tab are running as different apps, and the two have to match. Deploying a new server from Teamchat is what fixes it.', canTurnOn: false };
  }
  if (ev.delegated) {
    return { state: 'on', detail: '', canTurnOn: false };
  }
  if (ev.why === 'events_kv_handle_limit_reached') {
    return { state: 'limit', detail: 'Paused: your Puter account is holding as many of these as it allows. Teamchat tries again on its own, and room frees whenever someone leaves.', canTurnOn: false };
  }
  if (ev.why === 'account_is_not_verified') {
    return { state: 'unverified', detail: 'Paused: your Puter account’s email address is not confirmed yet. Teamchat tries again on its own once it is.', canTurnOn: false };
  }
  return { state: 'consent', detail: 'Off: needs your permission. Until then, everyone’s tabs check for themselves every few seconds.', canTurnOn: true };
}

export function workspaceSettingsDialog() {
  const ws = store.ws;
  if (!ws) return;
  const admin = store.isAdmin();
  const owner = ws.owner === store.uuid;
  const content = el('div');
  let closed = false;
  let liveLine = null;
  let liveTurnOn = null;

  /* Icon: shown in place of the name's first letter on the rail, in the workspace
     menu, and in the switcher. Cropped square and downscaled here, PNG when it
     fits (a logo keeps its transparent background), so the worker stores a small file. */
  const iconPreview = workspaceMark(el('span.ws-mark.ws-mark-lg', { 'aria-hidden': 'true' }), ws);
  if (admin) {
    const iconInput = el('input', { type: 'file', accept: 'image/*', hidden: true, 'aria-hidden': 'true', tabindex: -1 });
    const iconErr = el('p.field-error', { hidden: true, id: fieldId('ws-icon-err'), role: 'alert' });
    const iconBtn = el('button.btn.btn-sm.btn-outline', { type: 'button', html: icon('image', 15), 'aria-describedby': iconErr.id, onclick: () => iconInput.click() }, ws.icon ? ' Change icon' : ' Add an icon');
    const removeIconBtn = el('button.btn.btn-sm.btn-ghost', { type: 'button', hidden: !ws.icon, onclick: async () => {
      // The button goes as its press lands: a keyboard on it moves to the
      // one beside it, which now offers to add an icon, rather than falling
      // to the page body behind the dialog (busy puts the keyboard back only
      // on a button still shown, and a browser will not focus a hidden one).
      const had = document.activeElement === removeIconBtn;
      const done = busy(removeIconBtn, 'Removing');
      try {
        await store.updateWorkspaceIcon(null);
        workspaceMark(iconPreview, store.ws || { ...ws, icon: null });
        removeIconBtn.hidden = true;
        iconBtn.lastChild.textContent = ' Add an icon';
        toast('Icon removed');
        if (had) iconBtn.focus({ preventScroll: true });
      } catch (err) {
        toast(err.message, { icon: 'alert' });
      }
      done();
    } }, 'Remove');
    iconInput.addEventListener('change', async () => {
      const file = iconInput.files?.[0];
      iconInput.value = '';
      if (!file) return;
      iconErr.hidden = true;
      const done = busy(iconBtn, 'Uploading');
      try {
        const blob = await prepareAvatar(file, { png: true, maxBytes: LIMITS.workspaceIconBytes });
        await store.updateWorkspaceIcon(blob);
        workspaceMark(iconPreview, store.ws || ws);
        removeIconBtn.hidden = false;
        done();
        iconBtn.lastChild.textContent = ' Change icon';
        toast('Icon updated');
      } catch (err) {
        done();
        iconErr.textContent = err.message || 'Could not use that image';
        iconErr.hidden = false;
      }
    });
    content.append(el('div.ws-icon-row', {}, iconPreview,
      el('div', { style: { minWidth: 0 } },
        el('span.field-label', {}, 'Workspace icon'),
        el('div.row', { style: { gap: '6px', marginTop: '6px' } }, iconBtn, removeIconBtn),
        el('p.small.muted', { style: { marginTop: '6px' } }, 'A square image; PNG, JPEG, or WebP. Shown on the rail and in the workspace menu for everyone.'),
        iconErr, iconInput)));
  }

  if (admin) {
    const nameInput = el('input.input', { value: ws.name, maxlength: LIMITS.workspaceName });
    const nameField = field('Workspace name', nameInput);
    const save = el('button.btn.btn-primary', { type: 'submit' }, 'Save');
    content.append(el('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        const name = nameInput.value.trim();
        if (!name) return nameField.showError('Name cannot be empty');
        // Against the name as it is now: a refresh after an earlier rename in
        // this same dialog replaced the workspace object taken at open. Said,
        // as the profile's Save says it: a press that did nothing anyone
        // could see read as a button that does not work.
        if (name === (store.ws?.name ?? ws.name)) return toast('No changes to save');
        const done = busy(save, 'Saving');
        try {
          await api.updateWorkspace(store.wsId, { name });
          await store.refreshAfterChange();
          await store.noteWorkspaceName(store.wsId, name);
          toast('Workspace renamed');
          done();
        } catch (err) {
          done();
          nameField.showError(err.message);
        }
      },
    }, nameField, el('div.row.row-end', {}, save)));
  } else {
    content.append(el('div.field', {}, el('span.field-label', {}, 'Workspace'),
      el('div.row', { style: { gap: '10px', alignItems: 'center' } }, iconPreview, el('p', {}, ws.name))));
  }

  if (admin) {
    content.append(switchRow({
      label: 'Link previews', sub: 'Show a card under messages with a link. Your workspace server fetches each link once (the reader\u2019s browser never does) and keeps a small copy of its image; that costs the owner a little egress and storage.',
      checked: ws.unfurl !== false,
      onChange: async (v) => {
        try {
          await api.updateWorkspace(store.wsId, { unfurl: v });
          await store.refreshAfterChange();
        } catch (err) {
          toast(err.message, { icon: 'alert' });
          return false;
        }
      },
    }));
  }
  const actions = el('div.details-card.mt');
  if (admin) {
    actions.append(el('button.details-row', { type: 'button', onclick: () => { modal.close(); inviteDialog(); } },
      el('span', { html: icon('userPlus', 18) }), el('span.details-text', {}, el('strong', {}, 'Invite people'), el('span', {}, 'Share the code or link'))));
  }
  actions.append(el('button.details-row', { type: 'button', onclick: () => { modal.close(); membersDialog(); } },
    el('span', { html: icon('users', 18) }), el('span.details-text', {}, el('strong', {}, 'Members'), el('span', {}, Object.keys(ws.members).length === 1 ? '1 person' : `${Object.keys(ws.members).length} people`))));
  if (admin) {
    actions.append(el('button.details-row', { type: 'button', onclick: () => { modal.close(); exportDialog(); } },
      el('span', { html: icon('download', 18) }), el('span.details-text', {}, el('strong', {}, 'Export workspace'), el('span', {}, 'Every message and file, as JSON and readable pages, into your Puter drive'))));
  }
  if (owner && Object.values(ws.members).some((m) => m.role === 'admin')) {
    actions.append(el('button.details-row', { type: 'button', onclick: () => { modal.close(); transferDialog(); } },
      el('span', { html: icon('refresh', 18) }), el('span.details-text', {}, el('strong', {}, ws.transferTo ? 'Transfer pending' : 'Transfer ownership'),
        el('span', {}, ws.transferTo ? `Waiting for ${store.member(ws.transferTo).name} to accept` : 'Hand the workspace, and its data, to another admin'))));
  }
  if (admin) {
    const n = ws.integrations || 0;
    actions.append(el('button.details-row', { type: 'button', onclick: () => { modal.close(); integrationsDialog(); } },
      el('span', { html: icon('plug', 18) }), el('span.details-text', {}, el('strong', {}, 'Integrations'), el('span', {}, n ? `${n} webhook${n === 1 ? '' : 's'} or bot${n === 1 ? '' : 's'}` : 'Post from CI, scripts, and other apps'))));
    const guests = Object.values(ws.members).filter((m) => m.role === 'guest').length;
    actions.append(el('button.details-row', { type: 'button', onclick: () => { modal.close(); guestsDialog(); } },
      el('span', { html: icon('doorOpen', 18) }), el('span.details-text', {}, el('strong', {}, 'Guests'), el('span', {}, guests ? `${guests} guest${guests === 1 ? '' : 's'} with access to single channels` : 'Invite outside collaborators to one channel from its details'))));
    const shared = Object.values(ws.channels || {}).filter((c) => c.shared || Object.keys(c.connections || {}).length).length;
    actions.append(el('button.details-row', { type: 'button', onclick: () => { modal.close(); sharedChannelsDialog(); } },
      el('span', { html: icon('shared', 18) }), el('span.details-text', {}, el('strong', {}, 'Shared channels'), el('span', {}, shared ? `${shared} channel${shared === 1 ? '' : 's'} shared with other workspaces` : 'Work with another workspace in a channel you both see'))));
  }
  // One press at a time on each (see pressOnce), as the rows of a channel's
  // details and the Guests dialog take theirs: the press asks first and then
  // waits on the worker (the hosts of the shared channels told, the member
  // taken out or the workspace deleted), and the row stayed live meanwhile,
  // so a second press (Enter again with the keyboard back on the row, a
  // double click) put the same question up again and sent its answer to the
  // worker a second time, refused over the "Left" or "Workspace deleted" just
  // said. Busy, not disabled, so the keyboard stays on the row through the wait.
  if (!owner) {
    const leave = el('button.details-row.danger', { type: 'button' },
      el('span', { html: icon('doorOpen', 18) }), el('span.details-text', {}, el('strong', {}, 'Leave workspace')));
    leave.addEventListener('click', pressOnce(leave, async () => {
      const ok = await confirmDialog({ title: `Leave ${ws.name}?`, message: 'You will need a new invite to come back.', confirmLabel: 'Leave' });
      if (!ok) return;
      try {
        const ref = store.wsId;
        // Out of the channels shared with other workspaces first: on their
        // hosts, the member is there through this workspace alone.
        await store.leaveHosts();
        const res = await api.removeMember(ref, store.uuid);
        // And this workspace's own word to each host that the seat has
        // ended, as an admin's removal carries it (see carryRevocations):
        // leaveHosts reaches only the hosts whose link is loaded, and a
        // host whose word for the member had lapsed would otherwise go on
        // seating them until it ran out.
        store.carryRevocations(res?.revocations).catch(() => {});
        modal.close();
        store.closeWorkspace();
        await store.forgetWorkspace(ref);
        toast(`Left ${ws.name}`);
        navigate('#/');
      } catch (err) {
        toast(err.message, { icon: 'alert' });
      }
    }));
    actions.append(leave);
  } else {
    const del = el('button.details-row.danger', { type: 'button' },
      el('span', { html: icon('trash', 18) }), el('span.details-text', {}, el('strong', {}, ws.sample ? 'Delete sample workspace' : 'Delete workspace'), el('span', {}, 'Owner only. Cannot be undone.')));
    del.addEventListener('click', pressOnce(del, async () => {
      const people = Object.keys(ws.members).length - 1;
      const ok = await confirmDialog({
        title: `Delete ${ws.name}?`,
        message: ws.sample ? 'The sample workspace and all of its messages will be removed.'
          : ws.movedTo ? 'This is the read-only copy left behind by the transfer. The workspace lives on at its new address; deleting this copy is safe.'
            : `Every channel, message, and file of this workspace will be removed for ${people ? `you and ${people} other ${people === 1 ? 'person' : 'people'}` : 'good'}. This cannot be undone. If you want to keep a copy, export it first from Workspace settings; if the team should carry on without you, transfer ownership instead.`,
        confirmLabel: 'Delete workspace',
      });
      if (!ok) return;
      try {
        const ref = store.wsId;
        // The hosts of the channels shared into this workspace are told
        // first: the worker cannot reach them once it has forgotten the
        // connections, and they would list this workspace for good.
        await store.disconnectHosts();
        await api.deleteWorkspace(ref);
        modal.close();
        store.closeWorkspace();
        await store.forgetWorkspace(ref);
        toast('Workspace deleted', { icon: 'trash' });
        navigate('#/');
      } catch (err) {
        toast(err.message, { icon: 'alert' });
      }
    }));
    actions.append(del);
  }
  content.append(actions);
  // A workspace's data lives in its owner's account: an owner with a team
  // and no other admin is one lost password away from losing it all.
  const otherAdmins = Object.entries(ws.members).filter(([u, m]) => u !== ws.owner && m.role === 'admin').length;
  const others = Object.keys(ws.members).length - 1;
  if (owner && others > 0 && !otherAdmins && !ws.movedTo) {
    content.append(el('div.callout.mt', { html: icon('shield', 16) }, el('span', {},
      'This workspace lives in your Puter account. Name a backup admin from ', el('strong', {}, 'Members'), ' so the team can export or take over the workspace if you ever cannot; and export a copy from time to time.')));
  }
  if (admin) {
    const built = ws.search?.built;
    content.append(el('div.details-card.mt', {}, el('button.details-row', {
      type: 'button', onclick: () => { modal.close(); searchIndexDialog(); },
    },
    el('span', { html: icon('search', 18) }),
    el('span.details-text', {}, el('strong', {}, 'Search index'),
      el('span', {}, built ? `Built ${relativeLong(built)}. Rebuild if results look incomplete.` : 'Not built yet: only recent messages can be found')),
    el('span', { html: icon('chevRight', 16), style: { color: 'var(--ink-3)' } }))));
  }
  // Owner only, like the events question itself (see serverEventsStatus):
  // it names the owner's own app uid and consent, neither of which is
  // anyone else's to know. Starts on "Checking" and is filled in once GET
  // /api/server answers (see loadLiveUpdates, below).
  if (owner) {
    liveLine = el('span', {}, 'Checking');
    liveTurnOn = el('button.btn.btn-sm', { type: 'button', hidden: true }, 'Turn on');
    const row = el('div.details-row.static', {},
      el('span', { html: icon('sparkle', 18) }),
      el('span.details-text', {}, el('strong', {}, 'Live updates'), liveLine),
      liveTurnOn);
    content.append(el('div.details-card.mt', {}, row));
  }
  if (ws.sample) {
    content.append(el('div.callout.mt', { html: icon('sparkle', 16) }, el('span', {}, 'This is a sample workspace with fictional teammates. Explore freely; delete it whenever you like.')));
  }
  const server = parseRef(store.wsId)?.server;
  const ownerName = store.member(ws.owner).name;
  content.append(el('p.small.muted', { style: { marginTop: '14px' } },
    owner ? 'This workspace runs on your server ' : `This workspace runs on ${ownerName}\u2019s server `,
    el('code', {}, server || 'unknown'),
    owner ? ', in your Puter account.' : ', in their Puter account.'));

  /**
   * The row's own state, read after the dialog is open (the way
   * acceptConnectDialog reads a share link's preview): fired once, filled in
   * when GET /api/server answers, and left alone if the dialog closed
   * meanwhile.
   */
  async function loadLiveUpdates() {
    const url = parseRef(store.wsId)?.url;
    let info = null;
    if (url) {
      try {
        info = await api.server(url);
      } catch {
        info = null;
      }
    }
    if (closed) return;
    if (!info) {
      liveLine.textContent = 'Could not be checked just now.';
      liveTurnOn.hidden = true;
      return;
    }
    const state = liveUpdatesState(info, store.appUid());
    liveLine.textContent = state.detail;
    liveLine.hidden = !state.detail;
    const grantAppUid = info.events?.appUid;
    // Nothing to press without a real way to ask for the permission: the
    // sentence above stands on its own, and the owner can still grant it
    // from an actual Puter session.
    const hasPerms = typeof puter !== 'undefined' && typeof puter.perms?.request === 'function';
    const canPress = state.canTurnOn && hasPerms && !!grantAppUid && !!url;
    liveTurnOn.hidden = !canPress;
    if (!canPress) return;
    liveTurnOn.onclick = async () => {
      const done = busy(liveTurnOn, 'Turning on');
      try {
        const granted = await puter.perms.request('permission', { permission: evGrantPermission(store.uuid, grantAppUid) });
        // Declined in Puter's own dialog: they just said no, nothing to
        // record and nothing worth a toast over.
        if (!granted) { done(); return; }
        await api.updateServer(url, { events: true });
        // An owner who once waved the toast away carries prefs.evConsent:
        // 'declined' with nothing anywhere able to clear it — a granted
        // permission is exactly what that pref was standing in the way of.
        await store.updatePrefs({ evConsent: null }).catch(() => {});
        // PUT /api/server clears the cached refusal, so its own answer comes
        // back why: 'unknown'; running that through liveUpdatesState would
        // redraw this row as "needs your permission" the instant the owner
        // just gave it, so the success is said directly instead.
        liveLine.textContent = 'On: your permission is in. Each member’s tabs start being woken the next time they check in.';
        // Given its label and its press back before it goes, so nothing is
        // left mid-press behind the hidden attribute; and the keyboard, if
        // it was on the button, goes to the panel rather than falling out of
        // the dialog onto the page body, which is where hiding the control
        // it rests on drops it (the same place the dialog itself puts the
        // keyboard when it has no field to offer, see openModal).
        done();
        const wasOnButton = document.activeElement === liveTurnOn;
        liveTurnOn.hidden = true;
        if (wasOnButton) modal.panel?.focus?.({ preventScroll: true });
        store.refreshWorkspace().catch(() => {});
      } catch {
        done();
        toast('Not turned on; nothing changed');
      }
    };
  }

  const modal = openModal({ title: 'Workspace settings', content, onClose: () => { closed = true; } });
  if (owner) loadLiveUpdates();
}

/**
 * The build of the search index running for a workspace, by its reference
 * (see searchIndexDialog): whether one runs, where it has got to (its words,
 * how far along, and the state the last step handed back for the next), and
 * the dialog showing it. Kept for the session, as exportState is: the dialog
 * closed while the build runs and opened again shows that build rather than
 * offering another.
 */
const reindexState = new Map();

/**
 * Build (or rebuild) the search index over a workspace's history. The worker
 * does a bounded slice per request and hands back where it got to; this
 * dialog loops until it says done, showing progress, and survives being
 * left open in the background.
 */
export function searchIndexDialog({ onDone } = {}) {
  const ws = store.ws;
  if (!ws || !store.isAdmin()) return;
  const ref = store.wsId;
  const built = ws.search?.built;
  // Where a pass that stopped had got to (`resume`), so "Try again" carries
  // on from there rather than dropping what it indexed and starting over.
  const state = reindexState.get(ref) || { running: false, status: '', pct: null, resume: null, stopped: false, shown: null };
  reindexState.set(ref, state);
  const status = el('p.small', { role: 'status', 'aria-live': 'polite', style: { minHeight: '20px', marginTop: '12px' } });
  const bar = el('div.progress', { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0', hidden: true }, el('div.progress-fill'));
  const start = el('button.btn.btn-primary', { type: 'button' }, state.stopped ? 'Try again' : built ? 'Rebuild index' : 'Build index');
  const done = el('button.btn', { type: 'button', onclick: () => modal.close() }, built ? 'Done' : 'Not now');
  const showBar = (pct) => {
    bar.hidden = false;
    bar.setAttribute('aria-valuenow', String(pct));
    bar.firstChild.style.width = `${pct}%`;
  };
  // The build carries on after Close (it is long, and the dialog says to
  // keep the tab open, not the dialog): its end is then a toast either way,
  // not a line on a status node nobody sees any more. And the dialog opened
  // again meanwhile (from Workspace settings, or the search page's own
  // offer) shows the build still going, its button busy and its bar where
  // it stands, rather than offering "Build index" over it: pressed, that
  // began a second walk of the same workspace beside the first, which
  // cleared the index the first was writing into and read every
  // conversation a second time, for one index. Stopped while no dialog
  // showed it, the next one opened says where it stopped and offers to
  // carry on from there; done, the next one starts afresh. This dialog is
  // the one showing the build, until it closes or another opens.
  const shown = {
    say: (t, pct) => {
      status.textContent = t;
      if (pct != null) showBar(pct);
    },
    // Done, the button is disabled for good, the keyboard moved on to Done first.
    finished: () => {
      done.textContent = 'Done';
      start.removeAttribute('aria-busy');
      if (document.activeElement === start) done.focus({ preventScroll: true });
      start.disabled = true;
    },
    stopped: () => {
      start.removeAttribute('aria-busy');
      start.textContent = 'Try again';
    },
  };
  state.shown = shown;
  // Busy, not disabled, while the index is built (see pressOnce): a disabled
  // button under the keyboard hands its focus to the page body, and after a
  // failure came back live, reading "Try again", with nobody on it.
  const running = () => {
    start.setAttribute('aria-busy', 'true');
    done.textContent = 'Close';
    status.textContent = state.status;
    if (state.pct != null) showBar(state.pct);
  };
  if (state.running) running();
  else if (state.status) {
    status.textContent = state.status;
    if (state.pct != null) showBar(state.pct);
  }

  async function run() {
    if (state.running) return;
    state.running = true;
    state.stopped = false;
    const report = (t, pct = null) => {
      state.status = t;
      if (pct != null) state.pct = pct;
      state.shown?.say(t, pct);
    };
    running();
    report(state.resume ? 'Carrying on' : 'Starting', state.pct ?? 0);
    let steps = 0;
    let skipped = 0;
    try {
      for (;;) {
        const res = await api.reindex(ref, state.resume);
        steps++;
        const p = res.progress || {};
        skipped = p.skipped || 0;
        const pct = p.total ? Math.min(99, Math.round((p.done / p.total) * 100)) : 0;
        report(p.clearing
          ? `Clearing the previous index: ${p.clearing} ${p.clearing === 1 ? 'month' : 'months'} to go`
          : `Indexed ${p.messages?.toLocaleString() || 0} messages across ${p.done || 0} of ${p.total || 0} conversations`, pct);
        if (res.done) break;
        state.resume = res.state;
        if (steps > 5000) throw new Error('The index is taking too long to build');
      }
      state.resume = null;
      state.running = false;
      // Done: the dialog showing it says so; the next one opened starts afresh.
      state.status = '';
      state.pct = null;
      // A walk lists a bounded number of conversations; threads found past
      // the bound were left out, and the admin should hear so.
      state.shown?.say(skipped
        ? `Done. ${skipped.toLocaleString()} ${skipped === 1 ? 'thread was' : 'threads were'} beyond what one pass can list and ${skipped === 1 ? 'was' : 'were'} left out.`
        : 'Done. Every message in this workspace can now be found.', 100);
      await store.refreshAfterChange();
      toast('Search index built');
      onDone?.();
      state.shown?.finished();
    } catch (e) {
      // A state the server refused (an older server, a stale shape) is no use
      // to carry on from; anything else stopped between two steps and resumes.
      if (e instanceof ApiError && e.status === 400) state.resume = null;
      state.running = false;
      state.stopped = true;
      report(state.resume
        ? `Stopped: ${e.message}. Try again to carry on from where it stopped; nothing indexed so far is lost.`
        : `Stopped: ${e.message}. Try again to start over.`);
      state.shown?.stopped();
      if (!state.shown) toast(`Search index stopped: ${e.message}`, { icon: 'alert', duration: 8000 });
    }
  }
  start.addEventListener('click', run);

  const content = el('div', {},
    el('p', { style: { color: 'var(--ink-2)', fontSize: '14px' } },
      built
        ? 'The index is what search reads. Rebuilding walks every conversation again and replaces it; do this if results look incomplete or after the worker was updated.'
        : 'This workspace was created before search existed, so only messages posted since then can be found. Building the index walks every conversation once so all of history is searchable.'),
    el('p.small.muted', { style: { marginTop: '8px' } }, 'Runs on the workspace server in short steps; keep this tab open until it finishes. Reads and writes count toward the owner\u2019s Puter usage.'),
    bar, status,
    el('div.modal-actions', {}, done, start));
  const modal = openModal({ title: 'Search index', content, onClose: () => { if (state.shown === shown) state.shown = null; } });
  return modal;
}

export function membersDialog() {
  const content = el('div');
  const search = el('input.input', { type: 'search', placeholder: 'Search members', 'aria-label': 'Search members' });
  const list = el('div.pick-list', { role: 'list' });
  // The people an admin removed from shared channels, under their own
  // heading and in their own list: a heading is not an item of the list of
  // members, and a list may hold nothing else.
  const removedWrap = el('div');
  const admin = store.isAdmin();
  const titleFor = () => (store.isGuest() ? `People you can see (${Object.keys(store.ws?.members || {}).length})` : `Members (${Object.keys(store.ws?.members || {}).length})`);
  let heading = null;

  function render() {
    // Over the whole content, not the member list alone: a redraw also
    // rebuilds the list of people removed from shared channels below it,
    // and the Restore button just pressed there went with it, leaving the
    // keyboard on the page body inside the open dialog.
    keepFocus(content, draw);
  }
  function draw() {
    // Removing someone redraws the list; the count in the title moves with it.
    if (heading) heading.textContent = titleFor();
    // "@ben" finds Ben as "ben" does: the leading mark is no part of a name (the sidebar's rule).
    const q = normalize(search.value.trim().replace(/^[#@]+/, ''));
    const members = Object.entries(store.ws?.members || {})
      .map(([uuid, m]) => ({ uuid, ...m }))
      .filter((m) => !q || normalize(m.name).includes(q) || normalize(m.username).includes(q))
      .sort((a, b) => (a.role === 'owner' ? -1 : b.role === 'owner' ? 1 : a.name.localeCompare(b.name)));
    list.replaceChildren(...members.map((m) => {
      const isMe = m.uuid === store.uuid;
      const row = el('div.pick-item', { role: 'listitem' },
        avatar(m, { size: 'sm', state: store.presenceOf(m.uuid) }),
        el('span.pick-text', {}, el('strong.name-line', {}, el('span.name-text', { dir: 'auto' }, m.name, isMe ? ' (you)' : ''), statusChip(m.uuid, { compact: true })), el('span', {}, m.title || `@${m.username}`)),
        rolePill(m.uuid));
      if (admin && !isMe && m.role !== 'owner') {
        // Someone from a connected workspace belongs to that workspace: no
        // role here to change, only the shared channel to be removed from.
        const external = m.role === 'external';
        row.append(el('button.icon-btn.icon-btn-sm', {
          type: 'button', html: icon('more', 16), 'aria-label': `Manage ${m.name}`, 'aria-haspopup': 'menu',
          onclick: (e) => openMenu(e.currentTarget, [
            { label: 'Send message', icon: 'message', onSelect: () => { modal.close(); openDmWith(m.uuid); } },
            'sep',
            external ? null : m.role === 'guest'
              ? { label: 'Make a full member', icon: 'userPlus', sub: 'Sees every public channel, like everyone else', onSelect: () => promoteGuest(m) }
              : m.role === 'admin'
                ? { label: 'Remove admin', icon: 'shield', onSelect: () => setRole(m, 'member') }
                : { label: 'Make admin', icon: 'shieldCheck', onSelect: () => setRole(m, 'admin') },
            {
              label: external ? 'Remove from shared channels' : 'Remove from workspace', icon: 'trash', danger: true,
              onSelect: async () => {
                const ok = await confirmDialog({
                  title: `Remove ${m.name}?`,
                  message: external ? `They are here through ${m.org?.name || 'a connected workspace'}. They leave the shared channel now and cannot come back through it until you restore them from this list.` : 'They lose access immediately and will need a new invite to return.',
                  confirmLabel: 'Remove',
                });
                if (!ok) return;
                try {
                  const res = await api.removeMember(store.wsId, m.uuid);
                  // Their seats in the channels shared with other workspaces end with their membership here (see carryRevocations).
                  store.carryRevocations(res?.revocations).catch(() => {});
                  await store.refreshAfterChange();
                  toast(`Removed ${m.name}`);
                  render();
                } catch (err) {
                  toast(err.message, { icon: 'alert' });
                }
              },
            },
          ], { align: 'end' }),
        }));
      } else if (!isMe) {
        row.append(el('button.icon-btn.icon-btn-sm', {
          type: 'button', html: icon('message', 16), 'aria-label': `Message ${m.name}`,
          onclick: () => { modal.close(); openDmWith(m.uuid); },
        }));
      }
      return row;
    }));
    // People from connected workspaces an admin removed: kept out of the
    // shared channels until restored from here, whatever their workspace says.
    const removed = admin ? Object.entries(store.ws?.removed || {})
      .map(([uuid, c]) => ({ uuid, ...c }))
      .filter((m) => !q || normalize(m.name).includes(q) || normalize(m.username).includes(q) || normalize(m.org?.name).includes(q))
      .sort((a, b) => (b.at || 0) - (a.at || 0)) : [];
    removedWrap.replaceChildren();
    if (removed.length) {
      removedWrap.append(el('h3.details-subhead', {}, 'Removed from shared channels'), el('div.pick-list', { role: 'list', 'aria-label': 'Removed from shared channels' }, ...removed.map((m) => {
        const org = m.org?.name || 'a connected workspace';
        // One press at a time, busy rather than disabled while the worker
        // answers: a disabled button under the keyboard hands its focus to
        // the page body, and the redraw that follows the answer (the row
        // gone from the list) found nothing to give the keyboard back to,
        // so the next Tab started over from the top of the window.
        const restore = el('button.btn.btn-sm.btn-ghost', {
          type: 'button', title: `Let ${m.name} back into the channels shared with ${org}`,
          onclick: async () => {
            if (restore.getAttribute('aria-busy') === 'true') return;
            restore.setAttribute('aria-busy', 'true');
            try {
              await api.restoreRemoved(store.wsId, m.uuid);
              await store.refreshAfterChange();
              toast(`${m.name} can join again through ${org}`);
              render();
            } catch (err) {
              toast(err.message, { icon: 'alert' });
            } finally {
              restore.removeAttribute('aria-busy');
            }
          },
        }, 'Restore');
        return el('div.pick-item', { role: 'listitem' },
          avatar(m, { size: 'sm' }),
          el('span.pick-text', {}, el('strong', { dir: 'auto' }, m.name), el('span', {}, `@${m.username} · removed ${relativeLong(m.at)}`)),
          el('span.pill.pill-org', { title: `From ${org}` }, el('span', { html: icon('building', 11, 2.2), 'aria-hidden': 'true' }), org),
          restore);
      })));
    }
  }
  /** A guest becoming a member sees the whole workspace, and there is no way back to guest: ask first. */
  async function promoteGuest(m) {
    const ok = await confirmDialog({
      title: `Make ${m.name} a full member?`,
      message: 'They will see every public channel and everyone in the workspace. A member cannot be turned back into a guest.',
      confirmLabel: 'Make member', danger: false,
    });
    if (ok) await setRole(m, 'member');
  }
  async function setRole(m, role) {
    try {
      const res = await api.setRole(store.wsId, m.uuid, role);
      // Made a guest, they are out of the channels shared with other workspaces (see carryRevocations).
      store.carryRevocations(res?.revocations).catch(() => {});
      await store.refreshAfterChange();
      toast(role === 'admin' ? `${m.name} is now an admin` : m.role === 'guest' ? `${m.name} is now a full member` : `${m.name} is no longer an admin`);
      render();
    } catch (err) {
      toast(err.message, { icon: 'alert' });
    }
  }
  search.addEventListener('input', render);
  content.append(el('div.field', {}, search), list, removedWrap);
  if (store.isAdmin()) {
    content.append(el('div.modal-actions', { style: { justifyContent: 'flex-start' } },
      el('button.btn.btn-outline', { type: 'button', html: icon('userPlus', 16), onclick: () => { modal.close(); inviteDialog(); } }, ' Invite people')));
  }
  // A poll that changes the members (another admin removing or promoting
  // someone, a person joining) redraws the list while it is open, as the
  // other long-lived dialogs do; a row for someone gone offered "Make
  // admin" and answered "Member not found".
  const off = store.on('workspace', render);
  const modal = openModal({ title: titleFor(), content, onClose: off });
  heading = modal.panel.querySelector('.modal-title');
  render();
}

/**
 * A one-line "email this invite" form for the share dialog: the shared email
 * worker composes the mail around the same code shown above it. An empty
 * fragment when the app cannot send email (its caller hands it straight to
 * append(), where null would render as text).
 */
function inviteEmailRow({ kind, channel, code, exp }) {
  if (!emailAvailable()) return document.createDocumentFragment();
  const input = el('input.input', { type: 'text', placeholder: 'name@example.com', autocapitalize: 'off', spellcheck: false, autocomplete: 'off', style: { flex: '1', minWidth: 0 } });
  const send = el('button.btn', { type: 'submit' }, 'Send');
  const f = field('Or email it', el('div.row', { style: { gap: '8px' } }, input, send),
    kind === 'connect' ? 'Goes to an admin of the other workspace, with this link inside.' : 'They get an email with this link inside.');
  return el('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      const { emails, bad } = parseEmails(input.value);
      if (bad.length) return f.showError(`Not an email address: ${bad.join(', ')}`);
      if (!emails.length) return f.showError('Add an email address');
      if (emails.length > 10) return f.showError('Send to 10 people at a time');
      const done = busy(send, 'Sending');
      try {
        const res = await sendInviteEmails({
          kind, server: parseRef(store.wsId)?.server, code, exp,
          workspace: store.ws?.name, channel: channel.name,
          inviter: store.profile?.name || store.profile?.username, emails,
        });
        done();
        if (res.sent === emails.length) {
          f.showError('');
          input.value = '';
          toast(`Sent to ${emails.length === 1 ? emails[0] : `${emails.length} people`}`);
        } else {
          // Some (or none) went out. Leave the addresses that did not send in
          // the field so they can be tried again rather than retyped — the
          // same keep-the-form rule as the workspace dialog's Email tab.
          const stuck = (res.results || []).filter((r) => r.status !== 'sent').map((r) => r.email);
          input.value = stuck.join(', ');
          toast(res.sent ? `Sent ${res.sent} of ${emails.length}` : 'Nothing was sent', res.sent ? {} : { icon: 'alert' });
          f.showError(unsentHint(res, stuck));
        }
      } catch (err) {
        done();
        f.showError(err.message);
      }
    },
  }, f);
}

/**
 * A channel's guest invite: whoever accepts it joins the workspace as a
 * guest of this channel only. Same shape as the workspace invite dialog: a
 * link and code to share anywhere (duration, replace, revoke), and, when the
 * app's email worker is deployed, an Email tab that composes and sends the
 * invitations, minting the link itself when the channel has none. `tab`
 * picks the tab to open on.
 */
export function guestInviteDialog(channel, { tab: startTab = 'link' } = {}) {
  const content = el('div');
  let off = null;
  const modal = openModal({ title: `Invite a guest to #${channel.name}`, content, onClose: () => off?.() });
  let code = channel.guestInvite || null;
  let exp = channel.guestInviteExp || null;
  let tab = startTab === 'email' && emailAvailable() ? 'email' : 'link';
  // The Email tab is rebuilt on every redraw (a tab switch, a new link), so
  // what was typed lives here rather than on the throwaway inputs.
  let draftEmails = '';
  let draftNote = '';

  /**
   * Take a minted (or revoked) code: on the channel this dialog was handed
   * and on the store's entry for it, which is where the Members tab reads
   * its "Guest invite link" label from.
   */
  function setCode(nextCode, nextExp) {
    code = nextCode || null;
    exp = nextExp || null;
    for (const c of new Set([channel, store.ws?.channels?.[channel.id]].filter(Boolean))) {
      if (code) Object.assign(c, { guestInvite: code, guestInviteExp: exp });
      else { delete c.guestInvite; delete c.guestInviteExp; }
    }
  }

  async function mint(ttl, btn) {
    if (btn.getAttribute('aria-busy') === 'true') return;
    const done = hold(btn, 'Creating');
    try {
      const res = await api.channelInvite(store.wsId, channel.id, ttl);
      setCode(res.code, res.exp);
      await store.refreshAfterChange();
      toast(`Guest invite ready, valid for ${INVITE_TTLS[ttl].label}`);
      render();
    } catch (err) {
      done();
      toast(err.message, { icon: 'alert' });
    }
  }
  function mintMenu(btn, replace) {
    if (btn.getAttribute('aria-busy') === 'true') return; // a link is being made from this button already
    openMenu(btn, [
      { header: replace ? 'New link, valid for' : 'Valid for' },
      ...Object.entries(INVITE_TTLS).map(([key, t]) => ({
        label: t.label, icon: 'link',
        onSelect: async () => {
          if (replace) {
            const ok = await confirmDialog({ title: 'Replace the guest invite?', message: 'The current code and link stop working immediately.', confirmLabel: 'Replace', danger: false });
            if (!ok) return;
          }
          mint(key, btn);
        },
      })),
    ], { align: 'end', label: 'Invite duration' });
  }

  /** The email needs a live link to carry; mint a month-long one quietly. */
  async function ensureCode() {
    if (code && (!exp || exp > Date.now())) return;
    const res = await api.channelInvite(store.wsId, channel.id, '30d');
    setCode(res.code, res.exp);
    store.refreshAfterChange();
  }

  const tabsRow = () => inviteTabsRow(tab, (key) => { tab = key; render(); });

  function drawEmail(into) {
    const emailsInput = el('textarea.textarea', { rows: 3, placeholder: 'ellis@example.com, maria@example.com', autocapitalize: 'off', spellcheck: false, autocomplete: 'off' });
    emailsInput.value = draftEmails;
    emailsInput.addEventListener('input', () => { draftEmails = emailsInput.value; });
    const emailsField = field('Email addresses', emailsInput, 'Up to 10 at a time, separated by commas or new lines.');
    const noteInput = el('input.input', { maxlength: 400, placeholder: 'What to say above the join button' });
    noteInput.value = draftNote;
    noteInput.addEventListener('input', () => { draftNote = noteInput.value; });
    const send = el('button.btn.btn-primary', { type: 'submit', html: icon('send', 15) }, ' Send invitations');
    const form = el('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        const { emails, bad } = parseEmails(emailsInput.value);
        if (bad.length) return emailsField.showError(`Not an email address: ${bad.join(', ')}`);
        if (!emails.length) return emailsField.showError('Add at least one email address');
        if (emails.length > 10) return emailsField.showError('Send to 10 people at a time');
        const done = busy(send, 'Sending');
        try {
          await ensureCode();
          const res = await sendInviteEmails({
            kind: 'guest', server: parseRef(store.wsId)?.server, code, exp,
            workspace: store.ws?.name, channel: channel.name,
            inviter: store.profile?.name || store.profile?.username,
            note: noteInput.value.trim(), emails,
          });
          if (res.sent === emails.length) {
            modal.close();
            toast(`Invitation${res.sent === 1 ? '' : 's'} sent to ${res.sent === 1 ? emails[0] : `${res.sent} people`}`);
            return;
          }
          // Some (or none) went out. Keep the dialog and leave only the
          // addresses that did not send, so the rest can be tried again
          // rather than retyped — the workspace dialog's rule.
          done();
          const stuck = (res.results || []).filter((r) => r.status !== 'sent').map((r) => r.email);
          draftEmails = stuck.join(', ');
          emailsInput.value = draftEmails;
          toast(res.sent ? `Sent ${res.sent} of ${emails.length}` : 'Nothing was sent', res.sent ? {} : { icon: 'alert' });
          emailsField.showError(unsentHint(res, stuck));
        } catch (err) {
          done();
          // The send itself failed (the email service, not the addresses), and
          // every such message points at the link to share instead. When a
          // link exists, show it; without one (minting it is what failed) the
          // message stays under the field. The typed addresses are kept
          // either way, so switching back finds them.
          if (code && tab === 'email') {
            tab = 'link';
            render();
            toast(err.message, { icon: 'alert', duration: 6000 });
          } else {
            emailsField.showError(err.message);
          }
        }
      },
    },
    emailsField,
    field('Add a note (optional)', noteInput, 'Goes into the email, above the join button.'),
    el('p.small.muted', {}, `Each person gets an email with a link to join ${store.ws?.name || 'the workspace'} as a guest of #${channel.name}: they see this channel and the people in it, nothing else. Someone who should see the whole workspace is invited from the workspace menu instead.`),
    el('div.modal-actions', {},
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'),
      send));
    into.append(form);
  }

  function render() {
    keepFocus(content, draw);
  }
  function draw() {
    content.replaceChildren();
    const tabs = tabsRow();
    if (!tabs) {
      drawLink(content);
      return;
    }
    // As in the workspace invite: one body under the strip, kept at the taller tab's height.
    const body = el('div');
    content.append(tabs, body);
    if (tab === 'email') drawEmail(body);
    else drawLink(body);
    holdTabHeight(body, tab === 'email' ? drawLink : drawEmail);
  }
  function drawLink(into) {
    const expired = !!exp && exp <= Date.now();
    into.append(el('div.callout', { html: icon('info', 16) }, el('span', {},
      'A guest joins this workspace seeing only #', channel.name, ': not the other channels, not the member directory. They can be added to more channels or made a full member later.')));
    if (!code || expired) {
      into.append(
        el('div.row', { style: { marginTop: '14px', justifyContent: 'center' } },
          el('button.btn.btn-primary', { type: 'button', html: icon('link', 16), 'aria-haspopup': 'menu', onclick: (e) => mintMenu(e.currentTarget, false) }, ' Create a guest invite')),
        el('div.modal-actions', {}, el('button.btn', { type: 'button', onclick: () => modal.close() }, 'Done')));
      return;
    }
    const server = parseRef(store.wsId)?.server;
    const link = inviteLink(server, code);
    const token = makeInviteToken(code, server);
    const expiry = inviteExpiryText(exp);
    const copyBtn = (text, label) => {
      const btn = el('button.btn.btn-sm', { type: 'button', 'aria-label': `Copy ${label.toLowerCase()}` }, 'Copy');
      btn.addEventListener('click', async () => {
        try {
          await copyToClipboard(text);
          toast(`${label} copied`);
          btn.textContent = 'Copied';
          setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
        } catch {
          toast('Could not copy. Select the text and copy it manually', { icon: 'alert' });
        }
      });
      return btn;
    };
    into.append(
      el('div.field.mt', {},
        el('div.row', { style: { justifyContent: 'space-between' } }, el('span.field-label', {}, 'Guest invite link'), el('span.pill', {}, expiry)),
        el('div.code-box', { style: { fontSize: '13px', letterSpacing: 0, fontFamily: 'var(--font)', fontWeight: 500 } },
          el('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, link), copyBtn(link, 'Link'))),
      el('div.field', {}, el('span.field-label', {}, 'Invite code'),
        el('div.code-box', { style: { fontSize: '14px', letterSpacing: '0.02em' } },
          el('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, token), copyBtn(token, 'Code'))),
      el('div.modal-actions', { style: { justifyContent: 'space-between' } },
        el('div.row', {},
          el('button.btn.btn-ghost', { type: 'button', html: icon('refresh', 15), 'aria-haspopup': 'menu', onclick: (e) => mintMenu(e.currentTarget, true) }, ' Replace'),
          el('button.btn.btn-ghost', {
            type: 'button', html: icon('x', 15),
            onclick: async (e) => {
              const btn = e.currentTarget;
              if (btn.getAttribute('aria-busy') === 'true') return;
              const ok = await confirmDialog({ title: 'Revoke the guest invite?', message: 'Nobody else can join with it. Guests already in the channel stay.', confirmLabel: 'Revoke' });
              if (!ok) return;
              const done = hold(btn, 'Revoking');
              try {
                await api.revokeChannelInvite(store.wsId, channel.id);
                setCode(null, null);
                await store.refreshAfterChange();
                toast('Guest invite revoked');
                render();
              } catch (err) {
                done();
                toast(err.message, { icon: 'alert' });
              }
            },
          }, ' Revoke')),
        el('button.btn', { type: 'button', onclick: () => modal.close() }, 'Done')));
  }
  // A code minted or revoked elsewhere reaches here through the workspace
  // poll; re-sync from the channel and redraw only when this channel's guest
  // code actually changed, so a stale one is never left to be copied.
  off = store.on('workspace', () => {
    const fresh = store.ws?.channels?.[channel.id];
    const nextCode = fresh?.guestInvite ?? null;
    const nextExp = fresh?.guestInviteExp ?? null;
    if (nextCode === code && nextExp === exp) return;
    code = nextCode;
    exp = nextExp;
    render();
  });
  render();
  if (tab === 'email') focusEmailField(content);
}

/* ---- shared channels ----------------------------------------------------- */

/**
 * Share a channel with another workspace: a link (or code) that workspace's
 * admin accepts, after which the channel appears in their sidebar and their
 * people take part in it here, labelled with their workspace. Same shape as
 * the guest invite dialog: link, code, duration, replace, revoke.
 */
export function shareChannelDialog(channel) {
  const content = el('div');
  let off = null;
  const modal = openModal({ title: `Share #${channel.name} with another workspace`, content, onClose: () => off?.() });
  let code = channel.connectInvite || null;
  let exp = channel.connectInviteExp || null;

  async function mint(ttl, btn) {
    if (btn.getAttribute('aria-busy') === 'true') return;
    const done = hold(btn, 'Creating');
    try {
      const res = await api.connectInvite(store.wsId, channel.id, ttl);
      code = res.code;
      exp = res.exp;
      Object.assign(channel, { connectInvite: code, connectInviteExp: exp });
      await store.refreshAfterChange();
      toast(`Share link ready, valid for ${INVITE_TTLS[ttl].label}`);
      render();
    } catch (err) {
      done();
      toast(err.message, { icon: 'alert' });
    }
  }
  function mintMenu(btn, replace) {
    if (btn.getAttribute('aria-busy') === 'true') return; // a link is being made from this button already
    openMenu(btn, [
      { header: replace ? 'New link, valid for' : 'Valid for' },
      ...Object.entries(INVITE_TTLS).map(([key, t]) => ({
        label: t.label, icon: 'link',
        onSelect: async () => {
          if (replace) {
            const ok = await confirmDialog({ title: 'Replace the share link?', message: 'The current link stops working immediately. Workspaces already connected stay connected.', confirmLabel: 'Replace', danger: false });
            if (!ok) return;
          }
          mint(key, btn);
        },
      })),
    ], { align: 'end', label: 'Link duration' });
  }
  function render() {
    keepFocus(content, draw);
  }
  function draw() {
    content.replaceChildren();
    const expired = !!exp && exp <= Date.now();
    const orgs = organizationsOf(channel).filter((o) => !o.us);
    content.append(el('div.callout', { html: icon('shared', 16) }, el('span', {},
      'An admin of the other workspace opens this link and picks which of their workspaces to add #', channel.name, ' to. Their people then join it here and see only this channel; everyone here sees who they are and where they are from.')));
    if (orgs.length) {
      content.append(el('p.small.muted', { style: { marginTop: '10px' } }, `Already shared with ${orgs.map((o) => o.name).join(', ')}.`));
    }
    if (!code || expired) {
      content.append(
        el('div.row', { style: { marginTop: '14px', justifyContent: 'center' } },
          el('button.btn.btn-primary', { type: 'button', html: icon('link', 16), 'aria-haspopup': 'menu', onclick: (e) => mintMenu(e.currentTarget, false) }, ' Create a share link')),
        el('div.modal-actions', {}, el('button.btn', { type: 'button', onclick: () => modal.close() }, 'Done')));
      return;
    }
    const server = parseRef(store.wsId)?.server;
    const link = connectLink(server, code);
    const token = makeInviteToken(code, server);
    const expiry = inviteExpiryText(exp);
    const copyBtn = (text, label) => {
      const btn = el('button.btn.btn-sm', { type: 'button', 'aria-label': `Copy ${label.toLowerCase()}` }, 'Copy');
      btn.addEventListener('click', async () => {
        try {
          await copyToClipboard(text);
          toast(`${label} copied`);
          btn.textContent = 'Copied';
          setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
        } catch {
          toast('Could not copy. Select the text and copy it manually', { icon: 'alert' });
        }
      });
      return btn;
    };
    content.append(
      el('div.field.mt', {},
        el('div.row', { style: { justifyContent: 'space-between' } }, el('span.field-label', {}, 'Share link'), el('span.pill', {}, expiry)),
        el('div.code-box', { style: { fontSize: '13px', letterSpacing: 0, fontFamily: 'var(--font)', fontWeight: 500 } },
          el('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, link), copyBtn(link, 'Link'))),
      el('div.field', {}, el('span.field-label', {}, 'Share code'),
        el('div.code-box', { style: { fontSize: '14px', letterSpacing: '0.02em' } },
          el('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, token), copyBtn(token, 'Code')),
        el('p.field-hint', {}, 'The other admin pastes either one under "Add a shared channel" in their workspace menu.')),
      inviteEmailRow({ kind: 'connect', channel, code, exp }),
      el('div.modal-actions', { style: { justifyContent: 'space-between' } },
        el('div.row', {},
          el('button.btn.btn-ghost', { type: 'button', html: icon('refresh', 15), 'aria-haspopup': 'menu', onclick: (e) => mintMenu(e.currentTarget, true) }, ' Replace'),
          el('button.btn.btn-ghost', {
            type: 'button', html: icon('x', 15),
            onclick: async (e) => {
              const btn = e.currentTarget;
              if (btn.getAttribute('aria-busy') === 'true') return;
              const ok = await confirmDialog({ title: 'Revoke the share link?', message: 'Nobody else can connect with it. Workspaces already connected stay connected.', confirmLabel: 'Revoke' });
              if (!ok) return;
              const done = hold(btn, 'Revoking');
              try {
                await api.revokeConnectInvite(store.wsId, channel.id);
                code = null;
                exp = null;
                delete channel.connectInvite;
                delete channel.connectInviteExp;
                await store.refreshAfterChange();
                toast('Share link revoked');
                render();
              } catch (err) {
                done();
                toast(err.message, { icon: 'alert' });
              }
            },
          }, ' Revoke')),
        el('button.btn', { type: 'button', onclick: () => modal.close() }, 'Done')));
  }
  // A share code minted or revoked elsewhere reaches here through the
  // workspace poll; re-sync from the channel and redraw only when this
  // channel's share code changed, so a stale one is never left to be copied.
  off = store.on('workspace', () => {
    const fresh = store.ws?.channels?.[channel.id];
    const nextCode = fresh?.connectInvite ?? null;
    const nextExp = fresh?.connectInviteExp ?? null;
    if (nextCode === code && nextExp === exp) return;
    code = nextCode;
    exp = nextExp;
    render();
  });
  render();
}

/**
 * Accept a share link: what it leads to (fetched from the host), which of
 * the user's workspaces to add the channel to (ones they administer), and
 * what to call it there. Accepting connects the two workspaces and opens the
 * channel.
 */
export function acceptConnectDialog({ server, code }) {
  const content = el('div', {}, el('div.msg-loader', {}, 'Looking up the channel'));
  let off = null;
  let closed = false;
  const modal = openModal({ title: 'Add a shared channel', content, onClose: () => { closed = true; off?.(); } });
  const hostUrl = parseRef(`000000@${server}`)?.url;
  // The workspaces the user administers: the open one as the store knows it,
  // the others as their workers last reported (one whose role is not known
  // yet is offered, and the accept itself checks before touching the host).
  const adminOf = (w) => (w.id === store.wsId && store.ws ? store.isAdmin() : !w.role || w.role === 'owner' || w.role === 'admin');
  const admins = store.workspaces.filter((w) => !w.unreachable && !w.movedTo && !w.sample && adminOf(w));
  if (!hostUrl) {
    content.replaceChildren(el('p.muted', {}, 'That link names a server address the app cannot call.'), el('div.modal-actions', {}, el('button.btn', { type: 'button', onclick: () => modal.close() }, 'Close')));
    return modal;
  }
  api.connectPreview(hostUrl, code).then((p) => {
    // Closed while the host was being asked: nothing to build, and no
    // subscription to leave running against a dialog that is gone.
    if (closed) return;
    // The host itself is not on offer: for an admin of both sides, the link
    // is for their other workspaces.
    const hostServer = parseRef(`000000@${server}`)?.server;
    const isHost = (w) => parseRef(w.id)?.id === p.workspace.id && parseRef(w.id)?.server === hostServer;
    const targets = admins.filter((w) => !isHost(w));
    if (!targets.length) {
      const own = admins.some(isHost);
      content.replaceChildren(
        el('div.callout', { html: icon('shared', 16) }, el('span', {}, own
          ? `#${p.channel.name} is ${p.workspace.name}'s own channel, and you administer no other workspace to add it to. A share link is for another workspace's admin.`
          : `${p.workspace.name} is sharing #${p.channel.name} with you. ${store.workspaces.length ? 'Only an admin can add a shared channel to a workspace, and you administer none of yours; ask one of their admins to open the link.' : 'Create a workspace first, then open the link again: a shared channel is added to a workspace you administer.'}`)),
        el('div.modal-actions', {}, el('button.btn', { type: 'button', onclick: () => modal.close() }, 'Close')));
      return;
    }
    const nameInput = el('input.input', { value: p.channel.name, maxlength: LIMITS.channelName, autocapitalize: 'off', spellcheck: false });
    const nameHint = 'How the channel is called in your workspace; the other workspace keeps its own name.';
    const nameField = field('Name here', el('div.input-prefix', {}, el('span', { html: icon('hash', 16) }), nameInput), nameHint);
    const select = el('select.select', { style: { width: '100%' }, 'aria-label': 'Add to workspace' }, ...targets.map((w) => el('option', { value: w.id }, w.name)));
    if (targets.some((w) => w.id === store.wsId)) select.value = store.wsId;
    const submit = el('button.btn.btn-primary', { type: 'submit' }, 'Add channel');
    const form = el('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        const name = cleanChannelName(nameInput.value);
        if (!name) return nameField.showError('Give the channel a name');
        const target = targets.find((w) => w.id === select.value);
        if (!target) return nameField.showError('Pick a workspace');
        const done = busy(submit, 'Connecting');
        try {
          const res = await store.acceptConnect({ server, code, wsRef: target.id, wsName: target.name, name, host: { ws: p.workspace.id, ch: p.channel.id } });
          modal.close();
          toast(`#${res.channel.name} from ${res.host.name} is now in ${target.name}`, { duration: 6000 });
          navigate({ ws: target.id, conv: res.channel.id, view: null });
        } catch (err) {
          done();
          nameField.showError(err.code === 'forbidden' ? 'Only admins of that workspace can add a shared channel' : err.code === 'invite_not_found' ? 'This share link is not valid or has expired. Ask for a new one.' : err.message);
        }
        return undefined;
      },
    },
    el('div.callout', { html: icon('shared', 16) }, el('span', {},
      el('strong', {}, p.workspace.name), ' is sharing ', el('strong', {}, `#${p.channel.name}`), p.channel.topic ? ` (${p.channel.topic})` : '', ` with you: ${p.channel.count} ${p.channel.count === 1 ? 'person' : 'people'} there`,
      p.connections.length ? `, already shared with ${p.connections.join(', ')}` : '', '. Members of the workspace you pick can join it and post; what they post is read there too.')),
    el('div.field.mt', {}, el('span.field-label', {}, 'Add to'), select, el('p.field-hint', {}, 'Workspaces you are an admin of.')),
    nameField,
    el('div.modal-actions', {}, el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Not now'), submit));
    previewChannelName(nameInput, nameField, nameHint);
    // A workspace that already holds this channel (a connection being
    // renewed, or one that ended and is being made again) keeps its entry
    // under the name it has there; the worker leaves both alone. So the
    // field says as much rather than asking for a name that would not take.
    // (Known for the open workspace; the accept itself checks the others.)
    const hostRef = makeRef(p.workspace.id, hostServer);
    const heldBy = (w) => (w.id === store.wsId && store.ws ? Object.values(store.ws.channels || {}).find((c) => c.shared?.ref === hostRef && c.shared?.ch === p.channel.id) : null);
    const syncName = () => {
      const target = targets.find((w) => w.id === select.value);
      const held = target ? heldBy(target) : null;
      nameInput.disabled = !!held;
      if (held) {
        nameInput.value = held.name;
        nameField.showHint(`${target.name} already has this channel as #${held.name}${held.lost ? ', no longer shared' : ''}. Adding it again ${held.lost ? 'reconnects it' : 'renews the connection'} and keeps that name.`);
        submit.textContent = held.lost ? 'Reconnect' : 'Renew connection';
      } else {
        submit.textContent = 'Add channel';
        nameInput.dispatchEvent(new Event('input'));
      }
    };
    select.addEventListener('change', syncName);
    syncName();
    // Whether the entry's connection is over is the host's word, which may
    // arrive after the preview did (a link opened at startup, before the
    // host has answered): the field follows it, so "renew" becomes
    // "reconnect" once that is what it is.
    off = store.on('workspace', syncName);
    content.replaceChildren(form);
  }).catch((e) => {
    content.replaceChildren(
      el('p.muted', {}, e.code === 'invite_not_found' ? 'This share link is not valid or has expired. Ask the other workspace for a new one.'
        : e.code === 'too_many_attempts' ? e.message
          : e.code === 'no_backend' || e.code === 'network' ? 'The workspace behind this link is not reachable right now.' : e.message),
      el('div.modal-actions', {}, el('button.btn', { type: 'button', onclick: () => modal.close() }, 'Close')));
  });
  return modal;
}

/** Paste a share link or code from another workspace's admin. */
export function addSharedChannelDialog() {
  const input = el('input.input', { placeholder: 'Share link, or XXXX-XXXX-XXXX@server', autocapitalize: 'off', spellcheck: false, autocomplete: 'off' });
  const f = field('Share link or code', input, 'An admin of the other workspace gets it from the channel’s details ("Share with another workspace").');
  const submit = el('button.btn.btn-primary', { type: 'submit' }, 'Continue');
  const form = el('form', {
    onsubmit: (e) => {
      e.preventDefault();
      const parsed = parseConnectInput(input.value);
      if (!parsed?.code || !parsed.server) return f.showError('Paste the whole share link, or the code with its server (XXXX-XXXX-XXXX@server)');
      modal.close();
      acceptConnectDialog(parsed);
      return undefined;
    },
  }, f, el('div.modal-actions', {}, el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'), submit));
  const modal = openModal({ title: 'Add a shared channel', content: form });
  setTimeout(() => input.focus(), 0);
}

/**
 * Admins: every channel shared with another workspace, hosted here or
 * there, with who is in it from where, and the way to end each connection.
 */
export function sharedChannelsDialog() {
  const content = el('div');
  const list = el('div');
  content.append(el('p.small.muted', { style: { marginBottom: '12px' } },
    'A shared channel is one channel two or more workspaces are in together. It lives on one of them; the others hold it in their sidebar, and their members take part labelled with their workspace.'),
  list,
  el('div.modal-actions', { style: { justifyContent: 'space-between' } },
    el('button.btn.btn-outline', { type: 'button', html: icon('shared', 16), onclick: () => { modal.close(); addSharedChannelDialog(); } }, ' Add a shared channel'),
    el('button.btn', { type: 'button', onclick: () => modal.close() }, 'Done')));
  let off = null;
  const modal = openModal({ title: 'Shared channels', content, wide: true, onClose: () => off?.() });
  function render() {
    keepFocus(list, draw);
  }
  function draw() {
    // Not a private channel nobody is left in: it is listed to admins only to be deleted, and the worker refuses every change to it.
    const channels = Object.values(store.ws?.channels || {}).filter((c) => !c.orphan && (c.shared || Object.keys(c.connections || {}).length)).sort((a, b) => a.name.localeCompare(b.name));
    list.replaceChildren();
    if (!channels.length) {
      list.append(el('div.empty', { style: { padding: '20px' } }, el('div.empty-icon', { html: icon('shared', 22) }), el('h3', {}, 'No shared channels yet'),
        el('p', {}, 'Share one of your channels from its details, or add a channel another workspace shared with you.')));
      return;
    }
    list.append(el('div.details-card', {}, ...channels.map((c) => {
      const orgs = organizationsOf(c).filter((o) => !o.us);
      const sub = c.shared ? `Hosted by ${c.shared.host || 'another workspace'}${orgs.length > 1 ? `, with ${orgs.filter((o) => !o.owner).map((o) => o.name).join(', ')}` : ''}` : `Hosted here, shared with ${orgs.map((o) => `${o.name} (${o.count})`).join(', ')}`;
      return el('div.details-row', {},
        el('span', { html: icon(channelIcon(c), 18) }),
        el('span.details-text', {}, el('strong', {}, c.name), el('span', {}, sub)),
        el('button.btn.btn-sm.btn-ghost', { type: 'button', onclick: () => { modal.close(); navigate({ ws: store.wsId, conv: c.id, details: true, view: null }); } }, 'Details'));
    })));
  }
  render();
  off = store.on('workspace', render);
}

/**
 * Integrations: incoming webhooks (post to one channel from a script) and
 * bot tokens (post to, read, and react in the channels they are added to).
 * A token is shown exactly once, right after it is created or rotated.
 */
export function integrationsDialog() {
  const content = el('div');
  const list = el('div');
  const base = parseRef(store.wsId)?.url || '';
  content.append(el('p.small.muted', { style: { marginBottom: '12px' } },
    'Let CI, scripts, and other apps post into this workspace. A webhook posts to one channel and can read nothing; a bot token can post to, read, and react in the channels you add it to. Tokens are shown once.'),
    list,
    el('div.modal-actions', { style: { justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' } },
      el('div.row', {},
        el('button.btn.btn-outline', { type: 'button', html: icon('webhook', 16), onclick: () => createIntegrationDialog('webhook', render) }, ' New webhook'),
        el('button.btn.btn-outline', { type: 'button', html: icon('bot', 16), onclick: () => createIntegrationDialog('bot', render) }, ' New bot token')),
      el('button.btn', { type: 'button', onclick: () => modal.close() }, 'Done')));
  const modal = openModal({ title: 'Integrations', content, wide: true });

  async function render() {
    const restore = focusMemo(list);
    await draw();
    restore();
  }
  async function draw() {
    list.replaceChildren(el('div.msg-loader', {}, 'Loading'));
    try {
      const { webhooks, bots } = await api.integrations(store.wsId);
      list.replaceChildren();
      if (!webhooks.length && !bots.length) {
        list.append(el('div.empty', { style: { padding: '20px' } }, el('div.empty-icon', { html: icon('plug', 22) }), el('h3', {}, 'Nothing connected yet'), el('p', {}, 'Create a webhook and post to it with one curl.')));
        return;
      }
      if (webhooks.length) list.append(el('h3.field-label', { style: { margin: '6px 0' } }, 'Webhooks'), el('div.details-card', {}, ...webhooks.map((h) => integrationRow(h, 'webhook'))));
      if (bots.length) list.append(el('h3.field-label', { style: { margin: '14px 0 6px' } }, 'Bot tokens'), el('div.details-card', {}, ...bots.map((b) => integrationRow(b, 'bot'))));
    } catch (e) {
      list.replaceChildren(el('div.empty', {}, el('p', {}, e.message)));
    }
  }

  function integrationRow(item, kind) {
    // A private channel the admin is not in is kept from them (the webhook
    // comes without its channel, marked private; a bot with the channels
    // they can see and how many are kept): said so, rather than "#?", and
    // the token is not theirs to rotate, since a fresh one would open it.
    const withheld = kind === 'webhook' ? !!item.private && !item.ch : Number(item.hidden) > 0;
    const kept = withheld && kind === 'bot' ? `${item.hidden} private channel${Number(item.hidden) === 1 ? '' : 's'} you are not in` : null;
    // An archived channel is said to be: the worker refuses every post into
    // it (a webhook's, a bot's), and the row read as any other's, so the
    // admin looking into why a build's notices stopped saw nothing amiss here.
    const named = (c) => {
      const ch = store.channel(c);
      return ch ? `#${ch.name}${ch.archived ? ' (archived)' : ''}` : '#?';
    };
    const where = kind === 'webhook'
      ? (withheld ? 'a private channel you are not in' : named(item.ch))
      : [...(item.channels || []).map(named), kept].filter(Boolean).join(', ') || 'no channels yet';
    const sub = `${where} · ${item.lastUsed ? `last used ${relativeLong(item.lastUsed)}` : 'never used'}${kind === 'bot' ? ` · ${(item.scopes || []).join(', ')}` : ''}`;
    return el('div.details-row', {},
      el('span.avatar.avatar-sm.avatar-bot', { dataset: { color: String(item.color || 8) }, 'aria-hidden': 'true' }, el('span', { html: icon('bot', 14, 2) })),
      el('span.details-text', {}, el('strong', {}, item.name), el('span', {}, sub)),
      el('button.icon-btn.icon-btn-sm', {
        type: 'button', html: icon('more', 16), 'aria-label': `Manage ${item.name}`, 'aria-haspopup': 'menu',
        onclick: (e) => openMenu(e.currentTarget, [
          kind === 'bot' && { label: 'Channels and scopes', icon: 'hash', onSelect: () => editBotDialog(item, render) },
          { label: 'Rotate token', icon: 'key', disabled: withheld, sub: withheld ? 'An admin in its private channel can rotate it' : 'The current token stops working', onSelect: async () => {
            const ok = await confirmDialog({ title: `Rotate ${item.name}\u2019s token?`, message: 'Anything using the current token stops working until you give it the new one.', confirmLabel: 'Rotate', danger: false });
            if (!ok) return;
            try {
              const r = kind === 'webhook' ? await api.rotateWebhook(store.wsId, item.id) : await api.rotateBot(store.wsId, item.id);
              showTokenDialog(kind, { ...item, token: r.token });
            } catch (err) {
              toast(err.message, { icon: 'alert' });
            }
          } },
          { label: 'Revoke', icon: 'trash', danger: true, onSelect: async () => {
            const ok = await confirmDialog({ title: `Revoke ${item.name}?`, message: 'Requests with its token are refused from now on. Messages it posted stay.', confirmLabel: 'Revoke' });
            if (!ok) return;
            try {
              if (kind === 'webhook') await api.deleteWebhook(store.wsId, item.id);
              else await api.deleteBot(store.wsId, item.id);
              await store.refreshAfterChange();
              toast('Revoked');
              render();
            } catch (err) {
              toast(err.message, { icon: 'alert' });
            }
          } },
        ], { align: 'end' }),
      }));
  }

  function showTokenDialog(kind, made) {
    const url = kind === 'webhook' ? `${base}/webhook/${made.token}` : `${base}/bot/${made.token}/channels/{channel}/messages`;
    const example = kind === 'webhook'
      ? `curl -X POST '${url}' \\\n  -H 'Content-Type: application/json' \\\n  -d '{"text": "Build 42 passed"}'`
      : `curl -X POST '${base}/bot/${made.token}/channels/${(made.channels || [])[0] || 'CHANNEL_ID'}/messages' \\\n  -H 'Content-Type: application/json' \\\n  -d '{"text": "Hello from a bot"}'`;
    const copyBtn = (text, label) => el('button.btn.btn-sm', {
      type: 'button',
      onclick: (e) => {
        const btn = e.currentTarget;
        copyToClipboard(text).then(() => {
          toast(`${label} copied`);
          btn.textContent = 'Copied';
          setTimeout(() => { btn.textContent = 'Copy'; }, 1500); // and can be copied again, as in the invite dialogs
        }).catch(() => toast('Could not copy', { icon: 'alert' }));
      },
    }, 'Copy');
    const body = el('div', {},
      el('div.callout.callout-danger', { html: icon('alert', 16) }, el('span', {}, 'This is the only time the token is shown. Copy it now and keep it like a password: anyone with it can post as this integration.')),
      el('div.field.mt', {}, el('span.field-label', {}, kind === 'webhook' ? 'Webhook URL' : 'Token'),
        el('div.code-box', { style: { fontSize: '12.5px', letterSpacing: 0 } }, el('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, kind === 'webhook' ? url : made.token), copyBtn(kind === 'webhook' ? url : made.token, kind === 'webhook' ? 'URL' : 'Token'))),
      el('div.field', {}, el('span.field-label', {}, 'Try it'),
        el('pre.code-block.token-example', {}, example), el('div.row.row-end', {}, copyBtn(example.replace(/\\\n/g, ''), 'Command'))),
      el('p.field-hint', {}, kind === 'webhook' ? `Posts to #${store.channel(made.channel || made.ch)?.name}. Accepts { "text": "..." } or a blocks/attachments payload; up to 60 posts a minute; it cannot read anything.` : 'Bot routes: POST and GET /bot/{token}/channels/{channel}/messages, POST .../messages/{seq}/reactions, within the scopes you chose; up to 60 calls a minute.'),
      el('div.modal-actions', {}, el('button.btn.btn-primary', { type: 'button', onclick: () => tokenModal.close() }, 'I copied it')));
    const tokenModal = openModal({ title: `${made.name} is ready`, content: body });
  }

  function createIntegrationDialog(kind, done) {
    const nameInput = el('input.input', { placeholder: kind === 'webhook' ? 'e.g. Deploys' : 'e.g. Release bot', maxlength: LIMITS.webhookName });
    const nameField = field('Name', nameInput, 'Shown as the author of what it posts, with an APP tag.');
    // What the worker takes: an archived channel is refused, and a channel
    // hosted by another workspace has its integrations set up there (the
    // worker refuses one for a webhook and drops one from a bot's list). Nor
    // a private channel nobody is left in: listed to admins only to be deleted.
    const channels = Object.values(store.ws?.channels || {}).filter((c) => !c.archived && !c.shared && !c.orphan).sort((a, b) => a.name.localeCompare(b.name));
    const select = el('select.select', { style: { width: '100%' }, 'aria-label': 'Posts to channel' }, ...channels.map((c) => el('option', { value: c.id }, `#${c.name}`)));
    // Offered first: the channel the admin has open, when it is one of these
    // (the dialog is reached with the channel a script should post into in
    // front of them), else the workspace's default channel. The list's
    // order (by name) put whichever channel sorted first there, a private
    // channel as readily as any, and a Create pressed without a look at the
    // field bound the webhook to it.
    const preferred = channels.find((c) => c.id === store.openConv) || channels.find((c) => c.def) || channels[0];
    if (preferred) select.value = preferred.id;
    // A webhook needs a channel: with none to offer, the field says so and
    // Create stays off, rather than an empty id going up and the worker's
    // "Channel not found" landing under the name.
    const noChannel = kind === 'webhook' && !channels.length;
    const picked = new Set();
    const chanList = el('div.pick-list', { role: 'listbox', 'aria-multiselectable': 'true', 'aria-label': 'Channels the bot may use' });
    // The arrows step through the channels, Home and End to the first and
    // the last, as through the people of a new message (the listbox
    // pattern); Tab still walks them one by one as before.
    listKeyNav(chanList, '.pick-item');
    const renderChans = () => rerender(chanList, ...channels.map((c) => el('button.pick-item', {
      type: 'button', role: 'option', 'aria-checked': String(picked.has(c.id)), 'aria-selected': String(picked.has(c.id)),
      onclick: () => { if (picked.has(c.id)) picked.delete(c.id); else picked.add(c.id); renderChans(); },
    }, el('span', { html: icon(channelIcon(c), 16), style: { color: 'var(--ink-3)' } }), el('span.pick-text', {}, el('strong', {}, c.name)), el('span.pick-check', { html: icon('check', 14, 3) }))));
    renderChans();
    const scopes = new Set(['post']);
    // The worker wants at least one scope: said under the scopes when every
    // switch is off, not under the name.
    const scopesErr = el('p.field-error', { hidden: true, role: 'alert' });
    const scopeRow = (key, label, sub) => switchRow({ label, sub, checked: scopes.has(key), onChange: (v) => { if (v) scopes.add(key); else scopes.delete(key); if (scopes.size) scopesErr.hidden = true; } });
    // The colour follows the name as it is typed, the way the worker would
    // pick one, until a dot is chosen by hand.
    let color = colorSlotFor(nameInput);
    let colorPicked = false;
    const colors = el('div.color-row', { role: 'radiogroup', 'aria-label': 'Color' });
    const roveColors = radioNav(colors);
    const renderColors = () => {
      rerender(colors, ...Array.from({ length: 8 }, (_, i) => i + 1).map((c) => el('button.color-dot', {
        type: 'button', role: 'radio', 'aria-checked': String(c === color), 'aria-label': `Color ${c}`,
        style: { background: `var(--av-${c})`, color: `var(--av-${c}-ink)` }, html: c === color ? icon('check', 16, 3) : '',
        onclick: () => { color = c; colorPicked = true; renderColors(); },
      })));
      roveColors();
    };
    renderColors();
    nameInput.addEventListener('input', () => {
      if (colorPicked) return;
      color = colorSlotFor(nameInput);
      renderColors();
    });
    const submit = el('button.btn.btn-primary', { type: 'submit', disabled: noChannel }, 'Create');
    const form = el('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        const name = nameInput.value.trim();
        if (!name) return nameField.showError('Give it a name');
        if (noChannel) return undefined;
        if (kind === 'bot' && !scopes.size) {
          scopesErr.textContent = 'Pick at least one scope';
          scopesErr.hidden = false;
          return undefined;
        }
        const busyDone = busy(submit, 'Creating');
        try {
          const made = kind === 'webhook'
            ? await api.createWebhook(store.wsId, { channel: select.value, name, color })
            : await api.createBot(store.wsId, { name, color, channels: [...picked], scopes: [...scopes] });
          await store.refreshAfterChange();
          createModal.close();
          showTokenDialog(kind, made);
          done();
        } catch (err) {
          busyDone();
          nameField.showError(err.message);
        }
      },
    },
    nameField,
    kind === 'webhook'
      ? el('div.field', {}, el('span.field-label', {}, 'Posts to'),
        noChannel ? el('p.field-error', {}, 'No channel to post into: unarchive one first, or create one.') : select,
        !noChannel && el('p.field-hint', {}, 'One channel per webhook.'))
      : el('div', {},
        el('div.field', {}, el('span.field-label', {}, 'Channels it may use'), chanList, el('p.field-hint', {}, channels.length ? 'You can change these later.' : 'No channel to add yet: unarchive or create one, then add it from the bot’s menu.')),
        el('div.field', {}, el('span.field-label', {}, 'Scopes'),
          scopeRow('post', 'Post messages', 'Write into its channels'),
          scopeRow('read', 'Read messages', 'Fetch pages of its channels'),
          scopeRow('react', 'React', 'Add and remove reactions'),
          scopesErr)),
    el('div.field', {}, el('span.field-label', {}, 'Color'), colors),
    el('div.modal-actions', {}, el('button.btn.btn-ghost', { type: 'button', onclick: () => createModal.close() }, 'Cancel'), submit));
    const createModal = openModal({ title: kind === 'webhook' ? 'New incoming webhook' : 'New bot token', content: form });
  }

  function editBotDialog(bot, done) {
    const picked = new Set(bot.channels || []);
    // As when creating one: a channel hosted elsewhere is not this bot's to
    // use (the worker drops it from the list), nor a private channel nobody
    // is left in. An archived channel is not offered, but one the bot is
    // already in is listed, marked, so that it can be taken off: unlisted, as
    // it used to be, it stayed on the bot (the list is what is sent) with no
    // way but revoking the bot to take it off, while the admins' list kept
    // saying "(archived)" beside it.
    const channels = Object.values(store.ws?.channels || {}).filter((c) => !c.shared && !c.orphan && (!c.archived || picked.has(c.id))).sort((a, b) => a.name.localeCompare(b.name));
    const scopes = new Set(bot.scopes || ['post']);
    const scopesErr = el('p.field-error', { hidden: true, role: 'alert' });
    const chanList = el('div.pick-list', { role: 'listbox', 'aria-multiselectable': 'true', 'aria-label': 'Channels the bot may use' });
    listKeyNav(chanList, '.pick-item'); // the arrows, Home and End, as when the bot was made
    const renderChans = () => rerender(chanList, ...channels.map((c) => el('button.pick-item', {
      type: 'button', role: 'option', 'aria-checked': String(picked.has(c.id)), 'aria-selected': String(picked.has(c.id)),
      onclick: () => { if (picked.has(c.id)) picked.delete(c.id); else picked.add(c.id); renderChans(); },
    }, el('span', { html: icon(c.archived ? 'archive' : channelIcon(c), 16), style: { color: 'var(--ink-3)' } }),
    el('span.pick-text', {}, el('strong', {}, c.name, c.archived && el('span.pill.pill-inline', {}, 'Archived'))),
    el('span.pick-check', { html: icon('check', 14, 3) }))));
    renderChans();
    const scopeRow = (key, label) => switchRow({ label, checked: scopes.has(key), onChange: (v) => { if (v) scopes.add(key); else scopes.delete(key); if (scopes.size) scopesErr.hidden = true; } });
    const save = el('button.btn.btn-primary', { type: 'button', onclick: async () => {
      // The worker refuses a bot with no scope; said under the switches.
      if (!scopes.size) {
        scopesErr.textContent = 'Pick at least one scope';
        scopesErr.hidden = false;
        return;
      }
      const d = busy(save, 'Saving');
      try {
        await api.updateBot(store.wsId, bot.id, { channels: [...picked], scopes: [...scopes] });
        await store.refreshAfterChange();
        editModal.close();
        toast('Bot updated');
        done();
      } catch (err) {
        d();
        toast(err.message, { icon: 'alert' });
      }
    } }, 'Save');
    const editModal = openModal({ title: `${bot.name}: channels and scopes`, content: el('div', {},
      el('div.field', {}, el('span.field-label', {}, 'Channels'), chanList),
      el('div.field', {}, el('span.field-label', {}, 'Scopes'), scopeRow('post', 'Post messages'), scopeRow('read', 'Read messages'), scopeRow('react', 'React'), scopesErr),
      el('div.modal-actions', {}, el('button.btn.btn-ghost', { type: 'button', onclick: () => editModal.close() }, 'Cancel'), save)) });
  }

  render();
}

/** A stable colour from the name typed so far, as a default. */
function colorSlotFor(input) {
  let h = 0;
  for (const ch of input.value || 'app') h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return (h % 8) + 1;
}

/**
 * The export running for a workspace, by its reference (see exportDialog):
 * whether one runs, where it has got to, and the dialog showing it. Kept
 * for the session, as transferState is: the dialog closed while the export
 * runs and opened again shows that export rather than offering another.
 */
const exportState = new Map();

/** Export the whole workspace into the user's Puter drive, with progress. */
export function exportDialog() {
  const ws = store.ws;
  if (!ws) return;
  const ref = store.wsId;
  const state = exportState.get(ref) || { running: false, status: '', shown: null };
  exportState.set(ref, state);
  const status = el('p.small', { role: 'status', 'aria-live': 'polite', style: { minHeight: '20px', marginTop: '12px' } });
  const start = el('button.btn.btn-primary', { type: 'button' }, 'Export now');
  const done = el('button.btn', { type: 'button', onclick: () => modal.close() }, 'Close');
  // The export carries on after Close (it is long, and the dialog says to
  // keep the tab open, not the dialog): its end is then a toast either way,
  // not a line on a status node nobody sees any more. And the dialog opened
  // again meanwhile (from Workspace settings) shows the export still going,
  // its button busy, rather than offering "Export now" over it: pressed, that
  // began a second export of the same workspace beside the first, twice the
  // reads of the owner's store for one archive, written into the same folder.
  // Stopped while no dialog showed it, the next one opened says where it
  // stopped and offers to try again; done, the next one starts afresh.
  // This dialog is the one showing the export, until it closes or another opens.
  const shown = {
    say: (t) => { status.textContent = t; },
    saved: (folder, missing) => {
      // Attachments the drive did not get (their bytes gone from the server,
      // or the write refused), counted by the writer as it goes (see
      // writeArchiveToDrive): said with the folder, since "Saved" alone
      // stood over a files folder with some of them missing, and the reader
      // found out when a page's link led nowhere.
      status.replaceChildren('Done. Saved to ', el('code', {}, folder), ' in your Puter drive: open index.html to read it, or import messages.json into another account\u2019s Teamchat.',
        missing ? ` Every message is there; ${missing === 1 ? 'one attachment' : `${missing} attachments`} could not be written into its files folder (the bytes were not on the server, or the drive refused them), so ${missing === 1 ? 'its link' : 'their links'} on the pages ${missing === 1 ? 'leads' : 'lead'} nowhere.` : '');
      // Done, the button is disabled for good, the keyboard moved on to Close first.
      start.removeAttribute('aria-busy');
      if (document.activeElement === start) done.focus({ preventScroll: true });
      start.disabled = true;
    },
    stopped: () => { start.removeAttribute('aria-busy'); },
  };
  state.shown = shown;
  // One export at a time, busy rather than disabled while it runs (see
  // pressOnce): a disabled button under the keyboard hands its focus to the
  // page body, for the minutes an export takes, and after a failure came
  // back live with nobody on it.
  const running = () => {
    start.setAttribute('aria-busy', 'true');
    status.textContent = state.status;
  };
  if (state.running) running();
  else if (state.status) status.textContent = state.status;
  start.addEventListener('click', async () => {
    if (state.running) return;
    state.running = true;
    running();
    const report = (t) => { state.status = t; state.shown?.say(t); };
    report('Reading the workspace');
    try {
      const archive = await exportWorkspace(ref, { onProgress: (p) => report(progressText(p)) });
      let missing = 0;
      const folder = await writeArchiveToDrive(ref, archive, { onProgress: (p) => { report(progressText(p)); if (typeof p?.missing === 'number') missing = p.missing; } });
      state.running = false;
      state.status = '';
      state.shown?.saved(folder, missing);
      toast(missing ? `Workspace exported; ${missing === 1 ? 'one attachment' : `${missing} attachments`} could not be written` : 'Workspace exported', missing ? { icon: 'alert', duration: 6000 } : {});
    } catch (e) {
      state.running = false;
      report(`Stopped: ${e.message}. Try again; nothing on the server changed.`);
      state.shown?.stopped();
      if (!state.shown) toast(`Export stopped: ${e.message}`, { icon: 'alert', duration: 8000 });
    }
  });
  const modal = openModal({ title: `Export ${ws.name}`, content: el('div', {},
    el('p', { style: { color: 'var(--ink-2)', fontSize: '14px' } }, 'A complete archive of this workspace: channels, members, every message with its reactions and edits, threads, pins, and attachment bytes.'),
    el('ul.small.muted', { style: { paddingLeft: '18px', marginTop: '8px', listStyle: 'disc' } },
      el('li', {}, el('code', {}, 'messages.json'), ' — the archive, which another account can import'),
      el('li', {}, el('code', {}, 'index.html'), ' and one page per conversation — plain HTML, readable years from now, searchable with your browser'),
      el('li', {}, el('code', {}, 'files/'), ' — the attachments')),
    el('p.small.muted', { style: { marginTop: '8px' } }, 'It is written into your own Puter drive under Teamchat exports. Large workspaces take a while; keep this tab open.'),
    status,
    el('div.modal-actions', {}, done, start)), onClose: () => { if (state.shown === shown) state.shown = null; } });
}

/**
 * Owner: nominate an admin. The nominee's app moves the data with their own
 * session onto their own server and marks this copy as moved.
 */
export function transferDialog() {
  const ws = store.ws;
  if (!ws || ws.owner !== store.uuid) return;
  const admins = Object.entries(ws.members).filter(([u, m]) => u !== store.uuid && m.role === 'admin');
  let picked = ws.transferTo || admins[0]?.[0] || null;
  const list = el('div.pick-list', { role: 'radiogroup', 'aria-label': 'New owner' });
  const rove = radioNav(list);
  const render = () => {
    rerender(list, ...admins.map(([u, m]) => el('button.pick-item', {
      type: 'button', role: 'radio', 'aria-checked': String(picked === u), 'aria-selected': String(picked === u), onclick: () => { picked = u; render(); },
    }, avatar({ uuid: u, ...m }, { size: 'sm' }), el('span.pick-text', {}, el('strong', { dir: 'auto' }, m.name), el('span', {}, `@${m.username}`)), el('span.pick-check', { html: icon('check', 14, 3) }))));
    rove();
  };
  render();
  const submit = el('button.btn.btn-primary', { type: 'button', disabled: !picked }, ws.transferTo ? 'Change nominee' : 'Nominate');
  submit.addEventListener('click', async () => {
    const d = busy(submit, 'Saving');
    try {
      await api.transfer(store.wsId, { to: picked });
      await store.refreshAfterChange();
      modal.close();
      toast(`${store.member(picked).name} can now accept the transfer from their Workspace settings`, { duration: 6000 });
    } catch (e) {
      d();
      toast(e.message, { icon: 'alert' });
    }
  });
  // One press at a time (see pressOnce), as Nominate takes one: the press
  // waits on the worker, and the button stayed live meanwhile, so a second
  // press (a double click, Enter again) sent a second cancel, refused over
  // the "Transfer cancelled" just said. Busy, not disabled, so the keyboard
  // stays on the button through the wait.
  const cancel = ws.transferTo ? el('button.btn.btn-ghost', { type: 'button' }, 'Cancel transfer') : null;
  cancel?.addEventListener('click', pressOnce(cancel, async () => {
    try {
      await api.transfer(store.wsId, { cancel: true });
      await store.refreshAfterChange();
      modal.close();
      toast('Transfer cancelled');
    } catch (e) {
      toast(e.message, { icon: 'alert' });
    }
  }));
  const modal = openModal({ title: 'Transfer ownership', content: el('div', {},
    el('p', { style: { color: 'var(--ink-2)', fontSize: '14px', marginBottom: '10px' } },
      'The workspace and all of its data move to the new owner\u2019s Puter account. You nominate an admin here; when they accept, their app copies everything onto their own server, members are carried across without re-joining, and this copy becomes read-only so nothing is lost while links catch up. You can delete the old copy afterwards. Webhooks and bot tokens do not move: the new owner makes them again from Workspace settings, and anything posting through the old ones stops.'),
    admins.length ? list : el('p.muted', {}, 'Make someone an admin first, from Members.'),
    el('div.modal-actions', { style: { justifyContent: 'space-between' } }, cancel || el('span'), el('div.row', {}, el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Close'), submit))) });
}

/**
 * What an attempt to accept a transfer left behind, by the original's
 * reference: the copy it made, for the next attempt to finish with rather
 * than make another (see transferWorkspace). Kept for the session, so the
 * dialog closed and opened again carries on as well.
 */
const transferState = new Map();

/**
 * The nominee: accept, and move the workspace onto their own server. The
 * move takes minutes and goes on whether the dialog stays open or not: the
 * dialog shows its progress while open, says on closing that the move
 * carries on and where to follow it, and opened again while it runs (from
 * the banner's Review) shows the progress where the last one left off,
 * rather than offering to start the same move a second time; when the move
 * completes, whichever dialog is showing it closes with it.
 */
export async function acceptTransferDialog() {
  const ws = store.ws;
  if (!ws || ws.transferTo !== store.uuid) return;
  const status = el('p.small', { role: 'status', 'aria-live': 'polite', style: { minHeight: '20px', marginTop: '12px' } });
  const start = el('button.btn.btn-primary', { type: 'button' }, 'Accept and move it here');
  const dismiss = el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Not now');
  const oldRef = store.wsId;
  const state = transferState.get(oldRef) || { copy: null, running: false, status: '', shown: null };
  transferState.set(oldRef, state);
  // Webhooks and bot tokens are not in what a move carries (the archive
  // holds channels, members, messages, pins, files and the queue; a token is
  // the old server's alone and dies with the copy left behind): said only
  // when the workspace has any, to whoever accepts, and again when the move
  // is done, since it is then that they must be made again, on the new server.
  const integrations = store.ws?.integrations || 0;
  const remade = integrations
    ? ` ${integrations === 1 ? 'The workspace had one webhook or bot token, and it did' : `The workspace had ${integrations} webhooks or bot tokens, and they did`} not move: make ${integrations === 1 ? 'it' : 'them'} again from Workspace settings on the new server, and give the new token${integrations === 1 ? '' : 's'} to whatever posted through the old.`
    : '';
  // This dialog is the one showing the move, until it closes or another opens.
  const shown = {
    say: (t) => { status.textContent = t; },
    close: () => modal.close(),
    stopped: () => { start.removeAttribute('aria-busy'); dismiss.textContent = 'Not now'; },
  };
  state.shown = shown;
  const running = () => {
    // Busy, not disabled, so a keyboard on the button stays on it (a
    // disabled button under the keyboard hands its focus to the page body).
    start.setAttribute('aria-busy', 'true');
    dismiss.textContent = 'Close';
    status.textContent = state.status;
  };
  if (state.running) running();
  // Opened again after the move stopped while no dialog was showing it (the
  // toast said so then): where it stopped, and that trying again carries on
  // from there, are read here too, rather than the opening words alone over
  // an empty line, as if nothing had been tried.
  else if (state.status) status.textContent = state.status;
  start.addEventListener('click', async () => {
    if (state.running) return;
    state.running = true;
    running();
    const report = (t) => { state.status = t; state.shown?.say(t); };
    try {
      report('Preparing your server');
      const target = await store.ensureOwnWorker(report);
      const moved = await transferWorkspace(oldRef, target.url, state, { profile: store.profileSeed(), icon: !!ws.icon, onProgress: (p) => report(progressText(p)) });
      await store._addWorkspace({ ref: moved.ref, name: ws.name, icon: moved.icon });
      await store.forgetWorkspace(oldRef);
      state.running = false;
      state.shown?.close();
      // What the new server could not take of the queue (see leftBehindText):
      // said with the rest, or the nominee was told the workspace was theirs
      // and nothing of the scheduled messages left in the old copy.
      const left = moved.mine ? leftBehindText(moved.scheduled) : '';
      toast(moved.mine ? `The workspace is now yours, on your server.${remade}${left ? ` ${left}` : ''}` : 'The workspace had already moved; opening it where it is', { duration: integrations || left ? 12000 : 8000 });
      navigate({ ws: moved.ref });
    } catch (e) {
      state.running = false;
      report(`Stopped: ${e.message}. Nothing is lost; try again and it carries on from here.`);
      state.shown?.stopped();
      // Said where the reader is, when the dialog showing the move is closed:
      // the status line above was in it.
      if (!state.shown) toast(`Moving ${ws.name} stopped: ${e.message}. Open Review from the banner to try again; it carries on from where it left off`, { icon: 'alert', duration: 8000 });
    }
  });
  const modal = openModal({
    title: `Take over ${ws.name}?`,
    content: el('div', {},
      el('p', { style: { color: 'var(--ink-2)', fontSize: '14px' } },
        `${store.member(ws.owner).name} asked you to become the owner. Accepting copies the whole workspace onto a server in your Puter account (created now if you have none), keeps every member, and leaves the old copy read-only. Storage and execution for it will count against your Puter allowance from then on. Webhooks and bot tokens stay behind: make them again from Workspace settings once the workspace is here.`),
      status,
      el('div.modal-actions', {}, dismiss, start)),
    onClose: () => {
      if (state.shown === shown) state.shown = null;
      // Closed (Not now, Escape, the scrim) while the move runs: the move
      // does not stop with the dialog, and the workspace stays paused
      // meanwhile, so say so and where to follow it, rather than leaving the
      // reader to wonder why nothing can be posted and be taken to the new
      // server minutes later without a word.
      if (state.running) toast(`Moving ${ws.name} carries on in the background; nothing can be posted there until it is done. Review, in the banner over the conversation, shows how far it is, and the workspace opens on your server when it is done`, { duration: 8000 });
    },
  });
}

/**
 * The import running in this session (see importWorkspaceDialog): whether
 * one runs, where it has got to, and the dialog showing it. One at a time
 * (the workspace it makes has no reference to keep it by until it is made),
 * kept as exportState is: the dialog closed while the import runs and opened
 * again shows that import rather than taking a second file.
 */
const importState = { running: false, status: '', shown: null };

/** Import a workspace from an exported messages.json (a local file or a file in the user's drive). */
export function importWorkspaceDialog() {
  const state = importState;
  const input = el('input', { type: 'file', accept: 'application/json,.json', hidden: true, 'aria-hidden': 'true', tabindex: -1 });
  const status = el('p.small', { role: 'status', 'aria-live': 'polite', style: { minHeight: '20px', marginTop: '12px' } });
  // The picker does not open while an import runs: a second file chosen
  // meanwhile would make a second workspace beside the one being made.
  const pick = el('button.btn.btn-primary', { type: 'button', html: icon('download', 16), onclick: () => { if (pick.getAttribute('aria-busy') !== 'true') input.click(); } }, ' Choose messages.json');
  const label = pick.innerHTML;
  // The import carries on after the dialog is closed (it takes minutes on a
  // large archive): its end is then a toast, and the workspace opens, as
  // before; a stop is a toast too, rather than a line on a status node
  // nobody sees any more, which is what it was. And the dialog opened again
  // meanwhile (from the workspace menu) shows the import still going, its
  // button busy, rather than offering to choose a file over it, which would
  // have made a second workspace beside the first. Stopped while no dialog
  // showed it, the next one opened says where it stopped; done, the next one
  // starts afresh. This dialog is the one showing the import, until it closes
  // or another opens.
  const shown = {
    say: (t) => { status.textContent = t; },
    stopped: () => {
      pick.removeAttribute('aria-busy');
      pick.innerHTML = label;
    },
    close: () => modal.close(),
  };
  state.shown = shown;
  // Busy, not disabled, while the archive is read and sent (as pressOnce
  // holds a button): disabled by hand, the button under the keyboard
  // dropped it on the page, and after a refusal (not an export, the server
  // not answering) came back live with nobody on it, so the next Tab
  // started over from the top. No form here for Enter to send twice.
  const running = () => {
    pick.setAttribute('aria-busy', 'true');
    pick.textContent = 'Importing';
    status.textContent = state.status;
  };
  if (state.running) running();
  else if (state.status) status.textContent = state.status;
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.value = '';
    if (!file || state.running) return;
    state.running = true;
    running();
    const report = (t) => { state.status = t; state.shown?.say(t); };
    try {
      report('Reading the archive');
      const archive = JSON.parse(await file.text());
      if (archive?.header?.format !== 'teamchat-export') throw new Error('That is not a Teamchat export');
      const target = await store.ensureOwnWorker(report);
      // What the server said of the archive's waiting messages when the copy
      // was made (see leftBehindText), for the closing words.
      let scheduled = null;
      const ref = await importArchive(target.url, archive, { profile: store.profileSeed(), onProgress: (p) => report(progressText(p)), onCreated: (made, info) => { scheduled = info?.scheduled || null; } });
      await store._addWorkspace({ ref, name: archive.header.workspace.name });
      state.running = false;
      state.status = '';
      state.shown?.close();
      const left = leftBehindText(scheduled);
      toast(`Imported ${archive.header.workspace.name}. Attachment bytes are not in messages.json; copy them from the export\u2019s files folder if you need them.${left ? ` ${left}` : ''}`, { duration: left ? 12000 : 8000 });
      navigate({ ws: ref });
    } catch (e) {
      state.running = false;
      report(`Stopped: ${e.message}`);
      state.shown?.stopped();
      if (!state.shown) toast(`Import stopped: ${e.message}`, { icon: 'alert', duration: 8000 });
    }
  });
  const modal = openModal({ title: 'Import a workspace', onClose: () => { if (state.shown === shown) state.shown = null; }, content: el('div', {},
    el('p', { style: { color: 'var(--ink-2)', fontSize: '14px' } }, 'Recreate a workspace from an export on your own server: channels, members, messages, threads, reactions, and pins, with their ids. You become its owner; members keep their roles and reach it without re-joining.'),
    status, input,
    el('div.modal-actions', {}, el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'), pick)) });
}

/** Admins: every guest, the channels they see, promote or remove in one click. */
export function guestsDialog() {
  const content = el('div');
  const list = el('div.pick-list', { role: 'list' });
  content.append(el('p.small.muted', { style: { marginBottom: '10px' } }, 'Guests joined through a channel invite. They see only the channels listed here and the people in them.'), list,
    el('div.modal-actions', {}, el('button.btn', { type: 'button', onclick: () => modal.close() }, 'Done')));
  // The list follows the workspace while the dialog stands: another admin
  // making a guest a full member or revoking one (the poll brings the role),
  // a guest let into another channel (its guest count moves) has the list
  // read again from the server, as the Members dialog redraws for a change
  // of members. Read once, at open, a row for someone made a member
  // meanwhile still offered "Make member", and one for someone revoked
  // answered "Member not found". Only the newest read's answer is kept.
  const guestKey = () => JSON.stringify([
    Object.entries(store.ws?.members || {}).filter(([, m]) => m.role === 'guest').map(([u]) => u).sort(),
    Object.entries(store.ws?.channels || {}).map(([id, c]) => [id, c.guests || 0]),
  ]);
  let guestSig = guestKey();
  let reads = 0;
  const off = store.on('workspace', () => {
    const next = guestKey();
    if (next === guestSig) return;
    guestSig = next;
    render();
  });
  const modal = openModal({ title: 'Guests', content, onClose: off });
  async function render() {
    const restore = focusMemo(list);
    await draw();
    restore();
  }
  async function draw() {
    // The rows as they stand stay on show, busy, while the list is read
    // again (the poll redraws it under a reader); the wait is said only
    // where there is nothing to keep.
    if (list.querySelector('.pick-item, .empty')) list.setAttribute('aria-busy', 'true');
    else list.replaceChildren(el('div.msg-loader', {}, 'Loading'));
    const mine = ++reads;
    try {
      const { guests } = await api.guests(store.wsId);
      if (mine !== reads) return;
      list.removeAttribute('aria-busy');
      list.replaceChildren(...guests.map((g) => {
        const m = store.member(g.uuid);
        // A private channel the admin is not in is kept from them (the
        // worker names it only by number, as it does a bot's), so the row
        // says how many rather than reading "no channels" for a guest who
        // is in some.
        const kept = Number(g.hidden) > 0 ? `${g.hidden} private channel${Number(g.hidden) === 1 ? '' : 's'} you are not in` : null;
        const channels = [...g.channels.map((c) => store.channel(c)?.name).filter(Boolean).map((n) => `#${n}`), kept].filter(Boolean).join(', ') || 'no channels';
        // One press at a time on each (see pressOnce): the press asks first
        // and then waits on the worker, and the row stayed live meanwhile, so
        // a second press put the same question up again and its answer went
        // to the worker a second time ("Member not found" after "Removed").
        const make = el('button.btn.btn-sm.btn-outline', { type: 'button' }, 'Make member');
        make.addEventListener('click', pressOnce(make, async () => {
          const sure = await confirmDialog({
            title: `Make ${m.name} a full member?`,
            message: 'They will see every public channel and everyone in the workspace. A member cannot be turned back into a guest.',
            confirmLabel: 'Make member', danger: false,
          });
          if (!sure) return;
          try {
            await api.setRole(store.wsId, g.uuid, 'member');
            await store.refreshAfterChange();
            toast(`${m.name} is now a full member`);
            render();
          } catch (err) {
            toast(err.message, { icon: 'alert' });
          }
        }));
        const revoke = el('button.btn.btn-sm.btn-ghost', { type: 'button', style: { color: 'var(--critical)' } }, 'Revoke');
        revoke.addEventListener('click', pressOnce(revoke, async () => {
          const ok = await confirmDialog({ title: `Revoke ${m.name}\u2019s access?`, message: 'They lose access to the workspace immediately.', confirmLabel: 'Revoke' });
          if (!ok) return;
          try {
            const res = await api.removeMember(store.wsId, g.uuid);
            store.carryRevocations(res?.revocations).catch(() => {});
            await store.refreshAfterChange();
            toast(`Removed ${m.name}`);
            render();
          } catch (err) {
            toast(err.message, { icon: 'alert' });
          }
        }));
        return el('div.pick-item', { role: 'listitem' },
          avatar(m, { size: 'sm', state: store.presenceOf(g.uuid) }),
          el('span.pick-text', {}, el('strong', { dir: 'auto' }, m.name), el('span', {}, channels)),
          make, revoke);
      }));
      if (!guests.length) list.append(el('div.empty', {}, el('p', {}, 'No guests. Invite one from a channel\u2019s details.')));
    } catch (e) {
      if (mine !== reads) return;
      list.removeAttribute('aria-busy');
      list.replaceChildren(el('div.empty', {}, el('p', {}, e.message)));
    }
  }
  render();
}

/* ---- personal settings --------------------------------------------------- */

/**
 * Profile, status, appearance, preferences and account in one dialog.
 * `section` names the part it was opened for ('status' from "Set a status"
 * and its shortcut, 'appearance' from the rail's theme item, 'quiet' from
 * the notification menu's Quiet hours): that part is brought into view and
 * its first control takes the keyboard, where the dialog's first field did.
 */
export function settingsDialog({ section = null } = {}) {
  const profile = store.profile;
  if (!profile) return;
  const content = el('div');

  /* Profile */
  const nameInput = el('input.input', { value: profile.name, maxlength: LIMITS.displayName, autocomplete: 'name' });
  const titleInput = el('input.input', { value: profile.title || '', maxlength: LIMITS.title, placeholder: 'e.g. Product designer' });
  let color = profile.color || 1;
  let preview = avatar({ ...profile }, { size: 'xl' });
  const colors = el('div.color-row', { role: 'radiogroup', 'aria-label': 'Avatar color' });
  const roveColors = radioNav(colors);
  const renderColors = () => {
    rerender(colors, ...Array.from({ length: 8 }, (_, i) => i + 1).map((c) => el('button.color-dot', {
      type: 'button', role: 'radio', 'aria-checked': String(c === color), 'aria-label': `Color ${c}`,
      style: { background: `var(--av-${c})`, color: `var(--av-${c}-ink)` },
      html: c === color ? icon('check', 16, 3) : '',
      onclick: () => {
        color = c;
        preview.dataset.color = String(c);
        renderColors();
      },
    })));
    roveColors();
  };
  renderColors();
  const nameField = field('Display name', nameInput);
  const save = el('button.btn.btn-primary', { type: 'submit' }, 'Save profile');
  // The same initials the avatar itself derives, so the preview is honest.
  // `store.profile` rather than the copy taken when the dialog opened: a
  // photo added or removed a moment ago decides whether initials show.
  nameInput.addEventListener('input', () => { if (!store.profile?.avatar) preview.firstChild.textContent = initials(nameInput.value.trim()); });

  /* Photo: cropped square and downscaled here, so the worker stores a small file. */
  const photoInput = el('input', { type: 'file', accept: 'image/*', hidden: true, 'aria-hidden': 'true', tabindex: -1 });
  const photoErr = el('p.field-error', { hidden: true, id: fieldId('photo-err'), role: 'alert' });
  const photoBtn = el('button.btn.btn-sm.btn-outline', { type: 'button', html: icon('image', 15), 'aria-describedby': photoErr.id, onclick: () => photoInput.click() }, profile.avatar ? ' Change photo' : ' Add a photo');
  const removeBtn = el('button.btn.btn-sm.btn-ghost', { type: 'button', hidden: !profile.avatar, onclick: async () => {
    // As the workspace icon's Remove: the button goes as its press lands, and
    // a keyboard on it moves to "Add a photo" beside it rather than falling
    // to the page body behind the dialog.
    const had = document.activeElement === removeBtn;
    const done = busy(removeBtn, 'Removing');
    try {
      await store.updateAvatar(null);
      const fresh = avatar({ ...store.profile, name: nameInput.value.trim() || store.profile.name, color }, { size: 'xl' });
      preview.replaceWith(fresh);
      preview = fresh;
      toast('Photo removed');
      removeBtn.hidden = true;
      photoBtn.lastChild.textContent = ' Add a photo';
      if (had) photoBtn.focus({ preventScroll: true });
    } catch (err) {
      toast(err.message, { icon: 'alert' });
    }
    done();
  } }, 'Remove');
  photoInput.addEventListener('change', async () => {
    const file = photoInput.files?.[0];
    photoInput.value = '';
    if (!file) return;
    photoErr.hidden = true;
    const done = busy(photoBtn, 'Uploading');
    try {
      const blob = await prepareAvatar(file);
      await store.updateAvatar(blob);
      const fresh = avatar({ ...store.profile, color }, { size: 'xl' });
      preview.replaceWith(fresh);
      preview = fresh;
      removeBtn.hidden = false;
      done();
      photoBtn.lastChild.textContent = ' Change photo';
      toast('Photo updated');
    } catch (err) {
      done();
      photoErr.textContent = err.message || 'Could not use that image';
      photoErr.hidden = false;
    }
  });
  content.append(el('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      const name = nameInput.value.trim();
      if (!name) return nameField.showError('Your name cannot be empty');
      const title = titleInput.value.trim();
      // Nothing changed against the profile as it stands (an earlier save in
      // this dialog may have moved it on from the copy taken at open): nothing
      // is sent, and the words say so rather than "Profile saved".
      const cur = store.profile || profile;
      if (name === cur.name && title === (cur.title || '') && color === (cur.color || 1)) return toast('No changes to save');
      const done = busy(save, 'Saving');
      try {
        await store.updateProfile({ name, title, color });
        toast('Profile saved');
        done();
      } catch (err) {
        done();
        nameField.showError(err.message);
      }
    },
  },
  el('div.profile-card', {}, preview, el('p.small.muted', {}, `@${profile.username}`),
    el('div.row', { style: { gap: '6px', marginTop: '6px' } }, photoBtn, removeBtn), photoErr, photoInput),
  nameField,
  field('Title (optional)', titleInput),
  el('div.field', {}, el('span.field-label', {}, 'Avatar color'), colors),
  el('div.row.row-end', {}, save)));

  /* Status: emoji, a few words, and how long it lasts. */
  const cur = store.statusOf(profile.uuid) || { emoji: '', text: '', until: null };
  let statusEmoji = cur.emoji || '';
  const emojiBtn = el('button.status-emoji-btn', { type: 'button', 'aria-label': statusEmoji ? `Status emoji ${statusEmoji}. Change` : 'Pick a status emoji', 'aria-haspopup': 'dialog' }, statusEmoji || el('span', { html: icon('smilePlus', 18) }));
  emojiBtn.addEventListener('click', (e) => openEmojiPicker(e.currentTarget, {
    label: 'Status emoji',
    onPick: (key, char) => {
      statusEmoji = char;
      emojiBtn.replaceChildren(char);
      emojiBtn.setAttribute('aria-label', `Status emoji ${char}. Change`);
    },
  }));
  const statusInput = el('input.input', { value: cur.text || '', maxlength: LIMITS.statusText, placeholder: 'What are you up to?' });
  // A status that already has an expiry keeps it unless the reader picks
  // another: the first option names the exact time, so fixing a typo in the
  // text never quietly moves when the status clears.
  const keepLabel = cur.until ? `Until ${untilText(cur.until)}` : null;
  const untilSelect = el('select.select', { 'aria-label': 'Clear status after' },
    ...[...(keepLabel ? [['keep', keepLabel]] : []), ['never', 'Don\u2019t clear'], ['1h', 'In 1 hour'], ['4h', 'In 4 hours'], ['today', 'Today'], ['week', 'This week']].map(([v, label]) => el('option', { value: v }, label)));
  if (cur.until) untilSelect.value = 'keep';
  const untilFor = (v) => {
    const now = Date.now();
    if (v === 'keep') return cur.until;
    if (v === '1h') return now + 3600_000;
    if (v === '4h') return now + 4 * 3600_000;
    if (v === 'today') { const d = new Date(now); d.setHours(24, 0, 0, 0); return d.getTime(); }
    if (v === 'week') return now + 7 * 86400_000;
    return null;
  };
  const presets = el('div.status-presets', {}, ...[['📅', 'In a meeting', '1h'], ['🎯', 'Focusing', '4h'], ['🍽️', 'Out for lunch', '1h'], ['🤒', 'Out sick', 'today'], ['🌴', 'On holiday', 'week']].map(([em, text, until]) => el('button.chip', {
    type: 'button',
    onclick: () => {
      statusEmoji = em;
      emojiBtn.replaceChildren(em);
      statusInput.value = text;
      untilSelect.value = until;
    },
  }, `${em} ${text}`)));
  const statusSave = el('button.btn.btn-primary.btn-sm', { type: 'button', onclick: async () => {
    const done = busy(statusSave, 'Saving');
    try {
      await store.updateStatus({ emoji: statusEmoji, text: statusInput.value.trim(), until: untilFor(untilSelect.value) });
      const set = !!(statusInput.value.trim() || statusEmoji);
      toast(set ? 'Status set' : 'Status cleared');
      statusClear.hidden = !set; // Clear is offered as soon as there is something to clear
    } catch (err) {
      toast(err.message, { icon: 'alert' });
    }
    done();
  } }, 'Set status');
  // The box is emptied once the status is cleared, not before: emptied as
  // the press landed, a clear the account would not take (offline) left an
  // empty box, and the emoji button reading as unset, beside the toast
  // saying the status stands, so keeping it meant typing it again. One press
  // at a time, busy rather than disabled (see pressOnce), and the button
  // going with the keyboard on it hands it to the box.
  const statusClear = el('button.btn.btn-ghost.btn-sm', { type: 'button', hidden: !cur.text && !cur.emoji }, 'Clear');
  statusClear.addEventListener('click', pressOnce(statusClear, async () => {
    try {
      await store.updateStatus(null);
    } catch (err) {
      toast(err.message, { icon: 'alert' });
      return;
    }
    statusEmoji = '';
    emojiBtn.replaceChildren(el('span', { html: icon('smilePlus', 18) }));
    emojiBtn.setAttribute('aria-label', 'Pick a status emoji');
    statusInput.value = '';
    // "Clear after" starts over with the status: the choice
    // kept was the cleared status's ("In 1 hour", or the very time it was to
    // clear at), and the next status typed into the empty box would have
    // taken it without a word.
    [...untilSelect.querySelectorAll('option')].find((o) => o.value === 'keep')?.remove();
    untilSelect.value = 'never';
    toast('Status cleared');
    const had = document.activeElement === statusClear;
    statusClear.hidden = true;
    if (had) statusInput.focus({ preventScroll: true });
  }));
  const statusHead = el('h3.field-label', { style: { margin: '22px 0 8px' } }, 'Status');
  content.append(statusHead,
    el('div.status-row', {}, emojiBtn, statusInput),
    presets,
    el('div.row', { style: { marginTop: '10px', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' } },
      el('div.row', {}, el('span.small.muted', {}, 'Clear'), untilSelect),
      el('div.row', {}, statusClear, statusSave)));

  /* Appearance */
  const themeSeg = el('div.seg', { role: 'radiogroup', 'aria-label': 'Theme' });
  const roveTheme = radioNav(themeSeg);
  const renderTheme = () => {
    const cur = currentTheme();
    rerender(themeSeg, ...[['system', 'monitor', 'System'], ['light', 'sun', 'Light'], ['dark', 'moon', 'Dark']].map(([mode, ic, label]) => el('button', {
      type: 'button', role: 'radio', 'aria-checked': String(cur === mode),
      html: icon(ic, 15, 2),
      onclick: () => {
        applyTheme(mode);
        renderTheme();
        store.updatePrefs({ theme: mode }).catch(() => {});
      },
    }, ` ${label}`)));
    roveTheme();
  };
  renderTheme();
  const themeHead = el('h3.field-label', { style: { margin: '22px 0 8px' } }, 'Appearance');
  content.append(themeHead, themeSeg);

  /* Preferences */
  content.append(el('h3.field-label', { style: { margin: '22px 0 4px' } }, 'Preferences'));
  content.append(switchRow({
    label: 'Enter sends the message', sub: 'Off: Enter adds a line, Ctrl or Cmd+Enter sends',
    checked: profile.prefs?.enterSends !== false,
    onChange: async (v) => {
      try {
        await store.updatePrefs({ enterSends: v });
      } catch (err) {
        toast(err.message || 'Could not save that setting', { icon: 'alert' });
        return false;
      }
    },
  }));
  content.append(switchRow({
    label: 'Confirm before @channel, @here, @everyone', sub: 'Shows how many people a broadcast will notify',
    checked: !profile.prefs?.skipBroadcastConfirm,
    onChange: async (v) => {
      try {
        await store.updatePrefs({ skipBroadcastConfirm: !v });
      } catch (err) {
        toast(err.message || 'Could not save that setting', { icon: 'alert' });
        return false;
      }
    },
  }));
  // Sounds and quiet hours stand outside the notificationsSupported() gate:
  // a browser without the Notification API (Safari on iPhone outside the
  // Home Screen app) still hears the chime, and quiet hours silence it.
  content.append(el('h3.field-label', { style: { margin: '22px 0 4px' } }, 'Notifications'));
  if (notificationsSupported()) {
    content.append(switchRow({
      label: 'Desktop notifications', sub: 'Mentions, direct messages, followed threads, and channels set to "All messages", while the tab is in the background',
      checked: !!profile.prefs?.notify && notificationsGranted(),
      onChange: async (v) => {
        if (v) {
          const ok = await requestNotificationPermission();
          if (!ok) {
            toast('Notifications are blocked in your browser settings', { icon: 'bellOff' });
            return false;
          }
        }
        try {
          await store.updatePrefs({ notify: v });
        } catch (err) {
          toast(err.message || 'Could not save that setting', { icon: 'alert' });
          return false;
        }
      },
    }));
    if (pushSupported() && import.meta.env?.PROD) {
      content.append(switchRow({
        label: 'Notifications when the app is closed', sub: isIos() && !isStandalone() ? 'On iPhone and iPad, add Teamchat to your Home Screen first' : 'Mentions and direct messages reach this device through your browser, following the settings above',
        // Shown on only while the browser still lets the app notify, as the
        // desktop switch above is: the preference stands after a permission
        // revoked in the browser's settings, and the switch read "on" for a
        // device that nothing could reach any more.
        checked: !!profile.prefs?.push && notificationsGranted(),
        onChange: async (v) => {
          try {
            await store.setPush(v);
            toast(v ? 'This device will be notified while the app is closed' : 'Push notifications turned off', { icon: v ? 'bell' : 'bellOff' });
          } catch (err) {
            toast(err.message || 'Could not set up push', { icon: 'alert', duration: 6000 });
            return false;
          }
        },
      }));
    }
    content.append(switchRow({
      label: 'Show the message in notifications', sub: 'Off: notifications say who wrote, not what',
      checked: profile.prefs?.notifyPreview !== false,
      onChange: async (v) => {
        try {
          await store.updatePrefs({ notifyPreview: v });
        } catch (err) {
          toast(err.message || 'Could not save that setting', { icon: 'alert' });
          return false;
        }
      },
    }));
  }
  content.append(switchRow({
    label: 'Notification sounds', sub: 'A soft chime for what would notify you, also when the tab is open on another conversation',
    checked: profile.prefs?.sound !== false,
    onChange: async (v) => {
      try {
        await store.updatePrefs({ sound: v });
        // Turning it on plays the chime once: what it sounds like, and the
        // click is the user gesture that unlocks audio for the page.
        if (v) playNotificationSound();
      } catch (err) {
        toast(err.message || 'Could not save that setting', { icon: 'alert' });
        return false;
      }
    },
  }));
  let quietSwitch = null;
  {
    // Quiet hours: a daily window during which nothing notifies. Counters
    // keep accruing; only the interruptions stop.
    const dnd = { enabled: false, from: '22:00', to: '08:00', ...(profile.prefs?.dnd || {}) };
    const fromInput = el('input.input.input-time', { type: 'time', value: dnd.from, 'aria-label': 'Quiet hours start', disabled: !dnd.enabled });
    const toInput = el('input.input.input-time', { type: 'time', value: dnd.to, 'aria-label': 'Quiet hours end', disabled: !dnd.enabled });
    const saveDnd = async () => {
      const next = { enabled: dnd.enabled, from: fromInput.value || dnd.from, to: toInput.value || dnd.to };
      try {
        await store.updatePrefs({ dnd: next });
        Object.assign(dnd, next);
        return true;
      } catch (e) {
        toast(e.message || 'Could not save', { icon: 'alert' });
        return false;
      }
    };
    fromInput.addEventListener('change', saveDnd);
    toInput.addEventListener('change', saveDnd);
    quietSwitch = switchRow({
      label: 'Quiet hours', sub: 'No notifications during this window, every day. Unread counts still add up.',
      checked: dnd.enabled,
      onChange: async (v) => {
        dnd.enabled = v;
        fromInput.disabled = !v;
        toInput.disabled = !v;
        if (await saveDnd()) return true;
        // Not saved: the switch goes back, and so does what it controls.
        dnd.enabled = !v;
        fromInput.disabled = v;
        toInput.disabled = v;
        return false;
      },
    });
    content.append(quietSwitch);
    content.append(el('div.row.dnd-row', {}, el('span.small.muted', {}, 'From'), fromInput, el('span.small.muted', {}, 'to'), toInput));
  }

  /* Install */
  if (!isStandalone() && (canInstall() || isIos())) {
    content.append(el('h3.field-label', { style: { margin: '22px 0 4px' } }, 'Install'));
    if (canInstall()) {
      content.append(el('button.details-row', { type: 'button', style: { paddingLeft: 0, paddingRight: 0 }, onclick: async () => { if (await promptInstall()) toast('Teamchat installed'); } },
        el('span', { html: icon('download', 18) }), el('span.details-text', {}, el('strong', {}, 'Install Teamchat'), el('span', {}, 'Opens in its own window, works offline for reading, and can notify you when closed, with your unread count on its icon'))));
    } else {
      content.append(el('p.small.muted', {}, 'To install on this device: tap Share, then “Add to Home Screen”. Installing is also what lets Teamchat notify you while it is closed on iPhone and iPad.'));
    }
  }

  /* Account */
  if (typeof puter !== 'undefined' && puter.env !== 'app') {
    content.append(el('div.modal-actions', { style: { justifyContent: 'space-between', marginTop: '24px' } },
      el('button.btn.btn-ghost', {
        type: 'button', html: icon('logout', 16),
        onclick: async () => {
          const ok = await confirmDialog({ title: 'Sign out?', message: 'You can sign back in with your Puter account anytime.', confirmLabel: 'Sign out', danger: false });
          if (!ok) return;
          try {
            await store.signOut();
          } finally {
            location.hash = '';
            location.reload();
          }
        },
      }, ' Sign out'),
      el('button.btn', { type: 'button', onclick: () => modal.close() }, 'Done')));
  } else {
    content.append(el('div.modal-actions', {}, el('button.btn', { type: 'button', onclick: () => modal.close() }, 'Done')));
  }
  content.append(el('p.small.muted', { style: { textAlign: 'center', marginTop: '14px' } }, 'Powered by ',
    el('a', { href: 'https://developer.puter.com', target: '_blank', rel: 'noopener' }, 'Puter')));
  const modal = openModal({ title: 'You', content });
  // Opened for one part of it (see section): that part comes into view, its
  // heading at the top of the dialog, and its first control takes the
  // keyboard from the dialog's first field (Add a photo), where the dialog
  // put it whatever it was opened for; "Set a status" then left the reader
  // on the photo button with the status box below the fold. On a phone the
  // dialog keeps the keyboard on its own panel, as it does for every field,
  // so the sheet that has only just slid in is not covered by the keyboard.
  const part = {
    status: [statusHead, statusInput],
    appearance: [themeHead, themeSeg.querySelector('[aria-checked="true"]') || themeSeg.querySelector('button')],
    quiet: [quietSwitch, quietSwitch],
  }[section];
  if (part) {
    const [head, control] = part;
    head?.scrollIntoView?.({ block: 'start' });
    if (control && matchMedia('(min-width: 640px)').matches) control.focus({ preventScroll: true });
  }
}
