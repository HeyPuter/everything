import { FUNCTIONS } from './formula/functions.js';
import { sheetKey } from './refs.js';
import { pivotDateSerial } from './native-pivot-cache.js';

const summaries = { sum: 'SUM', count: 'COUNTA', countNums: 'COUNT', average: 'AVERAGE', min: 'MIN', max: 'MAX',
  product: 'PRODUCT', stdDev: 'STDEV', stdDevp: 'STDEV.P', var: 'VAR', varp: 'VAR.P' };
const fail = message => { throw new Error(`Invalid pivot query: ${message}`); };
const valueKey = item => JSON.stringify([item.type, item.type === 'string' ? sheetKey(item.value) : item.value]);

/** Query a decoded, immutable saved cache. Selection is by shared-item identity;
 * inline values match typed member values, with case-insensitive text
 * comparison. Field indexes are not record-column offsets. This neither reads
 * edited worksheet cells nor evaluates calculated fields or OLAP measures.
 */
export class NativePivotQuery {
  constructor(cache) {
    if (!Array.isArray(cache?.records)) fail('saved records are unavailable');
    this.cache = cache;
    this.columns = new Map(cache.recordFields.map((field, column) => [field, column]));
    this.indexes = new Map();
    this.memberKeys = new Map();
  }

  column(field) {
    if (!Number.isInteger(field) || !this.cache.fields[field]) fail('field index');
    const column = this.columns.get(field);
    if (column == null) fail('calculated or grouped field requires evaluation');
    return column;
  }

  index(field) {
    const column = this.column(field);
    if (this.indexes.has(field)) return this.indexes.get(field);
    const indexed = new Map(), inline = new Map();
    for (let row = 0; row < this.cache.records.length; row++) {
      const item = this.cache.records[row][column];
      const map = item.index == null ? inline : indexed, key = item.index == null ? valueKey(item) : item.index;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(row);
    }
    const result = { indexed, inline };
    this.indexes.set(field, result);
    return result;
  }

  /** OR within a field selection, AND between selections. null means all,
   * while an empty list means no members. Results retain cache record order.
   */
  rows(filters = []) {
    if (!Array.isArray(filters)) fail('filters');
    const clauses = [];
    for (const filter of filters) {
      this.column(filter?.field);
      if (filter.items === null) continue;
      if (!Array.isArray(filter.items)) fail('member selection');
      const shared = this.cache.fields[filter.field].items;
      for (const member of filter.items) if (!Number.isInteger(member) || member < 0 || member >= shared.length) fail('member index');
      const index = this.index(filter.field), rows = new Set();
      for (const member of filter.items) {
        for (const row of index.indexed.get(member) || []) rows.add(row);
        for (const row of index.inline.get(valueKey(shared[member])) || []) rows.add(row);
      }
      clauses.push(rows);
    }
    if (!clauses.length) return Array.from({ length: this.cache.records.length }, (_, i) => i);
    clauses.sort((a, b) => a.size - b.size);
    return [...clauses[0]].filter(row => clauses.every(clause => clause.has(row))).sort((a, b) => a - b);
  }

  /** Partition an already selected record set once at each hierarchy level.
   * Unlike querying every possible member, this does not form a dense product
   * of all parent and child members when most combinations have no records.
   */
  partition(field, rows) {
    const column = this.column(field), shared = this.cache.fields[field].items;
    if (!this.memberKeys.has(field)) {
      const keys = new Map();
      for (const [index, item] of shared.entries()) {
        const key = valueKey(item);
        keys.set(key, keys.has(key) ? null : index);
      }
      this.memberKeys.set(field, keys);
    }
    const keys = this.memberKeys.get(field), groups = new Map();
    for (const row of rows) {
      if (!Number.isInteger(row) || row < 0 || row >= this.cache.records.length) fail('record index');
      const item = this.cache.records[row][column], index = item.index ?? keys.get(valueKey(item));
      if (index == null || !shared[index]) fail('missing or ambiguous shared member');
      if (!groups.has(index)) groups.set(index, []);
      groups.get(index).push(row);
    }
    return groups;
  }

  /** Counts for cross-filter availability, including members with zero data.
   * Scan selected records once; do not rescan the cache for every button.
   */
  memberCounts(field, filters = []) {
    const column = this.column(field), shared = this.cache.fields[field].items;
    const byValue = new Map(), counts = new Array(shared.length).fill(0);
    for (const [index, item] of shared.entries()) {
      const key = valueKey(item);
      if (!byValue.has(key)) byValue.set(key, []);
      byValue.get(key).push(index);
    }
    for (const row of this.rows(filters)) {
      const item = this.cache.records[row][column];
      for (const index of item.index == null ? byValue.get(valueKey(item)) || [] : [item.index]) counts[index]++;
    }
    return counts;
  }

  /** Return the unformatted result and record count separately: empty-cell
   * display, error captions and show-values-as belong to the report layer.
   * Native Count/Count Nums have COUNTA/COUNT semantics (Microsoft's PivotTable
   * summary-function specification); range arguments avoid scalar coercion.
   */
  aggregate(field, summary = 'sum', filters = [], { withPresence = false } = {}) {
    return this.aggregateRows(field, summary, this.rows(filters), { withPresence });
  }

  /** Aggregate an already selected group without re-evaluating shared parent
   * filters for every member (used by automatic value sorting). */
  aggregateRows(field, summary = 'sum', rows = [], { withPresence = false } = {}) {
    const column = this.column(field), functionName = Object.hasOwn(summaries, summary) && summaries[summary];
    if (!functionName) fail('summary function');
    if (!Array.isArray(rows)) fail('record selection');
    let nonEmpty = 0;
    const values = rows.map(row => {
      if (!Number.isInteger(row) || row < 0 || row >= this.cache.records.length) fail('record index');
      const item = this.cache.records[row][column];
      if (item.type !== 'blank') nonEmpty++;
      // A cached date is its ISO text: as its serial it is the number a Max, Min, Average or Count Numbers reads.
      return [item.type === 'error' ? { error: item.value } : item.type === 'date' ? pivotDateSerial(item.value) : item.value];
    });
    const result = FUNCTIONS[functionName].fn([{ range: true, values }]);
    return { value: typeof result === 'number' && !Number.isFinite(result) ? { error: '#NUM!' } : result, records: rows.length, ...(withPresence ? { nonEmpty } : {}) };
  }
}
