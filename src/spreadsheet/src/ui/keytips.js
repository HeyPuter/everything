/**
 * Ribbon key tips: press and release Alt (or press F10) to show a letter on
 * each ribbon tab; type a tab's letter to open it and show letters on its
 * commands; type a command's letters to run it. Escape steps back a level,
 * and anything else (a click, another chord, focus leaving) dismisses them.
 * Every tip is worked out from the labels on screen by one rule (see
 * assignTips), so there is no table of keys to keep up.
 */
import { el, isComposing } from './dom.js';

const ALNUM = /^[A-Z0-9]$/;
const words = label => String(label).toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);

/**
 * Key tips for a row of labels, in their order. The rule: a label whose first letter (or digit) no other
 * label in the row starts with gets that one key. Labels that share a first letter each get two keys:
 * that letter, then the first of these not already taken in the group: the initials of the label's later
 * words, then the label's other letters in order, then 1-9. A label with no letter or digit gets no tip.
 * So no one-key tip ever begins a two-key one, and every tip can be typed.
 */
export function assignTips(names) {
  const firsts = names.map(name => words(name)[0]?.[0] || null);
  const count = new Map();
  for (const f of firsts) if (f) count.set(f, (count.get(f) || 0) + 1);
  const used = new Set();
  return names.map((name, i) => {
    const first = firsts[i];
    if (!first) return null;
    if (count.get(first) === 1) return first;
    const parts = words(name);
    const seconds = [...parts.slice(1).map(w => w[0]), ...parts.join('').slice(1), ...'123456789'];
    const tip = seconds.map(ch => first + ch).find(t => !used.has(t)) || null;
    if (tip) used.add(tip);
    return tip;
  });
}

/**
 * Attach key tips to an editor. `ribbon` is the ribbon element; `openFile()` opens the File menu;
 * `blocked()` is true while a dialog, a menu or a cell entry owns the keyboard.
 */
