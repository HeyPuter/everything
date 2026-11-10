/**
 * Starting points: small, complete workbooks with live formulas, formats,
 * validation, and conditional formatting already in place. Each template
 * builds a fresh Workbook; blue cells are the ones meant to be edited.
 */

import { Workbook } from './workbook.js';
import { parseInput, todaySerial, ymdToSerial, serialToYMD } from './format.js';
import { parseCellRef, parseRange, cellKey } from './cell.js';
import { sampleWorkbook } from './sample.js';
import { t } from '../i18n/index.js';

const INPUT = '#0a63f0';
const HEAD = { bold: true, bg: '#eef2ff', color: '#1e3a8a' };
const MUTED = { color: '#6b6964' };

function put(sheet, a1, input, style) {
  const { r, c } = parseCellRef(a1);
  const { v, f, fmt, dateStyle, cur } = parseInput(input, 'en-US');
  const s = { ...(fmt ? { fmt } : {}), ...(cur ? { cur } : {}), ...(dateStyle ? { dateStyle } : {}), ...(style || {}) };
  sheet.cells.set(cellKey(r, c), { v, f, s: Object.keys(s).length ? s : undefined });
}

/** Today as an ISO string, so template dates start from the day the file is made. */
function iso(serial) {
  const { y, m, d } = serialToYMD(serial);
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function finish(wb, sheet) {
  wb.activeSheetId = sheet.id;
  wb.clearHistory();
  wb.dirty = false;
  return wb;
}

function invoice() {
  const wb = new Workbook({ sheets: [{ name: 'Invoice', colWidths: { 0: 280, 1: 80, 2: 120, 3: 130 } }] });
  const [sh] = wb.sheets;
  const money = { fmt: 'currency', dec: 2 };
  put(sh, 'A1', 'INVOICE', { bold: true, size: 24 });
  put(sh, 'A3', 'From', { ...MUTED, bold: true });
  put(sh, 'A4', 'Your company', { color: INPUT });
  put(sh, 'A5', '123 Main Street, Springfield', { color: INPUT });
  put(sh, 'A6', 'hello@example.com', { color: INPUT });
  put(sh, 'C3', 'Bill to', { ...MUTED, bold: true });
  put(sh, 'C4', 'Client name', { color: INPUT });
  put(sh, 'C5', 'Client address', { color: INPUT });
  put(sh, 'C6', 'client@example.com', { color: INPUT });
  put(sh, 'A8', 'Invoice number', MUTED);
  put(sh, 'B8', '1001', { color: INPUT, align: 'left' });
  put(sh, 'C8', 'Invoice date', MUTED);
  put(sh, 'D8', '=TODAY()', { fmt: 'date', dateStyle: 'medium', color: INPUT });
  put(sh, 'C9', 'Due date', MUTED);
  put(sh, 'D9', '=D8+30', { fmt: 'date', dateStyle: 'medium' });
  put(sh, 'A11', 'Description');
  put(sh, 'B11', 'Qty', { align: 'right' });
  put(sh, 'C11', 'Unit price', { align: 'right' });
  put(sh, 'D11', 'Amount', { align: 'right' });
  const items = [['Design work', 12, 95], ['Development', 30, 120], ['Hosting (monthly)', 1, 25]];
  for (let i = 0; i < 8; i++) {
    const r = 12 + i;
    const item = items[i];
    if (item) {
      put(sh, `A${r}`, item[0], { color: INPUT });
      put(sh, `B${r}`, String(item[1]), { color: INPUT });
      put(sh, `C${r}`, String(item[2]), { ...money, color: INPUT });
    }
    put(sh, `D${r}`, '', money);
  }
  // The line items are a table: Amount is a calculated column, so a new line typed under the last one gets it too.
  wb.addTable(sh.id, parseRange('A11:D19'), { name: 'Items', style: 'gray', banded: false });
  wb.setInput(sh.id, 11, 3, '=IF(OR([@Qty]="",[@[Unit price]]=""),"",[@Qty]*[@[Unit price]])');
  put(sh, 'C21', 'Subtotal', { align: 'right' });
  put(sh, 'D21', '=SUM(Items[Amount])', money);
  put(sh, 'B22', 'Tax rate', { align: 'right' });
  put(sh, 'C22', '8%', { fmt: 'percent', dec: 1, color: INPUT });
  put(sh, 'D22', '=D21*C22', money);
  put(sh, 'C23', 'Total due', { bold: true, align: 'right' });
  put(sh, 'D23', '=D21+D22', { ...money, bold: true, bt: true, bs: 'medium' });
  put(sh, 'A25', 'Notes', { ...MUTED, bold: true });
  put(sh, 'A26', 'Payment is due within 30 days. Thank you for your business.', { color: INPUT });
  return finish(wb, sh);
}

function todo() {
  const wb = new Workbook({ sheets: [{ name: 'Tasks', colWidths: { 0: 60, 1: 300, 2: 110, 3: 100, 4: 260, 5: 30, 6: 130, 7: 80 } }] });
  const [sh] = wb.sheets;
  const today = todaySerial();
  ['Done', 'Task', 'Due', 'Priority', 'Notes'].forEach((h, i) => put(sh, `${'ABCDE'[i]}1`, h, { align: i === 0 ? 'center' : 'left' }));
  const rows = [
    [true, 'Set up the project board', -3, 'High', ''],
    [false, 'Write the kickoff brief', 0, 'High', 'Share with the team by noon'],
    [false, 'Review the budget draft', 1, 'Medium', ''],
    [false, 'Book the venue', 3, 'Medium', 'Two options shortlisted'],
    [false, 'Send invitations', 7, 'Low', 'After the venue is confirmed'],
    [false, 'Order name badges', 10, 'Low', ''],
  ];
  rows.forEach(([done, task, offset, priority, notes], i) => {
    const r = 2 + i;
    put(sh, `A${r}`, done ? 'TRUE' : 'FALSE', { align: 'center' });
    put(sh, `B${r}`, task);
    put(sh, `C${r}`, iso(today + offset));
    put(sh, `D${r}`, priority);
    if (notes) put(sh, `E${r}`, notes, MUTED);
  });
  put(sh, 'G1', 'Summary', HEAD);
  put(sh, 'H1', '', HEAD);
  // A task typed under the table, or added with Tab, has a blank Done cell (its checkbox draws unticked): it is
  // not done, so the summary counts anything but TRUE, as the rules below grey out $A2=TRUE alone.
  put(sh, 'G2', 'Open');
  put(sh, 'H2', '=COUNTIFS(Tasks[Task],"<>",Tasks[Done],"<>TRUE")');
  put(sh, 'G3', 'Done');
  put(sh, 'H3', '=COUNTIF(Tasks[Done],TRUE)');
  put(sh, 'G4', 'Overdue');
  put(sh, 'H4', '=COUNTIFS(Tasks[Due],"<"&TODAY(),Tasks[Done],"<>TRUE")');
  put(sh, 'G5', 'Due this week');
  put(sh, 'H5', '=COUNTIFS(Tasks[Due],">="&TODAY(),Tasks[Due],"<="&TODAY()+7,Tasks[Done],"<>TRUE")');
  // The list is a table named Tasks: typing under it adds a task; the summary formulas follow the table.
  wb.addTable(sh.id, parseRange(`A1:E${1 + rows.length}`), { name: 'Tasks', style: 'blue' });
  wb.addValidation(sh.id, { range: parseRange('A2:A200'), type: 'checkbox', strict: true, allowBlank: true });
  wb.addValidation(sh.id, { range: parseRange('D2:D200'), type: 'list', source: 'High, Medium, Low', strict: false, allowBlank: true });
  wb.addValidation(sh.id, { range: parseRange('C2:C200'), type: 'date', strict: false, allowBlank: true, message: 'Enter a date' });
  wb.addRule(sh.id, { range: parseRange('B2:E200'), type: 'formula', value: '=$A2=TRUE', style: { color: '#918f88' } });
  wb.addRule(sh.id, { range: parseRange('C2:C200'), type: 'formula', value: '=AND(C2<>"",C2<TODAY(),$A2<>TRUE)', style: { color: '#c22a2a', bold: true } });
  wb.addRule(sh.id, { range: parseRange('D2:D200'), type: 'eq', value: 'High', style: { color: '#c22a2a' } });
  wb.setFrozen(sh.id, 1, 0);
  return finish(wb, sh);
}

function expenses() {
  const wb = new Workbook({
    sheets: [
      { name: 'Expenses', colWidths: { 0: 110, 1: 140, 2: 260, 3: 110 } },
      { name: 'Summary', colWidths: { 0: 140, 1: 110, 2: 90 } },
    ],
  });
  const [log, summary] = wb.sheets;
  const money = { fmt: 'currency', dec: 2 };
  const today = todaySerial();
  ['Date', 'Category', 'Description', 'Amount'].forEach((h, i) => put(log, `${'ABCD'[i]}1`, h, { align: i === 3 ? 'right' : 'left' }));
  const cats = ['Housing', 'Food', 'Transport', 'Utilities', 'Health', 'Fun', 'Other'];
  const entries = [
    [-27, 'Housing', 'Rent', 1500], [-26, 'Food', 'Groceries', 96.4], [-24, 'Utilities', 'Electricity', 118], [-23, 'Transport', 'Transit pass', 85],
    [-21, 'Fun', 'Concert tickets', 64.5], [-20, 'Food', 'Lunch out', 18.75], [-17, 'Health', 'Pharmacy', 23.1], [-14, 'Food', 'Groceries', 104.1],
    [-12, 'Utilities', 'Internet', 55], [-9, 'Transport', 'Fuel', 48], [-6, 'Fun', 'Streaming', 15.99], [-3, 'Food', 'Groceries', 88.6], [-1, 'Other', 'Gift', 40],
  ];
  entries.forEach(([offset, cat, desc, amount], i) => {
    const r = 2 + i;
    put(log, `A${r}`, iso(today + offset));
    put(log, `B${r}`, cat);
    put(log, `C${r}`, desc);
    put(log, `D${r}`, String(amount), money);
  });
  // The log is a table named Expenses; the summary sheet reads its columns by name, however long it grows.
  wb.addTable(log.id, parseRange(`A1:D${1 + entries.length}`), { name: 'Expenses', style: 'green' });
  wb.addValidation(log.id, { range: parseRange('B2:B500'), type: 'list', source: 'Summary!$A$2:$A$8', strict: false, allowBlank: true });
  wb.addValidation(log.id, { range: parseRange('A2:A500'), type: 'date', strict: false, allowBlank: true });
  wb.setFrozen(log.id, 1, 0);

  put(summary, 'A1', 'Category', HEAD);
  put(summary, 'B1', 'Spent', { ...HEAD, align: 'right' });
  put(summary, 'C1', 'Share', { ...HEAD, align: 'right' });
  cats.forEach((cat, i) => {
    const r = 2 + i;
    put(summary, `A${r}`, cat, { color: INPUT });
    put(summary, `B${r}`, `=SUMIF(Expenses[Category],A${r},Expenses[Amount])`, money);
    put(summary, `C${r}`, `=IF($B$9=0,0,B${r}/$B$9)`, { fmt: 'percent', dec: 0 });
  });
  put(summary, 'A9', 'Total', { bold: true });
  put(summary, 'B9', '=SUM(B2:B8)', { ...money, bold: true });
  put(summary, 'C9', '=SUM(C2:C8)', { fmt: 'percent', dec: 0, bold: true });
  put(summary, 'A11', 'This month');
  put(summary, 'B11', '=SUMIFS(Expenses[Amount],Expenses[Date],">="&EOMONTH(TODAY(),-1)+1,Expenses[Date],"<="&EOMONTH(TODAY(),0))', money);
  put(summary, 'A12', 'Average per day');
  put(summary, 'B12', '=IFERROR(B9/(MAX(Expenses[Date])-MIN(Expenses[Date])+1),0)', money);
  put(summary, 'A13', 'Largest expense');
  put(summary, 'B13', '=MAX(Expenses[Amount])', money);
  put(summary, 'A14', 'Entries');
  put(summary, 'B14', '=COUNTA(Expenses[Amount])');
  wb.addRule(summary.id, { range: parseRange('B2:B8'), type: 'databar', style: {}, barColor: '#8fb8ff' });
  wb.addChart(summary.id, { type: 'donut', range: parseRange('A1:B8'), title: 'Where the money goes', anchor: { r: 0, c: 4 }, dx: 8, dy: 4, w: 420, h: 300, seriesIn: 'cols', headers: true, legend: true, legendPos: 'right' });
  return finish(wb, log);
}

function loan() {
  const wb = new Workbook({ sheets: [{ name: 'Loan', colWidths: { 0: 160, 1: 130, 2: 120, 3: 120, 4: 120, 5: 130 } }] });
  const [sh] = wb.sheets;
  const money = { fmt: 'currency', dec: 2 };
  const today = todaySerial();
  const { y, m } = serialToYMD(today);
  put(sh, 'A1', 'Loan calculator', { bold: true, size: 18 });
  put(sh, 'A2', 'Change the blue cells; everything else updates.', MUTED);
  put(sh, 'A4', 'Loan amount');
  put(sh, 'B4', '250000', { fmt: 'currency', dec: 0, color: INPUT });
  put(sh, 'A5', 'Annual interest rate');
  put(sh, 'B5', '6.5%', { fmt: 'percent', dec: 2, color: INPUT });
  put(sh, 'A6', 'Term (years)');
  put(sh, 'B6', '30', { color: INPUT });
  put(sh, 'A7', 'First payment');
  put(sh, 'B7', iso(ymdToSerial(y, m + 1, 1)), { fmt: 'date', dateStyle: 'medium', color: INPUT });
  put(sh, 'D4', 'Monthly payment', { bold: true });
  put(sh, 'E4', '=PMT(B5/12,B6*12,-B4)', { ...money, bold: true });
  put(sh, 'D5', 'Number of payments');
  put(sh, 'E5', '=B6*12');
  put(sh, 'D6', 'Total paid');
  put(sh, 'E6', '=E4*E5', money);
  put(sh, 'D7', 'Total interest');
  put(sh, 'E7', '=E6-B4', money);
  put(sh, 'D8', 'Last payment');
  put(sh, 'E8', '=EDATE(B7,E5-1)', { fmt: 'date', dateStyle: 'medium' });
  ['#', 'Date', 'Payment', 'Interest', 'Principal', 'Balance'].forEach((h, i) => put(sh, `${'ABCDEF'[i]}10`, h, { ...HEAD, align: i < 2 ? 'left' : 'right' }));
  for (let i = 0; i < 60; i++) {
    const r = 11 + i;
    put(sh, `A${r}`, `=IF(${i + 1}<=$E$5,${i + 1},"")`);
    put(sh, `B${r}`, `=IF(A${r}="","",EDATE($B$7,A${r}-1))`, { fmt: 'date' });
    put(sh, `C${r}`, `=IF(A${r}="","",$E$4)`, money);
    put(sh, `D${r}`, `=IF(A${r}="","",IPMT($B$5/12,A${r},$E$5,-$B$4))`, money);
    put(sh, `E${r}`, `=IF(A${r}="","",C${r}-D${r})`, money);
    // The last payment clears the loan; MAX keeps floating-point dust from reading as -$0.00.
    put(sh, `F${r}`, i === 0 ? `=IF(A${r}="","",MAX(0,$B$4-E${r}))` : `=IF(A${r}="","",MAX(0,F${r - 1}-E${r}))`, money);
  }
  put(sh, 'A72', 'The schedule shows the first 60 payments.', MUTED);
  wb.setFrozen(sh.id, 10, 0);
  return finish(wb, sh);
}

function gradebook() {
  const wb = new Workbook({ sheets: [{ name: 'Grades', colWidths: { 0: 170, 1: 90, 2: 90, 3: 90, 4: 90, 5: 100, 6: 80 } }] });
  const [sh] = wb.sheets;
  const pct = { fmt: 'percent', dec: 0 };
  ['Student', 'Homework', 'Quiz', 'Midterm', 'Final', 'Average', 'Grade'].forEach((h, i) => put(sh, `${'ABCDEFG'[i]}1`, h, { ...HEAD, align: i ? 'right' : 'left' }));
  put(sh, 'A2', 'Weight', { bold: true, ...MUTED });
  [0.2, 0.1, 0.3, 0.4].forEach((w, i) => put(sh, `${'BCDE'[i]}2`, `${w * 100}%`, { ...pct, color: INPUT, bold: true }));
  const students = [
    ['Ava Martin', 92, 88, 79, 85], ['Ben Okafor', 78, 82, 71, 74], ['Chloe Dubois', 96, 91, 94, 97], ['Diego Alvarez', 65, 70, 58, 62],
    ['Emma Schulz', 88, 79, 83, 90], ['Farah Haddad', 71, 64, 69, 73], ['Grace Kim', 84, 90, 88, 81], ['Hugo Rossi', 59, 61, 52, 57],
    ['Isla Murphy', 90, 95, 91, 89], ['Jamal Wright', 82, 77, 80, 84],
  ];
  students.forEach(([name, ...scores], i) => {
    const r = 3 + i;
    put(sh, `A${r}`, name);
    scores.forEach((s, j) => put(sh, `${'BCDE'[j]}${r}`, String(s), { color: INPUT }));
    put(sh, `F${r}`, `=IF(COUNT(B${r}:E${r})=0,"",SUMPRODUCT(B${r}:E${r},$B$2:$E$2)/SUMPRODUCT(--(B${r}:E${r}<>""),$B$2:$E$2))`, { fmt: 'number', dec: 1 });
    put(sh, `G${r}`, `=IF(F${r}="","",IFS(F${r}>=90,"A",F${r}>=80,"B",F${r}>=70,"C",F${r}>=60,"D",TRUE,"F"))`, { align: 'center', bold: true });
  });
  const last = 2 + students.length;
  put(sh, `A${last + 2}`, 'Class average', { bold: true });
  ['B', 'C', 'D', 'E', 'F'].forEach((col) => put(sh, `${col}${last + 2}`, `=AVERAGE(${col}3:${col}${last})`, { fmt: 'number', dec: 1, bold: true }));
  put(sh, `A${last + 3}`, 'Highest');
  ['B', 'C', 'D', 'E', 'F'].forEach((col) => put(sh, `${col}${last + 3}`, `=MAX(${col}3:${col}${last})`, { fmt: 'number', dec: 1 }));
  put(sh, `A${last + 4}`, 'Lowest');
  ['B', 'C', 'D', 'E', 'F'].forEach((col) => put(sh, `${col}${last + 4}`, `=MIN(${col}3:${col}${last})`, { fmt: 'number', dec: 1 }));
  put(sh, `A${last + 6}`, 'Grade counts', { bold: true });
  ['A', 'B', 'C', 'D', 'F'].forEach((g, i) => {
    put(sh, `A${last + 7 + i}`, g, { align: 'center' });
    put(sh, `B${last + 7 + i}`, `=COUNTIF($G$3:$G$${last},A${last + 7 + i})`);
  });
  wb.addRule(sh.id, { range: parseRange(`B3:E${last}`), type: 'lt', value: 60, style: { color: '#c22a2a' } });
  wb.addRule(sh.id, { range: parseRange(`F3:F${last}`), type: 'scale', style: {}, from: '#fde8e8', mid: '#fef3c7', to: '#e3f5e1' });
  wb.setFrozen(sh.id, 2, 1);
  return finish(wb, sh);
}

function schedule() {
  const wb = new Workbook({ sheets: [{ name: 'Week', colWidths: { 0: 80, 1: 150, 2: 150, 3: 150, 4: 150, 5: 150, 6: 150, 7: 150 } }] });
  const [sh] = wb.sheets;
  const today = todaySerial();
  const { weekday } = serialToYMD(today);
  const monday = today - ((weekday + 6) % 7);
  put(sh, 'A1', 'Week of', { ...HEAD, align: 'right' });
  put(sh, 'B1', iso(monday), { fmt: 'date', dateStyle: 'medium', color: INPUT, bold: true });
  put(sh, 'A2', 'Time', HEAD);
  ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].forEach((d, i) => put(sh, `${'BCDEFGH'[i]}2`, `="${d} "&TEXT($B$1+${i},"d")`, { ...HEAD, align: 'center' }));
  for (let h = 7; h <= 20; h++) put(sh, `A${h - 4}`, `${String(h).padStart(2, '0')}:00`, { fmt: 'time', align: 'right', ...MUTED });
  const events = [['B5', 'Team stand-up'], ['B7', 'Deep work'], ['C6', 'Design review'], ['D5', 'Team stand-up'], ['D9', 'Dentist'], ['E8', 'Lunch with Sam'], ['F5', 'Team stand-up'], ['F10', 'Weekly retro'], ['G6', 'Farmers market'], ['H8', 'Family call']];
  for (const [a1, text] of events) put(sh, a1, text, { bg: '#e0ecff', color: '#1e3a8a' });
  wb.addRule(sh.id, { range: parseRange('A3:H16'), type: 'bands', style: {}, header: false, color1: '#f7f7f5', color2: '#ffffff', headerColor: '#e0ecff' });
  wb.setFrozen(sh.id, 2, 1);
  for (let r = 2; r <= 15; r++) wb.setRowHeight(sh.id, r, 34);
  return finish(wb, sh);
}

