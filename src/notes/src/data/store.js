import { Emitter } from '../lib/emitter.js';
import { uid } from '../lib/ids.js';
import { htmlToText } from '../lib/sanitize.js';
import { nextColor } from './colors.js';
import { extractTags } from './tags.js';
import { createLock, unlockKey, sealJSON, openJSON, sealBytes, openBytes } from './crypto.js';

/*
 * Files, relative to the app's folder:
 *   library.json            notebook order and per-user library state
 *   notebooks/<id>.json     one manifest per notebook: sections, section
 *                           groups and page metadata (title, level, dates)
 *   pages/<id>.json         page content: outlines, ink, page settings
 *   versions/<id>.json      earlier versions of a page
 *   assets/<id>             pictures, attachments and recordings
 *   trash.json              deleted pages, sections and notebooks
 */

export const TRASH_DAYS = 60;
const VERSION_INTERVAL = 10 * 60 * 1000;
const MAX_VERSIONS = 20;
const SAVE_DELAY = 700;

export function emptyPage(id, title = '', now = new Date().toISOString()) {
  return { id, v: 1, title, created: now, modified: now, color: null, rules: null, ruleColor: null, outlines: [], ink: [] };
}

/** Plain text of a page for search, previews and export. */
export function pageText(page) {
  const parts = [page.title || ''];
  for (const o of page.outlines || []) parts.push(htmlToText(o.html));
  return parts.join('\n').trim();
}

export class Store extends Emitter {
  constructor(backend, { now = () => new Date().toISOString(), saveDelay = SAVE_DELAY } = {}) {
    super();
    this.backend = backend;
    this.now = now;
    this.saveDelay = saveDelay;
    this.library = { v: 1, notebooks: [] };
    this.notebooks = [];
    this.trash = [];
    this.pages = new Map();
    this.pageLoads = new Map();
    this.textCache = new Map();
    this.assetUrls = new Map();
    this.timers = new Map();
    this.writers = new Map();
    this.pendingWrites = new Map();
    this.failed = new Set();
    this.versionState = new Map();
    this.versionJobs = new Map();
    this.loadedSnapshots = new Map();
    this.status = 'saved';
    // Keys of unlocked password-protected sections, by section id. Never stored.
    this.keys = new Map();
    this.unlocked = { has: (id) => this.keys.has(id) };
  }

  // ---------------------------------------------------------------- loading

  async load({ defaultName = 'My Notebook' } = {}) {
    const [library, trash, listed] = await Promise.all([
      this.backend.readJSON('library.json'),
      this.backend.readJSON('trash.json'),
      this.backend.list('notebooks'),
    ]);
    this.library = library && Array.isArray(library.notebooks) ? library : { v: 1, notebooks: [] };
    this.trash = Array.isArray(trash) ? trash : [];
    const trashedNotebooks = new Set(this.trash.filter((t) => t.kind === 'notebook').map((t) => t.notebook.id));
    // Notebooks created on another device before this library.json was
    // written still show up: the folder listing is the source of truth.
    const ids = [...this.library.notebooks];
    for (const item of listed) {
      const id = item.name.replace(/\.json$/, '');
      if (!item.isDir && item.name.endsWith('.json') && !ids.includes(id) && !trashedNotebooks.has(id)) ids.push(id);
    }
    // A network error fails the whole load (the app offers to retry) rather
    // than silently dropping a notebook; only unreadable files are skipped.
    const loaded = await Promise.all(ids.map((id) => this.backend.readJSON(`notebooks/${id}.json`).catch((err) => {
      if (err instanceof SyntaxError) return { unreadable: id };
      throw err;
    })));
    this.unreadable = loaded.filter((nb) => nb?.unreadable).map((nb) => nb.unreadable);
    this.notebooks = loaded.filter((nb) => nb && nb.id && Array.isArray(nb.sections));
    this.syncLibraryOrder();
    if (!this.notebooks.length && !this.unreadable.length) await this.createStarterNotebook(defaultName);
    this.purgeExpiredTrash();
    this.emit('change', { type: 'load' });
  }

  async createStarterNotebook(name) {
    const nb = this.createNotebook(name, { silent: true });
    const quick = this.createSection(nb.id, { name: 'Quick Notes', color: 'yellow', silent: true });
    this.createSection(nb.id, { name: 'New Section 1', color: 'green', silent: true });
    this.createPage(quick.id, { title: '', silent: true });
    await this.flush();
    return nb;
  }

  /** Re-reads manifests changed on another device. Open dirty notebooks win. */
  async refresh() {
    const library = await this.backend.readJSON('library.json').catch(() => null);
    if (!library) return false;
    let changed = false;
    for (const id of library.notebooks || []) {
      if (this.timers.has(`notebooks/${id}.json`)) continue;
      const remote = await this.backend.readJSON(`notebooks/${id}.json`).catch(() => null);
      if (!remote) continue;
      const i = this.notebooks.findIndex((n) => n.id === id);
      if (i < 0) {
        if (this.trash.some((t) => t.kind === 'notebook' && t.notebook.id === id)) continue;
        this.notebooks.push(remote);
        changed = true;
      } else if (remote.modified > this.notebooks[i].modified) {
        for (const s of this.sectionsOf(remote)) {
          const key = this.keys.get(s.id);
          if (!key) continue;
          const pages = s.locked && s.sealed ? await openJSON(key, s.sealed).catch(() => null) : null;
          if (pages) s.pages = pages;
          else {
            // Password changed or removed on another device: this key no
            // longer fits, so the section locks rather than look empty (and
            // save an empty page list over the real one).
            this.keys.delete(s.id);
            if (s.locked) for (const m of this.section(s.id)?.pages || []) this.pages.delete(m.id);
          }
        }
        this.notebooks[i] = remote;
        changed = true;
      }
    }
    if (changed) {
      this.syncLibraryOrder();
      this.emit('change', { type: 'refresh' });
    }
    return changed;
  }

