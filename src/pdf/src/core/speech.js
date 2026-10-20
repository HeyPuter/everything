/**
 * Page text cut into pieces to speak one after another, whole sentences where they fit.
 * Chrome stops speaking a long utterance after about fifteen seconds without ever ending it,
 * so a page read as one utterance fell silent partway and Read to end never moved on.
 */
export function speechChunks(text, { max = 200, lang } = {}) {
  const flowing = String(text).replace(/\s+/g, ' ').trim();
  if (!flowing) return [];
  const sentences =
    typeof Intl.Segmenter === 'function'
      ? Array.from(
          new Intl.Segmenter(lang, { granularity: 'sentence' }).segment(flowing),
          (part) => part.segment,
        )
      : [flowing];
  const chunks = [];
  let current = '';
  const add = (piece) => {
    if (current && current.length + piece.length > max) {
      chunks.push(current.trim());
      current = '';
    }
    current += piece;
  };
  for (let sentence of sentences) {
    // A sentence too long to speak whole breaks at the last space that fits.
    while (sentence.length > max) {
      const space = sentence.lastIndexOf(' ', max);
      const at = space > 0 ? space + 1 : max;
      add(sentence.slice(0, at));
      sentence = sentence.slice(at);
    }
    add(sentence);
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}