function timeline() {
  const days = 35;
  const colWidths = { 0: 200, 1: 100, 2: 100, 3: 100, 4: 60 };
  for (let i = 0; i < days; i++) colWidths[5 + i] = 26;
  const wb = new Workbook({ sheets: [{ name: 'Timeline', colWidths, cols: 5 + days + 4 }] });
  const [sh] = wb.sheets;
  const today = todaySerial();
  const { weekday } = serialToYMD(today);
  const monday = today - ((weekday + 6) % 7);
  const col = (i) => { let n = i; let s = ''; do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0); return s; };
  put(sh, 'A1', 'Project timeline', { bold: true, size: 18 });
  put(sh, 'C1', 'Starts', { ...MUTED, align: 'right' });
  put(sh, 'D1', iso(monday), { fmt: 'date', dateStyle: 'medium', color: INPUT, bold: true });
  ['Task', 'Owner', 'Start', 'End', 'Days'].forEach((h, i) => put(sh, `${'ABCDE'[i]}3`, h, HEAD));
  for (let i = 0; i < days; i++) {
    const c = col(5 + i);
    put(sh, `${c}3`, i === 0 ? '=$D$1' : `=${col(4 + i)}3+1`, { ...HEAD, fmt: 'custom', code: 'd', align: 'center', size: 10 });
    put(sh, `${c}2`, `=LEFT(TEXT(${c}3,"ddd"),1)`, { align: 'center', size: 9, ...MUTED });
  }
  const tasks = [
    ['Kickoff and scope', 'Ava', 0, 2], ['Research', 'Ben', 1, 6], ['Wireframes', 'Chloe', 5, 10], ['Visual design', 'Chloe', 9, 16],
    ['Build', 'Diego', 12, 26], ['Content', 'Emma', 14, 22], ['Testing', 'Ben', 24, 30], ['Launch', 'Ava', 31, 32],
  ];
  tasks.forEach(([task, owner, start, end], i) => {
    const r = 4 + i;
    put(sh, `A${r}`, task);
    put(sh, `B${r}`, owner, { color: INPUT });
    put(sh, `C${r}`, `=$D$1+${start}`, { fmt: 'date', color: INPUT });
    put(sh, `D${r}`, `=$D$1+${end}`, { fmt: 'date', color: INPUT });
    put(sh, `E${r}`, `=D${r}-C${r}+1`, { align: 'right' });
  });
  const lastRow = 3 + tasks.length;
  const grid = parseRange(`F4:${col(4 + days)}${lastRow}`);
  wb.addRule(sh.id, { range: grid, type: 'formula', value: '=AND(F$3>=$C4,F$3<=$D4)', style: { bg: '#337bfc', color: '#337bfc' } });
  wb.addRule(sh.id, { range: parseRange(`F2:${col(4 + days)}${lastRow}`), type: 'formula', value: '=F$3=TODAY()', style: { bg: '#fef3c7' } });
  wb.addRule(sh.id, { range: parseRange(`F4:${col(4 + days)}${lastRow}`), type: 'formula', value: '=WEEKDAY(F$3,2)>5', style: { bg: '#f2f1ee' } });
  put(sh, `A${lastRow + 2}`, 'Bars follow the start and end dates; change the project start in D1 to shift everything.', MUTED);
  wb.setFrozen(sh.id, 3, 5);
  return finish(wb, sh);
}

