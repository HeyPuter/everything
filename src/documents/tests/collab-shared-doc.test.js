import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { diffText } from '../src/collab/text-diff.js';
import { encodeParagraph, readBody, readState, writeState, createSharedDoc, unsupportedReason } from '../src/collab/shared-doc.js';

const stateOf = m => ({ paragraphs: m.paragraphs, tables: m.tables, styles: m.styles, stylesEnabled: m.stylesEnabled, numbering: m.numbering, pageSettings: m.pageSettings, comments: m.comments, trackChanges: m.trackChanges, stories: {} });
const modelFrom = state => new TextDocument(state.paragraphs, state.pageSettings, state.numbering, state.stylesEnabled ? state.styles : undefined, state.tables, {}, { comments: state.comments, trackChanges: state.trackChanges });
// Paragraph ids are local bookkeeping; compare what a reader sees.
const visible = m => m.paragraphs.map(p => ({ format: p.format, runs: p.runs.map(r => ({ text: r.text, bold: r.bold, italic: r.italic })), bookmarks: (p.bookmarks || []).map(({ offset, id, edge }) => [id, edge, offset]) }));

/** Seeded pseudo-random numbers, so a failing case can be replayed. */
function random(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

class Peer {
  constructor(name, ydoc) {
    this.name = name; this.ydoc = ydoc; this.outbox = [];
    this.model = modelFrom(readState(ydoc));
    ydoc.on('update', (update, origin) => { if (origin === this) this.outbox.push(update); });
  }
  edit(fn) {
    fn(this.model);
    writeState(this.ydoc, stateOf(this.model), this);
  }
  receive(update) {
    Y.applyUpdate(this.ydoc, update, 'remote');
    const selection = this.model.selection;
    this.model = modelFrom(readState(this.ydoc));
    this.model.select(Math.min(selection.anchor, this.model.text.length), Math.min(selection.focus, this.model.text.length));
  }
}

function pair(paragraphs) {
  const seed = new TextDocument(paragraphs);
  const origin = createSharedDoc(stateOf(seed));
  const start = Y.encodeStateAsUpdate(origin);
  const docs = [new Y.Doc(), new Y.Doc()];
  docs.forEach(d => Y.applyUpdate(d, start));
  return docs.map((d, i) => new Peer(i ? 'bob' : 'ann', d));
}
const deliverAll = peers => {
  for (const from of peers) {
    const updates = from.outbox.splice(0);
    for (const to of peers) if (to !== from) for (const u of updates) to.receive(u);
  }
};

describe('text diff', () => {
  it('finds insertions and deletions in the middle', () => {
    expect(diffText('hello world', 'hello brave world')).toEqual([{ type: 'equal', length: 6 }, { type: 'insert', length: 6 }, { type: 'equal', length: 5 }]);
    expect(diffText('abcdef', 'abef')).toEqual([{ type: 'equal', length: 2 }, { type: 'delete', length: 2 }, { type: 'equal', length: 2 }]);
  });
  it('applies to the target string', () => {
    const rnd = random(7), chars = 'ab\ncd';
    for (let n = 0; n < 200; n++) {
      const make = () => Array.from({ length: Math.floor(rnd() * 12) }, () => chars[Math.floor(rnd() * chars.length)]).join('');
      const a = make(), b = make();
      let ai = 0, bi = 0, out = '';
      for (const s of diffText(a, b)) {
        if (s.type === 'equal') { out += a.slice(ai, ai + s.length); ai += s.length; bi += s.length; }
        else if (s.type === 'insert') { out += b.slice(bi, bi + s.length); bi += s.length; }
        else ai += s.length;
      }
      expect(out).toBe(b);
    }
  });
  it('never splits a surrogate pair', () => {
    // 😀 and 😃 share their high surrogate; a code-unit script would cut between the halves.
    expect(diffText('A\u{1F603}', 'A\u{1F600}\u{1F603}')).toEqual([{ type: 'equal', length: 1 }, { type: 'insert', length: 2 }, { type: 'equal', length: 2 }]);
    expect(diffText('x\u{1F600}y', 'x\u{1F603}y')).toEqual([{ type: 'equal', length: 1 }, { type: 'delete', length: 2 }, { type: 'insert', length: 2 }, { type: 'equal', length: 1 }]);
    const rnd = random(11), chars = ['a', '\u{1F600}', '\u{1F603}', '\u{1F4A9}', '\n'];
    for (let n = 0; n < 200; n++) {
      const make = () => Array.from({ length: Math.floor(rnd() * 10) }, () => chars[Math.floor(rnd() * chars.length)]).join('');
      const a = make(), b = make();
      let ai = 0, bi = 0, out = '';
      const whole = (text, i) => !/[\udc00-\udfff]/.test(text[i] || '');
      for (const s of diffText(a, b)) {
        expect(whole(a, ai) && whole(b, bi)).toBe(true);
        if (s.type === 'equal') { out += a.slice(ai, ai + s.length); ai += s.length; bi += s.length; }
        else if (s.type === 'insert') { out += b.slice(bi, bi + s.length); bi += s.length; }
        else ai += s.length;
      }
      expect(out).toBe(b);
    }
  });
});

describe('shared document mapping', () => {
  it('round-trips paragraphs, run formatting and paragraph properties', () => {
    const m = new TextDocument([paragraph('Hello world'), paragraph('Second')]);
    m.select(0, 5); m.toggleBold();
    m.select(13); m.setParagraphFormat({ alignment: 'center' });
    const ydoc = createSharedDoc(stateOf(m));
    const back = readState(ydoc);
    expect(back.paragraphs.map(p => p.runs.map(r => [r.text, r.bold]))).toEqual([[['Hello', true], [' world', false]], [['Second', false]]]);
    expect(back.paragraphs[1].format.alignment).toBe('center');
    expect(ydoc.getText('body').toString()).toBe('Hello world\nSecond\n');
    // Every model position is the same index in the shared text.
    expect(modelFrom(back).text).toBe(m.text);
  });

  it('places markers on the character at their offset, so typing before them moves them', () => {
    const [ann, bob] = pair([paragraph('one two three')]);
    ann.edit(m => { m.select(4); m.addBookmark('mark'); });
    deliverAll([ann, bob]);
    bob.edit(m => { m.select(0); m.replace('zero '); });
    deliverAll([ann, bob]);
    const at = ann.model.bookmarks.find(b => b.name === 'mark').start;
    expect(ann.model.text.slice(at)).toBe('two three');
    expect(visible(ann.model)).toEqual(visible(bob.model));
  });

  it('merges concurrent typing in one paragraph', () => {
    const [ann, bob] = pair([paragraph('The cat sat.')]);
    ann.edit(m => { m.select(4); m.replace('black '); });
    bob.edit(m => { m.select(11); m.replace(' down'); });
    deliverAll([ann, bob]);
    expect(ann.model.text).toBe('The black cat sat down.');
    expect(bob.model.text).toBe(ann.model.text);
  });

  it('keeps typing that lands in a paragraph someone else splits', () => {
    const [ann, bob] = pair([paragraph('first second')]);
    ann.edit(m => { m.select(5, 6); m.replace('\n'); });
    bob.edit(m => { m.select(12); m.replace(' third'); });
    deliverAll([ann, bob]);
    expect(ann.model.text).toBe('first\nsecond third');
    expect(bob.model.text).toBe(ann.model.text);
  });

  it('merges bold from one person with italic from another on the same words', () => {
    const [ann, bob] = pair([paragraph('shared words')]);
    ann.edit(m => { m.select(0, 6); m.toggleBold(); });
    bob.edit(m => { m.select(0, 6); m.toggleItalic(); });
    deliverAll([ann, bob]);
    const run = ann.model.paragraphs[0].runs[0];
    expect([run.text, run.bold, run.italic]).toEqual(['shared', true, true]);
    expect(visible(bob.model)).toEqual(visible(ann.model));
  });

  it('keeps adjacent pictures as separate runs', () => {
    const m = new TextDocument([paragraph('')]);
    m.assets.a = { bytes: new Uint8Array([1]), mime: 'image/png' };
    m.insertImage('a', { width: 100, height: 100 });
    m.select(1); m.insertImage('a', { width: 100, height: 100 });
    const back = readState(createSharedDoc(stateOf(m)));
    expect(back.paragraphs[0].runs.filter(r => r.image).length).toBe(2);
  });

  it('reports content it cannot co-edit character by character', () => {
    expect(unsupportedReason({ paragraphs: [{ runs: [{ text: '', contentControl: { id: 1 } }] }] })).toMatch(/content controls/);
    expect(unsupportedReason({ paragraphs: [paragraph('fine')] })).toBe(null);
  });

  it('encodes each paragraph mark with the paragraph properties', () => {
    const e = encodeParagraph({ id: 'p1', runs: [{ text: 'ab', bold: true }], format: { alignment: 'right' } });
    expect(e.text).toBe('ab\n');
    expect(e.attrs.get(e.keys[2])['p:format']).toBe('{"alignment":"right"}');
    expect(e.attrs.get(e.keys[0])['r:bold']).toBe('true');
  });

  it('converges under random concurrent edits from three people', () => {
    const words = ['alpha', 'beta', ' ', '\n', 'gamma ', 'δ', '😀'];
    for (let seed = 1; seed <= 25; seed++) {
      const rnd = random(seed);
      const seedModel = new TextDocument([paragraph('One two three.'), paragraph('Four five six.'), paragraph('Seven.')]);
      const start = Y.encodeStateAsUpdate(createSharedDoc(stateOf(seedModel)));
      const peers = ['a', 'b', 'c'].map(name => { const d = new Y.Doc(); Y.applyUpdate(d, start); return new Peer(name, d); });
      for (let step = 0; step < 30; step++) {
        const peer = peers[Math.floor(rnd() * peers.length)];
        const choice = rnd();
        peer.edit(m => {
          const length = m.text.length;
          const a = Math.floor(rnd() * (length + 1)), b = Math.min(length, a + Math.floor(rnd() * 6));
          m.select(a, choice < 0.3 ? a : b);
          if (choice < 0.55) m.replace(words[Math.floor(rnd() * words.length)]);
          else if (choice < 0.7) { if (a !== b) m.replace(''); }
          else if (choice < 0.8) m.toggleBold();
          else if (choice < 0.9) m.toggleItalic();
          else m.setParagraphFormat({ alignment: ['left', 'center', 'right'][Math.floor(rnd() * 3)] });
        });
        // Deliver some of the pending updates, in a random order.
        if (rnd() < 0.4) {
          const from = peers[Math.floor(rnd() * peers.length)];
          const updates = from.outbox.splice(0);
          for (const to of peers) if (to !== from) for (const u of updates) to.receive(u);
        }
      }
      deliverAll(peers); deliverAll(peers);
      const texts = peers.map(p => p.ydoc.getText('body').toString());
      expect(new Set(texts).size, `seed ${seed}`).toBe(1);
      const views = peers.map(p => JSON.stringify(visible(p.model)));
      expect(new Set(views).size, `seed ${seed}`).toBe(1);
      // The shared text and the model agree on every position.
      expect(peers[0].model.text + '\n').toBe(texts[0]);
    }
  });

  it('reads a body without a final mark', () => {
    const ydoc = new Y.Doc();
    ydoc.getText('body').insert(0, 'loose');
    expect(readBody(ydoc.getText('body')).map(p => p.runs.map(r => r.text).join(''))).toEqual(['loose']);
  });
});

describe('typing in a table while someone else changes its structure', () => {
  // A 3×2 table after "Intro": cells in reading order are [r1c1, r1c2, r2c1, r2c2, r3c1, r3c2].
  const start = () => {
    const seed = new TextDocument([paragraph('Intro')]);
    seed.select(5); seed.insertTable(3, 2);
    const origin = createSharedDoc(stateOf(seed));
    const update = Y.encodeStateAsUpdate(origin);
    // Fixed client ids: Yjs orders insertions made at one place at the same moment by them.
    return ['ann', 'bob'].map((name, i) => { const d = new Y.Doc(); d.clientID = 1000 + i; Y.applyUpdate(d, update); return new Peer(name, d); });
  };
  const cells = m => (m.tables[0]?.rows || []).flatMap(r => r.cells.map(c => c.id));
  const at = (m, cellId) => { m.select(m.paragraphOffset(m.paragraphs.findIndex(p => p.cellId === cellId))); };
  const holder = (m, text) => m.paragraphs.find(p => p.runs.some(r => r.text.includes(text)))?.cellId;
  const cases = {
    'inserts a row': (m, ids) => { at(m, ids[0]); m.insertTableRow(); },
    'deletes a row': (m, ids) => { at(m, ids[0]); m.deleteTablePart('row'); },
    'inserts a column': (m, ids) => { at(m, ids[0]); m.insertTableColumn(); },
    'deletes a column': (m, ids) => { at(m, ids[0]); m.deleteTablePart('column'); },
    'merges cells': (m, ids) => { const a = m.paragraphOffset(m.paragraphs.findIndex(p => p.cellId === ids[0])), b = m.paragraphOffset(m.paragraphs.findIndex(p => p.cellId === ids[1])); m.select(a, b); m.mergeCells(); },
  };
  // The cell typed in: not one a new row or column goes right before (see below).
  const targets = { 'inserts a row': 3, 'deletes a row': 3, 'inserts a column': 2, 'deletes a column': 3, 'merges cells': 3 };
  for (const [name, change] of Object.entries(cases)) {
    it(`keeps text typed in another cell in that cell when someone ${name}`, () => {
      const [ann, bob] = start();
      const ids = cells(ann.model), target = ids[targets[name]];
      ann.edit(m => change(m, ids));
      bob.edit(m => { at(m, target); m.replace('B2'); });
      deliverAll([ann, bob]);
      for (const peer of [ann, bob]) {
        expect(holder(peer.model, 'B2'), `${peer.name}`).toBe(target);
        // The table reads back whole: every cell has its paragraphs, in reading order.
        expect(() => modelFrom(readState(peer.ydoc))).not.toThrow();
      }
      expect(bob.ydoc.getText('body').toString()).toBe(ann.ydoc.getText('body').toString());
      expect(JSON.stringify(visible(bob.model))).toBe(JSON.stringify(visible(ann.model)));
    });
  }
  it('keeps text typed in a cell someone else merges into the cell beside it, in the merged cell', () => {
    const [ann, bob] = start();
    const ids = cells(ann.model);
    ann.edit(m => cases['merges cells'](m, ids));
    bob.edit(m => { at(m, ids[1]); m.replace('B1'); });
    deliverAll([ann, bob]);
    for (const peer of [ann, bob]) {
      expect(() => modelFrom(readState(peer.ydoc))).not.toThrow();
      expect(holder(peer.model, 'B1')).toBe(ids[0]);
    }
    expect(bob.ydoc.getText('body').toString()).toBe(ann.ydoc.getText('body').toString());
  });
  it('keeps text typed in a row someone else deletes, and the table whole', () => {
    const [ann, bob] = start();
    const ids = cells(ann.model);
    ann.edit(m => { at(m, ids[2]); m.deleteTablePart('row'); });
    bob.edit(m => { at(m, ids[3]); m.replace('Lost?'); });
    deliverAll([ann, bob]);
    for (const peer of [ann, bob]) {
      expect(() => modelFrom(readState(peer.ydoc))).not.toThrow();
      expect(peer.model.tables[0].rows).toHaveLength(2);
      // No paragraph refers to a cell that is gone.
      const live = new Set(cells(peer.model));
      expect(peer.model.paragraphs.filter(p => p.cellId && !live.has(p.cellId))).toEqual([]);
      // What was typed there is kept, in the cell after it.
      expect(holder(peer.model, 'Lost?')).toBe(ids[4]);
    }
    expect(bob.ydoc.getText('body').toString()).toBe(ann.ydoc.getText('body').toString());
  });

  it('stays whole and keeps everyone\'s typing under random row and column changes by one person', () => {
    // Typing goes on after text already in a cell. (Typing into an empty cell right where someone else inserts a row
    // or column at the same moment can still land in a new cell: the two insertions share one place in the text.)
    const filled = () => {
      const seed = new TextDocument([paragraph('Intro')]);
      seed.select(5); seed.insertTable(3, 2);
      seed.tables[0].rows.flatMap(r => r.cells).forEach((c, i) => { seed.selectCell(c.id); seed.replace(`c${i}`); });
      const update = Y.encodeStateAsUpdate(createSharedDoc(stateOf(seed)));
      return ['ann', 'bob'].map((name, i) => { const d = new Y.Doc(); d.clientID = 1000 + i; Y.applyUpdate(d, update); return new Peer(name, d); });
    };
    const end = (m, cellId) => { const i = m.paragraphs.findLastIndex(p => p.cellId === cellId); m.select(m.paragraphOffset(i) + m.paragraphs[i].runs.reduce((n, r) => n + r.text.length, 0)); };
    for (let seed = 1; seed <= 40; seed++) {
      const rnd = random(seed);
      const [ann, bob] = filled();
      const typed = [];
      for (let step = 0; step < 12; step++) {
        const ids = cells(ann.model);
        if (!ids.length) break;
        const pick = () => ids[Math.floor(rnd() * ids.length)];
        const kind = ['inserts a row', 'deletes a row', 'inserts a column', 'deletes a column'][Math.floor(rnd() * 4)];
        try { ann.edit(m => cases[kind](m, [pick(), pick()])); } catch { /* a change the table refuses (the last row, say) */ }
        const own = cells(bob.model).filter(id => bob.model.paragraphs.some(p => p.cellId === id && p.runs.some(r => r.text)));
        if (!own.length) continue;
        const cell = own[Math.floor(rnd() * own.length)], word = `w${seed}x${step}z`;
        bob.edit(m => { end(m, cell); m.replace(rnd() < 0.2 ? `${word}\n${word}b` : word); });
        typed.push([word, cell]);
        if (rnd() < 0.6) deliverAll([ann, bob]);
      }
      deliverAll([ann, bob]); deliverAll([ann, bob]);
      expect(bob.ydoc.getText('body').toString(), `seed ${seed}`).toBe(ann.ydoc.getText('body').toString());
      const model = modelFrom(readState(ann.ydoc));
      const live = new Set(cells(model));
      expect(model.paragraphs.filter(p => p.cellId && !live.has(p.cellId)), `seed ${seed}`).toEqual([]);
      // What was typed in a cell that is still there is in that cell.
      for (const [word, cell] of typed) if (live.has(cell)) expect(holder(model, word), `seed ${seed} ${word}`).toBe(cell);
    }
  });
});
