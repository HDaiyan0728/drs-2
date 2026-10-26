/* Report builder — turns engine results into a plain report model, an Excel workbook (ExcelJS)
 * and a self-contained HTML report. No DOM access; works in browsers (window.ReconReport) and Node. */
(function (root) {
  'use strict';
  const R = (typeof module !== 'undefined' && module.exports) ? require('./engine.js') : root.Reconcile;

  const LIMITS = { htmlDiscrepancies: 25000, htmlRecords: 10000, excelRows: 1000000, matchedSheets: 12, matchedRowsPerSheet: 100000, previewCols: 10 };
  const ISSUE_LEVEL = { 'Value conflict': 'bad', 'Placeholder in comparison': 'bad', 'Garbled text': 'bad', 'Cannot compare reliably': 'warn', 'Blank in comparison': 'warn', 'Blank in source': 'warn' };

  const disp = v => R.displayValue(v);
  function preview(F, row, skipId) {
    return F.cols.filter(c => !c.virtual && c.id !== skipId).slice(0, LIMITS.previewCols)
      .map(c => { const v = disp(c.get(row)); return v === '' ? null : `${c.label}: ${v}`; }).filter(Boolean).join(' | ');
  }

  /*
   * comparison (from the UI or tests):
   * { id, source:{file, sheet, headerRow}, compare:{file, sheet, headerRow}, P:{A,B}, key, keyAuto, sug, res, error?, warnings?, mappingUsed? }
   */
  function comparisonModel(c, index) {
    const id = c.id || ('C' + (index + 1));
    const base = {
      id, label: c.label || `${c.source.file} › ${c.source.sheet}  ↔  ${c.compare.file} › ${c.compare.sheet}`,
      sourceFile: c.source.file, sourceSheet: c.source.sheet, compareFile: c.compare.file, compareSheet: c.compare.sheet,
      sourceHeaderRow: c.source.headerRow || null, compareHeaderRow: c.compare.headerRow || null,
      warnings: (c.warnings || []).slice(), mapping: [], unmatchedSource: [], unmatchedCompare: [], discrepancies: [], missing: [], extra: [], duplicates: []
    };
    const P = c.P, res = c.res;
    if (!P || !res || !c.key) {
      base.status = 'Not run'; base.level = 'warn';
      base.error = c.error || 'No matching key column was selected, so records could not be compared.';
      if (P && c.sug) addMapping(base, c, P);
      return base;
    }
    const { A, B } = P, s = res.summary;
    base.key = { source: s.keyLabelA, compare: s.keyLabelB, detected: !!c.keyAuto };
    base.summary = s;
    addMapping(base, c, P);
    // Discrepancies with full traceability
    res.issues.forEach(i => base.discrepancies.push({
      comparison: id, key: i.keyValue || i.key, sourceFile: c.source.file, sourceSheet: c.source.sheet, compareFile: c.compare.file, compareSheet: c.compare.sheet,
      sourceColumn: i.sourceColumn, compareColumn: i.column, sourceRow: i.sourceRow, compareRow: i.compareRow,
      sourceValue: i.src, compareValue: i.db, issue: i.issue, reason: i.why, level: ISSUE_LEVEL[i.issue] || 'warn'
    }));
    const keyA = A.colsById[res.key.aId], keyB = B.colsById[res.key.bId];
    res.sourceOnly.forEach(ix => { const row = A.rows[ix]; base.missing.push({ comparison: id, key: disp(keyA.get(row)), file: c.source.file, sheet: c.source.sheet, row: R.rowNumberOf(row, ix), preview: preview(A, row, keyA.id) }); });
    res.dbOnly.forEach(ix => { const row = B.rows[ix]; base.extra.push({ comparison: id, key: disp(keyB.get(row)), file: c.compare.file, sheet: c.compare.sheet, row: R.rowNumberOf(row, ix), preview: preview(B, row, keyB.id) }); });
    const blankWarn = (list, F, keyCol, side) => {
      if (!list.length) return;
      const rowsTxt = list.slice(0, 20).map(ix => R.rowNumberOf(F.rows[ix], ix)).join(', ') + (list.length > 20 ? ', …' : '');
      base.warnings.push(`${list.length} ${side} row(s) have a blank key (${keyCol.label}) and were not compared: Excel row ${rowsTxt}.`);
    };
    blankWarn(res.blankKeyA, A, keyA, 'source');
    blankWarn(res.blankKeyB, B, keyB, 'comparison');
    res.dupB.forEach(d => base.duplicates.push({ comparison: id, side: 'Comparison', file: c.compare.file, sheet: c.compare.sheet, key: d.key, rows: d.rows.map(ix => R.rowNumberOf(B.rows[ix], ix)).join(', '), note: 'Most complete row was used' }));
    res.dupA.forEach(d => base.duplicates.push({ comparison: id, side: 'Source', file: c.source.file, sheet: c.source.sheet, key: d.key, rows: d.rows.map(ix => R.rowNumberOf(A.rows[ix], ix)).join(', '), note: 'Each source row was compared' }));
    const counts = {};
    base.discrepancies.forEach(d => { counts[d.issue] = (counts[d.issue] || 0) + 1; });
    base.issueCounts = counts;
    const pending = base.mapping.filter(m => m.tier === 'medium' && !m.used).length;
    const unresolved = base.unmatchedCompare.length;
    const hardIssues = s.sourceOnly + s.dbOnly + s.conflicts + (counts['Garbled text'] || 0) + (counts['Placeholder in comparison'] || 0);
    const softIssues = (counts['Blank in comparison'] || 0) + (counts['Blank in source'] || 0) + s.uncomparable;
    base.status = hardIssues ? 'Discrepancies found' : softIssues || pending || unresolved ? 'Needs attention' : 'Passed';
    base.level = hardIssues ? 'bad' : base.status === 'Passed' ? 'ok' : 'warn';
    base.pendingReview = pending; base.unresolvedColumns = unresolved;
    return base;
  }

  function addMapping(base, c, P) {
    const { A, B } = P;
    const used = new Map((c.res ? c.res.maps : []).map(m => [m.bId, m]));
    const stats = new Map((c.res ? c.res.mapping : []).map(m => [m.bId, m]));
    const decisions = c.sug ? c.sug.decisions : [];
    const decByB = new Map(decisions.map(d => [d.bId, d]));
    const keyB = c.key ? c.key.bId : null;
    if (c.key) base.mapping.push({ compareColumn: B.colsById[c.key.bId].label, sourceColumn: A.colsById[c.key.aId].label, tier: 'key', status: c.keyAuto ? 'Key (detected)' : 'Key (chosen by you)', confidence: 1, method: 'Record identifier', evidence: c.keyReason || 'Values identify the same record in both files', used: true });
    (c.sug ? c.sug.aliases : []).forEach(al => base.mapping.push({ compareColumn: B.colsById[al.bId].label, sourceColumn: A.colsById[al.aId].label, tier: 'alias', status: 'Key alias', confidence: al.value, method: 'Holds the same values as the key', evidence: `${Math.round(al.value * 100)}% identical to the key`, used: false }));
    B.cols.forEach(b => {
      if (b.id === keyB || (c.sug && c.sug.aliases.some(x => x.bId === b.id))) return;
      const m = used.get(b.id), d = decByB.get(b.id), st = stats.get(b.id);
      if (!m && !d) return;
      const aId = m ? m.aId : (d && d.aId);
      const tier = m ? (m.tier || 'manual') : d.tier;
      const status = m ? R.mapStatus(m.conf, m.vs, m.ambiguous, m.tier) : (d.tier === 'medium' ? 'Needs review — not used' : d.tier === 'confirmed' ? 'Confirmed: no counterpart' : R.TIER_LABEL[d.tier]);
      const row = {
        compareColumn: b.label, sourceColumn: aId ? A.colsById[aId].label : null, tier, status,
        confidence: m ? m.conf : (d ? d.conf : null), margin: d && d.margin !== undefined ? d.margin : null,
        competitor: d && d.competitor ? `${d.competitor.label} (${Math.round(d.competitor.conf * 100)}%)` : '',
        method: d && d.nameHow ? d.nameHow : (tier === 'manual' ? 'Chosen by you' : ''),
        evidence: (m && m.reason) || (d && d.reason) || '', used: !!m
      };
      if (st) Object.assign(row, { compared: st.comparable, exact: st.exact, format: st.format, conflicts: st.mismatch, garbled: st.encoding, uncomparable: st.uncomparable, blankCompare: st.blank_compare, blankSource: st.blank_source, agreement: st.quality });
      base.mapping.push(row);
      if (!m) base.unmatchedCompare.push({ side: 'Comparison', file: base.compareFile, sheet: base.compareSheet, column: b.label,
        bestCandidate: d && (d.aId || d.suggestion) ? A.colsById[d.aId || d.suggestion].label : '', confidence: d ? d.conf : null,
        reason: d ? (d.tier === 'medium' ? 'Proposed mapping awaiting review (not used)' : d.tier === 'confirmed' ? 'You confirmed it has no counterpart' : d.reason) : '' });
    });
    const usedA = new Set([...used.values()].map(m => m.aId));
    if (c.key) usedA.add(c.key.aId);
    A.cols.filter(a => !a.virtual && !usedA.has(a.id)).forEach(a => {
      const prop = decisions.find(d => d.aId === a.id);
      base.unmatchedSource.push({ side: 'Source', file: base.sourceFile, sheet: base.sourceSheet, column: a.label, bestCandidate: prop ? B.colsById[prop.bId].label : '', confidence: prop ? prop.conf : null, reason: prop ? 'Proposed mapping awaiting review (not used)' : 'No comparison column matched' });
    });
  }

  /*
   * run: { title?, generatedAt?, comparisons: [...], errors?: [{level, file, sheet, message}], files?: {source:[names], compare:[names]} }
   */
  function buildModel(run) {
    const comps = run.comparisons.map(comparisonModel);
    const sum = f => comps.reduce((t, c) => t + (c.summary ? f(c.summary) : 0), 0);
    const files = run.files || { source: [...new Set(comps.map(c => c.sourceFile))], compare: [...new Set(comps.map(c => c.compareFile))] };
    const sheetsOf = side => new Set(comps.map(c => side === 'source' ? c.sourceFile + '\u0000' + c.sourceSheet : c.compareFile + '\u0000' + c.compareSheet)).size;
    const errors = (run.errors || []).slice();
    comps.forEach(c => {
      if (c.error) errors.push({ level: 'Error', comparison: c.id, file: `${c.sourceFile} / ${c.compareFile}`, sheet: `${c.sourceSheet} / ${c.compareSheet}`, message: c.error });
      c.warnings.forEach(w => errors.push({ level: 'Warning', comparison: c.id, file: `${c.sourceFile} / ${c.compareFile}`, sheet: `${c.sourceSheet} / ${c.compareSheet}`, message: w }));
      if (c.pendingReview) errors.push({ level: 'Warning', comparison: c.id, file: `${c.sourceFile} / ${c.compareFile}`, sheet: `${c.sourceSheet} / ${c.compareSheet}`, message: `${c.pendingReview} proposed column mapping(s) were not reviewed and were excluded from the comparison.` });
    });
    const totals = {
      sourceFiles: files.source.length, compareFiles: files.compare.length, sourceSheets: sheetsOf('source'), compareSheets: sheetsOf('compare'),
      comparisons: comps.length, run: comps.filter(c => c.summary).length, passed: comps.filter(c => c.status === 'Passed').length,
      failed: comps.filter(c => c.status === 'Discrepancies found').length, attention: comps.filter(c => c.status === 'Needs attention' || c.status === 'Not run').length,
      sourceRecords: sum(s => s.rowsA), compareRecords: sum(s => s.rowsB), matched: sum(s => s.matched), missing: sum(s => s.sourceOnly), extra: sum(s => s.dbOnly),
      identical: sum(s => s.recordsEquivalent), withDifferences: sum(s => s.recordsWithIssues),
      discrepancies: comps.reduce((t, c) => t + c.discrepancies.length, 0), conflicts: sum(s => s.conflicts), uncomparable: sum(s => s.uncomparable),
      mappedColumns: comps.reduce((t, c) => t + c.mapping.filter(m => m.used && m.tier !== 'key').length, 0),
      unmatchedColumns: comps.reduce((t, c) => t + c.unmatchedCompare.length + c.unmatchedSource.length, 0),
      pendingReview: comps.reduce((t, c) => t + (c.pendingReview || 0), 0)
    };
    const status = totals.failed ? 'FAIL' : totals.attention ? 'REVIEW' : 'PASS';
    return { title: run.title || 'Data Validation & Reconciliation Report', generatedAt: run.generatedAt || new Date(), engineVersion: R.VERSION, totals, status, comparisons: comps, errors, files };
  }

  // ================= Excel =================
  const FILL = { head: 'FF1E293B', brand: 'FF4F46E5', ok: 'FFDCFCE7', bad: 'FFFEE2E2', warn: 'FFFEF3C7', info: 'FFDBEAFE', grey: 'FFF1F5F9', violet: 'FFEDE9FE',
    exact: 'FFDCFCE7', format: 'FFDBEAFE', mismatch: 'FFFEE2E2', encoding: 'FFFFEDD5', uncomparable: 'FFF3E8FF', blank_compare: 'FFFEF3C7', blank_source: 'FFFEF3C7' };
  /* Excel stores wall-clock dates. ExcelJS converts Date objects using UTC, which would shift
     local dates in UTC+ time zones, so pass a UTC date carrying the local wall-clock components. */
  function xv(v) {
    if (v instanceof Date) { if (isNaN(v.getTime())) return null; return new Date(Date.UTC(v.getFullYear(), v.getMonth(), v.getDate(), v.getHours(), v.getMinutes(), v.getSeconds())); }
    if (v === undefined) return null;
    if (typeof v === 'string' && v.length > 32000) return v.slice(0, 32000) + '…';
    return v;
  }
  const fill = argb => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
  function headerRow(row) {
    row.eachCell(c => { c.fill = fill(FILL.head); c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.alignment = { vertical: 'middle', wrapText: true }; });
    row.height = 30;
  }
  /* cols: [{ h: header, k: key | fn(row), w: width, fmt?: numFmt, style?: fn(value,row)->argb }] */
  function table(wb, name, cols, rows, opts) {
    opts = opts || {};
    const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1, xSplit: opts.freezeCols || 0 }] });
    ws.columns = cols.map(c => ({ header: c.h, key: c.h, width: c.w || 16 }));
    headerRow(ws.getRow(1));
    const n = Math.min(rows.length, LIMITS.excelRows);
    for (let i = 0; i < n; i++) {
      const r = rows[i];
      const vals = cols.map(c => xv(typeof c.k === 'function' ? c.k(r) : r[c.k]));
      const row = ws.addRow(vals);
      cols.forEach((c, ci) => {
        const cell = row.getCell(ci + 1);
        if (c.fmt) cell.numFmt = c.fmt;
        else if (vals[ci] instanceof Date) cell.numFmt = 'yyyy-mm-dd';
        if (c.wrap) cell.alignment = { wrapText: true, vertical: 'top' };
        if (c.style) { const f = c.style(vals[ci], r); if (f) cell.fill = fill(f); }
      });
    }
    if (rows.length > n) ws.addRow([`… ${rows.length - n} more rows not written (Excel row limit).`]);
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
    return ws;
  }
  const lvlFill = l => l === 'ok' ? FILL.ok : l === 'bad' ? FILL.bad : l === 'warn' ? FILL.warn : null;
  const tierFill = t => ({ key: FILL.info, alias: FILL.info, confirmed: FILL.ok, remembered: FILL.ok, high: FILL.ok, accepted: FILL.violet, manual: FILL.violet, medium: FILL.warn, low: FILL.bad }[t] || null);

  function buildWorkbook(model, ExcelJS, opts) {
    opts = opts || {};
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Data Reconciliation Studio'; wb.created = model.generatedAt instanceof Date ? model.generatedAt : new Date();
    const T = model.totals;
    // ---- Summary
    const ws = wb.addWorksheet('Summary', { views: [{ showGridLines: false }] });
    ws.columns = [{ width: 38 }, { width: 22 }, { width: 70 }];
    ws.mergeCells('A1:C1');
    const t = ws.getCell('A1'); t.value = model.title; t.font = { bold: true, size: 18, color: { argb: 'FFFFFFFF' } }; t.fill = fill(FILL.brand); t.alignment = { vertical: 'middle', indent: 1 }; ws.getRow(1).height = 40;
    const statusText = { PASS: 'PASSED — no discrepancies', FAIL: 'FAILED — discrepancies found', REVIEW: 'NEEDS REVIEW — see warnings' }[model.status];
    ws.getCell('A3').value = 'Overall status'; ws.getCell('A3').font = { bold: true };
    ws.getCell('B3').value = statusText; ws.getCell('B3').font = { bold: true }; ws.mergeCells('B3:C3');
    ws.getCell('B3').fill = fill(model.status === 'PASS' ? FILL.ok : model.status === 'FAIL' ? FILL.bad : FILL.warn);
    ws.getCell('A4').value = 'Generated'; ws.getCell('B4').value = xv(model.generatedAt instanceof Date ? model.generatedAt : new Date(model.generatedAt)); ws.getCell('B4').numFmt = 'yyyy-mm-dd hh:mm';
    ws.getCell('A5').value = 'Engine version'; ws.getCell('B5').value = model.engineVersion;
    let r = 7;
    const kv = [
      ['Source files', T.sourceFiles, model.files.source.join(', ')], ['Comparison files', T.compareFiles, model.files.compare.join(', ')],
      ['Source worksheets compared', T.sourceSheets, ''], ['Comparison worksheets compared', T.compareSheets, ''],
      ['Comparisons configured', T.comparisons, 'Each pair of worksheets is compared independently'],
      ['Comparisons passed', T.passed, ''], ['Comparisons with discrepancies', T.failed, ''], ['Comparisons needing attention', T.attention, 'Not run, unresolved columns, pending reviews, blanks or values that could not be compared'],
      ['Source records', T.sourceRecords, ''], ['Comparison records', T.compareRecords, ''], ['Records matched by key', T.matched, ''],
      ['Matched records with identical values', T.identical, 'After formatting differences are ignored'], ['Matched records with differences', T.withDifferences, ''],
      ['Missing records (in source only)', T.missing, ''], ['Extra records (in comparison only)', T.extra, ''],
      ['Value discrepancies (cells)', T.discrepancies, 'Conflicts, garbled text, placeholders, blanks and uncomparable values'],
      ['  of which value conflicts', T.conflicts, ''], ['  of which could not be compared reliably', T.uncomparable, 'Not counted as matches'],
      ['Columns mapped and compared', T.mappedColumns, ''], ['Columns not mapped', T.unmatchedColumns, 'See "Unmatched Columns"'], ['Proposed mappings not reviewed', T.pendingReview, 'Excluded from the comparison']
    ];
    ws.getRow(r).values = ['Metric', 'Value', 'Notes']; headerRow(ws.getRow(r));
    kv.forEach(k => { r++; ws.getRow(r).values = k; ws.getCell('B' + r).alignment = { horizontal: 'right' }; ws.getCell('C' + r).alignment = { wrapText: true }; });

    // ---- Comparisons
    table(wb, 'Comparisons', [
      { h: 'Comparison', k: 'id', w: 12 }, { h: 'Status', k: 'status', w: 20, style: (v, c) => lvlFill(c.level) },
      { h: 'Source file', k: 'sourceFile', w: 30 }, { h: 'Source worksheet', k: 'sourceSheet', w: 22 }, { h: 'Source header row', k: 'sourceHeaderRow', w: 10 },
      { h: 'Comparison file', k: 'compareFile', w: 30 }, { h: 'Comparison worksheet', k: 'compareSheet', w: 22 }, { h: 'Comparison header row', k: 'compareHeaderRow', w: 10 },
      { h: 'Key (source ↔ comparison)', k: c => c.key ? `${c.key.source} ↔ ${c.key.compare}` : '(none)', w: 34 },
      { h: 'Source records', k: c => c.summary ? c.summary.rowsA : null, w: 11 }, { h: 'Comparison records', k: c => c.summary ? c.summary.rowsB : null, w: 11 },
      { h: 'Matched', k: c => c.summary ? c.summary.matched : null, w: 10 }, { h: 'Missing', k: c => c.summary ? c.summary.sourceOnly : null, w: 10, style: v => v ? FILL.bad : null },
      { h: 'Extra', k: c => c.summary ? c.summary.dbOnly : null, w: 10, style: v => v ? FILL.warn : null },
      { h: 'Identical records', k: c => c.summary ? c.summary.recordsEquivalent : null, w: 11 }, { h: 'Records with differences', k: c => c.summary ? c.summary.recordsWithIssues : null, w: 12 },
      { h: 'Value conflicts', k: c => c.summary ? c.summary.conflicts : null, w: 10, style: v => v ? FILL.bad : null },
      { h: 'Uncomparable values', k: c => c.summary ? c.summary.uncomparable : null, w: 12 },
      { h: 'Columns compared', k: c => c.mapping.filter(m => m.used && m.tier !== 'key').length, w: 10 },
      { h: 'Unmatched columns', k: c => c.unmatchedCompare.length + c.unmatchedSource.length, w: 10 },
      { h: 'Note', k: c => c.error || '', w: 40, wrap: true }
    ], model.comparisons);

    // ---- Column mapping
    const maps = []; model.comparisons.forEach(c => c.mapping.forEach(m => maps.push(Object.assign({ c }, m))));
    table(wb, 'Column Mapping', [
      { h: 'Comparison', k: m => m.c.id, w: 11 }, { h: 'Source file', k: m => m.c.sourceFile, w: 24 }, { h: 'Source worksheet', k: m => m.c.sourceSheet, w: 18 },
      { h: 'Comparison file', k: m => m.c.compareFile, w: 24 }, { h: 'Comparison worksheet', k: m => m.c.compareSheet, w: 18 },
      { h: 'Source column', k: m => m.sourceColumn || '(none)', w: 26 }, { h: 'Comparison column', k: 'compareColumn', w: 26 },
      { h: 'Mapping status', k: 'status', w: 24, style: (v, m) => tierFill(m.tier) }, { h: 'Used in comparison', k: m => m.used ? 'Yes' : 'No', w: 10 },
      { h: 'Confidence', k: 'confidence', w: 11, fmt: '0%' }, { h: 'Lead over next best', k: 'margin', w: 11, fmt: '0%' }, { h: 'Closest alternative', k: 'competitor', w: 26 },
      { h: 'Name evidence', k: 'method', w: 30, wrap: true }, { h: 'Evidence', k: 'evidence', w: 70, wrap: true },
      { h: 'Records compared', k: 'compared', w: 10 }, { h: 'Exact', k: 'exact', w: 8 }, { h: 'Format only', k: 'format', w: 8 }, { h: 'Conflicts', k: 'conflicts', w: 9, style: v => v ? FILL.bad : null },
      { h: 'Uncomparable', k: 'uncomparable', w: 10 }, { h: 'Blank in comparison', k: 'blankCompare', w: 10 }, { h: 'Blank in source', k: 'blankSource', w: 10 },
      { h: 'Agreement', k: 'agreement', w: 10, fmt: '0.0%', style: v => v == null ? null : v >= 0.95 ? FILL.ok : v >= 0.8 ? FILL.warn : FILL.bad }
    ], maps, { freezeCols: 1 });

    const unmatched = []; model.comparisons.forEach(c => c.unmatchedCompare.concat(c.unmatchedSource).forEach(u => unmatched.push(Object.assign({ comparison: c.id }, u))));
    if (unmatched.length) table(wb, 'Unmatched Columns', [
      { h: 'Comparison', k: 'comparison', w: 11 }, { h: 'Side', k: 'side', w: 12 }, { h: 'File', k: 'file', w: 28 }, { h: 'Worksheet', k: 'sheet', w: 20 },
      { h: 'Column', k: 'column', w: 28 }, { h: 'Best candidate', k: 'bestCandidate', w: 28 }, { h: 'Candidate confidence', k: 'confidence', w: 12, fmt: '0%' }, { h: 'Reason', k: 'reason', w: 70, wrap: true }
    ], unmatched);

    const disc = []; model.comparisons.forEach(c => c.discrepancies.forEach(d => disc.push(d)));
    if (disc.length) table(wb, 'Value Discrepancies', [
      { h: 'Comparison', k: 'comparison', w: 11 }, { h: 'Record key', k: 'key', w: 22 },
      { h: 'Source file', k: 'sourceFile', w: 24 }, { h: 'Source worksheet', k: 'sourceSheet', w: 16 }, { h: 'Source row', k: 'sourceRow', w: 9 }, { h: 'Source column', k: 'sourceColumn', w: 22 },
      { h: 'Comparison file', k: 'compareFile', w: 24 }, { h: 'Comparison worksheet', k: 'compareSheet', w: 16 }, { h: 'Comparison row', k: 'compareRow', w: 9 }, { h: 'Comparison column', k: 'compareColumn', w: 22 },
      { h: 'Source value (original)', k: 'sourceValue', w: 26 }, { h: 'Comparison value (original)', k: 'compareValue', w: 26 },
      { h: 'Issue', k: 'issue', w: 22, style: (v, d) => lvlFill(d.level) }, { h: 'Reason', k: 'reason', w: 50, wrap: true }
    ], disc, { freezeCols: 2 });

    const miss = []; model.comparisons.forEach(c => c.missing.forEach(x => miss.push(x)));
    if (miss.length) table(wb, 'Missing Records', [
      { h: 'Comparison', k: 'comparison', w: 11 }, { h: 'Record key', k: 'key', w: 24 }, { h: 'Source file', k: 'file', w: 26 }, { h: 'Source worksheet', k: 'sheet', w: 18 }, { h: 'Source row', k: 'row', w: 10 },
      { h: 'Record values (first columns)', k: 'preview', w: 100, wrap: true }
    ], miss);
    const extra = []; model.comparisons.forEach(c => c.extra.forEach(x => extra.push(x)));
    if (extra.length) table(wb, 'Extra Records', [
      { h: 'Comparison', k: 'comparison', w: 11 }, { h: 'Record key', k: 'key', w: 24 }, { h: 'Comparison file', k: 'file', w: 26 }, { h: 'Comparison worksheet', k: 'sheet', w: 18 }, { h: 'Comparison row', k: 'row', w: 10 },
      { h: 'Record values (first columns)', k: 'preview', w: 100, wrap: true }
    ], extra);
    const dups = []; model.comparisons.forEach(c => c.duplicates.forEach(x => dups.push(x)));
    if (dups.length) table(wb, 'Duplicate Keys', [
      { h: 'Comparison', k: 'comparison', w: 11 }, { h: 'Side', k: 'side', w: 12 }, { h: 'File', k: 'file', w: 26 }, { h: 'Worksheet', k: 'sheet', w: 18 }, { h: 'Key', k: 'key', w: 24 }, { h: 'Excel rows', k: 'rows', w: 30 }, { h: 'Handling', k: 'note', w: 30 }
    ], dups);
    if (model.errors.length) table(wb, 'Errors & Warnings', [
      { h: 'Level', k: 'level', w: 10, style: v => v === 'Error' ? FILL.bad : FILL.warn }, { h: 'Comparison', k: e => e.comparison || '', w: 11 }, { h: 'File', k: e => e.file || '', w: 36 }, { h: 'Worksheet', k: e => e.sheet || '', w: 24 }, { h: 'Message', k: 'message', w: 100, wrap: true }
    ], model.errors);

    // ---- Side-by-side record sheets (one per comparison, when the run is small enough)
    if (opts.comparisons && model.comparisons.length <= LIMITS.matchedSheets) {
      opts.comparisons.forEach((c, i) => {
        const m = model.comparisons[i];
        if (!c.res || !c.res.matchedRows.length) return;
        const { A, B } = c.P, res = c.res;
        const cols = [{ h: 'Record key', k: x => x.keyValue || x.key, w: 22 }, { h: 'Source row', k: x => x.sourceRow, w: 9 }, { h: 'Comparison row', k: x => x.compareRow, w: 9 }];
        res.maps.forEach((mp, mi) => {
          cols.push({ h: `${mp.aLabel} (source)`, k: x => mp.a.get(A.rows[x.ia]), w: 20 });
          cols.push({ h: `${mp.bLabel} (comparison)`, k: x => mp.b.get(B.rows[x.ib]), w: 20 });
          cols.push({ h: `${mp.bLabel} status`, k: x => x.st[mi].replace('_', ' '), w: 12, style: v => FILL[String(v).replace(' ', '_')] || null });
        });
        const name = (m.id + ' Records').slice(0, 31);
        table(wb, name, cols, res.matchedRows.slice(0, LIMITS.matchedRowsPerSheet), { freezeCols: 1 });
      });
    }
    return wb;
  }

  // ================= HTML =================
  const esc = s => String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = n => n === null || n === undefined ? '—' : Number(n).toLocaleString('en-US');
  const pct = x => x === null || x === undefined ? '—' : (x * 100).toFixed(1) + '%';
  function jsonForScript(o) { return JSON.stringify(o).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029'); }

  function buildHtml(model) {
    const T = model.totals;
    const statusTxt = { PASS: 'Passed', FAIL: 'Discrepancies found', REVIEW: 'Needs review' }[model.status];
    const statusCls = { PASS: 'ok', FAIL: 'bad', REVIEW: 'warn' }[model.status];
    let discLeft = LIMITS.htmlDiscrepancies, recLeft = LIMITS.htmlRecords;
    const data = { comparisons: [], discrepancies: [], records: [], truncated: { disc: 0, rec: 0 } };
    model.comparisons.forEach(c => {
      data.comparisons.push({ id: c.id, sf: c.sourceFile, ss: c.sourceSheet, cf: c.compareFile, cs: c.compareSheet });
      c.discrepancies.forEach(d => {
        if (discLeft-- > 0) data.discrepancies.push([d.comparison, d.key, d.sourceColumn, d.compareColumn, d.sourceRow, d.compareRow, disp(d.sourceValue), disp(d.compareValue), d.issue, d.reason, d.level]);
        else data.truncated.disc++;
      });
      c.missing.forEach(x => { if (recLeft-- > 0) data.records.push([x.comparison, 'Missing in comparison', x.key, x.file, x.sheet, x.row, x.preview]); else data.truncated.rec++; });
      c.extra.forEach(x => { if (recLeft-- > 0) data.records.push([x.comparison, 'Extra in comparison', x.key, x.file, x.sheet, x.row, x.preview]); else data.truncated.rec++; });
    });
    const gen = model.generatedAt instanceof Date ? model.generatedAt : new Date(model.generatedAt);
    const genTxt = `${gen.getFullYear()}-${String(gen.getMonth() + 1).padStart(2, '0')}-${String(gen.getDate()).padStart(2, '0')} ${String(gen.getHours()).padStart(2, '0')}:${String(gen.getMinutes()).padStart(2, '0')}`;
    const card = (label, value, sub, cls) => `<div class="card kpi ${cls || ''}"><div class="kl">${esc(label)}</div><div class="kv">${value}</div><div class="ks">${sub || ''}</div></div>`;
    const tierCls = t => ({ key: 'info', alias: 'info', confirmed: 'ok', remembered: 'ok', high: 'ok', accepted: 'violet', manual: 'violet', medium: 'warn', low: 'bad' }[t] || 'muted');

    const compRows = model.comparisons.map(c => `<tr data-comp="${esc(c.id)}">
      <td><b>${esc(c.id)}</b></td><td><span class="pill ${c.level}">${esc(c.status)}</span></td>
      <td><div class="file">${esc(c.sourceFile)}</div><div class="sheet">${esc(c.sourceSheet)}</div></td>
      <td><div class="file">${esc(c.compareFile)}</div><div class="sheet">${esc(c.compareSheet)}</div></td>
      <td class="n">${c.summary ? num(c.summary.matched) : '—'}</td><td class="n">${c.summary ? num(c.summary.sourceOnly) : '—'}</td><td class="n">${c.summary ? num(c.summary.dbOnly) : '—'}</td>
      <td class="n">${num(c.discrepancies.length)}</td><td class="n">${num(c.unmatchedCompare.length + c.unmatchedSource.length)}</td></tr>`).join('');

    const compSections = model.comparisons.map(c => {
      const s = c.summary;
      const mapRows = c.mapping.map(m => `<tr><td>${esc(m.sourceColumn || '(none)')}</td><td>${esc(m.compareColumn)}</td>
        <td><span class="pill ${tierCls(m.tier)}">${esc(m.status)}</span></td><td class="n">${m.confidence == null ? '—' : Math.round(m.confidence * 100) + '%'}</td>
        <td class="n">${m.agreement == null ? '—' : pct(m.agreement)}</td><td class="n">${m.conflicts == null ? '—' : num(m.conflicts)}</td><td class="ev">${esc(m.evidence)}</td></tr>`).join('');
      const unm = c.unmatchedCompare.concat(c.unmatchedSource).map(u => `<tr><td>${esc(u.side)}</td><td>${esc(u.column)}</td><td>${esc(u.bestCandidate || '—')}</td><td class="ev">${esc(u.reason)}</td></tr>`).join('');
      const issueChips = c.issueCounts ? Object.entries(c.issueCounts).map(([k, v]) => `<span class="pill ${ISSUE_LEVEL[k] || 'warn'}">${esc(k)}: ${num(v)}</span>`).join(' ') : '';
      return `<details class="card comp" id="comp-${esc(c.id)}" ${model.comparisons.length <= 3 ? 'open' : ''}>
        <summary><span class="pill ${c.level}">${esc(c.status)}</span> <b>${esc(c.id)}</b>
          <span class="trace"><span class="file">${esc(c.sourceFile)}</span> › <span class="sheet">${esc(c.sourceSheet)}</span>
          <span class="vs">↔</span><span class="file">${esc(c.compareFile)}</span> › <span class="sheet">${esc(c.compareSheet)}</span></span></summary>
        ${c.error ? `<div class="note bad">${esc(c.error)}</div>` : ''}
        ${s ? `<div class="mini">
          <div><b>${num(s.rowsA)}</b><span>source records</span></div><div><b>${num(s.rowsB)}</b><span>comparison records</span></div>
          <div><b>${num(s.matched)}</b><span>matched by key</span></div><div><b>${num(s.recordsEquivalent)}</b><span>identical</span></div>
          <div class="${s.sourceOnly ? 'bad' : ''}"><b>${num(s.sourceOnly)}</b><span>missing</span></div><div class="${s.dbOnly ? 'warn' : ''}"><b>${num(s.dbOnly)}</b><span>extra</span></div>
          <div class="${s.conflicts ? 'bad' : ''}"><b>${num(s.conflicts)}</b><span>value conflicts</span></div><div class="${s.uncomparable ? 'warn' : ''}"><b>${num(s.uncomparable)}</b><span>uncomparable</span></div></div>
          <p class="meta">Key: <b>${esc(c.key.source)}</b> ↔ <b>${esc(c.key.compare)}</b> ${c.key.detected ? '(detected automatically)' : '(chosen by user)'} · Header rows: source ${esc(c.sourceHeaderRow || '—')}, comparison ${esc(c.compareHeaderRow || '—')}</p>
          ${issueChips ? `<p>${issueChips}</p>` : ''}
          <p><button class="link" data-filter-comp="${esc(c.id)}">Show this comparison's discrepancies ↓</button></p>` : ''}
        <h4>Column mapping</h4>
        <div class="tw"><table class="sortable"><thead><tr><th>Source column</th><th>Comparison column</th><th>Status</th><th>Confidence</th><th>Agreement</th><th>Conflicts</th><th>Evidence</th></tr></thead><tbody>${mapRows}</tbody></table></div>
        ${unm ? `<h4>Unmatched columns</h4><div class="tw"><table class="sortable"><thead><tr><th>Side</th><th>Column</th><th>Best candidate</th><th>Reason</th></tr></thead><tbody>${unm}</tbody></table></div>` : ''}
      </details>`;
    }).join('');
    const errRows = model.errors.map(e => `<tr><td><span class="pill ${e.level === 'Error' ? 'bad' : 'warn'}">${esc(e.level)}</span></td><td>${esc(e.comparison || '')}</td><td>${esc(e.file || '')}</td><td>${esc(e.sheet || '')}</td><td>${esc(e.message)}</td></tr>`).join('');

    const css = `:root{--ink:#0f172a;--muted:#64748b;--line:#e2e8f0;--bg:#f4f6fb;--card:#fff;--brand:#4f46e5;--ok:#059669;--okb:#dcfce7;--warn:#b45309;--warnb:#fef3c7;--bad:#b91c1c;--badb:#fee2e2;--info:#1d4ed8;--infob:#dbeafe;--vio:#6d28d9;--viob:#ede9fe}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
header{background:linear-gradient(130deg,#172554,#4f46e5 60%,#7c3aed);color:#fff;padding:34px max(18px,calc((100vw - 1240px)/2)) 70px}
header h1{margin:0;font-size:27px;letter-spacing:-.01em}header .sub{opacity:.85;margin-top:4px}
.status{display:inline-flex;align-items:center;gap:8px;margin-top:16px;padding:8px 14px;border-radius:999px;font-weight:700;background:rgba(255,255,255,.15)}
.status i{width:10px;height:10px;border-radius:50%;display:inline-block}.status.ok i{background:#34d399}.status.bad i{background:#f87171}.status.warn i{background:#fbbf24}
main{max-width:1240px;margin:-44px auto 40px;padding:0 18px}
.card{background:var(--card);border-radius:14px;box-shadow:0 8px 26px rgba(15,23,42,.07);padding:18px;margin-bottom:16px;min-width:0}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-bottom:16px}
.kpi{border-top:4px solid var(--brand);margin:0}.kpi.ok{border-color:var(--ok)}.kpi.bad{border-color:var(--bad)}.kpi.warn{border-color:#f59e0b}
.kl{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);font-weight:700}.kv{font-size:25px;font-weight:750}.ks{font-size:12px;color:var(--muted)}
h2{font-size:18px;margin:26px 0 10px}h4{margin:18px 0 8px;font-size:14px}
.tw{width:100%;overflow:auto;border:1px solid var(--line);border-radius:10px;max-height:560px}
table{border-collapse:separate;border-spacing:0;width:100%;font-size:13px}th{position:sticky;top:0;background:#f8fafc;text-align:left;padding:9px 10px;border-bottom:1px solid var(--line);font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);cursor:pointer;white-space:nowrap;z-index:1}
th.asc:after{content:" ▲"}th.desc:after{content:" ▼"}td{padding:8px 10px;border-bottom:1px solid #f1f5f9;vertical-align:top;overflow-wrap:anywhere}td.n{text-align:right;white-space:nowrap}td.ev{color:#475569;font-size:12px;min-width:260px}
tr:hover td{background:#fafaff}.pill{display:inline-block;padding:2px 9px;border-radius:999px;font-size:11.5px;font-weight:650;white-space:nowrap}
.pill.ok{background:var(--okb);color:var(--ok)}.pill.bad{background:var(--badb);color:var(--bad)}.pill.warn{background:var(--warnb);color:var(--warn)}.pill.info{background:var(--infob);color:var(--info)}.pill.violet{background:var(--viob);color:var(--vio)}.pill.muted{background:#f1f5f9;color:var(--muted)}
.file{font-weight:650;overflow-wrap:anywhere}.sheet{color:var(--muted);font-size:12px}.trace{display:inline-flex;flex-wrap:wrap;gap:4px;align-items:baseline;margin-left:6px}.trace .vs{margin:0 6px;color:var(--brand);font-weight:700}
details.comp summary{cursor:pointer;list-style:none;display:flex;flex-wrap:wrap;gap:8px;align-items:center}details.comp summary::-webkit-details-marker{display:none}details.comp summary:before{content:"▸";color:var(--muted)}details.comp[open] summary:before{content:"▾"}
.mini{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;margin:14px 0 6px}.mini div{background:#f8fafc;border-radius:10px;padding:9px 11px}.mini b{display:block;font-size:18px}.mini span{font-size:11.5px;color:var(--muted)}.mini .bad{background:var(--badb)}.mini .warn{background:var(--warnb)}
.meta{color:var(--muted);font-size:12.5px}.note{padding:10px 12px;border-radius:10px;margin:10px 0}.note.bad{background:var(--badb);color:var(--bad)}.note.warn{background:var(--warnb);color:var(--warn)}
.toolbar{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px;align-items:center}.toolbar input,.toolbar select{padding:8px 10px;border:1px solid var(--line);border-radius:9px;font:inherit;background:#fff;min-width:150px}.toolbar input{flex:1;min-width:200px}
.pager{display:flex;gap:8px;align-items:center;justify-content:flex-end;margin-top:8px;font-size:12.5px;color:var(--muted)}button{font:inherit;border:1px solid var(--line);background:#fff;border-radius:8px;padding:6px 10px;cursor:pointer}button.link{border:0;padding:0;color:var(--brand);background:none;font-weight:600}
#disc td:last-child{min-width:220px}
.legend{font-size:12px;color:var(--muted)}.val{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;white-space:pre-wrap}.empty{padding:18px;color:var(--muted);text-align:center}
@media(max-width:720px){header{padding:24px 14px 60px}header h1{font-size:21px}main{padding:0 10px}.kv{font-size:21px}.toolbar>*{width:100%}}
@media print{header{background:#312e81!important;-webkit-print-color-adjust:exact;print-color-adjust:exact}.tw{max-height:none;overflow:visible}.toolbar,.pager{display:none}details.comp{display:block}}`;

    const script = `(function(){
var D=JSON.parse(document.getElementById('report-data').textContent);
function e(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function sortable(t){var ths=t.querySelectorAll('th');ths.forEach(function(th,i){th.addEventListener('click',function(){var tb=t.tBodies[0],rows=[].slice.call(tb.rows),dir=th.classList.contains('asc')?-1:1;ths.forEach(function(x){x.classList.remove('asc','desc')});th.classList.add(dir>0?'asc':'desc');rows.sort(function(a,b){var x=a.cells[i].textContent.trim(),y=b.cells[i].textContent.trim(),nx=parseFloat(x.replace(/[,%]/g,'')),ny=parseFloat(y.replace(/[,%]/g,''));if(!isNaN(nx)&&!isNaN(ny)&&/^[\\d.,%-]+$/.test(x)&&/^[\\d.,%-]+$/.test(y))return(nx-ny)*dir;return x.localeCompare(y)*dir});rows.forEach(function(r){tb.appendChild(r)})})})}
document.querySelectorAll('table.sortable').forEach(sortable);
var compById={};D.comparisons.forEach(function(c){compById[c.id]=c});
function explorer(cfg){var st={q:'',f:{},page:0,sort:null,dir:1},size=100;var root=document.getElementById(cfg.id);if(!root)return;
 var tb=root.querySelector('tbody'),info=root.querySelector('.info'),q=root.querySelector('input[type=search]');
 q.addEventListener('input',function(){st.q=q.value.toLowerCase();st.page=0;draw()});
 root.querySelectorAll('select[data-f]').forEach(function(s){s.addEventListener('change',function(){st.f[s.dataset.f]=s.value;st.page=0;draw()})});
 root.querySelectorAll('th[data-i]').forEach(function(th){th.addEventListener('click',function(){var i=+th.dataset.i;st.dir=st.sort===i?-st.dir:1;st.sort=i;root.querySelectorAll('th').forEach(function(x){x.classList.remove('asc','desc')});th.classList.add(st.dir>0?'asc':'desc');draw()})});
 root.querySelector('.prev').addEventListener('click',function(){if(st.page>0){st.page--;draw()}});root.querySelector('.next').addEventListener('click',function(){st.page++;draw()});
 cfg.api&&(cfg.api.set=function(k,v){st.f[k]=v;var s=root.querySelector('select[data-f="'+k+'"]');if(s)s.value=v;st.page=0;draw();root.scrollIntoView({behavior:'smooth'})});
 function draw(){var rows=cfg.rows.filter(function(r){for(var k in st.f){if(st.f[k]&&String(r[k])!==st.f[k])return false}if(!st.q)return true;for(var i=0;i<r.length;i++){if(String(r[i]==null?'':r[i]).toLowerCase().indexOf(st.q)>=0)return true}return false});
  if(st.sort!==null){var i=st.sort,d=st.dir;rows=rows.slice().sort(function(a,b){var x=a[i],y=b[i];if(typeof x==='number'&&typeof y==='number')return(x-y)*d;return String(x==null?'':x).localeCompare(String(y==null?'':y),undefined,{numeric:true})*d})}
  var pages=Math.max(1,Math.ceil(rows.length/size));if(st.page>=pages)st.page=pages-1;var sl=rows.slice(st.page*size,st.page*size+size);
  tb.innerHTML=sl.length?sl.map(cfg.render).join(''):'<tr><td colspan="20" class="empty">No rows match.</td></tr>';
  info.textContent=rows.length.toLocaleString()+' rows · page '+(st.page+1)+' of '+pages}
 draw()}
var discApi={};
explorer({id:'disc',rows:D.discrepancies,api:discApi,render:function(r){var c=compById[r[0]]||{};return '<tr><td><b>'+e(r[0])+'</b></td><td>'+e(r[1])+'</td><td><div class="file">'+e(c.sf)+'</div><div class="sheet">'+e(c.ss)+' · row '+e(r[4])+' · '+e(r[2])+'</div></td><td><div class="file">'+e(c.cf)+'</div><div class="sheet">'+e(c.cs)+' · row '+e(r[5])+' · '+e(r[3])+'</div></td><td class="val">'+(r[6]===''?'<i class="legend">blank</i>':e(r[6]))+'</td><td class="val">'+(r[7]===''?'<i class="legend">blank</i>':e(r[7]))+'</td><td><span class="pill '+e(r[10])+'">'+e(r[8])+'</span><div class="legend">'+e(r[9])+'</div></td></tr>'}});
explorer({id:'recs',rows:D.records,render:function(r){return '<tr><td><b>'+e(r[0])+'</b></td><td><span class="pill '+(r[1].indexOf('Missing')===0?'bad':'warn')+'">'+e(r[1])+'</span></td><td>'+e(r[2])+'</td><td><div class="file">'+e(r[3])+'</div><div class="sheet">'+e(r[4])+' · row '+e(r[5])+'</div></td><td class="ev">'+e(r[6])+'</td></tr>'}});
document.querySelectorAll('[data-filter-comp]').forEach(function(b){b.addEventListener('click',function(){discApi.set&&discApi.set(0,b.dataset.filterComp)})});
document.querySelectorAll('tr[data-comp]').forEach(function(tr){tr.style.cursor='pointer';tr.addEventListener('click',function(){var d=document.getElementById('comp-'+tr.dataset.comp);if(d){d.open=true;d.scrollIntoView({behavior:'smooth'})}})});
})();`;
    const opt = (vals) => vals.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
    const issueTypes = [...new Set(data.discrepancies.map(d => d[8]))];
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(model.title)}</title><style>${css}</style></head><body>
<header><h1>${esc(model.title)}</h1><div class="sub">Generated ${esc(genTxt)} · ${num(T.comparisons)} independent comparison${T.comparisons === 1 ? '' : 's'} · ${num(T.sourceFiles)} source file${T.sourceFiles === 1 ? '' : 's'}, ${num(T.compareFiles)} comparison file${T.compareFiles === 1 ? '' : 's'}</div>
<div class="status ${statusCls}"><i></i>${esc(statusTxt)}</div></header>
<main>
<section class="kpis">
${card('Comparisons', num(T.comparisons), `${num(T.passed)} passed · ${num(T.failed)} with discrepancies · ${num(T.attention)} need attention`, T.failed ? 'bad' : T.attention ? 'warn' : 'ok')}
${card('Records matched', num(T.matched), `${num(T.sourceRecords)} source · ${num(T.compareRecords)} comparison records`)}
${card('Missing records', num(T.missing), 'in source, not in comparison', T.missing ? 'bad' : 'ok')}
${card('Extra records', num(T.extra), 'in comparison, not in source', T.extra ? 'warn' : 'ok')}
${card('Value discrepancies', num(T.discrepancies), `${num(T.conflicts)} conflicts · ${num(T.uncomparable)} uncomparable`, T.conflicts ? 'bad' : T.discrepancies ? 'warn' : 'ok')}
${card('Columns compared', num(T.mappedColumns), `${num(T.unmatchedColumns)} unmatched · ${num(T.pendingReview)} unreviewed proposals`, T.unmatchedColumns || T.pendingReview ? 'warn' : 'ok')}
</section>
<div class="card"><h2 style="margin-top:0">Executive summary</h2>
<p>${T.comparisons} worksheet pair${T.comparisons === 1 ? ' was' : 's were'} compared independently. ${num(T.matched)} records were matched by key; ${num(T.identical)} of them have identical values once formatting differences are ignored and ${num(T.withDifferences)} have at least one difference.
${T.missing || T.extra ? `${num(T.missing)} source records are missing from the comparison data and ${num(T.extra)} comparison records are not in the source.` : 'Every record was found on both sides.'}
${T.pendingReview ? `<b>${num(T.pendingReview)} proposed column mapping(s) were not reviewed and were excluded</b>, so their columns were not checked.` : ''}
${T.uncomparable ? `${num(T.uncomparable)} values could not be compared reliably and are listed for manual checking, not counted as matches.` : ''}</p>
<p class="legend">Every discrepancy lists the source and comparison file, worksheet, column and Excel row number so it can be checked in the original files. Rows are matched by the record key, not by position.</p></div>
<h2>Comparisons</h2>
<div class="card"><div class="tw"><table class="sortable"><thead><tr><th>ID</th><th>Status</th><th>Source file › worksheet</th><th>Comparison file › worksheet</th><th>Matched</th><th>Missing</th><th>Extra</th><th>Discrepancies</th><th>Unmatched cols</th></tr></thead><tbody>${compRows}</tbody></table></div><p class="legend">Click a row to open its details.</p></div>
${compSections}
<h2>Value discrepancies</h2>
<div class="card" id="disc">
<div class="toolbar"><input type="search" placeholder="Search key, column, value, reason…"><select data-f="0"><option value="">All comparisons</option>${opt(model.comparisons.map(c => c.id))}</select><select data-f="8"><option value="">All issue types</option>${opt(issueTypes)}</select></div>
${data.truncated.disc ? `<div class="note warn">${num(data.truncated.disc)} further discrepancies are not shown here to keep the file small. The Excel report contains every row.</div>` : ''}
<div class="tw"><table><thead><tr><th data-i="0">Comp.</th><th data-i="1">Record key</th><th data-i="4">Source (file · sheet · row · column)</th><th data-i="5">Comparison (file · sheet · row · column)</th><th data-i="6">Source value</th><th data-i="7">Comparison value</th><th data-i="8">Issue / reason</th></tr></thead><tbody></tbody></table></div>
<div class="pager"><span class="info"></span><button class="prev">‹ Prev</button><button class="next">Next ›</button></div></div>
<h2>Missing and extra records</h2>
<div class="card" id="recs">
<div class="toolbar"><input type="search" placeholder="Search key or values…"><select data-f="0"><option value="">All comparisons</option>${opt(model.comparisons.map(c => c.id))}</select><select data-f="1"><option value="">Missing and extra</option><option>Missing in comparison</option><option>Extra in comparison</option></select></div>
${data.truncated.rec ? `<div class="note warn">${num(data.truncated.rec)} further records are not shown here. The Excel report contains every row.</div>` : ''}
<div class="tw"><table><thead><tr><th data-i="0">Comp.</th><th data-i="1">Type</th><th data-i="2">Record key</th><th data-i="5">File · worksheet · row</th><th>Record values</th></tr></thead><tbody></tbody></table></div>
<div class="pager"><span class="info"></span><button class="prev">‹ Prev</button><button class="next">Next ›</button></div></div>
${errRows ? `<h2>Errors and warnings</h2><div class="card"><div class="tw"><table class="sortable"><thead><tr><th>Level</th><th>Comparison</th><th>File</th><th>Worksheet</th><th>Message</th></tr></thead><tbody>${errRows}</tbody></table></div></div>` : ''}
<p class="legend">Data Reconciliation Studio · engine ${esc(model.engineVersion)} · This report is self-contained and works offline.</p>
</main>
<script type="application/json" id="report-data">${jsonForScript(data)}</script>
<script>${script}</script></body></html>`;
    return html;
  }

  const api = { buildModel, comparisonModel, buildWorkbook, buildHtml, LIMITS, excelValue: xv };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ReconReport = api;
})(typeof self !== 'undefined' ? self : this);