  /**
   * Reloads an open page if another device saved a newer copy and nothing
   * is waiting to be saved here. Returns true when the page changed.
   */
  async refreshPage(id) {
    const local = this.pages.get(id);
    if (!local || this.timers.has(`pages/${id}.json`) || this.pendingWrites.has(`pages/${id}.json`)) return false;
    let remote = await this.backend.readJSON(`pages/${id}.json`).catch(() => null);
    if (remote?.sealed) {
      const key = this.keys.get(this.findPage(id)?.section.id);
      remote = key ? await openJSON(key, remote.sealed).catch(() => null) : null;
    }
    if (!remote?.modified || remote.modified <= local.modified) return false;
    for (const k of Object.keys(local)) delete local[k];
    Object.assign(local, remote, { id });
    local.outlines ||= [];
    local.ink ||= [];
    this.textCache.delete(id);
    this.emit('page-replaced', { id });
    return true;
  }

  /** library.json keeps unreadable notebooks so a bad read never drops them. */
  syncLibraryOrder() {
    this.library.notebooks = [...this.notebooks.map((nb) => nb.id), ...(this.unreadable || []).filter((id) => !this.notebooks.some((nb) => nb.id === id))];
  }

  // ---------------------------------------------------------------- lookup

  notebook(id) {
    return this.notebooks.find((nb) => nb.id === id) || null;
  }

  /** Depth-first walk over sections (not groups) of a notebook. */
  *sectionsOf(nb) {
    const stack = [...nb.sections].reverse();
    while (stack.length) {
      const node = stack.pop();
      if (node.type === 'group') stack.push(...[...node.children].reverse());
      else yield node;
    }
  }

  *allSections() {
    for (const nb of this.notebooks) for (const s of this.sectionsOf(nb)) yield { notebook: nb, section: s };
  }

  /** Finds a section or group node with its containing list. */
  findNode(id) {
    for (const nb of this.notebooks) {
      const found = findIn(nb.sections, id, null);
      if (found) return { notebook: nb, ...found };
    }
    return null;
  }

  section(id) {
    const f = this.findNode(id);
    return f && f.node.type === 'section' ? f.node : null;
  }

  findPage(pageId) {
    for (const { notebook, section } of this.allSections()) {
      const index = section.pages.findIndex((p) => p.id === pageId);
      if (index >= 0) return { notebook, section, meta: section.pages[index], index };
    }
    return null;
  }

  /** Index range [start, end) of a page and the subpages under it. */
  pageGroup(section, index) {
    const level = section.pages[index].level || 0;
    let end = index + 1;
    while (end < section.pages.length && (section.pages[end].level || 0) > level) end++;
    return [index, end];
  }

  recentPages(limit = 40) {
    const all = [];
    for (const { notebook, section } of this.allSections()) {
      if (section.locked && !this.unlocked?.has(section.id)) continue;
      for (const meta of section.pages) all.push({ notebook, section, meta });
    }
    return all.sort((a, b) => (b.meta.modified || '').localeCompare(a.meta.modified || '')).slice(0, limit);
  }

  // ---------------------------------------------------------------- notebooks

  createNotebook(name, { color, silent } = {}) {
    const now = this.now();
    const nb = { id: uid('n'), v: 1, name: name.trim() || 'Untitled Notebook', color: color || nextColor(this.notebooks.map((n) => n.color)), created: now, modified: now, sections: [] };
    this.notebooks.push(nb);
    this.library.notebooks = this.notebooks.map((n) => n.id);
    this.touchNotebook(nb);
    this.scheduleLibrary();
    if (!silent) this.emit('change', { type: 'notebook', id: nb.id });
    return nb;
  }

  renameNotebook(id, name) {
    const nb = this.notebook(id);
    if (!nb || !name.trim()) return;
    nb.name = name.trim();
    this.touchNotebook(nb);
    this.emit('change', { type: 'notebook', id });
  }

  setNotebookColor(id, color) {
    const nb = this.notebook(id);
    if (!nb) return;
    nb.color = color;
    this.touchNotebook(nb);
    this.emit('change', { type: 'notebook', id });
  }

  moveNotebook(id, toIndex) {
    const from = this.notebooks.findIndex((n) => n.id === id);
    if (from < 0) return;
    const [nb] = this.notebooks.splice(from, 1);
    this.notebooks.splice(Math.max(0, Math.min(toIndex, this.notebooks.length)), 0, nb);
    this.library.notebooks = this.notebooks.map((n) => n.id);
    this.scheduleLibrary();
    this.emit('change', { type: 'notebook', id });
  }

  deleteNotebook(id) {
    const i = this.notebooks.findIndex((n) => n.id === id);
    if (i < 0) return null;
    const [nb] = this.notebooks.splice(i, 1);
    this.library.notebooks = this.notebooks.map((n) => n.id);
    const entry = { id: uid('t'), kind: 'notebook', deletedAt: this.now(), notebook: nb, index: i };
    this.trash.unshift(entry);
    this.scheduleLibrary();
    this.scheduleTrash();
    this.emit('change', { type: 'notebook-deleted', id });
    return entry;
  }

  // ---------------------------------------------------------------- sections

  createSection(notebookId, { name, color, parentId = null, index, silent } = {}) {
    const nb = this.notebook(notebookId);
    if (!nb) throw new Error('No such notebook');
    const list = parentId ? this.findNode(parentId)?.node.children : nb.sections;
    if (!list) throw new Error('No such section group');
    const used = [...this.sectionsOf(nb)].map((s) => s.color);
    const now = this.now();
    const section = { type: 'section', id: uid('s'), name: (name || '').trim() || this.uniqueSectionName(nb), color: color || nextColor(used), created: now, modified: now, pages: [] };
    list.splice(index ?? list.length, 0, section);
    this.touchNotebook(nb);
    if (!silent) this.emit('change', { type: 'section', id: section.id });
    return section;
  }

  uniqueSectionName(nb) {
    const names = new Set([...this.sectionsOf(nb)].map((s) => s.name));
    let n = 1;
    while (names.has(`New Section ${n}`)) n++;
    return `New Section ${n}`;
  }

  createGroup(notebookId, { name, parentId = null, index } = {}) {
    const nb = this.notebook(notebookId);
    const list = parentId ? this.findNode(parentId)?.node.children : nb.sections;
    const group = { type: 'group', id: uid('g'), name: (name || '').trim() || 'New Section Group', collapsed: false, children: [] };
    list.splice(index ?? list.length, 0, group);
    this.touchNotebook(nb);
    this.emit('change', { type: 'group', id: group.id });
    return group;
  }

  renameNode(id, name) {
    const f = this.findNode(id);
    if (!f || !name.trim()) return;
    f.node.name = name.trim();
    if (f.node.type === 'section') f.node.modified = this.now();
    this.touchNotebook(f.notebook);
    this.emit('change', { type: 'section', id });
  }

