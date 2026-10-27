/**
 * Tiny in-memory SQL subset (original). DataGrip-inspired explorer — not JetBrains DataGrip.
 * LIVE remote DB connections are out of scope for v0 (DOCUMENTED).
 */

/** @typedef {Record<string, string|number|boolean|null>} Row */
/** @typedef {{ name:string, columns:string[], rows:Row[] }} Table */
/** @typedef {{ tables: Record<string, Table> }} Catalog */

/** @returns {Catalog} */
export function seedCatalog() {
  return {
    tables: {
      employees: {
        name: 'employees',
        columns: ['id', 'name', 'dept', 'salary'],
        rows: [
          { id: 1, name: 'Ada', dept: 'Eng', salary: 120 },
          { id: 2, name: 'Grace', dept: 'Eng', salary: 130 },
          { id: 3, name: 'Alan', dept: 'Research', salary: 110 },
          { id: 4, name: 'Katherine', dept: 'Ops', salary: 95 },
        ],
      },
      depts: {
        name: 'depts',
        columns: ['dept', 'floor'],
        rows: [
          { dept: 'Eng', floor: 3 },
          { dept: 'Research', floor: 2 },
          { dept: 'Ops', floor: 1 },
        ],
      },
    },
  };
}

/** @param {Catalog} catalog */
export function listTables(catalog) {
  return Object.keys(catalog.tables).sort();
}

/**
 * Supports: SELECT * FROM t; SELECT cols FROM t WHERE col = value;
 * @param {Catalog} catalog
 * @param {string} sql
 */
export function runQuery(catalog, sql) {
  const text = sql.trim().replace(/;+\s*$/, '');
  const m = text.match(
    /^select\s+(.+?)\s+from\s+([a-z_][a-z0-9_]*)(?:\s+where\s+([a-z_][a-z0-9_]*)\s*=\s*(.+))?$/i,
  );
  if (!m) {
    throw new Error('Supported: SELECT cols FROM table [WHERE col = value]');
  }
  const [, colsRaw, tableName, whereCol, whereValRaw] = m;
  const table = catalog.tables[tableName.toLowerCase()];
  if (!table) throw new Error(`Unknown table: ${tableName}`);

  let rows = [...table.rows];
  if (whereCol) {
    const want = parseLiteral(whereValRaw.trim());
    rows = rows.filter((r) => r[whereCol] === want);
  }

  const cols =
    colsRaw.trim() === '*'
      ? [...table.columns]
      : colsRaw.split(',').map((c) => c.trim());
  for (const c of cols) {
    if (!table.columns.includes(c)) throw new Error(`Unknown column: ${c}`);
  }

  return {
    columns: cols,
    rows: rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c]]))),
  };
}

/** @param {string} raw */
function parseLiteral(raw) {
  if (/^null$/i.test(raw)) return null;
  if (/^true$/i.test(raw)) return true;
  if (/^false$/i.test(raw)) return false;
  if (/^'.*'$/.test(raw) || /^".*"$/.test(raw)) return raw.slice(1, -1);
  const n = Number(raw);
  if (!Number.isNaN(n)) return n;
  return raw;
}
