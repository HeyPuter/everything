// Country identity for the atlas. Everything is keyed by ISO 3166-1 alpha-2; names come from Intl.DisplayNames.

// world-atlas countries-50m feature ids (ISO 3166-1 numeric) → alpha-2.
const NUMERIC = `004AF 008AL 010AQ 012DZ 016AS 020AD 024AO 028AG 031AZ 032AR 036AU 040AT 044BS 048BH 050BD 051AM 052BB
056BE 060BM 064BT 068BO 070BA 072BW 076BR 084BZ 086IO 090SB 092VG 096BN 100BG 104MM 108BI 112BY 116KH 120CM 124CA 132CV
136KY 140CF 144LK 148TD 152CL 156CN 158TW 170CO 174KM 178CG 180CD 184CK 188CR 191HR 192CU 196CY 203CZ 204BJ 208DK 212DM
214DO 218EC 222SV 226GQ 231ET 232ER 233EE 234FO 238FK 239GS 242FJ 246FI 248AX 250FR 258PF 260TF 262DJ 266GA 268GE 270GM
275PS 276DE 288GH 296KI 300GR 304GL 308GD 316GU 320GT 324GN 328GY 332HT 334HM 336VA 340HN 344HK 348HU 352IS 356IN 360ID
364IR 368IQ 372IE 376IL 380IT 384CI 388JM 392JP 398KZ 400JO 404KE 408KP 410KR 414KW 417KG 418LA 422LB 426LS 428LV 430LR
434LY 438LI 440LT 442LU 446MO 450MG 454MW 458MY 462MV 466ML 470MT 478MR 480MU 484MX 492MC 496MN 498MD 499ME 500MS 504MA
508MZ 512OM 516NA 520NR 524NP 528NL 531CW 533AW 534SX 540NC 548VU 554NZ 558NI 562NE 566NG 570NU 574NF 578NO 580MP 583FM
584MH 585PW 586PK 591PA 598PG 600PY 604PE 608PH 612PN 616PL 620PT 624GW 626TL 630PR 634QA 642RO 643RU 646RW 652BL 654SH
659KN 660AI 662LC 663MF 666PM 670VC 674SM 678ST 682SA 686SN 688RS 690SC 694SL 702SG 703SK 704VN 705SI 706SO 710ZA 716ZW
724ES 728SS 729SD 732EH 740SR 748SZ 752SE 756CH 760SY 762TJ 764TH 768TG 776TO 780TT 784AE 788TN 792TR 795TM 796TC 800UG
804UA 807MK 818EG 826GB 831GG 832JE 833IM 834TZ 840US 850VI 854BF 858UY 860UZ 862VE 876WF 882WS 887YE 894ZM`;
const NUMERIC_CODES = new Map(NUMERIC.split(/\s+/).map((entry) => [entry.slice(0, 3), entry.slice(3)]));

/** ISO 3166-1 numeric (`'250'`, `250`, `'076'`) → alpha-2, for the codes the bundled countries file uses; else null. */
export function alpha2FromNumeric(id) {
  if (typeof id === 'number' && !(Number.isInteger(id) && id >= 0 && id < 1000)) return null;
  if (typeof id !== 'number' && (typeof id !== 'string' || !/^\d{1,3}$/.test(id))) return null;
  return NUMERIC_CODES.get(String(id).padStart(3, '0')) ?? null;
}
/** Every `[numeric, alpha2]` pair of the table. */
export const numericTable = () => [...NUMERIC_CODES];
// The dataset leaves Kosovo without a numeric id; XK is the code geocoders return for it.
const UNNUMBERED = new Map([['Kosovo', 'XK']]);

// Territories the dataset draws inside another country's geometry count as that country.
export const FOLDED = Object.freeze({ GF: 'FR', GP: 'FR', MQ: 'FR', RE: 'FR', YT: 'FR', SJ: 'NO', BQ: 'NL' });

// UN M49 regions, with the Americas split into North (including Central America and the Caribbean) and South.
const REGIONS = {
  AF: 'AO BF BI BJ BW CD CF CG CI CM CV DJ DZ EG EH ER ET GA GH GM GN GQ GW IO KE KM LR LS LY MA MG ML MR MU MW MZ NA NE NG RE RW SC SD SH SL SN SO SS ST SZ TD TF TG TN TZ UG YT ZA ZM ZW',
  AN: 'AQ',
  AS: 'AE AF AM AZ BD BH BN BT CN CY GE HK ID IL IN IQ IR JO JP KG KH KP KR KW KZ LA LB LK MM MN MO MV MY NP OM PH PK PS QA SA SG SY TH TJ TL TM TR TW UZ VN YE',
  EU: 'AD AL AT AX BA BE BG BY CH CZ DE DK EE ES FI FO FR GB GG GI GR HR HU IE IM IS IT JE LI LT LU LV MC MD ME MK MT NL NO PL PT RO RS RU SE SI SJ SK SM UA VA XK',
  NA: 'AG AI AW BB BL BM BQ BS BZ CA CR CU CW DM DO GD GL GP GT HN HT JM KN KY LC MF MQ MS MX NI PA PM PR SV SX TC TT US VC VG VI',
  SA: 'AR BO BR BV CL CO EC FK GF GS GY PE PY SR UY VE',
  OC: 'AS AU CC CK CX FJ FM GU HM KI MH MP NC NF NR NU NZ PF PG PN PW SB TK TO TV UM VU WF WS',
};
export const CONTINENTS = Object.freeze(Object.keys(REGIONS));
const CONTINENT_OF = new Map(Object.entries(REGIONS).flatMap(([continent, codes]) => codes.split(' ').map((code) => [code, continent])));

/** Every country code the atlas can show or mark, folded territories excluded. */
export const COUNTRY_CODES = Object.freeze([...CONTINENT_OF.keys()].filter((code) => !Object.hasOwn(FOLDED, code)).sort());
const KNOWN = new Set(COUNTRY_CODES);

/** The atlas code for an ISO alpha-2 value (case-insensitive), or null when it is not a known country. */
export function countryCode(value) {
  if (typeof value !== 'string' || !/^[A-Za-z]{2}$/.test(value)) return null;
  const upper = value.toUpperCase();
  const code = FOLDED[upper] ?? upper;
  return KNOWN.has(code) ? code : null;
}

/** The alpha-2 code of a countries-50m feature, or null for the few areas without one. */
export function featureCode(feature) {
  const id = feature?.id;
  if (typeof id === 'string' || typeof id === 'number') return alpha2FromNumeric(id);
  return UNNUMBERED.get(feature?.properties?.name) ?? null;
}

export const continentOf = (code) => CONTINENT_OF.get(code) ?? null;

const displayNames = new Map();
/** Localized country name; falls back to the code where the runtime has no name. */
export function countryName(code, locale = 'en') {
  let names = displayNames.get(locale);
  if (names === undefined) {
    try { names = new Intl.DisplayNames([locale, 'en'], { type: 'region', fallback: 'code' }); } catch { names = null; }
    displayNames.set(locale, names);
  }
  try { return names?.of(code) ?? code; } catch { return code; }
}

/** Accent- and case-insensitive text for search. */
export function searchText(value, locale = 'en') {
  return String(value ?? '').normalize('NFD').replace(/\p{Mn}/gu, '').toLocaleLowerCase(locale);
}