export function attachKeyTips({ ribbon, fileButton = () => null, openFile = () => {}, blocked = () => false, onExit = () => {} }) {
  let state = null; // { level: 'tabs' | 'commands', typed, tips: [{ tip, target, kind, name }] }
  let altAlone = false;
  const layer = el('div.keytips-layer', { 'aria-hidden': 'true' });
  document.body.append(layer);

  const activePanel = () => [...ribbon.querySelectorAll('.ribbon-panel')].find(p => !p.hidden);
  const commands = () => [...(activePanel()?.querySelectorAll('.tb-btn, .ribbon-control') || [])]
    .filter(b => !b.closest('[hidden]') && b.getClientRects().length && !b.disabled);

  function render() {
    layer.replaceChildren();
    if (!state) return;
    for (const tip of state.tips) {
      if (!tip.tip.startsWith(state.typed)) continue;
      const rect = tip.target.getBoundingClientRect();
      const badge = el('span.keytip', { dataset: { tip: tip.tip } }, tip.tip);
      const x = tip.kind === 'tab' || tip.target.classList.contains('ribbon-large') ? rect.left + rect.width / 2 : rect.left + 12;
      const y = tip.kind === 'tab' ? rect.bottom - 4 : tip.target.classList.contains('ribbon-large') ? rect.bottom - 8 : rect.bottom - 6;
      Object.assign(badge.style, { left: `${Math.round(x)}px`, top: `${Math.round(y)}px` });
      layer.append(badge);
    }
  }

  function showTabs() {
    const file = fileButton();
    // Every tab, shown or not, takes part, so a tab's tip stays the same as contextual tabs come and go.
    // A tab may carry a fixed tip of its own (data-keytip): it stands apart from the rule, so a contextual tab
    // that comes and goes never takes a letter, or a second key, from the tabs always there.
    const all = [...(file ? [{ target: file, kind: 'file', name: 'File' }] : []),
      ...[...ribbon.querySelectorAll('.ribbon-tab')].map(tab => ({ target: tab, kind: 'tab', name: tab.textContent, fixed: tab.dataset.keytip || null }))];
    const entries = all.filter(t => !t.fixed);
    const assigned = assignTips(entries.map(t => t.name));
    const tips = [...entries.map((t, i) => ({ ...t, tip: assigned[i] })), ...all.filter(t => t.fixed).map(t => ({ ...t, tip: t.fixed }))]
      .filter(t => t.tip && (t.kind === 'file' || !t.target.hidden));
    state = { level: 'tabs', typed: '', tips };
    ribbon.classList.add('keytips-on');
    render();
  }

  function showCommands(tabName) {
    const list = commands();
    const names = list.map(b => b.getAttribute('aria-label') || b.textContent.trim());
    const tips = assignTips(names);
    state = { level: 'commands', tab: tabName, typed: '', tips: list.map((target, i) => ({ tip: tips[i], target, kind: 'command', name: names[i] })).filter(t => t.tip) };
    render();
  }

  function exit({ focusGrid = true } = {}) {
    if (!state) return;
    state = null;
    ribbon.classList.remove('keytips-on');
    render();
    if (focusGrid) onExit();
  }

  function activate(tip) {
    if (tip.kind === 'file') { exit({ focusGrid: false }); openFile(); return; }
    if (tip.kind === 'tab') {
      tip.target.click();
      // The tab's panel lays out before its commands can be measured for their tips.
      requestAnimationFrame(() => { if (state) showCommands(tip.name); });
      state = { ...state, level: 'pending', typed: '', tips: [] };
      render();
      return;
    }
    const target = tip.target;
    const opensMenu = target.getAttribute('aria-haspopup') === 'menu';
    exit({ focusGrid: !opensMenu && !target.matches('input, select') });
    if (target.matches('input, select')) { target.focus(); return; }
    target.click();
  }

  function onKeyDown(e) {
    if (isComposing(e)) return;
    if (e.key === 'Alt') { altAlone = !e.repeat && !e.ctrlKey && !e.metaKey && !e.shiftKey; return; }
    altAlone = false;
    if (!state) {
      if (e.key === 'F10' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && !blocked()) { e.preventDefault(); showTabs(); }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      if (state.level === 'commands' && state.typed) { state.typed = ''; render(); }
      else if (state.level === 'commands') showTabs();
      else exit();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) { exit({ focusGrid: false }); return; }
    if (e.key === 'F10' || e.key === 'Tab') { e.preventDefault(); exit(); return; }
    const ch = e.key.length === 1 ? e.key.toUpperCase() : null;
    e.preventDefault(); e.stopPropagation();
    if (!ch || !ALNUM.test(ch)) return;
    const typed = state.typed + ch;
    const matches = state.tips.filter(t => t.tip.startsWith(typed));
    if (!matches.length) return; // an unknown key is ignored, as the tips stay up
    const exact = matches.find(t => t.tip === typed);
    if (exact && matches.length === 1) { activate(exact); return; }
    state.typed = typed;
    render();
  }

  function onKeyUp(e) {
    if (e.key !== 'Alt') return;
    const alone = altAlone;
    altAlone = false;
    if (!alone) return;
    if (state) { e.preventDefault(); exit(); return; }
    if (blocked()) return;
    e.preventDefault();
    showTabs();
  }

  const dismiss = () => exit({ focusGrid: false });
  const onPointer = () => { altAlone = false; dismiss(); };
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('keyup', onKeyUp, true);
  document.addEventListener('pointerdown', onPointer, true);
  window.addEventListener('blur', dismiss);
  window.addEventListener('resize', dismiss);

  return {
    get active() { return !!state; },
    get level() { return state?.level || null; },
    show: showTabs,
    exit,
    destroy() {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('keyup', onKeyUp, true);
      document.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('blur', dismiss);
      window.removeEventListener('resize', dismiss);
      layer.remove();
    },
  };
}
