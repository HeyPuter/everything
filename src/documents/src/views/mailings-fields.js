/**
 * Write & Insert Fields and Preview dialogs: Address Block, Greeting Line, Insert Merge Field,
 * Rules, Match Fields, Find Recipient, Check for Errors, prompts for Ask/Fill-in, and the
 * Finish & Merge options.
 *
 * Each dialog works through `mm`, the Mailings controller: mm.state(), mm.setState(patch),
 * mm.records(), mm.insertField(instruction), mm.goToRecord(n), mm.mapping().
 */
import { el } from '../ui/dom.js';
import { dialog, field, select, input, checkbox, radios, button } from './mailings-ui.js';
import {
  ADDRESS_FIELDS, NAME_FORMATS, GREETING_NAMES, SAMPLE_RECIPIENT, addressBlockInstruction, greetingInstruction,
  renderAddressBlock, renderGreetingLine, fieldName, quoteArgument, autoMatchFields,
} from '../engine/merge-fields.js';

/** A small record navigator for previews inside dialogs: ◀ n of N ▶, calling update(record|null). */
function previewNavigator(mm, update) {
  const records = mm.records();
  let at = Math.min(Math.max(0, (mm.state().activeRecord || 1) - 1), Math.max(0, records.length - 1));
  const label = el('span.mm-nav-label', { role: 'status' });
  const prev = button('◀', () => { at = Math.max(0, at - 1); sync(); }, 'btn-ghost', { 'aria-label': 'Previous recipient', title: 'Previous recipient' });
  const next = button('▶', () => { at = Math.min(records.length - 1, at + 1); sync(); }, 'btn-ghost', { 'aria-label': 'Next recipient', title: 'Next recipient' });
  function sync() {
    prev.disabled = at <= 0; next.disabled = at >= records.length - 1;
    label.textContent = records.length ? `Recipient ${at + 1} of ${records.length}` : 'Sample recipient';
    update(records[at] || null);
  }
  const node = el('div.mm-nav', {}, records.length > 1 ? prev : null, label, records.length > 1 ? next : null);
  node.sync = sync;
  return node;
}
/** Look up an address concept for a record (or the sample when there are no recipients). */
const conceptLookup = (mm, record) => id => {
  if (!record) return SAMPLE_RECIPIENT[id] || '';
  const column = mm.mapping()[id];
  return column ? record.values[column] ?? '' : '';
};

/* ---- Address Block ---- */
export function openAddressBlock(mm) {
  const format = el('div.mm-format-list', { role: 'listbox', 'aria-label': 'Recipient name format', tabindex: 0 });
  let chosen = 'titleFirstLast';
  const renderFormats = () => format.replaceChildren(...NAME_FORMATS.map(([id, sample]) => el('div.mm-format-item', { role: 'option', id: `mm-name-${id}`, 'aria-selected': String(id === chosen), onclick: () => { chosen = id; renderFormats(); update(); } }, sample)));
  format.addEventListener('keydown', e => {
    const i = NAME_FORMATS.findIndex(f => f[0] === chosen);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); chosen = NAME_FORMATS[Math.max(0, Math.min(NAME_FORMATS.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))][0]; renderFormats(); update(); }
  });
  const company = checkbox('Include the company name', true);
  const postal = checkbox('Include the postal address', true);
  const excluded = input('United States', { 'aria-label': 'Leave out this country or region' });
  const country = radios('Country or region', [['always', 'Always include the country or region'], ['never', 'Never include the country or region'], ['unlessExcluded', 'Include it only when it differs from:']], 'unlessExcluded', () => update());
  const preview = el('pre.mm-preview', { 'aria-live': 'polite', 'aria-label': 'Preview' });
  let record = null;
  const options = () => ({ name: chosen, company: company.input.checked, postal: postal.input.checked, country: country.value, excluded: excluded.value.trim() });
  function update() {
    excluded.disabled = country.value !== 'unlessExcluded';
    preview.textContent = renderAddressBlock(addressBlockInstruction(options()), conceptLookup(mm, record)) || '(This recipient has no address details in the matched columns.)';
  }
  const nav = previewNavigator(mm, r => { record = r; update(); });
  for (const box of [company, postal]) box.input.addEventListener('change', update);
  excluded.addEventListener('input', update);
  renderFormats();
  const unmatched = () => ['first', 'last', 'address1', 'city'].filter(id => !mm.mapping()[id]);
  const hint = el('p.field-hint');
  const refreshHint = () => { const missing = unmatched(); hint.textContent = mm.records().length && missing.length ? `Not matched yet: ${missing.map(id => ADDRESS_FIELDS.find(f => f.id === id).label.toLowerCase()).join(', ')}. Use Match Fields to choose their columns.` : ''; };
  refreshHint();
  dialog({ title: 'Insert Address Block', size: 'wide', submit: 'Insert', focus: format, body: [
    el('div.mm-two', {},
      el('div', {}, el('p.field-label', {}, 'Recipient name'), format, company, postal, country, excluded),
      el('div', {}, el('p.field-label', {}, 'Preview'), preview, nav, hint, button('Match Fields…', () => openMatchFields(mm, () => { refreshHint(); update(); })))),
  ], onSubmit: () => mm.insertField(addressBlockInstruction(options())) });
  nav.sync();
}

