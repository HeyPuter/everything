/**
 * In-memory worksheet host for VBA-style Range access.
 * Cells keyed as "A1", "B2", … (column letters + 1-based row).
 */

/** @param {number} col 0-based */
export function colToLetters(col) {
  let n = col + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** @param {string} letters */
export function lettersToCol(letters) {
  const u = letters.toUpperCase();
  let n = 0;
  for (let i = 0; i < u.length; i += 1) {
    n = n * 26 + (u.charCodeAt(i) - 64);
  }
  return n - 1;
}

/** @param {string} addr */
export function parseAddress(addr) {
  const m = String(addr).trim().toUpperCase().match(/^([A-Z]+)(\d+)$/);
  if (!m) throw new Error(`Invalid cell address: ${addr}`);
  return { col: lettersToCol(m[1]), row: Number(m[2]) - 1, key: `${m[1]}${m[2]}` };
}

export function createWorksheet(rows = 20, cols = 10) {
  /** @type {Map<string, string | number | boolean>} */
  const cells = new Map();
  return {
    rows,
    cols,
    /** @param {string} addr */
    get(addr) {
      const { key } = parseAddress(addr);
      return cells.has(key) ? cells.get(key) : '';
    },
    /** @param {string} addr @param {string | number | boolean} value */
    set(addr, value) {
      const { key } = parseAddress(addr);
      cells.set(key, value);
    },
    clear() {
      cells.clear();
    },
    /** @returns {{ address: string, value: string | number | boolean }[]} */
    entries() {
      return [...cells.entries()].map(([address, value]) => ({ address, value }));
    },
  };
}