  setSectionColor(id, color) {
    const f = this.findNode(id);
    if (!f) return;
    f.node.color = color;
    this.touchNotebook(f.notebook);
    this.emit('change', { type: 'section', id });
  }

  toggleGroup(id, collapsed) {
    const f = this.findNode(id);
    if (!f || f.node.type !== 'group') return;
    f.node.collapsed = collapsed ?? !f.node.collapsed;
    this.touchNotebook(f.notebook);
    this.emit('change', { type: 'group', id });
  }

  /** Moves a section or group to a notebook/group at an index. */
  moveNode(id, { notebookId, parentId = null, index }) {
    const f = this.findNode(id);
    if (!f) return false;
    const target = this.notebook(notebookId || f.notebook.id);
    if (!target) return false;
    if (parentId && (parentId === id || (f.node.type === 'group' && findIn(f.node.children, parentId, null)))) return false;
    const list = parentId ? this.findNode(parentId)?.node.children : target.sections;
    if (!list) return false;
    f.list.splice(f.index, 1);
    let at = index ?? list.length;
    if (list === f.list && f.index < at) at--;
    list.splice(Math.max(0, Math.min(at, list.length)), 0, f.node);
    this.touchNotebook(f.notebook);
    if (target !== f.notebook) this.touchNotebook(target);
    this.emit('change', { type: 'section', id });
    return true;
  }

  /** Copies a section (with all page files) into a notebook. */
  async copySection(id, { notebookId, parentId = null, index } = {}) {
    const f = this.findNode(id);
    if (!f || f.node.type !== 'section') return null;
    const target = this.notebook(notebookId || f.notebook.id);
    const list = parentId ? this.findNode(parentId)?.node.children : target.sections;
    const now = this.now();
    const copy = { ...structuredClone(f.node), id: uid('s'), created: now, modified: now, pages: [] };
    delete copy.locked;
    delete copy.sealed;
    const copiedPages = [];
    if (target === f.notebook) copy.name = `${f.node.name} (copy)`;
    for (const meta of f.node.pages) {
      const page = await this.loadPage(meta.id);
      const newId = uid('p');
      const dup = { ...structuredClone(page), id: newId };
      this.pages.set(newId, dup);
      copiedPages.push(dup);
      this.schedule(`pages/${newId}.json`, () => this.pages.get(newId), 0);
      copy.pages.push({ ...meta, id: newId });
    }
    list.splice(index ?? list.length, 0, copy);
    this.touchNotebook(target);
    for (const page of copiedPages) await this.copyAssets(page);
    this.emit('change', { type: 'section', id: copy.id });
    return copy;
  }

  deleteNode(id) {
    const f = this.findNode(id);
    if (!f) return null;
    f.list.splice(f.index, 1);
    const entry = { id: uid('t'), kind: f.node.type === 'group' ? 'group' : 'section', deletedAt: this.now(), notebookId: f.notebook.id, parentId: f.parent?.id || null, index: f.index, node: f.node };
    this.trash.unshift(entry);
    this.touchNotebook(f.notebook);
    this.scheduleTrash();
    this.emit('change', { type: 'section-deleted', id });
    return entry;
  }

  // ---------------------------------------------------------------- pages

  /** True when a section is protected and its password has not been entered. */
  isLocked(sectionId) {
    const node = this.section(sectionId);
    return Boolean(node?.locked && !this.keys.has(node.id));
  }

  createPage(sectionId, { title = '', index, level = 0, outlines, color, rules, silent } = {}) {
    const f = this.findNode(sectionId);
    if (!f || f.node.type !== 'section') throw new Error('No such section');
    if (this.isLocked(sectionId)) throw new Error('Unlock this section to add pages.');
    const now = this.now();
    const id = uid('p');
    const page = { ...emptyPage(id, title, now), outlines: outlines || [], color: color || null, rules: rules || null };
    const meta = { id, title, level, created: now, modified: now };
    const pages = f.node.pages;
    pages.splice(index ?? pages.length, 0, meta);
    normalizeLevels(pages);
    this.pages.set(id, page);
    this.schedule(`pages/${id}.json`, () => this.pages.get(id), 0);
    f.node.modified = now;
    this.touchNotebook(f.notebook);
    if (!silent) this.emit('change', { type: 'page', id });
    return meta;
  }

  async loadPage(id) {
    if (this.pages.has(id)) return this.pages.get(id);
    if (this.pageLoads.has(id)) return this.pageLoads.get(id);
    const job = (async () => {
      // A sealed save still waiting to be retried is newer than the file.
      const queued = this.timers.get(`pages/${id}.json`)?.getter();
      let raw = typeof queued?.sealed === 'string' ? queued : await this.backend.readJSON(`pages/${id}.json`);
      const found = this.findPage(id);
      if (raw?.sealed) {
        // The page may have just moved, so its current section's key is
        // only the first guess.
        const first = found && this.keys.get(found.section.id);
        const keys = [first, ...this.keys.values()].filter(Boolean);
        let opened = null;
        for (const key of keys) {
          opened = await openJSON(key, raw.sealed).catch(() => null);
          if (opened) break;
        }
        if (!opened) throw new Error('This page is in a locked section.');
        raw = opened;
      }
      const page = raw && typeof raw === 'object' && raw.id ? raw : emptyPage(id, found?.meta.title || '', found?.meta.created || this.now());
      page.outlines ||= [];
      page.ink ||= [];
      // A page loaded twice concurrently must resolve to one object.
      if (!this.pages.has(id)) {
        this.pages.set(id, page);
        if (raw && !found?.section.locked) this.loadedSnapshots.set(id, structuredClone(raw));
      }
      return this.pages.get(id);
    })();
    this.pageLoads.set(id, job);
    try {
      return await job;
    } finally {
      this.pageLoads.delete(id);
    }
  }

  /** Records an edit to a loaded page and schedules its save. */
  pageChanged(page, { title } = {}) {
    const now = this.now();
    page.modified = now;
    this.textCache.delete(page.id);
    const found = this.findPage(page.id);
    if (found) {
      const titleChanged = title !== undefined && found.meta.title !== title;
      found.meta.modified = now;
      if (title !== undefined) {
        page.title = title;
        found.meta.title = title;
      }
      found.section.modified = now;
      this.touchNotebook(found.notebook, { quiet: true });
      if (titleChanged) this.emit('change', { type: 'page-title', id: page.id });
    }
    this.maybeVersion(page);
    this.schedule(`pages/${page.id}.json`, () => this.pages.get(page.id));
    this.emit('page-modified', { id: page.id });
  }

