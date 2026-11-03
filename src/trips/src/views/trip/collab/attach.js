import { el } from '../../../ui/dom.js';
import { t } from '../../../lib/i18n/index.js';
import { openFilePicker } from '../../../lib/files/ui.js';
import { icon, iconAction } from './common.js';
import { linkToggle } from './model.js';

/** Attaches trip files to `{type, id}`: choose existing ones or upload new ones (needs `files.edit`). */
export function openAttachPicker(ctx, { type, id }) {
  return openFilePicker(ctx.space, { link: { t: type, id } });
}

/** Attached files as links to the Files tab, with a detach button for members who can edit files. */
export function attachmentList(ctx, { type, id, files }) {
  const { space } = ctx;
  if (!files.length) return null;
  const hash = ctx.tabHash('files');
  const canEdit = space.can('files.edit');
  return el('ul.collab-files', { 'aria-label': t('collab.attachments') }, files.map((file) => el('li.collab-file', {},
    icon('attach', 16),
    hash ? el('a', { href: hash }, el('bdi', {}, file.name)) : el('bdi', {}, file.name),
    canEdit && iconAction('close', t('collab.attach.remove', { name: file.name }), { onclick: () => {
      const current = space.get('file', file.id);
      const patch = current && linkToggle(current, type, id, false);
      if (patch) void ctx.apply([space.ops.patch('file', file.id, patch)], { flush: true });
    } }))));
}
