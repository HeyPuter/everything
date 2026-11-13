// Edit > Find and Replace Text… and Edit > Check Spelling…: non-modal
// dialogs that walk the document's text layers, select each match in the
// text (an editing session) and change it in place.
import type { Editor } from '../../editor';
import { escapeXML } from '../../model/assets';
import { allLayers, type Layer } from '../../model/document';
import { layerLock } from '../../model/locks';
import { plainText, type TextContent } from '../../imaging/text/model';
import { findMatches, replaceAll, type FindOptions } from '../../imaging/text/find';
import { englishChecker, matchCase, type Misspelling, type SpellChecker } from '../../imaging/text/spelling';
import { openWorkspace } from '../retouch/workspace';
import { activatePendingEdit, commit, editLayers, inputFocused, insert, ordered, session, setSelection, startEdit } from './session';
import { editable, ppiOf } from './text-utils';
import { SpellingSkips } from './spelling-skips';
import './find-spell.css';

/** Text layers to search, top of the stack first, starting at the current one. */
function textLayers(e: Editor, all: boolean): Layer[] {
  const list = allLayers(e.doc.layers).filter((l) => l.kind === 'text' && l.visible).reverse();
  const current = session?.layerId ?? e.layer?.id;
  if (!all) return list.filter((l) => l.id === current);
  const i = list.findIndex((l) => l.id === current);
  return i > 0 ? [...list.slice(i), ...list.slice(0, i)] : list;
}
function textOf(e: Editor, l: Layer): string {
  if (session?.layerId === l.id) return plainText(session.data.content);
  return plainText(editable(l, ppiOf(e)).textData.content);
}
/** Where the search continues: after the selection in the edited layer. */
function position(): { id?: string; at: number } {
  if (!session) return { at: 0 };
  return { id: session.layerId, at: ordered(session)[1] };
}
/** Show a range as the text selection (editing that layer). */
async function reveal(e: Editor, id: string, a: number, b: number, isCurrent: () => boolean) {
  if (!isCurrent()) return false;
  if (session?.layerId === id) {
    setSelection(e, a, b);
    return true;
  }
  if (!e.tool.startsWith('type')) e.setTool('type');
  const started = await startEdit(e, id, { anchor: a, focus: b }, isCurrent);
  // Early keyboard/IME input already used the selected match. Completion
  // must not select it again or take focus from the ongoing edit.
  return !!started && !started.startedEarly && isCurrent() && session?.layerId === id;
}
/** First hit after the current position, wrapping once through the layers. */
function search<T extends { start: number; end: number }>(e: Editor, all: boolean, hits: (text: string, layer: Layer) => T[]): { layer: Layer; hit: T } | undefined {
  const layers = textLayers(e, all);
  const pos = position();
  for (const l of layers) {
    const hit = hits(textOf(e, l), l).find((h) => l.id !== pos.id || h.start >= pos.at);
    if (hit) return { layer: l, hit };
  }
  // Wrapped around: the start of the layer the search began in.
  const first = layers.find((l) => l.id === pos.id);
  const hit = first && hits(textOf(e, first), first).find((h) => h.start < pos.at);
  return first && hit ? { layer: first, hit } : undefined;
}
const lockedMessage = 'Some text layers are locked; unlock them to change their text.';

