import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { encodeDataModelBytes } from '../src/core/data-model.js';
import { modelArchive, modelLoad } from './helpers/data-model-fixture.js';

// In DAX a measure's name belongs to the whole model: a measure on Products may use [Total] defined on Orders.
// The app looked [Total] up among the Products measures alone and failed with "Missing model measure Total".
const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const X15 = 'http://schemas.microsoft.com/office/spreadsheetml/2010/11/main';
const dim = (t, col) => modelLoad('Dimension', `<ID>${t}</ID><Name>${t}</Name><Attributes><Attribute><ID>${col}</ID><Name>${col}</Name><KeyColumns><KeyColumn><DataType>BigInt</DataType></KeyColumn></KeyColumns></Attribute></Attributes>`);
const conn = (id, n, src) => `<connection id="${n}" name="B${id}" type="102"><extLst><ext><x:connection id="${id}"><x:rangePr sourceName="${src}"/></x:connection></ext></extLst></connection>`;

it('finds a measure of another table by its name alone', async () => {
  const archive = modelArchive([
    { path: 'orders.dim.xml', xml: dim('Orders', 'Net') },
    { path: 'products.dim.xml', xml: dim('Products', 'Price') },
    { path: 'formulas.scr.xml', xml: modelLoad('MdxScript', `<Commands><Command><Text>CREATE MEASURE [Model].Orders[Total] = SUM(Orders[Net]);
CREATE MEASURE [Model].Products[Ratio] = DIVIDE([Total], SUM(Products[Price]));
CREATE MEASURE [Model].Orders[Half] = DIVIDE([Ratio], 2);</Text></Command></Commands>`) },
  ]);
  const wb = new Workbook({ dataModel: { version: 1, archive: encodeDataModelBytes(archive),
    modelXml: `<x:dataModel xmlns:x="${X15}"><x:modelTables><x:modelTable id="Orders" name="Orders" connection="BOrders"/><x:modelTable id="Products" name="Products" connection="BProducts"/></x:modelTables></x:dataModel>`,
    connectionsXml: `<connections xmlns="${MAIN}" xmlns:x="${X15}">${conn('Orders', 1, 'OrdersSrc')}${conn('Products', 2, 'ProductsSrc')}</connections>` },
  names: [{ name: 'OrdersSrc', ref: 'Input!$A$1:$A$3' }, { name: 'ProductsSrc', ref: 'Input!$C$1:$C$3' }],
  sheets: [{ name: 'Input', cells: { '0,0': { v: 'Net' }, '1,0': { v: 6 }, '2,0': { v: 4 }, '0,2': { v: 'Price' }, '1,2': { v: 2 }, '2,2': { v: 3 } } }] });
  expect(await wb.evaluateModelMeasure('Orders', 'Total')).toBe(10);
  expect(await wb.evaluateModelMeasure('Products', 'Ratio')).toBe(2);
  expect(await wb.evaluateModelMeasure('Orders', 'Half')).toBe(1);
  await expect(wb.evaluateModelMeasure('Products', 'Nowhere')).rejects.toThrow(/Nowhere/);
});
