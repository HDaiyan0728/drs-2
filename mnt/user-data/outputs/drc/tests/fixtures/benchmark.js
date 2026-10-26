/*
 * Column-matching benchmark: synthetic but realistic file pairs with
 * manually written ground-truth mappings.
 *
 * Each domain describes "concepts". A concept has a value generator and the
 * header name used in the source file and in the comparison file. A concept
 * that exists on only one side has `src` or `cmp` set to null. Two different
 * concepts with similar names (e.g. Billing City / Shipping City) are the
 * "similar names, different meaning" traps.
 *
 * Categories (used for per-category metrics):
 *   exact            identical header
 *   format           case / spacing / punctuation / separator differences
 *   abbrev_reorder   abbreviations and reordered words
 *   synonym          common synonyms
 *   different_name   same concept, very different wording
 *   ambiguous        name alone is not enough (generic or shared words)
 *   misleading       uninformative names (Field 7, Col_B)
 *   distractor       compare column has NO counterpart; must stay unmapped
 *
 * The SPLIT field marks domains used while developing ("dev") versus
 * domains written up-front and NOT used to tune the lexicon ("holdout").
 * This file was written before the v3 lexicon in engine.js. The correlated
 * look-alike traps (`corr`) were added after the first benchmark run because the
 * first version was too easy; they make the benchmark harder, not easier.
 */
'use strict';

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

const FIRST = ['Amina', 'Rahim', 'Karim', 'Sadia', 'John', 'Maria', 'Wei', 'Fatima', 'Liam', 'Nusrat', 'Tanvir', 'Olivia', 'Arjun', 'Sofia', 'Hasan', 'Mei', 'Omar', 'Elena', 'Rafi', 'Chloe'];
const LAST = ['Rahman', 'Khan', 'Smith', 'Garcia', 'Chen', 'Ahmed', 'Hossain', 'Brown', 'Islam', 'Lopez', 'Patel', 'Wang', 'Akter', 'Miller', 'Das'];
const CITY = ['Dhaka', 'Chattogram', 'Khulna', 'Sylhet', 'Rajshahi', 'London', 'Berlin', 'Toronto', 'Sydney', 'Nairobi', 'Lagos', 'Cairo'];
const COUNTRY = ['Bangladesh', 'United Kingdom', 'Germany', 'Canada', 'Australia', 'Kenya', 'Nigeria', 'Egypt'];
const DEPT = ['Finance', 'Human Resources', 'Operations', 'IT', 'Procurement', 'Legal', 'Sales'];
const TITLE = ['Analyst', 'Senior Analyst', 'Manager', 'Engineer', 'Officer', 'Director', 'Assistant'];
const PRODUCT = ['Steel Rod', 'Cement Bag', 'Cable Drum', 'Pipe 2in', 'Valve Set', 'Paint 5L', 'Bolt Pack'];
const CURR = ['BDT', 'USD', 'EUR', 'GBP'];
const MAKE = ['Toyota', 'Honda', 'Nissan', 'Ford', 'Hyundai', 'Tata'];
const MODEL = ['Corolla', 'Civic', 'Sunny', 'Ranger', 'Elantra', 'Nexon'];
const FUEL = ['Petrol', 'Diesel', 'Hybrid', 'Electric', 'CNG'];
const COURSE = ['Mathematics', 'Physics', 'Chemistry', 'Economics', 'Computer Science', 'History'];
const BRANCH = ['Gulshan', 'Motijheel', 'Dhanmondi', 'Mirpur', 'Uttara', 'Banani'];

