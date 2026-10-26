// Linear equation input built up into Office Math (ECMA-376 Part 1 §22.1).
// The syntax is a practical subset of the UnicodeMath linear format with a few
// TeX control words. Parsing is forgiving: anything that does not build up is
// kept as literal text, so typing never fails half-way through an equation.
import { MATH, MATH_DEPTH_LIMIT, linearMath, mathPlainText } from './office-math.js';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

const TEX = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ϵ', varepsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', varpi: 'ϖ', rho: 'ρ', varrho: 'ϱ', sigma: 'σ', varsigma: 'ς', tau: 'τ', upsilon: 'υ', phi: 'ϕ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  sum: '∑', prod: '∏', coprod: '∐', int: '∫', iint: '∬', iiint: '∭', oint: '∮', oiint: '∯', bigcup: '⋃', bigcap: '⋂', bigvee: '⋁', bigwedge: '⋀',
  infty: '∞', partial: '∂', nabla: '∇', emptyset: '∅', varnothing: '∅', hbar: 'ℏ', ell: 'ℓ', Re: 'ℜ', Im: 'ℑ', aleph: 'ℵ', prime: '′', degree: '°', angle: '∠',
  le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠', approx: '≈', equiv: '≡', cong: '≅', sim: '∼', simeq: '≃', propto: '∝', ll: '≪', gg: '≫',
  pm: '±', mp: '∓', times: '×', cdot: '⋅', div: '÷', ast: '∗', circ: '∘', bullet: '∙', oplus: '⊕', otimes: '⊗',
  to: '→', rightarrow: '→', leftarrow: '←', gets: '←', leftrightarrow: '↔', Rightarrow: '⇒', implies: '⇒', Leftarrow: '⇐', Leftrightarrow: '⇔', iff: '⇔', mapsto: '↦',
  in: '∈', notin: '∉', ni: '∋', subset: '⊂', subseteq: '⊆', supset: '⊃', supseteq: '⊇', cup: '∪', cap: '∩', setminus: '∖', wedge: '∧', land: '∧', vee: '∨', lor: '∨', neg: '¬', lnot: '¬', forall: '∀', exists: '∃', perp: '⊥', parallel: '∥', mid: '∣',
  ldots: '…', dots: '…', cdots: '⋯', vdots: '⋮', ddots: '⋱',
  langle: '⟨', rangle: '⟩', lfloor: '⌊', rfloor: '⌋', lceil: '⌈', rceil: '⌉', lbrace: '{', rbrace: '}', vert: '|', Vert: '‖',
  cbrt: '∛', matrix: '■', eqarray: '█',
};
const FUNCS = new Set('sin cos tan cot sec csc sinh cosh tanh coth arcsin arccos arctan log ln lg exp lim max min sup inf det gcd lcm arg dim ker deg Pr'.split(' '));
const LIMIT_FUNCS = new Set(['lim', 'max', 'min', 'sup', 'inf']);
const ACCENTS = { hat: '̂', check: '̌', tilde: '̃', acute: '́', grave: '̀', breve: '̆', dot: '̇', ddot: '̈', vec: '⃗', bar: 'top', overline: 'top', underline: 'bot' };
const OPEN = { '(': ')', '[': ']', '{': '}', '⟨': '⟩', '⌊': '⌋', '⌈': '⌉' };
const CLOSE = new Set(Object.values(OPEN));
const BARS = new Set(['|', '‖']);
const NARY = new Set('∑∏∐∫∬∭∮∯∰∱∲∳⋃⋂⋁⋀'.split(''));
const INTEGRALS = new Set('∫∬∭∮∯∰∱∲∳'.split(''));
const OPS = new Set('+-−*∗×·⋅÷=≠<>≤≥≪≫±∓→←↔⇒⇐⇔↦≈≡≅≃∼∝∈∉∋⊂⊆⊃⊇∪∩∖∧∨¬∀∃⊕⊗∘∙∣∥⊥,;:'.split(''));
// An n-ary operand runs up to the next relation, as in "∑_(i=1)^n i = …".
const RELATIONS = new Set('=≠<>≤≥≪≫→←↔⇒⇐⇔≈≡≅≃∼∝∈∉∋⊂⊆⊃⊇,;'.split(''));
const SIGNS = new Set('+-−±∓');
const ROOT_DEGREE = { '∛': '3', '∜': '4' };

const run = (text, plain = false) => ({ type: 'run', text, ...(plain ? { plain } : {}) });