  setPageLevel(pageId, delta) {
    const f = this.findPage(pageId);
    if (!f) return false;
    const pages = f.section.pages;
    const [start, end] = this.pageGroup(f.section, f.index);
    const prevLevel = f.index > 0 ? pages[f.index - 1].level || 0 : -1;
    const level = f.meta.level || 0;
    const next = Math.max(0, Math.min(2, level + delta, prevLevel + 1));
    if (next === level) return false;
    const shift = next - level;
    for (let i = start; i < end; i++) pages[i].level = Math.max(0, Math.min(2, (pages[i].level || 0) + shift));
    normalizeLevels(pages);
    this.touchNotebook(f.notebook);
    this.emit('change', { type: 'page', id: pageId });
    return true;
  }

  togglePageCollapsed(pageId) {
    const f = this.findPage(pageId);
    if (!f) return;
    f.meta.collapsed = !f.meta.collapsed;
    this.touchNotebook(f.notebook);
    this.emit('change', { type: 'page', id: pageId });
  }

  /**
   * Moves a page (with its subpages) to a section at an index. Subpages
   * travel along and keep their relative level.
   */
  movePage(pageId, { sectionId, index, level }) {
    const f = this.findPage(pageId);
    if (!f) return false;
    const target = this.findNode(sectionId || f.section.id);
    if (!target || target.node.type !== 'section') return false;
    if (this.isLocked(target.node.id)) return false;
    const [start, end] = this.pageGroup(f.section, f.index);
    const group = f.section.pages.splice(start, end - start);
    let at = index ?? target.node.pages.length;
    if (target.node === f.section && at > start) at -= Math.min(at - start, group.length);
    at = Math.max(0, Math.min(at, target.node.pages.length));
    if (level !== undefined) {
      const shift = level - (group[0].level || 0);
      for (const m of group) m.level = Math.max(0, Math.min(2, (m.level || 0) + shift));
    }
    target.node.pages.splice(at, 0, ...group);
    normalizeLevels(f.section.pages);
    normalizeLevels(target.node.pages);
    this.touchNotebook(f.notebook);
    if (target.notebook !== f.notebook) this.touchNotebook(target.notebook);
    if ((f.section.locked || target.node.locked) && f.section !== target.node) {
      for (const m of group) {
        this.loadPage(m.id).then((page) => {
          this.rekeyAssets(page);
          this.schedule(`pages/${m.id}.json`, () => this.pages.get(m.id), 0);
        }).catch(() => {});
      }
    }
    this.emit('change', { type: 'page', id: pageId });
    return true;
  }

  async copyPage(pageId, { sectionId, index } = {}) {
    const f = this.findPage(pageId);
    if (!f) return null;
    const page = await this.loadPage(pageId);
    const target = this.findNode(sectionId || f.section.id)?.node;
    if (!target || target.type !== 'section') return null;
    const now = this.now();
    const id = uid('p');
    const sameSection = target === f.section;
    const title = sameSection && page.title ? `${page.title} (copy)` : page.title;
    const dup = { ...structuredClone(page), id, title, modified: now };
    this.pages.set(id, dup);
    this.schedule(`pages/${id}.json`, () => this.pages.get(id), 0);
    const meta = { id, title, level: sameSection ? f.meta.level || 0 : 0, created: page.created, modified: now };
    const at = index ?? (sameSection ? this.pageGroup(f.section, f.index)[1] : target.pages.length);
    target.pages.splice(at, 0, meta);
    normalizeLevels(target.pages);
    this.touchNotebook(this.findNode(target.id).notebook);
    await this.copyAssets(dup);
    this.emit('change', { type: 'page', id });
    return meta;
  }

  deletePage(pageId) {
    const f = this.findPage(pageId);
    if (!f) return null;
    const pages = f.section.pages;
    // A collapsed parent takes its hidden subpages with it, so nothing is left
    // behind that the page list was not showing.
    const [start, end] = f.meta.collapsed ? this.pageGroup(f.section, f.index) : [f.index, f.index + 1];
    const removed = pages.splice(start, end - start);
    normalizeLevels(pages);
    const entry = { id: uid('t'), kind: 'page', deletedAt: this.now(), notebookId: f.notebook.id, sectionId: f.section.id, sectionName: f.section.name, index: start, pages: removed };
    if (f.section.locked) {
      entry.lockedSection = f.section.id;
      entry.pageIds = removed.map((p) => p.id);
    }
    this.trash.unshift(entry);
    this.touchNotebook(f.notebook);
    this.scheduleTrash();
    this.emit('change', { type: 'page-deleted', id: pageId });
    return entry;
  }

  // ---------------------------------------------------------------- trash

  /** Decrypts a Deleted Notes entry from a protected section so it can be restored. */
  async openTrash(trashId) {
    const entry = this.trash.find((t) => t.id === trashId);
    if (!entry) return false;
    if (entry.kind === 'page' && entry.sealedPages && !entry.pages.length) {
      const key = this.keys.get(entry.lockedSection);
      if (!key) return false;
      const pages = await openJSON(key, entry.sealedPages).catch(() => null);
      if (!pages) return false;
      entry.pages = pages;
      delete entry.sealedPages;
    }
    return true;
  }

