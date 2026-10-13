import { describe, it, expect } from 'vitest';
import {
  parseFieldCode, flattenFieldCode, fieldKeyword, tokenizeInstruction, evaluateField, mergeContext, planMerge, mergeCopy,
  renderAddressBlock, renderGreetingLine, addressBlockInstruction, greetingInstruction, autoMatchFields, formatValue,
  formatNumberPicture, formatDatePicture, compareOperands, mergePrompts, placeholderText, mergeRecords, visibleRows,
  duplicateRows, validateAddresses, emptyRecipientList, fieldSwitches,
} from '../src/engine/merge-fields.js';

const data = [
  { number: 1, values: { Title: 'Ms.', 'First Name': 'Rosa', 'Last Name': 'Vidal', Company: 'Tide Works', 'Address Line 1': '1 Pier Rd', 'Address Line 2': '', City: 'Oslo', State: '', 'ZIP Code': '0150', Country: 'Norway', Amount: '1234.5' } },
  { number: 2, values: { Title: '', 'First Name': 'Ken', 'Last Name': 'Ito', Company: '', 'Address Line 1': '9 Elm St', 'Address Line 2': 'Apt 4', City: 'Austin', State: 'TX', 'ZIP Code': '78701', Country: 'United States', Amount: '-20' } },
  { number: 3, values: { Title: 'Dr.', 'First Name': '', 'Last Name': '', Company: '', 'Address Line 1': '', 'Address Line 2': '', City: 'Paris', State: '', 'ZIP Code': '', Country: 'France', Amount: '0' } },
];
const ctx = (cursor = 0, extra = {}) => mergeContext({ data, cursor, mapping: autoMatchFields(Object.keys(data[0].values)), ...extra });

describe('field code syntax', () => {
  it('parses nested codes and flattens them back', () => {
    const code = 'IF "{ MERGEFIELD City }" = "Oslo" "Hei" "Hello"';
    const tree = parseFieldCode(code);
    expect(tree.parts).toHaveLength(3);
    expect(flattenFieldCode(tree)).toBe(code);
    expect(fieldKeyword(tree)).toBe('IF');
    expect(fieldKeyword(tree.parts[1])).toBe('MERGEFIELD');
    expect(flattenFieldCode(parseFieldCode('MERGEFIELD {broken'))).toBe('MERGEFIELD {broken');
  });
  it('tokenizes quoted arguments with escapes and switches', () => {
    expect(tokenizeInstruction(' MERGEFIELD "First Name" \\b "Dear " \\* Upper ').map(t => t.value)).toEqual(['MERGEFIELD', 'First Name', '\\b', 'Dear ', '\\*', 'Upper']);
    expect(tokenizeInstruction('SET x "say \\"hi\\""')[2].value).toBe('say "hi"');
    expect(fieldSwitches(tokenizeInstruction('City \\*Upper \\o')).switches).toEqual({ '\\*': ['Upper'], '\\o': true });
  });
});

describe('MERGEFIELD', () => {
  it('merges values with formatting switches', () => {
    expect(evaluateField(' MERGEFIELD City ', ctx())).toBe('Oslo');
    expect(evaluateField(' MERGEFIELD "First Name" \\* Upper ', ctx())).toBe('ROSA');
    expect(evaluateField(' MERGEFIELD Title \\f " " ', ctx(1))).toBe('');
    expect(evaluateField(' MERGEFIELD Title \\f " " ', ctx(0))).toBe('Ms. ');
    expect(evaluateField(' MERGEFIELD city \\b "in " ', ctx(0))).toBe('in Oslo');
    expect(evaluateField(' MERGEFIELD Amount \\# "$#,##0.00" ', ctx(0))).toBe('$1,234.50');
  });
  it('reports a column the data does not have', () => {
    const issues = [];
    expect(evaluateField(' MERGEFIELD Nickname ', ctx(0, { onIssue: i => issues.push(i) }))).toBe('«Nickname»');
    expect(issues).toEqual([{ type: 'missingField', field: 'Nickname', record: 1 }]);
  });
  it('formats numbers, dates and capitalization', () => {
    expect(formatNumberPicture('-20', '#,##0.00;(#,##0.00)')).toBe('(20.00)');
    expect(formatNumberPicture('7', '000')).toBe('007');
    expect(formatNumberPicture('abc', '0.0')).toBe('abc');
    expect(formatDatePicture('2026-03-05', 'MMMM d, yyyy')).toBe('March 5, 2026');
    expect(formatDatePicture('2026-03-05', "dddd 'the' d")).toBe('Thursday the 5');
    expect(formatValue('mARY ann', { '\\*': ['Caps'] })).toBe('Mary Ann');
    expect(formatValue('3', { '\\*': ['Ordinal'] })).toBe('3rd');
    expect(formatValue('14', { '\\*': ['roman'] })).toBe('xiv');
  });
});