/* ---- Greeting Line ---- */
export function openGreetingLine(mm) {
  const salutation = select([['Dear', 'Dear'], ['To', 'To'], ['Hello', 'Hello'], ['Hi', 'Hi'], ['Greetings', 'Greetings'], ['', '(none)']], 'Dear', { 'aria-label': 'Salutation' });
  const name = select(GREETING_NAMES.map(([id, sample]) => [id, sample]), 'titleLast', { 'aria-label': 'Name format' });
  const punctuation = select([[',', ','], [':', ':'], ['!', '!'], ['.', '.'], ['', '(none)']], ',', { 'aria-label': 'Punctuation' });
  const fallback = input('Dear Friend,', { 'aria-label': 'Greeting when the name is missing' });
  const preview = el('p.mm-preview.mm-preview-line', { 'aria-live': 'polite' });
  let record = null;
  const options = () => ({ salutation: salutation.value, name: name.value, punctuation: punctuation.value, fallback: fallback.value });
  const update = () => { preview.textContent = renderGreetingLine(greetingInstruction(options()), conceptLookup(mm, record)) || '(empty)'; };
  for (const c of [salutation, name, punctuation]) c.addEventListener('change', update);
  fallback.addEventListener('input', update);
  const nav = previewNavigator(mm, r => { record = r; update(); });
  dialog({ title: 'Insert Greeting Line', size: 'wide', submit: 'Insert', body: [
    el('div.mm-inline.mm-greeting', {}, field('Salutation', salutation), field('Name', name), field('Ending', punctuation)),
    field('When a name is missing', fallback, 'Used for recipients with no name in the matched columns.'),
    el('p.field-label', {}, 'Preview'), preview, nav,
    el('div.row', {}, button('Match Fields…', () => openMatchFields(mm, update))),
  ], onSubmit: () => mm.insertField(greetingInstruction(options())) });
  nav.sync();
}

/* ---- Merge fields ---- */
const CASES = [['', 'As typed'], ['Upper', 'UPPERCASE'], ['Lower', 'lowercase'], ['FirstCap', 'First letter capital'], ['Caps', 'Title Case']];
/** A MERGEFIELD instruction for a column with optional text before/after and capitalization. */
export function mergeFieldInstruction(column, { before = '', after = '', format = '' } = {}) {
  return ` MERGEFIELD ${fieldName(column)}${before ? ` \\b ${quoteArgument(before)}` : ''}${after ? ` \\f ${quoteArgument(after)}` : ''}${format ? ` \\* ${format}` : ''} `;
}

export function openInsertField(mm) {
  const columns = mm.state().list?.columns || [];
  const kind = radios('Insert', [['database', 'Database fields'], ['address', 'Address fields']], 'database', () => fill());
  const list = el('select.input.mm-field-list', { size: 9, 'aria-label': 'Fields' });
  const before = input('', { 'aria-label': 'Text before' }), after = input('', { 'aria-label': 'Text after' });
  const format = select(CASES, '', { 'aria-label': 'Capitalization' });
  const note = el('p.field-hint');
  function fill() {
    const items = kind.value === 'address' ? ADDRESS_FIELDS.map(f => [f.id, `${f.label}${mm.mapping()[f.id] ? ` → ${mm.mapping()[f.id]}` : ' (not matched)'}`]) : columns.map(c => [c, c]);
    list.replaceChildren(...items.map(([v, l]) => el('option', { value: v }, l)));
    if (items.length) list.value = items[0][0];
    note.textContent = kind.value === 'database' && !columns.length ? 'Select recipients first to list their columns, or type a column name below.' : '';
  }
  const custom = input('', { 'aria-label': 'Or type a field name', placeholder: 'Field name' });
  fill();
  const insert = () => {
    let column = custom.value.trim() || list.value;
    if (kind.value === 'address' && !custom.value.trim()) {
      column = mm.mapping()[list.value];
      if (!column) throw new Error(`Match “${ADDRESS_FIELDS.find(f => f.id === list.value)?.label}” to a column first (Match Fields).`);
    }
    if (!column) throw new Error('Choose a field to insert.');
    mm.insertField(mergeFieldInstruction(column, { before: before.value, after: after.value, format: format.value }));
    custom.value = '';
  };
  list.addEventListener('dblclick', () => { try { insert(); } catch (e) { modal.error(e.message); } });
  const modal = dialog({ title: 'Insert Merge Field', size: 'wide', submit: 'Insert', cancel: 'Close', body: [
    kind, el('div.mm-two', {}, el('div', {}, list, note, field('Or type a field name', custom)),
      el('div', {}, field('Text before (only when the field has a value)', before), field('Text after (only when the field has a value)', after), field('Capitalization', format),
        button('Match Fields…', () => openMatchFields(mm, fill)))),
  ], onSubmit: () => { insert(); return false; } });
  return modal;
}

