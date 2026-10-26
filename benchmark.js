#!/usr/bin/env node
/*
 * Column-matching benchmark: original engine (v2) vs current engine (v3) on the
 * same labelled cases. Run: npm run benchmark   (add --json for machine output,
 * --verbose to list every wrong or unresolved decision).
 *
 * Definitions (per comparison-file column):
 *   accepted    the engine would use this mapping in the comparison without asking
 *   review      the engine proposes a mapping but asks the user to confirm
 *   unresolved  no mapping proposed
 * Metrics:
 *   auto precision   correct accepted / all accepted              (the number that protects UAT results)
 *   auto recall      correct accepted / columns that have a true counterpart
 *   assisted recall  correct (accepted + review) / columns with a true counterpart
 *   wrong-accept     wrong accepted / all columns                 (includes distractors that got mapped)
 *   unresolved rate  unresolved / all columns
 */
'use strict';
const path = require('path');
const { allCases } = require('./fixtures/benchmark');
const V2 = require('./baseline/engine_v2.js');
const V3 = require(path.join(__dirname, '..', process.env.ENGINE || 'engine.js'));

const args = process.argv.slice(2);
const VERBOSE = args.includes('--verbose');

function predictV2(c, strictStatus) {
  const out = {};
  const run = V2.runReconciliation(c.source, c.compare);
  if (run.error || !run.result) return out;
  const { A, B, key, suggestion } = run;
  out[B.colsById[key.bId].label] = { src: A.colsById[key.aId].label, state: 'accepted', conf: 1 };
  suggestion.aliases.forEach(x => { out[B.colsById[x.bId].label] = { src: A.colsById[x.aId].label, state: 'accepted', conf: 1 }; });
  run.result.mapping.forEach(m => {
    const st = m.status;
    const state = !strictStatus ? 'accepted' : (st === 'Auto-matched' ? 'accepted' : 'review');
    out[m.bLabel] = { src: m.aLabel.replace(/ \+ .*$/, ''), state, conf: m.conf };
  });
  return out;
}

function predictV3(c) {
  const out = {};
  const run = V3.runReconciliation(c.source, c.compare);
  const { A, B, key, suggestion } = run;
  if (key) out[B.colsById[key.bId].label] = { src: A.colsById[key.aId].label, state: 'accepted', conf: 1 };
  suggestion.aliases.forEach(x => { out[B.colsById[x.bId].label] = { src: A.colsById[x.aId].label, state: 'accepted', conf: 1 }; });
  suggestion.decisions.forEach(d => {
    const b = B.colsById[d.bId].label;
    if (!d.aId) { out[b] = { src: null, state: 'unresolved', conf: d.conf }; return; }
    const state = (d.tier === 'high' || d.tier === 'confirmed' || d.tier === 'remembered') ? 'accepted' : d.tier === 'medium' ? 'review' : 'unresolved';
    out[b] = { src: A.colsById[d.aId].label.replace(/ \+ .*$/, ''), state, conf: d.conf, reason: d.reason };
  });
  return out;
}

function grade(cases, predict) {
  const t = { cols: 0, positives: 0, accepted: 0, acceptedOK: 0, review: 0, reviewOK: 0, unresolved: 0, unresolvedOK: 0, wrongAccept: 0, ms: 0, perCat: {}, errors: [] };
  cases.forEach(c => {
    const t0 = process.hrtime.bigint();
    const pred = predict(c);
    t.ms += Number(process.hrtime.bigint() - t0) / 1e6;
    c.truth.forEach(tr => {
      const p = pred[tr.compare] || { src: null, state: 'unresolved' };
      const cat = tr.cat;
      const pc = t.perCat[cat] = t.perCat[cat] || { n: 0, acceptedOK: 0, wrongAccept: 0, reviewOK: 0, unresolved: 0 };
      t.cols++; pc.n++;
      if (tr.source) t.positives++;
      const correct = p.state !== 'unresolved' && p.src === tr.source;
      if (p.state === 'accepted') { t.accepted++; if (correct) { t.acceptedOK++; pc.acceptedOK++; } else { t.wrongAccept++; pc.wrongAccept++; } }
      else if (p.state === 'review') { t.review++; if (correct) { t.reviewOK++; pc.reviewOK++; } }
      else { t.unresolved++; pc.unresolved++; if (!tr.source) t.unresolvedOK++; }
      if (!(p.state === 'accepted' && correct) && !(p.state === 'unresolved' && !tr.source))
        t.errors.push({ case: c.id, compare: tr.compare, expected: tr.source, got: p.src, state: p.state, cat, conf: p.conf, reason: p.reason });
    });
  });
  const r = x => Math.round(x * 1000) / 10;
  return {
    columns: t.cols,
    autoPrecision: r(t.accepted ? t.acceptedOK / t.accepted : 1),
    autoRecall: r(t.positives ? t.acceptedOK / t.positives : 0),
    assistedRecall: r(t.positives ? (t.acceptedOK + t.reviewOK) / t.positives : 0),
    wrongAcceptRate: r(t.wrongAccept / t.cols),
    wrongAccepted: t.wrongAccept,
    reviewRate: r(t.review / t.cols),
    reviewPrecision: r(t.review ? t.reviewOK / t.review : 1),
    unresolvedRate: r(t.unresolved / t.cols),
    distractorsCorrectlyUnmapped: t.unresolvedOK,
    msPerCase: Math.round(t.ms / cases.length),
    perCat: t.perCat, errors: t.errors
  };
}

