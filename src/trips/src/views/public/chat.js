import { el } from '../../ui/dom.js';
import { avatar } from '../../ui/avatar.js';
import { markdown } from '../../ui/md.js';
import { t } from '../../lib/i18n/index.js';
import { attachments } from './files.js';

const when = (epoch) => {
  try { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(epoch)); } catch { return ''; }
};

/** The latest messages the snapshot holds, oldest first. Reactions are not part of the public view. */
export function renderChat(ctx) {
  const messages = [...ctx.space.select.msg.all()].sort((a, b) => (a.cr ?? 0) - (b.cr ?? 0));
  if (!messages.length) return el('p.public-empty', {}, t('public.chatEmpty'));
  return el('div.public-chat', {}, el('p.public-hint', {}, t('public.chatHint')),
    el('ol.public-messages', {}, messages.map((msg) => {
      const name = msg.author ? ctx.people(msg.author) : t('public.someone');
      return el('li.public-message', {}, avatar({ id: msg.author ?? '', name, size: 28 }),
        el('div.public-message-body', {},
          el('p.public-message-head', {}, el('strong', {}, name),
            Number.isSafeInteger(msg.cr) && el('time.public-sub', { dateTime: new Date(msg.cr).toISOString() }, when(msg.cr))),
          markdown(msg.text), attachments(ctx.files, ctx.filesFor(`msg:${msg.id}`))));
    })));
}