  restore(trashId) {
    const i = this.trash.findIndex((t) => t.id === trashId);
    if (i < 0) return null;
    const entry = this.trash[i];
    let result = null;
    if (entry.kind === 'notebook') {
      this.notebooks.splice(Math.min(entry.index, this.notebooks.length), 0, entry.notebook);
      this.library.notebooks = this.notebooks.map((n) => n.id);
      this.touchNotebook(entry.notebook);
      this.scheduleLibrary();
      result = { notebookId: entry.notebook.id };
    } else if (entry.kind === 'section' || entry.kind === 'group') {
      const nb = this.notebook(entry.notebookId) || this.notebooks[0];
      if (!nb) return null;
      const parent = entry.parentId ? this.findNode(entry.parentId)?.node : null;
      const list = parent?.children || nb.sections;
      list.splice(Math.min(entry.index, list.length), 0, entry.node);
      this.touchNotebook(nb);
      result = { notebookId: nb.id, sectionId: entry.node.id };
    } else if (entry.kind === 'page') {
      let section = this.section(entry.sectionId);
      if (!section) {
        const nb = this.notebook(entry.notebookId) || this.notebooks[0];
        if (!nb) return null;
        section = [...this.sectionsOf(nb)][0] || this.createSection(nb.id, { name: entry.sectionName || 'Restored Pages', silent: true });
      }
      if (this.isLocked(section.id)) return null;
      section.pages.splice(Math.min(entry.index, section.pages.length), 0, ...entry.pages);
      normalizeLevels(section.pages);
      this.touchNotebook(this.findNode(section.id).notebook);
      result = { sectionId: section.id, pageId: entry.pages[0]?.id };
    }
    this.trash.splice(i, 1);
    this.scheduleTrash();
    this.emit('change', { type: 'restore' });
    return result;
  }

  /** Permanently deletes a trash entry and the files it owns. */
  async purge(trashId) {
    const i = this.trash.findIndex((t) => t.id === trashId);
    if (i < 0) return;
    const [entry] = this.trash.splice(i, 1);
    const pageIds = trashPageIds(entry);
    this.scheduleTrash();
    this.emit('change', { type: 'purge' });
    await Promise.all(pageIds.map((id) => this.dropPageFiles(id)));
    if (entry.kind === 'notebook') {
      this.cancel(`notebooks/${entry.notebook.id}.json`);
      await this.backend.remove(`notebooks/${entry.notebook.id}.json`);
    }
  }

  async emptyTrash() {
    for (const entry of [...this.trash]) await this.purge(entry.id);
  }

  purgeExpiredTrash() {
    const cutoff = Date.now() - TRASH_DAYS * 86400000;
    for (const entry of [...this.trash]) if (Date.parse(entry.deletedAt) < cutoff) this.purge(entry.id).catch(() => {});
  }

  async dropPageFiles(id) {
    this.cancel(`pages/${id}.json`);
    this.pages.delete(id);
    this.textCache.delete(id);
    // A shared link must not outlive a page deleted for good.
    await Promise.all([this.backend.remove(`pages/${id}.json`), this.backend.remove(`versions/${id}.json`), this.backend.remove(`published/${id}.json`)]);
  }

  // ---------------------------------------------------------------- versions

  /**
   * Keeps the page as it was before this editing session as a version, at
   * most once per VERSION_INTERVAL (judged by the newest stored version, so
   * reloading the app does not add versions).
   */
  maybeVersion(page) {
    // Versions of protected pages would be plaintext copies; none are kept.
    if (this.findPage(page.id)?.section.locked) return;
    const state = this.versionState.get(page.id);
    if (state?.busy || (state && Date.now() - state.last < VERSION_INTERVAL)) return;
    const before = this.loadedSnapshots.get(page.id);
    if (!before) return;
    this.versionState.set(page.id, { busy: true, last: Date.now() });
    const job = (async () => {
      const list = (await this.backend.readJSON(`versions/${page.id}.json`).catch(() => null)) || [];
      // The section may have been protected while the list was read.
      if (this.protectionOf(page.id)) return;
      const newest = list[0] ? Date.parse(list[0].at) : 0;
      if (Date.now() - newest >= VERSION_INTERVAL && before.modified !== list[0]?.page.modified) {
        list.unshift({ at: this.now(), page: before });
        list.length = Math.min(list.length, MAX_VERSIONS);
        await this.backend.writeJSON(`versions/${page.id}.json`, list);
      }
      this.loadedSnapshots.set(page.id, structuredClone(this.pages.get(page.id) || page));
    })().catch(() => {}).finally(() => {
      this.versionState.set(page.id, { busy: false, last: Date.now() });
      if (this.versionJobs.get(page.id) === job) this.versionJobs.delete(page.id);
    });
    this.versionJobs.set(page.id, job);
  }

  async addVersion(pageId, snapshot) {
    const list = (await this.backend.readJSON(`versions/${pageId}.json`).catch(() => null)) || [];
    list.unshift({ at: this.now(), page: snapshot });
    list.length = Math.min(list.length, MAX_VERSIONS);
    await this.backend.writeJSON(`versions/${pageId}.json`, list);
  }

  async versions(pageId) {
    return (await this.backend.readJSON(`versions/${pageId}.json`).catch(() => null)) || [];
  }

  async restoreVersion(pageId, at) {
    const list = await this.versions(pageId);
    const v = list.find((x) => x.at === at);
    const page = await this.loadPage(pageId);
    if (!v) return null;
    await this.addVersion(pageId, structuredClone(page));
    Object.assign(page, structuredClone(v.page), { id: pageId });
    this.pageChanged(page, { title: page.title });
    this.emit('page-replaced', { id: pageId });
    return page;
  }

  // ---------------------------------------------------------------- protection

  /** Encrypts what a protected section would otherwise write in plaintext. */
  /**
   * The protected section a page belongs to, live or in Deleted Notes, or
   * null when the page is not protected. Plaintext must never be written
   * for a page this returns a section for.
   */
  protectionOf(pageId) {
    const found = this.findPage(pageId);
    if (found) return found.section.locked ? found.section.id : null;
    for (const entry of this.trash) {
      if (entry.kind === 'page' && entry.lockedSection && (entry.pageIds?.includes(pageId) || entry.pages.some((p) => p.id === pageId))) return entry.lockedSection;
      const node = entry.node || entry.notebook;
      if (!node) continue;
      const stack = [node];
      while (stack.length) {
        const n = stack.pop();
        if (n.type === 'group') stack.push(...n.children);
        else if (n.sections) stack.push(...n.sections);
        else if (n.locked && n.pages?.some((p) => p.id === pageId)) return n.id;
      }
    }
    return null;
  }

