// Sharing a cloud project with other Puter users. Sharing is per file: the
// other person opens it from "Shared with me", and with edit access their
// saves go back to the same file.

import { h, clear, isComposing } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { openDialog } from '../ui/dialog.js';
import { puter, cloudAvailable } from './puter.js';

const MODES = [['read', 'Can view'], ['write', 'Can edit']];

export async function shareDialog(app) {
  const loc = app.location;
  if (!cloudAvailable() || loc?.type !== 'cloud') {
    app.toast('Save the project to your Puter cloud first, then share it.', { kind: 'info', title: 'Share' });
    return;
  }
  if (app.project.dirty) await app.save({ quiet: true });
  const fs = puter().fs;
  const who = h('input', { type: 'text', placeholder: 'Puter username or email', 'aria-label': 'Person to share with', autocomplete: 'off', spellcheck: 'false' });
  const mode = h('select', { 'aria-label': 'Access' }, MODES.map(([v, l]) => h('option', { value: v }, l)));
  const status = h('div.small', { role: 'status', style: { minHeight: '18px', marginTop: '6px' } });
  const list = h('div');

  let listing = 0;
  const render = async () => {
    // Lists can overlap (sharing while the first is on its way): only the
    // last one asked for is shown, or the people would be listed twice.
    const mine = ++listing;
    let shares = [];
    try { shares = await fs.getShares(loc.path); } catch { shares = []; }
    if (mine !== listing) return;
    clear(list);
    if (!shares?.length) { list.append(h('p.muted', 'Not shared with anyone yet.')); return; }
    const rows = shares.map((s) => {
      const holder = typeof s.holder === 'string' ? s.holder : s.holder?.username || s.holder?.email || '';
      const sel = h('select', { 'aria-label': `Access for ${holder}` }, MODES.concat([['manage', 'Can edit and share']]).map(([v, l]) => h('option', { value: v, selected: v === s.mode }, l)));
      sel.addEventListener('change', async () => {
        try { await fs.share(loc.path, recipient(holder), sel.value); status.textContent = `Updated access for ${holder}.`; } catch (err) { status.textContent = err.message; }
      });
      const remove = h('button.btn.sm', { type: 'button', onClick: async () => {
        try { await fs.unshare(loc.path, recipient(holder)); status.textContent = `${holder} no longer has access.`; render(); } catch (err) { status.textContent = err.message; }
      } }, 'Remove');
      return h('tr', h('td', holder), h('td', sel), h('td', { style: { textAlign: 'right' } }, remove));
    });
    list.append(h('div.table-wrap', h('table.grid', h('thead', h('tr', h('th', 'Person'), h('th', 'Access'), h('th', h('span.sr-only', 'Actions')))), h('tbody', rows))));
  };

  const add = async () => {
    const v = who.value.trim();
    if (!v) { who.focus(); return false; }
    status.textContent = 'Sharing...';
    try {
      const [share] = await fs.share(loc.path, recipient(v), mode.value);
      status.textContent = share?.isNew === false ? `Updated access for ${v}.` : `Shared with ${v}. They can open it from Open project, Shared with me.`;
      who.value = '';
      render();
    } catch (err) {
      status.textContent = `Could not share: ${err?.message || err}`;
    }
    return false;
  };
  who.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !isComposing(e)) { e.preventDefault(); add(); } });

  render();
  await openDialog({
    title: `Share ${app.project.name}`, size: 'wide',
    body: [
      h('p', 'People you share with open the project in their own Circuits. With edit access, their saves update this file. Everyone should save often, because two people editing at the same time overwrite each other.'),
      h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } }, h('div', { style: { flex: '1 1 220px' } }, who), mode,
        h('button.btn.primary', { type: 'button', onClick: add }, icon('share', 14), 'Share')),
      status,
      h('h3', { style: { fontSize: 'var(--fs-md)', margin: '14px 0 6px' } }, 'People with access'),
      list,
    ],
    actions: [{ label: 'Done', primary: true }],
  }).result;
}

function recipient(v) {
  return v.includes('@') ? { email: v } : { username: v };
}

/** Projects other people shared with the current user. */
export async function sharedWithMe() {
  if (!cloudAvailable() || !puter()?.fs?.listShared) return [];
  try {
    const { items } = await puter().fs.listShared();
    return (items || []).filter((i) => !i.is_dir && !i.isDir && /\.circuits$/i.test(i.name)).map((i) => ({
      name: i.name.replace(/\.circuits$/i, ''),
      location: { type: 'cloud', path: i.path },
      owner: typeof i.owner === 'string' ? i.owner : i.owner?.username || '',
      mode: i.mode,
      modified: i.modified ? (i.modified < 1e12 ? i.modified * 1000 : i.modified) : 0,
    }));
  } catch { return []; }
}
