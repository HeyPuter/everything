import { el, isComposing, IS_MAC, shortcutCode } from './dom.js';
import { openMenu } from './menu.js';
import { commandIconEl } from './ribbon.js';
import { iconEl } from './icons.js';
import { localStore } from '../lib/storage.js';

const MODE_STORE = 'documents:ribbon-mode';
export const RIBBON_MODES = ['always', 'tabs', 'auto'];
/** KeyTips for the standard tabs; contextual and module tabs get letters from their names. */
const TAB_KEYS = { home: 'H', insert: 'N', draw: 'JI', design: 'G', layout: 'P', references: 'S', mailings: 'M', review: 'R', view: 'W' };

export function recallRibbonMode(storage = localStore()) {
  try { const mode = storage?.getItem(MODE_STORE); return RIBBON_MODES.includes(mode) ? mode : 'always'; } catch { return 'always'; }
}

/**
 * Prefix-free KeyTip codes for labels: one letter each while letters last (preferring a letter of the
 * label, the initials first), then two letters behind a prefix no single code uses.
 */
export function assignKeyTips(labels, { taken = [] } = {}) {
  const used = new Set(taken);
  const letters = label => {
    const words = String(label).toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
    return [...new Set([...words.map(w => w[0]), ...words.join('').split('')])];
  };
  const codes = new Array(labels.length).fill(null);
  const singleBudget = labels.length <= 26 - used.size ? labels.length : Math.max(0, 26 - used.size - 4);
  let singles = 0;
  // Initials first, so most commands get the letter their name starts with; then any letter of the name.
  for (const pass of ['initials', 'letters']) labels.forEach((label, i) => {
    if (codes[i] || singles >= singleBudget) return;
    const words = String(label).toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
    const pool = pass === 'initials' ? words.map(w => w[0]) : letters(label);
    const pick = pool.find(ch => /[A-Z]/.test(ch) && !used.has(ch));
    if (pick) { codes[i] = pick; used.add(pick); singles++; }
  });
  labels.forEach((label, i) => {
    if (codes[i] || singles >= singleBudget) return;
    const free = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').find(ch => !used.has(ch));
    if (free) { codes[i] = free; used.add(free); singles++; }
  });
  // The rest share prefixes that no single code uses.
  const prefixes = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').filter(ch => !used.has(ch) && ![...used].some(code => code.startsWith(ch)));
  let p = 0, second = new Set();
  labels.forEach((label, i) => {
    if (codes[i] || !prefixes.length) return;
    let prefix = prefixes[p];
    let next = [...letters(label), ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890'].find(ch => !second.has(ch));
    if (!next) { p = (p + 1) % prefixes.length; prefix = prefixes[p]; second = new Set(); next = letters(label)[0] || 'A'; }
    second.add(next);
    codes[i] = prefix + next;
  });
  return codes;
}

/**
 * Ribbon display (always shown, tabs only, auto-hidden; collapse with a double-click on a tab, the
 * chevron or Cmd+Option+R / Ctrl+F1) and KeyTips: press and release Alt (Option on a Mac) to label the
 * tabs and commands with letters, then type them to go there.
 */
export function createRibbonModes({ workspace, header, toolbar, ribbon, tabs, titleBar, focusEditor }) {
  let mode = recallRibbonMode();
  let peeking = false;
  const tabRow = ribbon.tablist;
  const collapse = el('button.ed-ribbon-toggle', { type: 'button', onclick: () => {
    if (mode === 'always') setMode('tabs'); else { setMode('always'); }
    focusEditor();
  } }, iconEl('chevU', 14));
  collapse.addEventListener('mousedown', e => e.preventDefault());
  // Both are reachable from View > Ribbon and the chord; they stay out of the Tab order between the tabs and the commands.
  collapse.tabIndex = -1;
  const options = el('button.ed-ribbon-options', { type: 'button', 'aria-label': 'Ribbon display options', title: 'Ribbon display options', 'aria-haspopup': 'menu',
    onclick: e => openMenu({ anchor: options, label: 'Ribbon display options', align: 'end', minWidth: 240, pointer: !!e.detail, onClose: e.detail ? focusEditor : null, items: [
      { label: 'Always Show the Ribbon', radio: true, checked: mode === 'always', onSelect: () => setMode('always') },
      { label: 'Show Tabs Only', radio: true, checked: mode === 'tabs', onSelect: () => setMode('tabs') },
      { label: 'Auto-hide the Ribbon', radio: true, checked: mode === 'auto', onSelect: () => setMode('auto') },
      { separator: true }, { label: 'Show KeyTips', hint: IS_MAC ? 'Option' : 'Alt', onSelect: () => keyTips.show() }] }) }, commandIconEl('more', 16));
  options.addEventListener('mousedown', e => e.preventDefault());
  options.tabIndex = -1;
  // Both sit at the right end of the tab row, where they take no room from the commands.
  tabRow.append(options, collapse);
  const reveal = el('button.ed-ribbon-reveal', { type: 'button', 'aria-label': 'Show the ribbon', title: 'Show the ribbon', onclick: () => { peek(true); tabRow.querySelector('.ribbon-tab[aria-selected="true"]')?.focus(); } }, commandIconEl('more', 16));
  titleBar.querySelector('.canvas-title-actions')?.prepend(reveal);

  function apply() {
    workspace.classList.toggle('ribbon-tabs-only', mode === 'tabs');
    workspace.classList.toggle('ribbon-auto-hide', mode === 'auto');
    workspace.classList.toggle('ribbon-peek', peeking);
    // Shown over the document, the commands sit right under the tabs.
    toolbar.style.top = peeking ? `${header.offsetTop + header.offsetHeight}px` : '';
    const collapsed = mode !== 'always';
    collapse.setAttribute('aria-label', collapsed ? 'Always show the ribbon' : 'Collapse the ribbon');
    collapse.title = collapsed ? 'Always show the ribbon' : `Collapse the ribbon (${IS_MAC ? 'Cmd+Option+R' : 'Ctrl+F1'})`;
    collapse.replaceChildren(iconEl(collapsed ? 'chevD' : 'chevU', 14));
    collapse.classList.toggle('is-pin', collapsed);
    reveal.hidden = mode !== 'auto' || peeking;
    for (const tab of tabRow.querySelectorAll('.ribbon-tab')) tab.setAttribute('aria-expanded', String(!collapsed || peeking));
    if (!collapsed || peeking) requestAnimationFrame(() => ribbon.fit());
  }
  function setMode(next) {
    if (!RIBBON_MODES.includes(next)) return;
    mode = next; peeking = false;
    try { localStore()?.setItem(MODE_STORE, mode); } catch { /* storage unavailable */ }
    apply();
  }
  function peek(on) {
    if (mode === 'always') on = false;
    if (peeking === on) return;
    peeking = on;
    apply();
    if (on) document.addEventListener('pointerdown', outside, true); else document.removeEventListener('pointerdown', outside, true);
  }
  const owned = node => !!node?.closest?.('.menu, .modal-root, .popover, .ribbon-flyout, .ed-keytips');
  const outside = e => { if (!toolbar.contains(e.target) && !tabRow.contains(e.target) && !reveal.contains(e.target) && !owned(e.target)) peek(false); };
  // A tab click in a collapsed ribbon shows the commands over the document; clicking the open tab again hides them.
  tabRow.addEventListener('click', e => {
    const tab = e.target.closest('.ribbon-tab'); if (!tab || mode === 'always') return;
    const wasCurrent = tab.getAttribute('aria-selected') === 'true';
    if (peeking && wasCurrent && e.detail === 1 && tab.dataset.peekedAt && Date.now() - Number(tab.dataset.peekedAt) > 300) { peek(false); return; }
    tab.dataset.peekedAt = String(Date.now());
    peek(true);
  }, true);
  tabRow.addEventListener('dblclick', e => { if (!e.target.closest('.ribbon-tab')) return; setMode(mode === 'always' ? 'tabs' : 'always'); });
  tabRow.addEventListener('keydown', e => { if (mode !== 'always' && (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') && e.target.matches('.ribbon-tab')) peek(true); });
  // A command run from the shown commands puts them away (a menu or dialog it opens keeps them up until it closes).
  toolbar.addEventListener('click', e => {
    if (!peeking || e.target.closest('.ed-ribbon-toggle')) return;
    const button = e.target.closest('button');
    if (!button || button.getAttribute('aria-haspopup') || button.classList.contains('ribbon-collapsed')) return;
    setTimeout(() => { if (!toolbar.contains(document.activeElement) && !owned(document.activeElement)) peek(false); }, 0);
  });
  toolbar.addEventListener('keydown', e => { if (e.key === 'Escape' && peeking) { peek(false); } });
  toolbar.addEventListener('focusout', e => { if (peeking && e.relatedTarget && !toolbar.contains(e.relatedTarget) && !tabRow.contains(e.relatedTarget) && !owned(e.relatedTarget)) peek(false); });

  /* ---- KeyTips ---- */
  const keyTips = (() => {
    let layer = null, level = null, codes = [], typed = '';
    const visible = node => node && node.getClientRects().length && !node.closest('[hidden]');
    function badge(target, code, disabled) {
      const box = target.getBoundingClientRect();
      const tip = el('span.ed-keytip', { 'aria-hidden': 'true' }, code);
      if (disabled) tip.classList.add('is-disabled');
      tip.style.left = `${Math.round(box.left + box.width / 2)}px`;
      tip.style.top = `${Math.round(box.bottom - 6)}px`;
      return tip;
    }
    function render(targets) {
      layer?.remove();
      codes = targets;
      layer = el('div.ed-keytips', { role: 'status', 'aria-live': 'polite' }, el('span.visually-hidden', {}, 'KeyTips shown. Type a letter to choose, Escape to go back.'),
        ...targets.filter(t => visible(t.node)).map(t => badge(t.node, t.code, t.disabled)));
      document.body.append(layer);
    }
    function top() {
      level = 'top'; typed = '';
      if (mode !== 'always' && !peeking) { /* tabs stay reachable in a collapsed ribbon */ }
      const targets = [];
      const file = tabRow.querySelector('.ribbon-file');
      if (file) targets.push({ node: file, code: 'F', run: () => { hide(); file.click(); } });
      const shown = tabs.filter(t => { const b = document.getElementById(`ribbon-tab-${t.id}`); return b && !b.hidden; });
      const fixed = shown.map(t => TAB_KEYS[t.id] || null);
      const auto = assignKeyTips(shown.map((t, i) => fixed[i] ? '' : t.label), { taken: ['F', 'Q', '0', ...fixed.filter(Boolean)] });
      shown.forEach((t, i) => {
        const node = document.getElementById(`ribbon-tab-${t.id}`);
        const code = fixed[i] || (t.contextual ? `J${auto[i]?.[0] || 'X'}` : auto[i]);
        targets.push({ node, code, run: () => openTab(t.id) });
      });
      const quick = [...(titleBar.querySelectorAll('.ed-quick > button, .ed-quick > .ribbon-split > button:first-child'))].filter(visible);
      quick.slice(0, 9).forEach((node, i) => targets.push({ node, code: String(i + 1), disabled: node.disabled, run: () => { hide(); if (!node.disabled) node.click(); } }));
      const search = titleBar.querySelector('.ed-search-input');
      if (visible(search)) targets.push({ node: search, code: 'Q', run: () => { hide(); search.focus(); } });
      const menubar = titleBar.querySelector('.ed-menubar .menu-btn');
      const menus = visible(menubar) ? menubar : titleBar.querySelector('.ed-menus-button');
      if (visible(menus)) targets.push({ node: menus, code: '0', run: () => { hide(); menus.focus(); menus.click(); } });
      render(targets);
    }
    function openTab(id) {
      ribbon.select(id);
      if (mode !== 'always') peek(true);
      requestAnimationFrame(() => commands(id));
    }
    function commands(id) {
      level = 'tab'; typed = '';
      const panel = toolbar.querySelector(`#ribbon-panel-${id}`);
      const controls = panel ? [...panel.querySelectorAll('button, select, input')].filter(n => visible(n) && !n.closest('.ribbon-gallery') && !n.classList.contains('ribbon-split-arrow')) : [];
      const labels = controls.map(n => n.getAttribute('aria-label') || n.title || n.textContent || '');
      const assigned = assignKeyTips(labels);
      render(controls.map((node, i) => ({ node, code: assigned[i], disabled: node.disabled, run: () => {
        hide();
        if (node.disabled) return;
        if (node.matches('input, select')) node.focus(); else node.click();
      } })).filter(t => t.code));
    }
    function hide() {
      layer?.remove(); layer = null; level = null; typed = '';
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', hide);
      window.removeEventListener('resize', hide);
      document.removeEventListener('pointerdown', hide, true);
    }
    function onKey(e) {
      if (!level || isComposing(e)) return;
      if (['Alt', 'Shift', 'Control', 'Meta'].includes(e.key)) { if (e.key === 'Alt') { e.preventDefault(); } return; }
      e.preventDefault(); e.stopPropagation();
      if (e.key === 'Escape') { if (level === 'tab') top(); else { hide(); focusEditor(); } return; }
      const ch = /^Key([A-Z])$/.exec(shortcutCode(e))?.[1] || /^Digit([0-9])$/.exec(e.code)?.[1] || (e.key.length === 1 ? e.key.toUpperCase() : null);
      if (!ch) { hide(); return; }
      typed += ch;
      const exact = codes.find(t => t.code === typed);
      if (exact) { exact.run(); return; }
      if (!codes.some(t => t.code.startsWith(typed))) { typed = ''; return; }
      // Dim the badges that no longer match.
      for (const tip of layer?.querySelectorAll('.ed-keytip') || []) tip.classList.toggle('is-filtered', !tip.textContent.startsWith(typed));
    }
    function show() {
      if (document.querySelector('.modal-root:not(.closing), .backstage:not([hidden])')) return;
      top();
      window.addEventListener('keydown', onKey, true);
      window.addEventListener('blur', hide);
      window.addEventListener('resize', hide);
      document.addEventListener('pointerdown', hide, true);
    }
    return { show, hide, get active() { return !!level; } };
  })();

  // Alt (Option) pressed and released alone shows the KeyTips.
  let altDown = 0, altClean = false;
  const abort = new AbortController();
  window.addEventListener('keydown', e => {
    if (keyTips.active) return;
    if (e.key === 'Alt' && !e.repeat && !e.ctrlKey && !e.metaKey && !e.shiftKey) { altDown = Date.now(); altClean = true; return; }
    altClean = false;
    if (!IS_MAC && e.key === 'F10' && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.defaultPrevented) { e.preventDefault(); keyTips.show(); }
  }, { capture: true, signal: abort.signal });
  window.addEventListener('keyup', e => {
    if (e.key !== 'Alt') return;
    const clean = altClean && Date.now() - altDown < 900;
    altClean = false;
    if (!clean || keyTips.active || isComposing(e)) return;
    const target = document.activeElement;
    if (target && target.matches?.('input, textarea, select, [contenteditable="true"]') && !target.matches('.canvas-input')) return;
    if (!workspace.isConnected) return;
    e.preventDefault();
    keyTips.show();
  }, { capture: true, signal: abort.signal });
  window.addEventListener('pointerdown', () => { altClean = false; }, { capture: true, signal: abort.signal });

  apply();
  return {
    get mode() { return mode; },
    setMode,
    toggle() { setMode(mode === 'always' ? 'tabs' : 'always'); },
    peek, showKeyTips: () => keyTips.show(),
    beforeRun() { if (mode !== 'always') peek(true); },
    destroy() { abort.abort(); keyTips.hide(); document.removeEventListener('pointerdown', outside, true); },
  };
}