const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
const pad = (n, w) => String(n).padStart(w, '0');
const dateBetween = (r, y0, y1) => new Date(y0 + Math.floor(r() * (y1 - y0 + 1)), Math.floor(r() * 12), 1 + Math.floor(r() * 28));
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1, 2)}-${pad(d.getDate(), 2)}`;
const dmy = d => `${pad(d.getDate(), 2)}/${pad(d.getMonth() + 1, 2)}/${d.getFullYear()}`;
const money = (r, lo, hi) => Math.round((lo + r() * (hi - lo)) * 100) / 100;

/* Formatting noise applied to some comparison values (not real differences) */
function fmtNoise(v, r) {
  if (v === null || v === undefined) return v;
  if (v instanceof Date) return r() < 0.5 ? iso(v) : dmy(v);
  if (typeof v === 'number') return r() < 0.5 ? v.toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(v) ? 0 : 2 }) : v;
  if (typeof v === 'string') { const x = r(); return x < 0.3 ? v.toUpperCase() : x < 0.6 ? '  ' + v + ' ' : v; }
  return v;
}

/*
 * Concept definition: { gen(r, i, row) -> value, src: header|null, cmp: header|null, cat, noise? }
 * gen receives the shared per-record object so related concepts can be consistent.
 */
const DOMAINS = [
  // ---------------- DEV ----------------
  {
    id: 'customers', split: 'dev', rows: 400,
    concepts: [
      { key: true, gen: (r, i) => 'C' + pad(10000 + i, 6), src: 'Customer ID', cmp: 'Customer ID', cat: 'exact' },
      { gen: (r, i, o) => (o.fn = pick(r, FIRST)) + ' ' + (o.ln = pick(r, LAST)), src: 'Customer Name', cmp: 'Name of Customer', cat: 'abbrev_reorder' },
      { gen: r => dateBetween(r, 1950, 2004), src: 'Date of Birth', cmp: 'Birth Date', cat: 'synonym', noise: true },
      { gen: (r, i, o) => `${o.fn}.${o.ln}${i}@mail.com`.toLowerCase(), src: 'E-mail', cmp: 'email_address', cat: 'format' },
      { gen: r => '+8801' + pad(Math.floor(r() * 1e9), 9), src: 'Mobile No', cmp: 'Contact Number', cat: 'synonym' },
      { gen: r => pick(r, CITY), src: 'Billing City', cmp: 'Bill City', cat: 'abbrev_reorder' },
      { gen: r => pick(r, CITY), corr: { of: 'Billing City', p: 0.75 }, src: 'Shipping City', cmp: 'Ship-To City', cat: 'abbrev_reorder' },
      { gen: r => pick(r, COUNTRY), src: 'Country', cmp: 'COUNTRY NAME', cat: 'format' },
      { gen: r => (r() < 0.6 ? 'Y' : 'N'), src: 'Is Active', cmp: 'Active Flag', cat: 'synonym' },
      { gen: r => (r() < 0.5 ? 'Y' : 'N'), src: 'Is Verified', cmp: null, cat: 'distractor' },
      { gen: r => (r() < 0.5 ? 'Y' : 'N'), src: null, cmp: 'Newsletter Opt In', cat: 'distractor' },
      { gen: r => money(r, 0, 50000), src: 'Credit Limit', cmp: 'Credit Lmt', cat: 'abbrev_reorder', noise: true },
      { gen: r => dateBetween(r, 2015, 2025), src: 'Registration Date', cmp: null, cat: 'distractor' },
      { gen: r => dateBetween(r, 2015, 2025), src: null, cmp: 'Last Login Date', cat: 'distractor' },
      { gen: r => 'SEG-' + Math.floor(r() * 5), src: 'Segment', cmp: 'Field 7', cat: 'misleading' }
    ]
  },
  {
    id: 'employees', split: 'dev', rows: 350,
    concepts: [
      { key: true, gen: (r, i) => 'E' + pad(500 + i, 5), src: 'Emp No', cmp: 'Employee Number', cat: 'abbrev_reorder' },
      { gen: r => pick(r, FIRST), src: 'First Name', cmp: 'Given Name', cat: 'synonym' },
      { gen: r => pick(r, LAST), src: 'Last Name', cmp: 'Surname', cat: 'synonym' },
      { gen: r => pick(r, DEPT), src: 'Department', cmp: 'Dept', cat: 'abbrev_reorder' },
      { gen: r => pick(r, TITLE), src: 'Designation', cmp: 'Job Title', cat: 'synonym' },
      { gen: r => dateBetween(r, 2005, 2024), src: 'Joining Date', cmp: 'Hire Date', cat: 'synonym', noise: true },
      { gen: r => dateBetween(r, 2005, 2024), corr: { of: 'Joining Date', p: 0.8 }, src: 'Contract Start Date', cmp: null, cat: 'distractor' },
      { gen: r => (r() < 0.15 ? dateBetween(r, 2020, 2025) : null), src: 'Termination Date', cmp: 'Separation Date', cat: 'synonym' },
      { gen: r => money(r, 20000, 250000), src: 'Basic Salary', cmp: 'Base Pay', cat: 'different_name', noise: true },
      { gen: r => (r() < 0.5 ? 'Male' : 'Female'), src: 'Gender', cmp: 'Sex', cat: 'synonym' },
      { gen: r => pick(r, BRANCH), src: 'Office Location', cmp: 'Work Site', cat: 'different_name' },
      { gen: r => pick(r, BRANCH), src: 'Home District', cmp: null, cat: 'distractor' },
      { gen: r => 'E' + pad(500 + Math.floor(r() * 50), 5), src: 'Manager ID', cmp: 'Reports To', cat: 'different_name' },
      { gen: r => Math.floor(r() * 30), src: 'Leave Balance', cmp: null, cat: 'distractor' },
      { gen: r => Math.floor(r() * 30), src: null, cmp: 'Overtime Hours', cat: 'distractor' }
    ]
  },
  {
    id: 'orders', split: 'dev', rows: 500,
    concepts: [
      { key: true, gen: (r, i) => 'SO-' + (70000 + i), src: 'Order No.', cmp: 'order_number', cat: 'format' },
      { gen: r => dateBetween(r, 2023, 2025), src: 'Order Date', cmp: 'OrderDate', cat: 'format', noise: true },
      { gen: r => dateBetween(r, 2023, 2025), src: 'Ship Date', cmp: 'Dispatch Date', cat: 'synonym', noise: true },
      { gen: r => dateBetween(r, 2023, 2025), corr: { of: 'Ship Date', p: 0.6 }, src: null, cmp: 'Delivery Date', cat: 'distractor' },
      { gen: r => 'C' + pad(10000 + Math.floor(r() * 300), 6), src: 'Cust ID', cmp: 'Customer Code', cat: 'abbrev_reorder' },
      { gen: r => pick(r, PRODUCT), src: 'Item Description', cmp: 'Product Name', cat: 'different_name' },
      { gen: r => 1 + Math.floor(r() * 40), src: 'Qty', cmp: 'Quantity Ordered', cat: 'abbrev_reorder' },
      { gen: r => money(r, 5, 900), src: 'Unit Price', cmp: 'Price Per Unit', cat: 'abbrev_reorder', noise: true },
      { gen: r => money(r, 50, 30000), src: 'Total Amount', cmp: 'Order Total', cat: 'abbrev_reorder', noise: true },
      { gen: r => money(r, 0, 500), src: 'Discount', cmp: null, cat: 'distractor' },
      { gen: r => money(r, 0, 500), src: null, cmp: 'Tax Amount', cat: 'distractor' },
      { gen: r => pick(r, CURR), src: 'Curr', cmp: 'Currency Code', cat: 'abbrev_reorder' },
      { gen: r => pick(r, ['Open', 'Shipped', 'Closed', 'Cancelled']), src: 'Order Status', cmp: 'Status', cat: 'ambiguous' },
      { gen: r => pick(r, ['Paid', 'Unpaid', 'Partial']), src: 'Payment Status', cmp: null, cat: 'distractor' }
    ]
  },
  // ---------------- HOLD-OUT (not used to tune the lexicon) ----------------
  {
    id: 'invoices', split: 'holdout', rows: 450,
    concepts: [
      { key: true, gen: (r, i) => 'INV/' + (2024000 + i), src: 'Invoice Ref', cmp: 'Bill Number', cat: 'different_name' },
      { gen: r => dateBetween(r, 2024, 2025), src: 'Invoice Date', cmp: 'Bill Dt', cat: 'abbrev_reorder', noise: true },
      { gen: r => dateBetween(r, 2024, 2025), src: 'Due Date', cmp: 'Payment Due', cat: 'abbrev_reorder', noise: true },
      { gen: r => 'V' + pad(Math.floor(r() * 200), 4), src: 'Vendor Code', cmp: 'Supplier No', cat: 'synonym' },
      { gen: r => pick(r, ['Acme Ltd', 'Delta Traders', 'Nova Supplies', 'Orion Steel', 'Zenith Corp']), src: 'Vendor Name', cmp: 'Supplier', cat: 'synonym' },
      { gen: r => money(r, 100, 90000), src: 'Net Amount', cmp: 'Amount (excl. VAT)', cat: 'different_name', noise: true },
      { gen: r => money(r, 0, 9000), src: 'VAT', cmp: 'Tax Value', cat: 'synonym', noise: true },
      { gen: r => money(r, 100, 99000), src: 'Gross Amount', cmp: 'Invoice Total', cat: 'different_name', noise: true },
      { gen: r => 'PO-' + (9000 + Math.floor(r() * 400)), src: 'PO Number', cmp: 'Purchase Order Ref', cat: 'abbrev_reorder' },
      { gen: r => pick(r, ['Approved', 'Pending', 'Rejected']), src: 'Approval Status', cmp: 'Status', cat: 'ambiguous' },
      { gen: r => pick(r, ['Paid', 'Unpaid']), src: 'Payment Status', cmp: null, cat: 'distractor' },
      { gen: r => money(r, 100, 99000), corr: { of: 'Gross Amount', p: 0.7 }, src: null, cmp: 'Paid Amount', cat: 'distractor' },
      { gen: r => 'GL' + (4000 + Math.floor(r() * 30)), src: 'GL Account', cmp: 'Col_B', cat: 'misleading' },
      { gen: r => pick(r, BRANCH), src: null, cmp: 'Cost Centre', cat: 'distractor' }
    ]
  },
  {
    id: 'fleet', split: 'holdout', rows: 300,
    concepts: [
      { key: true, gen: (r, i) => 'DHA-' + pad(1000 + i, 4), src: 'Registration No', cmp: 'Plate Number', cat: 'synonym' },
      { gen: r => 'VIN' + pad(Math.floor(r() * 1e9), 10), src: 'Chassis Number', cmp: 'VIN', cat: 'synonym' },
      { gen: r => pick(r, MAKE), src: 'Make', cmp: 'Manufacturer', cat: 'synonym' },
      { gen: r => pick(r, MODEL), src: 'Model', cmp: 'Vehicle Model', cat: 'abbrev_reorder' },
      { gen: r => 2005 + Math.floor(r() * 20), src: 'Year of Manufacture', cmp: 'Mfg Year', cat: 'abbrev_reorder' },
      { gen: r => pick(r, FUEL), src: 'Fuel Type', cmp: 'Energy Source', cat: 'different_name' },
      { gen: r => Math.floor(r() * 250000), src: 'Odometer (km)', cmp: 'Mileage', cat: 'different_name' },
      { gen: r => dateBetween(r, 2025, 2027), src: 'Insurance Expiry', cmp: 'Policy End Date', cat: 'different_name', noise: true },
      { gen: r => dateBetween(r, 2025, 2027), src: 'Fitness Expiry', cmp: null, cat: 'distractor' },
      { gen: r => pick(r, FIRST) + ' ' + pick(r, LAST), src: 'Assigned Driver', cmp: 'Driver Name', cat: 'abbrev_reorder' },
      { gen: r => pick(r, BRANCH), src: 'Depot', cmp: 'Home Base', cat: 'different_name' },
      { gen: r => pick(r, ['Active', 'In Repair', 'Retired']), src: null, cmp: 'Status', cat: 'distractor' }
    ]
  },
  {
    id: 'students', split: 'holdout', rows: 380,
    concepts: [
      { key: true, gen: (r, i) => 'S' + (202400 + i), src: 'Student ID', cmp: 'Roll No', cat: 'different_name' },
      { gen: r => pick(r, FIRST) + ' ' + pick(r, LAST), src: 'Full Name', cmp: 'Student Name', cat: 'abbrev_reorder' },
      { gen: r => pick(r, FIRST) + ' ' + pick(r, LAST), src: "Father's Name", cmp: 'Guardian', cat: 'different_name' },
      { gen: r => dateBetween(r, 1998, 2007), src: 'DOB', cmp: 'Date Of Birth', cat: 'abbrev_reorder', noise: true },
      { gen: r => pick(r, COURSE), src: 'Programme', cmp: 'Course', cat: 'synonym' },
      { gen: r => Math.round((2 + r() * 2) * 100) / 100, src: 'CGPA', cmp: 'Grade Point Avg', cat: 'abbrev_reorder' },
      { gen: r => dateBetween(r, 2018, 2024), src: 'Admission Date', cmp: 'Enrolment Date', cat: 'synonym', noise: true },
      { gen: r => dateBetween(r, 2018, 2024), src: null, cmp: 'Graduation Date', cat: 'distractor' },
      { gen: r => pick(r, CITY), src: 'Hometown', cmp: 'City', cat: 'ambiguous' },
      { gen: r => pick(r, CITY), corr: { of: 'Hometown', p: 0.8 }, src: 'Permanent City', cmp: null, cat: 'distractor' },
      { gen: r => (r() < 0.5 ? 'Yes' : 'No'), src: 'Scholarship', cmp: 'Has Scholarship', cat: 'abbrev_reorder' },
      { gen: r => (r() < 0.5 ? 'Yes' : 'No'), src: 'Hostel Resident', cmp: null, cat: 'distractor' },
      { gen: r => Math.floor(r() * 20000), src: 'Tuition Due', cmp: 'Outstanding Fees', cat: 'different_name', noise: true }
    ]
  },
  {
    id: 'loans', split: 'holdout', rows: 420,
    concepts: [
      { key: true, gen: (r, i) => 'LN' + (880000 + i * 7), src: 'Client Reference', cmp: 'Account Identifier', cat: 'different_name' },
      { gen: r => pick(r, FIRST) + ' ' + pick(r, LAST), src: 'Borrower', cmp: 'Customer Name', cat: 'different_name' },
      { gen: r => money(r, 50000, 5000000), src: 'Principal', cmp: 'Loan Amount', cat: 'different_name', noise: true },
      { gen: r => money(r, 50000, 5000000), corr: { of: 'Principal', p: 0.85 }, src: 'Sanctioned Amount', cmp: null, cat: 'distractor' },
      { gen: r => money(r, 0, 4000000), src: 'Outstanding Balance', cmp: 'O/S Bal', cat: 'abbrev_reorder', noise: true },
      { gen: r => Math.round((7 + r() * 8) * 100) / 100, src: 'Interest Rate %', cmp: 'Rate of Interest', cat: 'abbrev_reorder' },
      { gen: r => dateBetween(r, 2018, 2024), src: 'Disbursement Date', cmp: 'Disbursed On', cat: 'abbrev_reorder', noise: true },
      { gen: r => dateBetween(r, 2026, 2035), src: 'Maturity Date', cmp: 'Loan End Date', cat: 'different_name', noise: true },
      { gen: r => 12 * (1 + Math.floor(r() * 10)), src: 'Tenure (Months)', cmp: 'Term Months', cat: 'synonym' },
      { gen: r => pick(r, BRANCH), src: 'Branch', cmp: 'Branch Name', cat: 'abbrev_reorder' },
      { gen: r => pick(r, ['Standard', 'SMA', 'Substandard', 'Doubtful', 'Bad']), src: 'Classification', cmp: 'Asset Class', cat: 'ambiguous' },
      { gen: r => money(r, 0, 100000), src: 'Overdue Amount', cmp: null, cat: 'distractor' },
      { gen: r => money(r, 0, 100000), src: null, cmp: 'Provision Amount', cat: 'distractor' },
      { gen: r => '+8801' + pad(Math.floor(r() * 1e9), 9), src: 'Phone', cmp: 'Col_9', cat: 'misleading' }
    ]
  }
];

/*
 * Build one benchmark case.
 * overlap: share of compare records that reuse source keys (1 = same records;
 *          0 = disjoint record sets, which forces name/profile-only matching).
 */
/* Generate one record; concepts with `corr` copy another concept's value with probability p
   (models look-alike columns such as Shipping City usually equal to Billing City). */
function genRecord(domain, r, i, o, rec) {
  domain.concepts.forEach((c, ci) => { rec[ci] = c.gen(r, i, o); });
  domain.concepts.forEach((c, ci) => {
    if (!c.corr) return;
    const j = domain.concepts.findIndex(x => x.src === c.corr.of || x.cmp === c.corr.of);
    if (j >= 0 && r() < c.corr.p) rec[ci] = rec[j];
  });
}

function buildCase(domain, opts) {
  opts = opts || {};
  const overlap = opts.overlap === undefined ? 0.85 : opts.overlap;
  const conflictRate = opts.conflictRate === undefined ? 0.04 : opts.conflictRate;
  const r = rng(opts.seed || 7);
  const src = { name: domain.id + '_client.xlsx', headers: [], rows: [] };
  const cmp = { name: domain.id + '_system.xlsx', headers: [], rows: [] };
  const srcCols = domain.concepts.filter(c => c.src);
  const cmpCols = domain.concepts.filter(c => c.cmp);
  src.headers = srcCols.map(c => c.src);
  // Compare file uses a different column order (a realistic trap for position-based matching)
  const order = cmpCols.map((c, i) => ({ c, k: r() })).sort((a, b) => a.k - b.k).map(x => x.c);
  cmp.headers = order.map(c => c.cmp);

  const records = [];
  for (let i = 0; i < domain.rows; i++) {
    const o = {};
    const rec = {};
    genRecord(domain, r, i, o, rec);
    records.push(rec);
  }
  records.forEach(rec => {
    const row = {};
    domain.concepts.forEach((c, ci) => { if (c.src) row[c.src] = rec[ci]; });
    src.rows.push(row);
  });
  const nShared = Math.round(domain.rows * overlap);
  const extra = [];
  for (let i = 0; i < domain.rows - nShared; i++) {
    const o = {}, rec = {};
    genRecord(domain, r, 100000 + i, o, rec);
    extra.push(rec);
  }
  const cmpRecords = records.slice(0, nShared).concat(extra);
  cmpRecords.forEach(rec => {
    const row = {};
    domain.concepts.forEach((c, ci) => {
      if (!c.cmp) return;
      let v = rec[ci];
      if (!c.key) {
        // compare-only concepts must be independent of the source
        if (!c.src) { /* compare-only column: keep the record's own (possibly correlated) value */ }
        else if (r() < conflictRate) v = c.gen(r, 0, {});         // genuine conflict
        else if (r() < 0.04) v = null;                              // blank in system
        else if (c.noise || r() < 0.15) v = fmtNoise(v, r);         // formatting only
      }
      row[c.cmp] = v;
    });
    cmp.rows.push(row);
  });
  // shuffle compare rows (row order must not matter)
  for (let i = cmp.rows.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [cmp.rows[i], cmp.rows[j]] = [cmp.rows[j], cmp.rows[i]]; }

  const truth = cmpCols.map(c => ({ compare: c.cmp, source: c.src, cat: c.src ? c.cat : 'distractor', key: !!c.key }));
  return { id: domain.id + (opts.suffix || ''), split: domain.split, source: src, compare: cmp, truth };
}

function allCases() {
  const out = [];
  DOMAINS.forEach((d, i) => {
    out.push(buildCase(d, { seed: 11 + i, overlap: 0.85, suffix: '' }));
    // Same schema, no shared records: only names and column profiles are available
    out.push(buildCase(d, { seed: 101 + i, overlap: 0, suffix: '#no-overlap' }));
    // Dirty data: 30% of values genuinely conflict and only 60% of records are shared
    out.push(buildCase(d, { seed: 201 + i, overlap: 0.6, conflictRate: 0.3, suffix: '#dirty' }));
  });
  return out;
}

module.exports = { DOMAINS, buildCase, allCases, rng };
