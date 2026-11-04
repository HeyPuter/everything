/**
 * Context for formula autocomplete: what is under the caret while a formula
 * is being typed. Pure so it can be tested without a DOM.
 *
 * completionContext(text, caret) →
 *   { kind: 'name', prefix, start }         a function name being typed
 *   { kind: 'call', name, argIndex, start } the caret sits inside NAME( ... )
 *   { kind: 'column', table, prefix, ... }  a table column inside Table[ ... ]
 *   null                                    nothing to suggest
 */

import { FUNCTION_NAMES } from './functions.js';
import { t, tSource } from '../../i18n/index.js';

/**
 * Each function's argument list and the catalog key of its description. Function and argument
 * names are the formula language and stay English in every interface language, as Excel's do;
 * the description is read through signatureFor, in the interface language.
 */
export const SIGNATURES = {
  ADDRESS: ['row_num, column_num, [abs_num], [a1], [sheet_text]', 'formulaHints.fn.ADDRESS'],
  SUM: ['number1, [number2], ...', 'formulaHints.fn.SUM'],
  SORTBY: ['array, by_array1, [order1], [by_array2], [order2], ...', 'formulaHints.fn.SORTBY'],
  AGGREGATE: ['function_num, options, ref1, [ref2 | k]', 'formulaHints.fn.AGGREGATE'],
  'MODE.MULT': ['number1, [number2], ...', 'formulaHints.fn.MODE_MULT'],
  STDEVA: ['value1, [value2], ...', 'formulaHints.fn.STDEVA'],
  VARA: ['value1, [value2], ...', 'formulaHints.fn.VARA'],
  GAUSS: ['z', 'formulaHints.fn.GAUSS'],
  PHI: ['x', 'formulaHints.fn.PHI'],
  'F.INV': ['probability, deg_freedom1, deg_freedom2', 'formulaHints.fn.F_INV'],
  'F.TEST': ['array1, array2', 'formulaHints.fn.F_TEST'],
  'BINOM.INV': ['trials, probability_s, alpha', 'formulaHints.fn.BINOM_INV'],
  'GAMMA.INV': ['probability, alpha, beta', 'formulaHints.fn.GAMMA_INV'],
  'BETA.DIST': ['x, alpha, beta, cumulative, [A], [B]', 'formulaHints.fn.BETA_DIST'],
  'BETA.INV': ['probability, alpha, beta, [A], [B]', 'formulaHints.fn.BETA_INV'],
  'HYPGEOM.DIST': ['sample_s, number_sample, population_s, number_pop, cumulative', 'formulaHints.fn.HYPGEOM_DIST'],
  'NEGBINOM.DIST': ['number_f, number_s, probability_s, cumulative', 'formulaHints.fn.NEGBINOM_DIST'],
  ERF: ['lower_limit, [upper_limit]', 'formulaHints.fn.ERF'],
  ERFC: ['x', 'formulaHints.fn.ERFC'],
  COMPLEX: ['real_num, i_num, [suffix]', 'formulaHints.fn.COMPLEX'],
  IMSUM: ['inumber1, [inumber2], ...', 'formulaHints.fn.IMSUM'],
  IMPRODUCT: ['inumber1, [inumber2], ...', 'formulaHints.fn.IMPRODUCT'],
  IMDIV: ['inumber1, inumber2', 'formulaHints.fn.IMDIV'],
  IMPOWER: ['inumber, number', 'formulaHints.fn.IMPOWER'],
  IMABS: ['inumber', 'formulaHints.fn.IMABS'],
  IMARGUMENT: ['inumber', 'formulaHints.fn.IMARGUMENT'],
  PROB: ['x_range, prob_range, lower_limit, [upper_limit]', 'formulaHints.fn.PROB'],
  'PERCENTRANK.EXC': ['array, x, [significance]', 'formulaHints.fn.PERCENTRANK_EXC'],
  MARGINOFERROR: ['range, confidence', 'formulaHints.fn.MARGINOFERROR'],
  COUNTUNIQUEIFS: ['range, criteria_range1, criterion1, ...', 'formulaHints.fn.COUNTUNIQUEIFS'],
  DISC: ['settlement, maturity, pr, redemption, [basis]', 'formulaHints.fn.DISC'],
  INTRATE: ['settlement, maturity, investment, redemption, [basis]', 'formulaHints.fn.INTRATE'],
  RECEIVED: ['settlement, maturity, investment, discount, [basis]', 'formulaHints.fn.RECEIVED'],
  PRICEDISC: ['settlement, maturity, discount, redemption, [basis]', 'formulaHints.fn.PRICEDISC'],
  YIELDDISC: ['settlement, maturity, pr, redemption, [basis]', 'formulaHints.fn.YIELDDISC'],
  TBILLEQ: ['settlement, maturity, discount', 'formulaHints.fn.TBILLEQ'],
  TBILLPRICE: ['settlement, maturity, discount', 'formulaHints.fn.TBILLPRICE'],
  TBILLYIELD: ['settlement, maturity, pr', 'formulaHints.fn.TBILLYIELD'],
  PRICE: ['settlement, maturity, rate, yld, redemption, frequency, [basis]', 'formulaHints.fn.PRICE'],
  YIELD: ['settlement, maturity, rate, pr, redemption, frequency, [basis]', 'formulaHints.fn.YIELD'],
  DURATION: ['settlement, maturity, coupon, yld, frequency, [basis]', 'formulaHints.fn.DURATION'],
  MDURATION: ['settlement, maturity, coupon, yld, frequency, [basis]', 'formulaHints.fn.MDURATION'],
  ACCRINT: ['issue, first_interest, settlement, rate, par, frequency, [basis]', 'formulaHints.fn.ACCRINT'],
  ACCRINTM: ['issue, settlement, rate, par, [basis]', 'formulaHints.fn.ACCRINTM'],
  PRICEMAT: ['settlement, maturity, issue, rate, yld, [basis]', 'formulaHints.fn.PRICEMAT'],
  YIELDMAT: ['settlement, maturity, issue, rate, pr, [basis]', 'formulaHints.fn.YIELDMAT'],
  AMORLINC: ['cost, date_purchased, first_period, salvage, period, rate, [basis]', 'formulaHints.fn.AMORLINC'],
  AMORDEGRC: ['cost, date_purchased, first_period, salvage, period, rate, [basis]', 'formulaHints.fn.AMORDEGRC'],
  ODDFPRICE: ['settlement, maturity, issue, first_coupon, rate, yld, redemption, frequency, [basis]', 'formulaHints.fn.ODDFPRICE'],
  ODDFYIELD: ['settlement, maturity, issue, first_coupon, rate, pr, redemption, frequency, [basis]', 'formulaHints.fn.ODDFYIELD'],
  ODDLPRICE: ['settlement, maturity, last_interest, rate, yld, redemption, frequency, [basis]', 'formulaHints.fn.ODDLPRICE'],
  ODDLYIELD: ['settlement, maturity, last_interest, rate, pr, redemption, frequency, [basis]', 'formulaHints.fn.ODDLYIELD'],
  BAHTTEXT: ['number', 'formulaHints.fn.BAHTTEXT'],
  ASC: ['text', 'formulaHints.fn.ASC'],
  DBCS: ['text', 'formulaHints.fn.DBCS'],
  JIS: ['text', 'formulaHints.fn.JIS'],
  PHONETIC: ['reference', 'formulaHints.fn.PHONETIC'],
  GETPIVOTDATA: ['data_field, pivot_table, [field1, item1], ...', 'formulaHints.fn.GETPIVOTDATA'],
  WEBSERVICE: ['url', 'formulaHints.fn.WEBSERVICE'],
  STOCKHISTORY: ['stock, start_date, [end_date], [interval], [headers], [property0], ...', 'formulaHints.fn.STOCKHISTORY'],
  RTD: ['progID, server, topic1, [topic2], ...', 'formulaHints.fn.RTD'],
  CUBEVALUE: ['connection, [member_expression1], ...', 'formulaHints.fn.CUBEVALUE'],
  CUBEMEMBER: ['connection, member_expression, [caption]', 'formulaHints.fn.CUBEMEMBER'],
  CUBEMEMBERPROPERTY: ['connection, member_expression, property', 'formulaHints.fn.CUBEMEMBERPROPERTY'],
  CUBERANKEDMEMBER: ['connection, set_expression, rank, [caption]', 'formulaHints.fn.CUBERANKEDMEMBER'],
  CUBESET: ['connection, set_expression, [caption], [sort_order], [sort_by]', 'formulaHints.fn.CUBESET'],
  CUBESETCOUNT: ['set', 'formulaHints.fn.CUBESETCOUNT'],
  CUBEKPIMEMBER: ['connection, kpi_name, kpi_property, [caption]', 'formulaHints.fn.CUBEKPIMEMBER'],
  COUPPCD: ['settlement, maturity, frequency, [basis]', 'formulaHints.fn.COUPPCD'],
  COUPNCD: ['settlement, maturity, frequency, [basis]', 'formulaHints.fn.COUPNCD'],
  COUPNUM: ['settlement, maturity, frequency, [basis]', 'formulaHints.fn.COUPNUM'],
  COUPDAYBS: ['settlement, maturity, frequency, [basis]', 'formulaHints.fn.COUPDAYBS'],
  COUPDAYS: ['settlement, maturity, frequency, [basis]', 'formulaHints.fn.COUPDAYS'],
  COUPDAYSNC: ['settlement, maturity, frequency, [basis]', 'formulaHints.fn.COUPDAYSNC'],
  QUERY: ['data, query, [headers]', 'formulaHints.fn.QUERY'],
  ISOMITTED: ['argument', 'formulaHints.fn.ISOMITTED'],
  IMPORTXML: ['url, xpath_query', 'formulaHints.fn.IMPORTXML'],
  IMPORTHTML: ['url, "table" | "list", [index]', 'formulaHints.fn.IMPORTHTML'],
  IMPORTDATA: ['url, [delimiter]', 'formulaHints.fn.IMPORTDATA'],
  IMPORTRANGE: ['spreadsheet, range', 'formulaHints.fn.IMPORTRANGE'],
  AI: ['prompt, [data]', 'formulaHints.fn.AI'],
  TRANSLATE: ['text, [source_language], [target_language]', 'formulaHints.fn.TRANSLATE'],
  GOOGLETRANSLATE: ['text, [source_language], [target_language]', 'formulaHints.fn.GOOGLETRANSLATE'],
  DETECTLANGUAGE: ['text', 'formulaHints.fn.DETECTLANGUAGE'],
  AVERAGE: ['number1, [number2], ...', 'formulaHints.fn.AVERAGE'],
  MIN: ['number1, [number2], ...', 'formulaHints.fn.MIN'],
  MAX: ['number1, [number2], ...', 'formulaHints.fn.MAX'],
  COUNT: ['value1, [value2], ...', 'formulaHints.fn.COUNT'],
  COUNTA: ['value1, [value2], ...', 'formulaHints.fn.COUNTA'],
  COUNTBLANK: ['range', 'formulaHints.fn.COUNTBLANK'],
  MEDIAN: ['number1, [number2], ...', 'formulaHints.fn.MEDIAN'],
  PRODUCT: ['number1, [number2], ...', 'formulaHints.fn.PRODUCT'],
  STDEV: ['number1, [number2], ...', 'formulaHints.fn.STDEV'],
  ROUND: ['number, digits', 'formulaHints.fn.ROUND'],
  ROUNDUP: ['number, digits', 'formulaHints.fn.ROUNDUP'],
  ROUNDDOWN: ['number, digits', 'formulaHints.fn.ROUNDDOWN'],
  ABS: ['number', 'formulaHints.fn.ABS'],
  INT: ['number', 'formulaHints.fn.INT'],
  MOD: ['number, divisor', 'formulaHints.fn.MOD'],
  POWER: ['number, power', 'formulaHints.fn.POWER'],
  SQRT: ['number', 'formulaHints.fn.SQRT'],
  SUMIF: ['range, criteria, [sum_range]', 'formulaHints.fn.SUMIF'],
  SUMIFS: ['sum_range, criteria_range1, criteria1, ...', 'formulaHints.fn.SUMIFS'],
  COUNTIF: ['range, criteria', 'formulaHints.fn.COUNTIF'],
  COUNTIFS: ['criteria_range1, criteria1, ...', 'formulaHints.fn.COUNTIFS'],
  AVERAGEIF: ['range, criteria, [average_range]', 'formulaHints.fn.AVERAGEIF'],
  SUMPRODUCT: ['array1, [array2], ...', 'formulaHints.fn.SUMPRODUCT'],
  IF: ['condition, value_if_true, [value_if_false]', 'formulaHints.fn.IF'],
  IFS: ['condition1, value1, [condition2, value2], ...', 'formulaHints.fn.IFS'],
  IFERROR: ['value, value_if_error', 'formulaHints.fn.IFERROR'],
  IFNA: ['value, value_if_na', 'formulaHints.fn.IFNA'],
  AND: ['logical1, [logical2], ...', 'formulaHints.fn.AND'],
  OR: ['logical1, [logical2], ...', 'formulaHints.fn.OR'],
  NOT: ['logical', 'formulaHints.fn.NOT'],
  SWITCH: ['expression, value1, result1, ..., [default]', 'formulaHints.fn.SWITCH'],
  CHOOSE: ['index, value1, [value2], ...', 'formulaHints.fn.CHOOSE'],
  VLOOKUP: ['search_key, range, index, [is_sorted]', 'formulaHints.fn.VLOOKUP'],
  HLOOKUP: ['search_key, range, index, [is_sorted]', 'formulaHints.fn.HLOOKUP'],
  XLOOKUP: ['search_key, lookup_range, return_range, [if_not_found], [match_mode], [search_mode]', 'formulaHints.fn.XLOOKUP'],
  INDEX: ['range, row, [column]', 'formulaHints.fn.INDEX'],
  MATCH: ['search_key, range, [type]', 'formulaHints.fn.MATCH'],
  CONCAT: ['text1, [text2], ...', 'formulaHints.fn.CONCAT'],
  TEXTJOIN: ['delimiter, ignore_empty, text1, ...', 'formulaHints.fn.TEXTJOIN'],
  LEN: ['text', 'formulaHints.fn.LEN'],
  LEFT: ['text, [count]', 'formulaHints.fn.LEFT'],
  RIGHT: ['text, [count]', 'formulaHints.fn.RIGHT'],
  MID: ['text, start, count', 'formulaHints.fn.MID'],
  UPPER: ['text', 'formulaHints.fn.UPPER'],
  LOWER: ['text', 'formulaHints.fn.LOWER'],
  PROPER: ['text', 'formulaHints.fn.PROPER'],
  TRIM: ['text', 'formulaHints.fn.TRIM'],
  SUBSTITUTE: ['text, old_text, new_text, [instance]', 'formulaHints.fn.SUBSTITUTE'],
  FIND: ['search_text, text, [start]', 'formulaHints.fn.FIND'],
  SEARCH: ['search_text, text, [start]', 'formulaHints.fn.SEARCH'],
  TEXT: ['value, format', 'formulaHints.fn.TEXT'],
  VALUE: ['text', 'formulaHints.fn.VALUE'],
  TODAY: ['', 'formulaHints.fn.TODAY'],
  NOW: ['', 'formulaHints.fn.NOW'],
  DATE: ['year, month, day', 'formulaHints.fn.DATE'],
  YEAR: ['date', 'formulaHints.fn.YEAR'],
  MONTH: ['date', 'formulaHints.fn.MONTH'],
  DAY: ['date', 'formulaHints.fn.DAY'],
  WEEKDAY: ['date, [type]', 'formulaHints.fn.WEEKDAY'],
  DAYS: ['end_date, start_date', 'formulaHints.fn.DAYS'],
  EDATE: ['date, months', 'formulaHints.fn.EDATE'],
  EOMONTH: ['date, months', 'formulaHints.fn.EOMONTH'],
  ISBLANK: ['value', 'formulaHints.fn.ISBLANK'],
  ISNUMBER: ['value', 'formulaHints.fn.ISNUMBER'],
  ISTEXT: ['value', 'formulaHints.fn.ISTEXT'],
  ISERROR: ['value', 'formulaHints.fn.ISERROR'],
  ROW: ['[reference]', 'formulaHints.fn.ROW'],
  COLUMN: ['[reference]', 'formulaHints.fn.COLUMN'],
  AVERAGEIFS: ['average_range, criteria_range1, criteria1, ...', 'formulaHints.fn.AVERAGEIFS'],
  LARGE: ['range, n', 'formulaHints.fn.LARGE'],
  SMALL: ['range, n', 'formulaHints.fn.SMALL'],
  RANK: ['value, range, [is_ascending]', 'formulaHints.fn.RANK'],
  PERCENTILE: ['range, percentile', 'formulaHints.fn.PERCENTILE'],
  QUARTILE: ['range, quartile', 'formulaHints.fn.QUARTILE'],
  PERCENTRANK: ['range, value, [digits]', 'formulaHints.fn.PERCENTRANK'],
  MODE: ['number1, [number2], ...', 'formulaHints.fn.MODE'],
  SUMSQ: ['number1, [number2], ...', 'formulaHints.fn.SUMSQ'],
  COUNTUNIQUE: ['value1, [value2], ...', 'formulaHints.fn.COUNTUNIQUE'],
  GEOMEAN: ['number1, [number2], ...', 'formulaHints.fn.GEOMEAN'],
  AVEDEV: ['number1, [number2], ...', 'formulaHints.fn.AVEDEV'],
  'VAR.P': ['number1, [number2], ...', 'formulaHints.fn.VAR_P'],
  'STDEV.P': ['number1, [number2], ...', 'formulaHints.fn.STDEV_P'],
  CORREL: ['range1, range2', 'formulaHints.fn.CORREL'],
  SLOPE: ['known_ys, known_xs', 'formulaHints.fn.SLOPE'],
  INTERCEPT: ['known_ys, known_xs', 'formulaHints.fn.INTERCEPT'],
  FORECAST: ['x, known_ys, known_xs', 'formulaHints.fn.FORECAST'],
  'FORECAST.ETS': ['target_date, values, timeline, [seasonality], [data_completion], [aggregation]', 'formulaHints.fn.FORECAST_ETS'],
  'FORECAST.ETS.CONFINT': ['target_date, values, timeline, [confidence_level], [seasonality], [data_completion], [aggregation]', 'formulaHints.fn.FORECAST_ETS_CONFINT'],
  'FORECAST.ETS.SEASONALITY': ['values, timeline, [data_completion], [aggregation]', 'formulaHints.fn.FORECAST_ETS_SEASONALITY'],
  'FORECAST.ETS.STAT': ['values, timeline, statistic_type, [seasonality], [data_completion], [aggregation]', 'formulaHints.fn.FORECAST_ETS_STAT'],
  RSQ: ['known_ys, known_xs', 'formulaHints.fn.RSQ'],
  MROUND: ['number, multiple', 'formulaHints.fn.MROUND'],
  QUOTIENT: ['dividend, divisor', 'formulaHints.fn.QUOTIENT'],
  GCD: ['number1, [number2], ...', 'formulaHints.fn.GCD'],
  LCM: ['number1, [number2], ...', 'formulaHints.fn.LCM'],
  FACT: ['number', 'formulaHints.fn.FACT'],
  COMBIN: ['n, k', 'formulaHints.fn.COMBIN'],
  PERMUT: ['n, k', 'formulaHints.fn.PERMUT'],
  EVEN: ['number', 'formulaHints.fn.EVEN'],
  ODD: ['number', 'formulaHints.fn.ODD'],
  SIN: ['angle', 'formulaHints.fn.SIN'],
  COS: ['angle', 'formulaHints.fn.COS'],
  TAN: ['angle', 'formulaHints.fn.TAN'],
  ATAN2: ['x, y', 'formulaHints.fn.ATAN2'],
  DEGREES: ['angle', 'formulaHints.fn.DEGREES'],
  RADIANS: ['angle', 'formulaHints.fn.RADIANS'],
  SPARKLINE: ['data, [type], [color]', 'formulaHints.fn.SPARKLINE'],
  UNIQUE: ['range, [by_column], [exactly_once]', 'formulaHints.fn.UNIQUE'],
  FILTER: ['range, condition1, [condition2], ...', 'formulaHints.fn.FILTER'],
  SORT: ['range, [sort_column], [is_ascending], [by_col | sort_column2, is_ascending2, ...]', 'formulaHints.fn.SORT'],
  SEQUENCE: ['rows, [columns], [start], [step]', 'formulaHints.fn.SEQUENCE'],
  TRANSPOSE: ['range', 'formulaHints.fn.TRANSPOSE'],
  FLATTEN: ['range1, [range2], ...', 'formulaHints.fn.FLATTEN'],
  SPLIT: ['text, delimiter, [split_by_each], [remove_empty]', 'formulaHints.fn.SPLIT'],
  TEXTSPLIT: ['text, col_delimiter, [row_delimiter], [ignore_empty], [match_mode], [pad_with]', 'formulaHints.fn.TEXTSPLIT'],
  CHOOSECOLS: ['range, column1, [column2], ...', 'formulaHints.fn.CHOOSECOLS'],
  CHOOSEROWS: ['range, row1, [row2], ...', 'formulaHints.fn.CHOOSEROWS'],
  ARRAYFORMULA: ['array_formula', 'formulaHints.fn.ARRAYFORMULA'],
  LOOKUP: ['search_key, search_range, [result_range]', 'formulaHints.fn.LOOKUP'],
  INDIRECT: ['reference_text, [a1]', 'formulaHints.fn.INDIRECT'],
  OFFSET: ['reference, rows, columns, [height], [width]', 'formulaHints.fn.OFFSET'],
  HYPERLINK: ['url, [label]', 'formulaHints.fn.HYPERLINK'],
  SHEET: ['[sheet_name]', 'formulaHints.fn.SHEET'],
  SHEETS: ['', 'formulaHints.fn.SHEETS'],
  ISFORMULA: ['reference', 'formulaHints.fn.ISFORMULA'],
  FORMULATEXT: ['reference', 'formulaHints.fn.FORMULATEXT'],
  'ERROR.TYPE': ['value', 'formulaHints.fn.ERROR_TYPE'],
  REGEXMATCH: ['text, regular_expression', 'formulaHints.fn.REGEXMATCH'],
  INFO: ['type_text', 'formulaHints.fn.INFO'],
  FILTERXML: ['xml, xpath', 'formulaHints.fn.FILTERXML'],
  'BINOM.DIST.RANGE': ['trials, probability_s, number_s, [number_s2]', 'formulaHints.fn.BINOM_DIST_RANGE'],
  BESSELJ: ['x, n', 'formulaHints.fn.BESSELJ'],
  BESSELY: ['x, n', 'formulaHints.fn.BESSELY'],
  BESSELI: ['x, n', 'formulaHints.fn.BESSELI'],
  BESSELK: ['x, n', 'formulaHints.fn.BESSELK'],
  IMCOSH: ['inumber', 'formulaHints.fn.IMCOSH'],
  IMSINH: ['inumber', 'formulaHints.fn.IMSINH'],
  IMSEC: ['inumber', 'formulaHints.fn.IMSEC'],
  IMCSC: ['inumber', 'formulaHints.fn.IMCSC'],
  IMCOT: ['inumber', 'formulaHints.fn.IMCOT'],
  IMSECH: ['inumber', 'formulaHints.fn.IMSECH'],
  IMCSCH: ['inumber', 'formulaHints.fn.IMCSCH'],
  REGEXTEST: ['text, pattern, [case_sensitivity]', 'formulaHints.fn.REGEXTEST'],
  GROUPBY: ['row_fields, values, function, [field_headers], [total_depth], [sort_order], [filter_array]', 'formulaHints.fn.GROUPBY'],
  PIVOTBY: ['row_fields, col_fields, values, function, [field_headers], [row_total_depth], [row_sort_order], [col_total_depth], [col_sort_order], [filter_array]', 'formulaHints.fn.PIVOTBY'],
  PERCENTOF: ['data_subset, data_all', 'formulaHints.fn.PERCENTOF'],
  TRIMRANGE: ['range, [trim_rows], [trim_cols]', 'formulaHints.fn.TRIMRANGE'],
  ADD: ['value1, value2', 'formulaHints.fn.ADD'],
  MINUS: ['value1, value2', 'formulaHints.fn.MINUS'],
  MULTIPLY: ['factor1, factor2', 'formulaHints.fn.MULTIPLY'],
  DIVIDE: ['dividend, divisor', 'formulaHints.fn.DIVIDE'],
  POW: ['base, exponent', 'formulaHints.fn.POW'],
  EQ: ['value1, value2', 'formulaHints.fn.EQ'],
  NE: ['value1, value2', 'formulaHints.fn.NE'],
  GT: ['value1, value2', 'formulaHints.fn.GT'],
  GTE: ['value1, value2', 'formulaHints.fn.GTE'],
  LT: ['value1, value2', 'formulaHints.fn.LT'],
  LTE: ['value1, value2', 'formulaHints.fn.LTE'],
  UMINUS: ['value', 'formulaHints.fn.UMINUS'],
  UPLUS: ['value', 'formulaHints.fn.UPLUS'],
  UNARY_PERCENT: ['value', 'formulaHints.fn.UNARY_PERCENT'],
  REGEXEXTRACT: ['text, regular_expression, [return_mode], [case_sensitivity]', 'formulaHints.fn.REGEXEXTRACT'],
  REGEXREPLACE: ['text, regular_expression, replacement, [occurrence], [case_sensitivity]', 'formulaHints.fn.REGEXREPLACE'],
  JOIN: ['delimiter, value1, [value2], ...', 'formulaHints.fn.JOIN'],
  TEXTBEFORE: ['text, delimiter, [instance_num], [match_mode], [match_end], [if_not_found]', 'formulaHints.fn.TEXTBEFORE'],
  TEXTAFTER: ['text, delimiter, [instance_num], [match_mode], [match_end], [if_not_found]', 'formulaHints.fn.TEXTAFTER'],
  NUMBERVALUE: ['text, [decimal_separator], [group_separator]', 'formulaHints.fn.NUMBERVALUE'],
  DOLLAR: ['number, [decimals]', 'formulaHints.fn.DOLLAR'],
  FIXED: ['number, [decimals], [no_commas]', 'formulaHints.fn.FIXED'],
  UNICHAR: ['number', 'formulaHints.fn.UNICHAR'],
  UNICODE: ['text', 'formulaHints.fn.UNICODE'],
  DATEDIF: ['start_date, end_date, unit', 'formulaHints.fn.DATEDIF'],
  DATEVALUE: ['date_text', 'formulaHints.fn.DATEVALUE'],
  TIMEVALUE: ['time_text', 'formulaHints.fn.TIMEVALUE'],
  WEEKNUM: ['date, [type]', 'formulaHints.fn.WEEKNUM'],
  ISOWEEKNUM: ['date', 'formulaHints.fn.ISOWEEKNUM'],
  NETWORKDAYS: ['start_date, end_date, [holidays]', 'formulaHints.fn.NETWORKDAYS'],
  WORKDAY: ['start_date, days, [holidays]', 'formulaHints.fn.WORKDAY'],
  YEARFRAC: ['start_date, end_date, [basis]', 'formulaHints.fn.YEARFRAC'],
  DAYS360: ['start_date, end_date, [method]', 'formulaHints.fn.DAYS360'],
  PMT: ['rate, periods, present_value, [future_value], [type]', 'formulaHints.fn.PMT'],
  IPMT: ['rate, period, periods, present_value, [future_value], [type]', 'formulaHints.fn.IPMT'],
  PPMT: ['rate, period, periods, present_value, [future_value], [type]', 'formulaHints.fn.PPMT'],
  FV: ['rate, periods, payment, [present_value], [type]', 'formulaHints.fn.FV'],
  PV: ['rate, periods, payment, [future_value], [type]', 'formulaHints.fn.PV'],
  NPER: ['rate, payment, present_value, [future_value], [type]', 'formulaHints.fn.NPER'],
  RATE: ['periods, payment, present_value, [future_value], [type], [guess]', 'formulaHints.fn.RATE'],
  NPV: ['rate, cashflow1, [cashflow2], ...', 'formulaHints.fn.NPV'],
  IRR: ['cashflows, [guess]', 'formulaHints.fn.IRR'],
  XNPV: ['rate, cashflows, dates', 'formulaHints.fn.XNPV'],
  XIRR: ['cashflows, dates, [guess]', 'formulaHints.fn.XIRR'],
  SLN: ['cost, salvage, life', 'formulaHints.fn.SLN'],
  SYD: ['cost, salvage, life, period', 'formulaHints.fn.SYD'],
  DDB: ['cost, salvage, life, period, [factor]', 'formulaHints.fn.DDB'],
  EFFECT: ['nominal_rate, periods_per_year', 'formulaHints.fn.EFFECT'],
  NOMINAL: ['effective_rate, periods_per_year', 'formulaHints.fn.NOMINAL'],
  LET: ['name1, value1, [name2, value2], ..., result', 'formulaHints.fn.LET'],
  LAMBDA: ['[param1, param2], ..., calculation', 'formulaHints.fn.LAMBDA'],
  MAP: ['array1, [array2], ..., lambda', 'formulaHints.fn.MAP'],
  REDUCE: ['initial_value, array, lambda(accumulator, value)', 'formulaHints.fn.REDUCE'],
  SCAN: ['initial_value, array, lambda(accumulator, value)', 'formulaHints.fn.SCAN'],
  BYROW: ['array, lambda(row)', 'formulaHints.fn.BYROW'],
  BYCOL: ['array, lambda(column)', 'formulaHints.fn.BYCOL'],
  MAKEARRAY: ['rows, columns, lambda(row, column)', 'formulaHints.fn.MAKEARRAY'],
  XMATCH: ['search_key, lookup_range, [match_mode], [search_mode]', 'formulaHints.fn.XMATCH'],
  VSTACK: ['array1, [array2], ...', 'formulaHints.fn.VSTACK'],
  HSTACK: ['array1, [array2], ...', 'formulaHints.fn.HSTACK'],
  TAKE: ['array, rows, [columns]', 'formulaHints.fn.TAKE'],
  DROP: ['array, rows, [columns]', 'formulaHints.fn.DROP'],
  EXPAND: ['array, rows, [columns], [pad_with]', 'formulaHints.fn.EXPAND'],
  WRAPROWS: ['vector, wrap_count, [pad_with]', 'formulaHints.fn.WRAPROWS'],
  WRAPCOLS: ['vector, wrap_count, [pad_with]', 'formulaHints.fn.WRAPCOLS'],
  TOCOL: ['array, [ignore], [scan_by_column]', 'formulaHints.fn.TOCOL'],
  TOROW: ['array, [ignore], [scan_by_column]', 'formulaHints.fn.TOROW'],
  RANDARRAY: ['[rows], [columns], [min], [max], [whole_number]', 'formulaHints.fn.RANDARRAY'],
  AVERAGEA: ['value1, [value2], ...', 'formulaHints.fn.AVERAGEA'],
  DEVSQ: ['number1, [number2], ...', 'formulaHints.fn.DEVSQ'],
  SKEW: ['number1, [number2], ...', 'formulaHints.fn.SKEW'],
  KURT: ['number1, [number2], ...', 'formulaHints.fn.KURT'],
  TRIMMEAN: ['range, fraction', 'formulaHints.fn.TRIMMEAN'],
  STANDARDIZE: ['x, mean, standard_deviation', 'formulaHints.fn.STANDARDIZE'],
  FREQUENCY: ['data, bins', 'formulaHints.fn.FREQUENCY'],
  TREND: ['known_y, [known_x], [new_x], [const]', 'formulaHints.fn.TREND'],
  GROWTH: ['known_y, [known_x], [new_x], [const]', 'formulaHints.fn.GROWTH'],
  LINEST: ['known_y, [known_x], [const], [stats]', 'formulaHints.fn.LINEST'],
  LOGEST: ['known_y, [known_x], [const], [stats]', 'formulaHints.fn.LOGEST'],
  STEYX: ['known_y, known_x', 'formulaHints.fn.STEYX'],
  'NORM.DIST': ['x, mean, standard_deviation, cumulative', 'formulaHints.fn.NORM_DIST'],
  'NORM.INV': ['probability, mean, standard_deviation', 'formulaHints.fn.NORM_INV'],
  'NORM.S.DIST': ['z, cumulative', 'formulaHints.fn.NORM_S_DIST'],
  'NORM.S.INV': ['probability', 'formulaHints.fn.NORM_S_INV'],
  'BINOM.DIST': ['successes, trials, probability, cumulative', 'formulaHints.fn.BINOM_DIST'],
  'POISSON.DIST': ['x, mean, cumulative', 'formulaHints.fn.POISSON_DIST'],
  'EXPON.DIST': ['x, lambda, cumulative', 'formulaHints.fn.EXPON_DIST'],
  'T.DIST': ['x, degrees_freedom, cumulative', 'formulaHints.fn.T_DIST'],
  'T.INV': ['probability, degrees_freedom', 'formulaHints.fn.T_INV'],
  'T.TEST': ['range1, range2, tails, type', 'formulaHints.fn.T_TEST'],
  'CHISQ.DIST': ['x, degrees_freedom, cumulative', 'formulaHints.fn.CHISQ_DIST'],
  'CHISQ.TEST': ['actual_range, expected_range', 'formulaHints.fn.CHISQ_TEST'],
  'F.DIST': ['x, degrees_freedom1, degrees_freedom2, cumulative', 'formulaHints.fn.F_DIST'],
  'CONFIDENCE.NORM': ['alpha, standard_deviation, size', 'formulaHints.fn.CONFIDENCE_NORM'],
  'CEILING.MATH': ['number, [significance], [mode]', 'formulaHints.fn.CEILING_MATH'],
  'FLOOR.MATH': ['number, [significance], [mode]', 'formulaHints.fn.FLOOR_MATH'],
  MMULT: ['array1, array2', 'formulaHints.fn.MMULT'],
  MINVERSE: ['array', 'formulaHints.fn.MINVERSE'],
  MDETERM: ['array', 'formulaHints.fn.MDETERM'],
  MUNIT: ['size', 'formulaHints.fn.MUNIT'],
  BASE: ['number, radix, [min_length]', 'formulaHints.fn.BASE'],
  DECIMAL: ['text, radix', 'formulaHints.fn.DECIMAL'],
  DEC2BIN: ['number, [places]', 'formulaHints.fn.DEC2BIN'],
  DEC2HEX: ['number, [places]', 'formulaHints.fn.DEC2HEX'],
  BIN2DEC: ['number', 'formulaHints.fn.BIN2DEC'],
  HEX2DEC: ['number', 'formulaHints.fn.HEX2DEC'],
  ROMAN: ['number, [form]', 'formulaHints.fn.ROMAN'],
  ARABIC: ['text', 'formulaHints.fn.ARABIC'],
  CONVERT: ['number, from_unit, to_unit', 'formulaHints.fn.CONVERT'],
  BITAND: ['number1, number2', 'formulaHints.fn.BITAND'],
  DELTA: ['number1, [number2]', 'formulaHints.fn.DELTA'],
  GESTEP: ['number, [step]', 'formulaHints.fn.GESTEP'],
  SERIESSUM: ['x, n, m, coefficients', 'formulaHints.fn.SERIESSUM'],
  DB: ['cost, salvage, life, period, [month]', 'formulaHints.fn.DB'],
  VDB: ['cost, salvage, life, start_period, end_period, [factor], [no_switch]', 'formulaHints.fn.VDB'],
  CUMIPMT: ['rate, periods, present_value, start_period, end_period, type', 'formulaHints.fn.CUMIPMT'],
  CUMPRINC: ['rate, periods, present_value, start_period, end_period, type', 'formulaHints.fn.CUMPRINC'],
  ISPMT: ['rate, period, periods, present_value', 'formulaHints.fn.ISPMT'],
  MIRR: ['cashflows, finance_rate, reinvest_rate', 'formulaHints.fn.MIRR'],
  PDURATION: ['rate, present_value, future_value', 'formulaHints.fn.PDURATION'],
  RRI: ['periods, present_value, future_value', 'formulaHints.fn.RRI'],
  FVSCHEDULE: ['principal, rates', 'formulaHints.fn.FVSCHEDULE'],
  DOLLARDE: ['fractional_price, fraction', 'formulaHints.fn.DOLLARDE'],
  DOLLARFR: ['decimal_price, fraction', 'formulaHints.fn.DOLLARFR'],
  ISNONTEXT: ['value', 'formulaHints.fn.ISNONTEXT'],
  ISREF: ['value', 'formulaHints.fn.ISREF'],
  ISEMAIL: ['value', 'formulaHints.fn.ISEMAIL'],
  ISURL: ['value', 'formulaHints.fn.ISURL'],
  ISBETWEEN: ['value, lower, upper, [lower_inclusive], [upper_inclusive]', 'formulaHints.fn.ISBETWEEN'],
  ENCODEURL: ['text', 'formulaHints.fn.ENCODEURL'],
  ARRAYTOTEXT: ['array, [format]', 'formulaHints.fn.ARRAYTOTEXT'],
  VALUETOTEXT: ['value, [format]', 'formulaHints.fn.VALUETOTEXT'],
  CELL: ['info_type, [reference]', 'formulaHints.fn.CELL'],
  ARRAY_CONSTRAIN: ['array, rows, columns', 'formulaHints.fn.ARRAY_CONSTRAIN'],
  'NETWORKDAYS.INTL': ['start_date, end_date, [weekend], [holidays]', 'formulaHints.fn.NETWORKDAYS_INTL'],
  'WORKDAY.INTL': ['start_date, days, [weekend], [holidays]', 'formulaHints.fn.WORKDAY_INTL'],
  EPOCHTODATE: ['timestamp, [unit]', 'formulaHints.fn.EPOCHTODATE'],
  DSUM: ['database, field, criteria', 'formulaHints.fn.DSUM'],
  DAVERAGE: ['database, field, criteria', 'formulaHints.fn.DAVERAGE'],
  DCOUNT: ['database, [field], criteria', 'formulaHints.fn.DCOUNT'],
  DCOUNTA: ['database, [field], criteria', 'formulaHints.fn.DCOUNTA'],
  DMAX: ['database, field, criteria', 'formulaHints.fn.DMAX'],
  DMIN: ['database, field, criteria', 'formulaHints.fn.DMIN'],
  DGET: ['database, field, criteria', 'formulaHints.fn.DGET'],
  DPRODUCT: ['database, field, criteria', 'formulaHints.fn.DPRODUCT'],
  DSTDEV: ['database, field, criteria', 'formulaHints.fn.DSTDEV'],
  DVAR: ['database, field, criteria', 'formulaHints.fn.DVAR'],
  IMAGE: ['url, [mode or alt_text], [sizing]', 'formulaHints.fn.IMAGE'],
  SUBTOTAL: ['function_code, range1, ...', 'formulaHints.fn.SUBTOTAL'],
  ROWS: ['range', 'formulaHints.fn.ROWS'],
  COLUMNS: ['range', 'formulaHints.fn.COLUMNS'],
  AREAS: ['reference', 'formulaHints.fn.AREAS'],
  CONCATENATE: ['text1, [text2], ...', 'formulaHints.fn.CONCATENATE'],
  EXACT: ['text1, text2', 'formulaHints.fn.EXACT'],
  REPLACE: ['old_text, start, count, new_text', 'formulaHints.fn.REPLACE'],
  REPT: ['text, number_times', 'formulaHints.fn.REPT'],
  CHAR: ['number', 'formulaHints.fn.CHAR'],
  CODE: ['text', 'formulaHints.fn.CODE'],
  CLEAN: ['text', 'formulaHints.fn.CLEAN'],
  N: ['value', 'formulaHints.fn.N'],
  T: ['value', 'formulaHints.fn.T'],
  TYPE: ['value', 'formulaHints.fn.TYPE'],
  NA: ['', 'formulaHints.fn.NA'],
  TRUE: ['', 'formulaHints.fn.TRUE'],
  FALSE: ['', 'formulaHints.fn.FALSE'],
  PI: ['', 'formulaHints.fn.PI'],
  RAND: ['', 'formulaHints.fn.RAND'],
  RANDBETWEEN: ['bottom, top', 'formulaHints.fn.RANDBETWEEN'],
  ISNA: ['value', 'formulaHints.fn.ISNA'],
  ISERR: ['value', 'formulaHints.fn.ISERR'],
  ISLOGICAL: ['value', 'formulaHints.fn.ISLOGICAL'],
  ISEVEN: ['number', 'formulaHints.fn.ISEVEN'],
  ISODD: ['number', 'formulaHints.fn.ISODD'],
  XOR: ['logical1, [logical2], ...', 'formulaHints.fn.XOR'],
  TIME: ['hour, minute, second', 'formulaHints.fn.TIME'],
  HOUR: ['time', 'formulaHints.fn.HOUR'],
  MINUTE: ['time', 'formulaHints.fn.MINUTE'],
  SECOND: ['time', 'formulaHints.fn.SECOND'],
  TRUNC: ['number, [digits]', 'formulaHints.fn.TRUNC'],
  SIGN: ['number', 'formulaHints.fn.SIGN'],
  EXP: ['number', 'formulaHints.fn.EXP'],
  LN: ['number', 'formulaHints.fn.LN'],
  LOG: ['number, [base]', 'formulaHints.fn.LOG'],
  LOG10: ['number', 'formulaHints.fn.LOG10'],
  CEILING: ['number, significance', 'formulaHints.fn.CEILING'],
  FLOOR: ['number, significance', 'formulaHints.fn.FLOOR'],
  'CEILING.PRECISE': ['number, [significance]', 'formulaHints.fn.CEILING_PRECISE'],
  'FLOOR.PRECISE': ['number, [significance]', 'formulaHints.fn.FLOOR_PRECISE'],
  'ISO.CEILING': ['number, [significance]', 'formulaHints.fn.ISO_CEILING'],
  FACTDOUBLE: ['number', 'formulaHints.fn.FACTDOUBLE'],
  MULTINOMIAL: ['number1, [number2], ...', 'formulaHints.fn.MULTINOMIAL'],
  COMBINA: ['number, number_chosen', 'formulaHints.fn.COMBINA'],
  PERMUTATIONA: ['number, number_chosen', 'formulaHints.fn.PERMUTATIONA'],
  SQRTPI: ['number', 'formulaHints.fn.SQRTPI'],
  ASIN: ['number', 'formulaHints.fn.ASIN'],
  ACOS: ['number', 'formulaHints.fn.ACOS'],
  ATAN: ['number', 'formulaHints.fn.ATAN'],
  ACOT: ['number', 'formulaHints.fn.ACOT'],
  SINH: ['number', 'formulaHints.fn.SINH'],
  COSH: ['number', 'formulaHints.fn.COSH'],
  TANH: ['number', 'formulaHints.fn.TANH'],
  ASINH: ['number', 'formulaHints.fn.ASINH'],
  ACOSH: ['number', 'formulaHints.fn.ACOSH'],
  ATANH: ['number', 'formulaHints.fn.ATANH'],
  ACOTH: ['number', 'formulaHints.fn.ACOTH'],
  COT: ['angle', 'formulaHints.fn.COT'],
  SEC: ['angle', 'formulaHints.fn.SEC'],
  CSC: ['angle', 'formulaHints.fn.CSC'],
  COTH: ['number', 'formulaHints.fn.COTH'],
  SECH: ['number', 'formulaHints.fn.SECH'],
  CSCH: ['number', 'formulaHints.fn.CSCH'],
  MAXIFS: ['max_range, criteria_range1, criteria1, ...', 'formulaHints.fn.MAXIFS'],
  MINIFS: ['min_range, criteria_range1, criteria1, ...', 'formulaHints.fn.MINIFS'],
  MAXA: ['value1, [value2], ...', 'formulaHints.fn.MAXA'],
  MINA: ['value1, [value2], ...', 'formulaHints.fn.MINA'],
  HARMEAN: ['number1, [number2], ...', 'formulaHints.fn.HARMEAN'],
  'MODE.SNGL': ['number1, [number2], ...', 'formulaHints.fn.MODE_SNGL'],
  'RANK.EQ': ['number, ref, [order]', 'formulaHints.fn.RANK_EQ'],
  'RANK.AVG': ['number, ref, [order]', 'formulaHints.fn.RANK_AVG'],
  'PERCENTILE.INC': ['array, k', 'formulaHints.fn.PERCENTILE_INC'],
  'PERCENTILE.EXC': ['array, k', 'formulaHints.fn.PERCENTILE_EXC'],
  'PERCENTRANK.INC': ['array, x, [significance]', 'formulaHints.fn.PERCENTRANK_INC'],
  'QUARTILE.INC': ['array, quart', 'formulaHints.fn.QUARTILE_INC'],
  'QUARTILE.EXC': ['array, quart', 'formulaHints.fn.QUARTILE_EXC'],
  'STDEV.S': ['number1, [number2], ...', 'formulaHints.fn.STDEV_S'],
  STDEVP: ['number1, [number2], ...', 'formulaHints.fn.STDEVP'],
  STDEVPA: ['value1, [value2], ...', 'formulaHints.fn.STDEVPA'],
  VAR: ['number1, [number2], ...', 'formulaHints.fn.VAR'],
  'VAR.S': ['number1, [number2], ...', 'formulaHints.fn.VAR_S'],
  VARP: ['number1, [number2], ...', 'formulaHints.fn.VARP'],
  VARPA: ['value1, [value2], ...', 'formulaHints.fn.VARPA'],
  'SKEW.P': ['number1, [number2], ...', 'formulaHints.fn.SKEW_P'],
  PEARSON: ['array1, array2', 'formulaHints.fn.PEARSON'],
  COVAR: ['array1, array2', 'formulaHints.fn.COVAR'],
  'COVARIANCE.P': ['array1, array2', 'formulaHints.fn.COVARIANCE_P'],
  'COVARIANCE.S': ['array1, array2', 'formulaHints.fn.COVARIANCE_S'],
  'FORECAST.LINEAR': ['x, known_ys, known_xs', 'formulaHints.fn.FORECAST_LINEAR'],
  SUMX2MY2: ['array_x, array_y', 'formulaHints.fn.SUMX2MY2'],
  SUMX2PY2: ['array_x, array_y', 'formulaHints.fn.SUMX2PY2'],
  SUMXMY2: ['array_x, array_y', 'formulaHints.fn.SUMXMY2'],
  FISHER: ['x', 'formulaHints.fn.FISHER'],
  FISHERINV: ['y', 'formulaHints.fn.FISHERINV'],
  GAMMA: ['number', 'formulaHints.fn.GAMMA'],
  GAMMALN: ['x', 'formulaHints.fn.GAMMALN'],
  'GAMMALN.PRECISE': ['x', 'formulaHints.fn.GAMMALN_PRECISE'],
  'GAMMA.DIST': ['x, alpha, beta, cumulative', 'formulaHints.fn.GAMMA_DIST'],
  GAMMADIST: ['x, alpha, beta, cumulative', 'formulaHints.fn.GAMMADIST'],
  GAMMAINV: ['probability, alpha, beta', 'formulaHints.fn.GAMMAINV'],
  'LOGNORM.DIST': ['x, mean, standard_dev, cumulative', 'formulaHints.fn.LOGNORM_DIST'],
  'LOGNORM.INV': ['probability, mean, standard_dev', 'formulaHints.fn.LOGNORM_INV'],
  LOGNORMDIST: ['x, mean, standard_dev', 'formulaHints.fn.LOGNORMDIST'],
  LOGINV: ['probability, mean, standard_dev', 'formulaHints.fn.LOGINV'],
  NORMDIST: ['x, mean, standard_dev, cumulative', 'formulaHints.fn.NORMDIST'],
  NORMINV: ['probability, mean, standard_dev', 'formulaHints.fn.NORMINV'],
  NORMSDIST: ['z', 'formulaHints.fn.NORMSDIST'],
  NORMSINV: ['probability', 'formulaHints.fn.NORMSINV'],
  'WEIBULL.DIST': ['x, alpha, beta, cumulative', 'formulaHints.fn.WEIBULL_DIST'],
  WEIBULL: ['x, alpha, beta, cumulative', 'formulaHints.fn.WEIBULL'],
  POISSON: ['x, mean, cumulative', 'formulaHints.fn.POISSON'],
  EXPONDIST: ['x, lambda, cumulative', 'formulaHints.fn.EXPONDIST'],
  BINOMDIST: ['number_s, trials, probability_s, cumulative', 'formulaHints.fn.BINOMDIST'],
  CRITBINOM: ['trials, probability_s, alpha', 'formulaHints.fn.CRITBINOM'],
  NEGBINOMDIST: ['number_f, number_s, probability_s', 'formulaHints.fn.NEGBINOMDIST'],
  HYPGEOMDIST: ['sample_s, number_sample, population_s, number_pop', 'formulaHints.fn.HYPGEOMDIST'],
  BETADIST: ['x, alpha, beta, [A], [B]', 'formulaHints.fn.BETADIST'],
  BETAINV: ['probability, alpha, beta, [A], [B]', 'formulaHints.fn.BETAINV'],
  'CHISQ.DIST.RT': ['x, deg_freedom', 'formulaHints.fn.CHISQ_DIST_RT'],
  'CHISQ.INV': ['probability, deg_freedom', 'formulaHints.fn.CHISQ_INV'],
  'CHISQ.INV.RT': ['probability, deg_freedom', 'formulaHints.fn.CHISQ_INV_RT'],
  CHIDIST: ['x, deg_freedom', 'formulaHints.fn.CHIDIST'],
  CHIINV: ['probability, deg_freedom', 'formulaHints.fn.CHIINV'],
  CHITEST: ['actual_range, expected_range', 'formulaHints.fn.CHITEST'],
  'F.DIST.RT': ['x, deg_freedom1, deg_freedom2', 'formulaHints.fn.F_DIST_RT'],
  'F.INV.RT': ['probability, deg_freedom1, deg_freedom2', 'formulaHints.fn.F_INV_RT'],
  FDIST: ['x, deg_freedom1, deg_freedom2', 'formulaHints.fn.FDIST'],
  FINV: ['probability, deg_freedom1, deg_freedom2', 'formulaHints.fn.FINV'],
  FTEST: ['array1, array2', 'formulaHints.fn.FTEST'],
  'T.DIST.2T': ['x, deg_freedom', 'formulaHints.fn.T_DIST_2T'],
  'T.DIST.RT': ['x, deg_freedom', 'formulaHints.fn.T_DIST_RT'],
  'T.INV.2T': ['probability, deg_freedom', 'formulaHints.fn.T_INV_2T'],
  TDIST: ['x, deg_freedom, tails', 'formulaHints.fn.TDIST'],
  TINV: ['probability, deg_freedom', 'formulaHints.fn.TINV'],
  TTEST: ['array1, array2, tails, type', 'formulaHints.fn.TTEST'],
  'Z.TEST': ['array, x, [sigma]', 'formulaHints.fn.Z_TEST'],
  ZTEST: ['array, x, [sigma]', 'formulaHints.fn.ZTEST'],
  CONFIDENCE: ['alpha, standard_dev, size', 'formulaHints.fn.CONFIDENCE'],
  'CONFIDENCE.T': ['alpha, standard_dev, size', 'formulaHints.fn.CONFIDENCE_T'],
  'ERF.PRECISE': ['x', 'formulaHints.fn.ERF_PRECISE'],
  'ERFC.PRECISE': ['x', 'formulaHints.fn.ERFC_PRECISE'],
  BITOR: ['number1, number2', 'formulaHints.fn.BITOR'],
  BITXOR: ['number1, number2', 'formulaHints.fn.BITXOR'],
  BITLSHIFT: ['number, shift_amount', 'formulaHints.fn.BITLSHIFT'],
  BITRSHIFT: ['number, shift_amount', 'formulaHints.fn.BITRSHIFT'],
  BIN2HEX: ['number, [places]', 'formulaHints.fn.BIN2HEX'],
  BIN2OCT: ['number, [places]', 'formulaHints.fn.BIN2OCT'],
  DEC2OCT: ['number, [places]', 'formulaHints.fn.DEC2OCT'],
  HEX2BIN: ['number, [places]', 'formulaHints.fn.HEX2BIN'],
  HEX2OCT: ['number, [places]', 'formulaHints.fn.HEX2OCT'],
  OCT2BIN: ['number, [places]', 'formulaHints.fn.OCT2BIN'],
  OCT2DEC: ['number', 'formulaHints.fn.OCT2DEC'],
  OCT2HEX: ['number, [places]', 'formulaHints.fn.OCT2HEX'],
  IMREAL: ['inumber', 'formulaHints.fn.IMREAL'],
  IMAGINARY: ['inumber', 'formulaHints.fn.IMAGINARY'],
  IMCONJUGATE: ['inumber', 'formulaHints.fn.IMCONJUGATE'],
  IMSUB: ['inumber1, inumber2', 'formulaHints.fn.IMSUB'],
  IMSQRT: ['inumber', 'formulaHints.fn.IMSQRT'],
  IMEXP: ['inumber', 'formulaHints.fn.IMEXP'],
  IMLN: ['inumber', 'formulaHints.fn.IMLN'],
  IMLOG10: ['inumber', 'formulaHints.fn.IMLOG10'],
  IMLOG2: ['inumber', 'formulaHints.fn.IMLOG2'],
  IMSIN: ['inumber', 'formulaHints.fn.IMSIN'],
  IMCOS: ['inumber', 'formulaHints.fn.IMCOS'],
  IMTAN: ['inumber', 'formulaHints.fn.IMTAN'],
  DSTDEVP: ['database, field, criteria', 'formulaHints.fn.DSTDEVP'],
  DVARP: ['database, field, criteria', 'formulaHints.fn.DVARP'],
  LEFTB: ['text, [num_bytes]', 'formulaHints.fn.LEFTB'],
  RIGHTB: ['text, [num_bytes]', 'formulaHints.fn.RIGHTB'],
  MIDB: ['text, start, num_bytes', 'formulaHints.fn.MIDB'],
  LENB: ['text', 'formulaHints.fn.LENB'],
  FINDB: ['find_text, within_text, [start]', 'formulaHints.fn.FINDB'],
  SEARCHB: ['find_text, within_text, [start]', 'formulaHints.fn.SEARCHB'],
  REPLACEB: ['old_text, start, num_bytes, new_text', 'formulaHints.fn.REPLACEB'],
  SINGLE: ['value', 'formulaHints.fn.SINGLE'],
  TABLE: ['row_input, column_input', 'formulaHints.fn.TABLE'],
  TO_DATE: ['value', 'formulaHints.fn.TO_DATE'],
  TO_DOLLARS: ['value', 'formulaHints.fn.TO_DOLLARS'],
  TO_PERCENT: ['value', 'formulaHints.fn.TO_PERCENT'],
  TO_PURE_NUMBER: ['value', 'formulaHints.fn.TO_PURE_NUMBER'],
  TO_TEXT: ['value', 'formulaHints.fn.TO_TEXT'],
};

