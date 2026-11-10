import { el, listItem, isComposing, relativeTime, formatBytes, MOD_KEY } from '../ui/dom.js';
import { commandIconEl } from '../ui/ribbon.js';
import { iconEl } from '../ui/icons.js';
import { TEMPLATES } from '../lib/templates.js';
import { documentStatistics } from './editor-commands.js';

/**
 * The File view ("backstage"): a full-window page over the editor with the file's commands in a column
 * on the left — New, Open, Info, Save, Print, Share, Export, Close — and the chosen one's page on the
 * right. Escape or Back returns to the document.
 *
 * The api object comes from the editor view; every entry is optional and its page is left out when the
 * editor cannot do it (a document on this device has no version history, for one).
 */
export function createBackstage(api) {
  const { local } = api;
  const sections = [
    ['new', 'New', 'filePlus'],
    ['open', 'Open', 'folderOpen'],
    ['info', 'Info', 'info'],
    ['save', local ? 'Download' : 'Save', local ? 'download' : 'save'],
    ['print', 'Print', 'print'],
    ...(api.shareAvailable?.() ? [['share', 'Share', 'share']] : []),
    ['export', 'Export', 'pdf'],
  ];
  const panel = el('div.bs-panel', { role: 'tabpanel', tabindex: -1 });
  const tabs = new Map();
  const nav = el('div.bs-nav', { role: 'tablist', 'aria-orientation': 'vertical', 'aria-label': 'File' });
  const back = el('button.bs-back', { type: 'button', 'aria-label': 'Back to the document', title: 'Back to the document (Escape)', onclick: () => close() }, iconEl('back', 18), el('span', {}, 'Back'));
  for (const [id, label, icon] of sections) {
    const tab = el('button.bs-tab', { type: 'button', role: 'tab', id: `bs-tab-${id}`, 'aria-selected': 'false', 'aria-controls': 'bs-panel', tabIndex: -1, onclick: () => show(id, { focus: false }) }, commandIconEl(icon, 18), el('span', {}, label));
    tabs.set(id, tab); nav.append(tab);
  }
  panel.id = 'bs-panel';
  const footer = el('div.bs-nav-footer', {},
    el('button.bs-tab', { type: 'button', onclick: () => { close(); api.goHome?.(); } }, commandIconEl('close', 18), el('span', {}, 'Close')),
    api.preferences ? el('button.bs-tab', { type: 'button', onclick: () => { close(); api.preferences(); } }, commandIconEl('preferences', 18), el('span', {}, 'Preferences')) : null);
  // A dialog only while it is open: closed, it is an empty shell nothing should find.
  const root = el('div.backstage', { 'aria-label': 'File', hidden: true },
    el('aside.bs-side', {}, back, nav, footer), el('main.bs-main', {}, panel));
  let current = 'info', opener = null, token = 0;
  // Property edits not yet saved with Save Properties, applied as the page is left (Back, Escape, another page).
  let leavePage = null;
  const leave = () => { const commit = leavePage; leavePage = null; try { commit?.(); } catch { /* the edits could not be applied */ } };

  // Escape closes the File view wherever the keyboard is (a button that disabled itself while working
  // leaves focus on the page body), unless a dialog or menu above it takes the key.
  const onEscape = e => {
    if (root.hidden || e.key !== 'Escape' || e.defaultPrevented || isComposing(e)) return;
    if (document.querySelector('.modal-root:not(.closing), .menu')) return;
    if (document.activeElement && document.activeElement !== document.body && !root.contains(document.activeElement)) return;
    e.preventDefault(); e.stopPropagation(); close();
  };
  // The pages are listed down the side, or along the top in a narrow window (the view's CSS): the arrows follow the list.
  const across = typeof matchMedia === 'function' ? matchMedia('(max-width: 700px)') : null;
  const orient = () => nav.setAttribute('aria-orientation', across?.matches ? 'horizontal' : 'vertical');
  root.addEventListener('keydown', e => {
    if (isComposing(e)) return;
    if (!e.target.matches?.('.bs-tab[role="tab"]')) return;
    const list = [...tabs.values()], at = list.indexOf(e.target);
    const [back, forward] = across?.matches ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
    const next = e.key === forward ? at + 1 : e.key === back ? at - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : null;
    if (next === null) return;
    e.preventDefault();
    const tab = list[(next + list.length) % list.length];
    show(tab.id.slice(7));
  });
  // Tab stays inside the File view.
  root.addEventListener('keydown', e => {
    if (e.key !== 'Tab' || e.altKey || e.ctrlKey || e.metaKey) return;
    const focusable = [...root.querySelectorAll('button, input, select, textarea, a[href], [tabindex="0"]')].filter(n => !n.disabled && !n.closest('[hidden]') && n.tabIndex >= 0);
    if (!focusable.length) return;
    const first = focusable[0], last = focusable.at(-1);
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  function show(id, { focus = true } = {}) {
    if (!tabs.has(id)) id = 'info';
    current = id;
    for (const [key, tab] of tabs) { tab.setAttribute('aria-selected', String(key === id)); tab.tabIndex = key === id ? 0 : -1; }
    panel.setAttribute('aria-labelledby', `bs-tab-${id}`);
    const request = ++token;
    leave();
    panel.replaceChildren(...[builders[id]?.(request)].flat().filter(Boolean));
    panel.scrollTop = 0;
    // In a narrow window the pages run along a row that scrolls sideways: the focus brings a half-hidden one wholly
    // into view (the browser scrolls only to one wholly out of view).
    if (focus) { tabs.get(id).focus(); tabs.get(id).scrollIntoView?.({ block: 'nearest', inline: 'nearest' }); }
  }
  const stillShowing = request => request === token && !root.hidden;
  const heading = (text, sub) => [el('h1.bs-title', {}, text), sub ? el('p.bs-sub', {}, sub) : null];
  const tile = (label, icon, onclick, { hint, disabled = false, primary = false } = {}) => el(`button.bs-tile${primary ? '.is-primary' : ''}`, { type: 'button', disabled, onclick },
    el('span.bs-tile-icon', {}, commandIconEl(icon, 32)), el('span.bs-tile-label', {}, label), hint ? el('span.bs-tile-hint', {}, hint) : null);
  const act = fn => () => { close({ focus: false }); fn(); };

  /* ---- New ---- */
  function newPage(request) {
    const mine = el('div.bs-tiles');
    const mineSection = el('section.bs-section', { hidden: true }, el('h2', {}, 'My templates'), mine);
    if (!local && api.customTemplates) api.customTemplates().then(list => {
      if (!stillShowing(request) || !list?.length) return;
      mine.replaceChildren(...list.map(t => tile(t.name, 'template', act(() => api.newFromTemplate(t.id)))));
      mineSection.hidden = false;
    }).catch(() => {});
    return [...heading('New', 'Start from a blank page or a template.'),
      el('section.bs-section', {}, el('div.bs-tiles', {},
        tile('Blank document', 'blankPage', act(() => api.newDocument()), { primary: true }),
        ...(api.newFromTemplate ? TEMPLATES.map(t => tile(t.name, 'template', act(() => api.newFromTemplate(t.id)), { hint: t.description })) : []))),
      mineSection];
  }

  /* ---- Open ---- */
  function openPage(request) {
    const list = el('div.bs-list', { role: 'list' }, el('p.bs-muted', {}, 'Loading recent documents…'));
    if (api.recentDocuments) api.recentDocuments().then(docs => {
      if (!stillShowing(request)) return;
      list.replaceChildren(...(docs.length ? docs.map(doc => listItem(el('button.bs-row', { type: 'button', onclick: act(() => api.openPath(doc.path)) },
        commandIconEl('filePlus', 20), el('span.bs-row-main', {}, el('strong', {}, doc.name), el('span', {}, doc.when || ''))))) : [el('p.bs-muted', {}, 'No other documents yet.')]));
    }).catch(() => { if (stillShowing(request)) list.replaceChildren(el('p.bs-muted', {}, 'Could not load recent documents.')); });
    return [...heading('Open'),
      el('section.bs-section', {}, el('div.bs-tiles', {},
        tile('Browse this device…', 'folderOpen', act(() => api.openDocument()), { hint: '.docx, .hwp, Markdown, HTML or text', primary: true }),
        api.openFromCloud ? tile('Browse Puter…', 'folderOpen', act(() => api.openFromCloud()), { hint: 'Any document in your Puter files' }) : null,
        api.goHome ? tile('All documents', 'home', act(() => api.goHome()), { hint: local ? 'The documents screen' : 'Your documents on Puter' }) : null)),
      api.recentDocuments ? el('section.bs-section', {}, el('h2', {}, 'Recent'), list) : null];
  }

  /* ---- Info ---- */
  function infoPage(request) {
    const props = api.properties?.() || {};
    const readOnly = !!api.readOnly?.();
    const field = (key, label, { multiline = false } = {}) => {
      const input = multiline ? el('textarea.input', { rows: 3, name: key, 'aria-label': label }, props[key] || '') : el('input.input', { name: key, value: props[key] || '', 'aria-label': label });
      input.readOnly = readOnly;
      return el('label.bs-field', {}, el('span.field-label', {}, label), input);
    };
    const saved = el('span.bs-muted', { role: 'status' });
    const form = el('form.bs-props', { onsubmit: e => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(form).entries());
      try {
        const changed = api.setProperties?.(data);
        saved.textContent = changed ? 'Properties updated. They are saved with the document.' : 'No changes.';
      } catch (error) { saved.textContent = error?.message || String(error); }
    } },
    field('title', 'Title'), field('subject', 'Subject'), field('creator', 'Author'), field('keywords', 'Keywords'),
    field('category', 'Category'), field('contentStatus', 'Status'), field('description', 'Comments', { multiline: true }),
    el('div.bs-actions', {}, el('button.btn.btn-primary', { type: 'submit', disabled: readOnly || !api.setProperties }, 'Save Properties'), saved));
    // Typed properties are kept when the page is left without Save Properties, as a desktop File view keeps them.
    if (!readOnly && api.setProperties) leavePage = () => {
      const data = Object.fromEntries(new FormData(form).entries());
      if (Object.entries(data).some(([key, value]) => value !== (props[key] || ''))) api.setProperties(data);
    };
    const dates = el('dl.bs-facts', {},
      ...fact('Created', props.created ? new Date(props.created).toLocaleString() : '—'),
      ...fact('Last modified', props.modified ? new Date(props.modified).toLocaleString() : '—'),
      ...fact('Last modified by', props.lastModifiedBy || '—'),
      ...fact('Location', api.location?.() || (local ? 'This device' : 'Puter')),
      ...fact('Size', api.size?.() ? formatBytes(api.size()) : '—'));
    const stats = api.statistics?.();
    const statsList = stats ? el('dl.bs-facts', {}, ...fact('Pages', stats.pages), ...fact('Words', stats.words), ...fact('Characters (no spaces)', stats.noSpaces),
      ...fact('Characters (with spaces)', stats.characters), ...fact('Paragraphs', stats.paragraphs)) : null;
    const versions = el('div.bs-list', { role: 'list' });
    const versionsSection = api.versions && api.versionsAvailable?.() !== false ? el('section.bs-section.bs-card', { id: 'bs-versions' }, el('h2', {}, 'Version history'),
      el('p.bs-muted', {}, 'Earlier versions are kept as you work. Restoring one keeps the current version too.'),
      el('div.bs-actions', {}, el('button.btn.btn-outline', { type: 'button', onclick: async e => {
        e.target.disabled = true;
        try { await api.saveVersionNow(); } finally { e.target.disabled = false; }
        loadVersions(request);
      } }, 'Save a Version Now'),
      api.openVersionHistory ? el('button.btn.btn-ghost', { type: 'button', onclick: act(() => api.openVersionHistory()) }, 'Open Version History') : null), versions) : null;
    const loadVersions = req => {
      versions.replaceChildren(el('p.bs-muted', {}, 'Loading versions…'));
      api.versions().then(list => {
        if (!stillShowing(req)) return;
        versions.replaceChildren(...(list.length ? list.map(v => el('div.bs-row', { role: 'listitem' },
          commandIconEl('history', 20), el('span.bs-row-main', {}, el('strong', {}, new Date(v.time).toLocaleString()), el('span', {}, relativeTime(v.time))),
          el('button.btn.btn-sm.btn-outline', { type: 'button', disabled: readOnly, onclick: () => api.restoreVersion(v) }, 'Restore'))) : [el('p.bs-muted', {}, 'No earlier versions yet.')]));
      }).catch(() => { if (stillShowing(req)) versions.replaceChildren(el('p.bs-muted', {}, 'Could not load the version history.')); });
    };
    if (versionsSection) loadVersions(request);
    return [...heading('Info', api.title?.()),
      el('div.bs-columns', {},
        el('section.bs-section.bs-card', {}, el('h2', {}, 'Properties'), form),
        el('div.bs-stack', {},
          el('section.bs-section.bs-card', {}, el('h2', {}, 'About this file'), dates),
          statsList ? el('section.bs-section.bs-card', {}, el('h2', {}, 'Statistics'), statsList) : null,
          api.setEditingMode ? el('section.bs-section.bs-card', {}, el('h2', {}, 'Protect'), el('p.bs-muted', {}, 'Switch to Viewing to read without changing anything by accident.'),
            el('div.bs-actions', {}, el('button.btn.btn-outline', { type: 'button', disabled: readOnly, onclick: act(() => api.setEditingMode('viewing')) }, 'View Only'))) : null,
          versionsSection))];
  }
  const fact = (label, value) => [el('dt', {}, label), el('dd', {}, typeof value === 'number' ? value.toLocaleString() : String(value))];

  /* ---- Save ---- */
  function savePage() {
    if (local) return [...heading('Download', 'This document lives on this device. Download it to keep your changes.'),
      el('section.bs-section', {}, el('div.bs-tiles', {},
        tile('Download .docx', 'download', act(() => api.download()), { primary: true }),
        api.savePdf ? tile('Download PDF', 'pdf', act(() => api.savePdf())) : null))];
    // The copy's name starts as one no file in the folder has, so Save As works at the first press.
    const name = el('input.input', { value: api.title?.() || '', 'aria-label': 'New file name', maxLength: 120 });
    if (api.copyName) {
      // Not under the user's hands: a name they are typing, or a field they have gone to, stays as it is.
      let touched = false;
      for (const type of ['input', 'focus']) name.addEventListener(type, () => { touched = true; }, { once: true });
      Promise.resolve().then(() => api.copyName()).then(free => { if (free && !touched) name.value = free; }).catch(() => { /* keep the title */ });
    }
    const message = el('p.bs-muted', { role: 'status' });
    const submit = el('button.btn.btn-primary', { type: 'submit' }, 'Save As');
    const saveAs = el('form.bs-inline-form', { onsubmit: async e => {
      e.preventDefault();
      // A second press (or Enter) while the copy is written would only report that its name is now taken.
      if (submit.disabled) return;
      submit.disabled = true;
      message.textContent = 'Saving a copy…';
      try {
        const failure = await api.saveAs(name.value);
        message.textContent = failure || 'Saved. You are now editing the copy.';
        if (!failure) { api.refreshTitle?.(); }
      } finally { submit.disabled = false; }
    } }, el('label.bs-field', {}, el('span.field-label', {}, 'Save a copy as'), name), submit);
    // Inside the Puter desktop the copy goes where Puter's Save dialog puts it, under the name chosen there.
    const copy = el('button.btn.btn-primary', { type: 'button', onclick: async () => {
      // A second press while the dialog comes up would only ask again.
      if (copy.disabled) return;
      copy.disabled = true;
      message.textContent = '';
      try {
        const failure = await api.saveCopyWhere();
        // A cancelled dialog has nothing to report.
        message.textContent = failure === '' ? '' : failure || 'Saved. You are now editing the copy.';
        if (failure === null) api.refreshTitle?.();
      } finally { copy.disabled = false; }
    } }, 'Save a Copy…');
    const copyWhere = el('div', {}, el('p.bs-muted', {}, 'Choose where on Puter to keep a copy. You then edit the copy, and the original stays as it is.'), el('div.bs-actions', {}, copy));
    return [...heading('Save', api.saveStatus?.()),
      el('section.bs-section', {}, el('div.bs-tiles', {},
        tile('Save now', 'save', act(() => api.save()), { primary: true, hint: `${MOD_KEY}+S` }),
        api.download ? tile('Download a copy', 'download', act(() => api.download()), { hint: '.docx file' }) : null,
        api.saveTemplate ? tile('Save as template', 'template', act(() => api.saveTemplate()), { disabled: !!api.readOnly?.() }) : null,
        api.rename ? tile('Rename', 'rename', act(() => api.rename())) : null)),
      api.saveCopyWhere || api.saveAs ? el('section.bs-section.bs-card', {}, el('h2', {}, 'Save As'), api.saveCopyWhere ? copyWhere : saveAs, message) : null];
  }

  /* ---- Print ---- */
  function printPage() {
    const total = api.pageCount?.() || 1, currentPage = api.currentPage?.() || 1;
    const copies = el('input.input', { type: 'number', min: 1, max: 99, value: 1, 'aria-label': 'Copies' });
    const range = el('select.input', { 'aria-label': 'Pages' }, el('option', { value: 'all' }, `All pages (${total})`), el('option', { value: 'current' }, `Current page (${currentPage})`), el('option', { value: 'custom' }, 'Custom range'));
    const custom = el('input.input', { placeholder: 'e.g. 1-3, 5', 'aria-label': 'Page range', hidden: true });
    const error = el('p.field-error', { role: 'alert', hidden: true });
    const previews = el('div.bs-print-pages', { 'aria-label': 'Print preview' });
    const pages = () => {
      if (range.value === 'current') return [currentPage];
      if (range.value === 'custom') return parsePageRange(custom.value, total);
      return Array.from({ length: total }, (_, i) => i + 1);
    };
    const mark = () => {
      const chosen = new Set(pages() || []);
      for (const [i, node] of [...previews.children].entries()) node.classList.toggle('is-excluded', !chosen.has(i + 1));
    };
    range.addEventListener('change', () => { custom.hidden = range.value !== 'custom'; error.hidden = true; mark(); if (!custom.hidden) custom.focus(); });
    custom.addEventListener('input', () => { error.hidden = true; mark(); });
    const form = el('form.bs-print-form', { onsubmit: e => {
      e.preventDefault();
      const list = pages();
      if (!list?.length) { error.textContent = `Enter pages between 1 and ${total}, such as 1-3, 5.`; error.hidden = false; custom.focus(); return; }
      const n = Math.max(1, Math.min(99, Math.round(Number(copies.value) || 1)));
      close({ focus: false });
      api.print({ pages: list, copies: n });
    } },
    el('button.btn.btn-primary.bs-print-button', { type: 'submit' }, commandIconEl('print', 20), 'Print'),
    el('label.bs-field', {}, el('span.field-label', {}, 'Copies'), copies),
    el('label.bs-field', {}, el('span.field-label', {}, 'Pages'), range), custom, error,
    api.pageSetup ? el('button.btn.btn-ghost', { type: 'button', onclick: act(() => api.pageSetup()) }, 'Page Setup…') : null,
    el('p.bs-muted', {}, 'Your browser’s print dialog opens next: choose a printer there, or Save as PDF.'));
    // Thumbnails render after the page shows, so opening Print stays quick.
    requestAnimationFrame(() => api.previewPages?.(previews, 24).then?.(mark));
    return [...heading('Print'), el('div.bs-print', {}, form, previews)];
  }

  /* ---- Share ---- */
  function sharePage(request) {
    const status = el('div.bs-share-status', {}, el('p.bs-muted', {}, 'Checking…'));
    const render = site => {
      if (!stillShowing(request)) return;
      const url = site?.url;
      status.replaceChildren(
        url ? el('p', {}, 'Published at ', el('a', { href: url, target: '_blank', rel: 'noopener' }, url)) : el('p.bs-muted', {}, 'Publish a read-only web page of this document. Anyone with the link can read it.'),
        el('div.bs-actions', {},
          el('button.btn.btn-primary', { type: 'button', onclick: async e => { e.target.disabled = true; status.querySelector('.bs-share-note')?.remove(); try { render(await api.publish()); } catch (err) { status.append(el('p.field-error.bs-share-note', {}, err?.message || String(err))); e.target.disabled = false; } } }, url ? 'Update Page' : 'Publish to the Web'),
          url ? el('button.btn.btn-outline', { type: 'button', onclick: () => { navigator.clipboard?.writeText(url); status.querySelector('.bs-share-note')?.remove(); status.append(el('p.bs-muted.bs-share-note', { role: 'status' }, 'Link copied.')); } }, 'Copy Link') : null,
          url ? el('button.btn.btn-ghost', { type: 'button', onclick: async () => { try { await api.unpublish(site); render(null); } catch (err) { status.append(el('p.field-error', {}, err?.message || String(err))); } } }, 'Stop Publishing') : null));
    };
    if (api.findSite) api.findSite().then(render).catch(() => render(null)); else render(null);
    return [...heading('Share'),
      api.shareWithPeople ? el('section.bs-section.bs-card', {}, el('h2', {}, 'Share with people'),
        el('p.bs-muted', {}, 'Invite people to edit, comment on or view this document with you, at the same time.'),
        el('div.bs-actions', {}, el('button.btn.btn-primary', { type: 'button', onclick: act(() => api.shareWithPeople()) }, 'Share with People…'))) : null,
      api.publish ? el('section.bs-section.bs-card', {}, el('h2', {}, 'Publish to the web'), status) : null,
      el('section.bs-section', {}, el('h2', {}, 'Send a copy'), el('div.bs-tiles', {},
        tile('Word document', 'download', act(() => api.download()), { hint: '.docx' }),
        api.savePdf ? tile('PDF', 'pdf', act(() => api.savePdf()), { hint: '.pdf' }) : null))];
  }

  /* ---- Export ---- */
  function exportPage() {
    return [...heading('Export', 'Download a copy of this document in another format to this device.'),
      el('section.bs-section', {}, el('div.bs-tiles', {},
        tile('Word document', 'download', act(() => api.download()), { hint: '.docx — keeps everything', primary: true }),
        api.savePdf ? tile('PDF', 'pdf', act(() => api.savePdf()), { hint: '.pdf — fixed pages, searchable text' }) : null,
        api.exportAs ? tile('Web page', 'webLayout', act(() => api.exportAs('html')), { hint: '.html — text, headings, lists, tables, links' }) : null,
        api.exportAs ? tile('Markdown', 'outlineView', act(() => api.exportAs('markdown')), { hint: '.md — plain-text formatting' }) : null,
        api.exportAs ? tile('Plain text', 'textMode', act(() => api.exportAs('text')), { hint: '.txt — words only' }) : null)),
      el('p.bs-muted', {}, 'Web page, Markdown and plain text keep the words and their structure; page layout, pictures, headers and footers stay in the .docx and PDF.')];
  }

  const builders = { new: newPage, open: openPage, info: infoPage, save: savePage, print: printPage, share: sharePage, export: exportPage };

  function open(id = 'info', { scrollTo } = {}) {
    if (root.hidden) { opener = document.activeElement; window.addEventListener('keydown', onEscape, true); across?.addEventListener?.('change', orient); orient(); root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); }
    root.hidden = false;
    document.body.classList.add('has-backstage');
    api.onOpen?.();
    show(id);
    if (scrollTo) requestAnimationFrame(() => panel.querySelector(`#${scrollTo}`)?.scrollIntoView({ block: 'start' }));
  }
  function close({ focus = true } = {}) {
    if (root.hidden) return;
    root.hidden = true; token++;
    leave();
    root.removeAttribute('role'); root.removeAttribute('aria-modal');
    window.removeEventListener('keydown', onEscape, true);
    across?.removeEventListener?.('change', orient);
    panel.replaceChildren();
    document.body.classList.remove('has-backstage');
    api.onClose?.();
    if (focus) { if (opener?.isConnected && opener !== document.body && !opener.closest('.backstage')) opener.focus(); else api.focusEditor?.(); }
  }
  return { el: root, open, close, get isOpen() { return !root.hidden; }, get current() { return current; } };
}

/** Pages from "1-3, 5" within 1..total, in order and without repeats; null when the text is not a range. */
export function parsePageRange(text, total) {
  const out = new Set();
  const parts = String(text || '').split(/[,;]/).map(s => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  for (const part of parts) {
    const m = /^(\d+)\s*(?:[-–]\s*(\d+))?$/.exec(part);
    if (!m) return null;
    const a = Number(m[1]), b = m[2] ? Number(m[2]) : a;
    if (a < 1 || b < a || b > total) return null;
    for (let i = a; i <= b; i++) out.add(i);
  }
  return [...out].sort((x, y) => x - y);
}

export { documentStatistics };
