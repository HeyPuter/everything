// Sharing a cloud part with other Puter users. Sharing is per file: the other
// person opens it from "Shared with me" in the Open dialog; with edit access
// their saves update the same file.

import { EXT, type FileEntry } from '../platform/files';
import { cloudAvailable, puter, signIn, storageError, toMs } from '../platform/puter';
import { h, clear } from '../ui/dom';
import { icon } from '../ui/icons';
import { showDialog, toast } from '../ui/overlay';
import type { App } from './app';
import type { FileOps } from './fileops';

const MODES: [string, string][] = [['read', 'Can view'], ['write', 'Can edit']];

interface ShareRecord {
  holder?: string | { username?: string; email?: string } | null;
  recipientEmail?: string;
  mode: string;
  pending?: boolean;
  inheritedFrom?: string | null;
}

type ShareFS = {
  share(path: string, recipient: unknown, mode: string): Promise<{ isNew?: boolean }[]>;
  unshare(path: string, recipient: unknown): Promise<{ revoked: number }>;
  getShares(path: string): Promise<ShareRecord[]>;
  listShared(opts?: { cursor?: string | null; limit?: number }): Promise<{ items: SharedItem[]; cursor?: string | null }>;
};

interface SharedItem {
  name: string;
  path: string;
  is_dir?: boolean;
  isDir?: boolean;
  modified?: number;
  mode?: string;
  owner?: string | { username?: string };
}

const fsx = () => puter()?.fs as unknown as ShareFS | undefined;
const recipient = (v: string) => (v.includes('@') ? { email: v } : { username: v });
const holderName = (s: ShareRecord) => (typeof s.holder === 'string' ? s.holder : s.holder?.username || s.holder?.email || s.recipientEmail || '');