/**
 * A function's argument list and description in the interface language. `{ source: true }` gives the
 * description in English whatever the language: for the AI model, or to search by English words.
 */
export function signatureFor(name, { source = false } = {}) {
  const [params, key] = SIGNATURES[name] || ['...', ''];
  return { name, params, description: key ? (source ? tSource(key) : t(key)) : '' };
}

const COMMON = ['SUM', 'AVERAGE', 'COUNT', 'MIN', 'MAX', 'IF', 'SUMIF', 'COUNTIF', 'VLOOKUP', 'ROUND', 'TODAY', 'CONCAT', 'IFERROR', 'AND', 'OR', 'INDEX', 'MATCH'];

/** Function names starting with the prefix: the everyday ones first, then documented, then the rest. */
export function matchFunctions(prefix, limit = 8, extraNames = []) {
  const p = prefix.toUpperCase();
  if (!p) return [];
  const starts = FUNCTION_NAMES.filter((n) => n.startsWith(p));
  const rank = (n) => (COMMON.includes(n) ? COMMON.indexOf(n) : SIGNATURES[n] ? 100 : 200);
  const names = extraNames.filter((n) => n.toUpperCase().startsWith(p)).sort();
  return [...names, ...starts.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))].slice(0, limit);
}

/** Is the caret inside quoted text, rather than an expression to complete or point a reference into? */
export function inString(text, caret) {
  if (!text.includes('"') && !text.includes("'")) return false;
  let quote = null, brackets = 0;
  for (let i = 0; i < caret; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) { if (text[i + 1] === quote) i++; else quote = null; }
    } else if (brackets) {
      if (ch === "'") i++;
      else if (ch === '[') brackets++;
      else if (ch === ']') brackets--;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '[') brackets++;
  }
  return quote !== null;
}