function tokenize(source) {
  // Split precomposed accented Latin letters so x̂-style accents build up.
  const s = [...source.replace(/[À-ɏḀ-ỿ]/gu, c => { const d = c.normalize('NFD'); return /^[A-Za-z]\p{M}+$/u.test(d) ? d : c; })];
  const out = [], push = (t, v, more) => out.push({ t, v, ...more });
  const symbol = c => {
    if (OPEN[c]) push('open', c);
    else if (CLOSE.has(c)) push('close', c);
    else if (BARS.has(c)) push('vbar', c);
    else if (c === '^') push('sup', c);
    else if (c === '_') push('sub', c);
    else if (c === '/') push('slash', c);
    else if (c === '¦') push('slash', c, { noBar: true });
    else if (c === '&') push('amp', c);
    else if (c === '@') push('at', c);
    else if (c === '▒') push('glue', c);
    else if (c === '√' || ROOT_DEGREE[c]) push('root', c);
    else if (c === '■') push('matrix', c);
    else if (c === '█') push('eqarr', c);
    else if (NARY.has(c)) push('nary', c);
    else if (/\p{M}/u.test(c)) push('comb', c);
    else if (OPS.has(c)) push('op', c === '-' ? '−' : c);
    else push('sym', c === "'" ? '′' : c);
  };
  // Reads a raw {…} argument for \text-like words; null when absent or unclosed.
  const raw = i => {
    if (s[i] !== '{') return null;
    for (let j = i + 1, depth = 1; j < s.length; j++) {
      if (s[j] === '{') depth++;
      else if (s[j] === '}' && !--depth) return { text: s.slice(i + 1, j).join(''), end: j + 1 };
    }
    return null;
  };
  for (let i = 0; i < s.length;) {
    const c = s[i];
    if (/\s/u.test(c)) { while (i < s.length && /\s/u.test(s[i])) i++; push('space', ' '); continue; }
    if (/[0-9]/.test(c)) {
      let j = i; while (/[0-9]/.test(s[j] ?? '')) j++;
      if (s[j] === '.' && /[0-9]/.test(s[j + 1] ?? '')) { j++; while (/[0-9]/.test(s[j] ?? '')) j++; }
      push('num', s.slice(i, j).join('')); i = j; continue;
    }
    if (/[A-Za-z]/.test(c)) { let j = i; while (/[A-Za-z]/.test(s[j] ?? '')) j++; push('word', s.slice(i, j).join('')); i = j; continue; }
    if (c === '"') {
      const end = s.indexOf('"', i + 1);
      if (end < 0) { push('sym', c); i++; continue; }
      push('text', s.slice(i + 1, end).join('')); i = end + 1; continue;
    }
    if (c === '\\') {
      let j = i + 1; while (/[A-Za-z]/.test(s[j] ?? '')) j++;
      const name = s.slice(i + 1, j).join('');
      if (!name) {
        const next = s[i + 1]; i += 2;
        if (next === undefined) push('sym', '\\');
        else if (',:; !'.includes(next)) push('space', ' ');
        else if (next === '|') push('vbar', '‖');
        else symbol(next);
        continue;
      }
      i = j;
      if (['text', 'textrm', 'mathrm', 'mbox', 'operatorname'].includes(name)) {
        const arg = raw(i);
        if (arg) { i = arg.end; name === 'operatorname' ? push('word', arg.text, { fn: true }) : push('text', arg.text); }
        else push('sym', `\\${name}`);
      } else if (/^(left|right|[bB]igg?[lr]?)$/.test(name)) { if (s[i] === '.') i++; }
      else if (name === 'quad' || name === 'qquad') push('space', ' ');
      else if (['frac', 'dfrac', 'tfrac', 'binom'].includes(name)) push('tex', name);
      else if (name === 'sqrt') push('root', '√', { tex: true });
      else if (ACCENTS[name]) push('accent', name);
      else if (FUNCS.has(name)) push('word', name, { fn: true });
      else if (TEX[name]) symbol(TEX[name]);
      else push('sym', `\\${name}`);
      continue;
    }
    symbol(c); i++;
  }
  return out;
}

const flatten = rows => rows.flatMap((row, r) => [...(r ? [run('@')] : []), ...row.flatMap((cell, c) => [...(c ? [run('&')] : []), ...cell])]);
// Parentheses that only group an operand are not displayed (linear format rule).
const unwrap = nodes => nodes.length === 1 && nodes[0].type === 'delim' && ['()', '{}'].includes(nodes[0].open + nodes[0].close) ? flatten(nodes[0].rows) : nodes;
const isOperand = n => n.type !== 'space' && n.type !== 'slash' && !n.op;