describe('address blocks and greeting lines', () => {
  const field = values => id => values[id] || '';
  it('drops empty groups and blank lines, and omits the excluded country', () => {
    const code = addressBlockInstruction({ name: 'titleFirstLast', company: true, country: 'unlessExcluded', excluded: 'United States' });
    expect(renderAddressBlock(code, field({ title: 'Ms.', first: 'Rosa', last: 'Vidal', company: 'Tide Works', address1: '1 Pier Rd', city: 'Oslo', postal: '0150', country: 'Norway' })))
      .toBe('Ms. Rosa Vidal\nTide Works\n1 Pier Rd\nOslo 0150\nNorway');
    expect(renderAddressBlock(code, field({ first: 'Ken', last: 'Ito', address1: '9 Elm St', address2: 'Apt 4', city: 'Austin', state: 'TX', postal: '78701', country: 'United States' })))
      .toBe('Ken Ito\n9 Elm St\nApt 4\nAustin, TX 78701');
    const noCompany = addressBlockInstruction({ name: 'lastFirst', company: false, country: 'never' });
    expect(renderAddressBlock(noCompany, field({ first: 'Rosa', last: 'Vidal', company: 'Tide Works', city: 'Oslo', country: 'Norway' }))).toBe('Vidal, Rosa\nOslo');
  });
  it('builds greetings and falls back when the name is empty', () => {
    const code = greetingInstruction({ salutation: 'Dear', name: 'titleLast', punctuation: ',', fallback: 'Dear Friend,' });
    expect(renderGreetingLine(code, field({ title: 'Ms.', last: 'Vidal' }))).toBe('Dear Ms. Vidal,');
    expect(renderGreetingLine(code, field({ last: 'Ito' }))).toBe('Dear Ito,');
    expect(renderGreetingLine(code, field({}))).toBe('Dear Friend,');
    expect(renderGreetingLine(greetingInstruction({ salutation: '', name: 'first', punctuation: '!' }), field({ first: 'Ken' }))).toBe('Ken!');
  });
  it('evaluates through the matched columns', () => {
    expect(evaluateField(greetingInstruction(), ctx(0))).toBe('Dear Ms. Vidal,');
    expect(evaluateField(addressBlockInstruction(), ctx(1))).toBe('Ken Ito\n9 Elm St\nApt 4\nAustin, TX 78701');
  });
  it('matches common column names to address concepts', () => {
    expect(autoMatchFields(['E-mail Address', 'Surname', 'Given Name', 'Zip', 'Organisation'])).toEqual({ first: 'Given Name', last: 'Surname', company: 'Organisation', postal: 'Zip', email: 'E-mail Address' });
  });
});

