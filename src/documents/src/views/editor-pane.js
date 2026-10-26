/**
 * The Editor pane: spelling (local dictionary), optional grammar and style suggestions from Puter's
 * AI (off until the reader turns it on, and marked as AI), and document statistics with readability
 * scores computed on this device. Corrections are ordinary edits, one undo step each.
 */
import { el, listItem, listboxKeys } from '../ui/dom.js';
import * as P from '../lib/puter.js';
import { engineApi } from '../lib/engine-api.js';
import { textStatistics, easeLabel } from '../lib/readability.js';
import { checkGrammar, SUGGESTION_KINDS } from '../lib/proofing-ai.js';
import { sidePane, section, button, hint, preference, reveal } from './review-ui.js';

const AI_ON = preference('documents:editor-ai', false);
const AI_KINDS = preference('documents:editor-ai-kinds', ['grammar', 'punctuation', 'clarity', 'conciseness']);

export function createEditorPane({ editor, pkg, proofing, error, onState = () => {} }) {
  let spellingIssues = [], current = null, aiSuggestions = [], aiBusy = null, ignoredSuggestions = new Set();
  const pane = sidePane({ title: 'Editor', label: 'Editor pane', className: 'rv-editor-pane', onOpen: () => { refreshAll(); }, onClose: () => { aiBusy?.abort(); onState(); editor()?.focus(); } });

  /* ---- Overview ---- */
  const score = el('div.rv-score', { role: 'status' });
  const scope = el('p.rv-scope');

  /* ---- Spelling ---- */
  const spellingList = el('div.rv-list', { role: 'list', 'aria-label': 'Spelling issues' });
  const detail = el('div.rv-detail', { hidden: true });
  const spelling = section('Spelling', spellingList, detail, el('div.rv-actions', {}, button('Check One by One (F7)', () => { pane.close({ quiet: true }); proofing.openPane(); })));

  function renderSpelling() {
    const groups = new Map();
    for (const m of spellingIssues) { if (!groups.has(m.word)) groups.set(m.word, []); groups.get(m.word).push(m); }
    spellingList.replaceChildren(...[...groups].map(([word, list]) => listItem(el('button.rv-item', { type: 'button', 'aria-current': String(current?.word === word), onclick: () => pick(list[0]) },
      el('span.rv-item-word.rv-misspelled', {}, word), el('span.rv-item-count', {}, list.length > 1 ? `×${list.length}` : '')))));
    if (!groups.size) spellingList.append(el('p.rv-empty', {}, 'No spelling issues found.'));
    if (current && !spellingIssues.some(m => m.start === current.start && m.word === current.word)) current = null;
    if (!current) detail.hidden = true;
  }
  function pick(m) {
    current = m;
    reveal(editor(), m.start, m.end);
    const options = proofing.suggest(m.word);
    const editable = !pkg()?.readOnly;
    const chooseItem = item => { for (const other of choice.children) other.setAttribute('aria-selected', String(other === item)); };
    const choice = el('div.rv-suggestions', { role: 'listbox', 'aria-label': `Suggestions for ${m.word}` }, ...(options.length ? options : []).map((option, i) => {
      const item = el('button.ed-proof-suggestion', { type: 'button', role: 'option', 'aria-selected': String(i === 0), dataset: { value: option }, disabled: !editable,
        onclick: () => chooseItem(item),
        ondblclick: () => apply(option) }, option);
      return item;
    }));
    // One Tab stop, on the chosen suggestion; the arrows move through the suggestions and choose as they go.
    listboxKeys(choice, chooseItem);
    const selected = () => choice.querySelector('[aria-selected="true"]')?.dataset.value;
    const apply = option => { proofing.change(m, option); current = null; later(); };
    detail.replaceChildren(
      el('p.rv-detail-title', {}, 'Not in the dictionary: ', el('strong', {}, m.word)),
      options.length ? choice : hint('No suggestions.'),
      el('div.rv-actions', {},
        button('Change', () => selected() && apply(selected()), { primary: true, disabled: !options.length || !editable }),
        button('Change All', () => { const option = selected(); if (option) { proofing.changeAll(m.word, option); current = null; later(); } }, { disabled: !options.length || !editable }),
        button('Ignore', () => { proofing.ignoreOnce(m); current = null; later(); }),
        button('Ignore All', () => { proofing.ignoreAll(m.word); current = null; later(); }),
        button('Add to Dictionary', () => { proofing.addToDictionary(m.word); current = null; later(); })));
    detail.hidden = false;
    renderSpelling();
    (choice.querySelector('[aria-selected="true"]') || detail.querySelector('button'))?.focus({ preventScroll: true });
  }

  /* ---- Grammar and refinements (AI, opt-in) ---- */
  const aiToggle = el('input', { type: 'checkbox', checked: AI_ON.get(), onchange: () => { AI_ON.set(aiToggle.checked); renderAi(); } });
  const kindBoxes = Object.entries(SUGGESTION_KINDS).filter(([k]) => k !== 'style').map(([kind, label]) => {
    const box = el('input', { type: 'checkbox', checked: AI_KINDS.get().includes(kind), onchange: () => AI_KINDS.set(kindBoxes.filter(b => b.input.checked).map(b => b.kind)) });
    return { kind, input: box, node: el('label.rv-check', {}, box, label) };
  });
  const aiStatus = el('p.rv-status', { role: 'status' });
  const aiList = el('div.rv-list', { role: 'list', 'aria-label': 'Grammar and style suggestions' });
  const aiRun = button('Check with AI', () => runAi(), { primary: true });
  const aiBody = el('div.rv-ai-body', {}, el('div.rv-checks', {}, ...kindBoxes.map(b => b.node)), el('div.rv-actions', {}, aiRun), aiStatus, aiList);
  const ai = section('Grammar and refinements', el('label.rv-check.rv-ai-toggle', {}, aiToggle, el('span', {}, 'Suggest with ', el('span.rv-ai-badge', { title: 'Uses Puter AI' }, 'AI'))),
    hint('When you run a check, the text being checked is sent to Puter AI. Nothing is sent until you choose Check with AI.'), aiBody);
  function renderAi() {
    aiBody.hidden = !aiToggle.checked;
    const available = P.canUseAi();
    aiRun.disabled = !available || !!aiBusy;
    if (!available) aiStatus.textContent = 'AI suggestions need Puter. Open this document in Puter to use them.';
    const visible = aiSuggestions.filter(s => !ignoredSuggestions.has(key(s)) && !(pkg()?.reviewSettings?.hideGrammaticalErrors));
    aiList.replaceChildren(...visible.map(s => el('div.rv-item.rv-ai-item', { role: 'listitem' },
      el('button.rv-ai-target', { type: 'button', onclick: () => reveal(editor(), s.start, s.end) }, el('span.rv-ai-kind', {}, SUGGESTION_KINDS[s.kind]), el('span.rv-ai-change', {}, el('del', {}, s.original), ' → ', el('ins', {}, s.suggestion))),
      s.reason ? el('p.rv-ai-reason', {}, s.reason) : null,
      el('div.rv-actions', {}, button('Accept', () => acceptSuggestion(s), { primary: true, disabled: !!pkg()?.readOnly }), button('Ignore', () => { ignoredSuggestions.add(key(s)); renderAi(); onState(); })))));
    editor()?.paint();
  }
  const key = s => `${s.start}:${s.original}:${s.suggestion}`;
  function acceptSuggestion(s) {
    const engine = editor(); if (!engine) return;
    // Suggestions are in the body's text: compare there, not with a header or footer being edited.
    if (engine.session.body.text.slice(s.start, s.end) !== s.original) { error(new Error('The text changed since it was checked. Check again.')); return; }
    engine.finishComposition();
    if (engine.session.path !== null) engine.editStory(null);
    const delta = s.suggestion.length - s.original.length;
    if (engine.execute(() => { engine.model.select(s.start, s.end); engine.model.replace(s.suggestion); })) {
      aiSuggestions = aiSuggestions.filter(x => x !== s).map(x => x.start >= s.end ? { ...x, start: x.start + delta, end: x.end + delta } : x);
      renderAi();
    }
  }
  async function runAi() {
    const engine = editor(); if (!engine || !P.canUseAi()) return;
    aiBusy?.abort(); aiBusy = new AbortController();
    const signal = aiBusy.signal, revision = engine.session.body.revision;
    const [a, b] = engine.session.path === null ? engine.model.range : [0, 0];
    const paragraphs = [];
    let at = 0;
    for (const p of engine.session.body.paragraphs) {
      const text = p.runs.map(r => r.text).join('');
      if (a === b || at + text.length >= a && at <= b) paragraphs.push({ text: text.replace(/￼/g, ' '), start: at });
      at += text.length + 1;
    }
    aiStatus.textContent = 'Checking…'; aiRun.disabled = true; aiList.replaceChildren();
    try {
      const kinds = kindBoxes.filter(k => k.input.checked).map(k => k.kind);
      const found = await checkGrammar(paragraphs, { chat: prompt => P.aiChat(prompt), kinds: kinds.length ? kinds : ['grammar'], signal });
      if (signal.aborted) return;
      if (editor()?.session.body.revision !== revision) { aiStatus.textContent = 'The document changed during the check. Check again.'; return; }
      // An object (a note reference, field or picture) was sent as a space. A suggestion that takes it in ("claim ."
      // → "claim.") could not be accepted, and would delete the object if it were: it is not offered.
      const body = editor()?.session.body.text || '';
      aiSuggestions = found.filter(s => body.slice(s.start, s.end) === s.original); ignoredSuggestions = new Set();
      aiStatus.textContent = aiSuggestions.length ? `${aiSuggestions.length} ${aiSuggestions.length === 1 ? 'suggestion' : 'suggestions'}` : 'No grammar or style suggestions.';
    } catch (e) { if (!signal.aborted) aiStatus.textContent = e.message; }
    finally { if (aiBusy?.signal === signal) aiBusy = null; renderAi(); onState(); }
  }

  /* ---- Statistics and readability ---- */
  const stats = el('dl.rv-stats');
  const readability = section('Statistics and readability', stats, hint('Computed on this device. Reading Ease runs from 0 (hard) to 100 (easy); the grade level estimates years of schooling needed.'));
  function renderStats() {
    const engine = editor(); if (!engine) return;
    const [a, b] = engine.model.range, selected = engine.session.path === null && a !== b;
    const text = selected ? engine.model.text.slice(a, b) : engine.session.body.text;
    const s = textStatistics(text);
    scope.textContent = selected ? 'Showing results for the selection.' : 'Showing results for the whole document.';
    const row = (label, value) => [el('dt', {}, label), el('dd', {}, value)];
    stats.replaceChildren(
      ...row('Words', s.words.toLocaleString()), ...row('Characters', s.characters.toLocaleString()), ...row('Paragraphs', s.paragraphs.toLocaleString()), ...row('Sentences', s.sentences.toLocaleString()),
      ...row('Sentences per paragraph', s.averages.sentencesPerParagraph), ...row('Words per sentence', s.averages.wordsPerSentence), ...row('Characters per word', s.averages.charactersPerWord),
      ...row('Reading Ease', `${s.readability.fleschReadingEase} · ${easeLabel(s.readability.fleschReadingEase)}`), ...row('Grade level', s.readability.fleschKincaidGrade), ...row('Passive sentences', `${s.readability.passivePercent}%`));
    const total = spellingIssues.length + aiSuggestions.filter(x => !ignoredSuggestions.has(key(x))).length;
    score.replaceChildren(el('strong', {}, total ? `${total} ${total === 1 ? 'suggestion' : 'suggestions'}` : 'No suggestions'), el('span', {}, ` · ${s.words.toLocaleString()} words`));
  }

  pane.body.append(score, scope, spelling, ai, readability);

  let pending = null, statsPending = null;
  // Checks run after a pause in typing; statistics follow the selection a moment later.
  function later() { clearTimeout(pending); pending = setTimeout(refreshAll, 400); }
  async function refreshAll() {
    if (!pane.isOpen) return;
    try { spellingIssues = proofing.enabled ? await proofing.issues() : []; } catch (e) { spellingIssues = []; error(e); }
    renderSpelling(); renderAi(); renderStats(); onState();
  }

  /** AI suggestions drawn as double blue underlines while the pane holds them. */
  function overlay(ctx, index) {
    const engine = editor();
    if (!engine || pkg()?.reviewSettings?.hideGrammaticalErrors || !aiSuggestions.length || engine.session.path !== null) return;
    ctx.save(); ctx.strokeStyle = '#2F6FD0'; ctx.lineWidth = 1;
    for (const s of aiSuggestions) {
      if (ignoredSuggestions.has(key(s))) continue;
      for (const r of engineApi().selectionRects(engine.layout, s.start, s.end)) {
        if (r.page !== index || r.width < 2) continue;
        const y = r.y + r.height - 2;
        ctx.beginPath(); ctx.moveTo(r.x, y + 0.5); ctx.lineTo(r.x + r.width, y + 0.5); ctx.moveTo(r.x, y - 1.5); ctx.lineTo(r.x + r.width, y - 1.5); ctx.stroke();
      }
    }
    ctx.restore();
  }

  return {
    pane, overlay,
    open() { pane.open(); },
    refresh() { if (pane.isOpen) later(); },
    selectionChanged() { if (pane.isOpen) { clearTimeout(statsPending); statsPending = setTimeout(renderStats, 150); } },
    /** Typing invalidates AI suggestion positions: drop the ones whose text changed. */
    changed() {
      const engine = editor(); if (!engine || !aiSuggestions.length) return;
      const text = engine.session.body.text;
      const kept = aiSuggestions.filter(s => text.slice(s.start, s.end) === s.original);
      if (kept.length !== aiSuggestions.length) { aiSuggestions = kept; renderAi(); }
    },
    get suggestionCount() { return aiSuggestions.filter(x => !ignoredSuggestions.has(key(x))).length; },
    destroy() { aiBusy?.abort(); clearTimeout(pending); clearTimeout(statsPending); pane.destroy(); },
  };
}