class Parser {
  constructor(tokens) { this.k = tokens; this.i = 0; }
  peek() { return this.k[this.i]; }
  skipSpace() { while (this.peek()?.t === 'space') this.i++; }
  stops(tok, ctx) {
    if (!tok) return true;
    if ((tok.t === 'close' || tok.t === 'vbar') && ctx.closers.has(tok.v)) return true;
    if (ctx.cells && (tok.t === 'amp' || tok.t === 'at')) return true;
    return ctx.rel && tok.t === 'op' && RELATIONS.has(tok.v);
  }
  sequence(ctx) {
    const items = [];
    while (!this.stops(this.peek(), ctx)) {
      const tok = this.peek();
      if (tok.t === 'space') { items.push({ type: 'space' }); this.i++; }
      else if (tok.t === 'slash') { items.push({ type: 'slash', noBar: !!tok.noBar, text: tok.v }); this.i++; }
      else if (tok.t === 'op') { items.push({ ...run(tok.v), op: true }); this.i++; }
      else items.push(...this.term(ctx));
    }
    return fractions(items);
  }
  term(ctx) {
    const nodes = this.primary(ctx);
    if (!nodes.length) return nodes;
    return [...nodes.slice(0, -1), ...this.postfix(nodes.at(-1), ctx)];
  }
  marks(node) {
    while (this.peek()?.t === 'comb') node = accent(this.k[this.i++].v, [node]);
    return node;
  }
  postfix(node, ctx) {
    node = this.marks(node);
    const scripts = this.scripts(ctx);
    return [scriptNode([node], scripts), ...scripts.literal];
  }
  scripts(ctx) {
    const found = { sub: null, sup: null, literal: [] };
    for (let tok; (tok = this.peek()) && (tok.t === 'sub' || tok.t === 'sup') && !found[tok.t];) {
      this.i++;
      const operand = this.scriptOperand(ctx);
      if (!operand) { found.literal.push(run(tok.v)); break; }
      found[tok.t] = operand;
    }
    return found;
  }
  scriptOperand(ctx) {
    const tok = this.peek();
    if (!tok || this.stops(tok, ctx)) return null;
    if (tok.t === 'op') {
      if (!SIGNS.has(tok.v)) return null;
      this.i++;
      const rest = this.scriptOperand(ctx);
      return [{ ...run(tok.v) }, ...(rest || [])];
    }
    if (['space', 'slash', 'sub', 'sup', 'amp', 'at', 'close', 'glue'].includes(tok.t)) return null;
    if (tok.t === 'word' && !tok.fn && !FUNCS.has(tok.v)) { this.i++; return [this.marks(run(tok.v))]; }
    const nodes = this.primary(ctx);
    return nodes.length ? unwrap([...nodes.slice(0, -1), this.marks(nodes.at(-1))]) : null;
  }
  primary(ctx) {
    const tok = this.k[this.i++];
    switch (tok.t) {
      case 'num': case 'sym': return [run(tok.v)];
      case 'text': return [{ type: 'text', text: tok.v }];
      case 'word': {
        const next = this.peek();
        if (tok.fn || FUNCS.has(tok.v)) return this.func(tok.v, ctx);
        if (next?.t === 'open' && next.v === '(' && ACCENTS[tok.v]) { const e = unwrap(this.primary(ctx)); return [accent(ACCENTS[tok.v], e)]; }
        if (next?.t === 'open' && next.v === '(' && tok.v === 'sqrt') return this.root({ v: '√' }, ctx);
        // A run of letters is a product of single-letter variables.
        if (tok.v.length > 1) this.k[--this.i] = { t: 'word', v: tok.v.slice(1) };
        return [run(tok.v[0])];
      }
      case 'open': return this.group(tok.v, OPEN[tok.v], ctx);
      case 'vbar': return this.group(tok.v, tok.v, ctx);
      case 'root': return this.root(tok, ctx);
      case 'nary': return this.nary(tok.v, ctx);
      case 'matrix': case 'eqarr': {
        if (this.peek()?.t !== 'open' || this.peek().v !== '(') return [run(tok.v)];
        const built = this.group(this.k[this.i++].v, ')', ctx), [group] = built;
        if (group.type !== 'delim') return [run(tok.v), ...built];
        if (tok.t === 'eqarr') return [{ type: 'eqArr', rows: group.rows.map(row => row.flat()) }];
        const columns = Math.max(...group.rows.map(row => row.length));
        return [{ type: 'matrix', columns, rows: group.rows.map(row => [...row, ...Array(columns - row.length).fill([])]) }];
      }
      case 'tex': {
        const num = this.braceArg(ctx), den = num && this.braceArg(ctx);
        if (!num) return [run(`\\${tok.v}`)];
        if (tok.v === 'binom') return [{ type: 'delim', open: '(', close: ')', rows: [[[{ type: 'frac', noBar: true, num, den: den || [] }]]] }];
        return [{ type: 'frac', num, den: den || [] }];
      }
      case 'accent': { const e = this.braceArg(ctx); return e ? [accent(ACCENTS[tok.v], e)] : [run(`\\${tok.v}`)]; }
      case 'glue': return [];
      default: return [run(tok.v)];
    }
  }
  // Parses a bracketed group; `&` separates cells and `@` rows (matrices).
  group(open, close, ctx) {
    const closers = new Set(BARS.has(open) ? ctx.closers : [...ctx.closers].filter(c => !BARS.has(c)));
    closers.add(close);
    const rows = [[]];
    for (;;) {
      rows.at(-1).push(this.sequence({ closers, cells: true, rel: false }));
      const tok = this.peek();
      if (tok?.t === 'amp') { this.i++; continue; }
      if (tok?.t === 'at') { this.i++; rows.push([]); continue; }
      if (tok && tok.v === close && (tok.t === 'close' || tok.t === 'vbar')) { this.i++; return [{ type: 'delim', open, close, rows }]; }
      return [run(open), ...flatten(rows)];
    }
  }
  braceArg(ctx) {
    this.skipSpace();
    const tok = this.peek();
    if (tok?.t === 'open' && tok.v === '{') return unwrap(this.primary(ctx));
    return this.scriptOperand(ctx);
  }
  root(tok, ctx) {
    let degree = ROOT_DEGREE[tok.v] ? [run(ROOT_DEGREE[tok.v])] : null;
    if (tok.tex && this.peek()?.t === 'open' && this.peek().v === '[') {
      const [group] = this.group(this.k[this.i++].v, ']', ctx);
      degree = group.type === 'delim' ? flatten(group.rows) : null;
    }
    this.skipSpace();
    const next = this.peek();
    if (!next || this.stops(next, ctx) || ['op', 'slash', 'sub', 'sup', 'amp', 'at', 'close'].includes(next.t)) return [run(tok.v)];
    const arg = this.term(ctx), only = arg.length === 1 && arg[0];
    if (only?.type === 'delim' && ['()', '{}'].includes(only.open + only.close)) {
      const [row] = only.rows;
      if (!degree && only.rows.length === 1 && row.length === 2) return [{ type: 'rad', degree: row[0], e: row[1] }];
      return [{ type: 'rad', degree, e: flatten(only.rows) }];
    }
    return [{ type: 'rad', degree, e: arg }];
  }
  nary(chr, ctx) {
    const { sub, sup, literal } = this.scripts(ctx);
    this.skipSpace();
    if (this.peek()?.t === 'glue') { this.i++; this.skipSpace(); }
    const e = literal.length ? [] : this.sequence({ ...ctx, rel: true });
    return [{ type: 'nary', chr, limLoc: INTEGRALS.has(chr) ? 'subSup' : 'undOvr', sub, sup, e }, ...literal];
  }
  func(name, ctx) {
    let fname = [run(name, true)];
    if (LIMIT_FUNCS.has(name) && this.peek()?.t === 'sub') {
      this.i++;
      const lim = this.scriptOperand(ctx);
      fname = lim ? [{ type: 'limLow', e: fname, lim }] : [...fname, run('_')];
    } else {
      const scripts = this.scripts(ctx);
      fname = [scriptNode(fname, scripts), ...scripts.literal];
    }
    const start = this.i;
    this.skipSpace();
    const arg = [];
    for (let tok; (tok = this.peek()) && !this.stops(tok, ctx) && !['space', 'op', 'slash', 'close', 'sub', 'sup', 'amp', 'at'].includes(tok.t);) {
      const opens = tok.t === 'open' || tok.t === 'vbar';
      arg.push(...this.term(ctx));
      if (opens) break;
    }
    if (!arg.length) { this.i = start; return fname; }
    return [{ type: 'func', name: fname, e: arg }];
  }
}

