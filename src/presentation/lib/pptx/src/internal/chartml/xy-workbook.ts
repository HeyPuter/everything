// Worksheet layout for XY (scatter / bubble) chart data. The chart's
// `<c:xVal>` / `<c:yVal>` / `<c:bubbleSize>` formulas and the embedded
// workbook cells come from the same plan so they always agree.
//
// Series that share identical X values share one X column (column A), as
// spreadsheet users lay such data out; otherwise every series carries its
// own X column. Each series then has a Y column headed by its name, and a
// bubble series a size column after it.

import type { ChartSpec } from "./types.ts";
import type { DataColumn } from "./embedded-xlsx.ts";

export interface XYSeriesColumns {
  /** Column of the X values, or null when the series has none. */
  readonly x: number | null;
  readonly y: number;
  /** Column of the bubble sizes (bubble charts only). */
  readonly size: number | null;
}

export interface XYWorkbookPlan {
  readonly series: ReadonlyArray<XYSeriesColumns>;
  readonly columns: ReadonlyArray<DataColumn>;
}

export const isXYChartKind = (kind: string): kind is "scatter" | "bubble" =>
  kind === "scatter" || kind === "bubble";

const sameValues = (
  a: ReadonlyArray<number | null> | undefined,
  b: ReadonlyArray<number | null> | undefined,
): boolean =>
  a === b ||
  (a !== undefined &&
    b !== undefined &&
    a.length === b.length &&
    a.every((v, i) => (v ?? null) === (b[i] ?? null)));

export const xyWorkbookPlan = (spec: ChartSpec): XYWorkbookPlan => {
  const bubble = spec.kind === "bubble";
  const first = spec.series[0]?.xValues;
  const shared =
    first !== undefined &&
    spec.series.every((series) => sameValues(series.xValues, first));
  const columns: DataColumn[] = [];
  const add = (column: DataColumn): number => columns.push(column) - 1;
  const sharedX = shared
    ? add({
        header: "X",
        values: first,
        ...(spec.series[0]?.xNumberFormat !== undefined
          ? { numberFormat: spec.series[0].xNumberFormat }
          : {}),
      })
    : null;
  const series = spec.series.map((model) => {
    const x =
      sharedX ??
      (model.xValues !== undefined
        ? add({
            header: `${model.name} X`,
            values: model.xValues,
            ...(model.xNumberFormat !== undefined
              ? { numberFormat: model.xNumberFormat }
              : {}),
          })
        : null);
    const y = add({
      header: model.name,
      values: model.values,
      ...(model.numberFormat !== undefined
        ? { numberFormat: model.numberFormat }
        : {}),
    });
    const size = bubble
      ? add({
          header: `${model.name} size`,
          values: model.bubbleSizes ?? [],
          ...(model.bubbleSizeNumberFormat !== undefined
            ? { numberFormat: model.bubbleSizeNumberFormat }
            : {}),
        })
      : null;
    return { x, y, size };
  });
  return { series, columns };
};
