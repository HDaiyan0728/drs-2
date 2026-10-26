'use strict';
/* UI smoke test: loads the real index.html in jsdom with the real SheetJS, ExcelJS, engine and report scripts. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const XLSX = require('xlsx');
const ExcelJS = require('exceljs');
const { DOMAINS, buildCase } = require('./fixtures/benchmark');

const root = path.join(__dirname, '..');
function page() {
  let html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const inline = f => `<script>${fs.readFileSync(f, 'utf8').replace(/<\/script/gi, '<\\/script')}</script>`;
  html = html
    .replace(/<script src="https:\/\/cdnjs[^"]*xlsx[^"]*"><\/script>/, () => inline(require.resolve('xlsx/dist/xlsx.full.min.js')))
    .replace(/<script src="https:\/\/cdnjs[^"]*Chart[^"]*"><\/script>/, '<script>window.Chart = function(){ return { destroy(){} }; };</script>')
    .replace(/<script src="https:\/\/cdnjs[^"]*exceljs[^"]*"><\/script>/, () => inline(require.resolve('exceljs/dist/exceljs.min.js')))
    .replace('<script src="./engine.js"></script>', () => inline(path.join(root, 'engine.js')))
    .replace('<script src="./report.js"></script>', () => inline(path.join(root, 'report.js')));
  const errors = [];
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/' });
  dom.window.addEventListener('error', e => errors.push(e.error || e.message));
  dom.window.URL.createObjectURL = () => 'blob:x'; dom.window.URL.revokeObjectURL = () => {};
  dom.window.HTMLAnchorElement.prototype.click = function () { dom.window.__downloads = (dom.window.__downloads || []).concat(this.download); };
  return { dom, w: dom.window, d: dom.window.document, errors };
}
function xlsxBytes(sheets) {
  const wb = XLSX.utils.book_new();
  Object.entries(sheets).forEach(([n, c]) => XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(c.rows, { header: c.headers }), n));
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));
}

test('end to end: two workbooks, several sheets, suggested pairs, review, reports', async () => {
  const { w, d, errors } = page();
  const cust = buildCase(DOMAINS.find(x => x.id === 'customers'), { seed: 3, conflictRate: 0.1 });
  const ord = buildCase(DOMAINS.find(x => x.id === 'orders'), { seed: 4 });
  const fleet = buildCase(DOMAINS.find(x => x.id === 'fleet'), { seed: 5 });
  await w.Studio.addWorkbook('A', 'Client_Data.xlsx', xlsxBytes({ Customers: cust.source, Orders: ord.source, Fleet: fleet.source }));
  await w.Studio.addWorkbook('B', 'System_Export.xlsx', xlsxBytes({ Order_Lines: ord.compare, Customer_Master: cust.compare, Notes: { headers: ['Remark'], rows: [] } }));
  const S = w.Studio.state;
  assert.equal(S.files.A[0].sheets.length, 3);
  // suggested: Customers↔Customer_Master, Orders↔Order_Lines; Fleet stays unpaired (nothing similar)
  const label = uid => { const s = S.files.A.concat(S.files.B).flatMap(f => f.sheets).find(x => x.uid === uid); return s.name; };
  assert.deepEqual(Array.from(S.pairs, p => label(p.src) + '>' + label(p.cmp)).sort(), ['Customers>Customer_Master', 'Orders>Order_Lines']);
  assert.match(d.querySelector('#plan').textContent, /left unpaired/);
  await w.Studio.runAll();
  assert.equal(S.comps.length, 2);
  assert.equal(S.view, 'overview');
  assert.ok(d.querySelector('#panel').textContent.includes('Customer_Master'));
  // every comparison independent with its own key
  S.comps.forEach(c => assert.ok(c.res && c.key, c.id + ' ran'));
  assert.notEqual(S.comps[0].res.summary.keyLabelA, S.comps[1].res.summary.keyLabelA);
  // open each tab of the first comparison without errors
  w.Studio.openComp(0, 'overview');
  for (const tab of ['mapping', 'missing', 'mismatch', 'records', 'quality']) { S.tab = tab; w.Studio.render(); assert.ok(d.querySelector('#panel').innerHTML.length > 100, tab); }
  // accept any proposals in comparison 1 via the UI and re-run
  S.tab = 'mapping'; w.Studio.render();
  const boxes = Array.from(d.querySelectorAll('input[data-accept]'));
  boxes.forEach(b => { b.checked = true; b.dispatchEvent(new w.Event('change', { bubbles: true })); });
  d.querySelector('#applyMap').click();
  // manual override via select: map "Field 7" to nothing
  // reports
  const model = w.Studio.buildModel();
  assert.equal(model.comparisons.length, 2);
  model.comparisons.forEach(c => c.discrepancies.forEach(x => assert.ok(x.sourceFile && x.compareSheet && x.sourceRow && x.compareRow)));
  const buf = await w.Studio.buildWorkbook().xlsx.writeBuffer();
  const back = new ExcelJS.Workbook(); await back.xlsx.load(buf);
  assert.ok(back.getWorksheet('Value Discrepancies'));
  const html = w.Studio.buildHtml();
  assert.ok(html.includes('System_Export.xlsx') && html.includes('Order_Lines'));
  S.view = 'reports'; w.Studio.render();
  assert.ok(d.querySelector('#dlHtml'));
  assert.equal(errors.length, 0, String(errors));
});

test('scenario C: every source sheet against one comparison sheet via the plan builder', async () => {
  const { w, d, errors } = page();
  const c = buildCase(DOMAINS.find(x => x.id === 'customers'), { seed: 8 });
  const half = n => ({ headers: c.source.headers, rows: c.source.rows.slice(n * 100, n * 100 + 100) });
  for (const n of [0, 1, 2]) await w.Studio.addWorkbook('A', `Source_${'ABC'[n]}.xlsx`, xlsxBytes({ Sheet1: half(n) }));
  await w.Studio.addWorkbook('B', 'Comparison.xlsx', xlsxBytes({ Master: c.compare }));
  const S = w.Studio.state;
  S.pairs = []; w.Studio.suggestPairs();
  const sel = d.querySelector('#manyToOne'); sel.value = S.files.B[0].sheets[0].uid;
  d.querySelector('#manyToOneBtn').click();
  assert.equal(S.pairs.length, 3);
  await w.Studio.runAll();
  assert.deepEqual(Array.from(S.comps, x => x.src.file), ['Source_A.xlsx', 'Source_B.xlsx', 'Source_C.xlsx']);
  S.comps.forEach(x => assert.equal(x.res.summary.rowsA, 100));
  assert.equal(errors.length, 0, String(errors));
});
