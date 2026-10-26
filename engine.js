/* Reconciliation engine v3 — pure logic, no DOM. Works in browsers (window.Reconcile) and Node (require). */
(function (root) {
  'use strict';
  const VERSION = '3.0.0';

  /* ======================================================================
   * Tunable thresholds. Change these only after re-running
   * `npm run benchmark` and checking the precision of auto-accepted matches.
   * ==================================================================== */
  const THRESHOLDS = {
    accept: 0.80,          // confidence needed to auto-accept a mapping
    review: 0.50,          // below this a column is "unresolved" (no proposal used)
    margin: 0.12,          // auto-accept also needs this lead over the best competing column
    exactMargin: 0.05,     // smaller lead required when the header names are identical
    candidateFloor: 0.30,  // pairs below this are not offered as candidates at all
    minComparable: 12,     // joined records with values on both sides needed for value evidence
    sampleSize: 3000,      // joined records sampled for value evidence (keeps matching O(columns² × 3000))
    profileSample: 3000,   // values sampled per column for profiles
    keyUniqueness: 0.95,   // share of distinct values a key column needs
    keyOverlap: 0.30,      // share of key values that must appear in the other file
    valueKnee: 0.7
                           // chance-corrected agreement at which value evidence counts as fully "related".
                           // Dirty UAT data still maps; look-alike columns are separated by competition.
  };

  // ================= value helpers =================
  const BLANK_TOKENS = new Set(['', 'null', 'nan', 'none', 'n/a', 'na', 'nat', 'undefined', '#n/a', '-', '--']);
  const PLACEHOLDER_TOKENS = new Set(['other', 'unknown', 'not specified', 'default', 'tbd', 'select', 'not available', '0000-00-00']);

  function isBlank(v) {
    if (v === null || v === undefined) return true;
    if (typeof v === 'number') return !isFinite(v);
    if (v instanceof Date) return isNaN(v.getTime());
    if (typeof v === 'boolean') return false;
    return BLANK_TOKENS.has(String(v).replace(/\u00a0/g, ' ').trim().toLowerCase());
  }
  const pad2 = n => String(n).padStart(2, '0');
  /* Dates from SheetJS are local-midnight Date objects. Use LOCAL components:
     toISOString() converts to UTC and shifts the day for UTC+ time zones (e.g. Dhaka). */
  function dateParts(d) {
    let t = d.getTime();
    // Excel serial dates can carry sub-minute floating error; round to the nearest minute
    t = Math.round(t / 60000) * 60000;
    const x = new Date(t);
    return { y: x.getFullYear(), m: x.getMonth() + 1, d: x.getDate(), hh: x.getHours(), mi: x.getMinutes(), ss: x.getSeconds() };
  }
  function fmtDate(p) {
    const base = `${p.y}-${pad2(p.m)}-${pad2(p.d)}`;
    return (p.hh || p.mi || p.ss) ? `${base} ${pad2(p.hh)}:${pad2(p.mi)}${p.ss ? ':' + pad2(p.ss) : ''}` : base;
  }
  /* Human-readable original value (used in UI and reports; never changes the stored value) */
  function displayValue(v) {
    if (v === null || v === undefined) return '';
    if (v instanceof Date) return isNaN(v.getTime()) ? '' : fmtDate(dateParts(v));
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    return String(v);
  }
  function normText(v) {
    if (isBlank(v)) return '';
    if (v instanceof Date) return fmtDate(dateParts(v));
    return String(v).replace(/\u00a0/g, ' ').trim().toLowerCase().replace(/\s+/g, ' ');
  }
  function normPhone(v) {
    if (isBlank(v)) return '';
    const digits = String(typeof v === 'number' ? Math.round(v) : v).replace(/\D/g, '');
    return digits.length >= 9 ? digits.slice(-9) : digits;
  }
  function normName(v) {
    let s = normText(v);
    if (!s) return '';
    s = s.replace(/\b(md|mr|mrs|ms|miss|dr|prof|mst|engr)\b\.?/g, ' ');
    return s.replace(/[^\p{L}\p{N}]+/gu, '');
  }
  function tokensOf(v) {
    if (isBlank(v)) return [];
    return normText(v).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  }
  function isPlaceholder(v) { return PLACEHOLDER_TOKENS.has(normText(v)); }

  // Garbled text: UTF-8 read as Windows-1252 ("BrÃ©gard"). Repaired only when the result is valid UTF-8.
  const CP1252_HIGH = [0x20AC, 0x81, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0x8D, 0x017D, 0x8F,
    0x90, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014, 0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0x9D, 0x017E, 0x0178];
  const CP1252_REV = new Map(CP1252_HIGH.map((cp, i) => [cp, 0x80 + i]));
  function unmojibake(v) {
    if (typeof v !== 'string' || !/[\u0080-\u00FF\u20AC\u201A-\u2122]/.test(v)) return null;
    const bytes = [];
    for (const ch of v) {
      const cp = ch.codePointAt(0);
      if (cp < 256) bytes.push(cp);
      else if (CP1252_REV.has(cp)) bytes.push(CP1252_REV.get(cp));
      else return null;
    }
    try {
      const out = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
      return out !== v ? out : null;
    } catch (e) { return null; }
  }
  function repaired(v) { const f = unmojibake(v); return f === null ? v : f; }
  function keyNorm(v) {
    if (isBlank(v)) return '';
    if (typeof v === 'number' && Number.isInteger(v)) return String(v);
    let s = normText(repaired(v));
    if (/^0*\d+(\.0+)?$/.test(s)) s = s.replace(/\.0+$/, '');   // "1234.0" (number stored as text) == 1234
    return s;
  }
  function isTruthy(v) {
    if (v === true || v === 1) return true;
    const s = normText(v);
    return s === 'true' || s === '1' || s === 'yes' || s === 'y' || s === 'active';
  }

  // ================= typed parsing =================
  const CURRENCY_RE = /^(?:[$€£¥৳₹]|bdt|usd|eur|gbp|inr|tk\.?)\s*|\s*(?:[$€£¥৳₹]|bdt|usd|eur|gbp|inr|tk\.?)$/i;
  /* Returns { n, lz } or null. lz = leading zeros were present ("00123"), which matters for codes. */
  function parseNumber(v) {
    if (typeof v === 'number') return isFinite(v) ? { n: v, lz: false } : null;
    if (typeof v !== 'string') return null;
    let s = v.replace(/\u00a0/g, ' ').trim();
    if (!s || s.length > 40) return null;
    let neg = false;
    if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1).trim(); }
    s = s.replace(CURRENCY_RE, '').trim();
    let pctv = false;
    if (s.endsWith('%')) { pctv = true; s = s.slice(0, -1).trim(); }
    if (/^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
    else if (/^[+-]?\d{1,3}( \d{3})+(\.\d+)?$/.test(s)) s = s.replace(/ /g, '');
    if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return null;
    let n = Number(s);
    if (!isFinite(n)) return null;
    if (neg) n = -n;
    if (pctv) n = n / 100;
    return { n, lz: /^[+-]?0\d/.test(s), pct: pctv };
  }
  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
    january: 1, february: 2, march: 3, april: 4, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
  function validYMD(y, m, d) {
    if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1000 || y > 9999) return false;
    const dt = new Date(y, m - 1, d);
    return dt.getMonth() === m - 1 && dt.getDate() === d;
  }
  /*
   * Parse a value as a calendar date. order: 'dmy' | 'mdy' | null (unknown).
   * Returns { key:'YYYY-MM-DD[ hh:mm]', alt?:key } or null.
   * `alt` is set when a numeric d/m/y string is ambiguous and the column order is unknown.
   */
  function parseDate(v, order, allowSerial) {
    if (v instanceof Date) return isNaN(v.getTime()) ? null : { key: fmtDate(dateParts(v)) };
    if (typeof v === 'number') {
      if (!allowSerial || v < 1 || v > 2958465) return null;
      // Excel serial day number (1900 system)
      const ms = Math.round((v - 25569) * 86400000);
      const u = new Date(ms);
      const p = { y: u.getUTCFullYear(), m: u.getUTCMonth() + 1, d: u.getUTCDate(), hh: u.getUTCHours(), mi: u.getUTCMinutes(), ss: 0 };
      return { key: fmtDate(p) };
    }
    if (typeof v !== 'string') return null;
    const s = v.trim();
    let m, time = '';
    const tm = s.match(/[ T](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*(am|pm)?(?:Z|[+-]\d{2}:?\d{2})?$/i);
    let body = s;
    if (tm) {
      let hh = +tm[1];
      if (tm[4]) { const pm = /pm/i.test(tm[4]); if (hh === 12) hh = pm ? 12 : 0; else if (pm) hh += 12; }
      if (hh || +tm[2] || +(tm[3] || 0)) time = ` ${pad2(hh)}:${pad2(+tm[2])}${+(tm[3] || 0) ? ':' + pad2(+tm[3]) : ''}`;
      body = s.slice(0, tm.index).trim();
    }
    const mk = (y, mo, d) => validYMD(y, mo, d) ? `${y}-${pad2(mo)}-${pad2(d)}${time}` : null;
    if ((m = body.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/))) { const k = mk(+m[1], +m[2], +m[3]); return k ? { key: k } : null; }
    if ((m = body.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/))) {
      let y = +m[3]; if (m[3].length === 2) y += y < 50 ? 2000 : 1900;
      const a = +m[1], b = +m[2];
      const dmy = mk(y, b, a), mdy = mk(y, a, b);
      if (order === 'dmy') return dmy ? { key: dmy } : null;
      if (order === 'mdy') return mdy ? { key: mdy } : null;
      if (dmy && mdy && dmy !== mdy) return { key: dmy, alt: mdy };
      return dmy || mdy ? { key: dmy || mdy } : null;
    }
    if ((m = body.match(/^(\d{1,2})[-\s/.]([A-Za-z]{3,9})[-\s/.,]+(\d{2}|\d{4})$/))) {
      const mo = MONTHS[m[2].toLowerCase()]; let y = +m[3]; if (m[3].length === 2) y += y < 50 ? 2000 : 1900;
      const k = mo ? mk(y, mo, +m[1]) : null; return k ? { key: k } : null;
    }
    if ((m = body.match(/^([A-Za-z]{3,9})[-\s/.]+(\d{1,2}),?[-\s/.]+(\d{4})$/))) {
      const mo = MONTHS[m[1].toLowerCase()]; const k = mo ? mk(+m[3], mo, +m[2]) : null; return k ? { key: k } : null;
    }

    return null;
  }
  const BOOL_T = new Set(['y', 'yes', 'true', 't', '1', 'active', 'on']);
  const BOOL_F = new Set(['n', 'no', 'false', 'f', '0', 'inactive', 'off']);
  function parseBool(v) {
    if (typeof v === 'boolean') return v;
    if (v === 1 || v === 0) return v === 1;
    const s = normText(v);
    if (BOOL_T.has(s)) return true;
    if (BOOL_F.has(s)) return false;
    return null;
  }

  // ================= value TYPE (not value) =================
  function typeOf(v) {
    if (isBlank(v)) return 'blank';
    if (v instanceof Date) return 'datetime';
    if (typeof v === 'boolean') return 'bool';
    if (typeof v === 'number') {
      if (Number.isInteger(v) && String(Math.abs(v)).length >= 11) return 'phone';
      return Number.isInteger(v) ? 'integer' : 'decimal';
    }
    const s = String(v).trim();
    if (/^[\w.+-]+@[\w-]+(\.[\w-]+)+$/.test(s)) return 'email';
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return 'guid';
    if (/^\+?[\d\s\-()]{9,}$/.test(s) && s.replace(/\D/g, '').length >= 10 && /[\s\-()+]|^0/.test(s)) return 'phone';
    if (parseDate(s, null, false)) return 'date';
    if (parseNumber(s)) return /^[+-]?\d+$/.test(s.replace(/[, ]/g, '')) ? 'integer' : 'decimal';
    if (parseBool(s) !== null && s.length <= 5) return 'bool';
    if (/^[A-Za-z0-9_\-/.]+$/.test(s) && /\d/.test(s)) return 'code';
    return 'text';
  }
  const TYPE_GROUP = { text: 'text', code: 'text', integer: 'num', decimal: 'num', phone: 'phone', date: 'date', datetime: 'date', email: 'email', guid: 'guid', bool: 'bool' };
  function typeHist(values) {
    const h = {}; let n = 0;
    values.forEach(v => {
      const t = typeOf(v); if (t === 'blank') return;
      const g = TYPE_GROUP[t] || 'text'; h[g] = (h[g] || 0) + 1; n++;
    });
    Object.keys(h).forEach(k => { h[k] /= n; });
    return { h, n };
  }
  // Groups that are often legitimately stored as each other
  const SOFT_COMPAT = { 'num|text': 0.5, 'bool|text': 0.8, 'bool|num': 0.7, 'phone|num': 0.9, 'phone|text': 0.5, 'date|num': 0.3, 'email|text': 0.6, 'guid|text': 0.7 };
  function typeSim(a, b) {
    if (!a.n || !b.n) return 0;
    let s = 0;
    Object.keys(a.h).forEach(ka => Object.keys(b.h).forEach(kb => {
      const w = ka === kb ? 1 : (SOFT_COMPAT[ka + '|' + kb] || SOFT_COMPAT[kb + '|' + ka] || 0);
      if (w) s += w * Math.min(a.h[ka], b.h[kb]);
    }));
    return Math.min(1, s);
  }
  function dominantType(th) {
    let best = null, bv = 0;
    Object.keys(th.h).forEach(k => { if (th.h[k] > bv) { bv = th.h[k]; best = k; } });
    return bv >= 0.6 ? best : 'mixed';
  }

  // ================= header normalisation & name evidence =================
  function cleanHeader(h) { return String(h === null || h === undefined ? '' : h).replace(/\s+/g, ' ').trim(); }
  function hkey(h) { return cleanHeader(h).toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''); }

  // Abbreviation expansion (token -> canonical tokens). General business vocabulary.
  const ABBR = {
    no: ['number'], num: ['number'], nbr: ['number'], nr: ['number'], numb: ['number'], nos: ['number'],
    identifier: ['id'], ident: ['id'], ref: ['reference'], refno: ['reference', 'number'],
    cust: ['customer'], clnt: ['client'], emp: ['employee'], empl: ['employee'], dept: ['department'], dpt: ['department'],
    desig: ['designation'], addr: ['address'], tel: ['telephone'], ph: ['phone'], mob: ['mobile'], mobl: ['mobile'],
    acct: ['account'], acc: ['account'], bal: ['balance'], amt: ['amount'], qty: ['quantity'], dt: ['date'],
    yr: ['year'], yrs: ['year'], mth: ['month'], mon: ['month'], curr: ['currency'], ccy: ['currency'], cur: ['currency'],
    desc: ['description'], descr: ['description'], mgr: ['manager'], org: ['organization'], dob: ['date', 'birth'], doj: ['date', 'joining'],
    pct: ['percent'], perc: ['percent'], avg: ['average'], tot: ['total'], lmt: ['limit'], mfg: ['manufacture'], mfr: ['manufacturer'],
    fname: ['first', 'name'], lname: ['last', 'name'], reg: ['registration'], regn: ['registration'], cat: ['category'],
    grp: ['group'], loc: ['location'], txn: ['transaction'], trx: ['transaction'], pmt: ['payment'], pymt: ['payment'],
    sal: ['salary'], hrs: ['hour'], hr: ['hour'], ctry: ['country'], cntry: ['country'], nm: ['name'], cd: ['code'],
    typ: ['type'], flg: ['flag'], ind: ['indicator'], sts: ['status'], stat: ['status'], excl: ['excluding'], incl: ['including'],
    email: ['email'], mail: ['email'], ship: ['shipping'], bill: ['billing']
  };
  const STOP = new Set(['of', 'the', 'a', 'an', 'in', 'on', 'for', 'to', 'by', 'per', 'and', 'at', 'as', 'is', 'has', 'with', 'from']);
  const STEM_EXCEPT = new Set(['status', 'address', 'gross', 'class', 'business', 'previous', 'bus', 'tax', 'yes', 'process', 'access', 'news', 'series', 'analysis', 'basis', 'alias', 'campus', 'bonus', 'surplus', 'plus', 'minus', 'days', 'loss', 'pass']);
  function stem(t) {
    if (t.length <= 3 || STEM_EXCEPT.has(t) || /\d/.test(t)) return t;
    let s = t;
    if (/ies$/.test(s) && s.length > 4) s = s.slice(0, -3) + 'y';
    else if (/(ss|us|is)$/.test(s)) { /* keep */ }
    else if (/s$/.test(s)) s = s.slice(0, -1);
    if (/ing$/.test(s) && s.length > 5) { s = s.slice(0, -3); if (/(bb|dd|gg|ll|mm|nn|pp|rr|tt)$/.test(s)) s = s.slice(0, -1); }
    else if (/ed$/.test(s) && s.length > 5) { s = s.slice(0, -2); if (/(bb|dd|gg|ll|mm|nn|pp|rr|tt)$/.test(s)) s = s.slice(0, -1); }
    if (/ment$/.test(s) && s.length > 7) s = s.slice(0, -4);
    return s;
  }
  // Raw word split: camelCase, separators, unicode letters/digits
  function rawWords(label) {
    let s = String(label == null ? '' : label);
    s = s.replace(/\b[oO]\/[sS]\b/g, ' outstanding ').replace(/\b[aA]\/[cC]\b/g, ' account ').replace(/#/g, ' number ').replace(/%/g, ' percent ').replace(/&/g, ' and ');
    s = s.replace(/'s\b/gi, '').replace(/([\p{Ll}\d])(\p{Lu})/gu, '$1 $2').replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1 $2');
    return s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  }
  // Canonical tokens: abbreviations expanded, stop words removed, light stemming
  function canonTokens(label) {
    const out = [];
    rawWords(label).forEach(w => {
      const exp = ABBR[w] || [w];
      exp.forEach(t => { if (!STOP.has(t)) out.push(stem(t)); });
    });
    return out;
  }

  /*
   * Concept lexicon: phrases that mean the same business field. Kept deliberately
   * narrow: a wrong synonym produces confident wrong matches. Single generic words
   * ("name", "status", "title", "job") are NOT synonyms of anything.
   */
  const SYN_GROUPS = [
    ['email', 'email address', 'e mail', 'primary email', 'work email', 'user email', 'email id'],
    ['gender', 'sex', 'person gender'],
    ['country', 'country name', 'nation'],
    ['phone', 'phone number', 'mobile', 'mobile number', 'telephone', 'telephone number', 'contact number', 'cell', 'cell phone', 'contact phone', 'cell number'],
    ['designation', 'job title', 'position', 'position title'],
    ['office', 'office name'],
    ['location', 'location name', 'site', 'work site', 'work location'],
    ['branch', 'branch name'],
    ['full name', 'employee name', 'display name'],
    ['first name', 'given name', 'forename'],
    ['last name', 'surname', 'family name'],
    ['middle name', 'second name'],
    ['employee id', 'employee number', 'staff id', 'staff number', 'personnel number', 'person number', 'employee code', 'staff no'],
    ['postal code', 'zip', 'zip code', 'postcode', 'post code'],
    ['active', 'active flag', 'enabled'],
    ['region', 'region name'],
    ['manager', 'manager name', 'reporting manager', 'supervisor', 'supervisor name', 'line manager'],
    ['fuel', 'fuel type', 'fuel name', 'fuel category', 'energy type', 'energy source', 'power source', 'powertrain', 'propulsion type'],
    ['registration number', 'plate number', 'license plate', 'licence plate', 'number plate', 'vehicle registration'],
    ['vin', 'vehicle identification number', 'chassis number'],
    ['make', 'manufacturer', 'vehicle make', 'brand'],
    ['department', 'department name', 'business unit', 'division'],
    ['date of birth', 'birth date', 'birthday'],
    ['start date', 'effective date', 'valid from', 'commencement date', 'from date'],
    ['end date', 'expiry date', 'expiration date', 'valid to', 'to date'],
    ['salary', 'basic salary', 'base salary', 'basic pay', 'base pay', 'monthly salary'],
    ['currency', 'currency code'],
    ['unit price', 'price per unit', 'unit cost', 'rate per unit'],
    ['address', 'street address', 'mailing address', 'address line'],
    ['city', 'town'],
    ['state', 'province'],
    ['hire date', 'joining date', 'date joined', 'join date', 'date of joining', 'employment date'],
    ['termination date', 'separation date', 'leaving date', 'last working day', 'exit date'],
    ['quantity'],
    ['description', 'details'],
    ['remarks', 'comments', 'notes', 'comment', 'note'],
    ['category', 'classification'],
    ['account number', 'account no'],
    ['tax id', 'tax number', 'tin', 'vat number', 'vat registration number'],
    ['customer id', 'customer number', 'customer code', 'client id', 'client number', 'client code'],
    ['ship date', 'shipping date', 'shipped date', 'dispatch date', 'dispatched date'],
    ['order total', 'order amount', 'order value'],
    ['product name', 'item name']
  ];
  const CONCEPT = new Map();   // canonical phrase -> concept index
  SYN_GROUPS.forEach((g, i) => g.forEach(p => CONCEPT.set(canonTokens(p).join(' '), i)));
  const MAX_PHRASE = 4;
  // Replace the longest known phrases in a token list with concept tokens ("c:12")
  function conceptualize(tokens) {
    const out = [];
    for (let i = 0; i < tokens.length;) {
      let hit = null;
      for (let L = Math.min(MAX_PHRASE, tokens.length - i); L >= 1; L--) {
        const k = CONCEPT.get(tokens.slice(i, i + L).join(' '));
        if (k !== undefined) { hit = { k, L }; break; }
      }
      if (hit) { out.push('c:' + hit.k); i += hit.L; } else { out.push(tokens[i]); i++; }
    }
    return out;
  }
  // Role words describe WHAT KIND of value a column holds. Different roles = different fields.
  const ROLE = {
    id: 'ID', number: 'ID', code: 'ID', reference: 'ID', key: 'ID', serial: 'ID',
    name: 'NAME',
    date: 'DATE', time: 'DATE', timestamp: 'DATE', day: 'DATE',
    amount: 'AMOUNT', total: 'AMOUNT', balance: 'AMOUNT', price: 'AMOUNT', cost: 'AMOUNT', fee: 'AMOUNT', sum: 'AMOUNT',
    quantity: 'QTY', count: 'QTY',
    flag: 'FLAG', indicator: 'FLAG',
    rate: 'RATE', percent: 'RATE', ratio: 'RATE',
    year: 'YEAR'
  };
  // Words that carry almost no meaning on their own
  const GENERIC = new Set(['status', 'type', 'value', 'data', 'info', 'detail', 'field', 'column', 'col', 'item', 'record', 'misc', 'other', 'unnamed']);
  function rolesOf(tokens) {
    const s = new Set();
    tokens.forEach(t => { if (ROLE[t]) s.add(ROLE[t]); });
    // phone numbers, account numbers and vehicle numbers are identifiers/contact values, not counts
    return s;
  }
  // Single-token synonyms used by the soft token matcher
  const TOKEN_SYN = new Map();
  SYN_GROUPS.forEach((g, i) => g.forEach(p => { const t = canonTokens(p); if (t.length === 1) TOKEN_SYN.set(t[0], i); }));

  function lev(a, b) {
    if (a === b) return 0;
    const m = a.length, n = b.length;
    if (!m) return n; if (!n) return m;
    // Optimal string alignment distance: a swap of two adjacent letters ("emial") costs 1
    let pp = new Array(n + 1).fill(0), prev = new Array(n + 1), cur = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
      cur[0] = i;
      for (let j = 1; j <= n; j++) {
        const c = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + c);
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) cur[j] = Math.min(cur[j], pp[j - 2] + 1);
      }
      [pp, prev, cur] = [prev, cur, pp];
    }
    return prev[n];
  }
  function levRatio(a, b) { const L = Math.max(a.length, b.length); return L ? 1 - lev(a, b) / L : 1; }
  // "qty" is an abbreviation of "quantity" when its letters appear in order and the first letter matches
  function isAbbrevOf(s, l) {
    if (s.length < 3 || l.length < s.length + 2 || s[0] !== l[0]) return false;
    let j = 0;
    for (let i = 0; i < l.length && j < s.length; i++) if (l[i] === s[j]) j++;
    return j === s.length;
  }
  function tokSim(x, y) {
    if (x === y) return 1;
    if (x.startsWith('c:') || y.startsWith('c:')) {
      const cx = x.startsWith('c:') ? +x.slice(2) : TOKEN_SYN.get(x), cy = y.startsWith('c:') ? +y.slice(2) : TOKEN_SYN.get(y);
      return cx !== undefined && cx === cy ? 0.92 : 0;
    }
    const sx = TOKEN_SYN.get(x), sy = TOKEN_SYN.get(y);
    if (sx !== undefined && sx === sy) return 0.92;
    if (isAbbrevOf(x, y) || isAbbrevOf(y, x)) return 0.85;
    if (Math.min(x.length, y.length) >= 4) { const r = levRatio(x, y); if (r >= 0.8) return 0.9 * r; }
    return 0;
  }

  /*
   * Header analysis is cached per label. `df` (document frequency of each token across the
   * headers of both files) is supplied by the caller so common words such as "date" weigh less
   * when a file has many date columns.
   */
  const headerCache = new Map();
  function analyzeHeader(label) {
    const k = String(label);
    if (headerCache.has(k)) return headerCache.get(k);
    const canon = canonTokens(label);
    const concept = conceptualize(canon);
    const roles = rolesOf(canon);
    const informative = concept.filter(t => !ROLE[t] && !GENERIC.has(t));
    const informativeCanon = canon.filter(t => !ROLE[t] && !GENERIC.has(t));
    const H = { label: k, key: hkey(label), canon, concept, roles, informative, informativeCanon, genericOnly: informative.length === 0 };
    if (headerCache.size > 5000) headerCache.clear();
    headerCache.set(k, H);
    return H;
  }
  function softSim(ta, tb, weight) {
    if (!ta.length || !tb.length) return 0;
    const dir = (P, Q) => {
      let num = 0, den = 0;
      P.forEach(p => {
        const w = weight(p);
        let best = 0; Q.forEach(q => { const s = tokSim(p, q); if (s > best) best = s; });
        num += w * best; den += w;
      });
      return den ? num / den : 0;
    };
    return (dir(ta, tb) + dir(tb, ta)) / 2;
  }
  function sameSet(a, b) { const A = new Set(a), B = new Set(b); return A.size === B.size && [...A].every(x => B.has(x)); }

  /*
   * Stage 1 — name evidence. Returns { score 0..1, how, conflict, generic }.
   * ctx.df: Map token -> document frequency (optional)
   */
  function nameScore(labelA, labelB, ctx) {
    const A = analyzeHeader(labelA), B = analyzeHeader(labelB);
    const df = ctx && ctx.df;
    const weight = t => {
      let w = df ? 1 / (1 + Math.log(Math.max(1, df.get(t) || 1))) : 1;
      if (ROLE[t]) w *= 0.5;
      if (GENERIC.has(t)) w *= 0.3;
      return w;
    };
    const out = (score, how, extra) => Object.assign({ score: Math.max(0, Math.min(1, score)), how }, extra || {});
    if (A.key && A.key === B.key) return out(1, 'exact name');
    const roleConflict = A.roles.size && B.roles.size && ![...A.roles].some(r => B.roles.has(r));
    let score, how;
    if (A.canon.length && sameSet(A.canon, B.canon)) { score = 0.96; how = 'same words (abbreviation, order or format differs)'; }
    else if (A.concept.length && sameSet(A.concept, B.concept)) { score = 0.92; how = 'synonym'; }
    else {
      // Compare both with synonym phrases collapsed and with the raw canonical words (catches typos inside a phrase)
      const s = Math.max(softSim(A.concept, B.concept, weight), softSim(A.canon, B.canon, weight));
      score = 0.85 * s;
      how = s >= 0.75 ? 'mostly the same words' : s >= 0.45 ? 'some shared words' : s > 0 ? 'weak word overlap' : 'no shared words';
      const r = levRatio(A.key, B.key);
      if (r >= 0.85 && 0.9 * r > score) { score = 0.9 * r; how = 'spelling variant'; }
    }
    const res = { conflict: false, generic: false };
    if (roleConflict) {
      score = Math.min(score, 0.2);
      how += ` — but different kinds of field (${[...A.roles].join('/').toLowerCase()} vs ${[...B.roles].join('/').toLowerCase()})`;
      res.conflict = true;
    } else if ((A.genericOnly || B.genericOnly) && !(A.genericOnly && B.genericOnly && sameSet(A.canon, B.canon))) {
      if (score > 0.55) { score = 0.55; how += ' — generic name, needs other evidence'; }
      res.generic = true;
    } else if (score < 0.92) {
      // "Title" vs "Job Title", "City" vs "Permanent City": the shorter name is less specific
      const lessSpecific = (xa, xb) => {
        const ia = new Set(xa), ib = new Set(xb);
        const [small, big] = ia.size <= ib.size ? [ia, ib] : [ib, ia];
        return small.size === 1 && big.size > 1 && [...small].every(t => big.has(t));
      };
      if ((lessSpecific(A.informative, B.informative) || lessSpecific(A.informativeCanon, B.informativeCanon)) && score > 0.55) {
        score = 0.55; how += ' — one name is less specific, needs other evidence'; res.generic = true;
      }
    }
    return out(score, how, res);
  }

  // Kind of comparison for a column pair (drives value normalisation)
  function detectKind(h) {
    const k = hkey(h);
    if (/(phone|mobile|telephone|cell|contact(no|number))/.test(k) && !/e?mail/.test(k)) return 'phone';
    if (/e?mail/.test(k)) return 'email';
    if (/^(full|first|last|given|family|sur|display|person|employee|customer|client)?name$/.test(k)) return 'name';
    if (/(date|dob|time)$/.test(k)) return 'date';
    return 'text';
  }
  function pairKind(a, b) {
    const ta = a.profile ? a.profile.dominant : null, tb = b.profile ? b.profile.dominant : null;
    const ka = a.kind || detectKind(a.label || a), kb = b.kind || detectKind(b.label || b);
    if (ka === 'phone' || kb === 'phone' || ta === 'phone' || tb === 'phone') return 'phone';
    if (ka === 'email' || kb === 'email') return 'email';
    if (ta === 'date' || tb === 'date') return 'date';
    if (ta === 'bool' && tb === 'bool') return 'bool';
    if (ta === 'num' && tb === 'num') return 'number';
    if (ka === 'name' || kb === 'name') return 'name';
    return 'text';
  }

  // ================= value comparison =================
  /*
   * Compare one source value with one comparison value.
   * Returns { s: status, why: explanation }
   * status: exact | format | encoding | mismatch | uncomparable | blank_source | blank_compare | both_blank
   * ctx: { kind, orderA, orderB, tolerance }
   */
  function compareCell(vSrc, vCmp, ctx) {
    ctx = ctx || {};
    const bs = isBlank(vSrc), bc = isBlank(vCmp);
    if (bs && bc) return { s: 'both_blank', why: '' };
    if (bs) return { s: 'blank_source', why: 'Source value is blank' };
    if (bc) return { s: 'blank_compare', why: 'Comparison value is blank' };
    // identical value of identical type
    if (vSrc instanceof Date && vCmp instanceof Date) {
      const a = fmtDate(dateParts(vSrc)), b = fmtDate(dateParts(vCmp));
      return a === b ? { s: 'exact', why: '' } : { s: 'mismatch', why: `Dates differ (${a} vs ${b})` };
    }
    if (typeof vSrc === typeof vCmp && typeof vSrc !== 'object') {
      if (typeof vSrc === 'number' && vSrc === vCmp) return { s: 'exact', why: '' };
      if (typeof vSrc === 'string' && vSrc.replace(/\u00a0/g, ' ').trim() === vCmp.replace(/\u00a0/g, ' ').trim()) return { s: 'exact', why: '' };
      if (typeof vSrc === 'boolean' && vSrc === vCmp) return { s: 'exact', why: '' };
    }
    const kind = ctx.kind || 'text';
    // ---- dates
    const isDateLike = x => x instanceof Date || (typeof x === 'string' && !!parseDate(x, null, false));
    if (kind === 'date' || vSrc instanceof Date || vCmp instanceof Date) {
      const da = parseDate(vSrc, ctx.orderA, isDateLike(vCmp)), db = parseDate(vCmp, ctx.orderB, isDateLike(vSrc));
      if (da && db) {
        const A = [da.key].concat(da.alt ? [da.alt] : []), B = [db.key].concat(db.alt ? [db.alt] : []);
        const anyEq = A.some(x => B.includes(x)), allEq = A.every(x => B.every(y => x === y));
        if (allEq) return { s: 'format', why: 'Same date, different format' };
        if (!anyEq) return { s: 'mismatch', why: `Dates differ (${da.key} vs ${db.key})` };
        return { s: 'uncomparable', why: 'Day/month order is ambiguous (e.g. 03/04 could be 3 April or 4 March)' };
      }
      if (kind === 'date' && (da || db)) return { s: 'uncomparable', why: `${da ? 'Comparison' : 'Source'} value is not a recognisable date` };
    }
    // ---- booleans
    if (kind === 'bool') {
      const ba = parseBool(vSrc), bb = parseBool(vCmp);
      if (ba !== null && bb !== null) return ba === bb ? { s: 'format', why: 'Same yes/no value, different notation' } : { s: 'mismatch', why: 'Yes/no values differ' };
    }
    // ---- numbers
    if (kind !== 'phone') {
      const na = parseNumber(vSrc), nb = parseNumber(vCmp);
      if (na && nb) {
        const tol = ctx.tolerance || 0;
        const diff = Math.abs(na.n - nb.n);
        const eq = diff <= Math.max(1e-9 * Math.max(Math.abs(na.n), Math.abs(nb.n)), tol);
        if (eq) return { s: 'format', why: (na.lz || nb.lz) ? 'Same number; leading zeros differ' : 'Same number, different formatting' };
        if (na.pct !== nb.pct && Math.abs(na.n * 100 - nb.n) < 1e-9) return { s: 'format', why: 'Same value written as percent and number' };
        if (na.pct !== nb.pct && Math.abs(nb.n * 100 - na.n) < 1e-9) return { s: 'format', why: 'Same value written as percent and number' };
        return { s: 'mismatch', why: `Numbers differ by ${+(nb.n - na.n).toPrecision(6)}` };
      }
      if (kind === 'number' && (na || nb)) return { s: 'uncomparable', why: `${na ? 'Comparison' : 'Source'} value is not a number` };
    }
    // ---- text-like
    if (normText(vSrc) === normText(vCmp)) return { s: 'format', why: 'Differs only in case or spacing' };
    if (kind === 'phone') { const a = normPhone(vSrc); if (a && a.length >= 7 && a === normPhone(vCmp)) return { s: 'format', why: 'Same phone number, different prefix or punctuation' }; }
    if (kind === 'name') { const a = normName(vSrc); if (a && a === normName(vCmp)) return { s: 'format', why: 'Same name; titles or punctuation differ' }; }
    const pa = String(vSrc).replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase(), pb = String(vCmp).replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();
    if (pa && pa === pb) return { s: 'format', why: 'Differs only in punctuation or spacing' };
    const fs = unmojibake(vSrc), fd = unmojibake(vCmp);
    if ((fd !== null && normText(fd) === normText(vSrc)) || (fs !== null && normText(fs) === normText(vCmp)) || (fs !== null && fd !== null && normText(fs) === normText(fd)))
      return { s: 'encoding', why: 'Same text, but one side has garbled characters (encoding problem)' };
    return { s: 'mismatch', why: 'Values differ' };
  }
  // Backwards-compatible: returns status string. ("blank_db" was renamed "blank_compare" in v3.)
  function compareValues(vSrc, vCmp, kind) { return compareCell(vSrc, vCmp, { kind: kind === 'phone' || kind === 'name' || kind === 'date' ? kind : 'text' }).s; }

  // Equivalence used while MATCHING columns (looser than reporting: format differences count as equal)
  function equivalent(va, vb, kind) {
    const s = compareCell(va, vb, { kind }).s;
    return s === 'exact' || s === 'format' || s === 'encoding';
  }
  // Soft similarity 0..1 used for free text while matching
  function rowSimilarity(va, vb) {
    const ba = isBlank(va), bb = isBlank(vb);
    if (ba && bb) return null;
    if (ba || bb) return 0;
    const ra = repaired(va), rb = repaired(vb);
    if (normText(ra) === normText(rb)) return 1;
    const na = normName(ra), nb = normName(rb);
    if (na && na === nb) return 0.97;
    const pa = normPhone(va), pb = normPhone(vb);
    if (pa && pa === pb && pa.length >= 7) return 0.97;
    const ta = new Set(tokensOf(ra)), tb = new Set(tokensOf(rb));
    if (!ta.size || !tb.size) return 0;
    let inter = 0; ta.forEach(t => { if (tb.has(t)) inter++; });
    return inter / (ta.size + tb.size - inter);
  }

  function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

  // ================= worksheet ingestion =================
  /*
   * Build a sheet table from an array-of-arrays (SheetJS sheet_to_json header:1 output).
   * opts.firstRow: 1-based Excel row number of aoa[0] (from the sheet's !ref)
   * Returns { headers, rows, headerRow, warnings } where each row has a hidden __row (Excel row number).
   */
  function tableFromAOA(aoa, opts) {
    opts = opts || {};
    const firstRow = opts.firstRow || 1;
    const warnings = [];
    const nonBlank = r => (r || []).filter(v => !isBlank(v)).length;
    // Header row: first row among the first 30 with at least 2 filled cells, most filled wins ties
    let hi = -1, best = 0;
    for (let i = 0; i < Math.min(aoa.length, 30); i++) {
      const n = nonBlank(aoa[i]);
      if (n >= 2 && n > best * 1.5) { hi = i; best = n; if (i === 0 || n >= 3) break; }
    }
    if (hi < 0) {
      if (!aoa.some(r => nonBlank(r))) return { headers: [], rows: [], headerRow: null, warnings: ['Worksheet is empty'], empty: true };
      hi = aoa.findIndex(r => nonBlank(r) >= 1);
      warnings.push('No clear header row found; using row ' + (firstRow + hi));
    }
    const seen = {}, dupes = [];
    const width = Math.max(...aoa.slice(hi, hi + 200).map(r => (r || []).length), 0);
    const headers = [];
    for (let i = 0; i < width; i++) {
      const raw = aoa[hi] ? aoa[hi][i] : null;
      let t = cleanHeader(raw instanceof Date ? displayValue(raw) : raw) || ('Column ' + (i + 1));
      if (seen[t.toLowerCase()]) { seen[t.toLowerCase()]++; dupes.push(t); t = t + ' (' + seen[t.toLowerCase()] + ')'; } else seen[t.toLowerCase()] = 1;
      headers.push(t);
    }
    if (dupes.length) warnings.push('Duplicate column names were renamed: ' + [...new Set(dupes)].join(', '));
    const unnamed = headers.filter(h => /^Column \d+$/.test(h)).length;
    if (unnamed) warnings.push(unnamed + ' column(s) have no header and were named "Column N"');
    const rows = [];
    for (let i = hi + 1; i < aoa.length; i++) {
      const r = aoa[i];
      if (!r || !r.some(v => !isBlank(v))) continue;
      const o = {};
      headers.forEach((h, j) => { o[h] = r[j] === undefined ? null : r[j]; });
      Object.defineProperty(o, '__row', { value: firstRow + i, enumerable: false });
      rows.push(o);
    }
    if (!rows.length) warnings.push('Header found but no data rows');
    return { headers, rows, headerRow: firstRow + hi, warnings };
  }

  /*
   * Read one SheetJS worksheet into a table. XLSX is the SheetJS module (passed in so the engine
   * has no hard dependency). Excel row numbers are preserved for traceability.
   */
  function readSheet(XLSX, ws, opts) {
    if (!ws || !ws['!ref']) return { headers: [], rows: [], headerRow: null, warnings: ['Worksheet is empty'], empty: true };
    const range = XLSX.utils.decode_range(ws['!ref']);
    const aoa = XLSX.utils.sheet_to_json(ws, Object.assign({ header: 1, defval: null, raw: true, blankrows: true }, opts || {}));
    return tableFromAOA(aoa, { firstRow: range.s.r + 1 });
  }

  // ================= column profiles =================
  function shapeOf(v) {
    const s = displayValue(v).trim();
    if (s.length > 40) return 'long';
    return s.replace(/\p{L}/gu, 'a').replace(/\d/g, '9').replace(/(a{3,})/g, 'a+').replace(/(9{3,})/g, m => '9' + (m.length > 6 ? '+' : m.length));
  }
  function profileColumn(F, c) {
    const rows = F.rows, n = rows.length;
    const step = Math.max(1, Math.floor(n / THRESHOLDS.profileSample));
    const vals = []; let blanks = 0, seenCount = 0;
    for (let i = 0; i < n; i += step) { seenCount++; const v = c.get(rows[i]); if (isBlank(v)) blanks++; else vals.push(v); }
    const th = typeHist(vals);
    const dom = dominantType(th);
    const normVals = vals.map(keyNorm);
    const freq = new Map(); normVals.forEach(v => freq.set(v, (freq.get(v) || 0) + 1));
    const shapes = new Map(); vals.forEach(v => { const s = shapeOf(v); shapes.set(s, (shapes.get(s) || 0) + 1); });
    let order = null;
    if (dom === 'date') {
      let d = false, m = false;
      vals.forEach(v => { if (typeof v === 'string') { const x = v.trim().match(/^(\d{1,2})[-/.](\d{1,2})[-/.]\d{2,4}/); if (x) { if (+x[1] > 12) d = true; if (+x[2] > 12) m = true; } } });
      order = d && !m ? 'dmy' : m && !d ? 'mdy' : null;
    }
    let nums = null;
    if (dom === 'num') {
      const xs = vals.map(parseNumber).filter(Boolean).map(x => x.n);
      if (xs.length) { const mean = xs.reduce((t, x) => t + x, 0) / xs.length; nums = { min: Math.min(...xs), max: Math.max(...xs), mean, int: xs.every(Number.isInteger) }; }
    }
    const avgLen = vals.length ? vals.reduce((t, v) => t + displayValue(v).length, 0) / vals.length : 0;
    return {
      fill: seenCount ? 1 - blanks / seenCount : 0, nonBlank: vals.length, distinct: freq.size,
      distinctRatio: vals.length ? freq.size / vals.length : 0, typeHist: th, dominant: dom, freq, shapes, order, nums, avgLen
    };
  }
  function histIntersect(m1, n1, m2, n2) {
    if (!n1 || !n2) return 0;
    let s = 0; m1.forEach((c, k) => { if (m2.has(k)) s += Math.min(c / n1, m2.get(k) / n2); });
    return s;
  }
  /* Profile similarity without joined records: type, uniqueness, shape, length, shared value domain */
  function profileSimilarity(pa, pb) {
    const ts = typeSim(pa.typeHist, pb.typeHist);
    const uniq = 1 - Math.abs(pa.distinctRatio - pb.distinctRatio);
    const shp = histIntersect(pa.shapes, pa.nonBlank, pb.shapes, pb.nonBlank);
    const len = pa.avgLen && pb.avgLen ? Math.min(pa.avgLen, pb.avgLen) / Math.max(pa.avgLen, pb.avgLen) : 0;
    // overlap of distinct values (meaningful for categorical columns such as country or currency)
    let inter = 0; pa.freq.forEach((c, k) => { if (pb.freq.has(k)) inter++; });
    const containment = Math.min(pa.distinct, pb.distinct) ? inter / Math.min(pa.distinct, pb.distinct) : 0;
    let numSim = null;
    if (pa.nums && pb.nums) {
      const lo = Math.max(pa.nums.min, pb.nums.min), hi = Math.min(pa.nums.max, pb.nums.max);
      const span = Math.max(pa.nums.max, pb.nums.max) - Math.min(pa.nums.min, pb.nums.min);
      numSim = span > 0 ? Math.max(0, hi - lo) / span : 1;
    }
    const score = 0.35 * ts + 0.15 * uniq + 0.2 * shp + 0.1 * len + 0.2 * (numSim === null ? containment : Math.max(numSim, containment));
    return { score, ts, uniq, shape: shp, containment, numSim };
  }

  // ================= file preparation =================
  // Input: { name, sheetName?, headers: [string], rows: [object keyed by header] }
  function prepareFile(file) {
    const headers = file.headers.map(cleanHeader);
    const cols = headers.map((h, i) => ({ id: h, label: h, index: i, scoreKey: hkey(h), kind: detectKind(h), virtual: false, get: r => r[h] }));
    const firstC = cols.find(c => /^(firstname|givenname|fname)$/.test(c.scoreKey));
    const lastC = cols.find(c => /^(lastname|surname|familyname|lname)$/.test(c.scoreKey));
    if (firstC && lastC) {
      cols.push({
        id: '__first_last', label: firstC.label + ' + ' + lastC.label, index: cols.length, scoreKey: 'fullname', kind: 'name', virtual: true,
        get: r => [firstC.get(r), lastC.get(r)].filter(x => !isBlank(x)).map(String).join(' ')
      });
    }
    const F = { name: file.name, sheetName: file.sheetName || null, fileNames: file.fileNames || [file.name], rows: file.rows, cols, colsById: Object.fromEntries(cols.map(c => [c.id, c])) };
    cols.forEach(c => { c.profile = profileColumn(F, c); c.typeHist = c.profile.typeHist; });
    return F;
  }
  function rowNumberOf(row, fallbackIndex) { return row && row.__row ? row.__row : (fallbackIndex === undefined ? null : fallbackIndex + 2); }

  function indexRows(rows, col) {
    const m = new Map();
    rows.forEach((r, i) => { const k = keyNorm(col.get(r)); if (!k) return; if (!m.has(k)) m.set(k, []); m.get(k).push(i); });
    return m;
  }
  function rowCompleteness(F, i) {
    const r = F.rows[i]; let n = 0;
    F.cols.forEach(c => { if (!c.virtual && !isBlank(c.get(r))) n++; });
    const act = F.cols.find(c => !c.virtual && /^(isactive|active|activeflag)$/.test(c.scoreKey));
    if (act && isTruthy(act.get(r))) n += 1000;
    return n;
  }

  // ================= key detection =================
  function distinctSet(F, col) {
    if (col._distinct) return col._distinct;
    const set = new Set(); let nonBlank = 0;
    F.rows.forEach(r => { const k = keyNorm(col.get(r)); if (k) { set.add(k); nonBlank++; } });
    col._distinct = { set, n: set.size, ratio: nonBlank ? set.size / nonBlank : 0, nonBlank, fill: F.rows.length ? nonBlank / F.rows.length : 0 };
    return col._distinct;
  }
  /* How much a column looks like a record identifier (not an amount or free text that happens to be unique) */
  function keyLikeness(c) {
    const H = analyzeHeader(c.label), p = c.profile || {};
    let s = 0;
    if (H.roles.has('ID') || /(^|[^a-z])(id|key|code|ref|no|number|email|username|login)([^a-z]|$)/i.test(c.label.replace(/([a-z])([A-Z])/g, '$1 $2'))) s += 0.06;
    if (H.roles.has('AMOUNT') || H.roles.has('QTY') || H.roles.has('RATE') || H.roles.has('NAME')) s -= 0.08;
    if (p.dominant === 'num' && p.nums && !p.nums.int) s -= 0.08;     // decimals are measurements, not identifiers
    if (p.dominant === 'text' && p.avgLen > 25) s -= 0.04;            // long free text
    if (p.dominant === 'email' || p.dominant === 'guid') s += 0.03;
    return s;
  }
  // Returns { best, alternatives }; each candidate { aId, bId, overlap, score, auto, reason }
  function detectKeys(A, B) {
    const cands = [];
    const keyable = (F, c) => !c.virtual && c.kind !== 'phone' && c.profile.dominant !== 'date' && c.profile.dominant !== 'bool';
    const As = A.cols.filter(c => keyable(A, c)).map(c => ({ c, d: distinctSet(A, c) })).filter(x => x.d.n > 0 && x.d.ratio >= THRESHOLDS.keyUniqueness && x.d.fill >= 0.5);
    const Bs = B.cols.filter(c => keyable(B, c)).map(c => ({ c, d: distinctSet(B, c) })).filter(x => x.d.n > 0 && x.d.ratio >= THRESHOLDS.keyUniqueness && x.d.fill >= 0.5);
    for (const a of As) for (const b of Bs) {
      const [small, big] = a.d.n <= b.d.n ? [a.d.set, b.d.set] : [b.d.set, a.d.set];
      let inter = 0; small.forEach(v => { if (big.has(v)) inter++; });
      const overlap = inter / Math.min(a.d.n, b.d.n);
      if (overlap < THRESHOLDS.keyOverlap) continue;
      const ns = nameScore(a.c.label, b.c.label).score;
      const score = overlap + 0.05 * ns + 0.02 * Math.min(a.d.fill, b.d.fill) + keyLikeness(a.c) + keyLikeness(b.c);
      cands.push({ aId: a.c.id, bId: b.c.id, overlap, score, auto: true, reason: `${Math.round(overlap * 100)}% of key values found in both files` });
    }
    cands.sort((x, y) => y.score - x.score);
    return { best: cands[0] || null, alternatives: cands.slice(1, 6) };
  }
  function detectKey(A, B) { return detectKeys(A, B).best; }

  // ================= join =================
  function joinOn(A, B, keyA, keyB) {
    const idxB = indexRows(B.rows, keyB), idxA = indexRows(A.rows, keyA);
    const pairs = [], sourceOnly = [], blankKeyA = [];
    A.rows.forEach((r, i) => {
      const k = keyNorm(keyA.get(r));
      if (!k) { blankKeyA.push(i); return; }
      const bi = idxB.get(k);
      if (bi) {
        const pick = bi.length === 1 ? bi[0] : bi.slice().sort((x, y) => rowCompleteness(B, y) - rowCompleteness(B, x) || x - y)[0];
        pairs.push({ key: k, ia: i, ib: pick, dupB: bi.length > 1 });
      } else sourceOnly.push(i);
    });
    const dbOnly = [], blankKeyB = [];
    B.rows.forEach((r, i) => { const k = keyNorm(keyB.get(r)); if (!k) { blankKeyB.push(i); return; } if (!idxA.has(k)) dbOnly.push(i); });
    const dupB = [], dupA = [];
    idxB.forEach((idx, k) => { if (idx.length > 1) dupB.push({ key: k, rows: idx }); });
    idxA.forEach((idx, k) => { if (idx.length > 1) dupA.push({ key: k, rows: idx }); });
    return { pairs, sourceOnly, dbOnly, blankKeyA, blankKeyB, dupA, dupB };
  }

  // ================= value evidence on joined records =================
  /*
   * Chance-corrected agreement. Two unrelated Yes/No columns agree ~50% of the time by chance,
   * so raw agreement is misleading. We compare observed agreement on joined records with the
   * agreement of deliberately mis-aligned records (record i vs record i+k) and report
   *   corrected = (observed - chance) / (1 - chance)
   */
  /*
   * Type-aware canonical key of one value, computed once per sampled value per column
   * (so matching costs columns² × sample string comparisons, not columns² × sample parses).
   */
  function matchKey(v, c) {
    if (isBlank(v)) return null;
    const p = c.profile || {}, dom = p.dominant;
    if (v instanceof Date) return 'd:' + fmtDate(dateParts(v));
    if (c.kind === 'phone' || dom === 'phone') { const d = normPhone(v); if (d.length >= 7) return 'p:' + d; }
    if (dom === 'date' && typeof v === 'string') { const d = parseDate(v, p.order, false); if (d) return 'd:' + d.key; }
    if (dom === 'bool' || (typeof v === 'boolean')) { const b = parseBool(v); if (b !== null) return 'b:' + (b ? 1 : 0); }
    const n = parseNumber(v);
    if (n) return 'n:' + String(+n.n.toPrecision(12));
    return 't:' + normText(repaired(v));
  }
  function columnSample(F, c, sample, side, cache) {
    const k = side + c.id;
    if (cache.has(k)) return cache.get(k);
    const textual = c.kind === 'name' || c.profile.dominant === 'text' || c.profile.dominant === 'mixed';
    const keys = new Array(sample.length), toks = textual ? new Array(sample.length) : null, names = textual ? new Array(sample.length) : null;
    for (let i = 0; i < sample.length; i++) {
      const v = c.get(F.rows[side === 'A' ? sample[i].ia : sample[i].ib]);
      keys[i] = matchKey(v, c);
      if (textual && keys[i] !== null) { toks[i] = new Set(tokensOf(repaired(v))); names[i] = normName(repaired(v)); }
    }
    const out = { keys, toks, names };
    cache.set(k, out);
    return out;
  }
  function softPair(sa, sb, i, j) {
    const ka = sa.keys[i], kb = sb.keys[j];
    if (ka === kb) return 1;
    if (sa.names && sb.names) {
      if (sa.names[i] && sa.names[i] === sb.names[j]) return 0.97;
      const ta = sa.toks[i], tb = sb.toks[j];
      if (!ta || !tb || !ta.size || !tb.size) return 0;
      let inter = 0; ta.forEach(t => { if (tb.has(t)) inter++; });
      return inter / (ta.size + tb.size - inter);
    }
    return 0;
  }
  /*
   * Chance-corrected agreement. Two unrelated Yes/No columns agree ~50% of the time by chance,
   * so raw agreement is misleading. We compare observed agreement on joined records with the
   * agreement of deliberately mis-aligned records (record i vs record i+k) and report
   *   corrected = (observed - chance) / (1 - chance)
   */
  function valueEvidence(A, B, a, b, sample, cache) {
    const n = sample.length;
    if (!n) return null;
    cache = cache || new Map();
    const sa = columnSample(A, a, sample, 'A', cache), sb = columnSample(B, b, sample, 'B', cache);
    let comp = 0, eq = 0, soft = 0, compX = 0, eqX = 0, softX = 0;
    const shift = Math.max(1, Math.floor(n / 2) + 1);
    for (let i = 0; i < n; i++) {
      const ka = sa.keys[i];
      if (ka === null) continue;
      const kb = sb.keys[i];
      if (kb !== null) { comp++; if (ka === kb) { eq++; soft++; } else soft += softPair(sa, sb, i, i); }
      if (n > 1) {
        const j = (i + shift) % n, kx = sb.keys[j];
        if (kx !== null) { compX++; if (ka === kx) { eqX++; softX++; } else softX += softPair(sa, sb, i, j); }
      }
    }
    if (comp < THRESHOLDS.minComparable) return { comparable: comp, insufficient: true };
    const obs = eq / comp, chance = compX ? eqX / compX : 0;
    const sObs = soft / comp, sChance = compX ? softX / compX : 0;
    const corr = (o, c) => c >= 0.999 ? 0 : Math.max(0, (o - c) / (1 - c));
    const score = Math.max(corr(obs, chance), 0.9 * corr(sObs, sChance));
    return { comparable: comp, observed: obs, chance, softObserved: sObs, softChance: sChance, score };
  }
  function samplePairs(pairs) {
    const n = pairs.length, cap = THRESHOLDS.sampleSize;
    if (n <= cap) return pairs;
    const out = [], step = n / cap;
    for (let i = 0; i < cap; i++) out.push(pairs[Math.floor(i * step)]);
    return out;
  }

  // ================= combine evidence =================
  function headerDF(A, B) {
    const df = new Map();
    [A, B].forEach(F => F.cols.forEach(c => { if (c.virtual) return; const H = analyzeHeader(c.label); new Set(H.concept.concat(H.canon)).forEach(t => df.set(t, (df.get(t) || 0) + 1)); }));
    return df;
  }
  function pct0(x) { return Math.round(x * 100) + '%'; }

  /*
   * Score one (source column a, comparison column b) pair.
   * Returns a candidate with conf (0..1) and an evidence list that explains the score.
   */
  function scorePair(A, B, a, b, ctx) {
    const nm = nameScore(a.label, b.label, ctx);
    const prof = profileSimilarity(a.profile, b.profile);
    const ev = ctx.sample && ctx.sample.length ? valueEvidence(A, B, a, b, ctx.sample, ctx.cache) : null;
    const evidence = [{ type: 'name', score: nm.score, text: `Name: ${nm.how} (${pct0(nm.score)})` }];
    const cand = { aId: a.id, bId: b.id, ns: nm.score, nameHow: nm.how, nameConflict: nm.conflict, nameGeneric: nm.generic,
      ts: prof.ts, ps: prof.score, vs: null, comp: 0, kind: pairKind(a, b), evidence, flags: [] };
    // Hard type gate: dates never match amounts, emails never match names, etc.
    if (prof.ts < 0.3 && nm.score < 1) {
      cand.conf = 0; cand.rejected = true; cand.reason = `value types differ (${a.profile.dominant} vs ${b.profile.dominant})`;
      evidence.push({ type: 'type', score: prof.ts, text: `Types: ${a.profile.dominant} vs ${b.profile.dominant} — incompatible` });
      return cand;
    }
    evidence.push({ type: 'profile', score: prof.score, text: `Profile: types ${pct0(prof.ts)} compatible, value shape ${pct0(prof.shape)} similar` + (prof.containment > 0.3 ? `, ${pct0(prof.containment)} shared distinct values` : '') });
    let conf;
    if (ev && !ev.insufficient) {
      cand.vs = ev.score; cand.comp = ev.comparable; cand.observed = ev.observed; cand.chance = ev.chance;
      const related = Math.min(1, ev.score / THRESHOLDS.valueKnee);
      cand.related = related;
      evidence.push({ type: 'values', score: ev.score, text: `Values: ${pct0(ev.observed)} agree on ${ev.comparable} matched records (chance level ${pct0(ev.chance)}) → ${pct0(ev.score)} beyond chance` });
      // Saturating "related" term plus a small unsaturated term, so that among look-alike columns
      // (e.g. Hometown vs Permanent City) the one that agrees more still scores higher.
      conf = 0.30 * nm.score + 0.55 * related + 0.15 * ev.score;
      // Decisive value evidence: unrelated columns essentially never agree this well beyond chance
      if (ev.score >= 0.9 && ev.comparable >= 30 && a.profile.distinct >= 3 && !nm.conflict) {
        conf = Math.max(conf, 0.86);
        cand.flags.push('decisive-values');
      }
      // Weak values with a good name: names can be right while data is dirty, so keep it reviewable
      if (ev.score < 0.25 && nm.score >= 0.9) { conf = Math.max(conf, 0.55); cand.flags.push('name-strong-values-weak'); }
      if (ev.score < 0.15 && nm.score < 0.9) conf = Math.min(conf, 0.3);
    } else {
      if (ev && ev.insufficient) { cand.comp = ev.comparable; evidence.push({ type: 'values', score: null, text: `Values: only ${ev.comparable} matched records have both values — not enough to verify` }); }
      // Name + profile only (no shared records): never stronger than the name itself
      conf = nm.score * (0.55 + 0.45 * prof.score);
      if (prof.containment >= 0.6 && Math.min(a.profile.distinct, b.profile.distinct) >= 3 && !nm.conflict) conf = Math.min(1, conf + 0.1 * prof.containment);
      cand.flags.push('no-value-evidence');
      if (nm.score < 1) conf = Math.min(conf, 0.9);
    }
    if (prof.ts < 0.6 && nm.score < 1) conf *= 0.85;
    if (a.virtual || b.virtual) conf -= 0.04;
    if (nm.conflict && conf > 0.79) { conf = 0.79; cand.flags.push('role-conflict'); }
    cand.conf = Math.max(0, Math.min(1, conf));
    cand.reason = evidence.filter(e => e.type !== 'profile').map(e => e.text).join(' · ');
    return cand;
  }

  // Maximum-weight one-to-one assignment (Hungarian algorithm, O(n²m)).
  function assign(nRows, nCols, weight) {
    const transpose = nRows > nCols;
    const n = transpose ? nCols : nRows, m = transpose ? nRows : nCols;
    const w = (i, j) => transpose ? weight(j, i) : weight(i, j);
    const INF = 1e9, u = new Array(n + 1).fill(0), v = new Array(m + 1).fill(0), p = new Array(m + 1).fill(0), way = new Array(m + 1).fill(0);
    for (let i = 1; i <= n; i++) {
      p[0] = i; let j0 = 0;
      const minv = new Array(m + 1).fill(INF), used = new Array(m + 1).fill(false);
      do {
        used[j0] = true; const i0 = p[j0]; let delta = INF, j1 = 0;
        for (let j = 1; j <= m; j++) if (!used[j]) {
          const cur = (1 - w(i0 - 1, j - 1)) - u[i0] - v[j];
          if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
          if (minv[j] < delta) { delta = minv[j]; j1 = j; }
        }
        for (let j = 0; j <= m; j++) { if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta; }
        j0 = j1;
      } while (p[j0] !== 0);
      do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
    }
    const out = [];
    for (let j = 1; j <= m; j++) if (p[j]) out.push(transpose ? [j - 1, p[j] - 1] : [p[j] - 1, j - 1]);
    return out;
  }

  const TIER_LABEL = { confirmed: 'Confirmed', remembered: 'Remembered', high: 'Auto-accepted', medium: 'Needs review', low: 'Unresolved', manual: 'Manual' };

  /*
   * Mapping suggestion with confidence tiers.
   * opts.known:    [{aLabel, bLabel}] confirmed pairs (locked, tier "confirmed")
   * opts.rejected: [{bLabel, aLabel|null}] pairs the user rejected (aLabel null = keep compare column unmapped)
   * opts.memory:   mapping memory entries [{src, cmp, decision}] from earlier confirmed runs
   * Returns { auto, candidates, aliases, decisions, unmatchedA, unmatchedB }
   *   decisions: one per comparison column { bId, aId|null, tier, conf, margin, competitor, reason, evidence }
   *   auto:      pairs to USE in the comparison (confirmed, remembered and high tier only)
   */
  function suggestMapping(A, B, key, join, opts) {
    opts = opts || {};
    const keyA = key ? A.colsById[key.aId] : null, keyB = key ? B.colsById[key.bId] : null;
    const pairs = join ? join.pairs : [];
    const sample = samplePairs(pairs);
    const ctx = { df: headerDF(A, B), sample, cache: new Map() };

    // Key aliases: other comparison columns holding the source key values
    const aliases = [];
    if (keyA) for (const b of B.cols) {
      if (b.id === keyB.id || b.virtual) continue;
      let eq = 0, comp = 0;
      for (const p of sample) { const va = keyA.get(A.rows[p.ia]), vb = b.get(B.rows[p.ib]); if (isBlank(va) || isBlank(vb)) continue; comp++; if (keyNorm(va) === keyNorm(vb)) eq++; }
      if (comp >= 10 && eq / comp >= 0.98) aliases.push({ bId: b.id, aId: keyA.id, value: eq / comp });
    }
    const aliasB = new Set(aliases.map(x => x.bId));
    const realKeys = F => new Set(F.cols.filter(c => !c.virtual).map(c => c.scoreKey));
    const realA = realKeys(A), realB = realKeys(B);
    const skipA = new Set(A.cols.filter(c => (c.virtual && realA.has(c.scoreKey)) || (keyA && c.id === keyA.id)).map(c => c.id));
    const skipB = new Set(B.cols.filter(c => (c.virtual && realB.has(c.scoreKey)) || (keyB && c.id === keyB.id) || aliasB.has(c.id)).map(c => c.id));
    const As = A.cols.filter(c => !skipA.has(c.id)), Bs = B.cols.filter(c => !skipB.has(c.id));

    const lc = s => String(s).toLowerCase();
    const known = (opts.known || []).filter(k => k.aLabel);
    const rejectedB = new Set((opts.rejected || []).filter(r => r.aLabel === null).map(r => lc(r.bLabel)));
    const rejectedPair = new Set((opts.rejected || []).filter(r => r.aLabel !== null).map(r => lc(r.bLabel) + '\u0000' + lc(r.aLabel)));
    const memory = opts.memory || [];
    const memKey = (c) => hkey(c.label) + '|' + (c.profile ? c.profile.dominant : '');
    const memMatch = new Map(), memReject = new Set();
    memory.forEach(m => { if (m.decision === 'match') memMatch.set(m.cmp + '\u0000' + m.src, m); else if (m.decision === 'reject') memReject.add(m.cmp + '\u0000' + (m.src || '')); });

    // Score matrix
    const M = Bs.map(b => As.map(a => {
      const c = scorePair(A, B, a, b, ctx);
      if (rejectedPair.has(lc(b.label) + '\u0000' + lc(a.label)) || memReject.has(memKey(b) + '\u0000' + memKey(a))) { c.conf = 0; c.rejected = true; c.reason = 'rejected by you'; }
      return c;
    }));
    const candidates = {};
    Bs.forEach((b, i) => { candidates[b.id] = M[i].filter(c => !c.rejected && c.conf >= THRESHOLDS.candidateFloor).sort((x, y) => y.conf - x.conf).slice(0, 5); });

    // Locked pairs first: confirmed by the user, then remembered from earlier runs
    const lockedA = new Set(), lockedB = new Set(), decisions = [];
    const lock = (bi, ai, tier, why) => {
      const c = Object.assign({}, M[bi][ai], { tier, conf: 1, locked: true });
      c.reason = why + (M[bi][ai].reason ? ' · ' + M[bi][ai].reason : '');
      lockedA.add(As[ai].id); lockedB.add(Bs[bi].id);
      decisions.push(Object.assign(c, { margin: null, competitor: null }));
    };
    known.forEach(k => {
      const bi = Bs.findIndex(b => lc(b.label) === lc(k.bLabel)), ai = As.findIndex(a => lc(a.label) === lc(k.aLabel));
      if (bi >= 0 && ai >= 0 && !lockedB.has(Bs[bi].id) && !lockedA.has(As[ai].id)) lock(bi, ai, 'confirmed', 'Confirmed by you');
    });
    Bs.forEach((b, bi) => {
      if (lockedB.has(b.id) || rejectedB.has(lc(b.label))) return;
      As.forEach((a, ai) => {
        if (lockedB.has(b.id) || lockedA.has(a.id)) return;
        const m = memMatch.get(memKey(b) + '\u0000' + memKey(a));
        if (m && M[bi][ai].ts >= 0.3) lock(bi, ai, 'remembered', 'Confirmed in an earlier validation');
      });
    });

    // Optimal one-to-one assignment over the remaining columns
    const freeB = Bs.map((b, i) => i).filter(i => !lockedB.has(Bs[i].id) && !rejectedB.has(lc(Bs[i].label)));
    const freeA = As.map((a, i) => i).filter(i => !lockedA.has(As[i].id));
    const W = (i, j) => { const c = M[freeB[i]][freeA[j]]; return c.rejected || c.conf < THRESHOLDS.candidateFloor ? 0 : c.conf; };
    const assigned = freeB.length && freeA.length ? assign(freeB.length, freeA.length, W) : [];
    const chosen = new Map();
    assigned.forEach(([i, j]) => { if (W(i, j) > 0) chosen.set(freeB[i], freeA[j]); });

    freeB.forEach(bi => {
      const b = Bs[bi];
      if (!chosen.has(bi)) {
        const top = candidates[b.id][0];
        decisions.push({ bId: b.id, aId: null, tier: 'low', conf: top ? top.conf : 0, margin: null, competitor: null,
          reason: top ? `Best candidate ${A.colsById[top.aId].label} is too weak or taken by a better match (${pct0(top.conf)})` : 'No candidate column has compatible values or name', evidence: top ? top.evidence : [], suggestion: top ? top.aId : null });
        return;
      }
      const ai = chosen.get(bi), c = M[bi][ai];
      // Competition: best alternative for this comparison column AND best alternative use of this source column
      let comp = 0, compWho = null;
      As.forEach((a2, aj) => { if (aj !== ai && !M[bi][aj].rejected && M[bi][aj].conf > comp) { comp = M[bi][aj].conf; compWho = { side: 'source', id: a2.id, label: a2.label }; } });
      Bs.forEach((b2, bj) => { if (bj !== bi && !lockedB.has(b2.id) && !M[bj][ai].rejected && M[bj][ai].conf > comp) { comp = M[bj][ai].conf; compWho = { side: 'compare', id: b2.id, label: b2.label }; } });
      const margin = c.conf - comp;
      const needMargin = c.ns >= 1 ? THRESHOLDS.exactMargin : THRESHOLDS.margin;
      let tier;
      if (c.conf >= THRESHOLDS.accept && margin >= needMargin && !c.flags.includes('role-conflict')) tier = 'high';
      else if (c.conf >= THRESHOLDS.review) tier = 'medium';
      else tier = 'low';
      const d = Object.assign({}, c, { tier, margin, competitor: compWho ? Object.assign(compWho, { conf: comp }) : null });
      if (tier === 'medium' && c.conf >= THRESHOLDS.accept && margin < needMargin && compWho)
        d.reason += ` · Close alternative: ${compWho.label} (${pct0(comp)})`;
      if (tier === 'low') { d.suggestion = c.aId; d.aId = null; d.reason = `Too weak to propose (${pct0(c.conf)}): ` + c.reason; }
      decisions.push(d);
    });

    Bs.forEach(b => { if (rejectedB.has(lc(b.label))) decisions.push({ bId: b.id, aId: null, tier: 'confirmed', conf: 1, reason: 'You confirmed this column has no counterpart', evidence: [] }); });

    decisions.forEach(d => { d.label = TIER_LABEL[d.tier]; d.ambiguous = d.tier === 'medium' && !!d.competitor && d.margin !== null && d.margin < THRESHOLDS.margin; d.alternative = d.competitor && d.competitor.side === 'source' ? { aId: d.competitor.id, conf: d.competitor.conf } : null; d.stage = d.tier; });
    const auto = decisions.filter(d => d.aId && (d.tier === 'high' || d.tier === 'confirmed' || d.tier === 'remembered'));
    const proposals = decisions.filter(d => d.aId && d.tier === 'medium');
    const usedA = new Set(decisions.filter(d => d.aId).map(d => d.aId));
    const unmatchedA = As.filter(a => !a.virtual && !usedA.has(a.id)).map(a => a.id);
    const unmatchedB = decisions.filter(d => !d.aId).map(d => d.bId);
    return { auto, proposals, candidates, aliases, decisions, unmatchedA, unmatchedB };
  }

  function confLabel(conf) { return conf >= THRESHOLDS.accept ? 'High' : conf >= THRESHOLDS.review ? 'Medium' : 'Low'; }
  function mapStatus(conf, vs, ambiguous, stage) {
    if (stage === 'known' || stage === 'confirmed') return 'Confirmed';
    if (stage === 'remembered') return 'Remembered';
    if (stage === 'high') return 'Auto-accepted';
    if (stage === 'medium') return ambiguous ? 'Needs review (close alternative)' : 'Needs review';
    if (stage === 'low') return 'Unresolved';
    if (stage === 'accepted') return 'Accepted by you';
    if (stage === 'manual') return 'Chosen by you';
    if (conf === null || conf === undefined) return 'Manual';
    return conf >= THRESHOLDS.accept ? 'Auto-accepted' : conf >= THRESHOLDS.review ? 'Needs review' : 'Unresolved';
  }

  // ================= full analysis =================
  const ISSUE_OF = {
    mismatch: 'Value conflict', encoding: 'Garbled text', blank_compare: 'Blank in comparison', blank_source: 'Blank in source', uncomparable: 'Cannot compare reliably'
  };
  /*
   * mapping: [{ aId, bId, conf?, tier?, reason?, ... }] ; key: { aId, bId }
   * opts.tolerance: absolute tolerance for numeric comparison (default 0)
   */
  function analyze(A, B, key, mapping, opts) {
    opts = opts || {};
    const keyA = A.colsById[key.aId], keyB = B.colsById[key.bId];
    const join = joinOn(A, B, keyA, keyB);
    const maps = mapping.map(m => {
      const a = A.colsById[m.aId], b = B.colsById[m.bId];
      return { aId: a.id, bId: b.id, aLabel: a.label, bLabel: b.label, kind: pairKind(a, b), a, b,
        ctx: { kind: pairKind(a, b), orderA: a.profile && a.profile.order, orderB: b.profile && b.profile.order, tolerance: opts.tolerance || 0 },
        conf: m.conf === undefined ? null : m.conf, ns: m.ns, vs: m.vs, ambiguous: !!m.ambiguous, tier: m.tier || m.stage || (m.conf == null ? 'manual' : 'high'),
        stage: m.tier || m.stage || (m.conf == null ? 'manual' : 'scored'), reason: m.reason || '', alternative: m.alternative || null, observed: m.observed, chance: m.chance };
    });
    const stats = maps.map(() => ({ exact: 0, format: 0, mismatch: 0, encoding: 0, uncomparable: 0, blank_source: 0, blank_compare: 0, both_blank: 0, placeholder: 0 }));
    const issues = [];
    const matchedRows = join.pairs.map((p, ri) => {
      const ra = A.rows[p.ia], rb = B.rows[p.ib];
      const keyValue = displayValue(keyA.get(ra));   // original key text, for finding the row in Excel
      const st = new Array(maps.length);
      let worst = 0;
      maps.forEach((m, mi) => {
        const vs = m.a.get(ra), vd = m.b.get(rb);
        const c = compareCell(vs, vd, m.ctx);
        st[mi] = c.s; stats[mi][c.s]++;
        if (ISSUE_OF[c.s]) {
          let issue = ISSUE_OF[c.s];
          if (c.s === 'mismatch' && isPlaceholder(vd)) { issue = 'Placeholder in comparison'; stats[mi].placeholder++; }
          issues.push({ ri, mi, key: p.key, keyValue, issue, status: c.s, why: c.why, column: m.bLabel, sourceColumn: m.aLabel, src: vs, db: vd,
            sourceRow: rowNumberOf(ra, p.ia), compareRow: rowNumberOf(rb, p.ib) });
          worst = Math.max(worst, c.s === 'mismatch' || c.s === 'encoding' ? 3 : c.s === 'uncomparable' ? 2 : 1);
        }
      });
      return { key: p.key, keyValue, ia: p.ia, ib: p.ib, st, worst, dupB: p.dupB, sourceRow: rowNumberOf(ra, p.ia), compareRow: rowNumberOf(rb, p.ib) };
    });
    const mappingStats = maps.map((m, mi) => {
      const s = stats[mi];
      const comparable = matchedRows.length - s.both_blank;
      const quality = comparable ? (s.exact + s.format) / comparable : 1;
      return Object.assign({}, s, { comparable, quality, aLabel: m.aLabel, bLabel: m.bLabel, kind: m.kind, conf: m.conf, vs: m.vs, tier: m.tier,
        status: mapStatus(m.conf, m.vs, m.ambiguous, m.stage), reason: m.reason, alternative: m.alternative, aId: m.aId, bId: m.bId });
    });
    const profile = F => F.cols.filter(c => !c.virtual).map(c => {
      let blanks = 0, garbled = 0;
      F.rows.forEach(r => { const v = c.get(r); if (isBlank(v)) blanks++; else if (unmojibake(v) !== null) garbled++; });
      return { label: c.label, blanks, garbled, filled: F.rows.length - blanks, pct: F.rows.length ? (F.rows.length - blanks) / F.rows.length : 0, type: c.profile ? c.profile.dominant : null };
    });
    const nullsA = profile(A), nullsB = profile(B);
    const countryCol = F => F.cols.find(c => !c.virtual && /^country(name)?$/.test(c.scoreKey));
    const breakdown = (F, idxs) => {
      const c = countryCol(F); if (!c) return null;
      const counts = new Map();
      idxs.forEach(i => { const raw = c.get(F.rows[i]); const k = isBlank(raw) ? '(blank)' : String(repaired(raw)).trim(); counts.set(k, (counts.get(k) || 0) + 1); });
      return [...counts.entries()].sort((x, y) => y[1] - x[1]).slice(0, 12).map(([label, count]) => ({ label, count }));
    };
    const sourceOnlyByCountry = breakdown(A, join.sourceOnly), dbOnlyByCountry = breakdown(B, join.dbOnly);
    const activeCol = B.cols.find(c => !c.virtual && /^(isactive|active|activeflag)$/.test(c.scoreKey));
    const dbOnlyActive = activeCol ? join.dbOnly.filter(i => isTruthy(activeCol.get(B.rows[i]))).length : null;
    const sum = k => mappingStats.reduce((t, s) => t + s[k], 0);
    const totalCells = matchedRows.length * maps.length;
    const cleanCells = sum('exact') + sum('format');
    const bothFilled = cleanCells + sum('mismatch') + sum('encoding') + sum('uncomparable');
    const dataErrors = sum('mismatch') + sum('encoding');
    const recordsIdentical = matchedRows.filter(r => r.st.every(s => s === 'exact' || s === 'both_blank')).length;
    const recordsEquivalent = matchedRows.filter(r => r.worst === 0).length;
    const summary = {
      rowsA: A.rows.length, rowsB: B.rows.length, keyLabelA: keyA.label, keyLabelB: keyB.label,
      matched: join.pairs.length, sourceOnly: join.sourceOnly.length, dbOnly: join.dbOnly.length, dbOnlyActive,
      dupGroupsA: join.dupA.length, dupGroupsB: join.dupB.length, blankKeyA: join.blankKeyA.length, blankKeyB: join.blankKeyB.length,
      mappingCount: maps.length, garbled: [...nullsA, ...nullsB].reduce((t, p) => t + p.garbled, 0),
      totalCells, cleanCells, issueCells: issues.length, agreement: totalCells ? cleanCells / totalCells : 0,
      dataErrorRate: bothFilled ? dataErrors / bothFilled : 0, conflicts: sum('mismatch'), uncomparable: sum('uncomparable'),
      formatOnly: sum('format'), recordsIdentical, recordsEquivalent, recordsWithIssues: matchedRows.length - recordsEquivalent,
      ambiguousCount: mappingStats.filter(s => s.status.indexOf('close alternative') >= 0).length
    };
    const insights = buildInsights(summary, mappingStats, sourceOnlyByCountry, dbOnlyByCountry);
    return {
      summary, insights, key: { aId: keyA.id, bId: keyB.id, aLabel: keyA.label, bLabel: keyB.label },
      mapping: mappingStats, matchedRows, issues, sourceOnly: join.sourceOnly, dbOnly: join.dbOnly, dupA: join.dupA, dupB: join.dupB,
      blankKeyA: join.blankKeyA, blankKeyB: join.blankKeyB, nullsA, nullsB, sourceOnlyByCountry, dbOnlyByCountry, maps
    };
  }

  function buildInsights(s, stats, srcCountry, dbCountry) {
    const num = n => Number(n).toLocaleString('en-US');
    const out = [];
    if (s.sourceOnly) {
      let txt = `${num(s.sourceOnly)} source record${s.sourceOnly > 1 ? 's have' : ' has'} no matching comparison record`;
      if (srcCountry && srcCountry.length) txt += `, most in ${srcCountry[0].label} (${srcCountry[0].count})`;
      out.push({ level: 'bad', text: txt + '.' });
    }
    if (s.dbOnly) {
      let txt = `${num(s.dbOnly)} comparison record${s.dbOnly > 1 ? 's are' : ' is'} not in the source`;
      if (s.dbOnlyActive !== null) txt += `, ${num(s.dbOnlyActive)} of them still marked active`;
      out.push({ level: 'warn', text: txt + '.' });
    }
    if (s.blankKeyA) out.push({ level: 'warn', text: `${num(s.blankKeyA)} source row${s.blankKeyA > 1 ? 's have' : ' has'} a blank key and could not be matched.` });
    if (s.blankKeyB) out.push({ level: 'warn', text: `${num(s.blankKeyB)} comparison row${s.blankKeyB > 1 ? 's have' : ' has'} a blank key and could not be matched.` });
    if (s.dupGroupsB) out.push({ level: 'warn', text: `${s.dupGroupsB} key value${s.dupGroupsB > 1 ? 's appear' : ' appears'} more than once in the comparison file. The most complete row was used for each.` });
    if (s.dupGroupsA) out.push({ level: 'warn', text: `${s.dupGroupsA} key value${s.dupGroupsA > 1 ? 's appear' : ' appears'} more than once in the source file.` });
    stats.forEach(st => { if (st.placeholder > 0) out.push({ level: 'bad', text: `${st.bLabel}: ${num(st.placeholder)} record${st.placeholder > 1 ? 's show' : ' shows'} a placeholder value (e.g. "Other") where the source has data.` }); });
    if (s.garbled) out.push({ level: 'bad', text: `${num(s.garbled)} values contain garbled characters (for example "Ã©" for "é"). This is an encoding problem in the file export.` });
    if (s.uncomparable) out.push({ level: 'warn', text: `${num(s.uncomparable)} values could not be compared reliably (ambiguous day/month order or text in a numeric/date column). They are not counted as matches.` });
    const worst = stats.filter(st => st.comparable > 0).sort((x, y) => x.quality - y.quality)[0];
    if (worst && worst.quality < 0.95) out.push({ level: 'warn', text: `Lowest agreement: ${worst.bLabel} ↔ ${worst.aLabel} at ${(worst.quality * 100).toFixed(1)}%.` });
    stats.forEach(st => {
      if (st.tier === 'medium' || st.tier === 'accepted') out.push({ level: 'warn', text: `Mapping used after review: ${st.bLabel} ↔ ${st.aLabel}. Confirm it before relying on its discrepancy counts.` });
      if (st.tier === 'manual') out.push({ level: 'info', text: `Manual mapping: ${st.bLabel} ↔ ${st.aLabel}.` });
    });
    if (s.formatOnly > 0) out.push({ level: 'info', text: `${num(s.formatOnly)} values match only after formatting is ignored (dates, number formats, case, spacing, titles, phone prefixes).` });
    return out;
  }

  // ================= evaluation against a confirmed mapping list =================
  function evaluateMapping(result, truth, extraPairs) {
    const mapping = result.mapping.concat((extraPairs || []).map(x => ({ bLabel: x.bLabel, aLabel: x.aLabel })));
    const byB = {}; mapping.forEach(m => { byB[m.bLabel] = m; });
    const rows = []; let correct = 0, wrong = 0, missed = 0;
    truth.forEach(t => {
      const m = byB[t.bLabel], got = m ? m.aLabel : null;
      const ok = t.aLabel === null ? !m : got === t.aLabel;
      if (ok) correct++; else if (t.aLabel === null || m) wrong++; else missed++;
      rows.push({ compare: t.bLabel, expected: t.aLabel, got, ok });
    });
    mapping.forEach(m => { if (!truth.some(t => t.bLabel === m.bLabel)) { wrong++; rows.push({ compare: m.bLabel, expected: null, got: m.aLabel, ok: false, extra: true }); } });
    const total = truth.length + mapping.filter(m => !truth.some(t => t.bLabel === m.bLabel)).length;
    return { rows, correct, wrong, missed, total, accuracy: total ? correct / total : 0, errorRate: total ? (wrong + missed) / total : 0 };
  }

  // ================= sheet pairing =================
  /*
   * Suggest source↔comparison worksheet pairs from header similarity.
   * sheets: [{ id, headers }]. A pair is suggested only when it is the clear mutual best match.
   */
  function headerSetSimilarity(ha, hb) {
    if (!ha.length || !hb.length) return 0;
    const df = new Map();
    [ha, hb].forEach(hs => hs.forEach(h => { const H = analyzeHeader(h); new Set(H.concept.concat(H.canon)).forEach(t => df.set(t, (df.get(t) || 0) + 1)); }));
    const pairs = assign(ha.length, hb.length, (i, j) => { const s = nameScore(ha[i], hb[j], { df }).score; return s >= 0.5 ? s : 0; });
    const total = pairs.reduce((t, [i, j]) => { const s = nameScore(ha[i], hb[j], { df }).score; return t + (s >= 0.5 ? s : 0); }, 0);
    return total / Math.max(ha.length, hb.length);
  }
  function suggestSheetPairs(sources, compares) {
    const S = sources.map(s => compares.map(c => headerSetSimilarity(s.headers, c.headers)));
    const out = [];
    sources.forEach((s, i) => {
      const row = S[i];
      let bj = -1, bv = 0, second = 0;
      row.forEach((v, j) => { if (v > bv) { second = bv; bv = v; bj = j; } else if (v > second) second = v; });
      if (bj < 0 || bv < 0.35) return;
      const colBest = Math.max(...S.map((r, k) => k === i ? 0 : r[bj]));
      if (bv - second >= 0.1 && bv - colBest >= 0.1) out.push({ sourceId: s.id, compareId: compares[bj].id, score: bv });
    });
    return { pairs: out, matrix: S };
  }

  // ================= orchestration =================
  /*
   * Run one independent comparison.
   * opts: { key?, mapping?, known?, rejected?, memory?, tolerance? }
   */
  function runReconciliation(fileA, fileB, opts) {
    opts = opts || {};
    const A = fileA.cols ? fileA : prepareFile(fileA), B = fileB.cols ? fileB : prepareFile(fileB);
    const det = detectKeys(A, B);
    let key = opts.key || (det.best ? { aId: det.best.aId, bId: det.best.bId } : null);
    const join = key ? joinOn(A, B, A.colsById[key.aId], B.colsById[key.bId]) : null;
    const sug = suggestMapping(A, B, key, join, opts);
    if (!key) return { A, B, key: null, keyAlternatives: det.alternatives, suggestion: sug, result: null, error: 'No suitable key column found. Choose the key columns manually.' };
    const mapping = opts.mapping || sug.auto;
    const result = analyze(A, B, key, mapping, opts);
    return { A, B, key, keyDetected: det.best, keyAlternatives: det.alternatives, suggestion: sug, result };
  }

  const api = {
    VERSION, THRESHOLDS, TIER_LABEL,
    isBlank, normText, normPhone, normName, isPlaceholder, compareValues, compareCell, rowSimilarity, displayValue,
    parseNumber, parseDate, parseBool, typeOf, typeHist, typeSim, nameScore, analyzeHeader, canonTokens,
    unmojibake, repaired, keyNorm, tableFromAOA, readSheet, profileColumn, profileSimilarity,
    prepareFile, detectKey, detectKeys, joinOn, suggestMapping, scorePair, valueEvidence, analyze, runReconciliation, evaluateMapping,
    suggestSheetPairs, headerSetSimilarity, assign,
    mapStatus, confLabel, cleanHeader, hkey, detectKind, pairKind, rowNumberOf
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Reconcile = api;
})(typeof self !== 'undefined' ? self : this);
