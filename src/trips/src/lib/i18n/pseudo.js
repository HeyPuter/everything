// en-XA: accented and about 40% longer, in brackets, so clipped, hard-coded or concatenated text stands out.
const ACCENTS = {
  a: 'á', b: 'ƀ', c: 'ç', d: 'đ', e: 'é', f: 'ƒ', g: 'ğ', h: 'ĥ', i: 'í', j: 'ĵ', k: 'ķ', l: 'ļ', m: 'ɱ',
  n: 'ñ', o: 'ö', p: 'þ', q: 'ǫ', r: 'ŕ', s: 'š', t: 'ŧ', u: 'û', v: 'ṽ', w: 'ŵ', x: 'ẋ', y: 'ý', z: 'ž',
  A: 'Å', B: 'Ɓ', C: 'Ç', D: 'Đ', E: 'É', F: 'Ƒ', G: 'Ğ', H: 'Ĥ', I: 'Î', J: 'Ĵ', K: 'Ķ', L: 'Ļ', M: 'Ṁ',
  N: 'Ñ', O: 'Ö', P: 'Þ', Q: 'Ǫ', R: 'Ŕ', S: 'Š', T: 'Ŧ', U: 'Û', V: 'Ṽ', W: 'Ŵ', X: 'Ẋ', Y: 'Ý', Z: 'Ž',
};

export function pseudo(text) {
  if (!/[A-Za-z]/.test(text.replace(/\{\w+\}/g, ''))) return text;
  const accented = text.split(/(\{\w+\})/).map((part, index) => (index % 2 ? part : part.replace(/[A-Za-z]/g, (char) => ACCENTS[char]))).join('');
  const padding = Math.max(1, Math.round(text.length * 0.3));
  return `[${accented} ${'·'.repeat(padding)}]`;
}

export function pseudoStrings(english) {
  return Object.freeze(Object.fromEntries(Object.entries(english).map(([key, value]) => [key, pseudo(value)])));
}
