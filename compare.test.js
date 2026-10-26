'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../engine.js');

const cmp = (a, b, ctx) => R.compareCell(a, b, ctx || {}).s;

test('dates use local calendar day (no UTC shift)', () => {
  // SheetJS returns local-midnight Date objects. v2 used toISOString(), which moved the day back in UTC+ zones.
  const d = new Date(2024, 0, 5);
  assert.equal(R.displayValue(d), '2024-01-05');
  assert.equal(cmp(d, '2024-01-05', { kind: 'date' }), 'format');
  assert.equal(cmp(d, new Date(2024, 0, 5)), 'exact');
  assert.equal(cmp(d, '06/01/2024', { kind: 'date', orderB: 'dmy' }), 'mismatch');
});

test('date formats and day/month ambiguity', () => {
  assert.equal(cmp('2024-03-15', '15/03/2024', { kind: 'date' }), 'format');       // unambiguous (15 > 12)
  assert.equal(cmp('2024-03-15', '15-Mar-2024', { kind: 'date' }), 'format');
  assert.equal(cmp('2024-03-15', 'Mar 15, 2024', { kind: 'date' }), 'format');
  assert.equal(cmp('2024-04-03', '03/04/2024', { kind: 'date' }), 'uncomparable');  // 3 April or 4 March?
  assert.equal(cmp('2024-04-03', '03/04/2024', { kind: 'date', orderB: 'dmy' }), 'format');
  assert.equal(cmp('2024-04-03', '03/04/2024', { kind: 'date', orderB: 'mdy' }), 'mismatch');
  assert.equal(cmp('2024-04-03', '07/09/2024', { kind: 'date' }), 'mismatch');      // different under both readings
  assert.equal(cmp('2024-04-03', 'not a date', { kind: 'date' }), 'uncomparable');
  assert.equal(cmp(new Date(2024, 0, 5, 14, 30), '2024-01-05 14:30', { kind: 'date' }), 'format');
});

test('numbers ignore formatting but not value', () => {
  assert.equal(cmp(1000, '1,000'), 'format');
  assert.equal(cmp(100, '100.00'), 'format');
  assert.equal(cmp('$1,234.50', 1234.5), 'format');
  assert.equal(cmp('(250)', -250), 'format');
  assert.equal(cmp('15%', 0.15), 'format');
  assert.equal(cmp(100, 100.01), 'mismatch');
  assert.equal(cmp(100, 100.01, { tolerance: 0.05 }), 'format');
  assert.equal(cmp('00123', 123), 'format');
  assert.match(R.compareCell('00123', 123).why, /leading zeros/);
  assert.equal(cmp(5, 'abc', { kind: 'number' }), 'uncomparable');
});

test('text, case, booleans, phones, names, encoding', () => {
  assert.equal(cmp('Dhaka', 'Dhaka'), 'exact');
  assert.equal(cmp('Dhaka', ' DHAKA '), 'format');
  assert.equal(cmp('Yes', true, { kind: 'bool' }), 'format');
  assert.equal(cmp('Y', 'No', { kind: 'bool' }), 'mismatch');
  assert.equal(cmp('+880 1712-345678', '01712345678', { kind: 'phone' }), 'format');
  assert.equal(cmp('Md. Sakib Hasan', 'Sakib Hasan', { kind: 'name' }), 'format');
  assert.equal(cmp('BrÃ©gard', 'Brégard'), 'encoding');
  assert.equal(cmp('Officer', 'Manager'), 'mismatch');
});

test('blanks are never treated as matches', () => {
  assert.equal(cmp(null, 'x'), 'blank_source');
  assert.equal(cmp('x', ''), 'blank_compare');
  assert.equal(cmp('N/A', null), 'both_blank');
  assert.equal(cmp(' ', 'x'), 'blank_source');
});

test('typed parsers', () => {
  assert.equal(R.parseNumber('1 234,5'), null);           // ambiguous European format is rejected, not guessed
  assert.equal(R.parseNumber('1,234.5').n, 1234.5);
  assert.equal(R.parseNumber('BDT 2,500').n, 2500);
  assert.equal(R.parseDate('31/12/2024').key, '2024-12-31');
  assert.equal(R.parseDate('31/02/2024'), null);           // invalid calendar date
  assert.equal(R.parseBool('N'), false);
});
