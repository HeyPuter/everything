import { it, expect } from 'vitest';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { emptyStyles } from '../src/engine/styles.js';

// A style list checks every style by resolving its whole basedOn chain, which costs the square of
// the chain's length. The toolbar refreshes it on every keystroke, so a file with a chain 3,000
// styles long took over five seconds per key.
it('checks the styles once for a styles and numbering pair, and again after a style edit', () => {
  const styles = emptyStyles(), depth = 600;
  for (let i = 0; i < depth; i++) styles.definitions[`S${i}`] = { id: `S${i}`, type: 'paragraph', name: `Style ${i}`, basedOn: i ? `S${i - 1}` : null, next: null, properties: {}, reference: {}, run: { bold: i % 2 === 0 } };
  styles.definitions.Broken = { id: 'Broken', type: 'paragraph', name: 'Broken', basedOn: 'Loop', properties: {}, reference: {}, run: {} };
  styles.definitions.Loop = { id: 'Loop', type: 'paragraph', name: 'Loop', basedOn: 'Broken', properties: {}, reference: {}, run: {} };
  styles.definitions.Strong = { id: 'Strong', type: 'character', name: 'Strong', basedOn: null, run: { bold: true } };
  const doc = new TextDocument([paragraph('Text', { styleId: `S${depth - 1}` })], undefined, undefined, styles);
  let started = performance.now();
  const first = doc.paragraphStyles;
  const firstTime = performance.now() - started;
  expect(first).toHaveLength(depth + 2);
  expect(first.find(s => s.id === 'Loop').error).toBe('Cyclic style inheritance is not supported.');
  expect(first.find(s => s.id === `S${depth - 1}`)).toEqual({ id: `S${depth - 1}`, name: `Style ${depth - 1}`, error: undefined });
  started = performance.now();
  for (let i = 0; i < 10; i++) expect(doc.paragraphStyles).toEqual(first);
  expect(performance.now() - started).toBeLessThan(firstTime);
  // Callers get their own copies.
  doc.paragraphStyles[0].name = 'Changed';
  expect(doc.paragraphStyles[0].name).toBe('Style 0');
  expect(doc.characterStyles).toEqual([{ id: 'Strong', name: 'Strong', error: undefined }]);
  // A style edit replaces the styles, and the list follows it.
  doc.select(0); doc.editParagraphStyle('S0', { name: 'Renamed' });
  expect(doc.paragraphStyles[0].name).toBe('Renamed');
  doc.undo();
  expect(doc.paragraphStyles[0].name).toBe('Style 0');
});