function calendar() {
  const colWidths = {};
  for (let c = 0; c < 7; c++) colWidths[c] = 120;
  const wb = new Workbook({ sheets: [{ name: 'Calendar', colWidths }] });
  const [sh] = wb.sheets;
  const today = todaySerial();
  const { y, m } = serialToYMD(today);
  put(sh, 'A1', '=TEXT(B2,"mmmm yyyy")', { bold: true, size: 20 });
  put(sh, 'A2', 'Month starts', MUTED);
  put(sh, 'B2', iso(ymdToSerial(y, m, 1)), { fmt: 'date', dateStyle: 'medium', color: INPUT, bold: true });
  put(sh, 'D2', 'Change the start date to move to another month. Monday-first weeks.', MUTED);
  ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].forEach((d, i) => put(sh, `${'ABCDEFG'[i]}4`, d, { ...HEAD, align: 'center' }));
  // Six weeks of day numbers: the first cell is the Monday on or before the 1st; days outside the month stay blank.
  put(sh, 'A5', '=IF(MONTH($B$2-WEEKDAY($B$2,2)+1)=MONTH($B$2),$B$2-WEEKDAY($B$2,2)+1,"")', { fmt: 'custom', code: 'd', align: 'right', bold: true });
  const dayCell = (r, c) => {
    const first = '$B$2-WEEKDAY($B$2,2)+1';
    const offset = (r - 5) * 2 * 7 / 2 + c; // rows of the grid step by two sheet rows
    const dayExpr = `${first}+${(r - 5) / 2 * 7 + c}`;
    put(sh, `${'ABCDEFG'[c]}${r}`, `=IF(MONTH(${dayExpr})=MONTH($B$2),${dayExpr},"")`, { fmt: 'custom', code: 'd', align: 'right', bold: true });
    void offset;
  };
  for (let week = 0; week < 6; week++) {
    const r = 5 + week * 2;
    for (let c = 0; c < 7; c++) {
      if (!(week === 0 && c === 0)) dayCell(r, c);
      put(sh, `${'ABCDEFG'[c]}${r + 1}`, '', { ...MUTED, wrap: true, valign: 'top', size: 11 });
    }
    wb.setRowHeight(sh.id, r, 22);
    wb.setRowHeight(sh.id, r + 1, 44);
  }
  wb.addRule(sh.id, { range: parseRange('A5:G15'), type: 'formula', value: '=A5=TODAY()', style: { bg: '#fef3c7', color: '#92400e' } });
  wb.addRule(sh.id, { range: parseRange('F5:G16'), type: 'formula', value: '=TRUE', style: { bg: '#f7f7f5' } });
  wb.applyBorders(sh.id, parseRange('A4:G16'), 'all', { color: '#e7e6e1' });
  put(sh, 'A18', 'Type notes into the space under each date; weekends are shaded and today is highlighted.', MUTED);
  return finish(wb, sh);
}