/* ---- Rules ---- */
export const RULES = [
  ['ask', 'Ask…'], ['fillin', 'Fill-in…'], ['if', 'If…Then…Else…'], ['mergerec', 'Merge Record #'], ['mergeseq', 'Merge Sequence #'],
  ['next', 'Next Record'], ['nextif', 'Next Record If…'], ['set', 'Set Bookmark…'], ['skipif', 'Skip Record If…'],
];
const COMPARISONS = [['=', 'Equal to'], ['<>', 'Not equal to'], ['<', 'Less than'], ['>', 'Greater than'], ['<=', 'Less than or equal to'], ['>=', 'Greater than or equal to'], ['blank', 'Is blank'], ['notBlank', 'Is not blank']];
/** The "{ MERGEFIELD x }" = "value" part of a rule. */
export function comparison(column, operator, value) {
  const operand = `"{ MERGEFIELD ${fieldName(column)} }"`;
  if (operator === 'blank') return `${operand} = ""`;
  if (operator === 'notBlank') return `${operand} <> ""`;
  return `${operand} ${operator} ${quoteArgument(value)}`;
}
const BOOKMARK = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

export function openRule(kind, mm) {
  const simple = { mergerec: ' MERGEREC ', mergeseq: ' MERGESEQ ', next: ' NEXT ' }[kind];
  if (simple) { mm.insertField(simple); return null; }
  const columns = mm.state().list?.columns || [];
  const columnSelect = () => columns.length ? select(columns.map(c => [c, c]), columns[0], { 'aria-label': 'Field name' }) : input('', { 'aria-label': 'Field name', placeholder: 'Column name' });
  const condition = () => {
    const column = columnSelect(), operator = select(COMPARISONS, '=', { 'aria-label': 'Comparison' }), value = input('', { 'aria-label': 'Compare to' });
    operator.addEventListener('change', () => { value.disabled = ['blank', 'notBlank'].includes(operator.value); });
    return { column, operator, value, node: el('div.mm-inline.mm-rule-condition', {}, field('Field name', column), field('Comparison', operator), field('Compare to', value)), code: () => {
      if (!column.value.trim()) throw new Error('Choose the field to compare.');
      return comparison(column.value.trim(), operator.value, value.value);
    } };
  };
  const bookmarkName = (value = '') => input(value, { 'aria-label': 'Bookmark name', placeholder: 'For example DueDate' });
  const checkName = name => { if (!BOOKMARK.test(name)) throw new Error('Use a bookmark name that starts with a letter and has only letters, numbers and underscores (up to 40).'); };
  let body, build, title;
  if (kind === 'ask' || kind === 'fillin') {
    const name = bookmarkName(), prompt = input('', { 'aria-label': 'Prompt' }), answer = input('', { 'aria-label': 'Default answer' });
    const once = checkbox('Ask once, not for each record');
    const show = checkbox('Show the answer here as well', kind === 'ask');
    title = kind === 'ask' ? 'Ask Rule' : 'Fill-in Rule';
    body = [kind === 'ask' ? field('Bookmark', name, 'The answer is stored under this name for use elsewhere in the document.') : null, field('Prompt', prompt), field('Default answer', answer), once, kind === 'ask' ? show : null];
    build = () => {
      if (!prompt.value.trim()) throw new Error('Type the question to ask.');
      const tail = `${answer.value ? ` \\d ${quoteArgument(answer.value)}` : ''}${once.input.checked ? ' \\o' : ''}`;
      if (kind === 'fillin') return [` FILLIN ${quoteArgument(prompt.value.trim())}${tail} `];
      checkName(name.value.trim());
      return [` ASK ${name.value.trim()} ${quoteArgument(prompt.value.trim())}${tail} `, ...(show.input.checked ? [` REF ${name.value.trim()} `] : [])];
    };
  } else if (kind === 'set') {
    const name = bookmarkName(), value = input('', { 'aria-label': 'Value' });
    title = 'Set Bookmark Rule';
    body = [field('Bookmark', name), field('Value', value, 'Show it elsewhere with a reference to the bookmark.')];
    build = () => { checkName(name.value.trim()); return [` SET ${name.value.trim()} ${quoteArgument(value.value)} `]; };
  } else if (kind === 'if') {
    const c = condition(), then = el('textarea.input.mm-textarea', { rows: 2, 'aria-label': 'Insert this text' }), otherwise = el('textarea.input.mm-textarea', { rows: 2, 'aria-label': 'Otherwise insert this text' });
    title = 'If…Then…Else Rule';
    body = [el('p.field-label', {}, 'If'), c.node, field('Insert this text', then), field('Otherwise insert this text', otherwise)];
    build = () => [` IF ${c.code()} ${quoteArgument(then.value)} ${quoteArgument(otherwise.value)} `];
  } else {
    const c = condition();
    title = kind === 'nextif' ? 'Next Record If Rule' : 'Skip Record If Rule';
    body = [el('p.field-hint', {}, kind === 'nextif' ? 'When the comparison is true, the following fields use the next recipient without starting a new document.' : 'When the comparison is true, this recipient is left out of the merge.'), c.node];
    build = () => [` ${kind === 'nextif' ? 'NEXTIF' : 'SKIPIF'} ${c.code()} `];
  }
  if (!columns.length && ['if', 'nextif', 'skipif'].includes(kind)) body.unshift(el('p.field-hint', {}, 'Select recipients first to choose from their columns.'));
  return dialog({ title, size: 'wide', submit: 'Insert', body, onSubmit: () => { for (const code of build()) mm.insertField(code); } });
}

