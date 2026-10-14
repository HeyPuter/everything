// internal/chartml — c: namespace: charts + minimal xlsx writer for embedded data.
// Allowed imports: internal/drawingml, internal/parts, internal/xml.

export type {
  ChartAxisCrossing,
  ChartAxisTickLabelPosition,
  ChartAxisScaling,
  ChartDataLabelPosition,
  ChartDataLabels,
  ChartDataTable,
  ChartErrorBars,
  ChartGrouping,
  ChartKind,
  ChartSeries,
  ChartSpec,
  ChartTextStyle,
  ChartTrendline,
} from "./types.ts";
export { buildChartSpaceDoc } from "./chart-builder.ts";
export { readChartSpec } from "./chart-reader.ts";
export type { DataColumn, DataRow } from "./embedded-xlsx.ts";
export {
  buildEmbeddedXlsx,
  buildEmbeddedXlsxColumns,
  cellAddr,
  cellRange,
} from "./embedded-xlsx.ts";