function habits() {
  const days = 31;
  const colWidths = { 0: 170 };
  for (let i = 0; i < days; i++) colWidths[1 + i] = 30;
  colWidths[1 + days] = 70; colWidths[2 + days] = 80;
  const wb = new Workbook({ sheets: [{ name: 'Habits', colWidths, cols: days + 6 }] });
  const [sh] = wb.sheets;
  const today = todaySerial();
  const { y, m } = serialToYMD(today);
  const col = (i) => { let n = i; let s = ''; do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0); return s; };
  put(sh, 'A1', 'Habit tracker', { bold: true, size: 18 });
  // The month lives under the title (the day columns are too narrow for it); everything keys off $A$2.
  put(sh, 'A2', iso(ymdToSerial(y, m, 1)), { fmt: 'custom', code: 'mmmm yyyy', color: INPUT, bold: true });
  put(sh, 'A3', 'Habit', HEAD);
  for (let i = 0; i < days; i++) {
    const c = col(1 + i);
    put(sh, `${c}2`, `=IF(DAY($A$2+${i})=${i + 1},LEFT(TEXT($A$2+${i},"ddd"),1),"")`, { align: 'center', size: 9, ...MUTED });
    put(sh, `${c}3`, `=IF(DAY($A$2+${i})=${i + 1},${i + 1},"")`, { ...HEAD, align: 'center', size: 10 });
  }
  put(sh, `${col(1 + days)}3`, 'Done', { ...HEAD, align: 'right' });
  put(sh, `${col(2 + days)}3`, 'Rate', { ...HEAD, align: 'right' });
  const list = ['Exercise', 'Read 20 minutes', 'No sugar', 'Sleep by 11', 'Write journal', 'Walk 10k steps'];
  list.forEach((h, i) => {
    const r = 4 + i;
    put(sh, `A${r}`, h, { color: INPUT });
    for (let d = 0; d < days; d++) if ((d + i) % 3 === 0 && d < 10) put(sh, `${col(1 + d)}${r}`, 'TRUE', { align: 'center' });
    put(sh, `${col(1 + days)}${r}`, `=COUNTIF(B${r}:${col(days)}${r},TRUE)`, { align: 'right' });
    put(sh, `${col(2 + days)}${r}`, `=IFERROR(${col(1 + days)}${r}/MAX(1,COUNTIF(B$3:${col(days)}$3,">0")),0)`, { fmt: 'percent', dec: 0, align: 'right' });
  });
  const last = 3 + list.length;
  put(sh, `A${last + 2}`, 'Best day', { bold: true });
  put(sh, `B${last + 2}`, `=IFERROR(INDEX(B3:${col(days)}3,MATCH(MAX(B${last + 3}:${col(days)}${last + 3}),B${last + 3}:${col(days)}${last + 3},0)),"")`, { bold: true, align: 'left' });
  put(sh, `A${last + 3}`, 'Habits done per day', MUTED);
  for (let d = 0; d < days; d++) put(sh, `${col(1 + d)}${last + 3}`, `=IF(${col(1 + d)}3="","",COUNTIF(${col(1 + d)}4:${col(1 + d)}${last},TRUE))`, { align: 'center', size: 10, ...MUTED });
  wb.addValidation(sh.id, { range: parseRange(`B4:${col(days)}${last}`), type: 'checkbox', strict: true, allowBlank: true });
  wb.addRule(sh.id, { range: parseRange(`${col(2 + days)}4:${col(2 + days)}${last}`), type: 'databar', style: {}, barColor: '#a7d9b5' });
  wb.addRule(sh.id, { range: parseRange(`B2:${col(days)}${last}`), type: 'formula', value: '=$A$2+COLUMN()-2=TODAY()', style: { bg: '#fef3c7' } });
  wb.setFrozen(sh.id, 3, 1);
  return finish(wb, sh);
}

