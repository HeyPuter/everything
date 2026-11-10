import { expect, it } from 'vitest';
import { SIGNATURES } from '../src/core/formula/hints.js';
import { ARITY } from '../src/core/formula/arity.js';
import { functionParams } from '../src/ui/insertfunction.js';

// A typed formula giving a function too few or too many arguments stays the text typed, as Excel
// refuses it. ROUND, ROUNDUP, ROUNDDOWN and NORM.S.DIST still showed their last argument as
// optional — in the hint under a formula being typed, and in Function Arguments, which let it be
// left out — so following them gave =ROUND(C3), an entry then kept as text. Their signatures now
// show it as required, as Excel's do, and no signature offers fewer or more arguments than the
// function takes.

/** The fewest and most arguments a signature offers: a top-level [optional] one or `...` may be left out. */
function offered(params) {
  const list = [];
  let depth = 0, part = '';
  for (const ch of params) {
    if ('([{'.includes(ch)) depth++;
    if (')]}'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) { list.push(part.trim()); part = ''; } else part += ch;
  }
  if (part.trim()) list.push(part.trim());
  const repeats = list.some((p) => p.includes('...'));
  return [list.filter((p) => !p.startsWith('[') && !p.includes('...')).length, repeats ? Infinity : list.length];
}

it('offers no function fewer or more arguments than it takes', () => {
  for (const [name, [min, max]] of ARITY) {
    if (!SIGNATURES[name]) continue;
    const [least, most] = offered(SIGNATURES[name][0]);
    expect(least, `${name}(${SIGNATURES[name][0]})`).toBeGreaterThanOrEqual(min);
    expect(most, `${name}(${SIGNATURES[name][0]})`).toBeLessThanOrEqual(max);
  }
});

it('asks Function Arguments for the digits of ROUND and the cumulative of NORM.S.DIST', () => {
  for (const name of ['ROUND', 'ROUNDUP', 'ROUNDDOWN']) expect(functionParams(name).params.map((p) => p.optional), name).toEqual([false, false]);
  expect(functionParams('NORM.S.DIST').params.map((p) => p.optional)).toEqual([false, false]);
});
