import { inspectDataModel } from './xlsx-data-model.js';
import { evaluateDax, DaxError } from './dax.js';
import { linkedModelSource, linkedModelColumn, linkedModelValue } from './data-model-source.js';
import { dataModelBytes } from './data-model.js';
import { readDataModelArchive } from './data-model-archive.js';
import { resolveModelTableStorage } from './data-model-table.js';
import { readModelColumnStorage } from './data-model-columns.js';
import { decodeModelXml } from './data-model-metadata.js';
import { readModelColumnValues } from './data-model-values.js';

const key = value => String(value).normalize('NFC').toUpperCase();
const one = (items, label) => { if (items.length !== 1) throw new DaxError(`${items.length ? 'Ambiguous' : 'Missing'} ${label}`); return items[0]; };

/** A bounded calculation session. Decoded sources/columns are shared across
 * report cells; filter contexts and circular-measure detection are per call.
 * Stored row selections are increasing physical model ordinals, never worksheet
 * positions. Callers own relationship propagation and must not mutate columns.
 */
export function createDataModelEvaluation(wb, { maxValues = 4 * 1048576, source: sourceKind = 'worksheet' } = {}) {
  if (!wb.dataModel) throw new DaxError('The workbook has no Data Model');
  if (!Number.isSafeInteger(maxValues) || maxValues < 0 || !['worksheet', 'stored'].includes(sourceKind)) throw new DaxError('Invalid Data Model evaluation options');
  const schema = inspectDataModel(wb.dataModel), sources = new Map(); let steps = maxValues;
  let archive;
  const consume = () => { if (--steps < 0) throw new DaxError('Data Model evaluation exceeds value limit'); };
  const tableFor = name => one(schema.tables.filter(t => key(t.id) === key(name) || key(t.name) === key(name)), `model table ${name}`);
  const measures = schema.scripts.flatMap(s => s.commands.flatMap(c => c.measures));
  const source = table => {
    if (!sources.has(table.id)) {
      let src;
      if (sourceKind === 'stored') {
        archive ??= readDataModelArchive(dataModelBytes(wb.dataModel));
        const file = resolveModelTableStorage(archive, table), storage = readModelColumnStorage(decodeModelXml(file.read()).xml);
        if (!storage.partitionMaps) throw new DaxError('Missing stored model partition maps');
        const count = storage.partitionMaps.reduce((n, p) => n + p.records, 0);
        if (count > steps) throw new DaxError('Data Model evaluation exceeds value limit');
        src = { file, r1: 0, r2: count - 1 };
      } else src = linkedModelSource(wb, schema, table);
      sources.set(table.id, { ...src, columns: new Map() });
    }
    return sources.get(table.id);
  };
  const column = (table, name) => {
    const src = source(table), columnKey = key(name);
    if (!src.columns.has(columnKey)) {
      const field = one(table.columns.filter(c => key(c.name) === columnKey || key(c.id) === columnKey), `model column ${name}`);
      if (sourceKind === 'stored') {
        const dataType = field.keys?.length === 1 && field.keys[0].dataType;
        const type = ['BigInt', 'Integer'].includes(dataType) ? 'integer' : dataType === 'Double' ? 'number'
          : ['WChar', 'VarWChar', 'Char', 'VarChar'].includes(dataType) ? 'string' : null;
        if (!type) throw new DaxError(`Unsupported stored model column type ${dataType || '(missing)'}`);
        const count = src.r2 + 1;
        if (count > steps) throw new DaxError('Data Model evaluation exceeds value limit');
        steps -= count;
        const values = readModelColumnValues(archive, src.file, field.id, { maxIds: count });
        if (values.length !== count || values.some(v => v !== null && (typeof v !== (type === 'integer' ? 'bigint' : type)
          || dataType === 'Integer' && (v < -2147483648n || v > 2147483647n)))) throw new DaxError('Stored model column type or row count mismatch');
        // These values have already been processed. Reapplying source trimming
        // or null conversion would change the saved snapshot's semantics.
        src.columns.set(columnKey, { type, values });
      } else src.columns.set(columnKey, linkedModelColumn(src, table, field));
    }
    return src.columns.get(columnKey);
  };
  const rows = function* (table, acceptRow, selectRows) {
    const src = source(table), selection = selectRows?.(table.id);
    if (selection != null && !Array.isArray(selection)) throw new DaxError('Invalid stored model row selection');
    let previous = -1;
    const count = selection?.length ?? src.r2 - src.r1 + 1;
    for (let i = 0; i < count; i++) {
      const r = selection == null ? src.r1 + i : selection[i];
      if (selection != null) {
        if (!Number.isInteger(r) || r < src.r1 || r > src.r2 || r <= previous) throw new DaxError('Invalid stored model row selection');
        previous = r;
      }
      consume();
      const get = name => {
        consume(); const field = column(table, name);
        return sourceKind === 'stored' ? field.values[r] : linkedModelValue(wb, src, field, r);
      };
      if (!acceptRow || acceptRow(table.id, get)) yield get;
    }
  };
  const calculate = (tableName, measureName, { acceptRow = null, selectRows = null } = {}) => {
    if (acceptRow != null && typeof acceptRow !== 'function' || selectRows != null && (typeof selectRows !== 'function' || sourceKind !== 'stored')) throw new DaxError('Invalid Data Model evaluation options');
    const active = new Set();
    const evaluate = (tableName, name) => {
      let table = tableFor(tableName);
      const home = m => key(m.table) === key(table.id) || key(m.table) === key(table.name);
      // Measure names are the model's, not a table's: [Total] from a measure on Products finds Orders[Total].
      let found = measures.filter(m => home(m) && key(m.name) === key(name));
      if (!found.length) {
        found = measures.filter(m => key(m.name) === key(name));
        if (found.length === 1) table = tableFor(found[0].table);
      }
      const definition = one(found, `model measure ${name}`);
      const identity = `${key(table.id)}\0${key(name)}`;
      if (active.has(identity) || active.size >= 64) throw new DaxError('Circular or excessively nested Data Model measure');
      active.add(identity);
      try {
        return evaluateDax(definition.expression, {
          table: table.id, measure: evaluate,
          columnType: (owner, name) => column(tableFor(owner), name).type,
          column: (owner, name) => {
            const target = tableFor(owner); column(target, name); // Validate even when there are no source rows.
            return (function* () { for (const get of rows(target, acceptRow, selectRows)) yield get(name); })();
          },
          rowCount: owner => { let count = 0; for (const _row of rows(tableFor(owner), acceptRow, selectRows)) count++; return count; },
        }, { maxValues });
      } finally { active.delete(identity); }
    };
    return evaluate(tableName, measureName);
  };
  return { schema, evaluate: calculate,
    storedColumn: (owner, name) => {
      if (sourceKind !== 'stored') throw new DaxError('Stored model source required');
      return column(tableFor(owner), name);
    },
    storedRowCount: owner => {
      if (sourceKind !== 'stored') throw new DaxError('Stored model source required');
      return source(tableFor(owner)).r2 + 1;
    },
  };
}

/** Evaluate a declared measure against current linked worksheet data or the
 * saved snapshot. This neither refreshes a source nor rewrites model storage. */
export function evaluateDataModelMeasure(wb, tableName, measureName, { acceptRow = null, ...options } = {}) {
  return createDataModelEvaluation(wb, options).evaluate(tableName, measureName, { acceptRow });
}