/**
 * The gallery: each template's name and description are messages, read where they are shown (and the
 * name, too, for the new file's default name), never here at import time, before the language is loaded.
 */
const template = (id, nameKey, descriptionKey, iconName, build) => ({
  id, icon: iconName, build, nameKey, descriptionKey,
  get name() { return t(this.nameKey); },
  get description() { return t(this.descriptionKey); },
});

export const TEMPLATES = [
  template('blank', 'coreTemplates.blank.name', 'coreTemplates.blank.description', 'filePlus', () => new Workbook()),
  template('budget', 'coreTemplates.budget.name', 'coreTemplates.budget.description', 'currency', () => sampleWorkbook()),
  template('expenses', 'coreTemplates.expenses.name', 'coreTemplates.expenses.description', 'chartPie', expenses),
  template('invoice', 'coreTemplates.invoice.name', 'coreTemplates.invoice.description', 'sheet', invoice),
  template('todo', 'coreTemplates.todo.name', 'coreTemplates.todo.description', 'check', todo),
  template('loan', 'coreTemplates.loan.name', 'coreTemplates.loan.description', 'percent', loan),
  template('gradebook', 'coreTemplates.gradebook.name', 'coreTemplates.gradebook.description', 'sparkle', gradebook),
  template('schedule', 'coreTemplates.schedule.name', 'coreTemplates.schedule.description', 'calendar', schedule),
  template('timeline', 'coreTemplates.timeline.name', 'coreTemplates.timeline.description', 'rows', timeline),
  template('calendar', 'coreTemplates.calendar.name', 'coreTemplates.calendar.description', 'calendar', calendar),
  template('habits', 'coreTemplates.habits.name', 'coreTemplates.habits.description', 'check', habits),
];

export function templateById(id) {
  return TEMPLATES.find((tpl) => tpl.id === id) || null;
}
