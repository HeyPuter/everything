/**
 * Minimal VBA-inspired interpreter (original; not Microsoft VBA).
 * Supports: Sub/End Sub, Dim, assignments, If/Then/Else/End If,
 * For/Next, MsgBox, Range("A1").Value, simple arithmetic & comparisons.
 */

/** @typedef {{ type: 'msg', text: string }} MsgEvent */
/** @typedef {{ worksheet: import('./worksheet.js').createWorksheet extends (...a:any)=>infer R ? R : never, messages: string[] }} Host */

const KEYWORDS = new Set([
  'SUB',
  'END',
  'DIM',
  'AS',
  'IF',
  'THEN',
  'ELSE',
  'FOR',
  'TO',
  'NEXT',
  'STEP',
  'MSGBOX',
  'TRUE',
  'FALSE',
  'RANGE',
  'VALUE',
  'SET',
  'LET',
]);

/**
 * @param {string} source
 * @returns {string[]}
 */
export function tokenizeLines(source) {
  return source
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      const noComment = line.replace(/'.*$/, '');
      return noComment.trim();
    })
    .filter(Boolean);
}

/**
 * @param {string} source
 * @param {Host} host
 */
export function runMacro(source, host) {
  const lines = tokenizeLines(source);
  /** @type {Map<string, string | number | boolean>} */
  const vars = new Map();
  let i = 0;
  let ran = false;

  function evalExpr(expr) {
    const e = expr.trim();
    // Lone string literal only — not `"a" & "b"` (avoid greedy .* across quotes).
    if (/^"(?:[^"]|"")*"$/.test(e)) return e.slice(1, -1).replace(/""/g, '"');
    if (/^Range\(\s*"([A-Za-z]+\d+)"\s*\)\s*\.\s*Value$/i.test(e)) {
      const m = e.match(/^Range\(\s*"([A-Za-z]+\d+)"\s*\)\s*\.\s*Value$/i);
      return host.worksheet.get(m[1]);
    }
    if (/^true$/i.test(e)) return true;
    if (/^false$/i.test(e)) return false;
    if (/^-?\d+(\.\d+)?$/.test(e)) return Number(e);
    if (vars.has(e.toLowerCase())) return vars.get(e.toLowerCase());

    // Comparisons
    for (const op of ['<=', '>=', '<>', '=', '<', '>']) {
      const idx = findOp(e, op);
      if (idx >= 0) {
        const left = evalExpr(e.slice(0, idx));
        const right = evalExpr(e.slice(idx + op.length));
        switch (op) {
          case '=':
            return left == right; // VBA-ish loose
          case '<>':
            return left != right;
          case '<':
            return Number(left) < Number(right);
          case '>':
            return Number(left) > Number(right);
          case '<=':
            return Number(left) <= Number(right);
          case '>=':
            return Number(left) >= Number(right);
          default:
            break;
        }
      }
    }

    // + - * /
    for (const op of ['+', '-']) {
      const idx = findOp(e, op);
      if (idx > 0) {
        return Number(evalExpr(e.slice(0, idx))) + (op === '+' ? 1 : -1) * Number(evalExpr(e.slice(idx + 1)));
      }
    }
    for (const op of ['*', '/']) {
      const idx = findOp(e, op);
      if (idx > 0) {
        const a = Number(evalExpr(e.slice(0, idx)));
        const b = Number(evalExpr(e.slice(idx + 1)));
        return op === '*' ? a * b : a / b;
      }
    }

    // concatenation &
    const amp = findOp(e, '&');
    if (amp >= 0) {
      return String(evalExpr(e.slice(0, amp))) + String(evalExpr(e.slice(amp + 1)));
    }

    throw new Error(`Cannot evaluate expression: ${expr}`);
  }

  /** @param {string} e @param {string} op */
  function findOp(e, op) {
    let depth = 0;
    let inStr = false;
    for (let p = 0; p < e.length; p += 1) {
      const ch = e[p];
      if (ch === '"') inStr = !inStr;
      if (inStr) continue;
      if (ch === '(') depth += 1;
      if (ch === ')') depth -= 1;
      if (depth === 0 && e.slice(p, p + op.length) === op) return p;
    }
    return -1;
  }

  function assign(target, value) {
    const range = target.match(/^Range\(\s*"([A-Za-z]+\d+)"\s*\)\s*\.\s*Value$/i);
    if (range) {
      host.worksheet.set(range[1], value);
      return;
    }
    vars.set(target.trim().toLowerCase(), value);
  }

  function skipBlock(endTokens) {
    let depth = 1;
    i += 1;
    while (i < lines.length) {
      const u = lines[i].toUpperCase();
      if (u.startsWith('IF ') || u === 'IF' || u.startsWith('FOR ') || u.startsWith('SUB ')) depth += 1;
      if (endTokens.some((t) => u === t || u.startsWith(t + ' '))) {
        depth -= 1;
        if (depth === 0) return;
      }
      if (u === 'ELSE' && depth === 1 && endTokens.includes('END IF')) return;
      i += 1;
    }
    throw new Error(`Missing ${endTokens.join('/')}`);
  }

  function execUntil(stopPred) {
    while (i < lines.length) {
      const line = lines[i];
      const upper = line.toUpperCase();
      if (stopPred && stopPred(upper, line)) return;

      if (/^SUB\s+/i.test(line)) {
        const name = line.match(/^SUB\s+(\w+)/i)[1];
        i += 1;
        if (!ran) {
          ran = true;
          execUntil((u) => u === 'END SUB');
          if (lines[i]?.toUpperCase() !== 'END SUB') throw new Error(`END SUB missing for ${name}`);
          i += 1;
        } else {
          skipBlock(['END SUB']);
          i += 1;
        }
        continue;
      }

      if (upper === 'END SUB' || upper === 'END IF' || upper.startsWith('NEXT')) return;

      if (/^DIM\s+/i.test(line)) {
        const names = line.replace(/^DIM\s+/i, '').split(',').map((p) => p.trim().split(/\s+AS\s+/i)[0].trim());
        for (const n of names) if (n) vars.set(n.toLowerCase(), null);
        i += 1;
        continue;
      }

      if (/^MSGBOX\s+/i.test(line)) {
        const arg = line.replace(/^MSGBOX\s+/i, '');
        host.messages.push(String(evalExpr(arg)));
        i += 1;
        continue;
      }

      if (/^IF\s+/i.test(line) && /THEN\s*$/i.test(line)) {
        const cond = line.replace(/^IF\s+/i, '').replace(/\s+THEN\s*$/i, '');
        const ok = Boolean(evalExpr(cond));
        i += 1;
        if (ok) {
          execUntil((u) => u === 'ELSE' || u === 'END IF');
          if (lines[i]?.toUpperCase() === 'ELSE') {
            skipBlock(['END IF']);
          }
          if (lines[i]?.toUpperCase() === 'END IF') i += 1;
        } else {
          // seek ELSE or END IF
          let depth = 1;
          while (i < lines.length) {
            const u = lines[i].toUpperCase();
            if (u.startsWith('IF ') && u.endsWith(' THEN')) depth += 1;
            if (u === 'END IF') {
              depth -= 1;
              if (depth === 0) {
                i += 1;
                break;
              }
            }
            if (u === 'ELSE' && depth === 1) {
              i += 1;
              execUntil((uu) => uu === 'END IF');
              if (lines[i]?.toUpperCase() === 'END IF') i += 1;
              break;
            }
            i += 1;
          }
        }
        continue;
      }

      if (/^FOR\s+(\w+)\s*=\s*(.+)\s+TO\s+(.+?)(?:\s+STEP\s+(.+))?$/i.test(line)) {
        const m = line.match(/^FOR\s+(\w+)\s*=\s*(.+)\s+TO\s+(.+?)(?:\s+STEP\s+(.+))?$/i);
        const v = m[1].toLowerCase();
        let cur = Number(evalExpr(m[2]));
        const end = Number(evalExpr(m[3]));
        const step = m[4] != null ? Number(evalExpr(m[4])) : 1;
        const bodyStart = i + 1;
        const loop = () => (step >= 0 ? cur <= end : cur >= end);
        while (loop()) {
          vars.set(v, cur);
          i = bodyStart;
          execUntil((u) => u === 'NEXT' || u.startsWith('NEXT '));
          cur += step;
        }
        // advance past NEXT
        while (i < lines.length && !/^NEXT/i.test(lines[i])) i += 1;
        i += 1;
        continue;
      }

      // assignment: [Let] target = expr  OR  Range(...).Value = expr
      const assignMatch = line.match(/^(?:LET\s+|SET\s+)?(.+?)\s*=\s*(.+)$/i);
      if (assignMatch && !KEYWORDS.has(assignMatch[1].trim().toUpperCase().split(/\s+/)[0])) {
        assign(assignMatch[1], evalExpr(assignMatch[2]));
        i += 1;
        continue;
      }

      throw new Error(`Unsupported statement: ${line}`);
    }
  }

  execUntil(null);
  if (!ran) {
    // allow scripts without Sub wrapper
    i = 0;
    ran = true;
    execUntil(null);
  }
  return { vars, messages: host.messages };
}
