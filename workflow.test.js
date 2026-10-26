'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const ExcelJS = require('exceljs');
const R = require('../engine.js');
const Report = require('../report.js');

/* Write a workbook to bytes and read it back exactly as the browser does (cellDates, dense). */
function workbook(sheets) {
  const wb = XLSX.utils.book_new();
  Object.entries(sheets).forEach(([name, aoa]) => XLSX.utils.book_append_sheet(wb, aoa === null ? {} : XLSX.utils.aoa_to_sheet(aoa), name));
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  return XLSX.read(buf, { type: 'buffer', cellDates: true, dense: true });
}
function sheet(wb, file, name) {
  const t = R.readSheet(XLSX, wb.Sheets[name]);
  return Object.assign(t, { file, sheet: name, name: file, sheetName: name });
}
/* Mirrors the UI: one independent comparison per configured pair */
function runPair(src, cmp, opts) {
  const P = { A: R.prepareFile(src), B: R.prepareFile(cmp) };
  const run = R.runReconciliation(P.A, P.B, opts);
  return { id: opts && opts.id, source: { file: src.file, sheet: src.sheet, headerRow: src.headerRow }, compare: { file: cmp.file, sheet: cmp.sheet, headerRow: cmp.headerRow },
    P, key: run.key, keyAuto: !!run.key, sug: run.suggestion, res: run.result, error: run.error, warnings: (src.warnings || []).concat(cmp.warnings || []) };
}

const CUSTOMERS = [['Customer ID', 'Customer Name', 'Date of Birth', 'Credit Limit'],
  ['C1', 'Amina Rahman', new Date(1990, 4, 17), 5000], ['C2', 'John Smith', new Date(1985, 0, 2), 12000],
  ['C3', 'Wei Chen', new Date(2001, 11, 31), 750], ['C4', 'Sadia Khan', new Date(1979, 6, 9), 0]];

test('header detection, blank rows and Excel row numbers', () => {
  const wb = workbook({ Data: [['Client extract — October'], [], ...CUSTOMERS.slice(0, 3), [], ...CUSTOMERS.slice(3)] });
  const t = sheet(wb, 'Client.xlsx', 'Data');
  assert.equal(t.headerRow, 3);
  assert.deepEqual(t.rows.map(r => r.__row), [4, 5, 7, 8]);   // the blank row 6 does not shift numbering
});

test('empty sheets, duplicate headers and missing headers are reported, not fatal', () => {
  const wb = workbook({ Empty: null, Dupes: [['ID', 'Amount', 'Amount', null], [1, 2, 3, 4]] });
  const e = sheet(wb, 'x.xlsx', 'Empty');
  assert.ok(e.empty);
  const d = sheet(wb, 'x.xlsx', 'Dupes');
  assert.deepEqual(d.headers, ['ID', 'Amount', 'Amount (2)', 'Column 4']);
  assert.ok(d.warnings.some(w => /Duplicate/.test(w)) && d.warnings.some(w => /no header/.test(w)));
});

test('sheet pairing suggestions: clear one-to-one only, never unrelated sheets', () => {
  const src = [
    { id: 's1', headers: ['Customer ID', 'Customer Name', 'Date of Birth', 'Credit Limit'] },
    { id: 's2', headers: ['Order No', 'Order Date', 'Qty', 'Unit Price'] },
    { id: 's3', headers: ['Vehicle', 'Fuel Type', 'Odometer'] }];
  const cmp = [
    { id: 'c1', headers: ['order_number', 'OrderDate', 'Quantity', 'Price Per Unit', 'Tax'] },
    { id: 'c2', headers: ['customer_id', 'Name of Customer', 'Birth Date', 'Credit Lmt'] },
    { id: 'c3', headers: ['Invoice', 'Supplier', 'Amount'] }];
  const { pairs } = R.suggestSheetPairs(src, cmp);
  const m = Object.fromEntries(pairs.map(p => [p.sourceId, p.compareId]));
  assert.equal(m.s1, 'c2'); assert.equal(m.s2, 'c1');
  assert.equal(m.s3, undefined, 'vehicles must not be paired with invoices');
});