/* ---- Match Fields ---- */
export function openMatchFields(mm, done = () => {}) {
  const columns = mm.state().list?.columns || [];
  if (!columns.length) { dialog({ title: 'Match Fields', submit: null, cancel: 'Close', body: el('p.modal-text', {}, 'Select recipients first. Then you can choose which of their columns hold names and addresses.') }); return; }
  const current = { ...autoMatchFields(columns), ...mm.mapping() };
  const selects = ADDRESS_FIELDS.map(f => [f.id, select([['', '(not matched)'], ...columns.map(c => [c, c])], current[f.id] || '', { 'aria-label': f.label })]);
  dialog({ title: 'Match Fields', size: 'wide', body: [
    el('p.field-hint', {}, 'Address blocks and greeting lines read these columns. Fields that match a column name are matched for you.'),
    el('div.mm-match-grid', {}, ...selects.map(([id, s]) => field(ADDRESS_FIELDS.find(f => f.id === id).label, s))),
  ], onSubmit: () => { mm.setState({ mapping: Object.fromEntries(selects.filter(([, s]) => s.value).map(([id, s]) => [id, s.value])) }); done(); } });
}

/* ---- Find Recipient ---- */
export function openFindRecipient(mm) {
  const columns = mm.state().list?.columns || [];
  const text = input('', { type: 'search', 'aria-label': 'Find' });
  const where = select([['', 'All fields'], ...columns.map(c => [c, c])], '', { 'aria-label': 'Look in' });
  const result = el('p.field-hint', { role: 'status' });
  const modal = dialog({ title: 'Find Entry', submit: 'Find Next', cancel: 'Close', body: [field('Find', text), field('Look in', where), result], onSubmit: () => {
    const query = text.value.trim().toLowerCase(); if (!query) throw new Error('Type something to find.');
    const records = mm.records(), start = mm.state().activeRecord || 1;
    for (let k = 1; k <= records.length; k++) {
      const index = (start - 1 + k) % records.length, record = records[index];
      const values = where.value ? [record.values[where.value]] : Object.values(record.values);
      if (values.some(v => String(v ?? '').toLowerCase().includes(query))) {
        mm.goToRecord(index + 1);
        result.textContent = `Showing recipient ${index + 1} of ${records.length}.`;
        return false;
      }
    }
    result.textContent = 'No recipient matches.';
    return false;
  } });
  return modal;
}

