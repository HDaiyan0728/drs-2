'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../engine.js');
const V2 = require('./baseline/engine_v2.js');
const { DOMAINS, buildCase } = require('./fixtures/benchmark');

const ns = (a, b) => R.nameScore(a, b).score;

test('name evidence: normalisation, abbreviations, reordering, synonyms', () => {
  assert.equal(ns('Customer ID', 'customer_id'), 1);
  assert.equal(ns('CustomerID', 'Customer ID'), 1);
  assert.ok(ns('Cust Ref', 'Customer Reference') >= 0.9);
  assert.ok(ns('Name of Customer', 'Customer Name') >= 0.9);
  assert.ok(ns('Date of Birth', 'Birth Date') >= 0.9);
  assert.ok(ns('DOB', 'Date of Birth') >= 0.9);
  assert.ok(ns('Qty', 'Quantity') >= 0.85);
  assert.ok(ns('Emial Address', 'Email Address') >= 0.8);
  assert.ok(ns('Surname', 'Last Name') >= 0.9);
});

test('name evidence: different fields are NOT matched by shared words (v2 scored these 0.88)', () => {
  assert.ok(V2.nameScore('Customer ID', 'Customer Name').score >= 0.88, 'baseline really had this defect');
  assert.ok(ns('Customer ID', 'Customer Name') <= 0.2);
  assert.ok(ns('Order Date', 'Order Number') <= 0.2);
  assert.ok(R.nameScore('Customer ID', 'Customer Name').conflict);
  assert.ok(ns('Status', 'Is Active') < 0.5, 'status is not a synonym of active');
  assert.ok(ns('Title', 'Job Title') <= 0.55, 'a generic one-word header needs other evidence');
  assert.ok(ns('Cost', 'Price') < 0.5);
});

test('unicode headers are not collapsed to the same key', () => {
  assert.notEqual(R.hkey('নাম'), R.hkey('ঠিকানা'));
  assert.ok(ns('নাম', 'ঠিকানা') < 0.5);
  assert.equal(ns('নাম', 'নাম'), 1);
});

function mk(headers, rows) { return { name: 'f.xlsx', headers, rows: rows.map(r => Object.fromEntries(headers.map((h, i) => [h, r[i]]))) }; }

test('correlated look-alike columns go to review instead of being auto-accepted', () => {
  // "City" in the system matches Hometown; "Permanent City" equals Hometown 80% of the time.
  const rows = [], cmp = [];
  let s = 1;
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  const C = ['Dhaka', 'Khulna', 'Sylhet', 'Rajshahi', 'Barishal', 'Rangpur'];
  for (let i = 0; i < 300; i++) {
    const home = C[Math.floor(rnd() * 6)], perm = rnd() < 0.8 ? home : C[Math.floor(rnd() * 6)];
    rows.push(['S' + i, home, perm]);
    cmp.push(['S' + i, rnd() < 0.7 ? home : C[Math.floor(rnd() * 6)]]);   // dirty system data
  }
  const run = R.runReconciliation(mk(['Student ID', 'Hometown', 'Permanent City'], rows), mk(['Student ID', 'City'], cmp));
  const d = run.suggestion.decisions.find(x => x.bId === 'City');
  assert.notEqual(d.tier, 'high', 'must not auto-accept: ' + d.reason);
});

test('chance correction: unrelated Yes/No columns are not matched', () => {
  const rows = [], cmp = [];
  let s = 7;
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  for (let i = 0; i < 400; i++) { rows.push(['K' + i, rnd() < 0.5 ? 'Y' : 'N']); cmp.push(['K' + i, rnd() < 0.5 ? 'Y' : 'N']); }
  const run = R.runReconciliation(mk(['Code', 'Is Verified'], rows), mk(['Code', 'Newsletter Opt In'], cmp));
  const d = run.suggestion.decisions.find(x => x.bId === 'Newsletter Opt In');
  assert.equal(d.aId, null, 'raw agreement is ~50% by chance; must stay unresolved');
});

test('confirmed, rejected and remembered mappings', () => {
  const c = buildCase(DOMAINS.find(d => d.id === 'customers'), { seed: 5 });
  const base = R.runReconciliation(c.source, c.compare);
  const auto = base.suggestion.decisions.find(d => d.bId === 'Field 7');
  // Confirm a pair, reject another compare column outright
  const run = R.runReconciliation(c.source, c.compare, { known: [{ bLabel: 'Field 7', aLabel: 'Segment' }], rejected: [{ bLabel: 'Bill City', aLabel: null }] });
  const f7 = run.suggestion.decisions.find(d => d.bId === 'Field 7');
  assert.equal(f7.tier, 'confirmed'); assert.equal(f7.aId, 'Segment');
  const bc = run.suggestion.decisions.find(d => d.bId === 'Bill City');
  assert.equal(bc.aId, null); assert.equal(bc.tier, 'confirmed');
  assert.ok(auto, 'Field 7 was decided automatically before confirmation');
  // Memory entries are keyed by normalised header + value type, never by values
  const mem = [{ cmp: R.hkey('Field 7') + '|text', src: R.hkey('Segment') + '|text', decision: 'match' }];
  const run2 = R.runReconciliation(c.source, c.compare, { memory: mem });
  assert.equal(run2.suggestion.decisions.find(d => d.bId === 'Field 7').tier, 'remembered');
});

test('one-to-one: a source column is never used twice', () => {
  const cases = DOMAINS.map((d, i) => buildCase(d, { seed: 300 + i, overlap: 0.7, conflictRate: 0.2 }));
  cases.forEach(c => {
    const run = R.runReconciliation(c.source, c.compare);
    const used = run.suggestion.decisions.filter(d => d.aId).map(d => d.aId);
    assert.equal(new Set(used).size, used.length, c.id);
  });
});

test('no shared records: names and profiles still produce safe proposals (v2 produced nothing)', () => {
  const c = buildCase(DOMAINS.find(d => d.id === 'employees'), { seed: 9, overlap: 0 });
  assert.ok(V2.runReconciliation(c.source, c.compare).error);
  const run = R.runReconciliation(c.source, c.compare);
  assert.equal(run.key, null);
  assert.ok(run.suggestion.decisions.some(d => d.aId === 'Gender' && d.bId === 'Sex'));
});

test('benchmark gate: no wrong auto-accepted mappings, and better than v2', () => {
  const { report } = require('./benchmark.js');
  const v3 = report['all cases']['v3 (confidence tiers)'], v2 = report['all cases']['v2 (original, every suggested mapping used)'];
  assert.equal(v3.wrongAccepted, 0, 'wrong auto-accepted mappings: ' + JSON.stringify(v3.errors.filter(e => e.state === 'accepted')));
  assert.ok(v3.autoPrecision >= v2.autoPrecision);
  assert.ok(v3.assistedRecall > v2.assistedRecall);
});