  async seal(path, value) {
    if (path.startsWith('pages/')) {
      if (typeof value?.sealed === 'string') return value;
      const sectionId = this.protectionOf(value?.id);
      if (!sectionId) return value;
      const key = this.keys.get(sectionId);
      return key ? { id: value.id, sealed: await sealJSON(key, value) } : null;
    }
    if (path.startsWith('notebooks/') || path === 'trash.json') {
      const jobs = [];
      const visit = (node) => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) return node.forEach(visit);
        if (node.kind === 'page' && node.lockedSection && node.pages?.length) {
          const key = this.keys.get(node.lockedSection);
          if (key) jobs.push(sealJSON(key, node.pages).then((sealed) => {
            node.sealedPages = sealed;
            node.pages = [];
            node.sectionName = '';
          }));
          else if (node.sealedPages) node.pages = [];
          // No key and nothing sealed yet: keep nothing readable, but never
          // lose the entry. This only happens if the key was dropped early.
          else node.pages = node.pages.map((p) => ({ id: p.id, level: p.level || 0, title: '' }));
          return;
        }
        if (node.type === 'section' && node.locked) {
          const key = this.keys.get(node.id);
          if (key) jobs.push(sealJSON(key, node.pages).then((sealed) => {
            node.sealed = sealed;
            node.pages = [];
          }));
          else node.pages = [];
          return;
        }
        for (const v of Object.values(node)) if (v && typeof v === 'object') visit(v);
      };
      visit(value);
      await Promise.all(jobs);
    }
    return value;
  }

  /** Opens a protected section with its password. Returns false if wrong. */
  async unlockSection(id, password) {
    const f = this.findNode(id);
    if (!f?.node.locked) return true;
    const key = await unlockKey(f.node.locked, password);
    if (!key) return false;
    this.keys.set(id, key);
    if (f.node.sealed) {
      f.node.pages = await openJSON(key, f.node.sealed);
    }
    this.emit('change', { type: 'unlock', id });
    return true;
  }

  /** Locks a section again: writes pending changes sealed, then forgets the key and the pages. */
  async lockSection(id) {
    // A section deleted while unlocked sits in Deleted Notes and locks too.
    const node = this.findNode(id)?.node || this.trashedSection(id);
    if (!node?.locked || !this.keys.has(id)) return;
    const pageIds = node.pages.map((p) => p.id);
    await this.flush();
    const key = this.keys.get(id);
    // A save that failed (offline) is retried after the key is gone, when it
    // could no longer be encrypted: seal what it will write now instead.
    const trashed = this.trash.filter((e) => e.kind === 'page' && e.lockedSection === id).flatMap((e) => e.pages.map((p) => p.id));
    for (const pid of [...pageIds, ...trashed]) {
      const pending = this.timers.get(`pages/${pid}.json`);
      const page = this.pages.get(pid);
      if (!pending || !page) continue;
      const sealed = { id: pid, sealed: await sealJSON(key, page) };
      pending.getter = () => sealed;
    }
    for (const entry of this.trash) {
      if (entry.kind === 'page' && entry.lockedSection === id && entry.pages.length) {
        entry.sealedPages = await sealJSON(key, entry.pages);
        entry.pages = [];
        entry.sectionName = '';
      }
    }
    node.sealed = await sealJSON(key, node.pages);
    this.keys.delete(id);
    node.pages = [];
    for (const pid of [...pageIds, ...trashed]) {
      this.pages.delete(pid);
      this.textCache.delete(pid);
    }
    for (const a of [...this.assetUrls.keys()].filter((a) => a.startsWith(`${id}.`))) {
      URL.revokeObjectURL(this.assetUrls.get(a));
      this.assetUrls.delete(a);
    }
    this.emit('change', { type: 'lock', id });
  }

  /** A section inside a Deleted Notes entry (deleted itself or with its group or notebook). */
  trashedSection(id) {
    for (const entry of this.trash) {
      const root = entry.node || entry.notebook;
      if (!root) continue;
      const found = findIn(root.sections || [root], id, null);
      if (found?.node.type === 'section') return found.node;
    }
    return null;
  }

  async lockAll() {
    for (const id of [...this.keys.keys()]) await this.lockSection(id);
  }

  /** Adds (or replaces) a section's password and encrypts its pages and assets. */
  async protectSection(id, password) {
    const f = this.findNode(id);
    if (!f || f.node.type !== 'section') return false;
    if (f.node.locked && !this.keys.has(id)) return false;
    const pages = await Promise.all(f.node.pages.map((m) => this.loadPage(m.id)));
    const { lock, key } = await createLock(password);
    const oldKey = this.keys.get(id);
    f.node.locked = lock;
    delete f.node.sealed;
    this.keys.set(id, key);
    if (oldKey) {
      // Deleted pages of this section move to the new key too.
      for (const entry of this.trash) {
        if (entry.kind !== 'page' || entry.lockedSection !== id) continue;
        if (entry.sealedPages) {
          entry.pages = await openJSON(oldKey, entry.sealedPages).catch(() => entry.pages);
          delete entry.sealedPages;
        }
        for (const m of entry.pages) {
          const raw = await this.backend.readJSON(`pages/${m.id}.json`).catch(() => null);
          if (!raw?.sealed) continue;
          const page = await openJSON(oldKey, raw.sealed).catch(() => null);
          if (!page) continue;
          this.pages.set(m.id, page);
          this.schedule(`pages/${m.id}.json`, () => this.pages.get(m.id), 0);
        }
      }
      this.scheduleTrash();
    }
    for (const page of pages) {
      await this.rekeyAssets(page, { from: oldKey, sectionId: id, force: Boolean(oldKey) });
      this.schedule(`pages/${page.id}.json`, () => this.pages.get(page.id), 0);
      // A version being written right now would land after the removal.
      await this.versionJobs.get(page.id);
      this.loadedSnapshots.delete(page.id);
      await this.backend.remove(`versions/${page.id}.json`).catch(() => {});
    }
    this.touchNotebook(f.notebook);
    await this.flush();
    this.emit('change', { type: 'protect', id });
    return true;
  }

  /** Removes a section's password (the section must be unlocked). */
  async unprotectSection(id) {
    const f = this.findNode(id);
    if (!f?.node.locked || !this.keys.has(id)) return false;
    const pages = await Promise.all(f.node.pages.map((m) => this.loadPage(m.id)));
    const key = this.keys.get(id);
    delete f.node.locked;
    delete f.node.sealed;
    for (const page of pages) {
      await this.rekeyAssets(page, { from: key, sectionId: null });
      this.schedule(`pages/${page.id}.json`, () => this.pages.get(page.id), 0);
    }
    this.keys.delete(id);
    this.touchNotebook(f.notebook);
    await this.flush();
    this.emit('change', { type: 'unprotect', id });
    return true;
  }

  /**
   * Re-saves a page's assets so they match its section: sealed with the
   * section key when protected, plain otherwise. Old copies are removed.
   */
  async rekeyAssets(page, { from = null, sectionId, force = false } = {}) {
    const target = sectionId === undefined ? this.findPage(page.id)?.section : this.section(sectionId);
    const wantSection = target?.locked && this.keys.has(target.id) ? target.id : null;
    let changed = false;
    for (const o of page.outlines) {
      const ids = [...new Set([...o.html.matchAll(/data-asset="([^"]+)"/g)].map((m) => m[1]))];
      for (const assetId of ids) {
        if (!isAssetId(assetId)) continue;
        const sealedFor = assetId.endsWith('.sealed') ? assetId.split('.')[0] : null;
        if (sealedFor === wantSection && !(force && sealedFor)) continue;
        let blob;
        if (sealedFor) {
          const key = force && sealedFor === target?.id && from ? from : this.keys.get(sealedFor) || from;
          const stored = await this.backend.readBlob(`assets/${assetId}`);
          if (!stored || !key) continue;
          const bytes = await openBytes(key, new Uint8Array(await (stored instanceof Blob ? stored : new Blob([stored])).arrayBuffer())).catch(() => null);
          if (!bytes) continue;
          blob = new Blob([bytes], { type: extMime(assetId.split('.').at(-2)) });
        } else {
          blob = await this.backend.readBlob(`assets/${assetId}`);
          if (!blob) continue;
          if (!(blob instanceof Blob)) blob = new Blob([blob]);
        }
        const ext = sealedFor ? assetId.split('.').at(-2) : assetId.split('.').pop();
        const newId = await this.saveAsset(blob, `x.${ext}`, { sectionId: wantSection });
        o.html = o.html.split(`data-asset="${assetId}"`).join(`data-asset="${newId}"`);
        await this.backend.remove(`assets/${assetId}`).catch(() => {});
        changed = true;
      }
    }
    if (changed) this.schedule(`pages/${page.id}.json`, () => this.pages.get(page.id), 0);
    return changed;
  }

  /** A copied page gets its own copies of sealed assets, keyed for where it now lives. */
  async copyAssets(page) {
    const target = this.findPage(page.id)?.section;
    const needs = page.outlines.some((o) => /data-asset="[^"]+\.sealed"/.test(o.html)) || target?.locked;
    if (!needs) return;
    for (const o of page.outlines) {
      for (const m of [...o.html.matchAll(/data-asset="([^"]+)"/g)]) {
        const blob = await this.assetBlob(m[1]).catch(() => null);
        if (!blob) continue;
        const ext = m[1].endsWith('.sealed') ? m[1].split('.').at(-2) : m[1].split('.').pop();
        const id = await this.saveAsset(blob, `x.${ext}`, { sectionId: target?.locked ? target.id : null });
        o.html = o.html.split(`data-asset="${m[1]}"`).join(`data-asset="${id}"`);
      }
    }
    this.schedule(`pages/${page.id}.json`, () => this.pages.get(page.id), 0);
  }

  // ---------------------------------------------------------------- search

  async textOf(pageId) {
    const page = await this.loadPage(pageId);
    const key = `${pageId}:${page.modified}`;
    const cached = this.textCache.get(pageId);
    if (cached?.key === key) return cached.text;
    const text = pageText(page);
    this.textCache.set(pageId, { key, text });
    return text;
  }

  /** Page metadata in a scope: all | notebook:<id> | section:<id> | page:<id>. */
  scopePages(scope = 'all') {
    const out = [];
    const [kind, id] = scope.split(':');
    for (const { notebook, section } of this.allSections()) {
      if (section.locked && !this.unlocked?.has(section.id)) continue;
      if (kind === 'notebook' && notebook.id !== id) continue;
      if (kind === 'section' && section.id !== id) continue;
      for (const meta of section.pages) {
        if (kind === 'page' && meta.id !== id) continue;
        out.push({ notebook, section, meta });
      }
    }
    return out;
  }

  /**
   * Searches page titles and text. Every whitespace-separated term must
   * appear (case- and accent-insensitive). Title hits rank first.
   */
  async search(query, { scope = 'all', limit = 200 } = {}) {
    const terms = normalize(query).split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    const candidates = this.scopePages(scope);
    const results = [];
    await mapLimit(candidates, 6, async (c) => {
      const text = await this.textOf(c.meta.id).catch(() => '');
      const hay = normalize(text);
      if (!terms.every((t) => hay.includes(t))) return;
      const title = normalize(c.meta.title || '');
      const score = terms.reduce((s, t) => s + (title.includes(t) ? 10 : 0) + countOf(hay, t), 0);
      results.push({ ...c, score, snippet: snippet(text, terms) });
    });
    results.sort((a, b) => b.score - a.score || (b.meta.modified || '').localeCompare(a.meta.modified || ''));
    return results.slice(0, limit);
  }

  /** Every tagged paragraph in a scope, for the Tags Summary pane. */
  async collectTags(scope = 'all') {
    const out = [];
    await mapLimit(this.scopePages(scope), 6, async (c) => {
      const page = await this.loadPage(c.meta.id).catch(() => null);
      if (!page) return;
      for (const t of extractTags(page.outlines)) out.push({ ...t, ...c });
    });
    return out;
  }

  // ---------------------------------------------------------------- assets

  /**
   * Stores a picture, attachment or recording. In an unlocked protected
   * section the bytes are encrypted with the section key; the asset id then
   * names the section so the right key can open it later.
   */
  async saveAsset(blob, name = '', { sectionId } = {}) {
    const ext = (name.match(/\.([a-z0-9]{1,8})$/i)?.[1] || mimeExt(blob.type) || 'bin').toLowerCase();
    const key = sectionId && this.keys.get(sectionId);
    const id = key ? `${sectionId}.${uid('a')}.${ext}.sealed` : `${uid('a')}.${ext}`;
    this.setStatus('saving');
    try {
      const data = key ? new Blob([await sealBytes(key, new Uint8Array(await blob.arrayBuffer()))]) : blob;
      await this.backend.writeBlob(`assets/${id}`, data);
    } finally {
      this.updateStatus();
    }
    this.assetUrls.set(id, URL.createObjectURL(blob));
    return id;
  }

  async assetBlob(id) {
    if (!isAssetId(id)) return null;
    const stored = await this.backend.readBlob(`assets/${id}`);
    if (!stored || !id.endsWith('.sealed')) return stored;
    const key = this.keys.get(id.split('.')[0]);
    if (!key) return null;
    const bytes = await openBytes(key, new Uint8Array(await (stored instanceof Blob ? stored : new Blob([stored])).arrayBuffer()));
    const ext = id.split('.').at(-2);
    return new Blob([bytes], { type: extMime(ext) });
  }

  async assetUrl(id) {
    if (this.assetUrls.has(id)) return this.assetUrls.get(id);
    const blob = await this.assetBlob(id);
    if (!blob) return null;
    const url = URL.createObjectURL(blob instanceof Blob ? blob : new Blob([blob]));
    this.assetUrls.set(id, url);
    return url;
  }

  // ---------------------------------------------------------------- saving

  touchNotebook(nb, { quiet = false } = {}) {
    nb.modified = this.now();
    this.schedule(`notebooks/${nb.id}.json`, () => this.notebook(nb.id) || null);
    if (!quiet) this.scheduleLibrary();
  }

  scheduleLibrary() {
    this.schedule('library.json', () => this.library);
  }

  scheduleTrash() {
    this.schedule('trash.json', () => this.trash);
  }

  /** Debounced write of the value getter() returns for path. */
  schedule(path, getter, delay = this.saveDelay) {
    clearTimeout(this.timers.get(path)?.t);
    const t = setTimeout(() => this.write(path), delay);
    this.timers.set(path, { t, getter });
    this.setStatus('pending');
  }

  cancel(path) {
    const entry = this.timers.get(path);
    if (entry) clearTimeout(entry.t);
    this.timers.delete(path);
    this.failed.delete(path);
    this.updateStatus();
  }

  async write(path) {
    const entry = this.timers.get(path);
    if (!entry) return;
    this.timers.delete(path);
    clearTimeout(entry.t);
    const value = entry.getter();
    if (value === null || value === undefined) {
      // Nothing left to save (deleted meanwhile): a failure of it is moot.
      this.failed.delete(path);
      return this.updateStatus();
    }
    let snapshot = JSON.parse(JSON.stringify(value));
    // Writes to one path run one at a time, in order.
    const prev = this.writers.get(path) || Promise.resolve();
    const job = prev.then(async () => {
      this.pendingWrites.set(path, (this.pendingWrites.get(path) || 0) + 1);
      this.setStatus('saving');
      try {
        snapshot = await this.seal(path, snapshot);
        if (snapshot !== null) await this.backend.writeJSON(path, snapshot);
        this.failed.delete(path);
      } catch (err) {
        console.warn('Save failed', path, err);
        this.failed.add(path);
        // Retry with the latest value later unless a newer save is queued.
        if (!this.timers.has(path)) {
          const t = setTimeout(() => this.write(path), 5000);
          this.timers.set(path, { t, getter: entry.getter });
        }
      } finally {
        const n = (this.pendingWrites.get(path) || 1) - 1;
        if (n) this.pendingWrites.set(path, n);
        else this.pendingWrites.delete(path);
        this.updateStatus();
      }
    });
    this.writers.set(path, job.catch(() => {}));
    return job;
  }

  /** Writes everything pending now. */
  async flush() {
    const paths = [...this.timers.keys()];
    await Promise.all(paths.map((p) => this.write(p)));
    await Promise.all([...this.writers.values()]);
  }

  hasUnsaved() {
    return this.timers.size > 0 || this.pendingWrites.size > 0;
  }

  setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.emit('status', status);
  }

  updateStatus() {
    if (this.pendingWrites.size) this.setStatus('saving');
    else if (this.failed.size) this.setStatus('error');
    else if (this.timers.size) this.setStatus('pending');
    else this.setStatus('saved');
  }
}