function scriptNode(base, { sub, sup }) {
  if (sub && sup) return { type: 'subSup', e: base, sub, sup };
  if (sub) return { type: 'sub', e: base, sub };
  if (sup) return { type: 'sup', e: base, sup };
  return base.length === 1 ? base[0] : { type: 'group', e: base };
}

function accent(mark, e) {
  if (mark === 'top' || mark === '̅') return { type: 'bar', pos: 'top', e };
  if (mark === 'bot' || mark === '̲') return { type: 'bar', pos: 'bot', e };
  return { type: 'acc', chr: mark, e };
}

// Builds a/b from the operands either side of each slash, left to right, so
// a/b/c is (a/b)/c. An operand is the run of terms up to an operator or space.
function fractions(items) {
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.type !== 'slash') { out.push(item); continue; }
    const num = [];
    while (out.length && isOperand(out.at(-1))) num.unshift(out.pop());
    let j = i + 1; const den = [];
    while (j < items.length && isOperand(items[j])) den.push(items[j++]);
    if (!num.length || !den.length) { out.push(...num, { ...run(item.text), op: true }); continue; }
    out.push({ type: 'frac', ...(item.noBar ? { noBar: true } : {}), num: unwrap(num), den: unwrap(den) });
    i = j - 1;
  }
  return out.filter(n => n.type !== 'space').map(n => n.op ? run(n.text) : n);
}