test('scenario C/D: many-to-one and one-to-many produce independent results with their own identity', () => {
  const sys = workbook({ Customer_Master: [['customer_id', 'Name of Customer', 'Birth Date', 'Credit Lmt'],
    ['C1', 'Amina Rahman', '1990-05-17', '5,000'], ['C2', 'John Smith', '02/01/1985', 12000], ['C3', 'Wei Chen', new Date(2001, 11, 31), 900], ['C9', 'Extra Person', null, 1]] });
  const a = workbook({ Customers: CUSTOMERS });
  const b = workbook({ Customers: [CUSTOMERS[0], CUSTOMERS[1], ['C5', 'Liam Brown', new Date(1999, 1, 1), 10]] });
  const target = sheet(sys, 'System_Export.xlsx', 'Customer_Master');
  const r1 = runPair(sheet(a, 'Client_A.xlsx', 'Customers'), target, { id: 'C1' });
  const r2 = runPair(sheet(b, 'Client_B.xlsx', 'Customers'), target, { id: 'C2' });
  assert.equal(r1.res.summary.matched, 3); assert.equal(r1.res.summary.sourceOnly, 1); assert.equal(r1.res.summary.dbOnly, 1);
  assert.equal(r2.res.summary.matched, 1); assert.equal(r2.res.summary.sourceOnly, 1); assert.equal(r2.res.summary.dbOnly, 3);
  // C3 credit limit 750 vs 900 is the only real conflict in run 1; 5000 vs "5,000" and dates are formatting only
  const conflicts = r1.res.issues.filter(i => i.status === 'mismatch');
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].key, 'c3'); assert.equal(conflicts[0].keyValue, 'C3'); assert.equal(conflicts[0].sourceRow, 4); assert.equal(conflicts[0].compareRow, 4);
  // dd/mm vs mm/dd: "02/01/1985" is ambiguous in a column with no day > 12, so it is flagged, not silently accepted
  const amb = r1.res.issues.filter(i => i.status === 'uncomparable');
  assert.equal(amb.length, 1); assert.equal(amb[0].key, 'c2');
});

