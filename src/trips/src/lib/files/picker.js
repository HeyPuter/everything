import './files.css';
import { el, uid } from '../../ui/dom.js';
import { button } from '../../ui/bits.js';
import { openModal } from '../../ui/modal.js';
import { toast } from '../../ui/toast.js';
import { t } from '../i18n/index.js';
import { errorKey } from './errors.js';
import { fileIcon, icon, iconAction } from './icons.js';
import { ACCEPT, canUseDrive, chooseLocalFiles, fileLinkOp, filesFor, fileUrl, pickFromDrive, startUpload, unlinkFile, userFiles } from './index.js';
import { formatBytes } from './format.js';
import { download, openPreview } from './preview.js';

function thumbFor(space, file, size = 20) {
  const node = el('span.file-mini-thumb', { 'aria-hidden': 'true' }, fileIcon(file.mime, size));
  if (file.thumb) fileUrl(space, file.id, { thumb: true }).then((url) => { if (url) node.replaceChildren(el('img', { src: url, alt: '' })); }, () => {});
  return node;
}

/**
 * Lets a member choose trip files, upload new ones from the device or the Puter drive, and (with `link`) attach the
 * chosen files to that entity. Without `link`, `selected` ids start chosen and the caller links them itself. Resolves
 * to the chosen file ids, or null when cancelled.
 */
export function openFilePicker(space, { link, selected = [], filter = () => true, accept = ACCEPT, max = Infinity, title = t('files.picker.title'), multiple = true } = {}) {
  return new Promise((resolve) => {
    const linked = new Set(link ? filesFor(space, link).map((file) => file.id) : []);
    const chosen = new Set(link ? linked : selected);
    const canUpload = space.can('files.upload');
    const searchId = uid('file-search');
    const search = el('input.input', { id: searchId, type: 'search', autocomplete: 'off', oninput: () => render() });
    const list = el('div.file-pick-list', { role: multiple ? 'group' : 'radiogroup', 'aria-label': t('files.picker.list') });
    const status = el('p.file-pick-status', { role: 'status' });
    let settled = false;

    function render() {
      const needle = search.value.trim().toLocaleLowerCase();
      const files = [...userFiles(space)].sort((a, b) => (b.cr ?? 0) - (a.cr ?? 0)).filter((file) => filter(file) && (!needle || file.name.toLocaleLowerCase().includes(needle)));
      if (!files.length) { list.replaceChildren(el('p.field-hint', {}, t(needle ? 'files.empty.search' : 'files.picker.none'))); return; }
      const full = multiple && chosen.size >= max;
      list.replaceChildren(...files.map((file) => el('button.pick-item.file-pick-item', {
        type: 'button', role: multiple ? 'checkbox' : 'radio', 'aria-checked': String(chosen.has(file.id)), disabled: full && !chosen.has(file.id),
        onclick: () => {
          if (!multiple) chosen.clear();
          if (chosen.has(file.id)) chosen.delete(file.id); else chosen.add(file.id);
          render();
          list.querySelector(`[data-id="${file.id}"]`)?.focus();
        },
        dataset: { id: file.id },
      }, thumbFor(space, file), el('span.file-pick-name', {}, file.name), el('span.file-pick-size', {}, formatBytes(file.size)))));
    }

    async function add(files) {
      for (const file of files) {
        const upload = startUpload(space, file, { link, onChange: (state) => {
          status.textContent = state.status === 'uploading' && state.total
            ? t('files.upload.progress', { name: state.name, percent: Math.round((state.loaded / state.total) * 100) })
            : t(`files.status.${state.status}`, { name: state.name });
        } });
        try {
          const { id, entity } = await upload.run();
          if (!multiple) chosen.clear();
          if (chosen.size < max && filter(entity ?? space.get('file', id) ?? {})) chosen.add(id);
          if (link) linked.add(id);
          status.textContent = t('files.upload.done', { name: upload.state.name });
        } catch (error) { status.textContent = `${upload.state.name}: ${t(errorKey(error))}`; }
        render();
      }
    }

    const finish = async () => {
      if (link) {
        const ops = [...[...chosen].filter((id) => !linked.has(id)).map((id) => fileLinkOp(space, id, { add: [link] })),
          ...[...linked].filter((id) => !chosen.has(id)).map((id) => fileLinkOp(space, id, { remove: [link] }))].filter(Boolean);
        try { if (ops.length) await space.apply(ops); } catch (error) { toast(t(errorKey(error))); return; }
      }
      settled = true;
      resolve([...chosen]);
      modal.close('done');
    };
    const uploads = canUpload && el('div.file-pick-sources', {},
      button(t('files.action.uploadDevice'), { size: 'sm', onclick: async () => add(await chooseLocalFiles({ accept, multiple })) }),
      canUseDrive() && button(t('files.action.fromDrive'), { size: 'sm', onclick: () => { pickFromDrive({ multiple }).then(add, (error) => toast(t(errorKey(error)))); } }));
    const content = el('div.file-picker', {},
      el('div.field', {}, el('label.field-label', { htmlFor: searchId }, t('files.search')), search),
      list, status, uploads);
    const modal = openModal({
      title, content, wide: true,
      actions: [button(t('ui.cancel'), { onclick: () => modal.close('cancel') }), button(t('files.picker.done'), { variant: 'primary', onclick: finish })],
      onClose: () => { if (!settled) resolve(null); },
    });
    const off = space.subscribe('file', () => render());
    void modal.closed.then(off);
    render();
  });
}

/**
 * Files attached to one entity, with preview, download, detach and an "Attach files" button. For booking, expense,
 * place and note forms. Returns `{element, destroy}`.
 */
export function attachmentList(space, target, { label = t('files.attachments'), onOpen } = {}) {
  const list = el('ul.file-attachments-list', { role: 'list' });
  const heading = el('h3.file-attachments-title', {}, icon('attach', 16), el('span', {}, label));
  const attach = button(t('files.action.attach'), { size: 'sm', onclick: () => { void openFilePicker(space, { link: target }); } });
  const element = el('section.file-attachments', {}, el('div.file-attachments-head', {}, heading, attach), list);
  function render() {
    attach.hidden = !space.can('files.edit');
    const files = filesFor(space, target);
    if (!files.length) { list.replaceChildren(el('li.file-attachments-empty', {}, t('files.attachmentsNone'))); return; }
    list.replaceChildren(...files.map((file) => el('li.file-attachment', {},
      el('button.file-attachment-open', { type: 'button', onclick: () => (onOpen ?? ((id) => openPreview(space, id, { ids: files.map((item) => item.id) })))(file.id) },
        thumbFor(space, file), el('span.file-attachment-name', {}, file.name)),
      iconAction('download', t('files.action.downloadName', { name: file.name }), { small: true, onclick: () => download(space, file.id) }),
      space.can('files.edit') && iconAction('close', t('files.action.detachName', { name: file.name }), { small: true, onclick: () => unlinkFile(space, file.id, target).catch((error) => toast(t(errorKey(error)))) }))));
  }
  const off = space.subscribe('file', render);
  render();
  return { element, destroy: off };
}