/* ---- Check for Errors ---- */
export function openCheckErrors(mm) {
  const report = mm.errorReport();
  const items = [];
  if (report.missing.length) items.push(el('li', {}, el('strong', {}, 'Fields with no matching column: '), report.missing.join(', '), '. These show as «Field» in merged documents.'));
  if (report.noRecipients) items.push(el('li', {}, 'No recipients are selected, so nothing will be merged.'));
  if (report.emptyAddress.length) items.push(el('li', {}, el('strong', {}, `Empty address blocks: `), `recipients ${report.emptyAddress.slice(0, 20).join(', ')}${report.emptyAddress.length > 20 ? '…' : ''}.`));
  if (report.noEmail.length) items.push(el('li', {}, el('strong', {}, 'No email address: '), `recipients ${report.noEmail.slice(0, 20).join(', ')}${report.noEmail.length > 20 ? '…' : ''}.`));
  if (report.skipped) items.push(el('li', {}, `${report.skipped} ${report.skipped === 1 ? 'recipient is' : 'recipients are'} skipped by Skip Record If rules.`));
  if (report.noFields) items.push(el('li', {}, 'The document has no merge fields yet, so every copy will be the same.'));
  dialog({ title: 'Check for Errors', submit: null, cancel: 'Close', size: 'wide', body: [
    el('p.modal-text', {}, items.length ? `A simulated merge of ${report.copies} ${report.copies === 1 ? 'document' : 'documents'} found:` : `A simulated merge of ${report.copies} ${report.copies === 1 ? 'document' : 'documents'} found no errors.`),
    items.length ? el('ul.mm-report', {}, ...items) : null,
  ] });
}

/* ---- Ask / Fill-in prompts before merging ---- */
export function askPrompts(prompts, answers = {}) {
  if (!prompts.length) return Promise.resolve(answers);
  return new Promise(resolve => {
    let result = null;
    const inputs = prompts.map(p => [p, input(answers[p.id] ?? p.defaultValue, { 'aria-label': p.prompt })]);
    dialog({ title: 'Answers for the Merge', submit: 'Continue', body: [
      el('p.field-hint', {}, 'These questions come from Ask and Fill-in fields. Each answer is used for every merged document.'),
      ...inputs.map(([p, i]) => field(p.prompt, i)),
    ], onSubmit: () => { result = { ...answers, ...Object.fromEntries(inputs.map(([p, i]) => [p.id, i.value])) }; }, onClose: () => resolve(result) });
  });
}

/* ---- Finish & Merge ---- */
/** Choose records (and email options); resolves { from, to, email? } or null. */
export function openFinish(kind, mm) {
  const total = mm.records().length, current = Math.min(mm.state().activeRecord || 1, total);
  const range = radios('Merge records', [['all', `All (${total})`], ['current', `Current record (${current})`], ['range', 'From–to']], 'all', () => sync());
  const from = input('1', { type: 'number', min: 1, max: total, 'aria-label': 'From record' }), to = input(String(total), { type: 'number', min: 1, max: total, 'aria-label': 'To record' });
  const sync = () => { from.disabled = to.disabled = range.value !== 'range'; };
  sync();
  const titles = { document: 'Merge to New Document', print: 'Merge to Printer', email: 'Merge to Email' };
  const columns = mm.state().list?.columns || [];
  const emailColumn = select(columns.map(c => [c, c]), mm.state().email?.to || mm.mapping().email || columns.find(c => /e-?mail/i.test(c)) || columns[0], { 'aria-label': 'To' });
  const subject = input(mm.state().subject || '', { 'aria-label': 'Subject line' });
  const format = select([['html', 'HTML'], ['text', 'Plain text']], mm.state().email?.format || 'html', { 'aria-label': 'Mail format' });
  return new Promise(resolve => {
    let result = null;
    dialog({ title: titles[kind], size: kind === 'email' ? 'wide' : '', submit: kind === 'email' ? 'Continue' : 'OK', body: [
      ...(kind === 'email' ? [field('To', emailColumn), field('Subject line', subject), field('Mail format', format)] : []),
      el('p.field-label', {}, 'Merge records'), range, el('div.mm-inline', {}, field('From record', from), field('To record', to)),
    ], onSubmit: () => {
      let a = 1, b = total;
      if (range.value === 'current') a = b = current;
      if (range.value === 'range') {
        a = Number(from.value); b = Number(to.value);
        if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b > total || a > b) throw new Error(`Choose records between 1 and ${total}.`);
      }
      if (kind === 'email') {
        if (!emailColumn.value) throw new Error('Choose the column with email addresses.');
        mm.setState({ subject: subject.value, email: { ...mm.state().email, to: emailColumn.value, format: format.value } });
      }
      result = { from: a, to: b };
    }, onClose: () => resolve(result) });
  });
}