// ----- Find and Replace -----
let findState = { query: '', replace: '', all: true, caseSensitive: false, wholeWord: false };
export async function findReplace(e: Editor) {
  document.querySelector<HTMLDialogElement>('dialog.fr-workspace')?.remove();
  const s = findState;
  const selected = session ? plainText(session.data.content).slice(...ordered(session)) : '';
  if (selected && !selected.includes('\n')) s.query = selected;
  const ws = openWorkspace(
    'Find and Replace Text',
    'cr-workspace fr-workspace',
    `<div class="cr-body">
  <label class="rw-field"><span>Find What</span><input id="fr-find" type="text" value="${escapeXML(s.query)}" autocomplete="off"></label>
  <label class="rw-field"><span>Change To</span><input id="fr-change" type="text" value="${escapeXML(s.replace)}" autocomplete="off"></label>
  <label class="rw-check"><input type="checkbox" id="fr-all" ${s.all ? 'checked' : ''}>Search All Layers</label>
  <label class="rw-check"><input type="checkbox" id="fr-case" ${s.caseSensitive ? 'checked' : ''}>Case Sensitive</label>
  <label class="rw-check"><input type="checkbox" id="fr-word" ${s.wholeWord ? 'checked' : ''}>Whole Word Only</label>
  <p class="cr-hint" id="fr-status" aria-live="polite"></p>
</div>
<footer class="rw-footer fr-footer"><button id="fr-done" type="button">Done</button><span class="rw-spacer"></span><button id="fr-change-all" type="button">Change All</button><button id="fr-change-one" type="button">Change</button><button id="fr-change-find" type="button">Change/Find</button><button id="fr-next" type="button" class="primary">Find Next</button></footer>`,
    { modal: false },
  );
  const q = (id: string) => ws.q<HTMLInputElement>(id);
  const opts = (): FindOptions => ({ caseSensitive: s.caseSensitive, wholeWord: s.wholeWord });
  const status = (t: string) => (ws.q('#fr-status').textContent = t);
  const read = () => {
    s.query = q('#fr-find').value;
    s.replace = q('#fr-change').value;
    s.all = q('#fr-all').checked;
    s.caseSensitive = q('#fr-case').checked;
    s.wholeWord = q('#fr-word').checked;
  };
  const selectionMatches = () => {
    if (!session) return false;
    const [a, b] = ordered(session);
    return findMatches(plainText(session.data.content), s.query, opts()).some(([x, y]) => x === a && y === b);
  };
  let searchRevision = 0;
  const next = async () => {
    const revision = ++searchRevision;
    const owner = e.session;
    const isCurrent = () => ws.dialog.isConnected && e.session === owner && revision === searchRevision;
    if (!isCurrent()) return;
    read();
    if (!s.query) return status('Type the text to find.');
    const found = search(e, s.all, (t) => findMatches(t, s.query, opts()).map(([start, end]) => ({ start, end })));
    if (!found) {
      status(textLayers(e, s.all).length ? 'No matches.' : 'There are no text layers to search.');
      return;
    }
    if (!(await reveal(e, found.layer.id, found.hit.start, found.hit.end, isCurrent)) || !isCurrent()) return;
    if (inputFocused()) ws.q<HTMLElement>('#fr-next').focus();
    status(`Found in “${found.layer.name}”.`);
  };
  const changeOne = () => {
    read();
    if (!selectionMatches()) return false;
    if (layerLock(e.doc.layers, session!.layerId, 'all')) {
      status(lockedMessage);
      return false;
    }
    insert(e, s.replace, 'replace');
    return true;
  };
  ws.q('#fr-next').addEventListener('click', () => void next());
  ws.q('#fr-change-one').addEventListener('click', () => {
    if (!changeOne()) status('Find a match first.');
  });
  ws.q('#fr-change-find').addEventListener('click', () => {
    changeOne();
    void next();
  });
  ws.q('#fr-change-all').addEventListener('click', async () => {
    read();
    // The non-modal dialog can change or close while fonts are prepared.
    // Every layer in this operation must use the settings from its click.
    const { query, replace, all } = s;
    const options = opts();
    if (!query) return status('Type the text to find.');
    if (session) await commit(e, { preserveFocus: ws.dialog.contains(document.activeElement) });
    const ids = textLayers(e, all)
      .filter((l) => findMatches(textOf(e, l), query, options).length)
      .map((l) => l.id);
    if (!ids.length) return status('No matches.');
    if (ids.some((id) => layerLock(e.doc.layers, id, 'all'))) return status(lockedMessage);
    const replacements = new Map<string, ReturnType<typeof replaceAll>>();
    await editLayers(e, 'Replace Text', (d, l) => {
      const r = replaceAll(d.content, query, replace, options);
      // A font wait can require another pass over newer text. Count only the
      // final replacement in each layer, not every preparation attempt.
      replacements.set(l.id, r);
      return { ...d, content: r.content };
    }, ids, undefined, { rebase: true, mapIndex: (id, index) => replacements.get(id)?.mapIndex(index) ?? index });
    const changed = [...replacements.values()].map((r) => r.count).filter((n) => n > 0);
    const count = changed.reduce((sum, n) => sum + n, 0);
    status(`Changed ${count} occurrence${count === 1 ? '' : 's'} in ${changed.length} layer${changed.length === 1 ? '' : 's'}.`);
  });
  ws.q('#fr-done').addEventListener('click', ws.close);
  ws.dialog.addEventListener('keydown', (ev) => {
    ev.stopPropagation();
    // Buttons keep their native Enter activation; fields use Find Next.
    if (ev.key === 'Enter' && !(ev.target as HTMLElement).closest('button')) {
      ev.preventDefault();
      void next();
    } else if (ev.key === 'Escape') ws.close();
  });
  q('#fr-find').focus();
  q('#fr-find').select();
  await ws.closed;
  read();
}

