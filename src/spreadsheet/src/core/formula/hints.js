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

export const SIGNATURES = {
  ADDRESS: ['row_num, column_num, [abs_num], [a1], [sheet_text]', 'A cell address as text; choose absolute or relative references, A1 or R1C1 notation, and an optional sheet.'],
  SUM: ['number1, [number2], ...', 'Adds its arguments.'],
  SORTBY: ['array, by_array1, [order1], [by_array2], [order2], ...', 'Sorts the rows of a range by one or more other ranges (1 ascending, -1 descending).'],
  AGGREGATE: ['function_num, options, ref1, [ref2 | k]', 'SUBTOTAL with more functions and options to skip hidden rows (1) and errors (2); 14-19 take k.'],
  'MODE.MULT': ['number1, [number2], ...', 'Every most-frequent value, as a column.'],
  STDEVA: ['value1, [value2], ...', 'Sample standard deviation counting text as 0 and TRUE as 1.'],
  VARA: ['value1, [value2], ...', 'Sample variance counting text as 0 and TRUE as 1.'],
  GAUSS: ['z', 'Probability a standard normal value falls between 0 and z.'],
  PHI: ['x', 'Density of the standard normal distribution at x.'],
  'F.INV': ['probability, deg_freedom1, deg_freedom2', 'Inverse of the left-tailed F distribution.'],
  'F.TEST': ['array1, array2', 'Two-tailed probability that two samples have different variances.'],
  'BINOM.INV': ['trials, probability_s, alpha', 'Smallest count of successes whose cumulative probability reaches alpha.'],
  'GAMMA.INV': ['probability, alpha, beta', 'Inverse of the gamma cumulative distribution.'],
  'BETA.DIST': ['x, alpha, beta, cumulative, [A], [B]', 'Beta distribution, optionally rescaled to [A, B].'],
  'BETA.INV': ['probability, alpha, beta, [A], [B]', 'Inverse of the beta cumulative distribution.'],
  'HYPGEOM.DIST': ['sample_s, number_sample, population_s, number_pop, cumulative', 'Hypergeometric distribution: successes in a sample drawn without replacement.'],
  'NEGBINOM.DIST': ['number_f, number_s, probability_s, cumulative', 'Negative binomial distribution: failures before the given successes.'],
  ERF: ['lower_limit, [upper_limit]', 'Error function integrated between the limits.'],
  ERFC: ['x', 'Complementary error function.'],
  COMPLEX: ['real_num, i_num, [suffix]', 'A complex number "a+bi" from its parts.'],
  IMSUM: ['inumber1, [inumber2], ...', 'Sum of complex numbers.'],
  IMPRODUCT: ['inumber1, [inumber2], ...', 'Product of complex numbers.'],
  IMDIV: ['inumber1, inumber2', 'Quotient of two complex numbers.'],
  IMPOWER: ['inumber, number', 'A complex number raised to a power.'],
  IMABS: ['inumber', 'Modulus of a complex number.'],
  IMARGUMENT: ['inumber', 'Argument (angle in radians) of a complex number.'],
  PROB: ['x_range, prob_range, lower_limit, [upper_limit]', 'Probability that a value falls between the limits.'],
  'PERCENTRANK.EXC': ['array, x, [significance]', 'Percent rank of a value, exclusive of 0 and 1.'],
  MARGINOFERROR: ['range, confidence', 'Sampling error of a mean at a confidence level.'],
  COUNTUNIQUEIFS: ['range, criteria_range1, criterion1, ...', 'Distinct values in a range whose rows meet the criteria.'],
  DISC: ['settlement, maturity, pr, redemption, [basis]', 'Discount rate of a security.'],
  INTRATE: ['settlement, maturity, investment, redemption, [basis]', 'Interest rate of a fully invested security.'],
  RECEIVED: ['settlement, maturity, investment, discount, [basis]', 'Amount received at maturity for a fully invested security.'],
  PRICEDISC: ['settlement, maturity, discount, redemption, [basis]', 'Price per 100 of a discounted security.'],
  YIELDDISC: ['settlement, maturity, pr, redemption, [basis]', 'Annual yield of a discounted security.'],
  TBILLEQ: ['settlement, maturity, discount', 'Bond-equivalent yield of a Treasury bill.'],
  TBILLPRICE: ['settlement, maturity, discount', 'Price per 100 of a Treasury bill.'],
  TBILLYIELD: ['settlement, maturity, pr', 'Yield of a Treasury bill.'],
  PRICE: ['settlement, maturity, rate, yld, redemption, frequency, [basis]', 'Price per 100 face value of a bond paying periodic interest.'],
  YIELD: ['settlement, maturity, rate, pr, redemption, frequency, [basis]', 'Yield of a bond paying periodic interest, from its price.'],
  DURATION: ['settlement, maturity, coupon, yld, frequency, [basis]', 'Macaulay duration of a bond, in years.'],
  MDURATION: ['settlement, maturity, coupon, yld, frequency, [basis]', 'Modified duration of a bond: its price sensitivity to yield.'],
  ACCRINT: ['issue, first_interest, settlement, rate, par, frequency, [basis]', 'Interest accrued on a security that pays periodic interest.'],
  ACCRINTM: ['issue, settlement, rate, par, [basis]', 'Interest accrued on a security that pays at maturity.'],
  PRICEMAT: ['settlement, maturity, issue, rate, yld, [basis]', 'Price per 100 face value of a security that pays interest at maturity.'],
  YIELDMAT: ['settlement, maturity, issue, rate, pr, [basis]', 'Yield of a security that pays interest at maturity.'],
  AMORLINC: ['cost, date_purchased, first_period, salvage, period, rate, [basis]', 'Linear depreciation of an asset for an accounting period (French system), prorated in the first period.'],
  AMORDEGRC: ['cost, date_purchased, first_period, salvage, period, rate, [basis]', 'Declining-balance depreciation for an accounting period (French system), with a coefficient by asset life.'],
  ODDFPRICE: ['settlement, maturity, issue, first_coupon, rate, yld, redemption, frequency, [basis]', 'Price per 100 face value of a security with an odd (short or long) first period.'],
  ODDFYIELD: ['settlement, maturity, issue, first_coupon, rate, pr, redemption, frequency, [basis]', 'Yield of a security with an odd (short or long) first period.'],
  ODDLPRICE: ['settlement, maturity, last_interest, rate, yld, redemption, frequency, [basis]', 'Price per 100 face value of a security with an odd last period.'],
  ODDLYIELD: ['settlement, maturity, last_interest, rate, pr, redemption, frequency, [basis]', 'Yield of a security with an odd last period.'],
  BAHTTEXT: ['number', 'A number in Thai words, as baht and satang.'],
  ASC: ['text', 'Full-width (double-byte) letters as half-width ones, under a double-byte language.'],
  DBCS: ['text', 'Half-width (single-byte) letters as full-width ones, under a double-byte language.'],
  JIS: ['text', 'Half-width (single-byte) letters as full-width ones (the same as DBCS).'],
  PHONETIC: ['reference', 'The phonetic (furigana) text of a cell; #N/A where none is stored.'],
  GETPIVOTDATA: ['data_field, pivot_table, [field1, item1], ...', 'A value from a PivotTable: the data field, narrowed by field and item pairs (the grand total when none are given).'],
  WEBSERVICE: ['url', 'The text a web address returns; #BUSY! while it downloads.'],
  STOCKHISTORY: ['stock, start_date, [end_date], [interval], [headers], [property0], ...', 'Historical market data; needs a data service this app does not reach (#CONNECT!).'],
  RTD: ['progID, server, topic1, [topic2], ...', 'Data from a real-time data server program; none is available here (#N/A).'],
  CUBEVALUE: ['connection, [member_expression1], ...', 'An aggregated value from an OLAP cube; needs a data connection (#N/A).'],
  CUBEMEMBER: ['connection, member_expression, [caption]', 'A member or tuple from an OLAP cube; needs a data connection (#N/A).'],
  CUBEMEMBERPROPERTY: ['connection, member_expression, property', 'A property of a cube member; needs a data connection (#N/A).'],
  CUBERANKEDMEMBER: ['connection, set_expression, rank, [caption]', 'The nth member of a cube set; needs a data connection (#N/A).'],
  CUBESET: ['connection, set_expression, [caption], [sort_order], [sort_by]', 'A set of cube members; needs a data connection (#N/A).'],
  CUBESETCOUNT: ['set', 'The number of items in a cube set; needs a data connection (#N/A).'],
  CUBEKPIMEMBER: ['connection, kpi_name, kpi_property, [caption]', 'A key performance indicator property from a cube; needs a data connection (#N/A).'],
  COUPPCD: ['settlement, maturity, frequency, [basis]', 'The coupon date on or before settlement.'],
  COUPNCD: ['settlement, maturity, frequency, [basis]', 'The first coupon date after settlement.'],
  COUPNUM: ['settlement, maturity, frequency, [basis]', 'Coupons payable between settlement and maturity.'],
  COUPDAYBS: ['settlement, maturity, frequency, [basis]', 'Days from the start of the coupon period to settlement.'],
  COUPDAYS: ['settlement, maturity, frequency, [basis]', 'Days in the coupon period that contains settlement.'],
  COUPDAYSNC: ['settlement, maturity, frequency, [basis]', 'Days from settlement to the next coupon date.'],
  QUERY: ['data, query, [headers]', 'Runs a Sheets-style query over the data: select, where, group by, order by, limit, label (e.g. "select A, sum(C) where B > 5 group by A").'],
  ISOMITTED: ['argument', 'TRUE when an optional LAMBDA parameter, written [name], was left out by the caller.'],
  IMPORTXML: ['url, xpath_query', 'Nodes picked by an XPath query from an XML or HTML document, one per row; #BUSY! while it downloads.'],
  IMPORTHTML: ['url, "table" | "list", [index]', 'The nth table or list on a web page, spilled into place; #BUSY! while it downloads.'],
  IMPORTDATA: ['url, [delimiter]', 'A CSV or TSV file from a web address, spilled into place; #BUSY! while it downloads.'],
  IMPORTRANGE: ['spreadsheet, range', 'Cells from another spreadsheet on your Puter drive ("Budget" or a path, then "Sheet1!A1:B10"); #BUSY! while it loads.'],
  AI: ['prompt, [data]', 'Asks Puter AI a question, optionally about a range of data; the answer fills the cell (#BUSY! while it thinks).'],
  TRANSLATE: ['text, [source_language], [target_language]', 'Translates text with Puter AI (languages as codes or names; the target defaults to English). #BUSY! while it works.'],
  GOOGLETRANSLATE: ['text, [source_language], [target_language]', 'Translates text with Puter AI (the Sheets name for TRANSLATE).'],
  DETECTLANGUAGE: ['text', 'The two-letter code of the language a text is written in, from Puter AI.'],
  AVERAGE: ['number1, [number2], ...', 'Arithmetic mean of the numbers.'],
  MIN: ['number1, [number2], ...', 'Smallest value.'],
  MAX: ['number1, [number2], ...', 'Largest value.'],
  COUNT: ['value1, [value2], ...', 'How many cells hold numbers.'],
  COUNTA: ['value1, [value2], ...', 'How many cells are not empty.'],
  COUNTBLANK: ['range', 'How many cells are empty.'],
  MEDIAN: ['number1, [number2], ...', 'Middle value.'],
  PRODUCT: ['number1, [number2], ...', 'Multiplies its arguments.'],
  STDEV: ['number1, [number2], ...', 'Sample standard deviation.'],
  ROUND: ['number, [digits]', 'Rounds to a number of digits.'],
  ROUNDUP: ['number, [digits]', 'Rounds away from zero.'],
  ROUNDDOWN: ['number, [digits]', 'Rounds toward zero.'],
  ABS: ['number', 'Absolute value.'],
  INT: ['number', 'Rounds down to an integer.'],
  MOD: ['number, divisor', 'Remainder after division.'],
  POWER: ['number, power', 'Raises a number to a power.'],
  SQRT: ['number', 'Square root.'],
  SUMIF: ['range, criteria, [sum_range]', 'Adds cells that meet a condition.'],
  SUMIFS: ['sum_range, criteria_range1, criteria1, ...', 'Adds cells meeting several conditions.'],
  COUNTIF: ['range, criteria', 'Counts cells that meet a condition.'],
  COUNTIFS: ['criteria_range1, criteria1, ...', 'Counts cells meeting several conditions.'],
  AVERAGEIF: ['range, criteria, [average_range]', 'Average of cells that meet a condition.'],
  SUMPRODUCT: ['array1, [array2], ...', 'Sum of the products of matching cells.'],
  IF: ['condition, value_if_true, [value_if_false]', 'One value or another depending on a test.'],
  IFS: ['condition1, value1, [condition2, value2], ...', 'First value whose condition is true.'],
  IFERROR: ['value, value_if_error', 'A fallback when a value is an error.'],
  IFNA: ['value, value_if_na', 'A fallback when a value is #N/A.'],
  AND: ['logical1, [logical2], ...', 'TRUE when every argument is true.'],
  OR: ['logical1, [logical2], ...', 'TRUE when any argument is true.'],
  NOT: ['logical', 'Reverses TRUE and FALSE.'],
  SWITCH: ['expression, value1, result1, ..., [default]', 'Matches an expression against a list.'],
  CHOOSE: ['index, value1, [value2], ...', 'Picks a value by position.'],
  VLOOKUP: ['search_key, range, index, [is_sorted]', 'Looks down the first column, returns from another.'],
  HLOOKUP: ['search_key, range, index, [is_sorted]', 'Looks across the first row, returns from another.'],
  XLOOKUP: ['search_key, lookup_range, return_range, [if_not_found], [match_mode], [search_mode]', 'Finds a value and returns its match; match_mode -1/1 takes the next smaller/larger, 2 allows wildcards.'],
  INDEX: ['range, row, [column]', 'The value at a position in a range.'],
  MATCH: ['search_key, range, [type]', 'The position of a value in a range.'],
  CONCAT: ['text1, [text2], ...', 'Joins text.'],
  TEXTJOIN: ['delimiter, ignore_empty, text1, ...', 'Joins text with a separator.'],
  LEN: ['text', 'Number of characters.'],
  LEFT: ['text, [count]', 'Characters from the start.'],
  RIGHT: ['text, [count]', 'Characters from the end.'],
  MID: ['text, start, count', 'Characters from the middle.'],
  UPPER: ['text', 'Uppercase.'],
  LOWER: ['text', 'Lowercase.'],
  PROPER: ['text', 'Capitalizes each word.'],
  TRIM: ['text', 'Removes extra spaces.'],
  SUBSTITUTE: ['text, old_text, new_text, [instance]', 'Replaces text.'],
  FIND: ['search_text, text, [start]', 'Position of text (case-sensitive).'],
  SEARCH: ['search_text, text, [start]', 'Position of text (case-insensitive).'],
  TEXT: ['value, format', 'Formats a number as text.'],
  VALUE: ['text', 'Converts text to a number.'],
  TODAY: ['', 'The current date.'],
  NOW: ['', 'The current date and time.'],
  DATE: ['year, month, day', 'Builds a date.'],
  YEAR: ['date', 'The year of a date.'],
  MONTH: ['date', 'The month of a date.'],
  DAY: ['date', 'The day of a date.'],
  WEEKDAY: ['date, [type]', 'Day of the week as a number.'],
  DAYS: ['end_date, start_date', 'Days between two dates.'],
  EDATE: ['date, months', 'A date some months away.'],
  EOMONTH: ['date, months', 'Last day of a month.'],
  ISBLANK: ['value', 'TRUE for an empty cell.'],
  ISNUMBER: ['value', 'TRUE for a number.'],
  ISTEXT: ['value', 'TRUE for text.'],
  ISERROR: ['value', 'TRUE for any error.'],
  ROW: ['[reference]', 'Row number of a reference.'],
  COLUMN: ['[reference]', 'Column number of a reference.'],
  AVERAGEIFS: ['average_range, criteria_range1, criteria1, ...', 'Average of cells meeting several conditions.'],
  LARGE: ['range, n', 'The nth largest value.'],
  SMALL: ['range, n', 'The nth smallest value.'],
  RANK: ['value, range, [is_ascending]', 'Position of a value in a list.'],
  PERCENTILE: ['range, percentile', 'Value at a percentile (0 to 1).'],
  QUARTILE: ['range, quartile', 'Value at a quartile (0 to 4).'],
  PERCENTRANK: ['range, value, [digits]', 'Percent rank of a value in a list.'],
  MODE: ['number1, [number2], ...', 'Most common value.'],
  SUMSQ: ['number1, [number2], ...', 'Sum of squares.'],
  COUNTUNIQUE: ['value1, [value2], ...', 'How many distinct values.'],
  GEOMEAN: ['number1, [number2], ...', 'Geometric mean.'],
  AVEDEV: ['number1, [number2], ...', 'Average absolute deviation from the mean.'],
  'VAR.P': ['number1, [number2], ...', 'Population variance.'],
  'STDEV.P': ['number1, [number2], ...', 'Population standard deviation.'],
  CORREL: ['range1, range2', 'Correlation coefficient of two ranges.'],
  SLOPE: ['known_ys, known_xs', 'Slope of the best-fit line.'],
  INTERCEPT: ['known_ys, known_xs', 'Where the best-fit line crosses the y axis.'],
  FORECAST: ['x, known_ys, known_xs', 'Predicts y for x along the best-fit line.'],
  'FORECAST.ETS': ['target_date, values, timeline, [seasonality], [data_completion], [aggregation]', 'Forecasts a future value by exponential triple smoothing.'],
  'FORECAST.ETS.CONFINT': ['target_date, values, timeline, [confidence_level], [seasonality], [data_completion], [aggregation]', 'Confidence interval of the forecast at the target date.'],
  'FORECAST.ETS.SEASONALITY': ['values, timeline, [data_completion], [aggregation]', 'Length of the repeating pattern detected in the values.'],
  'FORECAST.ETS.STAT': ['values, timeline, statistic_type, [seasonality], [data_completion], [aggregation]', 'A statistic of the exponential smoothing forecast.'],
  RSQ: ['known_ys, known_xs', 'R squared of the best-fit line.'],
  MROUND: ['number, multiple', 'Rounds to the nearest multiple.'],
  QUOTIENT: ['dividend, divisor', 'Integer part of a division.'],
  GCD: ['number1, [number2], ...', 'Greatest common divisor.'],
  LCM: ['number1, [number2], ...', 'Least common multiple.'],
  FACT: ['number', 'Factorial.'],
  COMBIN: ['n, k', 'Number of combinations.'],
  PERMUT: ['n, k', 'Number of permutations.'],
  EVEN: ['number', 'Rounds up to an even integer.'],
  ODD: ['number', 'Rounds up to an odd integer.'],
  SIN: ['angle', 'Sine of an angle in radians.'],
  COS: ['angle', 'Cosine of an angle in radians.'],
  TAN: ['angle', 'Tangent of an angle in radians.'],
  ATAN2: ['x, y', 'Angle of a point, in radians.'],
  DEGREES: ['angle', 'Radians to degrees.'],
  RADIANS: ['angle', 'Degrees to radians.'],
  SPARKLINE: ['data, [type], [color]', 'A tiny chart in the cell: "line", "column", "bar", or "winloss".'],
  UNIQUE: ['range, [by_column], [exactly_once]', 'Distinct rows (or columns) of a range; spills.'],
  FILTER: ['range, condition1, [condition2], ...', 'Rows (or columns) where every condition is TRUE; spills.'],
  SORT: ['range, [sort_column], [is_ascending], [by_col | sort_column2, is_ascending2, ...]', 'Rows of a range in order; spills. A fourth argument alone is by_col (TRUE or 1 sorts the columns); more column and order pairs sort by more columns.'],
  SEQUENCE: ['rows, [columns], [start], [step]', 'A block of counting numbers; spills.'],
  TRANSPOSE: ['range', 'Rows become columns; spills.'],
  FLATTEN: ['range1, [range2], ...', 'Every value in one column; spills.'],
  SPLIT: ['text, delimiter, [split_by_each], [remove_empty]', 'Pieces of text in a row; spills.'],
  TEXTSPLIT: ['text, col_delimiter, [row_delimiter], [ignore_empty], [match_mode], [pad_with]', 'Text cut into a block of cells by one or more delimiters; spills.'],
  CHOOSECOLS: ['range, column1, [column2], ...', 'Chosen columns of a range; spills.'],
  CHOOSEROWS: ['range, row1, [row2], ...', 'Chosen rows of a range; spills.'],
  ARRAYFORMULA: ['array_formula', 'Evaluates over whole ranges; spills.'],
  LOOKUP: ['search_key, search_range, [result_range]', 'Approximate lookup along a row or column.'],
  INDIRECT: ['reference_text, [a1]', 'The cell or range a text address names. Use FALSE for R1C1 notation; TRUE or omitted uses A1.'],
  OFFSET: ['reference, rows, columns, [height], [width]', 'A range shifted from a reference.'],
  HYPERLINK: ['url, [label]', 'A clickable link.'],
  SHEET: ['[sheet_name]', 'Position of a sheet.'],
  SHEETS: ['', 'Number of sheets.'],
  ISFORMULA: ['reference', 'TRUE when the cell holds a formula.'],
  FORMULATEXT: ['reference', 'The formula in a cell, as text.'],
  'ERROR.TYPE': ['value', 'A number for each kind of error.'],
  REGEXMATCH: ['text, regular_expression', 'TRUE when the text matches.'],
  INFO: ['type_text', 'Information about the environment: "numfile", "recalc", "release", "system", "directory", "origin", "osversion".'],
  FILTERXML: ['xml, xpath', 'Values picked from XML text by an XPath expression, spilled down.'],
  'BINOM.DIST.RANGE': ['trials, probability_s, number_s, [number_s2]', 'Probability of a count of successes between two bounds.'],
  BESSELJ: ['x, n', 'Bessel function of the first kind, order n.'],
  BESSELY: ['x, n', 'Bessel function of the second kind (Weber), order n.'],
  BESSELI: ['x, n', 'Modified Bessel function of the first kind, order n.'],
  BESSELK: ['x, n', 'Modified Bessel function of the second kind, order n.'],
  IMCOSH: ['inumber', 'Hyperbolic cosine of a complex number.'],
  IMSINH: ['inumber', 'Hyperbolic sine of a complex number.'],
  IMSEC: ['inumber', 'Secant of a complex number.'],
  IMCSC: ['inumber', 'Cosecant of a complex number.'],
  IMCOT: ['inumber', 'Cotangent of a complex number.'],
  IMSECH: ['inumber', 'Hyperbolic secant of a complex number.'],
  IMCSCH: ['inumber', 'Hyperbolic cosecant of a complex number.'],
  REGEXTEST: ['text, pattern, [case_sensitivity]', 'TRUE when the text matches the regular expression (1 ignores case).'],
  GROUPBY: ['row_fields, values, function, [field_headers], [total_depth], [sort_order], [filter_array]', 'Groups rows by one or more fields and summarizes the values with a function named without parentheses (SUM, AVERAGE, COUNT, ...) or a LAMBDA; totals, subtotals, sorting, and a filter are optional.'],
  PIVOTBY: ['row_fields, col_fields, values, function, [field_headers], [row_total_depth], [row_sort_order], [col_total_depth], [col_sort_order], [filter_array]', 'A pivot: rows by one field, columns by another, each cell the function over the matching values, with totals.'],
  PERCENTOF: ['data_subset, data_all', 'The sum of a subset as a share of the sum of everything; named in GROUPBY or PIVOTBY, each group\'s share of all the values.'],
  TRIMRANGE: ['range, [trim_rows], [trim_cols]', 'The range without its blank leading and trailing rows and columns (0 none, 1 leading, 2 trailing, 3 both).'],
  ADD: ['value1, value2', 'value1 + value2.'],
  MINUS: ['value1, value2', 'value1 - value2.'],
  MULTIPLY: ['factor1, factor2', 'factor1 times factor2.'],
  DIVIDE: ['dividend, divisor', 'dividend divided by divisor.'],
  POW: ['base, exponent', 'base raised to exponent.'],
  EQ: ['value1, value2', 'TRUE when the values are equal (the = operator).'],
  NE: ['value1, value2', 'TRUE when the values differ (the <> operator).'],
  GT: ['value1, value2', 'TRUE when value1 > value2.'],
  GTE: ['value1, value2', 'TRUE when value1 >= value2.'],
  LT: ['value1, value2', 'TRUE when value1 < value2.'],
  LTE: ['value1, value2', 'TRUE when value1 <= value2.'],
  UMINUS: ['value', 'The value negated.'],
  UPLUS: ['value', 'The value as is.'],
  UNARY_PERCENT: ['value', 'The value divided by 100 (the % operator).'],
  REGEXEXTRACT: ['text, regular_expression', 'The first match, its capture group, or several groups as a row; spills.'],
  REGEXREPLACE: ['text, regular_expression, replacement', 'Replaces every match.'],
  JOIN: ['delimiter, value1, [value2], ...', 'Joins values with a separator.'],
  TEXTBEFORE: ['text, delimiter, [instance_num], [match_mode], [match_end], [if_not_found]', 'Text before a delimiter; a negative instance counts from the end.'],
  TEXTAFTER: ['text, delimiter, [instance_num], [match_mode], [match_end], [if_not_found]', 'Text after a delimiter; a negative instance counts from the end.'],
  NUMBERVALUE: ['text, [decimal_separator], [group_separator]', 'Text to a number, with custom separators.'],
  DOLLAR: ['number, [decimals]', 'Formats a number as currency text.'],
  FIXED: ['number, [decimals], [no_commas]', 'Formats a number with fixed decimals as text.'],
  UNICHAR: ['number', 'The character for a Unicode code point.'],
  UNICODE: ['text', 'Code point of the first character.'],
  DATEDIF: ['start_date, end_date, unit', 'Difference between dates in "Y", "M", "D", "YM", "MD", or "YD".'],
  DATEVALUE: ['date_text', 'Turns date text into a date.'],
  TIMEVALUE: ['time_text', 'Turns time text into a time.'],
  WEEKNUM: ['date, [type]', 'Week of the year.'],
  ISOWEEKNUM: ['date', 'ISO week of the year.'],
  NETWORKDAYS: ['start_date, end_date, [holidays]', 'Working days between two dates.'],
  WORKDAY: ['start_date, days, [holidays]', 'The date some working days away.'],
  YEARFRAC: ['start_date, end_date, [basis]', 'Fraction of a year between two dates.'],
  DAYS360: ['start_date, end_date, [method]', 'Days between dates on a 360-day year.'],
  PMT: ['rate, periods, present_value, [future_value], [type]', 'Payment per period for a loan.'],
  IPMT: ['rate, period, periods, present_value, [future_value], [type]', 'Interest part of a payment.'],
  PPMT: ['rate, period, periods, present_value, [future_value], [type]', 'Principal part of a payment.'],
  FV: ['rate, periods, payment, [present_value], [type]', 'Future value of an investment.'],
  PV: ['rate, periods, payment, [future_value], [type]', 'Present value of an investment.'],
  NPER: ['rate, payment, present_value, [future_value], [type]', 'Number of payment periods.'],
  RATE: ['periods, payment, present_value, [future_value], [type], [guess]', 'Interest rate per period.'],
  NPV: ['rate, cashflow1, [cashflow2], ...', 'Net present value of cash flows.'],
  IRR: ['cashflows, [guess]', 'Internal rate of return.'],
  XNPV: ['rate, cashflows, dates', 'Net present value with dated cash flows.'],
  XIRR: ['cashflows, dates, [guess]', 'Rate of return with dated cash flows.'],
  SLN: ['cost, salvage, life', 'Straight-line depreciation per period.'],
  SYD: ['cost, salvage, life, period', 'Sum-of-years depreciation for a period.'],
  DDB: ['cost, salvage, life, period, [factor]', 'Declining-balance depreciation for a period.'],
  EFFECT: ['nominal_rate, periods_per_year', 'Effective annual interest rate.'],
  NOMINAL: ['effective_rate, periods_per_year', 'Nominal annual interest rate.'],
  LET: ['name1, value1, [name2, value2], ..., result', 'Names intermediate values, then computes a result with them.'],
  LAMBDA: ['[param1, param2], ..., calculation', 'A custom function, for MAP, REDUCE, BYROW, or a LET name.'],
  MAP: ['array1, [array2], ..., lambda', 'Applies a LAMBDA to every value, returning an array.'],
  REDUCE: ['initial_value, array, lambda(accumulator, value)', 'Folds an array into one value.'],
  SCAN: ['initial_value, array, lambda(accumulator, value)', 'Like REDUCE, keeping every intermediate value.'],
  BYROW: ['array, lambda(row)', 'Applies a LAMBDA to each row.'],
  BYCOL: ['array, lambda(column)', 'Applies a LAMBDA to each column.'],
  MAKEARRAY: ['rows, columns, lambda(row, column)', 'Builds an array from a LAMBDA of the position.'],
  XMATCH: ['search_key, lookup_range, [match_mode], [search_mode]', 'Position of a value: 0 exact, -1 next smaller, 1 next larger, 2 wildcard.'],
  VSTACK: ['array1, [array2], ...', 'Stacks arrays on top of each other.'],
  HSTACK: ['array1, [array2], ...', 'Places arrays side by side.'],
  TAKE: ['array, rows, [columns]', 'The first (or, negative, last) rows and columns.'],
  DROP: ['array, rows, [columns]', 'Everything but the first (or last) rows and columns.'],
  EXPAND: ['array, rows, [columns], [pad_with]', 'Grows an array, padding the new cells.'],
  WRAPROWS: ['vector, wrap_count, [pad_with]', 'Wraps a row or column into rows of a given length.'],
  WRAPCOLS: ['vector, wrap_count, [pad_with]', 'Wraps a row or column into columns of a given length.'],
  TOCOL: ['array, [ignore], [scan_by_column]', 'Flattens an array into one column (ignore: 1 blanks, 2 errors, 3 both).'],
  TOROW: ['array, [ignore], [scan_by_column]', 'Flattens an array into one row.'],
  RANDARRAY: ['[rows], [columns], [min], [max], [whole_number]', 'An array of random numbers.'],
  AVERAGEA: ['value1, [value2], ...', 'Average, counting text as 0 and TRUE as 1.'],
  DEVSQ: ['number1, [number2], ...', 'Sum of squared deviations from the mean.'],
  SKEW: ['number1, [number2], ...', 'Skewness of a distribution.'],
  KURT: ['number1, [number2], ...', 'Kurtosis of a distribution.'],
  TRIMMEAN: ['range, fraction', 'Mean after dropping a fraction of the extremes.'],
  STANDARDIZE: ['x, mean, standard_deviation', 'The z-score of a value.'],
  FREQUENCY: ['data, bins', 'How many values fall into each bin.'],
  TREND: ['known_y, [known_x], [new_x], [const]', 'Values along the least-squares line.'],
  GROWTH: ['known_y, [known_x], [new_x], [const]', 'Values along the fitted exponential curve.'],
  LINEST: ['known_y, [known_x], [const], [stats]', 'Slope and intercept of the least-squares line, with its statistics when asked.'],
  LOGEST: ['known_y, [known_x], [const], [stats]', 'Base and constant of the fitted exponential curve, with its statistics when asked.'],
  STEYX: ['known_y, known_x', 'Standard error of the predicted y.'],
  'NORM.DIST': ['x, mean, standard_deviation, cumulative', 'Normal distribution.'],
  'NORM.INV': ['probability, mean, standard_deviation', 'Inverse of the normal distribution.'],
  'NORM.S.DIST': ['z, [cumulative]', 'Standard normal distribution.'],
  'NORM.S.INV': ['probability', 'Inverse of the standard normal distribution.'],
  'BINOM.DIST': ['successes, trials, probability, cumulative', 'Binomial distribution.'],
  'POISSON.DIST': ['x, mean, cumulative', 'Poisson distribution.'],
  'EXPON.DIST': ['x, lambda, cumulative', 'Exponential distribution.'],
  'T.DIST': ['x, degrees_freedom, cumulative', 'Student t distribution (left tail).'],
  'T.INV': ['probability, degrees_freedom', 'Inverse of the left-tailed t distribution.'],
  'T.TEST': ['range1, range2, tails, type', 'Probability from a t-test: type 1 paired, 2 equal variance, 3 unequal.'],
  'CHISQ.DIST': ['x, degrees_freedom, cumulative', 'Chi-squared distribution.'],
  'CHISQ.TEST': ['actual_range, expected_range', 'Probability from a chi-squared test of independence.'],
  'F.DIST': ['x, degrees_freedom1, degrees_freedom2, cumulative', 'F distribution.'],
  'CONFIDENCE.NORM': ['alpha, standard_deviation, size', 'Half-width of a confidence interval for a mean.'],
  'CEILING.MATH': ['number, [significance], [mode]', 'Rounds up to a multiple; mode 1 rounds negatives away from zero.'],
  'FLOOR.MATH': ['number, [significance], [mode]', 'Rounds down to a multiple; mode 1 rounds negatives toward zero.'],
  MMULT: ['array1, array2', 'Matrix product.'],
  MINVERSE: ['array', 'Inverse of a square matrix.'],
  MDETERM: ['array', 'Determinant of a square matrix.'],
  MUNIT: ['size', 'The identity matrix.'],
  BASE: ['number, radix, [min_length]', 'A number as text in another base.'],
  DECIMAL: ['text, radix', 'Text in a base back to a number.'],
  DEC2BIN: ['number, [places]', 'Decimal to binary.'],
  DEC2HEX: ['number, [places]', 'Decimal to hexadecimal.'],
  BIN2DEC: ['number', 'Binary to decimal.'],
  HEX2DEC: ['number', 'Hexadecimal to decimal.'],
  ROMAN: ['number, [form]', 'A number as Roman numerals; form 0 or TRUE is classic, 1 to 3 more concise, 4 or FALSE simplified.'],
  ARABIC: ['text', 'Roman numerals back to a number.'],
  CONVERT: ['number, from_unit, to_unit', 'Converts between units: "mi" to "km", "lbm" to "kg", "F" to "C", ...'],
  BITAND: ['number1, number2', 'Bitwise AND.'],
  DELTA: ['number1, [number2]', '1 when two numbers are equal, else 0.'],
  GESTEP: ['number, [step]', '1 when a number is at least the step, else 0.'],
  SERIESSUM: ['x, n, m, coefficients', 'Sum of a power series.'],
  DB: ['cost, salvage, life, period, [month]', 'Fixed-declining-balance depreciation for a period.'],
  VDB: ['cost, salvage, life, start_period, end_period, [factor], [no_switch]', 'Declining-balance depreciation between two periods.'],
  CUMIPMT: ['rate, periods, present_value, start_period, end_period, type', 'Interest paid between two periods.'],
  CUMPRINC: ['rate, periods, present_value, start_period, end_period, type', 'Principal paid between two periods.'],
  ISPMT: ['rate, period, periods, present_value', 'Interest for a period of an even-principal loan.'],
  MIRR: ['cashflows, finance_rate, reinvest_rate', 'Modified internal rate of return.'],
  PDURATION: ['rate, present_value, future_value', 'Periods needed to reach a value.'],
  RRI: ['periods, present_value, future_value', 'Equivalent interest rate for growth.'],
  FVSCHEDULE: ['principal, rates', 'Future value under a schedule of rates.'],
  DOLLARDE: ['fractional_price, fraction', 'A fractional price (like 1.02 for 1 2/16) as a decimal.'],
  DOLLARFR: ['decimal_price, fraction', 'A decimal price as a fractional one.'],
  ISNONTEXT: ['value', 'TRUE when a value is not text.'],
  ISREF: ['value', 'TRUE when the argument is a reference.'],
  ISEMAIL: ['value', 'TRUE for text that looks like an email address.'],
  ISURL: ['value', 'TRUE for text that looks like a web address.'],
  ISBETWEEN: ['value, lower, upper, [lower_inclusive], [upper_inclusive]', 'TRUE when a value lies between two others.'],
  ENCODEURL: ['text', 'Escapes text for use in a URL.'],
  ARRAYTOTEXT: ['array, [format]', 'An array as text; format 1 keeps braces and quotes.'],
  VALUETOTEXT: ['value, [format]', 'Any value as text.'],
  CELL: ['info_type, [reference]', '"address", "row", "col", "contents", or "type" of a cell.'],
  ARRAY_CONSTRAIN: ['array, rows, columns', 'The top-left part of an array.'],
  'NETWORKDAYS.INTL': ['start_date, end_date, [weekend], [holidays]', 'Working days with a custom weekend (1-17 or "0000011").'],
  'WORKDAY.INTL': ['start_date, days, [weekend], [holidays]', 'A working-days offset with a custom weekend.'],
  EPOCHTODATE: ['timestamp, [unit]', 'A Unix timestamp (seconds, 2 = ms, 3 = µs) as a date.'],
  DSUM: ['database, field, criteria', 'Sum of a column over the rows that match a criteria table.'],
  DAVERAGE: ['database, field, criteria', 'Average of a column over matching rows.'],
  DCOUNT: ['database, [field], criteria', 'How many matching rows hold a number in the column.'],
  DCOUNTA: ['database, [field], criteria', 'How many matching rows are not empty in the column.'],
  DMAX: ['database, field, criteria', 'Largest value of a column over matching rows.'],
  DMIN: ['database, field, criteria', 'Smallest value of a column over matching rows.'],
  DGET: ['database, field, criteria', 'The single value that matches; #NUM! when several do.'],
  DPRODUCT: ['database, field, criteria', 'Product of a column over matching rows.'],
  DSTDEV: ['database, field, criteria', 'Sample standard deviation over matching rows.'],
  DVAR: ['database, field, criteria', 'Sample variance over matching rows.'],
  IMAGE: ['url, [mode or alt_text], [sizing]', 'Shows a picture in the cell: mode 1 fits, 2 stretches, 3 keeps the original size. With alt text second, sizing 0 fits, 1 fills, 2 keeps the original size.'],
  SUBTOTAL: ['function_code, range1, ...', 'Aggregates visible rows only: 9 = SUM, 1 = AVERAGE, 3 = COUNTA, 109 also skips hidden rows.'],
};

export function signatureFor(name) {
  const [params, description] = SIGNATURES[name] || ['...', ''];
  return { name, params, description };
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
