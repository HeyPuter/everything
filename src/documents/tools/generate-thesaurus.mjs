#!/usr/bin/env node
// Build public/thesaurus/en.json from a WordNet 3.1 dictionary directory (data.*, index.*, *.exc).
// Usage: node tools/generate-thesaurus.mjs <path/to/dict> [output.json]
//
// Output format (all indices are zero-based):
//   v  format version
//   w  string table: lemmas, synonyms and antonyms, sorted
//   g  glosses (definition only, shortened)
//   s  synsets: [pos, glossIndex, [synonym word indices], [antonym word indices]]
//      pos: 0 noun, 1 verb, 2 adjective, 3 adverb
//   x  per word index: list of synset indices for that lemma in sense order, or 0
//   e  irregular forms: [[form, baseWordIndex, pos], ...]
// The generator is deterministic: the same input gives byte-identical output.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const [dir, output = path.resolve(import.meta.dirname, '../public/thesaurus/en.json')] = process.argv.slice(2);
if (!dir) { console.error('Usage: node tools/generate-thesaurus.mjs <wordnet dict dir> [output.json]'); process.exit(1); }

const POS = ['noun', 'verb', 'adj', 'adv'];
const POS_CODE = { n: 0, v: 1, a: 2, s: 2, r: 3 };
const MAX_SENSES = 6, MAX_PER_POS = 4, MAX_SYNONYMS = 10, MAX_ANTONYMS = 6, GLOSS = 64;
const singleWord = lemma => /^[a-z][a-z'-]*$/.test(lemma) && !/--/.test(lemma);
const display = word => word.replace(/\((?:a|p|ip)\)$/, '').replace(/_/g, ' ');

/** Parse one data file into Map(offset → synset). */
function readData(pos) {
  const synsets = new Map();
  for (const line of fs.readFileSync(path.join(dir, `data.${pos}`), 'utf8').split('\n')) {
    if (!line || line.startsWith('  ')) continue;
    const [head, glossText = ''] = line.split(' | ');
    const f = head.trim().split(' ');
    let i = 0;
    const offset = f[i++]; i++; // lex_filenum
    const type = f[i++];
    const count = parseInt(f[i++], 16);
    const words = [];
    for (let k = 0; k < count; k++) { words.push(f[i++]); i++; }
    const pointerCount = parseInt(f[i++], 10);
    const pointers = [];
    for (let k = 0; k < pointerCount; k++) { pointers.push({ symbol: f[i], target: f[i + 1], pos: f[i + 2], source: parseInt(f[i + 3].slice(0, 2), 16), dest: parseInt(f[i + 3].slice(2), 16) }); i += 4; }
    synsets.set(`${POS_CODE[type] === 2 ? 'a' : type}${offset}`, { key: `${POS_CODE[type] === 2 ? 'a' : type}${offset}`, type, words, pointers, gloss: shortGloss(glossText) });
  }
  return synsets;
}
function shortGloss(text) {
  let gloss = text.split(/;\s*"/)[0].replace(/\s+/g, ' ').trim().replace(/;$/, '');
  if (gloss.length > GLOSS) gloss = gloss.slice(0, GLOSS).replace(/\s+\S*$/, '') + '…';
  return gloss;
}

const synsets = new Map();
for (const pos of POS) for (const [key, value] of readData(pos)) synsets.set(key, value);
const keyOf = (posLetter, offset) => `${POS_CODE[posLetter] === 2 ? 'a' : posLetter}${offset}`;

/** Index: lemma → [{ pos, keys in sense order }]. */
const index = new Map();
for (const pos of POS) {
  for (const line of fs.readFileSync(path.join(dir, `index.${pos}`), 'utf8').split('\n')) {
    if (!line || line.startsWith('  ')) continue;
    const f = line.trim().split(' ');
    const lemma = f[0], letter = f[1], senses = parseInt(f[2], 10), pointerCount = parseInt(f[3], 10);
    const tagged = parseInt(f[4 + pointerCount + 1], 10);
    const offsets = f.slice(4 + pointerCount + 2, 4 + pointerCount + 2 + senses);
    if (!singleWord(lemma)) continue;
    // Nouns never seen in the sense-tagged corpus are mostly specialist names: leave them out.
    if (letter === 'n' && !tagged) continue;
    if (!index.has(lemma)) index.set(lemma, []);
    // Untagged senses beyond the first are rare.
    index.get(lemma).push({ pos: POS_CODE[letter], keys: offsets.slice(0, Math.max(1, tagged)).map(o => keyOf(letter, o)) });
  }
}

function synonymsOf(synset, lemma) {
  const out = [];
  const add = word => { const shown = display(word); if (shown.toLowerCase() !== lemma && !out.some(w => w.toLowerCase() === shown.toLowerCase())) out.push(shown); };
  // Single words first; at most three phrases.
  const all = synset.words.map(display);
  for (const word of [...all.filter(w => !w.includes(' ')), ...all.filter(w => w.includes(' ')).slice(0, 3)]) add(word);
  // Adjective satellites lean on their head; heads offer their nearest satellites.
  // A satellite leans on its head adjective; a head offers the first words of a few satellites.
  if (synset.type === 's' || synset.type === 'a') for (const p of synset.pointers.filter(q => q.symbol === '&').slice(0, synset.type === 'a' ? 4 : 2)) { const other = synsets.get(keyOf(p.pos, p.target)); if (other) for (const word of other.words.slice(0, synset.type === 'a' ? 1 : 2)) add(word); }
  for (const p of synset.pointers) if (p.symbol === '^' && synset.type !== 'n') { const other = synsets.get(keyOf(p.pos, p.target)); if (other) add(other.words[0]); }
  return out.slice(0, MAX_SYNONYMS + (lemma ? 0 : 1));
}
function antonymsOf(synset, lemma) {
  const out = [];
  const add = word => { const shown = display(word); if (shown.toLowerCase() !== lemma && !out.includes(shown)) out.push(shown); };
  const direct = s => {
    for (const p of s.pointers) if (p.symbol === '!') {
      const other = synsets.get(keyOf(p.pos, p.target));
      if (!other) continue;
      if (p.dest) add(other.words[p.dest - 1]); else other.words.forEach(add);
    }
  };
  direct(synset);
  // Satellites inherit the antonyms of their head (indirect antonyms).
  if (synset.type === 's') for (const p of synset.pointers) if (p.symbol === '&') { const head = synsets.get(keyOf(p.pos, p.target)); if (head) direct(head); }
  return out.slice(0, MAX_ANTONYMS);
}

const kept = new Map(); // lemma → [synset keys]
for (const lemma of [...index.keys()].sort()) {
  const chosen = [];
  for (const group of index.get(lemma).sort((a, b) => a.pos - b.pos)) {
    let inPos = 0;
    for (const key of group.keys) {
      const synset = synsets.get(key);
      if (!synset || inPos >= MAX_PER_POS || chosen.length >= MAX_SENSES) continue;
      if (!synonymsOf(synset, lemma).length && !antonymsOf(synset, lemma).length) continue;
      chosen.push(key); inPos++;
    }
  }
  if (chosen.length) kept.set(lemma, chosen);
}

// Shared tables.
const usedKeys = [...new Set([...kept.values()].flat())].sort();
const words = new Set(kept.keys());
const built = new Map();
for (const key of usedKeys) {
  const synset = synsets.get(key);
  built.set(key, { pos: POS_CODE[synset.type], gloss: synset.gloss, synonyms: synonymsOf(synset, ''), antonyms: antonymsOf(synset, '') });
  for (const w of built.get(key).synonyms) words.add(w);
  for (const w of built.get(key).antonyms) words.add(w);
}
const exceptions = [];
for (const pos of POS) {
  const file = path.join(dir, `${pos}.exc`);
  if (!fs.existsSync(file)) continue;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const [form, base] = line.trim().split(' ');
    if (form && base && form !== base && kept.has(base) && singleWord(form)) exceptions.push([form, base, POS.indexOf(pos)]);
  }
}
const wordList = [...words].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
const wordIndex = new Map(wordList.map((w, i) => [w, i]));
const glosses = [...new Set([...built.values()].map(s => s.gloss))].sort();
const glossIndex = new Map(glosses.map((g, i) => [g, i]));
const synsetIndex = new Map(usedKeys.map((k, i) => [k, i]));
const data = {
  v: 1,
  source: 'WordNet 3.1',
  w: wordList,
  g: glosses,
  s: usedKeys.map(key => { const s = built.get(key); return [s.pos, glossIndex.get(s.gloss), s.synonyms.map(w => wordIndex.get(w)), s.antonyms.map(w => wordIndex.get(w))]; }),
  x: wordList.map(w => kept.has(w) ? kept.get(w).map(k => synsetIndex.get(k)) : 0),
  e: [...new Map(exceptions.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : a[2] - b[2]).map(e => [e.join(' '), e])).values()].map(([form, base, pos]) => [form, wordIndex.get(base), pos]),
};
const json = JSON.stringify(data);
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, json);
console.log(`entries ${kept.size}, words ${wordList.length}, synsets ${usedKeys.length}, glosses ${glosses.length}, irregular forms ${data.e.length}`);
console.log(`bytes ${Buffer.byteLength(json)}, sha256 ${createHash('sha256').update(json).digest('hex')}`);