/** Parses linear-format math into a small syntax tree ({ type: 'math', body }). */
export function parseLinearMath(input) {
  const source = String(input ?? '');
  if (!source.trim()) throw new Error('Empty equation');
  const parser = new Parser(tokenize(source.trim())), body = [];
  // Unmatched closers at the top level are kept as literal characters.
  while (parser.i < parser.k.length) {
    body.push(...parser.sequence({ closers: new Set(), cells: false, rel: false }));
    if (parser.i < parser.k.length) body.push(run(parser.k[parser.i++].v));
  }
  return { type: 'math', body };
}

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const mrun = (text, plain) => `<m:r>${plain ? '<m:rPr><m:sty m:val="p"/></m:rPr>' : ''}<m:t${/^\s|\s$/.test(text) ? ' xml:space="preserve"' : ''}>${esc(text)}</m:t></m:r>`;
const on = (name, value) => `<m:${name} m:val="${esc(value)}"/>`;
const wrap = (name, nodes) => `<m:${name}>${omml(nodes)}</m:${name}>`;

function omml(nodes) {
  let xml = '', text = '';
  const flush = () => { if (text) xml += mrun(text); text = ''; };
  for (const n of nodes) {
    if (n.type === 'run' && !n.plain) { text += n.text; continue; }
    flush(); xml += element(n);
  }
  flush();
  return xml;
}

// Children follow the sequence order of the shared-math schema types.
function element(n) {
  switch (n.type) {
    case 'run': return mrun(n.text, n.plain);
    case 'text': return mrun(n.text, true);
    case 'group': return omml(n.e);
    case 'frac': return `<m:f>${n.noBar ? `<m:fPr>${on('type', 'noBar')}</m:fPr>` : ''}${wrap('num', n.num)}${wrap('den', n.den)}</m:f>`;
    case 'sup': return `<m:sSup>${wrap('e', n.e)}${wrap('sup', n.sup)}</m:sSup>`;
    case 'sub': return `<m:sSub>${wrap('e', n.e)}${wrap('sub', n.sub)}</m:sSub>`;
    case 'subSup': return `<m:sSubSup>${wrap('e', n.e)}${wrap('sub', n.sub)}${wrap('sup', n.sup)}</m:sSubSup>`;
    case 'rad': return `<m:rad>${n.degree?.length ? '' : `<m:radPr>${on('degHide', '1')}</m:radPr>`}${wrap('deg', n.degree || [])}${wrap('e', n.e)}</m:rad>`;
    case 'nary': return `<m:nary><m:naryPr>${on('chr', n.chr)}${on('limLoc', n.limLoc)}${n.sub ? '' : on('subHide', '1')}${n.sup ? '' : on('supHide', '1')}</m:naryPr>${wrap('sub', n.sub || [])}${wrap('sup', n.sup || [])}${wrap('e', n.e)}</m:nary>`;
    case 'delim': {
      const pr = n.open === '(' && n.close === ')' ? '' : `<m:dPr>${on('begChr', n.open)}${on('endChr', n.close)}</m:dPr>`;
      return `<m:d>${pr}${wrap('e', flatten(n.rows))}</m:d>`;
    }
    case 'func': return `<m:func>${wrap('fName', n.name)}${wrap('e', n.e)}</m:func>`;
    case 'limLow': return `<m:limLow>${wrap('e', n.e)}${wrap('lim', n.lim)}</m:limLow>`;
    case 'acc': return `<m:acc><m:accPr>${on('chr', n.chr)}</m:accPr>${wrap('e', n.e)}</m:acc>`;
    case 'bar': return `<m:bar><m:barPr>${on('pos', n.pos)}</m:barPr>${wrap('e', n.e)}</m:bar>`;
    case 'matrix': return `<m:m><m:mPr><m:mcs><m:mc><m:mcPr>${on('count', n.columns)}${on('mcJc', 'center')}</m:mcPr></m:mc></m:mcs></m:mPr>${n.rows.map(row => `<m:mr>${row.map(cell => wrap('e', cell)).join('')}</m:mr>`).join('')}</m:m>`;
    case 'eqArr': return `<m:eqArr>${n.rows.map(row => wrap('e', row)).join('')}</m:eqArr>`;
    default: return '';
  }
}

