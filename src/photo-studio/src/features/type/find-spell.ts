// Edit > Find and Replace Text… and Edit > Check Spelling…: non-modal
// dialogs that walk the document's text layers, select each match in the
// text (an editing session) and change it in place.
import type { Editor } from '../../editor';
import { escapeXML } from '../../model/assets';
import { allLayers, type Layer } from '../../model/document';
import { layerLock } from '../../model/locks';
import { plainText } from '../../imaging/text/model';
import { findMatches, replaceAll, type FindOptions } from '../../imaging/text/find';
import { englishChecker, matchCase, type Misspelling, type SpellChecker } from '../../imaging/text/spelling';
import { openWorkspace } from '../retouch/workspace';
import { commit, editLayers, insert, ordered, session, setSelection, startEdit } from './session';
import { editable, ppiOf } from './text-utils';
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
async function reveal(e: Editor, id: string, a: number, b: number) {
  if (session?.layerId !== id) {
    if (!e.tool.startsWith('type')) e.setTool('type');
    await startEdit(e, id, 'end');
  }
  if (session?.layerId === id) setSelection(e, a, b);
}
/** First hit after the current position, wrapping once through the layers. */
function search<T extends { start: number; end: number }>(e: Editor, all: boolean, hits: (text: string) => T[]): { layer: Layer; hit: T } | undefined {
  const layers = textLayers(e, all);
  const pos = position();
  for (const l of layers) {
    const hit = hits(textOf(e, l)).find((h) => l.id !== pos.id || h.start >= pos.at);
    if (hit) return { layer: l, hit };
  }
  // Wrapped around: the start of the layer the search began in.
  const first = layers.find((l) => l.id === pos.id);
  const hit = first && hits(textOf(e, first)).find((h) => h.start < pos.at);
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
  const next = async () => {
    read();
    if (!s.query) return status('Type the text to find.');
    const found = search(e, s.all, (t) => findMatches(t, s.query, opts()).map(([start, end]) => ({ start, end })));
    if (!found) {
      status(textLayers(e, s.all).length ? 'No matches.' : 'There are no text layers to search.');
      return;
    }
    await reveal(e, found.layer.id, found.hit.start, found.hit.end);
    ws.q<HTMLElement>('#fr-next').focus();
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
    if (session) await commit(e);
    const ids = textLayers(e, all)
      .filter((l) => findMatches(textOf(e, l), query, options).length)
      .map((l) => l.id);
    if (!ids.length) return status('No matches.');
    if (ids.some((id) => layerLock(e.doc.layers, id, 'all'))) return status(lockedMessage);
    let count = 0;
    await editLayers(e, 'Replace Text', (d) => {
      const r = replaceAll(d.content, query, replace, options);
      count += r.count;
      return { ...d, content: r.content };
    }, ids);
    status(`Changed ${count} occurrence${count === 1 ? '' : 's'} in ${ids.length} layer${ids.length === 1 ? '' : 's'}.`);
  });
  ws.q('#fr-done').addEventListener('click', ws.close);
  ws.dialog.addEventListener('keydown', (ev) => {
    ev.stopPropagation();
    if (ev.key === 'Enter') {
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
  const status = (t: string) => (ws.q('#sp-status').textContent = t);
  const buttons = [...ws.dialog.querySelectorAll<HTMLButtonElement>('.sp-footer button:not(#sp-done)')];
  const enable = (on: boolean) => buttons.forEach((b) => (b.disabled = !on));
  enable(false);
  let current: { layer: Layer; hit: Misspelling } | undefined;
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
  const next = async () => {
    const found = search(e, all(), (t) => spell.misspellings(t));
    current = found;
    if (!found) {
      ws.q('#sp-word').textContent = '—';
      ws.q('#sp-suggestions').innerHTML = '';
      enable(false);
      status(textLayers(e, all()).length ? 'Spell check complete.' : 'There are no text layers to check.');
      return;
    }
    enable(true);
    await reveal(e, found.layer.id, found.hit.start, found.hit.end);
    show(found.hit.word);
    ws.q<HTMLElement>('#sp-change-one').focus();
    status(`In “${found.layer.name}”.`);
  };
  // Skip past the current word without changing it.
  const skip = async () => {
    if (current && session?.layerId === current.layer.id) setSelection(e, current.hit.end, current.hit.end);
    await next();
  };
  ws.q('#sp-suggestions').addEventListener('click', (ev) => {
    const o = (ev.target as HTMLElement).closest<HTMLElement>('[data-word]');
    if (!o) return;
    for (const x of ws.dialog.querySelectorAll('.sp-option')) x.setAttribute('aria-selected', String(x === o));
    ws.q<HTMLInputElement>('#sp-change').value = o.dataset.word!;
  });
  ws.q('#sp-suggestions').addEventListener('dblclick', () => ws.q('#sp-change-one').click());
  ws.q('#sp-ignore').addEventListener('click', () => void skip());
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
    if (!current || session?.layerId !== current.layer.id) return void next();
    if (layerLock(e.doc.layers, current.layer.id, 'all')) return status(lockedMessage);
    setSelection(e, current.hit.start, current.hit.end);
    insert(e, ws.q<HTMLInputElement>('#sp-change').value, 'replace');
    void next();
  });
  ws.q('#sp-change-all').addEventListener('click', async () => {
    if (!current) return;
    const word = current.hit.word,
      to = ws.q<HTMLInputElement>('#sp-change').value;
    if (session) await commit(e);
    const ids = textLayers(e, all())
      .filter((l) => findMatches(textOf(e, l), word, { wholeWord: true }).length)
      .map((l) => l.id);
    if (ids.some((id) => layerLock(e.doc.layers, id, 'all'))) return status(lockedMessage);
    // Each occurrence keeps its own capitalization pattern.
    await editLayers(e, 'Change Spelling', (d) => {
      let content = d.content;
      for (const variant of new Set(findMatches(plainText(content), word, { wholeWord: true }).map(([a, b]) => plainText(content).slice(a, b))))
        content = replaceAll(content, variant, matchCase(variant, to), { caseSensitive: true, wholeWord: true }).content;
      return { ...d, content };
    }, ids);
    current = undefined;
    await next();
  });
  ws.q('#sp-done').addEventListener('click', ws.close);
  ws.dialog.addEventListener('keydown', (ev) => {
    ev.stopPropagation();
    if (ev.key === 'Escape') ws.close();
  });
  await next();
  await ws.closed;
}

