/**
 * List numbers in the ST_NumberFormat values (ECMA-376 Part 1 §17.18.59) that imported documents use
 * beyond the ones the list dialogs offer: full-width and enclosed digits, English ordinals and words,
 * Chinese and Japanese counting numerals and ideographic digits, the ten heavenly stems and twelve
 * earthly branches, the Japanese aiueo and iroha syllabaries, Korean counting numerals and digits, the ganada and chosung
 * sequences, Hebrew letter numerals and alphabet, the Arabic abjad and alphabet, and dashes. §17.18.59 names each sequence by example only. A value outside
 * the characters a sequence has (a circled number above 50, a stem above 10) is written as a decimal
 * number, which is this editor's approximation, not a documented reference behavior.
 */
export const IMPORTED_NUMBER_FORMATS = Object.freeze([
  'decimalHalfWidth', 'decimalFullWidth', 'decimalFullWidth2', 'decimalEnclosedCircle', 'decimalEnclosedCircleChinese',
  'decimalEnclosedFullstop', 'decimalEnclosedParen', 'ordinal', 'cardinalText', 'ordinalText', 'chicago',
  'chineseCounting', 'japaneseCounting', 'ideographDigital', 'ideographTraditional', 'ideographZodiac', 'aiueo', 'aiueoFullWidth',
  'ganada', 'chosung', 'numberInDash', 'koreanCounting', 'koreanDigital', 'hebrew1', 'hebrew2', 'arabicAbjad', 'arabicAlpha', 'irohaFullWidth',
]);

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
function words(n) {
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : '');
  if (n < 1000) return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` ${words(n % 100)}` : ''}`;
  return `${words(Math.floor(n / 1000))} thousand${n % 1000 ? ` ${words(n % 1000)}` : ''}`;
}
const IRREGULAR_ORDINALS = { one: 'first', two: 'second', three: 'third', five: 'fifth', eight: 'eighth', nine: 'ninth', twelve: 'twelfth' };
const ordinalWords = n => words(n).replace(/[a-z]+$/, w => IRREGULAR_ORDINALS[w] || (w.endsWith('y') ? `${w.slice(0, -1)}ieth` : `${w}th`));
const capitalized = text => text.charAt(0).toUpperCase() + text.slice(1);

const CJK_DIGITS = '〇一二三四五六七八九';
// Counting numerals below one hundred million: 十 百 千 within each group of four, 万 between groups.
// Chinese keeps 一 before 百 and 千 and writes 零 for skipped places; Japanese does neither.
// Counting numerals below one hundred million: thousands, hundreds and tens within each group of four,
// a myriad unit between groups. Chinese keeps 一 before 百 and 千 and writes 零 for skipped places;
// Japanese and Korean drop the one before every unit within a group and write no zero.
const CHINESE = { digits: CJK_DIGITS, units: ['千', '百', '十'], myriad: '万', chinese: true };
const JAPANESE = { digits: CJK_DIGITS, units: ['千', '百', '十'], myriad: '万' };
const KOREAN = { digits: '영일이삼사오육칠팔구', units: ['천', '백', '십'], myriad: '만' };
function countingGroup(value, system, first) {
  let text = '', skipped = false, started = false;
  for (const [unit, mark] of [[1000, system.units[0]], [100, system.units[1]], [10, system.units[2]], [1, '']]) {
    const digit = Math.floor(value / unit) % 10;
    if (!digit) { if (started) skipped = true; continue; }
    if (skipped && system.chinese) text += '零';
    skipped = false;
    // 十 alone stands for 10–19 at the start of a Chinese number; the others drop one before every unit.
    const omitOne = digit === 1 && mark && (!system.chinese || mark === system.units[2] && first && !started);
    text += (omitOne ? '' : system.digits[digit]) + mark;
    started = true;
  }
  return text;
}
function counting(n, system) {
  const high = Math.floor(n / 10000), low = n % 10000;
  if (!high) return countingGroup(low, system, true);
  return `${countingGroup(high, system, true)}${system.myriad}${low ? (system.chinese && low < 1000 ? '零' : '') + countingGroup(low, system, false) : ''}`;
}

// Hebrew letter numerals (gematria) below 1000; 15 and 16 are written טו and טז.
const HEBREW = 'אבגדהוזחטיכלמנסעפצקרשת';
function hebrewNumeral(value) {
  let text = '', rest = value % 100;
  for (let hundreds = Math.floor(value / 100); hundreds > 0; hundreds -= Math.min(hundreds, 4)) text += HEBREW[18 + Math.min(hundreds, 4) - 1];
  if (rest === 15 || rest === 16) return text + (rest === 15 ? 'טו' : 'טז');
  if (rest >= 10) { text += HEBREW[9 + Math.floor(rest / 10) - 1]; rest %= 10; }
  return rest ? text + HEBREW[rest - 1] : text;
}
const ABJAD = 'أبجدهوزحطيكلمنسعفصقرشتثخذضظغ', ARABIC = 'أبتثجحخدذرزسشصضطظعغفقكلمنهوي';
const IROHA = 'イロハニホヘトチリヌルヲワカヨタレソツネナラムウヰノオクヤマケフコエテアサキユメミシヱヒモセス';

const STEMS = '甲乙丙丁戊己庚辛壬癸', BRANCHES = '子丑寅卯辰巳午未申酉戌亥';
const AIUEO = 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン';
const AIUEO_HALF = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜｦﾝ';
const GANADA = '가나다라마바사아자차카타파하', CHOSUNG = 'ㄱㄴㄷㄹㅁㅂㅅㅇㅈㅊㅋㅌㅍㅎ';
const inSequence = (sequence, value) => value >= 1 && value <= sequence.length ? sequence[value - 1] : String(value);
const enclosed = (base, value) => value >= 1 && value <= 20 ? String.fromCodePoint(base + value - 1) : String(value);
// Unicode encloses 1–20, 21–35 and 36–50 in circles in three separate blocks.
const circled = value => value >= 21 && value <= 35 ? String.fromCodePoint(0x3251 + value - 21) : value >= 36 && value <= 50 ? String.fromCodePoint(0x32b1 + value - 36) : enclosed(0x2460, value);

/** The label for `value` in one of IMPORTED_NUMBER_FORMATS. */
export function importedNumeral(value, format) {
  switch (format) {
    case 'decimalHalfWidth': return String(value);
    case 'decimalFullWidth': case 'decimalFullWidth2': return String(value).replace(/[0-9-]/g, c => c === '-' ? '－' : String.fromCodePoint(0xff10 + Number(c)));
    case 'decimalEnclosedCircle': case 'decimalEnclosedCircleChinese': return circled(value);
    case 'decimalEnclosedParen': return enclosed(0x2474, value);
    case 'decimalEnclosedFullstop': return enclosed(0x2488, value);
    case 'ordinal': { const s = Math.abs(value) % 100; return `${value}${s >= 11 && s <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][Math.abs(value) % 10] || 'th'}`; }
    case 'cardinalText': return value >= 0 && value <= 999999 ? capitalized(words(value)) : String(value);
    case 'ordinalText': return value >= 1 && value <= 999999 ? capitalized(ordinalWords(value)) : String(value);
    case 'chicago': {
      // Note symbols: *, †, ‡, § and then doubled, tripled…
      if (value < 1) return String(value);
      const count = Math.floor((value - 1) / 4) + 1;
      if (count > 128) throw new Error('This symbol list number is too long for the preview.');
      return ['*', '†', '‡', '§'][(value - 1) % 4].repeat(count);
    }
    case 'chineseCounting': case 'japaneseCounting': case 'koreanCounting': return value >= 1 && value < 100000000 ? counting(value, { chineseCounting: CHINESE, japaneseCounting: JAPANESE, koreanCounting: KOREAN }[format]) : value === 0 && format !== 'koreanCounting' ? '〇' : String(value);
    case 'koreanDigital': return value >= 0 ? String(value).replace(/[0-9]/g, c => KOREAN.digits[c]) : String(value);
    case 'hebrew1': return value >= 1 && value < 1000 ? hebrewNumeral(value) : String(value);
    case 'hebrew2': return inSequence(HEBREW, value);
    case 'arabicAbjad': return inSequence(ABJAD, value);
    case 'arabicAlpha': return inSequence(ARABIC, value);
    case 'irohaFullWidth': return inSequence(IROHA, value);
    case 'ideographDigital': return value >= 0 ? String(value).replace(/[0-9]/g, c => CJK_DIGITS[c]) : String(value);
    case 'aiueo': return inSequence(AIUEO_HALF, value);
    case 'aiueoFullWidth': return inSequence(AIUEO, value);
    case 'numberInDash': return `- ${value} -`;
    case 'ideographTraditional': return inSequence(STEMS, value);
    case 'ideographZodiac': return inSequence(BRANCHES, value);
    case 'ganada': return inSequence(GANADA, value);
    case 'chosung': return inSequence(CHOSUNG, value);
    default: return String(value);
  }
}