// ----- Check Spelling -----
const userWordsKey = 'photo-studio-user-dictionary';
function userWords(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(userWordsKey) ?? '[]');
    return Array.isArray(v) ? v.filter((w) => typeof w === 'string') : [];
  } catch {
    return [];
  }
}
let checkerReady: Promise<SpellChecker> | undefined;
function checker(): Promise<SpellChecker> {
  checkerReady ??= englishChecker(`${import.meta.env.BASE_URL}dictionaries/en-US.txt.gz`).then((c) => {
    for (const w of userWords()) c.add(w);
    return c;
  });
  checkerReady.catch(() => (checkerReady = undefined));
  return checkerReady;
}
export async function checkSpelling(e: Editor) {
  document.querySelector<HTMLDialogElement>('dialog.sp-workspace')?.remove();
  const ws = openWorkspace(
    'Check Spelling',
    'cr-workspace sp-workspace',
    `<div class="cr-body">
  <div class="rw-field"><span>Not in Dictionary</span><output id="sp-word" class="sp-word">—</output></div>
  <label class="rw-field"><span>Change To</span><input id="sp-change" type="text" autocomplete="off" spellcheck="false"></label>
  <div class="rw-field"><span>Suggestions</span><div id="sp-suggestions" class="sp-suggestions" role="listbox" aria-label="Suggestions" tabindex="0"></div></div>
  <label class="rw-check"><input type="checkbox" id="sp-all" checked>Check All Layers</label>
  <p class="cr-hint">Dictionary: English (USA)</p>
  <p class="cr-hint" id="sp-status" aria-live="polite">Loading the dictionary…</p>
</div>
<footer class="rw-footer sp-footer"><button id="sp-done" type="button">Done</button><span class="rw-spacer"></span><button id="sp-add" type="button" title="Add the word to your dictionary in this browser">Add</button><button id="sp-ignore-all" type="button">Ignore All</button><button id="sp-ignore" type="button">Ignore</button><button id="sp-change-all" type="button">Change All</button><button id="sp-change-one" type="button" class="primary">Change</button></footer>`,
    { modal: false },
  );
  ws.q('#sp-done').addEventListener('click', ws.close);
  ws.dialog.addEventListener('keydown', (ev) => {
    ev.stopPropagation();
    if (ev.key === 'Escape') ws.close();
  });
  const status = (t: string) => (ws.q('#sp-status').textContent = t);
  const buttons = [...ws.dialog.querySelectorAll<HTMLButtonElement>('.sp-footer button:not(#sp-done)')];
  const enable = (on: boolean) => buttons.forEach((b) => (b.disabled = !on));
  enable(false);
  const skipped = new SpellingSkips();
  type Match = { owner: Editor['session']; layer: Layer; hit: Misspelling };
  let current: Match | undefined;
  let spell: SpellChecker;
  try {
    spell = await checker();
  } catch (error) {
    status(error instanceof Error ? error.message : String(error));
    return;
  }
  const all = () => ws.q<HTMLInputElement>('#sp-all').checked;
  const show = (word: string) => {
    ws.q('#sp-word').textContent = word;
    const list = spell.suggest(word);
    const input = ws.q<HTMLInputElement>('#sp-change');
    input.value = list[0] ?? word;
    ws.q('#sp-suggestions').innerHTML = list.length
      ? list.map((w, i) => `<div role="option" class="sp-option" data-word="${escapeXML(w)}" aria-selected="${i === 0}">${escapeXML(w)}</div>`).join('')
      : '<span class="muted">No suggestions</span>';
  };
  // This dialog stays open while text and document tabs can change. Only
  // apply the displayed suggestion while its original word still exists.
  const currentMatch = () => {
    const match = current;
    if (!match || match.owner !== e.session) return;
    const layer = textLayers(e, true).find((l) => l.id === match.layer.id);
    if (!layer) return;
    const text = textOf(e, layer);
    if (spell.misspellings(text).some((hit) => hit.start === match.hit.start && hit.end === match.hit.end && hit.word === match.hit.word)) return { ...match, text };
  };
  let searchRevision = 0;
  const next = async () => {
    const revision = ++searchRevision;
    const owner = e.session;
    const isCurrent = () => ws.dialog.isConnected && e.session === owner && revision === searchRevision;
    if (!isCurrent()) return;
    const found = search(e, all(), (t, l) => skipped.filter(owner, l.id, t, spell.misspellings(t)));
    current = found && { ...found, owner };
    if (!found) {
      ws.q('#sp-word').textContent = '—';
      ws.q('#sp-suggestions').innerHTML = '';
      enable(false);
      status(textLayers(e, all()).length ? 'Spell check complete.' : 'There are no text layers to check.');
      return;
    }
    show(found.hit.word);
    status(`In “${found.layer.name}”.`);
    enable(true);
    if (!(await reveal(e, found.layer.id, found.hit.start, found.hit.end, isCurrent)) || !isCurrent()) return;
    if (inputFocused()) ws.q<HTMLElement>('#sp-change-one').focus();
  };
  // Skip past the current word without changing it.
  const skip = async () => {
    if (current && currentMatch() && session?.layerId === current.layer.id) setSelection(e, current.hit.end, current.hit.end);
    await next();
  };
  ws.q('#sp-suggestions').addEventListener('click', (ev) => {
    const o = (ev.target as HTMLElement).closest<HTMLElement>('[data-word]');
    if (!o) return;
    for (const x of ws.dialog.querySelectorAll('.sp-option')) x.setAttribute('aria-selected', String(x === o));
    ws.q<HTMLInputElement>('#sp-change').value = o.dataset.word!;
  });
  ws.q('#sp-suggestions').addEventListener('dblclick', () => ws.q('#sp-change-one').click());
  ws.q('#sp-ignore').addEventListener('click', () => {
    const match = currentMatch();
    if (match) skipped.ignore(match.owner, match.layer.id, match.text, match.hit);
    void skip();
  });
  ws.q('#sp-ignore-all').addEventListener('click', () => {
    if (current) spell.ignore(current.hit.word);
    void skip();
  });
  ws.q('#sp-add').addEventListener('click', () => {
    if (!current) return;
    spell.add(current.hit.word);
    try {
      localStorage.setItem(userWordsKey, JSON.stringify([...new Set([...userWords(), current.hit.word])]));
    } catch {
      /* Optional. */
    }
    void skip();
  });
  ws.q('#sp-change-one').addEventListener('click', () => {
    const match = currentMatch();
    if (!match) return void next();
    if (layerLock(e.doc.layers, match.layer.id, 'all')) return status(lockedMessage);
    if (session?.layerId !== match.layer.id) activatePendingEdit(e, match.layer.id);
    if (session?.layerId !== match.layer.id) return void next();
    const { owner, layer, hit, text: before } = match;
    setSelection(e, hit.start, hit.end);
    insert(e, ws.q<HTMLInputElement>('#sp-change').value, 'replace');
    if (skipped.has(owner, layer.id)) {
      const after = plainText(session.data.content), delta = after.length - before.length;
      skipped.remap(owner, layer.id, before, after, (at) => at <= hit.start ? at : at >= hit.end ? at + delta : hit.end + delta);
    }
    void next();
  });
  ws.q('#sp-change-all').addEventListener('click', async () => {
    if (!current || !currentMatch()) return void next();
    const owner = e.session;
    const word = current.hit.word,
      to = ws.q<HTMLInputElement>('#sp-change').value;
    const revision = ++searchRevision;
    if (session) await commit(e);
    const ids = textLayers(e, all())
      .filter((l) => findMatches(textOf(e, l), word, { wholeWord: true }).length)
      .map((l) => l.id);
    if (ids.some((id) => layerLock(e.doc.layers, id, 'all'))) return status(lockedMessage);
    // Each occurrence keeps its own capitalization pattern. Compose the
    // position maps in the same order as these replacements on the latest text.
    const mappings = new Map<string, (index: number) => number>();
    const corrections = new Map<string, { before: TextContent; after: TextContent }>();
    await editLayers(e, 'Change Spelling', (d, l) => {
      let content = d.content;
      const maps: ((index: number) => number)[] = [];
      for (const variant of new Set(findMatches(plainText(content), word, { wholeWord: true }).map(([a, b]) => plainText(content).slice(a, b)))) {
        const r = replaceAll(content, variant, matchCase(variant, to), { caseSensitive: true, wholeWord: true });
        content = r.content;
        maps.push(r.mapIndex);
      }
      mappings.set(l.id, (index) => maps.reduce((at, map) => map(at), index));
      corrections.set(l.id, { before: d.content, after: content });
      return { ...d, content };
    }, ids, undefined, { rebase: true, mapIndex: (id, index) => mappings.get(id)?.(index) ?? index });
    for (const [id, change] of corrections) {
      const match: Match | undefined = revision !== searchRevision && current?.owner === owner && current.layer.id === id ? current : undefined;
      if (!match && !skipped.has(owner, id)) continue;
      const before = plainText(change.before), after = plainText(change.after), mapIndex = mappings.get(id)!;
      skipped.remap(owner, id, before, after, mapIndex);
      // A newer result can remain selected while this correction shifts it.
      // Keep its offsets aligned without replacing its custom suggestion.
      if (match) {
        const { start, end, word } = match.hit;
        const a = mapIndex(start), b = mapIndex(end);
        if (before.slice(start, end) === word && after.slice(a, b) === word) current = { ...match, hit: { ...match.hit, start: a, end: b } };
      }
    }
    if (!ws.dialog.isConnected || e.session !== owner || revision !== searchRevision) return;
    current = undefined;
    await next();
  });
  await next();
  await ws.closed;
}