test('reports: every discrepancy is traceable; Excel and HTML agree; dates are not shifted', async () => {
  const sys = workbook({ Customer_Master: [['Account Identifier', 'Name of Customer', 'Birth Date', 'Credit Lmt'],
    ['C1', 'Amina Rahman', new Date(1990, 4, 17), 5000], ['C2', 'Jon Smith', new Date(1985, 0, 3), 12000], ['C3', 'Wei Chen', new Date(2001, 11, 31), 750]] });
  const cli = workbook({ Customers: [['Client Reference', 'Customer Name', 'Date of Birth', 'Credit Limit'], ...CUSTOMERS.slice(1)] });
  const comps = [runPair(sheet(cli, 'Client_Data.xlsx', 'Customers'), sheet(sys, 'System_Export.xlsx', 'Customer_Master'), { id: 'C1' })];
  const model = Report.buildModel({ comparisons: comps, generatedAt: new Date(2026, 9, 26, 10, 0) });
  const c = model.comparisons[0];
  assert.equal(c.key.source, 'Client Reference'); assert.equal(c.key.compare, 'Account Identifier');
  assert.ok(c.discrepancies.length >= 2);
  for (const d of c.discrepancies) {
    for (const f of ['sourceFile', 'sourceSheet', 'compareFile', 'compareSheet', 'sourceColumn', 'compareColumn', 'sourceRow', 'compareRow', 'issue', 'reason', 'key'])
      assert.ok(d[f] !== undefined && d[f] !== null && d[f] !== '', `${f} missing in ${JSON.stringify(d)}`);
  }
  const dob = c.discrepancies.find(d => d.compareColumn === 'Birth Date');
  assert.equal(R.displayValue(dob.sourceValue), '1985-01-02'); assert.equal(R.displayValue(dob.compareValue), '1985-01-03');

  // Excel: read it back
  const wb = Report.buildWorkbook(model, ExcelJS, { comparisons: comps });
  const buf = await wb.xlsx.writeBuffer();
  const back = new ExcelJS.Workbook(); await back.xlsx.load(buf);
  assert.deepEqual(back.worksheets.map(w => w.name), ['Summary', 'Comparisons', 'Column Mapping', 'Unmatched Columns', 'Value Discrepancies', 'Missing Records', 'Extra Records', 'C1 Records'].filter(n => back.getWorksheet(n)));
  assert.ok(!back.getWorksheet('Errors & Warnings') || back.getWorksheet('Errors & Warnings').rowCount > 1, 'no empty sections');
  const vd = back.getWorksheet('Value Discrepancies');
  const hdr = vd.getRow(1).values.slice(1);
  ['Source file', 'Source worksheet', 'Source row', 'Source column', 'Comparison file', 'Comparison worksheet', 'Comparison row', 'Comparison column', 'Source value (original)', 'Comparison value (original)', 'Reason'].forEach(h => assert.ok(hdr.includes(h), h));
  assert.equal(vd.rowCount - 1, c.discrepancies.length);
  const col = h => hdr.indexOf(h) + 1;
  let found = false;
  vd.eachRow((row, n) => {
    if (n === 1 || row.getCell(col('Comparison column')).value !== 'Birth Date') return;
    found = true;
    const v = row.getCell(col('Comparison value (original)')).value;
    assert.ok(v instanceof Date);
    assert.equal(v.toISOString().slice(0, 10), '1985-01-03', 'Excel shows the same calendar day as the source file');
    assert.equal(row.getCell(col('Source file')).value, 'Client_Data.xlsx');
    assert.equal(row.getCell(col('Comparison worksheet')).value, 'Customer_Master');
  });
  assert.ok(found);

  // HTML: self-contained, escaped, carries traceability
  const html = Report.buildHtml(model);
  assert.ok(!/<script[^>]+src=/i.test(html) && !/<link[^>]+href=/i.test(html), 'no external resources');
  ['Client_Data.xlsx', 'System_Export.xlsx', 'Customer_Master', 'Customers', 'Client Reference', 'Account Identifier'].forEach(s => assert.ok(html.includes(s), s));
  const data = JSON.parse(html.match(/<script type="application\/json" id="report-data">([\s\S]*?)<\/script>/)[1]);
  assert.equal(data.discrepancies.length, c.discrepancies.length);
});

test('HTML report escapes hostile cell values and file names', () => {
  const evil = '</script><img src=x onerror=alert(1)>';
  const a = { file: evil + '.xlsx', sheet: 'S', headerRow: 1, headers: ['ID', 'Note'], rows: [{ ID: 1, Note: evil }, { ID: 2, Note: 'b' }], name: 'a', sheetName: 'S' };
  const b = { file: 'b.xlsx', sheet: 'S', headerRow: 1, headers: ['ID', 'Note'], rows: [{ ID: 1, Note: 'x' }, { ID: 2, Note: 'b' }], name: 'b', sheetName: 'S' };
  const comp = runPair(a, b, { id: 'C1', key: { aId: 'ID', bId: 'ID' } });
  const html = Report.buildHtml(Report.buildModel({ comparisons: [comp] }));
  assert.ok(!html.includes('<img src=x'));
  assert.equal((html.match(/<\/script>/g) || []).length, 2, 'only the two real closing script tags');
});

test('a comparison without a usable key is reported as "Not run", not as passed', () => {
  const a = { file: 'a.xlsx', sheet: 'S', headers: ['Name'], rows: [{ Name: 'x' }, { Name: 'y' }] };
  const b = { file: 'b.xlsx', sheet: 'T', headers: ['Other'], rows: [{ Other: 1 }] };
  const comp = runPair(a, b, { id: 'C1' });
  const model = Report.buildModel({ comparisons: [comp] });
  assert.equal(model.comparisons[0].status, 'Not run');
  assert.equal(model.status, 'REVIEW');
  assert.ok(model.errors.some(e => e.level === 'Error'));
});