function findIn(list, id, parent) {
  for (let i = 0; i < list.length; i++) {
    const node = list[i];
    if (node.id === id) return { node, list, index: i, parent };
    if (node.type === 'group') {
      const found = findIn(node.children, id, node);
      if (found) return found;
    }
  }
  return null;
}

/** Keeps subpage levels valid: the first page is level 0 and no page is more than one deeper than the one above. */
export function normalizeLevels(pages) {
  let prev = -1;
  for (const p of pages) {
    const level = Math.max(0, Math.min(2, p.level || 0, prev + 1));
    p.level = level;
    prev = level;
  }
  return pages;
}

function trashPageIds(entry) {
  if (entry.kind === 'page') return entry.pages.map((p) => p.id);
  const ids = [];
  const visit = (node) => {
    if (node.type === 'group') node.children.forEach(visit);
    else ids.push(...node.pages.map((p) => p.id));
  };
  if (entry.kind === 'notebook') entry.notebook.sections.forEach(visit);
  else visit(entry.node);
  return ids;
}

export function normalize(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function countOf(hay, term) {
  let n = 0;
  let i = hay.indexOf(term);
  while (i >= 0 && n < 50) {
    n++;
    i = hay.indexOf(term, i + term.length);
  }
  return n;
}

/** A short excerpt around the first match. */
export function snippet(text, terms, radius = 60) {
  const flat = text.replace(/\s+/g, ' ');
  const hay = normalize(flat);
  let at = -1;
  for (const t of terms) {
    const i = hay.indexOf(t);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) return flat.slice(0, radius * 2);
  const start = Math.max(0, at - radius);
  const end = Math.min(flat.length, at + radius);
  return (start > 0 ? '…' : '') + flat.slice(start, end).trim() + (end < flat.length ? '…' : '');
}

async function mapLimit(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

/** Asset ids are generated names; anything else (like a path) is refused. */
export function isAssetId(id) {
  return /^[a-z0-9]+(\.[a-z0-9]+){1,3}$/i.test(String(id || ''));
}

function extMime(ext) {
  return { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', webm: 'video/webm', ogg: 'audio/ogg', m4a: 'audio/mp4', mp4: 'video/mp4', pdf: 'application/pdf', txt: 'text/plain' }[ext] || 'application/octet-stream';
}

function mimeExt(type) {
  return { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'video/webm': 'webm', 'application/pdf': 'pdf', 'text/plain': 'txt' }[type];
}