const cases = allCases();
const subsets = {
  'all cases': cases,
  'dev (shared records)': cases.filter(c => c.split === 'dev' && !c.id.includes('#')),
  'holdout (shared records)': cases.filter(c => c.split === 'holdout' && !c.id.includes('#')),
  'dirty data (30% conflicts, 60% shared records)': cases.filter(c => c.id.includes('#dirty')),
  'no shared records (names + profiles only)': cases.filter(c => c.id.includes('#no-overlap'))
};
const engines = {
  'v2 (original, every suggested mapping used)': c => predictV2(c, false),
  'v2 (original, only "Auto-matched" status trusted)': c => predictV2(c, true),
  'v3 (confidence tiers)': predictV3
};
const report = {};
Object.entries(subsets).forEach(([sn, cs]) => {
  report[sn] = {};
  Object.entries(engines).forEach(([en, fn]) => { report[sn][en] = grade(cs, fn); });
});

if (require.main !== module) { module.exports = { report }; return; }
if (args.includes('--json')) { console.log(JSON.stringify(report, (k, v) => (k === 'errors' && !VERBOSE ? undefined : v), 2)); process.exit(0); }

const cols = ['autoPrecision', 'autoRecall', 'assistedRecall', 'wrongAcceptRate', 'wrongAccepted', 'reviewRate', 'reviewPrecision', 'unresolvedRate', 'msPerCase'];
Object.entries(report).forEach(([sn, byEngine]) => {
  const first = Object.values(byEngine)[0];
  console.log(`\n=== ${sn} — ${first.columns} comparison columns ===`);
  console.log('engine'.padEnd(52) + cols.map(c => c.padStart(16)).join(''));
  Object.entries(byEngine).forEach(([en, g]) => console.log(en.padEnd(52) + cols.map(c => String(g[c]).padStart(16)).join('')));
});
const cats = Object.keys(report['all cases']['v3 (confidence tiers)'].perCat);
console.log('\n=== per category, all cases (correct auto-accepted / wrong auto-accepted / correct proposals for review / unresolved) ===');
console.log('category'.padEnd(18) + 'n'.padStart(5) + Object.keys(engines).map(e => e.slice(0, 30).padStart(34)).join(''));
cats.forEach(cat => {
  const cells = Object.keys(engines).map(e => { const p = report['all cases'][e].perCat[cat] || { acceptedOK: 0, wrongAccept: 0, reviewOK: 0, unresolved: 0 }; return `${p.acceptedOK} / ${p.wrongAccept} / ${p.reviewOK} / ${p.unresolved}`.padStart(34); });
  console.log(cat.padEnd(18) + String(report['all cases']['v3 (confidence tiers)'].perCat[cat].n).padStart(5) + cells.join(''));
});
if (VERBOSE) {
  ['v2 (original, every suggested mapping used)', 'v3 (confidence tiers)'].forEach(en => {
    console.log(`\n--- ${en}: wrong or not auto-accepted ---`);
    report['all cases'][en].errors.forEach(e => console.log(`${e.case.padEnd(22)} ${e.state.padEnd(10)} ${String(e.compare).padEnd(22)} expected=${String(e.expected).padEnd(22)} got=${String(e.got).padEnd(22)} ${e.conf != null ? (e.conf * 100).toFixed(0) + '%' : ''} ${e.reason ? e.reason.slice(0, 150) : ''}`));
  });
}
module.exports = { report };