export async function shareDialog(app: App, files: FileOps) {
  const signal = app.documentSignal;
  const name = app.store.doc.name;
  const originalLocation = app.location;
  const fs = fsx();
  if (!fs?.share) {
    toast({ kind: 'warning', message: 'Sharing needs Puter, which could not be loaded. Check your connection and reload.' });
    return;
  }
  if (!cloudAvailable()) {
    toast({
      title: 'Share',
      message: 'Sign in to Puter to save this part to your cloud and share it with others.',
      actions: [{ label: 'Sign in', primary: true, run: () => void signIn().then(() => { if (!signal.aborted) return shareDialog(app, files); }).catch((e) => toast({ kind: 'error', message: (e as Error).message })) }],
      timeout: 9000,
    });
    return;
  }
  if (app.location?.type !== 'cloud' || app.store.dirty) {
    const ok = await files.save();
    if (signal.aborted || app.store.doc.name !== name) return;
    if (originalLocation?.type === 'cloud' && (app.location?.type !== 'cloud' || app.location.path !== originalLocation.path)) return;
    if (!ok || app.location?.type !== 'cloud') {
      toast({ title: 'Share', message: 'Save the part to your Puter cloud first, then share it.' });
      return;
    }
  }
  const path = (app.location as { path: string }).path;
  let open = true;
  const isCurrent = () => open && !signal.aborted && app.store.doc.name === name && app.location?.type === 'cloud' && app.location.path === path;
  const who = h('input', { class: 'input', placeholder: 'Puter username or email', 'aria-label': 'Person to share with', autocomplete: 'off', spellcheck: 'false' }) as HTMLInputElement;
  const mode = h('select', { class: 'input', 'aria-label': 'Access', style: { width: 'auto' } }, MODES.map(([v, l]) => h('option', { value: v }, l))) as HTMLSelectElement;
  const status = h('div', { class: 'field-label', role: 'status', style: { minHeight: '18px' } });
  const list = h('div');

  type AccessRow = { element: HTMLElement; pending: boolean; settled: number; removed: boolean };
  const accessRows = new Map<string, AccessRow>();
  let mutationRevision = 0;
  let renderSequence = 0;
  const render = async () => {
    if (!isCurrent()) return;
    const sequence = ++renderSequence;
    const revision = mutationRevision;
    clear(list);
    let shares: ShareRecord[] = [];
    try {
      shares = (await fs.getShares(path)) ?? [];
    } catch (e) {
      if (!isCurrent() || sequence !== renderSequence) return;
      list.append(h('p', { role: 'alert' }, `Could not load who has access: ${storageError(e)}`));
      return;
    }
    if (!isCurrent() || sequence !== renderSequence) return;
    const direct = shares.filter((s) => !s.inheritedFrom);
    const seen = new Set<string>();
    const rows = direct.map((s) => {
      const name = holderName(s);
      seen.add(name);
      const previous = accessRows.get(name);
      // Refreshes started before a row's operation settled cannot replace
      // its pending controls or its newly confirmed result.
      if (previous && !previous.removed && (previous.pending || previous.settled > revision)) return previous.element;
      const state: AccessRow = { element: h('tr'), pending: false, settled: 0, removed: false };
      const sel = h('select', { class: 'input', 'aria-label': `Access for ${name}`, style: { width: 'auto' } }, [...MODES, ['manage', 'Can edit and share'] as [string, string]].map(([v, l]) => {
        const o = h('option', { value: v }, l) as HTMLOptionElement;
        if (v === s.mode) o.selected = true;
        return o;
      })) as HTMLSelectElement;
      sel.addEventListener('change', async () => {
        if (state.pending || !isCurrent()) return;
        const next = sel.value;
        state.pending = true;
        sel.disabled = remove.disabled = true;
        status.textContent = `Updating access for ${name}...`;
        try {
          await fs.share(path, recipient(name), next);
          s.mode = next;
          status.textContent = `Updated access for ${name}.`;
        } catch (e) {
          sel.value = s.mode;
          status.textContent = `Could not update access for ${name}: ${storageError(e)}`;
        } finally {
          state.pending = false;
          state.settled = ++mutationRevision;
          sel.disabled = remove.disabled = false;
        }
      });
      // An icon button keeps the table within the dialog at phone widths.
      const remove = h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Remove ${name}`, title: 'Remove access' }, icon('trash', 16));
      remove.addEventListener('click', async () => {
        if (state.pending || !isCurrent()) return;
        state.pending = true;
        sel.disabled = remove.disabled = true;
        status.textContent = `Removing access for ${name}...`;
        try {
          await fs.unshare(path, recipient(name));
          state.removed = true;
          status.textContent = `${name} no longer has access.`;
          await render();
        } catch (e) {
          status.textContent = `Could not remove access for ${name}: ${storageError(e)}`;
        } finally {
          state.pending = false;
          state.settled = ++mutationRevision;
          sel.disabled = remove.disabled = false;
        }
      });
      state.element.append(h('td', {}, name, s.pending ? h('span', { class: 'field-label' }, ' (invited)') : null), h('td', {}, sel), h('td', { style: { textAlign: 'right' } }, remove));
      accessRows.set(name, state);
      return state.element;
    });
    for (const [name, state] of accessRows) {
      if (seen.has(name)) continue;
      if (!state.removed && (state.pending || state.settled > revision)) rows.push(state.element);
      else accessRows.delete(name);
    }
    if (!rows.length) { list.append(h('p', {}, 'Not shared with anyone yet.')); return; }
    list.append(h('table', { class: 'table' }, h('thead', {}, h('tr', {}, h('th', {}, 'Person'), h('th', {}, 'Access'), h('th', {}, h('span', { class: 'sr-only' }, 'Actions')))), h('tbody', {}, rows)));
  };

  let adding = false;
  let recipientRevision = 0;
  who.addEventListener('input', () => { recipientRevision++; });
  const add = async () => {
    if (adding || !isCurrent()) return;
    const v = who.value.trim();
    if (!v) { who.focus(); return; }
    const revision = recipientRevision;
    adding = true;
    addBtn.disabled = true;
    status.textContent = 'Sharing...';
    try {
      const res = await fs.share(path, recipient(v), mode.value);
      if (!isCurrent()) return;
      status.textContent = res?.[0]?.isNew === false ? `Updated access for ${v}.` : `Shared with ${v}. They can open it from Open, Shared with me.`;
      if (revision === recipientRevision) who.value = '';
      void render();
    } catch (e) {
      const code = (e as { code?: string })?.code;
      status.textContent = code === 'user_does_not_exist' ? `There is no Puter user called ${v}.` : code === 'cannot_share_with_self' ? 'You already own this part.' : `Could not share: ${storageError(e)}`;
    } finally {
      adding = false;
      addBtn.disabled = false;
    }
  };
  who.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); e.stopPropagation(); void add(); } });
  const addBtn = h('button', { class: 'btn primary', type: 'button' }, icon('share', 14), 'Share');
  addBtn.addEventListener('click', () => void add());
  void render();
  let stopWatching = () => {};
  await showDialog({
    title: `Share ${name}`, signal,
    onReady: (close) => { stopWatching = app.store.on(() => { if (!isCurrent()) close(null); }); },
    wide: true,
    body: [
      h('p', {}, 'People you share with open the part in their own Parametric. With edit access, their saves update this file, so agree on who is editing: two people saving at the same time overwrite each other.'),
      h('div', { class: 'row', style: { flexWrap: 'wrap' } }, h('div', { class: 'grow', style: { minWidth: '200px' } }, who), mode, addBtn),
      status,
      h('div', { class: 'field-label', style: { fontWeight: '600' } }, 'People with access'),
      list,
    ],
    buttons: [{ label: 'Done', value: 'ok', primary: true }],
  }).finally(() => { open = false; stopWatching(); });
}

/** Parts other people shared with the current user (all pages); throws when none could be read. */
export async function sharedWithMe(): Promise<(FileEntry & { owner: string; mode: string })[]> {
  const fs = fsx();
  if (!cloudAvailable() || !fs?.listShared) return [];
  const out: (FileEntry & { owner: string; mode: string })[] = [];
  let cursor: string | null | undefined = null;
  try {
    // Pages can come back short; keep going until there is no cursor.
    for (let page = 0; page < 50; page++) {
      const res: { items: SharedItem[]; cursor?: string | null } = await fs.listShared({ cursor, limit: 100 });
      for (const i of res.items ?? []) {
        if (i.is_dir || i.isDir || !i.name.endsWith(EXT)) continue;
        out.push({
          name: i.name.slice(0, -EXT.length),
          location: { type: 'cloud', path: i.path },
          modified: toMs(i.modified),
          owner: typeof i.owner === 'string' ? i.owner : i.owner?.username ?? '',
          mode: i.mode ?? 'read',
        });
      }
      cursor = res.cursor;
      if (!cursor) break;
    }
  } catch (e) {
    // Later pages failing still leaves the ones read; nothing read is an error to show.
    if (!out.length) throw e;
  }
  return out;
}
