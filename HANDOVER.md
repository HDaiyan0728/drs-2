# Data Reconciliation Studio: handover (v3)

Last updated: 26 Oct 2026. Read `README.md` first for usage. This document explains why the engine works the way it does, how it was evaluated, and how to change it safely.

## 1. What changed from v2, and why

Each problem below was reproduced against the v2 code before it was changed. The v2 engine is kept as `tests/baseline/engine_v2.js`.

| v2 problem | Effect | v3 fix |
|---|---|---|
| `index.html` pooled all uploaded files and worksheets into one dataset | Unrelated sheets mixed; one ambiguous result | A comparison plan: every source/comparison worksheet pair runs and reports independently |
| "id", "name", "date" and "number" discarded as generic words | `Customer ID ↔ Customer Name` and `Order Date ↔ Order Number` scored 0.88 | Words describing the kind of field are kept; differing kinds cap the name score at 0.2 |
| Over-broad synonym groups | `Status = Is Active`, `Title = Job Title`, `Cost = Price` scored 0.94 | Narrow, phrase-level synonyms; single generic words are synonyms of nothing |
| Raw value agreement | Unrelated Yes/No columns agree ~50% by chance | Agreement corrected for chance using deliberately misaligned records |
| Dates via `toISOString()` | Every date shifted one day back in UTC+ zones (Dhaka) | Local calendar components; Excel output written as wall-clock dates |
| No number, date or boolean normalisation | `1000` vs `"1,000"`, `100` vs `"100.00"`, `Yes` vs `TRUE` reported as conflicts | Typed comparison with explicit "cannot compare" outcomes |
| Row number assumed header on row 1 and no blank rows | Wrong Excel row references | Real sheet row numbers carried on every row |
| Greedy assignment; ambiguity checked in one direction only | Look-alike columns stolen; competing uses of a source column ignored | Hungarian assignment plus a margin over competitors in both directions |
| No key meant no mapping at all | Nothing to review | Mapping by names and profiles, offered for review |
| Every row scored for every column pair | 13.9 s for 10k rows × 39 columns | Values normalised once per column; 3,000-record sample; ~2.4 s |
| UI showed ambiguous pairs as "Auto-matched" (`mapStatus` called without the ambiguity flag) | Misleading status | Statuses come from the tier decision |
| Excel *Mismatches* colouring targeted the wrong column (`ci === 5`) | Wrong colours | Report rewritten (`report.js`) |
| `index.html` and `Reconciliation_Studio.html` diverged; test scripts listed in the old handover were not in the repo | Unclear source of truth | `index.html` is the source; the standalone file is generated; tests live in `tests/` |

## 2. Engine pipeline (`engine.js`)

1. **Ingest.** `readSheet(XLSX, ws)` → `tableFromAOA`.
   - The header row is found among the first 30 rows.
   - Duplicate and missing header names are renamed and reported.
   - Fully blank rows are skipped without renumbering. Each row object carries a hidden `__row` with its Excel row number.
2. **Prepare.** `prepareFile` builds a column profile from up to 3,000 sampled values: type histogram, dominant type, distinct ratio, value-shape histogram, value frequency, numeric range, date day/month order and average length. A *First + Last* virtual column is added when both exist, and dropped if a real full-name column exists.
3. **Find the key.** `detectKeys` looks for columns at least 95% unique and 50% filled on both sides, with at least 30% shared values.
   - The score is value overlap plus a small name bonus plus *key-likeness*: identifier-like names score higher; amounts, decimals, names and long free text score lower.
   - Key-likeness was added after a test caught a small file where a unique *Credit Limit* column tied with the real ID.
   - Phone, date and yes/no columns are never keys.
4. **Join.** `joinOn` uses the normalised key. With duplicate comparison keys, the most complete row (active rows first) is used and the duplicates are reported. Comparison columns whose values are ≥ 98% identical to the source key are *key aliases* and are not compared as data.
5. **Score every candidate pair.** `scorePair` returns `conf` plus an `evidence` list (see §3).
6. **Decide.** `suggestMapping`:
   - Locks *confirmed* pairs first, then *remembered* pairs.
   - Runs a Hungarian maximum-weight assignment on the remaining columns.
   - Computes each pair's margin over the best competitor, in both directions, and assigns a tier (§4). It returns `decisions` (one per comparison column), `auto` (what is used), `proposals` (review tier) and `candidates`.