/** The name suffix after a complete sheet qualifier, including an empty suffix. */
function qualifiedName(before) {
  const bang = before.lastIndexOf('!');
  if (bang < 1) return null;
  const prefix = before.slice(bang + 1);
  if (prefix && (!/^[\p{L}_\\][\p{L}\p{M}\p{N}_.\\?]*$/u.test(prefix) || /^[A-Za-z]{1,3}\d+$/.test(prefix))) return null;
  let start = bang - 1, sheet;
  if (before[start] === "'") {
    start--;
    while (start >= 1) {
      if (before[start] !== "'") { start--; continue; }
      if (before[start - 1] === "'") { start -= 2; continue; }
      break;
    }
    if (start < 1) return null;
    sheet = before.slice(start + 1, bang - 1).replace(/''/g, "'");
  } else {
    while (start >= 1 && /[\p{L}\p{M}\p{N}_.]/u.test(before[start])) start--;
    start++;
    sheet = before.slice(start, bang);
    if (!/^[\p{L}_\\][\p{L}\p{M}\p{N}_.\\?]*$/u.test(sheet)) return null;
  }
  if (!sheet || /[\p{L}\p{M}\p{N}_.'!:$]/u.test(before[start - 1] || '')) return null;
  return { kind: 'name', sheet, prefix, start: bang + 1 };
}

/**
 * Inside a structured reference's brackets: which table (null for a bare
 * [@Col] inside a table) and the column text typed so far.
 *   { kind: 'column', table, prefix, start, atRow, wrapped } or null
 */
function columnContext(before) {
  // Unmatched "[" positions, outermost first.
  const opens = [];
  for (let i = 1; i < before.length; i++) {
    const ch = before[i];
    if (ch === '"') { i++; while (i < before.length && before[i] !== '"') i++; continue; }
    if (ch === "'") { i++; continue; }
    if (ch === '[') opens.push(i);
    else if (ch === ']') opens.pop();
  }
  if (!opens.length) return null;
  const inner = before.slice(opens[opens.length - 1] + 1);
  if (/[\],]/.test(inner)) return null;
  const atRow = inner.startsWith('@');
  const prefix = atRow ? inner.slice(1) : inner;
  if (prefix.startsWith('[')) return null;
  const outer = opens[0];
  const table = /([\p{L}_\\][\p{L}\p{M}\p{N}_.\\?]*)$/u.exec(before.slice(0, outer))?.[1] || null;
  return { kind: 'column', table, prefix, start: before.length - prefix.length, atRow, wrapped: opens.length > 1 };
}

/** Column names (and, for a # prefix, the row selectors) that fit what was typed. */
export function matchColumns(prefix, columns, limit = 8) {
  const p = prefix.toLowerCase();
  const selectors = ['#All', '#Data', '#Headers', '#Totals', '#This Row'];
  const pool = p.startsWith('#') ? selectors : columns;
  return pool.filter((n) => n.toLowerCase().startsWith(p)).slice(0, limit);
}

export function completionContext(text, caret = text.length) {
  if (!text || text[0] !== '=' || caret < 1 || inString(text, caret)) return null;
  const before = text.slice(0, caret);

  const column = columnContext(before);
  if (column) return column;

  if (before.endsWith('!')) {
    const qualified = qualifiedName(before);
    if (qualified) return qualified;
  }

  // A name being typed: letters (and dots/underscores) right before the caret,
  // not glued onto a cell reference like A1 or a sheet name like Data!.
  const m = /([\p{L}_\\][\p{L}\p{M}\p{N}_.\\?]*)$/u.exec(before);
  if (m) {
    const word = m[1];
    const start = caret - word.length;
    const prevChar = before[start - 1] || '';
    if (prevChar === '!') {
      const qualified = qualifiedName(before);
      if (qualified) return qualified;
    }
    const looksLikeRef = /^\$?[A-Za-z]{1,3}\d+$/.test(word) || /^\d/.test(word);
    const afterSheet = prevChar === '!' || prevChar === "'";
    const afterColon = prevChar === ':'; // the end of a range, never a function
    if (!looksLikeRef && !afterSheet && !afterColon && start > 0) {
      return { kind: 'name', prefix: word, start };
    }
  }

  // Otherwise, the innermost open call around the caret.
  let depth = 0;
  let argIndex = 0;
  const argCounts = [];
  for (let i = before.length - 1; i >= 1; i--) {
    const ch = before[i];
    if (ch === '"') { // skip back over a string literal
      i--;
      while (i >= 1 && before[i] !== '"') i--;
      continue;
    }
    // A quoted sheet name ('Sales, 2024'!A1) may hold commas and parentheses: skip back to its
    // opening quote, passing over the doubled '' that stands for one quote inside it.
    if (ch === "'" && before[i + 1] === '!') {
      i--;
      while (i >= 1 && (before[i] !== "'" || before[i - 1] === "'")) i -= before[i] === "'" ? 2 : 1;
      continue;
    }
    if (ch === ')' || ch === '}' || ch === ']') { depth++; continue; }
    if (ch === ',' || ch === ';') { if (depth === 0) argIndex++; continue; }
    // Commas inside an array constant or a structured reference separate its parts, not the call's arguments.
    if (ch === '{' || ch === '[') { if (depth > 0) depth--; else argIndex = 0; continue; }
    if (ch === '(') {
      if (depth > 0) { depth--; continue; }
      const nm = /([\p{L}_\\][\p{L}\p{M}\p{N}_.\\?]*)$/u.exec(before.slice(0, i));
      if (nm) {
        const start = i - nm[1].length;
        if (before[start - 1] === '!') {
          const qualified = qualifiedName(before.slice(0, i));
          if (qualified) return { kind: 'call', name: nm[1].toUpperCase(), sheet: qualified.sheet, argIndex, start };
        }
        return { kind: 'call', name: nm[1].toUpperCase(), argIndex, start };
      }
      return null;
    }
  }
  void argCounts;
  return null;
}