/** Office Math markup for linear-format input; display wraps it in m:oMathPara. */
export function linearToOmml(input, { display = false } = {}) {
  const ns = `xmlns:m="${MATH}" xmlns:w="${W}"`, body = omml(parseLinearMath(input).body);
  return display ? `<m:oMathPara ${ns}><m:oMath>${body}</m:oMath></m:oMathPara>` : `<m:oMath ${ns}>${body}</m:oMath>`;
}

/** Linear text for existing Office Math markup, to edit it in the input box. */
export function ommlToLinear(xml) {
  const parse = text => {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    return doc.getElementsByTagName('parsererror').length ? null : doc.documentElement;
  };
  let root = parse(xml);
  // Retained fragments may rely on namespace prefixes declared by an ancestor.
  if (!root) root = parse(`<root xmlns:m="${MATH}" xmlns:w="${W}">${xml}</root>`)?.firstElementChild;
  return root ? linearMath(root).replace(/[ \t\r\n]+/g, ' ').trim() : '';
}

/*
 * Linear text that builds the same equation again, for Edit Equation. The display form above (the
 * equation's text in the document) is easy to read but loses structure when typed back: a binomial
 * reads as a fraction, a matrix as brackets, ∛x as 3√x. This one writes each structure in the input
 * syntax above. Structures that syntax has no form for keep their contents.
 */
const editableRoot = xml => {
  const parse = text => { const doc = new DOMParser().parseFromString(text, 'application/xml'); return doc.getElementsByTagName('parsererror').length ? null : doc.documentElement; };
  return parse(xml) || parse(`<root xmlns:m="${MATH}" xmlns:w="${W}">${xml}</root>`)?.firstElementChild || null;
};
const ACCENT_NAMES = Object.fromEntries(Object.entries(ACCENTS).filter(([name, chr]) => !['bar', 'top', 'bot'].includes(name) && chr.length === 1).map(([name, chr]) => [chr, name]));
const SPECIAL = new Set([...'()[]{}⟨⟩⌊⌋⌈⌉|‖^_/¦&@▒√∛∜■█"\\\'', ...NARY, ...OPS]);
const mathKids = (node, name) => [...(node?.children || [])].filter(n => n.namespaceURI === MATH && (!name || n.localName === name));
const mathChild = (node, name) => mathKids(node, name)[0] || null;
const mathVal = (node, name) => mathChild(node, name)?.getAttributeNS(MATH, 'val') ?? mathChild(node, name)?.getAttribute('m:val') ?? null;
const runText = node => [...node.getElementsByTagNameNS(MATH, 't'), ...node.getElementsByTagNameNS(W, 't')].map(t => t.textContent).join('');
const plainRun = node => mathVal(mathChild(node, 'rPr'), 'sty') === 'p' || !!mathChild(mathChild(node, 'rPr'), 'nor');
// One character, a number or a run of Latin letters reads back as one operand of a script or fraction.
const single = text => [...text].length === 1 ? !SPECIAL.has(text) && !/[\s\p{M}]/u.test(text) : /^\d+(\.\d+)?$/.test(text) || /^[A-Za-z]+$/.test(text) && !FUNCS.has(text);
const singleChar = text => [...text].length === 1 && single(text) || /^\d+(\.\d+)?$/.test(text);