7. **Analyse.** `analyze` compares every matched record and mapped column with `compareCell`, which returns `{ s: status, why }`. Issues carry the original key, both Excel rows, the original values and the reason.

## 3. Confidence formula

Name evidence `ns` (0..1, from `nameScore`):

| Match type | Score |
|---|---|
| Exact after normalisation | 1.00 |
| Same canonical words (abbreviation, order or format differs) | 0.96 |
| Synonym phrase | 0.92 |
| Otherwise: 0.85 × weighted soft word-set similarity | ≤ 0.85 |
| Whole-name spelling variant (alternative score, used when higher) | 0.9 × edit-distance ratio, when the ratio ≥ 0.85 |

Word weights fall when a word appears in many headers across the two files: the more date columns a file has, the less "date" counts. Two caps apply:
- **Different field kinds:** capped at 0.20.
- **Generic or less specific name:** capped at 0.55.

**With value evidence** (at least 12 joined records with values on both sides):

```
corrected = (observed − chance) / (1 − chance)      # also computed on soft text similarity
related   = min(1, corrected / 0.70)                # THRESHOLDS.valueKnee
conf      = 0.30·ns + 0.55·related + 0.15·corrected
```

- *Decisive values:* if corrected ≥ 0.9 on ≥ 30 records with ≥ 3 distinct values and no field-kind conflict, then conf ≥ 0.86.
- If corrected < 0.25 but the name score is at least 0.9, conf stays at least 0.55, so the pair goes to review.
- If corrected < 0.15 and the name score is below 0.9, conf is capped at 0.3.

**Without value evidence:**

```
conf = ns · (0.55 + 0.45·profile)
```

- Plus up to 0.1 for a shared categorical value domain.
- Capped at 0.9 unless the names are identical.

**Penalties in both cases:**
- Type-compatibility below 0.3 rejects the pair outright, unless the names are identical.
- Type-compatibility below 0.6 multiplies conf by 0.85.
- Virtual columns lose 0.04.
- A field-kind conflict caps conf at 0.79, so such pairs can never be auto-accepted.

## 4. Thresholds (`THRESHOLDS` in `engine.js`)

| Name | Value | Meaning |
|---|---|---|
| `accept` | 0.80 | Minimum confidence for auto-acceptance |
| `margin` / `exactMargin` | 0.12 / 0.05 | Required lead over the closest competitor |
| `review` | 0.50 | Below this a column is *Unresolved* |
| `candidateFloor` | 0.30 | Candidates below this are not offered |
| `valueKnee` | 0.70 | Corrected agreement at which value evidence saturates |
| `minComparable` | 12 | Joined records needed for value evidence |
| `sampleSize`, `profileSample` | 3000 | Sampling limits |
| `keyUniqueness`, `keyOverlap` | 0.95, 0.30 | Key detection |

**Rule for changing any threshold:** run `npm run benchmark` before and after. `wrongAccepted` must stay at 0, and a test enforces that. Then re-check against your own confirmed file pairs.

## 5. Evaluation

`npm run benchmark` runs v2 and v3 on the same labelled cases from `tests/fixtures/benchmark.js`:
- 7 domains (3 development, 4 hold-out);
- each in three variants: shared records, no shared records, and dirty data with 30% conflicts and 60% shared records;
- 252 labelled comparison columns in total.

The categories are exact, format, abbreviation/reorder, synonym, different name, ambiguous, misleading name, and distractors (columns that must stay unmapped).

Results at the time of writing:

| Subset | Engine | Precision of auto-accepted | Auto recall | Recall incl. review | Wrong auto-accepts |
|---|---|---|---|---|---|
| All 252 columns | v2 (all suggestions used) | 90.8% | 57.7% | 57.7% | 13 |
| | v2 ("Auto-matched" only) | 96.9% | 28.4% | 57.7% | 2 |
| | **v3** | **100%** | **66.2%** | **84.7%** | **0** |
| Dirty data | v2 | 91.7% | 89.2% | 89.2% | 6 |
| | **v3** | **100%** | 60.8% | **97.3%** | **0** |
| No shared records | v2 | — | 0% | 0% | 0 |
| | **v3** | **100%** | 39.2% | 56.8% | **0** |
| Hold-out, shared records | v3 | 100% | 97.6% | 100% | 0 |

