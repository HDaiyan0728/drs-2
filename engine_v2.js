
/* Reconciliation engine v2 — pure logic, no DOM. Works in browsers and Node. */
(function (root) {
  'use strict';

  // ================= value helpers =================
  const BLANK_TOKENS = new Set(['', 'null', 'nan', 'none', 'n/a', 'nat', 'undefined', '#n/a']);
  const PLACEHOLDER_TOKENS = new Set(['other', 'unknown', 'not specified', 'default', 'tbd', 'n/a', 'none', '-', 'select']);

  function isBlank(v) {
    if (v === null || v === undefined) return true;
    if (typeof v === 'number') return !isFinite(v);
    if (v instanceof Date) return isNaN(v.getTime());
    return BLANK_TOKENS.has(String(v).trim().toLowerCase());
  }

  function normText(v) {
    if (isBlank(v)) return '';
    if (v instanceof Date) return v.toISOString().slice(0, 19);
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
    s = s.replace(/\b(md|mr|mrs|ms|miss|dr|prof)\b\.?/g, ' ');
    return s.replace(/[^\p{L}\p{N}]+/gu, '');
  }

  // Punctuation- and spacing-insensitive token list, used for value similarity
  function tokensOf(v) {
    if (isBlank(v)) return [];
    return normText(v).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  }

  function isPlaceholder(v) {
    return PLACEHOLDER_TOKENS.has(normText(v));
  }

  // Garbled text: UTF-8 read as Windows-1252 ("BrÃ©gard", "Officer â€“ Admin").
  // Repaired only when the result is valid UTF-8, so correct text like "Brégard" is untouched.
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
  function repaired(v) {
    const fixed = unmojibake(v);
    return fixed === null ? v : fixed;
  }
  function keyNorm(v) { return normText(repaired(v)); }

  function isTruthy(v) {
    if (v === true || v === 1) return true;
    const s = normText(v);
    return s === 'true' || s === '1' || s === 'yes';
  }

  // ================= value TYPE (not value) =================
  // Type of one cell. Used for the type gate only, never for equality.
  function typeOf(v) {
    if (isBlank(v)) return 'blank';
    if (v instanceof Date) return 'datetime';
    if (typeof v === 'number') {
      if (Number.isInteger(v) && String(Math.abs(v)).length >= 9) return 'phone';
      return Number.isInteger(v) ? 'integer' : 'decimal';
    }
    const s = String(v).trim();
    if (/^[\w.+-]+@[\w-]+(\.[\w-]+)+$/.test(s)) return 'email';
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return 'guid';
    if (/^[+]?[\d\s\-()]+$/.test(s) && /\d/.test(s)) {
      const digits = s.replace(/\D/g, '');
      if (digits.length >= 9) return 'phone';
      return /^[+-]?\d+$/.test(s) ? 'integer' : 'text';
    }
    if (/^[+-]?\d+$/.test(s)) return 'integer';
    if (/^[+-]?\d*\.\d+$/.test(s)) return 'decimal';
    if (/^\d{4}-\d{2}-\d{2}/.test(s) || /^\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}$/.test(s)) return 'date';
    if (/^[A-Za-z0-9_-]+$/.test(s)) return 'code';
    return 'text';
  }
  // Compatibility groups: 'code' can match 'text', integers match decimals, etc.
  const TYPE_GROUP = { text: 'text', code: 'text', integer: 'num', decimal: 'num', phone: 'phone', date: 'date', datetime: 'date', email: 'email', guid: 'guid' };
  function typeHist(values) {
    const h = {};
    let n = 0;
    values.forEach(v => {
      const t = typeOf(v);
      if (t === 'blank') return;
      const g = TYPE_GROUP[t] || 'text';
      h[g] = (h[g] || 0) + 1; n++;
    });
    Object.keys(h).forEach(k => { h[k] /= n; });
    return { h, n };
  }
  // Histogram intersection, 0..1
  function typeSim(a, b) {
    if (!a.n || !b.n) return 0;
    let s = 0;
    Object.keys(a.h).forEach(k => { if (b.h[k]) s += Math.min(a.h[k], b.h[k]); });
    return s;
  }

  // ================= header helpers =================
  function cleanHeader(h) {
    return String(h === null || h === undefined ? '' : h).replace(/\s+/g, ' ').trim();
  }
  function hkey(h) {
    return cleanHeader(h).toLowerCase().replace(/[^a-z0-9]/g, '');
  }
  // Synonym groups: header names that mean the same thing across two systems.
  const SYN_GROUPS = [
    ['email', 'primaryemail', 'username', 'emailaddress', 'useremail', 'workemail', 'mail'],
    ['gender', 'persongender', 'sex'],
    ['country', 'countryname'],
    ['phone', 'phonenumber', 'mobile', 'mobilenumber', 'mobileno', 'telephone', 'contactnumber', 'cell'],
    ['designation', 'assignmentname', 'jobtitle', 'position', 'job', 'title'],
    ['office', 'officename', 'location', 'locationname', 'site', 'branch'],
    ['fullname', 'name', 'displayname', 'employeename'],
    ['firstname', 'givenname', 'fname'],
    ['lastname', 'surname', 'familyname', 'lname'],
    ['personnumber', 'employeeid', 'empno', 'staffid'],
    ['postalcode', 'zip', 'zipcode', 'postcode'],
    ['isactive', 'active', 'status'],
    ['region', 'regionname'],
    ['manager', 'managername', 'reportingmanager', 'supervisor', 'supervisorname', 'line manager'],
    // Common business/data-warehouse field names and abbreviations
    ['fuel', 'fueltype', 'fuelname', 'fuelcategory', 'energytype', 'energysource', 'powersource', 'powertrain', 'propulsiontype', 'fuelused', 'vehiclefuel'],
    ['fuelcode', 'fuelid', 'fuelkey'],
    ['vehicle', 'vehiclename', 'vehiclemodel', 'car'],
    ['registrationnumber', 'registrationno', 'regno', 'vehicle-registration', 'licenceplate', 'licenseplate', 'platenumber'],
    ['vin', 'vehicleidentificationnumber', 'chassisnumber', 'chassisno'],
    ['make', 'manufacturer', 'vehiclemake', 'brand'],
    ['model', 'vehiclemodelname'],
    ['department', 'departmentname', 'dept', 'deptname', 'businessunit', 'orgunit'],
    ['employeeid', 'employeeidentifier', 'personnelnumber', 'personnelno', 'staffnumber', 'staffno', 'empid', 'empcode'],
    ['dateofbirth', 'birthdate', 'dob'],
    ['startdate', 'datefrom', 'effectivedate', 'validfrom', 'commencementdate'],
    ['enddate', 'dateto', 'expirydate', 'expirationdate', 'validto'],
    ['salary', 'pay', 'basepay', 'basicpay', 'monthlysalary'],
    ['currency', 'currencycode', 'curr'],
    ['amount', 'totalamount', 'valueamount', 'cost', 'price'],
    ['address', 'streetaddress', 'addressline', 'mailingaddress'],
    ['city', 'town', 'municipality'],
    ['state', 'province', 'territory'],
    ['employmentstatus', 'employeestatus', 'workstatus', 'staffstatus'],
    ['hiredate', 'datehired', 'joiningdate', 'datejoined'],
    ['terminationdate', 'separationdate', 'leavingdate', 'lastworkingday'],
    ['quantity', 'qty', 'count', 'units'],
    ['description', 'details', 'remarks', 'comments', 'notes'],
    ['category', 'classification', 'class'],
    ['accountnumber', 'accountno', 'acctnumber', 'acctno'],
    ['taxid', 'taxnumber', 'tin', 'vatnumber', 'vatno']
  ];
  const groupOf = {};
  SYN_GROUPS.forEach((g, i) => g.forEach(t => { groupOf[hkey(t)] = i; }));
  // Words too generic to count as evidence of a match on their own
  const GENERIC = new Set(['name', 'number', 'no', 'code', 'id', 'type', 'date', 'status', 'of', 'the', 'and', 'column']);

  function dice(a, b) {
    if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
    const bigrams = s => {
      const m = new Map();
      for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); }
      return m;
    };
    const A = bigrams(a), B = bigrams(b);
    let inter = 0;
    A.forEach((c, g) => { if (B.has(g)) inter += Math.min(c, B.get(g)); });
    return (2 * inter) / ((a.length - 1) + (b.length - 1));
  }

  // Semantic header matching: normalized labels, known domain aliases, token concepts,
  // then character similarity. This is a lightweight local semantic layer (no API/model download).
  function headerTokens(label) {
    return String(label == null ? '' : label)
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
      .toLowerCase().split(/[^a-z0-9]+/).filter(t => t && !GENERIC.has(t));
  }

  const CONCEPT_OF = Object.create(null);
  SYN_GROUPS.forEach((g, i) => g.forEach(t => { CONCEPT_OF[hkey(t)] = i; }));
  function conceptTokens(label) {
    const whole = hkey(label);
    // Prefer a known meaning for the full phrase (e.g. "Fuel Type" and "Energy Source").
    if (CONCEPT_OF[whole] !== undefined) return ['concept:' + CONCEPT_OF[whole]];
    return headerTokens(label).map(t => CONCEPT_OF[hkey(t)] === undefined ? t : 'concept:' + CONCEPT_OF[hkey(t)]);
  }

  // Stage 1 — name score: exact, domain synonym, semantic token overlap, spelling.
  function nameScore(labelA, labelB) {
    const ka = hkey(labelA), kb = hkey(labelB);
    if (ka === kb) return { score: 1, how: 'exact name' };
    const ga = groupOf[ka], gb = groupOf[kb];
    if (ga !== undefined && ga === gb) return { score: 0.94, how: 'domain synonym' };

    const ta = [...new Set(conceptTokens(labelA))];
    const tb = [...new Set(conceptTokens(labelB))];
    if (ta.length && tb.length) {
      const overlap = ta.filter(t => tb.includes(t)).length;
      const diceScore = (2 * overlap) / (ta.length + tb.length);
      if (overlap && ta.every(t => tb.includes(t)) && tb.every(t => ta.includes(t)))
        return { score: 0.88, how: 'same semantic terms' };
      if (overlap && (ta.every(t => tb.includes(t)) || tb.every(t => ta.includes(t))))
        return { score: 0.78, how: 'semantic term match' };
      if (diceScore >= 0.5) return { score: Math.min(0.76, 0.52 + diceScore * 0.24), how: 'related header terms' };
    }

    const rawA = new Set(headerTokens(labelA));
    const rawB = new Set(headerTokens(labelB));
    const shared = [...rawA].filter(t => rawB.has(t));
    if (shared.length && (shared.length === rawA.size || shared.length === rawB.size)) return { score: 0.7, how: 'partial (words)' };
    if (shared.length) return { score: 0.5, how: 'half (shared word)' };
    return { score: dice(ka, kb), how: 'similar spelling' };
  }

  function detectKind(h) {
    const k = hkey(h);
    if (/(phone|mobile|telephone|cell)/.test(k) && !/(e?mail)/.test(k)) return 'phone';
    if (/e?mail/.test(k)) return 'email';
    if (/^(full|first|last|given|family|sur|display|person|employee)?name$/.test(k)) return 'name';
    if (/(date|created|edited|time)$/.test(k)) return 'date';
    return 'text';
  }
  function pairKind(ka, kb) {
    if (ka === 'phone' || kb === 'phone') return 'phone';
    if (ka === 'email' || kb === 'email') return 'email';
    if (ka === 'name' || kb === 'name') return 'name';
    if (ka === 'date' && kb === 'date') return 'date';
    return 'text';
  }
  function comparatorFor(kind) {
    if (kind === 'phone') return normPhone;
    if (kind === 'name') return normName;
    return normText;
  }

  // Compare one source value with one compare value
  // Returns: exact | format | encoding | mismatch | blank_source | blank_db | both_blank
  function compareValues(vSrc, vDb, kind) {
    const bs = isBlank(vSrc), bd = isBlank(vDb);
    if (bs && bd) return 'both_blank';
    if (bs) return 'blank_source';
    if (bd) return 'blank_db';
    if (normText(vSrc) === normText(vDb)) return 'exact';
    const cmp = comparatorFor(kind);
    const cs = cmp(vSrc), cd = cmp(vDb);
    if (cs && cs === cd) return 'format';
    const fs = unmojibake(vSrc), fd = unmojibake(vDb);
    if ((fd !== null && normText(fd) === normText(vSrc)) || (fs !== null && normText(fs) === normText(vDb))) return 'encoding';
    return 'mismatch';
  }

  // Similarity of two values, 0..1 (null = not comparable). Used for matching, punctuation-tolerant.
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

  // Deterministic PRNG so results are reproducible
  function rng(seed) {
    let s = seed >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  }

  // ================= file preparation =================
  // Input: { name, headers: [string], rows: [object keyed by header] }
  function prepareFile(file) {
    const headers = file.headers.map(cleanHeader);
    const cols = headers.map(h => ({
      id: h, label: h, scoreKey: hkey(h), kind: detectKind(h), virtual: false,
      get: r => r[h]
    }));
    const first = cols.find(c => c.scoreKey === 'firstname');
    const last = cols.find(c => c.scoreKey === 'lastname');
    if (first && last) {
      cols.push({
        id: '__first_last', label: first.label + ' + ' + last.label, scoreKey: 'fullname',
        kind: 'name', virtual: true,
        get: r => [first.get(r), last.get(r)].filter(x => !isBlank(x)).map(String).join(' ')
      });
    }
    const F = { name: file.name, fileNames: file.fileNames || [file.name], rows: file.rows, cols, colsById: Object.fromEntries(cols.map(c => [c.id, c])) };
    cols.forEach(c => { c.typeHist = typeHist(F.rows.map(r => c.get(r))); });
    return F;
  }

  function indexRows(rows, col) {
    const m = new Map();
    rows.forEach((r, i) => {
      const k = keyNorm(col.get(r));
      if (!k) return;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(i);
    });
    return m;
  }

  // How complete a row is; used to pick the best row among duplicate keys
  function rowCompleteness(F, i) {
    const r = F.rows[i];
    let n = 0;
    F.cols.forEach(c => { if (!c.virtual && !isBlank(c.get(r))) n++; });
    const act = F.cols.find(c => !c.virtual && c.scoreKey === 'isactive');
    if (act && isTruthy(act.get(r))) n += 1000;
    return n;
  }

  // ================= key detection (all candidates) =================
  function distinctSet(rows, col) {
    const set = new Set();
    let nonBlank = 0;
    rows.forEach(r => {
      const k = keyNorm(col.get(r));
      if (k) { set.add(k); nonBlank++; }
    });
    return { set, n: set.size, ratio: nonBlank ? set.size / nonBlank : 0, nonBlank };
  }

  // Returns { best, alternatives }; each candidate: { aId, bId, overlap, score, auto }
  function detectKeys(A, B) {
    const cands = [];
    for (const a of A.cols) {
      if (a.virtual || a.kind === 'phone') continue;
      for (const b of B.cols) {
        if (b.virtual || b.kind === 'phone') continue;
        const sa = distinctSet(A.rows, a), sb = distinctSet(B.rows, b);
        if (sa.n === 0 || sb.n === 0) continue;
        if (sa.ratio < 0.95 || sb.ratio < 0.95) continue; // a key must be (nearly) unique
        let inter = 0;
        sa.set.forEach(v => { if (sb.set.has(v)) inter++; });
        const overlap = inter / Math.min(sa.n, sb.n);
        if (overlap < 0.3) continue;
        const score = overlap + 0.05 * nameScore(a.label, b.label).score;
        cands.push({ aId: a.id, bId: b.id, overlap, score, auto: true });
      }
    }
    cands.sort((x, y) => y.score - x.score);
    return { best: cands[0] || null, alternatives: cands.slice(1) };
  }
  function detectKey(A, B) { return detectKeys(A, B).best; }

  // ================= join =================
  function joinOn(A, B, keyA, keyB) {
    const idxB = indexRows(B.rows, keyB);
    const idxA = indexRows(A.rows, keyA);
    const pairs = [];
    const sourceOnly = [];
    const blankKeyA = [];
    A.rows.forEach((r, i) => {
      const k = keyNorm(keyA.get(r));
      if (!k) { blankKeyA.push(i); return; }
      const bi = idxB.get(k);
      if (bi) {
        const pick = bi.length === 1 ? bi[0] : bi.slice().sort((x, y) => rowCompleteness(B, y) - rowCompleteness(B, x))[0];
        pairs.push({ key: k, ia: i, ib: pick });
      } else sourceOnly.push(i);
    });
    const dbOnly = [];
    const blankKeyB = [];
    B.rows.forEach((r, i) => {
      const k = keyNorm(keyB.get(r));
      if (!k) { blankKeyB.push(i); return; }
      if (!idxA.has(k)) dbOnly.push(i);
    });
    const dupB = [];
    idxB.forEach((idx, k) => { if (idx.length > 1) dupB.push({ key: k, rows: idx }); });
    const dupA = [];
    idxA.forEach((idx, k) => { if (idx.length > 1) dupA.push({ key: k, rows: idx }); });
    return { pairs, sourceOnly, dbOnly, blankKeyA, blankKeyB, dupA, dupB, idxB };
  }

  // ================= column matching (staged) =================
  // Stage 1  name: exact, synonym, partial/half word match, spelling
  // Stage 2  value-type gate (compares the TYPE of values, not the values)
  // Stage 3  sampled check on matched records: first 10, then last 10 and random 10 if similar
  // Stage 4  full value similarity on all matched records
  function scorePair(A, B, a, b, pairs, known) {
    const nm = nameScore(a.label, b.label);
    const kind = pairKind(a.kind, b.kind);
    const ts = typeSim(a.typeHist, b.typeHist);
    const isKnown = known && known.some(k => k.bLabel === b.label && k.aLabel === a.label);
    if (isKnown) return { aId: a.id, bId: b.id, conf: 1, ns: 1, vs: 1, ts, comp: pairs.length, kind, reason: 'known pair (you set this)', stage: 'known', ambiguous: false };

    const base = { aId: a.id, bId: b.id, ns: nm.score, nameHow: nm.how, ts, kind, comp: 0, vs: null, sampleVs: null, stage: 'gate' };
    if (ts < 0.4 && nm.score < 1) return { ...base, conf: 0, reason: 'value types differ', rejected: true };

    const sim = i => { const p = pairs[i]; return rowSimilarity(a.get(A.rows[p.ia]), b.get(B.rows[p.ib])); };
    const n = pairs.length;
    const mean = arr => arr.length ? arr.reduce((t, x) => t + x, 0) / arr.length : null;
    const valid = idxs => idxs.map(sim).filter(x => x !== null);

    // Value TYPE agreement on sampled matched records (number vs text vs date ...), not the values themselves
    const typeOK = i => { const p = pairs[i]; const va = a.get(A.rows[p.ia]), vb = b.get(B.rows[p.ib]);
      const ta = typeOf(va), tb = typeOf(vb); if (ta === 'blank' || tb === 'blank') return null;
      return TYPE_GROUP[ta] === TYPE_GROUP[tb] ? 1 : 0; };
    const first = []; for (let i = 0; i < Math.min(10, n); i++) first.push(i);
    const typesFirst = first.map(typeOK).filter(x => x !== null);
    base.typeSampleShare = typesFirst.length ? mean(typesFirst) : null;
    if (typesFirst.length >= 5 && base.typeSampleShare < 0.5 && nm.score < 1) return { ...base, conf: 0, reason: 'sampled value types differ', rejected: true };

    const m1 = valid(first);
    if (m1.length >= 5) {
      if (mean(m1) < 0.15 && nm.score < 0.9) return { ...base, conf: 0, reason: 'first 10 sampled values are not similar', rejected: true };
      if (n >= 20) {
        const last = []; for (let i = n - 10; i < n; i++) last.push(i);
        const rnd = rng(42), rand = [];
        for (let i = 0; i < 10; i++) rand.push(Math.floor(rnd() * n));
        base.sampleVs = mean(valid(first.concat(last, rand)));
      } else base.sampleVs = mean(m1);
    }

    let sum = 0, cnt = 0, eq = 0;
    for (let i = 0; i < n; i++) {
      const x = sim(i);
      if (x === null) continue;
      sum += x; cnt++;
      if (x >= 0.97) eq++;
    }
    base.comp = cnt;
    base.vs = cnt >= 3 ? sum / cnt : null;
    base.smallSample = cnt > 0 && cnt < 10;
    base.eqShare = cnt ? eq / cnt : null;
    let conf = base.vs === null ? 0.5 * nm.score : 0.30 * nm.score + 0.70 * base.vs;
    if (base.smallSample) conf *= 0.88; // small samples are useful, but less certain
    if (ts < 0.7) conf *= 0.85;
    if (a.virtual || b.virtual) conf -= 0.05;   // a real column beats a derived one on a tie
    return { ...base, conf, reason: nm.how + (base.vs === null ? '' : ` · ${Math.round(base.vs * 100)}% of values similar${base.smallSample ? ' (small sample)' : ''}`), stage: 'scored' };
  }

  // Returns { auto, candidates, aliases }
  //   auto: chosen mapping pairs (known pairs first, then greedy one-to-one by confidence)
  //   candidates: top alternatives per compare column
  //   aliases: compare columns that hold the same key values as the source key (not data columns)
  function suggestMapping(A, B, key, join, opts) {
    opts = opts || {};
    const minConf = opts.minConf || 0.3;
    const known = opts.known || [];
    const keyA = A.colsById[key.aId], keyB = B.colsById[key.bId];
    const pairs = join.pairs;
    const candidates = {};
    const all = [];

    // Key aliases first, so their columns are not also used as data columns
    const aliases = [];
    for (const b of B.cols) {
      if (b.id === keyB.id || b.virtual) continue;
      let eq = 0, comp = 0;
      for (const p of pairs) {
        const va = keyA.get(A.rows[p.ia]), vb = b.get(B.rows[p.ib]);
        if (isBlank(va) || isBlank(vb)) continue;
        comp++; if (keyNorm(va) === keyNorm(vb)) eq++;
      }
      if (comp >= 10 && eq / comp >= 0.98) aliases.push({ bId: b.id, aId: keyA.id, value: eq / comp });
    }
    const aliasB = new Set(aliases.map(x => x.bId));

    // A derived column (e.g. First + Last) is dropped when a real column with the same meaning exists
    const realKeys = (F) => new Set(F.cols.filter(c => !c.virtual).map(c => c.scoreKey));
    const realA = realKeys(A), realB = realKeys(B);
    const dupB = new Set(B.cols.filter(c => c.virtual && realB.has(c.scoreKey)).map(c => c.id));
    const dupA = new Set(A.cols.filter(c => c.virtual && realA.has(c.scoreKey)).map(c => c.id));
    for (const b of B.cols) {
      if (b.id === keyB.id || aliasB.has(b.id) || dupB.has(b.id)) continue;
      candidates[b.id] = [];
      for (const a of A.cols) {
        if (a.id === keyA.id || dupA.has(a.id)) continue;
        const c = scorePair(A, B, a, b, pairs, known);
        if (c.rejected) continue;
        candidates[b.id].push(c);
        all.push(c);
      }
      candidates[b.id].sort((x, y) => y.conf - x.conf);
      candidates[b.id] = candidates[b.id].slice(0, 5);
    }

    const usedA = new Set(), usedB = new Set(), auto = [];
    all.filter(c => c.stage === 'known').forEach(c => { usedA.add(c.aId); usedB.add(c.bId); auto.push(c); });
    const rest = all.filter(c => c.stage !== 'known').sort((x, y) => y.conf - x.conf);
    for (const c of rest) {
      if (usedA.has(c.aId) || usedB.has(c.bId)) continue;
      if (c.conf < minConf) continue;
      // Do not auto-map when the values barely agree; it stays visible as a suggestion
      if (c.vs !== null && c.vs < 0.3) continue;
      usedA.add(c.aId); usedB.add(c.bId);
      auto.push(c);
    }
    // Ambiguity: another source column for the same compare column scored within 0.10
    auto.forEach(c => {
      if (c.stage === 'known') return;
      const close = c.ns >= 1 ? null : (candidates[c.bId] || []).find(x => x.aId !== c.aId && c.conf - x.conf < 0.1 && x.conf >= 0.4);
      c.alternative = close ? { aId: close.aId, conf: close.conf } : null;
      c.ambiguous = !!close;
    });
    return { auto, candidates, aliases };
  }

  function confLabel(conf) {
    if (conf >= 0.7) return 'Auto-matched';
    if (conf >= 0.4) return 'Review';
    return 'Low confidence';
  }

  // Status of a column mapping, driven by how often values agree on matched records
  function mapStatus(conf, vs, ambiguous, stage) {
    if (stage === 'known') return 'Known pair';
    if (conf === null || conf === undefined) return 'Manual';
    if (ambiguous) return 'Confirm (close alternative)';
    if (vs === null || vs === undefined) return 'Review';
    if (vs >= 0.85) return 'Auto-matched';
    if (vs >= 0.5) return 'Review';
    return 'Low confidence';
  }

  // ================= full analysis =================
  // mapping: [{ aId, bId, conf?, ns?, vs?, ambiguous?, alternative?, stage?, reason? }] ; key: { aId, bId }
  function rowOrigin(row) { return { fileName: row && row.__fileName || 'Unknown file', sheetName: row && row.__sheetName || 'Unknown sheet', rowNumber: row && row.__rowNumber || null }; }
  function analyze(A, B, key, mapping) {
    const keyA = A.colsById[key.aId], keyB = B.colsById[key.bId];
    const join = joinOn(A, B, keyA, keyB);
    const maps = mapping.map(m => {
      const a = A.colsById[m.aId], b = B.colsById[m.bId];
      return { aId: a.id, bId: b.id, aLabel: a.label, bLabel: b.label, kind: pairKind(a.kind, b.kind), a, b,
        conf: m.conf === undefined ? null : m.conf, ns: m.ns, vs: m.vs, ambiguous: !!m.ambiguous,
        stage: m.stage || (m.conf == null ? 'manual' : 'scored'), reason: m.reason || '', alternative: m.alternative || null };
    });

    const matchedRows = join.pairs.map(p => {
      const cells = maps.map(m => {
        const vs = m.a.get(A.rows[p.ia]);
        const vd = m.b.get(B.rows[p.ib]);
        return { status: compareValues(vs, vd, m.kind), src: vs, db: vd };
      });
      return { key: p.key, ia: p.ia, ib: p.ib, sourceOrigin: rowOrigin(A.rows[p.ia]), comparisonOrigin: rowOrigin(B.rows[p.ib]), cells };
    });

    const mappingStats = maps.map((m, mi) => {
      const s = { exact: 0, format: 0, mismatch: 0, encoding: 0, blank_source: 0, blank_db: 0, both_blank: 0, placeholder: 0 };
      matchedRows.forEach(r => {
        const c = r.cells[mi];
        s[c.status]++;
        if (c.status === 'mismatch' && isPlaceholder(c.db)) s.placeholder++;
      });
      const comparable = matchedRows.length - s.both_blank;
      const quality = comparable ? (s.exact + s.format) / comparable : 1;
      return { ...s, comparable, quality, aLabel: m.aLabel, bLabel: m.bLabel, kind: m.kind, conf: m.conf, vs: m.vs,
        status: mapStatus(m.conf, m.vs, m.ambiguous, m.stage), reason: m.reason, alternative: m.alternative, aId: m.aId, bId: m.bId };
    });

    const issues = [];
    matchedRows.forEach(r => {
      r.cells.forEach((c, mi) => {
        if (['mismatch', 'encoding', 'blank_db', 'blank_source'].indexOf(c.status) === -1) return;
        let issue;
        if (c.status === 'encoding') issue = 'Garbled text in database';
        else if (c.status === 'mismatch') issue = isPlaceholder(c.db) ? 'Placeholder in database' : 'Value conflict';
        else if (c.status === 'blank_db') issue = 'Blank in database';
        else issue = 'Blank in source';
        issues.push({ key: r.key, column: maps[mi].bLabel, sourceColumn: maps[mi].aLabel, src: c.src, db: c.db, issue, mi, sourceOrigin: r.sourceOrigin, comparisonOrigin: r.comparisonOrigin });
      });
    });

    const profile = F => F.cols.filter(c => !c.virtual).map(c => {
      let blanks = 0, garbled = 0;
      F.rows.forEach(r => {
        const v = c.get(r);
        if (isBlank(v)) blanks++;
        else if (unmojibake(v) !== null) garbled++;
      });
      return { label: c.label, blanks, garbled, filled: F.rows.length - blanks, pct: F.rows.length ? (F.rows.length - blanks) / F.rows.length : 0 };
    });
    const nullsA = profile(A), nullsB = profile(B);

    const countryCol = F => F.cols.find(c => !c.virtual && /^country(name)?$/.test(c.scoreKey));
    const breakdown = (F, idxs) => {
      const c = countryCol(F);
      if (!c) return null;
      const counts = new Map();
      idxs.forEach(i => {
        const raw = c.get(F.rows[i]);
        const k = isBlank(raw) ? '(blank)' : String(repaired(raw)).trim();
        counts.set(k, (counts.get(k) || 0) + 1);
      });
      return [...counts.entries()].sort((x, y) => y[1] - x[1]).slice(0, 12).map(([label, count]) => ({ label, count }));
    };
    const sourceOnlyByCountry = breakdown(A, join.sourceOnly);
    const dbOnlyByCountry = breakdown(B, join.dbOnly);

    const activeCol = B.cols.find(c => !c.virtual && c.scoreKey === 'isactive');
    const dbOnlyActive = activeCol ? join.dbOnly.filter(i => isTruthy(activeCol.get(B.rows[i]))).length : null;

    const totalCells = matchedRows.length * maps.length;
    const cleanCells = mappingStats.reduce((t, s) => t + s.exact + s.format, 0);
    // Data error rate: among cells where both sides have a value, the share that really disagree
    const bothFilled = mappingStats.reduce((t, s) => t + s.exact + s.format + s.mismatch + s.encoding, 0);
    const dataErrors = mappingStats.reduce((t, s) => t + s.mismatch + s.encoding, 0);

    const summary = {
      rowsA: A.rows.length, rowsB: B.rows.length,
      keyLabelA: keyA.label, keyLabelB: keyB.label,
      matched: join.pairs.length,
      sourceOnly: join.sourceOnly.length,
      dbOnly: join.dbOnly.length,
      dbOnlyActive,
      dupGroupsA: join.dupA.length, dupGroupsB: join.dupB.length,
      blankKeyA: join.blankKeyA.length, blankKeyB: join.blankKeyB.length,
      mappingCount: maps.length,
      garbled: [...nullsA, ...nullsB].reduce((t, p) => t + p.garbled, 0),
      totalCells, cleanCells, issueCells: issues.length,
      agreement: totalCells ? cleanCells / totalCells : 0,
      dataErrorRate: bothFilled ? dataErrors / bothFilled : 0,
      ambiguousCount: mappingStats.filter(s => s.status.startsWith('Confirm')).length
    };

    const insights = buildInsights(summary, mappingStats, sourceOnlyByCountry, dbOnlyByCountry);

    return {
      summary, insights,
      key: { aId: keyA.id, bId: keyB.id, aLabel: keyA.label, bLabel: keyB.label },
      mapping: mappingStats,
      matchedRows, issues,
      sourceOnly: join.sourceOnly, dbOnly: join.dbOnly,
      dupA: join.dupA, dupB: join.dupB,
      blankKeyA: join.blankKeyA, blankKeyB: join.blankKeyB,
      nullsA, nullsB,
      sourceOnlyByCountry, dbOnlyByCountry,
      maps
    };
  }

  function buildInsights(s, stats, srcCountry, dbCountry) {
    const num = n => Number(n).toLocaleString('en-US');
    const out = [];
    if (s.sourceOnly) {
      let txt = `${num(s.sourceOnly)} source record${s.sourceOnly > 1 ? 's have' : ' has'} no matching database account`;
      if (srcCountry && srcCountry.length) txt += `, most in ${srcCountry[0].label} (${srcCountry[0].count})`;
      out.push({ level: 'bad', text: txt + '.' });
    }
    if (s.dbOnly) {
      let txt = `${num(s.dbOnly)} database account${s.dbOnly > 1 ? 's are' : ' is'} not in the source`;
      if (s.dbOnlyActive !== null) txt += `, ${num(s.dbOnlyActive)} of them still marked active`;
      out.push({ level: 'warn', text: txt + '.' });
    }
    if (s.dupGroupsB) out.push({ level: 'warn', text: `${s.dupGroupsB} key value${s.dupGroupsB > 1 ? 's appear' : ' appears'} more than once in the database. The most complete row was used for each.` });
    if (s.dupGroupsA) out.push({ level: 'warn', text: `${s.dupGroupsA} key value${s.dupGroupsA > 1 ? 's appear' : ' appears'} more than once in the source.` });
    stats.forEach(st => {
      if (st.placeholder > 0) {
        out.push({ level: 'bad', text: `${st.bLabel}: ${num(st.placeholder)} record${st.placeholder > 1 ? 's show a placeholder value (e.g. "Other") where the source has data.' : ' shows a placeholder value where the source has data.'}` });
      }
    });
    if (s.garbled) out.push({ level: 'bad', text: `${num(s.garbled)} values contain garbled characters (for example "Ã©" for "é" or "â€“" for a dash). This is an encoding problem in the file export.` });
    const worst = stats.filter(st => st.comparable > 0 && st.status !== 'Known pair').sort((x, y) => x.quality - y.quality)[0];
    if (worst && worst.quality < 0.95) out.push({ level: 'warn', text: `Lowest agreement: ${worst.bLabel} ↔ ${worst.aLabel} at ${(worst.quality * 100).toFixed(1)}%.` });
    stats.forEach(st => {
      if (st.status.startsWith('Confirm')) {
        out.push({ level: 'warn', text: `Please confirm: ${st.bLabel} was matched to ${st.aLabel}, but another source column scored almost as high. Lock your choice under Known pairs.` });
      } else if (st.status === 'Review' || st.status === 'Low confidence') {
        const why = st.vs === null || st.vs === undefined ? 'too few overlapping values to verify it' : `only ${(st.vs * 100).toFixed(0)}% of overlapping values are similar`;
        out.push({ level: 'warn', text: `Mapping needs review: ${st.bLabel} ↔ ${st.aLabel} (${why}).` });
      }
    });
    const fmt = stats.reduce((t, st) => t + st.format, 0);
    if (fmt > 0) out.push({ level: 'info', text: `${num(fmt)} values match only after formatting is ignored (spacing, titles, phone prefixes, punctuation).` });
    const blanks = stats.reduce((t, st) => t + st.blank_db, 0);
    if (blanks > 0) out.push({ level: 'info', text: `${num(blanks)} values are blank in the database where the source has data.` });
    return out;
  }

  // ================= evaluation against a confirmed mapping list =================
  // truth: [{ bLabel, aLabel }]; aLabel === null means the compare column should NOT be mapped
  function evaluateMapping(result, truth, extraPairs) {
    const mapping = result.mapping.concat((extraPairs || []).map(x => ({ bLabel: x.bLabel, aLabel: x.aLabel })));
    const byB = {};
    mapping.forEach(m => { byB[m.bLabel] = m; });
    const rows = [];
    let correct = 0, wrong = 0, missed = 0;
    truth.forEach(t => {
      const m = byB[t.bLabel];
      const got = m ? m.aLabel : null;
      const ok = t.aLabel === null ? !m : got === t.aLabel;
      if (ok) correct++;
      else if (t.aLabel === null || m) wrong++;
      else missed++;
      rows.push({ compare: t.bLabel, expected: t.aLabel, got, ok });
    });
    mapping.forEach(m => {
      if (!truth.some(t => t.bLabel === m.bLabel)) { wrong++; rows.push({ compare: m.bLabel, expected: null, got: m.aLabel, ok: false, extra: true }); }
    });
    const total = truth.length + mapping.filter(m => !truth.some(t => t.bLabel === m.bLabel)).length;
    return { rows, correct, wrong, missed, total, accuracy: total ? correct / total : 0, errorRate: total ? (wrong + missed) / total : 0 };
  }

  // ================= orchestration =================
  // opts: { key?: {aId,bId}, mapping?: [...], known?: [{bLabel,aLabel}] }
  function runReconciliation(fileA, fileB, opts) {
    opts = opts || {};
    const A = prepareFile(fileA), B = prepareFile(fileB);
    const det = detectKeys(A, B);
    let key = opts.key;
    if (!key) {
      if (!det.best) return { error: 'No suitable key column found. Pick a key in the Mapping tab.', A, B };
      key = det.best;
    }
    const join = joinOn(A, B, A.colsById[key.aId], B.colsById[key.bId]);
    const sug = suggestMapping(A, B, key, join, { known: opts.known });
    const mapping = opts.mapping || sug.auto.map(c => ({
      aId: c.aId, bId: c.bId, conf: c.conf, ns: c.ns, vs: c.vs, ambiguous: c.ambiguous,
      alternative: c.alternative, stage: c.stage, reason: c.reason
    }));
    const result = analyze(A, B, key, mapping);
    return { A, B, key, keyAlternatives: det.alternatives, suggestion: sug, result };
  }

  const api = {
    isBlank, normText, normPhone, normName, isPlaceholder, compareValues, rowSimilarity,
    typeOf, typeHist, typeSim, nameScore,
    unmojibake, repaired, keyNorm,
    prepareFile, detectKey, detectKeys, joinOn, suggestMapping, analyze, runReconciliation, evaluateMapping,
    mapStatus, confLabel, cleanHeader, hkey, detectKind, pairKind
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Reconcile = api;
})(typeof self !== 'undefined' ? self : this);