/** Items of an argument (m:e, m:num, m:sub...): [{ text, kind: 'op' | 'run' | 'plain' | structure name }]. */
function editableItems(node) {
  const items = [];
  for (const child of [...(node?.children || [])]) {
    if (child.namespaceURI === W) { if (child.localName === 'r') { const text = runText(child); if (text) items.push({ text, kind: 'run' }); } continue; }
    if (child.namespaceURI !== MATH || /Pr$/.test(child.localName)) continue;
    if (child.localName === 'r') {
      const text = runText(child);
      if (!text) continue;
      if (plainRun(child) && !text.includes('"')) { items.push({ text: `"${text}"`, kind: 'plain' }); continue; }
      // Operators stand alone; other characters join the runs beside them.
      for (const ch of [...text]) {
        if (OPS.has(ch === '−' ? '-' : ch) || OPS.has(ch)) items.push({ text: ch, kind: 'op' });
        else if (items.at(-1)?.kind === 'run') items.at(-1).text += ch;
        else items.push({ text: ch, kind: 'run' });
      }
      continue;
    }
    items.push({ text: editableNode(child), kind: child.localName, node: child });
  }
  return items;
}
// A space ends a script, a fraction's operand and a function's argument; it builds into nothing.
function spaced(previous, item) {
  if (!previous || previous.kind === 'op' || item.kind === 'op') return false;
  if (previous.kind === 'f' || item.kind === 'f') return true;
  const text = kind => kind === 'run' || kind === 'plain';
  if (text(previous.kind) && text(item.kind)) return false;
  // Letters on both sides would read as one word.
  if (text(previous.kind)) return /[A-Za-z]$/.test(previous.text) && /^[A-Za-z\\]/.test(item.text);
  return previous.kind !== 'd';
}
function editableSequence(node) {
  let out = '', previous = null;
  for (const item of editableItems(node)) { if (spaced(previous, item)) out += ' '; out += item.text; previous = item; }
  return out;
}
const bracket = text => `(${text})`;
// A script's operand, as scriptOperand reads it: one operand, or a bracketed group it unwraps.
function scriptArgument(node) {
  const items = editableItems(node);
  if (items.length === 1 && items[0].kind === 'run' && single(items[0].text)) return items[0].text;
  if (items.length === 2 && items[0].kind === 'op' && SIGNS.has(items[0].text) && items[1].kind === 'run' && single(items[1].text)) return items[0].text + items[1].text;
  return bracket(editableSequence(node));
}
// A fraction's numerator or denominator: a single character or number as it is, anything else bracketed.
function fractionPart(node) {
  const items = editableItems(node);
  return items.length === 1 && items[0].kind === 'run' && singleChar(items[0].text) ? items[0].text : bracket(editableSequence(node));
}
// The base of a script or mark: one operand the script attaches to.
function base(node) {
  const items = editableItems(node);
  if (items.length === 1 && (items[0].kind === 'run' && singleChar(items[0].text) || ['d', 'acc', 'bar'].includes(items[0].kind) && !/^\w+\(/.test(items[0].text))) return items[0].text;
  return bracket(editableSequence(node));
}
// Structures nested more deeply than Office Math's depth limit (each spans two or more elements)
// read back as their plain text rather than exhausting the stack.
let editableDepth = 0;
function editableNode(node) {
  if (editableDepth >= MATH_DEPTH_LIMIT / 2) return mathPlainText(node);
  editableDepth++;
  try { return editableStructure(node); } finally { editableDepth--; }
}
function editableStructure(node) {
  const e = mathChild(node, 'e');
  switch (node.localName) {
    case 'oMathPara': return mathKids(node, 'oMath').map(editableNode).join(' ');
    case 'oMath': return editableSequence(node);
    case 'f': return `${fractionPart(mathChild(node, 'num'))}${mathVal(mathChild(node, 'fPr'), 'type') === 'noBar' ? '¦' : '/'}${fractionPart(mathChild(node, 'den'))}`;
    case 'sSup': return `${base(e)}^${scriptArgument(mathChild(node, 'sup'))}`;
    case 'sSub': return `${base(e)}_${scriptArgument(mathChild(node, 'sub'))}`;
    case 'sSubSup': return `${base(e)}_${scriptArgument(mathChild(node, 'sub'))}^${scriptArgument(mathChild(node, 'sup'))}`;
    case 'rad': {
      const degree = editableSequence(mathChild(node, 'deg')), body = editableSequence(e);
      const items = editableItems(e);
      return degree ? `√(${degree}&${body})` : items.length === 1 && items[0].kind === 'run' && singleChar(items[0].text) ? `√${body}` : `√${bracket(body)}`;
    }
    case 'd': {
      const pr = mathChild(node, 'dPr'), open = mathVal(pr, 'begChr') ?? '(', close = mathVal(pr, 'endChr') ?? ')', parts = mathKids(node, 'e').map(editableSequence);
      return `${open}${parts.join(mathVal(pr, 'sepChr') ?? '|')}${close}`;
    }
    case 'nary': {
      const pr = mathChild(node, 'naryPr'), sub = mathChild(node, 'sub'), sup = mathChild(node, 'sup');
      const scripts = `${editableSequence(sub) ? `_${scriptArgument(sub)}` : ''}${editableSequence(sup) ? `^${scriptArgument(sup)}` : ''}`;
      return `${mathVal(pr, 'chr') ?? '∫'}${scripts} ${editableSequence(e)}`;
    }
    case 'func': {
      const name = mathChild(node, 'fName'), [only] = mathKids(name);
      let fname;
      if (mathKids(name).length === 1 && only.localName === 'limLow') fname = `${runText(mathChild(only, 'e'))}_${scriptArgument(mathChild(only, 'lim'))}`;
      else if (mathKids(name).length === 1 && ['sSup', 'sSub', 'sSubSup'].includes(only.localName)) {
        const word = runText(mathChild(only, 'e'));
        fname = `${FUNCS.has(word) ? word : `\\operatorname{${word}}`}${mathChild(only, 'sub') ? `_${scriptArgument(mathChild(only, 'sub'))}` : ''}${mathChild(only, 'sup') ? `^${scriptArgument(mathChild(only, 'sup'))}` : ''}`;
      } else { const word = runText(name); fname = FUNCS.has(word) ? word : `\\operatorname{${word}}`; }
      // The argument is the terms up to the next space or operator, or one bracketed group.
      const items = editableItems(e), simple = items.length && items.every(item => item.kind === 'run' || ['sSup', 'sSub', 'sSubSup', 'acc', 'bar'].includes(item.kind)) && items.length === 1 || items.length > 1 && items.every(item => item.kind === 'run');
      const argument = items.length === 1 && items[0].kind === 'd' ? items[0].text : simple ? items.map(item => item.text).join('') : bracket(editableSequence(e));
      return `${fname} ${argument}`;
    }
    case 'acc': {
      const chr = mathVal(mathChild(node, 'accPr'), 'chr') ?? '̂', items = editableItems(e);
      if (items.length === 1 && items[0].kind === 'run' && singleChar(items[0].text) && [...items[0].text].length === 1 && /\p{M}/u.test(chr)) return `${items[0].text}${chr}`;
      return ACCENT_NAMES[chr] ? `${ACCENT_NAMES[chr]}${bracket(editableSequence(e))}` : `${base(e)}${chr}`;
    }
    case 'bar': {
      const top = (mathVal(mathChild(node, 'barPr'), 'pos') ?? 'bot') === 'top', items = editableItems(e);
      if (items.length === 1 && items[0].kind === 'run' && [...items[0].text].length === 1 && single(items[0].text)) return `${items[0].text}${top ? '̅' : '̲'}`;
      return `${top ? 'overline' : 'underline'}${bracket(editableSequence(e))}`;
    }
    case 'm': return `■(${mathKids(node, 'mr').map(row => mathKids(row, 'e').map(editableSequence).join('&')).join('@')})`;
    case 'eqArr': return `█(${mathKids(node, 'e').map(editableSequence).join('@')})`;
    case 'limLow': return `${base(e)}_${scriptArgument(mathChild(node, 'lim'))}`;
    case 'limUpp': return `${base(e)}^${scriptArgument(mathChild(node, 'lim'))}`;
    // Structures the input syntax has no form for (boxes, group characters, phantoms, prescripts) keep their text.
    default: return linearMath(node);
  }
}

/** Linear text for existing Office Math markup that builds the same equation again when typed back. */
export function ommlToEditableLinear(xml) {
  const root = editableRoot(xml);
  return root ? editableNode(root).replace(/[\r\n]+/g, ' ').trim() : '';
}

export const EQUATION_GALLERY = [
  { id: 'circle-area', name: 'Area of a circle', linear: 'A=πr^2' },
  { id: 'quadratic', name: 'Quadratic formula', linear: 'x=(-b±√(b^2-4ac))/2a' },
  { id: 'pythagorean', name: 'Pythagorean theorem', linear: 'a^2+b^2=c^2' },
  { id: 'binomial', name: 'Binomial theorem', linear: '(a+b)^n=∑_(k=0)^n (n¦k) a^k b^(n-k)' },
  { id: 'sum-integers', name: 'Sum of the first n integers', linear: '∑_(k=1)^n k=n(n+1)/2' },
  { id: 'taylor', name: 'Taylor series', linear: 'f(x)=∑_(n=0)^∞ (f^((n))(a))/n! (x-a)^n' },
  { id: 'exponential', name: 'Exponential series', linear: 'e^x=1+x/1!+x^2/2!+x^3/3!+⋯' },
  { id: 'fourier', name: 'Fourier series', linear: 'f(x)=a_0/2+∑_(n=1)^∞ (a_n cos(nπx/L)+b_n sin(nπx/L))' },
  { id: 'trig-identity', name: 'Trigonometric identity', linear: 'sin^2 θ+cos^2 θ=1' },
  { id: 'euler', name: "Euler's identity", linear: 'e^(iπ)+1=0' },
  { id: 'gaussian-integral', name: 'Gaussian integral', linear: '∫_(-∞)^∞ e^(-x^2) dx=√π' },
  { id: 'determinant', name: 'Determinant of a 2×2 matrix', linear: '|■(a&b@c&d)|=ad-bc' },
  { id: 'limit-e', name: 'Limit defining e', linear: 'lim_(n→∞) (1+1/n)^n=e' },
];