The intended trade-off is visible in the dirty-data row. v3 auto-accepts fewer columns than v2 when data is dirty, and sends the rest to review, but it accepts no wrong columns. v2 auto-accepted 6 wrong mappings there, which would have produced misleading discrepancy counts.

**Honest limitations of this evaluation:**
- **Synthetic data.** Real exports are messier in ways the generator does not model.
- **Same author.** I wrote both the benchmark and the synonym list. The benchmark was written before the v3 synonym list, and hold-out header names were not added to it. However, the correlated look-alike traps were added after the first run, because v3 looked too good, and the `valueKnee` sweep (0.5–1.0) looked at all subsets including hold-out. 0.6–0.7 was a stable plateau with zero wrong accepts; 0.7 was chosen.
- **What's left unresolved.** On the hold-out "no shared records" cases, most misses are true synonyms missing from the list, such as `Supplier ↔ Vendor Name`, `Programme ↔ Course` and `Mileage ↔ Odometer`. With shared records, value evidence resolves them.

**Next validation step:** collect 5–10 real file pairs with mappings confirmed by the business team and add them as benchmark cases. Mappings saved from the UI as profiles (`mapping_profile_*.json`) contain exactly the ground truth needed.

## 6. Optional semantic layer (not implemented — decision needed)

Two options were evaluated on paper only:

1. **In-browser sentence embeddings**, e.g. `transformers.js` with a quantised MiniLM model.
   - About 23 MB downloaded once and cached by the browser.
   - No per-use cost, and data stays local.
   - Would mainly help in the "no shared records" case, with header synonyms the list lacks.
   - It could not be tested here, because the model host was unreachable from the build sandbox.
   - To add it: compute an embedding similarity per header pair and blend it into `ns` (for example, as an alternative to `softSim`, capped at about 0.85 so it never outranks exact or synonym evidence). Then **prove it on the benchmark** before enabling it by default.
2. **An LLM via a Vercel function.**
   - Needs an API key and per-call cost.
   - Would send column names and sample values outside the browser, which needs explicit, informed opt-in.
   - If used, call it only for *Needs review* or *Unresolved* columns, send headers plus at most 5 masked sample values, and treat the answer as one more piece of evidence, never as an automatic acceptance.

**Recommendation:** option 1 as an opt-in experiment, measured with the existing harness.

## 7. Tests

```
npm test             # 24 tests
npm run benchmark    # add --verbose to list every non-auto-accepted or wrong decision
```

- `tests/compare.test.js`: date/time-zone, number, boolean, phone, name, encoding and blank rules.
- `tests/matching.test.js`:
  - name evidence, including the v2 defects;
  - Unicode headers;
  - look-alike columns and chance correction;
  - confirmed, rejected and remembered mappings;
  - one-to-one assignment;
  - the no-key case;
  - the benchmark gate (zero wrong auto-accepts).
- `tests/workflow.test.js`:
  - real `.xlsx` files written and read with SheetJS: header detection, blank rows, Excel row numbers, empty sheets, duplicate headers;
  - sheet pairing;
  - many-to-one and one-to-many comparisons;
  - Excel report read back with ExcelJS (traceability columns, dates not shifted);
  - HTML self-contained and escaped;
  - "Not run" status for a pair without a key.
- `tests/ui.test.js`: the real `index.html` in jsdom with the real libraries. It loads two multi-sheet workbooks, checks the suggested pairs, runs, opens every tab, accepts proposals, and builds both reports. It also checks scenario C through the plan builder.

The suite passes under `TZ=Asia/Dhaka`, `UTC`, `America/New_York` and `Pacific/Auckland`.

## 8. Remaining work, in priority order

1. Validate on real confirmed file pairs and add them to the benchmark (§5).
2. Move analysis into a Web Worker for worksheets above about 100k rows.
3. Composite keys (two or more columns), and a prompt when two different comparison columns both look like the key.
4. A one-to-many (transaction) matching mode.
5. The semantic layer experiment (§6).
6. Bundle SheetJS, Chart.js and ExcelJS locally for offline or locked-down use, and add a CSP.
7. Configurable numeric tolerance per column in the UI (the engine already supports a global `tolerance`).
