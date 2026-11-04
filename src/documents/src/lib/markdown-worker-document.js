// The Markdown parser's browser build decodes a named character reference (&copy;) by setting it as an
// element's HTML, and a worker has no document. A stand-in element decodes it from the same table the
// parser's other builds read (a name it does not hold stays as written, which the parser takes as no match).
import { characterEntities } from 'character-entities';

if (typeof document === 'undefined') {
  globalThis.document = {
    createElement: () => {
      let text = '';
      return {
        set innerHTML(html) { const name = html.slice(1, -1); text = Object.hasOwn(characterEntities, name) ? characterEntities[name] : html; },
        get textContent() { return text; },
      };
    },
  };
}
