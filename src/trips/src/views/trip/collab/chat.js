import { el } from '../../../ui/dom.js';
import { button, emptyState, skeleton } from '../../../ui/bits.js';
import { openMenu } from '../../../ui/menu.js';
import { confirmDialog } from '../../../ui/modal.js';
import { markdown } from '../../../ui/md.js';
import { toast } from '../../../ui/toast.js';
import { t } from '../../../lib/i18n/index.js';
import { LIMITS } from '../../../shared/limits.js';
import { errorText, icon, iconAction, keepFocus, plural, reconcile, revisionOf } from './common.js';
import { MAX_CHARS, PAGE, accessKey, authorOf, canEditMessage, chatTimeline, emojiOnly, filesByLink, linkToggle, onStateKey, reactionPatch, reactionsOf } from './model.js';
import { IMAGE_ACCEPT, cachedFileUrl, errorCode, errorKey, fileType, fileUrl, isRaster, startUpload } from '../../../lib/files/index.js';
import { openFilePicker, openPreview } from '../../../lib/files/ui.js';
import { QUICK_REACTIONS, openEmojiPicker } from './emoji.js';

const snippet = (text, max = 140) => {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const coarse = () => globalThis.matchMedia?.('(pointer: coarse)').matches ?? false;
const MAX_IMAGES = 4;
const IMAGE_BYTES = 10 * 1024 * 1024;
const INLINE_FULL_BYTES = 2 * 1024 * 1024;

/** Chat: newest page from the replica, older pages through `space.chatHistory`, reactions, replies, edit and delete. */
export function mountChat(container, ctx) {
  const { space, uid } = ctx;
  let limit = PAGE;
  let history = { cursor: undefined, done: false, loading: false };
  let oldest = null;
  let reply = null;
  let editing = null;
  let known = null;
  let newest = -Infinity;
  let stick = true;
  let membersVersion = 0;
  let reactbar = null;
  let scheduled = false;
  let destroyed = false;
  let staged = [];
  const uploads = new Map();
  const cache = new Map();
  const days = new Map();

  const announcer = el('div.sr-only', { role: 'status', 'aria-live': 'polite' });
  const olderButton = button(t('collab.chat.older'), { size: 'sm', variant: 'ghost', onclick: () => void loadOlder() });
  const olderError = el('span.field-error', { role: 'alert', hidden: true });
  const olderRow = el('div.chat-older', { hidden: true }, olderButton, olderError);
  const list = el('div.chat-list');
  const empty = el('div.chat-empty', { hidden: true });
  const log = el('div.chat-log', { role: 'log', 'aria-live': 'off', 'aria-label': t('collab.chat.log'), tabIndex: 0 }, olderRow, empty, list);
  const jump = button(t('collab.chat.jump'), { size: 'sm', variant: 'primary', hidden: true, onclick: () => scrollToEnd() });
  jump.prepend(icon('down', 16));
  jump.classList.add('chat-jump');

  const contextText = el('span.chat-context-text');
  const contextLine = el('div.chat-context', { hidden: true }, contextText,
    iconAction('close', t('collab.chat.cancelContext'), { onclick: () => { cancelContext(); textarea.focus(); } }));
  const textarea = el('textarea.textarea.chat-input', { rows: 1, maxLength: MAX_CHARS, 'aria-label': t('collab.chat.input'), placeholder: t('collab.chat.placeholder') });
  const counter = el('span.chat-counter', { 'aria-live': 'polite', hidden: true });
  const emojiButton = iconAction('emoji', t('collab.chat.insertEmoji'), { onclick: () => ctx.track(openEmojiPicker({ onPick: insertText })) });
  const attachButton = iconAction('attach', t('collab.chat.attach'), { onclick: () => pickImages() });
  const sendButton = el('button.icon-btn.chat-send', { type: 'submit', title: t('collab.chat.send'), 'aria-label': t('collab.chat.send') }, icon('send'));
  const stagedList = el('ul.chat-staged', { hidden: true, 'aria-label': t('collab.chat.staged') });
  const form = el('form.chat-composer', { onsubmit: (event) => { event.preventDefault(); void submit(); } },
    contextLine, stagedList, el('div.chat-row', {}, emojiButton, attachButton, textarea, sendButton), counter);
  const readOnly = el('p.chat-readonly', { hidden: true }, icon('lock', 16), el('span', {}, t('collab.chat.readOnly')));

  textarea.addEventListener('input', () => { autosize(); updateCounter(); });
  textarea.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !coarse()) { event.preventDefault(); void submit(); }
    else if (event.key === 'Escape' && (reply || editing)) { event.preventDefault(); event.stopPropagation(); cancelContext(); }
    else if (event.key === 'ArrowUp' && !textarea.value && !editing) {
      const last = [...space.select.msg.all()].reverse().find((msg) => canEditMessage(msg, { uid, now: ctx.now() }));
      if (last) { event.preventDefault(); startEdit(last); }
    }
  });
  log.addEventListener('scroll', () => { stick = nearBottom(); if (stick) jump.hidden = true; });

  container.replaceChildren(el('div.chat', {}, log, jump, form, readOnly, announcer));

  function nearBottom() { return log.scrollHeight - log.scrollTop - log.clientHeight < 80; }
  function scrollToEnd() { log.scrollTop = log.scrollHeight; stick = true; jump.hidden = true; }
  function autosize() { textarea.style.blockSize = 'auto'; textarea.style.blockSize = `${Math.min(textarea.scrollHeight + 2, 200)}px`; }
  function updateCounter() {
    const left = MAX_CHARS - textarea.value.length;
    counter.hidden = left > 400;
    counter.textContent = plural(left, 'collab.chat.charsLeftOne', 'collab.chat.charsLeft');
  }
  function insertText(value) {
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? start;
    if (textarea.value.length + value.length - (end - start) > MAX_CHARS) return;
    textarea.setRangeText(value, start, end, 'end');
    textarea.dispatchEvent(new Event('input'));
    textarea.focus();
  }

  // Staged images are trip files: picked from the Files tab, or uploaded from the picker, a paste or a drop. They are
  // linked to the message when it is sent.
  const isChatImage = (file) => file.kind === 'user' && !file.trashed && /^image\//.test(file.mime ?? '') && file.size <= IMAGE_BYTES;
  function renderStaged() {
    staged = staged.filter((id) => space.get('file', id));
    stagedList.hidden = !staged.length && !uploads.size;
    stagedList.replaceChildren(...staged.map((id) => {
      const file = space.get('file', id);
      return el('li', {}, el('span.chip.collab-chip.chat-staged-chip', {}, miniThumb(file), el('bdi', {}, file.name),
        iconAction('close', t('collab.attach.remove', { name: file.name }), { onclick: () => { staged = staged.filter((item) => item !== id); renderStaged(); textarea.focus(); } })));
    }), ...[...uploads.values()].map((state) => el('li', {}, el('span.chip.collab-chip.chat-staged-chip.is-uploading', { 'aria-busy': 'true' }, icon('attach', 14),
      el('bdi', {}, state.total && state.status === 'uploading'
        ? t('collab.chat.uploadingPercent', { name: state.name, percent: Math.round((state.loaded / state.total) * 100) })
        : t('collab.chat.uploadingName', { name: state.name }))))));
  }
  async function pickImages() {
    const chosen = await openFilePicker(space, { selected: staged, filter: isChatImage, accept: IMAGE_ACCEPT, max: Math.max(MAX_IMAGES - uploads.size, 0), title: t('collab.chat.attachTitle') });
    if (destroyed || !chosen) return;
    staged = chosen.filter((id) => isChatImage(space.get('file', id) ?? {})).slice(0, MAX_IMAGES);
    renderStaged();
    textarea.focus();
  }
  function uploadImages(files) {
    if (!space.can('files.upload') || !space.can('files.edit')) return;
    const images = files.filter((file) => fileType(file.name)?.group === 'image');
    if (!images.length) return;
    const room = Math.max(MAX_IMAGES - staged.length - uploads.size, 0);
    if (images.length > room) toast(t('collab.chat.tooManyImages', { count: MAX_IMAGES }));
    for (const file of images.slice(0, room)) {
      if (file.size > IMAGE_BYTES) { toast(t('collab.chat.imageTooLarge', { name: file.name })); continue; }
      const task = startUpload(space, file, { onChange: (state) => { if (uploads.has(task)) { uploads.set(task, state); renderStaged(); } } });
      uploads.set(task, task.state);
      renderStaged();
      task.run().then(({ id }) => {
        if (!destroyed && !staged.includes(id) && staged.length < MAX_IMAGES) staged.push(id);
      }, (error) => { if (!destroyed && errorCode(error) !== 'aborted') toast(`${file.name}: ${t(errorKey(error))}`); })
        .finally(() => { uploads.delete(task); if (!destroyed) renderStaged(); });
    }
  }
  function miniThumb(file) {
    const node = el('span.chat-mini-thumb', { 'aria-hidden': 'true' }, icon('attach', 14));
    if (file.thumb) fileUrl(space, file.id, { thumb: true }).then((url) => { if (url) node.replaceChildren(el('img', { src: url, alt: '' })); }, () => {});
    return node;
  }
  textarea.addEventListener('paste', (event) => {
    const files = [...(event.clipboardData?.files ?? [])];
    if (!files.length || attachButton.hidden) return;
    event.preventDefault();
    uploadImages(files);
  });
  form.addEventListener('dragover', (event) => { if (!attachButton.hidden && event.dataTransfer?.types?.includes('Files')) event.preventDefault(); });
  form.addEventListener('drop', (event) => {
    const files = [...(event.dataTransfer?.files ?? [])];
    if (!files.length || attachButton.hidden) return;
    event.preventDefault();
    uploadImages(files);
  });

  function updateContext() {
    const target = reply ? space.get('msg', reply) : editing ? space.get('msg', editing) : null;
    if (reply && target) contextText.textContent = t('collab.chat.replyingTo', { name: ctx.author(target).name, text: snippet(target.text, 80) });
    else if (editing && target) contextText.textContent = t('collab.chat.editing');
    else { reply = null; editing = null; }
    contextLine.hidden = !reply && !editing;
    form.classList.toggle('is-editing', Boolean(editing));
  }
  function cancelContext() {
    if (editing) textarea.value = '';
    reply = null; editing = null;
    updateContext(); autosize(); updateCounter(); schedule();
  }
  function startReply(msg) { editing = null; reply = msg.id; updateContext(); textarea.focus(); }
  function startEdit(msg) {
    reply = null; editing = msg.id; textarea.value = msg.text;
    updateContext(); autosize(); updateCounter(); schedule();
    textarea.focus(); textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }

  async function submit() {
    if (!ctx.canPost()) return;
    const text = textarea.value.trim();
    // Messages need text (msg schema), so images go with a caption.
    if (!text) { if (staged.length && !editing) toast(t('collab.chat.captionRequired')); return; }
    if (uploads.size && !editing) { toast(t('collab.chat.waitUploads')); return; }
    if (text.length > MAX_CHARS) { toast(t('collab.chat.tooLong')); return; }
    if (editing) {
      const msg = space.get('msg', editing);
      if (!msg) { cancelContext(); return; }
      if (!canEditMessage(msg, { uid, now: ctx.now() })) { toast(t('collab.chat.editExpired')); return; }
      if (text !== msg.text && !await ctx.apply([space.ops.patch('msg', msg.id, { set: { text } })], { flush: true })) return;
      textarea.value = ''; cancelContext();
      return;
    }
    const fields = { text, author: uid, ...(reply && space.get('msg', reply) ? { reply } : {}) };
    const create = space.ops.create('msg', fields);
    const links = staged.map((id) => space.get('file', id)).filter(Boolean)
      .map((file) => [file.id, linkToggle(file, 'msg', create.id, true)]).filter(([, patch]) => patch)
      .map(([id, patch]) => space.ops.patch('file', id, patch));
    if (!await ctx.apply([create, ...links], { flush: true })) return;
    textarea.value = ''; reply = null; stick = true; staged = [];
    renderStaged(); updateContext(); autosize(); updateCounter(); schedule();
  }

  async function toggleReaction(id, emoji) {
    const msg = space.get('msg', id);
    if (!msg || !ctx.canPost()) return;
    await ctx.apply([space.ops.patch('msg', id, reactionPatch(msg, emoji, uid))], { flush: true });
  }
  async function remove(msg) {
    const ok = await confirmDialog({ title: t('collab.chat.deleteTitle'), body: t('collab.chat.deleteBody'), confirmLabel: t('collab.chat.delete'), danger: true });
    if (!ok) return;
    if (editing === msg.id || reply === msg.id) cancelContext();
    await ctx.apply([space.ops.remove('msg', msg.id)], { flush: true });
  }
  async function copy(msg) {
    try { await globalThis.navigator.clipboard.writeText(msg.text); toast(t('collab.chat.copied')); }
    catch { toast(t('collab.chat.copyFailed')); }
  }
  function focusMessage(id) {
    const node = cache.get(id)?.node;
    if (!node?.isConnected) { toast(t('collab.chat.replyNotLoaded')); return; }
    node.scrollIntoView?.({ block: 'center' });
    node.focus({ preventScroll: true });
    node.classList.add('is-flash');
    setTimeout(() => node.classList.remove('is-flash'), 1600);
  }

  function closeReactbar(restore = false) {
    if (!reactbar) return;
    const { bar, anchor } = reactbar;
    reactbar = null;
    bar.remove();
    if (restore && anchor.isConnected) anchor.focus();
  }
  function openReactbar(msg, anchor) {
    closeReactbar();
    const pick = (emoji) => { closeReactbar(true); void toggleReaction(msg.id, emoji); };
    const buttons = [...QUICK_REACTIONS.map((emoji) => el('button.chat-reactbar-btn', { type: 'button', 'aria-label': emoji, 'aria-pressed': String(msg.react?.[emoji]?.[uid] === 1), onclick: () => pick(emoji) }, emoji)),
      el('button.chat-reactbar-btn', { type: 'button', title: t('collab.chat.moreEmoji'), 'aria-label': t('collab.chat.moreEmoji'), onclick: () => {
        closeReactbar(true);
        ctx.track(openEmojiPicker({ title: t('collab.chat.reactTitle'), onPick: (emoji) => void toggleReaction(msg.id, emoji) }));
      } }, icon('plus', 16))];
    buttons.forEach((node, index) => { node.tabIndex = index ? -1 : 0; });
    const bar = el('div.chat-reactbar', { role: 'toolbar', 'aria-label': t('collab.chat.reactWith') }, buttons);
    bar.addEventListener('keydown', (event) => {
      const index = buttons.indexOf(document.activeElement);
      const rtl = getComputedStyle(bar).direction === 'rtl';
      const step = { ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1 }[event.key];
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeReactbar(true); return; }
      if (!step && !['Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + step + buttons.length) % buttons.length;
      buttons.forEach((node, i) => { node.tabIndex = i === next ? 0 : -1; });
      buttons[next].focus();
    });
    bar.addEventListener('focusout', (event) => { if (!bar.contains(event.relatedTarget)) closeReactbar(); });
    anchor.closest('.chat-msg')?.append(bar);
    reactbar = { bar, anchor };
    buttons[0].focus();
  }

  function moreMenu(msg, anchor) {
    const can = ctx.canPost();
    const items = [
      can && { label: t('collab.chat.reply'), onSelect: () => startReply(msg) },
      can && { label: t('collab.chat.react'), onSelect: () => openReactbar(msg, anchor) },
      { label: t('collab.chat.copy'), onSelect: () => void copy(msg) },
      canEditMessage(msg, { uid, now: ctx.now() }) && can && { label: t('collab.chat.edit'), icon: 'pencil', onSelect: () => startEdit(msg) },
      ctx.canManage(msg) && { separator: true },
      ctx.canManage(msg) && { label: t('collab.chat.delete'), icon: 'trash', danger: true, onSelect: () => void remove(msg) },
    ].filter(Boolean);
    openMenu(anchor, items);
  }

  function quoteNode(id) {
    const target = space.get('msg', id);
    if (!target) return el('div.chat-quote.is-missing', {}, t('collab.chat.replyMissing'));
    const name = ctx.author(target).name;
    return el('button.chat-quote', { type: 'button', onclick: () => focusMessage(id), 'aria-label': t('collab.chat.replyTo', { name, text: snippet(target.text, 80) }) },
      el('strong', {}, name), el('span', {}, snippet(target.text)));
  }

  function reactionsNode(msg, can) {
    const reactions = reactionsOf(msg, uid);
    if (!reactions.length) return null;
    return el('div.chat-reactions', {}, reactions.map((reaction) => {
      const names = reaction.users.map((id) => ctx.person(id).name).join(', ');
      const label = t('collab.chat.reactionLabel', { emoji: reaction.emoji, count: reaction.count, names });
      const content = [el('span.chat-reaction-emoji', { 'aria-hidden': 'true' }, reaction.emoji), el('span.num', { 'aria-hidden': 'true' }, String(reaction.count))];
      return can
        ? el(`button.chat-reaction${reaction.mine ? '.is-mine' : ''}`, { type: 'button', 'aria-pressed': String(reaction.mine), 'aria-label': label, title: names, onclick: () => void toggleReaction(msg.id, reaction.emoji) }, content)
        : el('span.chat-reaction', { role: 'img', 'aria-label': label, title: names }, content);
    }));
  }

  // Images with a thumbnail (or small enough to load whole) show inline and open the preview; other files are chips.
  const inlineImage = (file) => isRaster(file.mime) && Boolean(file.thumb || file.size <= INLINE_FULL_BYTES);
  function imageButton(file, ids) {
    const img = el('img', { alt: '', decoding: 'async' });
    const thumb = Boolean(file.thumb);
    const known = cachedFileUrl(space, file.id, { thumb });
    if (known) img.src = known;
    else fileUrl(space, file.id, { thumb }).then((url) => { if (url) img.src = url; }, () => img.replaceWith(icon('attach', 20)));
    return el('button.chat-image', { type: 'button', 'aria-label': t('collab.chat.openImage', { name: file.name }), title: file.name, onclick: () => openPreview(space, file.id, { ids }) }, img);
  }
  function attachmentsNode(files) {
    if (!files?.length) return null;
    const hash = ctx.tabHash('files');
    const images = files.filter(inlineImage);
    const ids = images.map((file) => file.id);
    const others = files.filter((file) => !inlineImage(file));
    return el('div.chat-attachments', {},
      images.length ? el('ul.chat-images', { 'aria-label': t('collab.attachments') }, images.map((file) => el('li', {}, imageButton(file, ids)))) : null,
      others.length ? el('ul.chat-files', { 'aria-label': t('collab.attachments') }, others.map((file) => el('li', {},
        hash ? el('a.chip.collab-chip', { href: hash }, icon('attach', 14), el('bdi', {}, file.name)) : el('span.chip.collab-chip', {}, icon('attach', 14), el('bdi', {}, file.name))))) : null);
  }

  function buildMessage(msg, { grouped, overlay, can, files }) {
    const author = authorOf(msg);
    const person = ctx.person(author);
    const text = markdown(msg.text);
    text.classList.add('chat-text');
    if (emojiOnly(msg.text)) text.classList.add('chat-jumbo');
    const offline = space.state.sync === 'offline';
    const status = overlay.local ? el('span.chat-status', {}, t(offline ? 'collab.chat.queued' : 'collab.chat.sending')) : null;
    const reactButton = can && iconAction('react', t('collab.chat.react'), { onclick: (event) => openReactbar(msg, event.currentTarget) });
    const replyButton = can && iconAction('reply', t('collab.chat.reply'), { onclick: () => startReply(msg) });
    const more = iconAction('more', t('collab.chat.actions'), { onclick: (event) => moreMenu(msg, event.currentTarget) });
    return el(`article.chat-msg${grouped ? '.is-grouped' : ''}${author === uid ? '.is-mine' : ''}${overlay.local ? '.is-pending' : ''}${editing === msg.id ? '.is-editing' : ''}`, { dataset: { id: msg.id, key: msg.id }, tabIndex: -1 },
      el('div.chat-gutter', {}, grouped ? ctx.timeNode(msg.cr, ctx.time(msg.cr)) : ctx.avatarOf(author, 36)),
      el('div.chat-body', {},
        grouped ? el('span.sr-only', {}, person.name) : el('div.chat-head', {}, el('span.chat-name', {}, person.name), ctx.timeNode(msg.cr, ctx.dateTime(msg.cr))),
        msg.reply && quoteNode(msg.reply), text, ctx.previews?.node(msg, { onLoad: () => { if (stick) log.scrollTop = log.scrollHeight; } }),
        attachmentsNode(files), reactionsNode(msg, can), status),
      el('div.chat-actions', {}, reactButton, replyButton, more));
  }

  function render() {
    scheduled = false;
    if (destroyed) return;
    const all = space.select.msg.all();
    if (all.length && oldest !== null && all[0].cr > oldest) history = { cursor: undefined, done: false, loading: false };
    oldest = all[0]?.cr ?? null;
    const can = ctx.canPost();
    form.hidden = !can;
    readOnly.hidden = can;
    attachButton.hidden = !space.can('files.edit');
    if (attachButton.hidden && staged.length) { staged = []; renderStaged(); }
    const filesMap = filesByLink(space.select.file.all(), 'msg');
    const items = chatTimeline(all, { zone: ctx.zone, limit });
    const keep = new Set();
    const offline = space.state.sync === 'offline';
    const nodes = items.map((item) => {
      if (item.kind === 'day') {
        if (!days.has(item.date)) days.set(item.date, el('div.chat-day', { role: 'separator' }, el('span', {}, ctx.day(item.date))));
        return days.get(item.date);
      }
      const { msg, grouped } = item;
      keep.add(msg.id);
      const overlay = space.overlay('msg', msg.id);
      const files = filesMap.get(msg.id);
      const sig = [revisionOf(msg), grouped, overlay.local, overlay.local && offline, can, editing === msg.id, membersVersion,
        msg.reply ? revisionOf(space.get('msg', msg.reply)) : '', files?.map(revisionOf).join(',') ?? ''].join('|');
      const cached = cache.get(msg.id);
      if (cached?.sig === sig) return cached.node;
      const node = buildMessage(msg, { grouped, overlay, can, files });
      cache.set(msg.id, { sig, node });
      return node;
    });
    for (const id of cache.keys()) if (!keep.has(id)) cache.delete(id);
    const fromBottom = log.scrollHeight - log.scrollTop;
    const atEnd = stick || nearBottom();
    keepFocus(list, () => reconcile(list, nodes));

    const loading = !all.length && space.state.rev === 0 && ['idle', 'syncing'].includes(space.state.sync);
    empty.hidden = all.length > 0;
    if (!all.length) empty.replaceChildren(loading ? el('div.chat-skeleton', { 'aria-hidden': 'true' }, skeleton('60%'), skeleton('40%'), skeleton('70%'))
      : emptyState({ title: t('collab.chat.emptyTitle'), body: t(can ? 'collab.chat.emptyBody' : 'collab.chat.emptyReadOnly'), icon: 'users' }));
    olderRow.hidden = all.length <= limit && (history.done || all.length < LIMITS.chatPage);
    olderButton.setAttribute('aria-busy', String(history.loading));

    const ids = new Set(all.map((msg) => msg.id));
    if (known) {
      // Older pages also add unknown messages; only newer arrivals are announced.
      const fresh = all.filter((msg) => !known.has(msg.id) && msg.cr > newest && authorOf(msg) !== uid);
      // A first load into an empty replica is not news.
      if (fresh.length && (known.size > 0 || fresh.length === 1)) {
        const last = fresh.at(-1);
        announcer.textContent = t('collab.chat.announce', { name: ctx.author(last).name, text: snippet(last.text, 120) });
        if (!atEnd) jump.hidden = false;
      }
    }
    known = ids;
    newest = Math.max(newest, all.at(-1)?.cr ?? -Infinity);
    if (history.keep) { log.scrollTop = log.scrollHeight - fromBottom; history.keep = false; }
    else if (atEnd) scrollToEnd();
  }

  function schedule() {
    if (scheduled || destroyed) return;
    scheduled = true;
    queueMicrotask(render);
  }

  async function loadOlder() {
    if (history.loading) return;
    const all = space.select.msg.all();
    olderError.hidden = true;
    stick = false;
    if (all.length > limit) { limit += PAGE; history.keep = true; render(); return; }
    if (history.done) return;
    history.loading = true;
    olderButton.setAttribute('aria-busy', 'true');
    const before = all[0]?.cr ?? Infinity;
    try {
      // The first page is the newest one; later pages follow the returned cursor.
      for (let round = 0; round < 4 && !history.done; round++) {
        const page = await space.chatHistory({ cursor: history.cursor });
        if (destroyed) return;
        history.cursor = page.cursor ?? undefined;
        if (!page.cursor || !page.messages.length) history.done = true;
        if (page.messages.some((msg) => (msg.cr ?? Infinity) < before)) break;
      }
      limit += PAGE;
      history.keep = true;
    } catch (error) {
      olderError.textContent = errorText(error);
      olderError.hidden = false;
    } finally {
      history.loading = false;
      if (!destroyed) render();
    }
  }

  const offs = [
    space.subscribe('msg', schedule),
    space.subscribe('file', schedule),
    space.subscribe('member', () => { membersVersion += 1; schedule(); }),
    onStateKey(space, (s) => `${s.state.sync === 'offline'}|${s.state.rev === 0 ? s.state.sync : ''}|${accessKey(s)}`, schedule),
  ];
  render();
  updateCounter();
  const dispose = () => {
    destroyed = true;
    for (const task of uploads.keys()) task.cancel();
    closeReactbar();
    for (const off of offs) off();
    cache.clear();
    days.clear();
  };
  // Hidden panels lose their scroll position; the tab calls this when Chat is shown again.
  dispose.show = () => { if (stick) scrollToEnd(); };
  return dispose;
}
