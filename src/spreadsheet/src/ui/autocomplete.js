/**
 * Formula hints while editing: a list of matching function names as one is
 * typed, and a signature line with the current argument marked once the
 * caret is inside a call. Attached to the grid's cell editor; keyboard
 * handling is offered first crack at Arrow/Tab/Enter/Escape.
 */

import { isComposing, el, fieldId } from './dom.js';
import { quoteSheet } from '../core/refs.js';
import { completionContext, matchFunctions, matchColumns, signatureFor } from '../core/formula/hints.js';

/**
 * extraNames(sheetName?) → names visible on that sheet, or the edited sheet
 * extraTables → table names (accepting one inserts "Name[")
 * extraSheets → the other sheets' names (accepting one inserts "Name!" or "'My sheet'!")
 * columnsFor(tableName | null) → the columns of a table (null: the table the edited cell sits in)
 */
export function createFormulaHints({ host, onAccept, extraNames = () => [], extraTables = () => [], extraSheets = () => [], columnsFor = () => [] }) {
  const root = el('div.fx-hints', { id: fieldId('fx-hints'), hidden: true, role: 'listbox', 'aria-label': 'Formula suggestions' });
  host.append(root);
  let items = [];
  let selected = 0;
  let ctx = null;
  let mode = null; // 'list' | 'signature'
  let sourceText = '';
  let activeInput = null;

  function unlinkInput() {
    for (const name of ['aria-controls', 'aria-activedescendant', 'aria-autocomplete', 'aria-describedby']) activeInput?.removeAttribute(name);
    activeInput = null;
  }

  function linkInput() {
    if (!activeInput) return;
    activeInput.setAttribute('aria-controls', root.id);
    if (mode === 'list') {
      activeInput.setAttribute('aria-autocomplete', 'list');
      activeInput.setAttribute('aria-activedescendant', `${root.id}-${selected}`);
      activeInput.removeAttribute('aria-describedby');
    } else {
      activeInput.removeAttribute('aria-autocomplete');
      activeInput.removeAttribute('aria-activedescendant');
      activeInput.setAttribute('aria-describedby', root.id);
    }
  }

  function close() {
    unlinkInput();
    root.hidden = true;
    root.replaceChildren();
    items = [];
    mode = null;
    ctx = null;
  }

  function position(rect) {
    const hostRect = host.getBoundingClientRect();
    root.style.left = `${Math.max(0, rect.left - hostRect.left)}px`;
    const height = hostRect.height;
    root.style.maxHeight = height ? `${Math.max(0, height - 16)}px` : '';
    root.style.overflowY = 'auto';
    let top = rect.bottom - hostRect.top + 2;
    const popupHeight = Math.min(root.offsetHeight, height ? Math.max(0, height - 16) : Infinity);
    if (height && top + popupHeight > height - 8) top = rect.top - hostRect.top - popupHeight - 2;
    if (height) top = Math.max(8, Math.min(top, height - popupHeight - 8));
    root.style.top = `${top}px`;
    // Keep it inside the host.
    const w = root.offsetWidth;
    if (rect.left - hostRect.left + w > hostRect.width - 8) root.style.left = `${Math.max(0, hostRect.width - w - 8)}px`;
  }

  function renderList() {
    root.setAttribute('role', 'listbox');
    const named = new Set(extraNames(ctx?.sheet));
    const tables = new Set(extraTables());
    const sheets = new Set(extraSheets());
    root.replaceChildren(...items.map((name, i) => {
      const isName = named.has(name);
      const sig = ctx?.kind === 'column' ? { description: name.startsWith('#') ? 'Rows of the table' : `Column of ${ctx.table || 'this table'}` }
        : isName ? { description: 'Named range' } : tables.has(name) ? { description: 'Table' } : sheets.has(name) ? { description: 'Sheet' } : signatureFor(name);
      return el('div.fx-item', {
        id: `${root.id}-${i}`, role: 'option', 'aria-selected': String(i === selected), className: `fx-item${i === selected ? ' selected' : ''}`,
        onpointerdown: (e) => { e.preventDefault(); accept(i); },
      },
        el('span.fx-name', {}, name),
        sig.description && el('span.fx-desc', {}, sig.description));
    }));
    linkInput();
    const option = root.children[selected];
    if (option && root.clientHeight) {
      if (option.offsetTop < root.scrollTop) root.scrollTop = option.offsetTop;
      else if (option.offsetTop + option.offsetHeight > root.scrollTop + root.clientHeight) root.scrollTop = option.offsetTop + option.offsetHeight - root.clientHeight;
    }
  }

  /** A signature's parameters: split at the commas between them, not at those inside one's own () or [] (lambda(accumulator, value), [name2, value2]). */
  function splitParams(params) {
    const out = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < params.length; i++) {
      const ch = params[i];
      if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth--;
      else if (ch === ',' && depth === 0) { out.push(params.slice(start, i).trim()); start = i + 1; }
    }
    out.push(params.slice(start).trim());
    return out;
  }

  function renderSignature() {
    root.setAttribute('role', 'tooltip');
    const sig = signatureFor(ctx.name);
    const parts = sig.params ? splitParams(sig.params) : [];
    const current = Math.min(ctx.argIndex, parts.length - 1);
    const spread = parts.length && parts[parts.length - 1] === '...';
    const nodes = [el('span.fx-name', {}, `${ctx.name}(`)];
    parts.forEach((p, i) => {
      const isCurrent = i === current || (spread && ctx.argIndex >= parts.length - 1 && i === parts.length - 1);
      nodes.push(el('span', { className: isCurrent ? 'fx-arg current' : 'fx-arg' }, p));
      if (i < parts.length - 1) nodes.push(', ');
    });
    nodes.push(')');
    root.replaceChildren(...[el('div.fx-signature', {}, ...nodes), sig.description && el('div.fx-desc', {}, sig.description)].filter(Boolean));
    linkInput();
  }

  /** Called on every edit; `rect` is the editor's bounding rect. */
  function update(text, caret, rect, input = null) {
    if (input !== activeInput) { unlinkInput(); activeInput = input; }
    sourceText = text;
    const previousItems = items;
    const previousContext = ctx;
    const previousMode = mode;
    const keepSelection = (next) => previousMode === 'list'
      && JSON.stringify(previousContext) === JSON.stringify(next)
      && items.length === previousItems.length && items.every((item, i) => item === previousItems[i]);
    const c = completionContext(text, caret);
    if (!c) { close(); return; }
    if (c.kind === 'column') {
      items = matchColumns(c.prefix, columnsFor(c.table));
      if (!items.length || (items.length === 1 && items[0].toLowerCase() === c.prefix.toLowerCase())) { close(); return; }
      ctx = c;
      mode = 'list';
      if (!keepSelection(c)) selected = 0;
      renderList();
      root.hidden = false;
      position(rect);
      return;
    }
    if (c.kind === 'name') {
      if (c.sheet) {
        items = [...new Set(extraNames(c.sheet))].filter((n) => n.toLowerCase().startsWith(c.prefix.toLowerCase())).sort().slice(0, 8);
        if (!items.length || (items.length === 1 && items[0].toLowerCase() === c.prefix.toLowerCase() && !/^[\w.]/.test(text.slice(caret)))) { close(); return; }
      } else items = matchFunctions(c.prefix, 8, [...new Set([...extraNames(), ...extraTables(), ...extraSheets()])]);
      if (!c.sheet && (!items.length || (items.length === 1 && items[0].toLowerCase() === c.prefix.toLowerCase()))) {
        // Fully typed: fall through to the signature if inside a call.
        const call = completionContext(`${text.slice(0, c.start)}${text.slice(caret)}`, c.start);
        if (call?.kind === 'call' && !call.sheet) { ctx = call; mode = 'signature'; renderSignature(); root.hidden = false; position(rect); return; }
        close();
        return;
      }
      ctx = c;
      mode = 'list';
      if (!keepSelection(c)) selected = 0;
      renderList();
    } else {
      if (c.sheet) { close(); return; }
      ctx = c;
      mode = 'signature';
      if (!signatureFor(c.name).description && !signatureFor(c.name).params) { close(); return; }
      renderSignature();
    }
    root.hidden = false;
    position(rect);
  }

  function accept(i = selected) {
    if (mode !== 'list' || !items[i]) return false;
    const name = items[i];
    const { start, prefix } = ctx;
    let end = start + prefix.length;
    if (ctx.kind === 'column') {
      // Table[Col]; a name with spaces or punctuation gets its own brackets: Table[[Unit Price]].
      const plain = /^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) || name.startsWith('#');
      const body = plain || ctx.wrapped ? name : `[${name}]`;
      // Replace the rest of an existing column and its closing bracket.
      while (end < sourceText.length && !/[\],]/.test(sourceText[end])) {
        if (sourceText[end] === "'" && end + 1 < sourceText.length) end++;
        end++;
      }
      if (sourceText[end] === ']') end++;
      close();
      onAccept({ start, end, text: `${body}]` });
      return true;
    }
    const isName = !!ctx.sheet || extraNames().includes(name);
    const isTable = extraTables().includes(name);
    const isSheet = !isName && !isTable && extraSheets().includes(name);
    end += /^[A-Za-z0-9_.]*/.exec(sourceText.slice(end))[0].length;
    const suffix = isName ? '' : isTable ? '[' : isSheet ? '!' : '(';
    const spaces = /^\s*/.exec(sourceText.slice(end))[0].length;
    if (suffix && sourceText[end + spaces] === suffix) end += spaces + 1;
    close();
    onAccept({ start, end, text: `${isSheet ? quoteSheet(name) : name}${suffix}` });
    return true;
  }

  /** Returns true when the key was consumed. */
  function handleKey(e) {
    if (isComposing(e) || root.hidden || mode !== 'list') return false;
    if (e.key !== 'Escape' && (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey)) return false;
    switch (e.key) {
      case 'ArrowDown': selected = (selected + 1) % items.length; renderList(); e.preventDefault(); return true;
      case 'ArrowUp': selected = (selected - 1 + items.length) % items.length; renderList(); e.preventDefault(); return true;
      case 'Tab': case 'Enter': {
        e.preventDefault();
        // A name typed out in full, though longer functions start the same way (Price beside PRICEDISC), is
        // taken as the name spells it and the key goes on to enter the formula, as it does for a name no
        // function shares: picking it again swallowed the Enter.
        const name = items[selected];
        const whole = ctx.kind === 'name' && (!!ctx.sheet || extraNames().includes(name)) && name.toLowerCase() === ctx.prefix.toLowerCase()
          && !/^[A-Za-z0-9_.]/.test(sourceText.slice(ctx.start + ctx.prefix.length));
        const accepted = accept();
        return accepted && !whole;
      }
      case 'Escape': e.preventDefault(); e.stopPropagation(); close(); return true;
      default: return false;
    }
  }

  return { update, close, handleKey, get isOpen() { return !root.hidden; }, el: root };
}
