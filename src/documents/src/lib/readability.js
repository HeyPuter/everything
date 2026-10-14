/**
 * Document statistics and readability, computed locally (no text leaves the device).
 * Readability uses the published Flesch Reading Ease and Flesch–Kincaid Grade Level formulas
 * over an English syllable estimate; the passive-voice share is a pattern-based estimate.
 */

const segmenter = granularity => (typeof Intl?.Segmenter === 'function' ? new Intl.Segmenter('en', { granularity }) : null);
const WORDS = segmenter('word'), SENTENCES = segmenter('sentence');

/** Word-like segments of text (numbers count as words, as word processors count them). */
export function words(text) {
  if (!WORDS) return String(text).match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu) || [];
  const out = [];
  for (const s of WORDS.segment(String(text))) if (s.isWordLike) out.push(s.segment);
  return out;
}

/** Sentences that contain at least one word. */
export function sentences(text) {
  const source = String(text).replace(/[\u000b\f\u000e]/g, ' ');
  const pieces = SENTENCES ? [...SENTENCES.segment(source)].map(s => s.segment) : source.split(/(?<=[.!?])\s+/);
  return pieces.flatMap(piece => piece.split(/\n+/)).map(s => s.trim()).filter(s => words(s).length);
}

/** Estimated English syllables in one word: vowel groups, less silent endings, plus endings that are voiced. */
export function syllables(word) {
  const lower = String(word).toLowerCase().replace(/[^a-z]/g, '');
  if (!lower) return 0;
  if (lower.length <= 3) return 1;
  const stem = lower.replace(/(?:[^laeiouy]es|[^laeiouy]ed|[^laeiouy]e)$/, '').replace(/^y/, '');
  let count = stem.match(/[aeiouy]+/g)?.length || 0;
  // Vowel pairs said apart (ra-di-o, pi-a-no), but not in -tion/-cial/-gion/-lion/-nion endings.
  count += stem.match(/(?<![tscgln])i[ao]/g)?.length || 0;
  // "-ted"/"-ded" (wan-ted) and "-es" after a sibilant (box-es) are spoken.
  if (/[td]ed$/.test(lower) || /(?:[cgsxz]|ch|sh)es$/.test(lower)) count++;
  return Math.max(1, count);
}

// Past participles that do not end in -ed, for the passive estimate.
const IRREGULAR = new Set(('arisen awoken been borne beaten become begun bent bet bid bitten blown broken brought built burnt burst bought caught chosen clung come cost crept cut dealt dug done drawn dreamt drunk driven eaten fallen fed felt fought found fled flung flown forbidden forgotten forgiven frozen gotten given gone ground grown hung had heard hidden hit held hurt kept knelt known laid led leant leapt learnt left lent let lain lit lost made meant met paid put quit read ridden rung risen run said seen sought sold sent set shaken shed shone shot shown shrunk shut sung sunk sat slept slid slung slit spoken spent spilt spun spat split spread sprung stood stolen stuck stung stunk struck strung sworn swept swum swung taken taught torn told thought thrown thrust trodden understood woken worn woven wept won wound withdrawn written').split(' '));
const BE = /^(?:am|is|are|was|were|be|been|being|get|gets|got|gotten|getting|'s|’s|'re|’re)$/i;

/** Whether a sentence looks passive: a form of "be"/"get", optionally an adverb, then a past participle. */
export function isPassive(sentence) {
  const list = words(sentence).map(w => w.toLowerCase());
  for (let i = 0; i < list.length - 1; i++) {
    if (!BE.test(list[i])) continue;
    for (let j = i + 1; j <= Math.min(i + 2, list.length - 1); j++) {
      const w = list[j];
      if (/^[a-z]{3,}ed$/.test(w) && !/(?:need|feed|seed|speed|breed|bleed|indeed|exceed|proceed|succeed)$/.test(w) || IRREGULAR.has(w)) return true;
      if (!/ly$/.test(w)) break;
    }
  }
  return false;
}

const round = (value, digits = 1) => Number.isFinite(value) ? Math.round(value * 10 ** digits) / 10 ** digits : 0;

/**
 * Statistics for a text whose paragraphs are separated by "\n":
 * { words, characters, charactersNoSpaces, paragraphs, sentences, syllables,
 *   averages: { sentencesPerParagraph, wordsPerSentence, charactersPerWord },
 *   readability: { fleschReadingEase, fleschKincaidGrade, passivePercent } }.
 */
export function textStatistics(text) {
  const source = String(text).replace(/￼/g, '');
  const wordList = words(source);
  const paragraphList = source.split('\n').filter(p => words(p).length);
  const sentenceList = sentences(source);
  const syllableCount = wordList.reduce((n, w) => n + syllables(w), 0);
  const letters = wordList.reduce((n, w) => n + w.length, 0);
  const sentencesCount = Math.max(sentenceList.length, wordList.length ? 1 : 0);
  const wordsPerSentence = sentencesCount ? wordList.length / sentencesCount : 0;
  const syllablesPerWord = wordList.length ? syllableCount / wordList.length : 0;
  const passive = sentenceList.filter(isPassive).length;
  return {
    words: wordList.length,
    characters: [...source.replace(/\n/g, '')].length,
    charactersNoSpaces: [...source.replace(/\s/g, '')].length,
    paragraphs: paragraphList.length,
    sentences: sentencesCount,
    syllables: syllableCount,
    averages: {
      sentencesPerParagraph: round(paragraphList.length ? sentencesCount / paragraphList.length : 0),
      wordsPerSentence: round(wordsPerSentence),
      charactersPerWord: round(wordList.length ? letters / wordList.length : 0),
    },
    readability: wordList.length ? {
      fleschReadingEase: round(Math.min(121.22, 206.835 - 1.015 * wordsPerSentence - 84.6 * syllablesPerWord)),
      fleschKincaidGrade: round(Math.max(0, 0.39 * wordsPerSentence + 11.8 * syllablesPerWord - 15.59)),
      passivePercent: Math.round(sentencesCount ? passive / sentencesCount * 100 : 0),
    } : { fleschReadingEase: 0, fleschKincaidGrade: 0, passivePercent: 0 },
  };
}

/** A plain-language band for a Reading Ease score. */
export function easeLabel(score) {
  return score >= 90 ? 'Very easy' : score >= 80 ? 'Easy' : score >= 70 ? 'Fairly easy' : score >= 60 ? 'Plain English' : score >= 50 ? 'Fairly difficult' : score >= 30 ? 'Difficult' : 'Very difficult';
}