describe('rules', () => {
  it('chooses IF branches with nested fields, numbers and wildcards', () => {
    expect(evaluateField('IF "{ MERGEFIELD City }" = "Oslo" "Hei" "Hello"', ctx(0))).toBe('Hei');
    expect(evaluateField('IF "{ MERGEFIELD City }" = "Oslo" "Hei" "Hello"', ctx(1))).toBe('Hello');
    expect(evaluateField('IF { MERGEFIELD Amount } > 100 "big" "small"', ctx(0))).toBe('big');
    expect(evaluateField('IF "{ MERGEFIELD City }" = "Au*" "A" "B"', ctx(1))).toBe('A');
    expect(evaluateField('IF "{ MERGEFIELD City }" <> "" "has city" "none"', ctx(2))).toBe('has city');
    expect(compareOperands('10', '<', '9')).toBe(false);
    expect(compareOperands('apple', '<', 'banana')).toBe(true);
  });
  it('numbers records and sequences', () => {
    expect(evaluateField('MERGEREC', ctx(2))).toBe('3');
    expect(evaluateField('MERGESEQ', mergeContext({ data, sequence: 7 }))).toBe('7');
  });
  it('assigns ASK and SET bookmarks that REF shows', () => {
    const c = ctx(0, { answers: { 'ASK:due': 'Friday' } });
    expect(evaluateField('ASK due "When is it due?" \\d "Monday"', c)).toBe('');
    expect(evaluateField('REF due', c)).toBe('Friday');
    expect(evaluateField('SET greeting "Ahoy"', c)).toBe('');
    expect(evaluateField('REF greeting \\* Upper', c)).toBe('AHOY');
    expect(evaluateField('REF _Ref123', c)).toBe(null);
    expect(evaluateField('FILLIN "Your initials?" \\d "NJ"', c)).toBe('NJ');
    expect(mergePrompts(['ASK due "When is it due?" \\d "Monday" \\o', 'FILLIN "Your initials?"', 'IF 1 = 1 "{ FILLIN "Your initials?" }" ""']))
      .toEqual([{ id: 'ASK:due', kind: 'ASK', name: 'due', prompt: 'When is it due?', defaultValue: 'Monday', once: true }, { id: 'FILLIN:Your initials?', kind: 'FILLIN', name: null, prompt: 'Your initials?', defaultValue: '', once: false }]);
  });
  it('NEXT fills a sheet of labels and leaves the rest empty', () => {
    const codes = [' MERGEFIELD City ', ' NEXT ', ' MERGEFIELD City ', ' NEXT ', ' MERGEFIELD City ', ' NEXT ', ' MERGEFIELD City '];
    const plan = planMerge(codes, { data });
    expect(plan).toHaveLength(1);
    expect(plan[0].results).toEqual(['Oslo', '', 'Austin', '', 'Paris', '', '']);
    expect(plan[0].records).toEqual([0, 1, 2]);
  });
  it('NEXTIF and SKIPIF steer which records produce copies', () => {
    const skip = planMerge(['SKIPIF "{ MERGEFIELD Country }" = "France"', ' MERGEFIELD City ', ' MERGESEQ '], { data });
    expect(skip.map(c => c.results.slice(1))).toEqual([['Oslo', '1'], ['Austin', '2']]);
    const nextIf = mergeCopy([' MERGEFIELD City ', 'NEXTIF "{ MERGEFIELD Country }" = "Norway"', ' MERGEFIELD City '], { data });
    expect(nextIf.results).toEqual(['Oslo', '', 'Austin']);
  });
  it('shows placeholders outside preview', () => {
    expect(placeholderText(' MERGEFIELD "First Name" ')).toBe('«First Name»');
    expect(placeholderText(' NEXT ')).toBe('«Next Record»');
    expect(placeholderText(addressBlockInstruction())).toBe('«AddressBlock»');
    expect(evaluateField('IF "{ MERGEFIELD City }" = "Oslo" "Hei" "Hello"', mergeContext({ data, placeholders: true }))).toBe('Hei');
  });
});

describe('recipient lists', () => {
  const list = () => ({ ...emptyRecipientList(['Name', 'City', 'ZIP Code', 'Email']), rows: [
    { values: ['Rosa', 'Oslo', '0150', 'rosa@example.com'], included: true },
    { values: ['Ken', 'Austin', '7870', 'ken@'], included: true },
    { values: ['ken ', 'austin', '78701', ''], included: false },
    { values: ['Ana', 'Lima', '15001', 'ana@example.org'], included: true },
  ] });
  it('sorts, filters and skips unchecked rows for the merge', () => {
    const l = list();
    l.sort = [{ column: 'Name', descending: false }];
    expect(visibleRows(l).map(r => r.number)).toEqual([4, 2, 3, 1]);
    expect(mergeRecords(l).map(r => r.values.Name)).toEqual(['Ana', 'Ken', 'Rosa']);
    l.filters = [{ column: 'City', operator: 'startsWith', value: 'a' }, { column: 'Name', operator: 'equals', value: 'rosa', join: 'or' }];
    expect(visibleRows(l).map(r => r.number)).toEqual([2, 3, 1]);
    expect(mergeRecords(l)[0]).toEqual({ number: 2, values: { Name: 'Ken', City: 'Austin', 'ZIP Code': '7870', Email: 'ken@' } });
  });
  it('finds duplicates and questionable addresses', () => {
    expect(duplicateRows(list(), ['Name', 'City'])).toEqual([[2, 3]]);
    const report = validateAddresses(list(), { first: 'Name', city: 'City', postal: 'ZIP Code', email: 'Email' });
    expect(report).toEqual([{ number: 2, problems: ['Email address looks incomplete'] }]);
    const us = { ...list(), columns: ['Name', 'City', 'ZIP Code', 'Email', 'Country'] };
    us.rows = us.rows.map(r => ({ ...r, values: [...r.values, 'USA'] }));
    expect(validateAddresses(us, { first: 'Name', city: 'City', postal: 'ZIP Code', email: 'Email', country: 'Country' }).map(r => r.number)).toEqual([1, 2]);
  });
});
