/*
 * The script runtime: the workbook object model a script's `main(workbook)` is given. This file is not a module of
 * the app: script-run.js reads it as text and the sandbox runs it, followed by the script's own code, in a worker
 * that has no access to the app, its page, its storage or the network (see lib/script-sandbox.js). Everything a
 * script does to the workbook leaves here as a message; the app checks and applies each one (see script-host.js).
 *
 * Writes are queued and sent in batches; a read sends what is queued first, so it sees every earlier write, and
 * answers asynchronously. Each message carries the line of the script that made it, for error messages.
 *
 * Indices are 0-based (row 0 is row 1 of the sheet); addresses are A1 notation ("B2", "A1:C10", "A:C", "3:5").
 */
(function () {
  'use strict';
  var scope = self;
  var post = scope.postMessage.bind(scope);
  var SELF_URL = '';
  try { SELF_URL = String(scope.location && scope.location.href || ''); } catch (e) { /* no location */ }
  var MAX_ROW = 1048575;
  var MAX_COL = 16383;
  var userFirst = 1;
  var userLast = Infinity;

  /* ---------- Isolation ---------- */

  // Whatever could reach beyond the workbook: the network, storage, other workers, the page. The sandbox's origin
  // already holds none of the app's data and its policy refuses network requests; these go as well, so a script
  // finds them plainly missing rather than failing obscurely.
  var BLOCKED = ['fetch', 'XMLHttpRequest', 'WebSocket', 'WebSocketStream', 'EventSource', 'WebTransport', 'importScripts',
    'indexedDB', 'caches', 'Worker', 'SharedWorker', 'BroadcastChannel', 'navigator', 'Request', 'Response', 'Headers',
    'FileReaderSync', 'FileSystemHandle', 'FileSystemDirectoryHandle', 'FileSystemFileHandle', 'FileSystemSyncAccessHandle',
    'IDBFactory', 'CacheStorage', 'StorageManager', 'CookieStore', 'cookieStore', 'webkitRequestFileSystem',
    'webkitRequestFileSystemSync', 'webkitResolveLocalFileSystemURL', 'webkitResolveLocalFileSystemSyncURL',
    'location', 'origin', 'window', 'document', 'parent', 'top', 'opener', 'frames', 'localStorage', 'sessionStorage',
    'puter', 'require', 'process', 'module', 'Deno', 'Bun'];
  BLOCKED.forEach(function (name) {
    for (var o = scope; o; o = Object.getPrototypeOf(o)) {
      try { if (Object.prototype.hasOwnProperty.call(o, name)) delete o[name]; } catch (e) { /* not deletable */ }
    }
    try { Object.defineProperty(scope, name, { value: undefined, writable: false, configurable: false, enumerable: false }); } catch (e) { /* frozen already */ }
  });

  /* ---------- Lines ---------- */

  /** The line of the script's own code that the current call came from, or 0. */
  function callerLine(stack) {
    var text = String(stack == null ? new Error().stack : stack || '');
    var lines = text.split('\n');
    for (var i = 0; i < lines.length; i++) {
      var m = /:(\d+):(\d+)\)?\s*$/.exec(lines[i]);
      if (!m) continue;
      if (SELF_URL && lines[i].indexOf(SELF_URL) < 0) continue;
      var n = Number(m[1]);
      if (n >= userFirst && n <= userLast) return n - userFirst + 1;
    }
    return 0;
  }

  /** An error with the script line it is about. */
  function ScriptError(message, line) {
    var e = new Error(message);
    e.name = 'ScriptError';
    e.scriptLine = line || callerLine();
    return e;
  }
  function fail(message) { throw ScriptError(message); }

  /* ---------- Messages ---------- */

  var queue = [];
  var flushing = false;
  var nextRead = 1;
  var pending = new Map();
  var finished = false;

  function flush() {
    flushing = false;
    if (!queue.length) return;
    var batch = queue;
    queue = [];
    post({ type: 'ops', ops: batch });
  }
  function write(op) {
    if (finished) fail('The script has already finished; changes made after main() returns are not applied. Await every promise inside main().');
    op.line = callerLine();
    queue.push(op);
    if (queue.length >= 2000) flush();
    else if (!flushing) { flushing = true; Promise.resolve().then(flush); }
  }
  function read(op) {
    if (finished) return Promise.reject(ScriptError('The script has already finished.'));
    op.line = callerLine();
    flush();
    var id = nextRead++;
    post({ type: 'read', id: id, op: op });
    return new Promise(function (resolve, reject) { pending.set(id, { resolve: resolve, reject: reject, line: op.line }); });
  }

  /* ---------- Console ---------- */

  function describe(value, depth, seen) {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    var t = typeof value;
    if (t === 'string') return depth ? JSON.stringify(value) : value;
    if (t === 'number' || t === 'boolean' || t === 'bigint') return String(value);
    if (t === 'symbol') return value.toString();
    if (t === 'function') return '[Function ' + (value.name || 'anonymous') + ']';
    if (value instanceof Error) return (value.name || 'Error') + ': ' + value.message;
    if (value instanceof Date) return isNaN(value) ? 'Invalid Date' : value.toISOString();
    if (typeof value.then === 'function') return 'Promise { … } (use await to get its value)';
    if (value instanceof Range) return 'Range ' + value.getAddress();
    if (value instanceof Worksheet) return 'Worksheet ' + value.getName();
    if (seen.indexOf(value) >= 0) return '[Circular]';
    if (depth > 3) return Array.isArray(value) ? '[…]' : '{…}';
    seen = seen.concat([value]);
    if (Array.isArray(value)) {
      var items = value.slice(0, 100).map(function (v) { return describe(v, depth + 1, seen); });
      if (value.length > 100) items.push('… ' + (value.length - 100) + ' more');
      return '[' + items.join(', ') + ']';
    }
    var keys = Object.keys(value);
    var parts = keys.slice(0, 50).map(function (k) { return k + ': ' + describe(value[k], depth + 1, seen); });
    if (keys.length > 50) parts.push('…');
    return '{ ' + parts.join(', ') + ' }';
  }
  var logged = 0;
  function log(level, args) {
    if (++logged > 5000) { if (logged === 5001) post({ type: 'log', level: 'warn', text: 'Too much output: later messages are not shown.', line: 0 }); return; }
    var text = Array.prototype.map.call(args, function (a) { return describe(a, 0, []); }).join(' ');
    if (text.length > 20000) text = text.slice(0, 20000) + '…';
    post({ type: 'log', level: level, text: text, line: callerLine() });
  }
  var scriptConsole = {};
  ['log', 'info', 'warn', 'error', 'debug'].forEach(function (level) {
    scriptConsole[level] = function () { log(level === 'debug' ? 'log' : level, arguments); };
  });
  scriptConsole.table = function (data) { log('log', [data]); };
  scriptConsole.clear = function () { post({ type: 'clear' }); };
  Object.defineProperty(scope, 'console', { value: Object.freeze(scriptConsole), writable: false, configurable: false });

  /* ---------- Addresses ---------- */

  function colName(c) { var s = ''; c += 1; while (c > 0) { var m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); } return s; }
  function colIndex(text) { var n = 0; for (var i = 0; i < text.length; i++) n = n * 26 + (text.charCodeAt(i) - 64); return n - 1; }
  /** "B2", "A1:C10", "A:C" or "3:5" (with or without $) as { r1, c1, r2, c2 }; null when it is none of those. */
  function parseAddress(text) {
    var t = String(text).trim().replace(/\$/g, '').toUpperCase();
    var m;
    if ((m = /^([A-Z]{1,3})(\d{1,7})(?::([A-Z]{1,3})(\d{1,7}))?$/.exec(t))) {
      var a = { r: Number(m[2]) - 1, c: colIndex(m[1]) };
      var b = m[3] ? { r: Number(m[4]) - 1, c: colIndex(m[3]) } : a;
      return box(a.r, a.c, b.r, b.c);
    }
    if ((m = /^([A-Z]{1,3}):([A-Z]{1,3})$/.exec(t))) return box(0, colIndex(m[1]), MAX_ROW, colIndex(m[2]));
    if ((m = /^(\d{1,7}):(\d{1,7})$/.exec(t))) return box(Number(m[1]) - 1, 0, Number(m[2]) - 1, MAX_COL);
    return null;
  }
  function box(r1, c1, r2, c2) {
    var b = { r1: Math.min(r1, r2), c1: Math.min(c1, c2), r2: Math.max(r1, r2), c2: Math.max(c1, c2) };
    if (b.r1 < 0 || b.c1 < 0 || b.r2 > MAX_ROW || b.c2 > MAX_COL) return null;
    return b;
  }
  function addressOf(b) {
    var wholeCols = b.r1 === 0 && b.r2 === MAX_ROW, wholeRows = b.c1 === 0 && b.c2 === MAX_COL;
    if (wholeCols && wholeRows) return 'A:' + colName(MAX_COL);
    if (wholeCols) return colName(b.c1) + ':' + colName(b.c2);
    if (wholeRows) return (b.r1 + 1) + ':' + (b.r2 + 1);
    var a = colName(b.c1) + (b.r1 + 1);
    return b.r1 === b.r2 && b.c1 === b.c2 ? a : a + ':' + colName(b.c2) + (b.r2 + 1);
  }
  function quoteSheet(name) { return /^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) && !/^[A-Za-z]{1,3}\d+$/.test(name) ? name : "'" + name.replace(/'/g, "''") + "'"; }
  function int(n, what, min) {
    if (typeof n !== 'number' || !Number.isInteger(n)) fail(what + ' must be a whole number, not ' + describe(n, 1, []));
    if (min != null && n < min) fail(what + ' must be at least ' + min + '.');
    return n;
  }
  function bool(v, what) { if (typeof v !== 'boolean') fail(what + ' must be true or false.'); return v; }

  /* ---------- Colours ---------- */

  var NAMED = { black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff', yellow: '#ffff00',
    orange: '#ffa500', purple: '#800080', gray: '#808080', grey: '#808080', silver: '#c0c0c0', navy: '#000080', teal: '#008080',
    maroon: '#800000', olive: '#808000', lime: '#00ff00', aqua: '#00ffff', cyan: '#00ffff', fuchsia: '#ff00ff', magenta: '#ff00ff', pink: '#ffc0cb' };
  function color(value, what) {
    if (value == null || value === '' || value === 'none') return null;
    var v = String(value).trim().toLowerCase();
    if (NAMED[v]) return NAMED[v];
    var m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/.exec(v);
    if (!m) fail(what + ' must be a colour such as "#1f6feb" or "red", not ' + describe(value, 1, []) + '.');
    var hex = m[1].length === 3 ? m[1].split('').map(function (ch) { return ch + ch; }).join('') : m[1];
    return '#' + hex;
  }

  /* ---------- The workbook mirror ---------- */

  var book = { name: '', sheets: [], activeId: null, selection: null, tableNames: [] };
  var tokens = 0;
  function sheetEntry(id) {
    for (var i = 0; i < book.sheets.length; i++) if (book.sheets[i].id === id) return book.sheets[i];
    return null;
  }
  function live(id) {
    var s = sheetEntry(id);
    if (!s) fail('That worksheet has been deleted.');
    return s;
  }
  var INVALID_SHEET = /[\\/?*:[\]]/;
  function sheetNameProblem(name, exceptId) {
    if (typeof name !== 'string' || !name.trim()) return 'A sheet name cannot be blank.';
    if (name.length > 31) return 'A sheet name can be at most 31 characters.';
    if (INVALID_SHEET.test(name)) return 'A sheet name cannot contain \\ / ? * : [ ]';
    if (/^'|'$/.test(name)) return 'A sheet name cannot begin or end with an apostrophe.';
    var lower = name.toLowerCase();
    for (var i = 0; i < book.sheets.length; i++) if (book.sheets[i].id !== exceptId && book.sheets[i].name.toLowerCase() === lower) return 'There is already a sheet named "' + name + '".';
    return null;
  }
  function adopt(sheets) { if (Array.isArray(sheets)) book.sheets = sheets; }

  /* ---------- Values ---------- */

  function cellValue(v, where) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number') { if (!isFinite(v)) fail(where + ': ' + v + ' is not a number a cell can hold.'); return v; }
    if (typeof v === 'string' || typeof v === 'boolean') return v;
    if (v instanceof Date) { if (isNaN(v)) fail(where + ': the date is invalid.'); return v; }
    if (v && typeof v.then === 'function') fail(where + ' is a Promise. Did you forget await?');
    fail(where + ' must be text, a number, true/false, a Date or null, not ' + describe(v, 1, []) + '.');
  }
  function grid(rows, range, what) {
    if (rows && typeof rows.then === 'function') fail(what + ' was given a Promise. Did you forget await?');
    var h = range.getRowCount(), w = range.getColumnCount();
    if (!Array.isArray(rows) || !rows.every(Array.isArray)) fail(what + ' takes an array of rows, each an array of values, e.g. [[1, 2], [3, 4]].');
    if (rows.length !== h || rows.some(function (row) { return row.length !== w; })) {
      fail(what + ': ' + range.getAddress() + ' is ' + h + ' row(s) by ' + w + ' column(s), but the values are ' + rows.length + ' by ' + (rows[0] ? rows[0].length : 0) + '.');
    }
    if (h * w > 1000000) fail(what + ': at most 1,000,000 cells at once.');
    return rows.map(function (row, r) { return row.map(function (v, c) { return cellValue(v, 'The value for ' + colName(range._b.c1 + c) + (range._b.r1 + r + 1)); }); });
  }

  /* ---------- Object model ---------- */

  function Workbook() {}
  Workbook.prototype = {
    /** The workbook's file name. */
    getName: function () { return book.name; },
    /** The sheet in front. */
    getActiveWorksheet: function () { return new Worksheet(book.activeId); },
    /** Every sheet, hidden ones included, in tab order. */
    getWorksheets: function () { return book.sheets.map(function (s) { return new Worksheet(s.id); }); },
    /** The sheet with this name (any case), or null. */
    getWorksheet: function (name) {
      var lower = String(name).toLowerCase();
      for (var i = 0; i < book.sheets.length; i++) if (book.sheets[i].name.toLowerCase() === lower) return new Worksheet(book.sheets[i].id);
      return null;
    },
    /** A new sheet, named `name` or the next free "SheetN", at position `index` (the end by default). */
    addWorksheet: function (name, index) {
      if (name == null) { var n = book.sheets.length + 1; while (sheetNameProblem('Sheet' + n)) n++; name = 'Sheet' + n; }
      var problem = sheetNameProblem(name);
      if (problem) fail(problem);
      var at = index == null ? book.sheets.length : Math.max(0, Math.min(book.sheets.length, int(index, 'The position', 0)));
      var id = 'new:' + (++tokens);
      book.sheets.splice(at, 0, { id: id, name: name, hidden: false, kind: 'grid' });
      write({ op: 'addSheet', token: id, name: name, index: at });
      return new Worksheet(id);
    },
    /** The cells selected when the script started (or last selected by it). */
    getSelectedRange: function () {
      var sel = book.selection;
      if (!sel || !sheetEntry(sel.sheet)) return new Worksheet(book.activeId).getRange('A1');
      return new Worksheet(sel.sheet).getRange(sel.address);
    },
    /** The tables of the workbook. */
    getTables: function () {
      return read({ op: 'tables' }).then(function (list) { return list.map(function (t) { return new Table(t.sheet, t.name); }); });
    },
    /** The table with this name (any case), or null. */
    getTable: function (name) {
      return this.getTables().then(function (list) {
        var lower = String(name).toLowerCase();
        return list.filter(function (t) { return t.getName().toLowerCase() === lower; })[0] || null;
      });
    },
  };

  function Worksheet(id) { this._id = id; }
  Worksheet.prototype = {
    getName: function () { return live(this._id).name; },
    setName: function (name) {
      var s = live(this._id);
      var problem = sheetNameProblem(name, this._id);
      if (problem) fail(problem);
      write({ op: 'renameSheet', sheet: this._id, name: name });
      s.name = name;
      return this;
    },
    /** Its position among the tabs, from 0. */
    getPosition: function () { live(this._id); return book.sheets.findIndex(function (s) { return s.id === this._id; }, this); },
    /** Move the tab to position `index`, from 0. */
    setPosition: function (index) {
      var s = live(this._id);
      var at = Math.min(book.sheets.length - 1, int(index, 'The position', 0));
      write({ op: 'moveSheet', sheet: this._id, index: at });
      book.sheets = book.sheets.filter(function (x) { return x !== s; });
      book.sheets.splice(at, 0, s);
      return this;
    },
    getVisible: function () { return !live(this._id).hidden; },
    setVisible: function (visible) {
      var s = live(this._id);
      bool(visible, 'setVisible');
      if (!visible && book.sheets.filter(function (x) { return !x.hidden; }).length <= 1 && !s.hidden) fail('The last visible sheet cannot be hidden.');
      write({ op: 'sheetVisible', sheet: this._id, visible: visible });
      s.hidden = !visible;
      return this;
    },
    /** Bring this sheet to the front. */
    activate: function () {
      var s = live(this._id);
      write({ op: 'activate', sheet: this._id });
      s.hidden = false;
      book.activeId = this._id;
      return this;
    },
    delete: function () {
      var s = live(this._id);
      if (book.sheets.filter(function (x) { return !x.hidden; }).length <= 1 && !s.hidden) fail('The last visible sheet cannot be deleted.');
      write({ op: 'deleteSheet', sheet: this._id });
      book.sheets = book.sheets.filter(function (x) { return x !== s; });
      if (book.activeId === this._id) book.activeId = (book.sheets.filter(function (x) { return !x.hidden; })[0] || book.sheets[0]).id;
    },
    setTabColor: function (value) { live(this._id); write({ op: 'tabColor', sheet: this._id, color: color(value, 'The tab colour') }); return this; },
    /** Cells by address ("A1", "B2:D9", "A:C", "3:5"); with no address, the whole sheet. */
    getRange: function (address) {
      live(this._id);
      if (address == null) return new Range(this._id, { r1: 0, c1: 0, r2: MAX_ROW, c2: MAX_COL });
      var text = String(address);
      var bang = text.lastIndexOf('!');
      if (bang > 0) {
        var other = new Workbook().getWorksheet(text.slice(0, bang).replace(/^'(.*)'$/, '$1').replace(/''/g, "'"));
        if (!other) fail('There is no sheet named ' + text.slice(0, bang) + '.');
        return other.getRange(text.slice(bang + 1));
      }
      var b = parseAddress(text);
      if (!b) fail('"' + text + '" is not an address. Use A1 notation such as "B2", "A1:C10", "A:C" or "3:5".');
      return new Range(this._id, b);
    },
    /** One cell by its 0-based row and column. */
    getCell: function (row, column) {
      var b = box(int(row, 'The row', 0), int(column, 'The column', 0), row, column);
      if (!b) fail('That cell is outside the sheet.');
      return new Range(live(this._id) && this._id, b);
    },
    /** The block from the first to the last cell holding anything; null when the sheet is empty. */
    getUsedRange: function (valuesOnly) {
      var id = this._id;
      return read({ op: 'usedRange', sheet: id, valuesOnly: !!valuesOnly }).then(function (address) { return address ? new Range(id, parseAddress(address)) : null; });
    },
    freezePanes: function (rows, columns) {
      live(this._id);
      write({ op: 'freeze', sheet: this._id, rows: int(rows || 0, 'The rows to freeze', 0), cols: int(columns || 0, 'The columns to freeze', 0) });
      return this;
    },
    freezeRows: function (rows) { return this.freezePanes(rows == null ? 1 : rows, 0); },
    freezeColumns: function (columns) { return this.freezePanes(0, columns == null ? 1 : columns); },
    unfreeze: function () { return this.freezePanes(0, 0); },
    showGridlines: function (on) { live(this._id); write({ op: 'gridlines', sheet: this._id, on: bool(on, 'showGridlines') }); return this; },
    /** Make a table of a block; its first row is the header unless `hasHeaders` is false. Returns the Table. */
    addTable: function (address, options) {
      var range = address instanceof Range ? address : this.getRange(address);
      options = options || {};
      var name = options.name == null ? null : String(options.name);
      if (name != null && !/^[A-Za-z_\\][A-Za-z0-9_.]{0,254}$/.test(name)) fail('"' + name + '" cannot be a table name: use letters, digits, _ and ., starting with a letter.');
      var taken = book.tableNames.map(function (t) { return t.toLowerCase(); });
      if (name == null) { var n = 1; while (taken.indexOf('table' + n) >= 0) n++; name = 'Table' + n; }
      else if (taken.indexOf(name.toLowerCase()) >= 0) fail('There is already a table named "' + name + '".');
      book.tableNames.push(name);
      var token = 'table:' + (++tokens);
      write({ op: 'addTable', sheet: range._sheet, a: addressOf(range._b), token: token, name: name, hasHeaders: options.hasHeaders !== false, style: options.style == null ? null : String(options.style) });
      return new Table(range._sheet, name, token);
    },
    /** Insert a chart of `type` ("column", "bar", "line", "pie", "area", "scatter"…) drawn from a block. */
    addChart: function (type, address, options) {
      var range = address instanceof Range ? address : this.getRange(address);
      options = options || {};
      write({ op: 'addChart', sheet: range._sheet, a: addressOf(range._b), type: String(type || 'column'), title: options.title == null ? '' : String(options.title),
        at: options.at == null ? null : String(options.at), width: options.width == null ? null : int(options.width, 'The width', 40), height: options.height == null ? null : int(options.height, 'The height', 40) });
    },
    getTables: function () {
      var id = this._id;
      return read({ op: 'tables', sheet: id }).then(function (list) { return list.map(function (t) { return new Table(t.sheet, t.name); }); });
    },
  };

  function Table(sheet, name, token) { this._sheet = sheet; this._name = name; this._token = token || null; }
  Table.prototype = {
    getName: function () { return this._name; },
    getWorksheet: function () { return new Worksheet(this._sheet); },
    _ref: function () { return this._token && this._name == null ? { token: this._token } : { name: this._name, token: this._token }; },
    setName: function (name) {
      if (!/^[A-Za-z_\\][A-Za-z0-9_.]{0,254}$/.test(String(name))) fail('"' + name + '" cannot be a table name.');
      var was = this._name;
      write({ op: 'renameTable', table: this._ref(), name: String(name) });
      book.tableNames = book.tableNames.filter(function (t) { return t !== was; }).concat([String(name)]);
      this._name = String(name);
      return this;
    },
    setStyle: function (style) { write({ op: 'tableStyle', table: this._ref(), style: String(style) }); return this; },
    setShowTotals: function (on) { write({ op: 'tableTotals', table: this._ref(), on: bool(on, 'setShowTotals') }); return this; },
    /** The table's cells, header and totals included. */
    getRange: function () {
      var self = this;
      return read({ op: 'tableRange', table: this._ref() }).then(function (t) { self._name = t.name; return new Range(t.sheet, parseAddress(t.address)); });
    },
    /** Turn the table back into a plain range, keeping its cells. */
    convertToRange: function () { write({ op: 'tableConvert', table: this._ref() }); },
  };

  function Range(sheet, b) { this._sheet = sheet; this._b = b; }
  function edge(value, allowed, what) {
    if (allowed.indexOf(value) < 0) fail(what + ' must be one of ' + allowed.map(function (a) { return '"' + a + '"'; }).join(', ') + '.');
    return value;
  }
  Range.prototype = {
    getWorksheet: function () { return new Worksheet(this._sheet); },
    /** "Sheet1!A1:B2"; with { sheet: false }, "A1:B2". */
    getAddress: function (options) {
      var local = addressOf(this._b);
      return options && options.sheet === false ? local : quoteSheet(live(this._sheet).name) + '!' + local;
    },
    getRowIndex: function () { return this._b.r1; },
    getColumnIndex: function () { return this._b.c1; },
    getRowCount: function () { return this._b.r2 - this._b.r1 + 1; },
    getColumnCount: function () { return this._b.c2 - this._b.c1 + 1; },
    getCellCount: function () { return this.getRowCount() * this.getColumnCount(); },
    /** The cell at a 0-based row and column inside this range (it may lie outside it). */
    getCell: function (row, column) {
      var b = box(this._b.r1 + int(row, 'The row'), this._b.c1 + int(column, 'The column'), this._b.r1 + row, this._b.c1 + column);
      if (!b) fail('That cell is outside the sheet.');
      return new Range(this._sheet, b);
    },
    getRow: function (i) { var r = this._b.r1 + int(i, 'The row', 0); return this._sub(r, this._b.c1, r, this._b.c2); },
    getColumn: function (j) { var c = this._b.c1 + int(j, 'The column', 0); return this._sub(this._b.r1, c, this._b.r2, c); },
    /** The same-sized range moved by rows and columns. */
    getOffsetRange: function (rows, columns) {
      int(rows, 'The row offset'); int(columns, 'The column offset');
      return this._sub(this._b.r1 + rows, this._b.c1 + columns, this._b.r2 + rows, this._b.c2 + columns);
    },
    /** The range grown (or shrunk) at its bottom and right by rows and columns. */
    getResizedRange: function (rows, columns) {
      int(rows, 'The rows to add'); int(columns, 'The columns to add');
      if (this._b.r2 + rows < this._b.r1 || this._b.c2 + columns < this._b.c1) fail('A range cannot shrink below one cell.');
      return this._sub(this._b.r1, this._b.c1, this._b.r2 + rows, this._b.c2 + columns);
    },
    getEntireRow: function () { return this._sub(this._b.r1, 0, this._b.r2, MAX_COL); },
    getEntireColumn: function () { return this._sub(0, this._b.c1, MAX_ROW, this._b.c2); },
    getLastCell: function () { return this._sub(this._b.r2, this._b.c2, this._b.r2, this._b.c2); },
    _sub: function (r1, c1, r2, c2) {
      var b = box(r1, c1, r2, c2);
      if (!b || r1 > r2 || c1 > c2) fail('That range is outside the sheet.');
      return new Range(this._sheet, b);
    },
    _ref: function () { live(this._sheet); return { sheet: this._sheet, a: addressOf(this._b) }; },
    _with: function (extra) { var o = this._ref(); for (var k in extra) o[k] = extra[k]; return o; },

    /* Reading (asynchronous: await the answer) */
    /** The values: numbers, text, true/false, or null for an empty cell; an error shows as its text ("#DIV/0!"). */
    getValues: function () { return read(this._with({ op: 'values' })); },
    getValue: function () { return read(this.getCell(0, 0)._with({ op: 'values' })).then(function (v) { return v[0][0]; }); },
    /** What each cell holds as typed: a formula ("=A1*2") or its value. */
    getFormulas: function () { return read(this._with({ op: 'formulas' })); },
    getFormula: function () { return read(this.getCell(0, 0)._with({ op: 'formulas' })).then(function (v) { return v[0][0]; }); },
    /** The text each cell shows, formatted. */
    getTexts: function () { return read(this._with({ op: 'texts' })); },
    getText: function () { return read(this.getCell(0, 0)._with({ op: 'texts' })).then(function (v) { return v[0][0]; }); },
    getNumberFormat: function () { return read(this.getCell(0, 0)._with({ op: 'numberFormat' })); },
    getNote: function () { return read(this.getCell(0, 0)._with({ op: 'note' })); },

    /* Writing */
    /** Values, each as if typed: "=SUM(A1:A3)" is a formula, "12%" a percentage. With { asText: true }, text stays text. */
    setValues: function (rows, options) {
      write(this._with({ op: 'write', rows: grid(rows, this, 'setValues'), asText: !!(options && options.asText) }));
      return this;
    },
    setValue: function (value, options) {
      var rows = [];
      for (var r = 0; r < this.getRowCount(); r++) { var row = []; for (var c = 0; c < this.getColumnCount(); c++) row.push(value); rows.push(row); }
      if (this.getCellCount() > 1000000) fail('setValue: at most 1,000,000 cells at once.');
      return this.setValues(rows, options);
    },
    setFormulas: function (rows) { return this.setValues(rows); },
    /** One formula; over several cells its references move with each cell, as a fill does. */
    setFormula: function (formula) {
      if (typeof formula !== 'string') fail('setFormula takes the formula as text, e.g. "=SUM(A1:A3)".');
      write(this._with({ op: 'fillFormula', formula: formula }));
      return this;
    },
    setNumberFormat: function (code) { write(this._with({ op: 'numberFormat', code: String(code) })); return this; },
    /** Clear "all" (the default), "contents" or "formats". */
    clear: function (what) { write(this._with({ op: 'clear', what: edge(what || 'all', ['all', 'contents', 'formats'], 'clear') })); return this; },
    /** Insert cells here, pushing the rest "down" or "right"; whole rows or columns are inserted as such. */
    insert: function (shift) { write(this._with({ op: 'insert', shift: edge(shift || 'down', ['down', 'right'], 'insert') })); return this; },
    /** Delete these cells, pulling the rest "up" or "left"; whole rows or columns are deleted as such. */
    delete: function (shift) { write(this._with({ op: 'delete', shift: edge(shift || 'up', ['up', 'left'], 'delete') })); },
    merge: function (across) { write(this._with({ op: 'merge', across: !!across })); return this; },
    unmerge: function () { write(this._with({ op: 'unmerge' })); return this; },
    /** Sort the rows by keys: [{ column: 0, ascending: true }], column counted from the range's left. */
    sort: function (keys, options) {
      if (keys == null) keys = [{ column: 0, ascending: true }];
      if (!Array.isArray(keys)) keys = [keys];
      var w = this.getColumnCount();
      var clean = keys.map(function (k) {
        var column = typeof k === 'number' ? k : k && k.column;
        int(column, 'The sort column', 0);
        if (column >= w) fail('Sort column ' + column + ' is outside the range, which is ' + w + ' column(s) wide.');
        return { column: column, ascending: !(k && k.ascending === false) };
      });
      if (!clean.length) fail('Give at least one sort key.');
      write(this._with({ op: 'sort', keys: clean, hasHeaders: !!(options && options.hasHeaders), matchCase: !!(options && options.matchCase) }));
      return this;
    },
    /** Extend this range's pattern into `destination` (a range that contains it), as dragging the fill handle does. */
    autoFill: function (destination) {
      var to = destination instanceof Range ? destination : this.getWorksheet().getRange(destination);
      write(this._with({ op: 'fill', to: addressOf(to._b) }));
      return to;
    },
    /** Remove rows whose values repeat in the given columns (all by default). */
    removeDuplicates: function (columns, hasHeaders) {
      write(this._with({ op: 'dedupe', columns: columns == null ? null : columns.map(function (c) { return int(c, 'The column', 0); }), hasHeaders: !!hasHeaders }));
      return this;
    },
    setRowsHidden: function (hidden) { write(this._with({ op: 'hide', axis: 'row', hidden: bool(hidden, 'setRowsHidden') })); return this; },
    setColumnsHidden: function (hidden) { write(this._with({ op: 'hide', axis: 'col', hidden: bool(hidden, 'setColumnsHidden') })); return this; },
    setNote: function (text) { write(this.getCell(0, 0)._with({ op: 'note', text: text == null ? '' : String(text) })); return this; },
    setHyperlink: function (url) { write(this.getCell(0, 0)._with({ op: 'link', url: url == null ? '' : String(url) })); return this; },
    /** Select these cells (and bring their sheet to the front). */
    select: function () {
      write(this._with({ op: 'select' }));
      book.selection = { sheet: this._sheet, address: addressOf(this._b) };
      book.activeId = this._sheet;
      return this;
    },
    getFormat: function () { return new Format(this); },
  };

  function Format(range) { this._range = range; }
  function style(range, patch) { write(range._with({ op: 'style', patch: patch })); }
  function styleRead(range, key) { return read(range.getCell(0, 0)._with({ op: 'style', key: key })); }
  var BORDER_EDGES = { all: 'all', outline: 'outer', inside: 'inner', top: 'top', bottom: 'bottom', left: 'left', right: 'right', horizontal: 'horizontal', vertical: 'vertical', none: 'none' };
  Format.prototype = {
    getFill: function () {
      var range = this._range;
      return {
        setColor: function (value) { style(range, { bg: color(value, 'The fill colour') }); return this; },
        clear: function () { style(range, { bg: null }); return this; },
        getColor: function () { return styleRead(range, 'bg'); },
      };
    },
    getFont: function () {
      var range = this._range;
      var flag = function (key, name) { return function (on) { style(range, (function () { var p = {}; p[key] = bool(on === undefined ? true : on, name) || null; return p; })()); return this; }; };
      return {
        setBold: flag('bold', 'setBold'),
        setItalic: flag('italic', 'setItalic'),
        setUnderline: flag('underline', 'setUnderline'),
        setStrikethrough: flag('strike', 'setStrikethrough'),
        setColor: function (value) { style(range, { color: color(value, 'The font colour') }); return this; },
        /** The size in points. */
        setSize: function (points) {
          if (typeof points !== 'number' || !(points >= 1 && points <= 409)) fail('The font size must be a number of points from 1 to 409.');
          style(range, { size: points });
          return this;
        },
        setName: function (name) { style(range, { font: String(name) }); return this; },
        getBold: function () { return styleRead(range, 'bold'); },
        getItalic: function () { return styleRead(range, 'italic'); },
        getUnderline: function () { return styleRead(range, 'underline'); },
        getStrikethrough: function () { return styleRead(range, 'strike'); },
        getColor: function () { return styleRead(range, 'color'); },
        getSize: function () { return styleRead(range, 'size'); },
        getName: function () { return styleRead(range, 'font'); },
      };
    },
    /** "left", "center", "right" or "general". */
    setHorizontalAlignment: function (a) { style(this._range, { align: edge(a, ['left', 'center', 'right', 'general'], 'The alignment') }); return this; },
    /** "top", "middle" or "bottom". */
    setVerticalAlignment: function (a) { style(this._range, { valign: edge(a, ['top', 'middle', 'bottom'], 'The vertical alignment') }); return this; },
    setWrapText: function (on) { style(this._range, { wrap: bool(on, 'setWrapText') }); return this; },
    /** Degrees from -90 to 90. */
    setTextRotation: function (deg) { if (typeof deg !== 'number' || deg < -90 || deg > 90) fail('The rotation must be from -90 to 90 degrees.'); style(this._range, { rot: deg }); return this; },
    setIndent: function (n) { style(this._range, { indent: int(n, 'The indent', 0) }); return this; },
    getHorizontalAlignment: function () { return styleRead(this._range, 'align'); },
    getVerticalAlignment: function () { return styleRead(this._range, 'valign'); },
    getWrapText: function () { return styleRead(this._range, 'wrap'); },
    /**
     * Borders on an edge: "all", "outline", "inside", "top", "bottom", "left", "right", "horizontal", "vertical", or
     * "none" to remove them. Options: { style: "thin" | "medium" | "thick" | "dashed" | "dotted" | "double", color }.
     */
    setBorder: function (which, options) {
      var kind = BORDER_EDGES[edge(which || 'all', Object.keys(BORDER_EDGES), 'The border edge')];
      options = options || {};
      var lineStyle = edge(options.style || 'thin', ['thin', 'medium', 'thick', 'dashed', 'dotted', 'double', 'hair'], 'The border style');
      write(this._range._with({ op: 'borders', kind: kind, style: lineStyle, color: options.color == null ? null : color(options.color, 'The border colour') }));
      return this;
    },
    clearBorders: function () { return this.setBorder('none'); },
    /** Width of the range's columns in pixels. */
    setColumnWidth: function (px) { if (typeof px !== 'number' || !(px >= 0 && px <= 4096)) fail('The column width must be from 0 to 4096 pixels.'); write(this._range._with({ op: 'size', axis: 'col', px: px })); return this; },
    /** Height of the range's rows in pixels. */
    setRowHeight: function (px) { if (typeof px !== 'number' || !(px >= 0 && px <= 546)) fail('The row height must be from 0 to 546 pixels.'); write(this._range._with({ op: 'size', axis: 'row', px: px })); return this; },
    /** Fit the columns to their contents. */
    autofitColumns: function () { write(this._range._with({ op: 'autofit', axis: 'col' })); return this; },
    autofitRows: function () { write(this._range._with({ op: 'autofit', axis: 'row' })); return this; },
    getColumnWidth: function () { return read(this._range.getCell(0, 0)._with({ op: 'size', axis: 'col' })); },
    getRowHeight: function () { return read(this._range.getCell(0, 0)._with({ op: 'size', axis: 'row' })); },
  };

  /* ---------- Running ---------- */

  var main = null;
  var started = false;
  function end(error) {
    if (finished) return;
    flush();
    finished = true;
    if (error) {
      var line = error && error.scriptLine || callerLine(error && error.stack) || 0;
      post({ type: 'error', name: error && error.name || 'Error', message: error && error.message != null ? String(error.message) : String(error), line: line });
    } else post({ type: 'done' });
  }
  scope.addEventListener('message', function (e) {
    var m = e.data || {};
    if (m.type === 'start' && !started) {
      started = true;
      userFirst = m.firstLine || 1;
      userLast = userFirst + (m.lineCount || 1e9) - 1;
      book.name = m.context.name || '';
      book.sheets = m.context.sheets || [];
      book.activeId = m.context.activeSheet;
      book.selection = m.context.selection || null;
      book.tableNames = m.context.tables || [];
      if (typeof main !== 'function') { end(ScriptError('The script needs a function named main: async function main(workbook) { … }', 1)); return; }
      var result;
      try { result = main(new Workbook()); } catch (err) { end(err); return; }
      Promise.resolve(result).then(function () { end(null); }, end);
    } else if (m.type === 'result') {
      var p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      adopt(m.sheets);
      if (m.error) p.reject(ScriptError(m.error, p.line)); else p.resolve(m.value);
    }
  });
  scope.addEventListener('unhandledrejection', function (e) { if (e.preventDefault) e.preventDefault(); end(e.reason || new Error('A promise was rejected')); });
  scope.addEventListener('error', function (e) { if (!e || !e.error) return; if (e.preventDefault) e.preventDefault(); end(e.error); });

  /** Called after the script's own code has been read: `fn` is its main(). */
  Object.defineProperty(scope, '__beginScript', { value: function (fn) { main = fn; post({ type: 'ready' }); }, configurable: false, writable: false });
})();
