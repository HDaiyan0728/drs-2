# Data Reconciliation Studio

A browser-based tool for validating client-provided Excel/CSV data against system exports before UAT. It compares any number of source and comparison worksheets, each pair independently, matches differently named columns with explained confidence, and produces Excel and HTML reports in which every discrepancy can be traced to its file, worksheet, column and Excel row.

All parsing, matching and reporting run in the user's browser. Spreadsheet contents are never sent to a server or to an AI service.

## Project files

```text
.
├── index.html                   # The application (Vercel entry point)
├── engine.js                    # Matching and comparison engine (no DOM; also runs in Node)
├── report.js                    # Report model, Excel workbook and HTML report builders
├── Reconciliation_Studio.html   # Single-file build (generated: npm run build:standalone)
├── scripts/build-standalone.js
├── tests/                       # Unit, workflow, UI and benchmark tests (not deployed)
│   ├── fixtures/benchmark.js    # Labelled column-matching benchmark
│   ├── baseline/engine_v2.js    # The previous engine, kept for comparison
│   └── *.test.js
├── HANDOVER.md                  # Design decisions, thresholds and how to tune them
├── package.json, vercel.json, .vercelignore
```

## Using it

1. **Add files.** Drop any number of `.xlsx`, `.xlsm`, `.xls` or `.csv` files into *Source files* (e.g. the client's data) and *Comparison files* (e.g. the system export). Each file lists its worksheets with row count, detected header row and any problems (empty sheet, duplicate or missing column names). Remove a file with its *Remove* button.
2. **Build the comparison plan.** Every comparison is one source worksheet against one comparison worksheet.
   - If each side has a single worksheet with data, they are paired automatically.
   - Otherwise the studio suggests pairs whose column names clearly match (mutual best match with a clear lead). Worksheets without a clear counterpart are left unpaired and reported, never forced into a pair.
   - *Every source worksheet against one comparison worksheet* covers "A, B, C and D each against System.xlsx".
   - *One source worksheet against every comparison worksheet* covers the reverse.
   - *Add one pair* for anything else. Pairs with few similar column names are flagged.
3. **Run.** Each pair is processed separately, with progress shown. Results are never merged across pairs.
4. **Review.** *Run overview* lists every comparison with its status. Open one to see its tabs:
   - **Column mapping**: the key, each proposed mapping, its confidence, status and evidence. Tick *Use this mapping* to accept a proposal, or pick another column. *Apply mapping & re-run* updates the results.
   - **Missing & extra**, **Discrepancies**, **Record comparison**, **Data quality**.
5. **Download reports** (Excel and HTML) for the whole run.

## How column matching works

The engine gathers several independent kinds of evidence for every (source column, comparison column) pair and explains each one.

| Evidence | What it does | Example |
|---|---|---|
| Normalisation | Case, spacing, punctuation, camelCase, `#`, `%`, `O/S`, `A/C` | `customer_id` = `CustomerID` |
| Abbreviations | Dictionary plus a general rule (letters in order, same first letter) | `Cust Ref` = `Customer Reference`, `Credit Lmt` = `Credit Limit` |
| Word order and stop words | Compared as weighted word sets | `Date of Birth` = `Birth Date` |
| Typos | Edit distance that counts swapped letters as one edit | `Emial Address` ≈ `Email Address` |
| Synonyms | A deliberately narrow list of business synonyms | `Surname` = `Last Name`, `Sex` = `Gender` |
| Field kind | Identifier, name, date, amount, quantity, flag, rate, year | `Customer ID` ≠ `Customer Name` |
| Specificity | One-word or generic names need other evidence | `Status` vs `Order Status`, `City` vs `Permanent City` |
| Column profile | Value type, format shape, uniqueness, length, shared value domain | dates never match amounts |
| Values on matched records | Agreement on records joined by the key, corrected for chance | `Field 7` = `Segment` when the values agree |

**Chance correction.** Two unrelated Yes/No columns agree about half the time by coincidence. The engine compares agreement on correctly joined records with agreement on deliberately misaligned records and reports only the agreement *beyond chance*.

**Dirty data still maps.** In UAT the system data is often wrong, and those differences are what the tool must surface. So value evidence measures whether two columns are clearly *related* (it saturates at 70% agreement beyond chance), rather than demanding that they agree perfectly. Look-alike columns, such as *Shipping City* that usually equals *Billing City*, are separated by competition (next section).

**One-to-one assignment with competition.** Columns are assigned by an optimal one-to-one assignment (Hungarian algorithm). A mapping is auto-accepted only if it also leads its closest competitor by a clear margin. The competitor can be another source column for the same comparison column, or another comparison column for the same source column. The closest alternative is shown with every decision.

### Confidence tiers

| Tier | Rule | Used in the comparison? |
|---|---|---|
| **Auto-accepted** | Confidence ≥ 80%, leads the next candidate by ≥ 12 points (≥ 5 for identical names), no field-kind conflict | Yes |
| **Needs review** | Confidence ≥ 50% but not auto-accepted | **No, until you tick *Use this mapping*** |
| **Unresolved** | Below 50%, or no compatible candidate | No; the best guess is shown |
| **Confirmed / Remembered** | You confirmed it, now or in an earlier run | Yes |
| **Chosen by you** | You picked a different column | Yes |

Reports state how many proposals were left unreviewed and list their columns as unmatched, so an unchecked column is never presented as checked.

### Without a shared key

If no column identifies the same records in both worksheets, mapping still runs on names and column profiles and is shown for review, and you can choose the key yourself. The previous version produced no mapping at all in this case.

### Remembering mappings

When *Remember mappings I confirm* is on, mappings you accept, choose or reject are stored in this browser's local storage. Each one is stored as normalised column name plus value type, for example `customerid|text`, never as values. They are proposed as *Remembered* the next time similar files appear. You can forget them at any time. *Save mapping profile* and *Load mapping profile* move confirmed mappings between computers as JSON.

## Value comparison

Matched records are compared cell by cell after type-aware normalisation:

- **Dates**: calendar day in the user's own time zone. Formats include ISO, `dd/mm/yyyy`, `15-Mar-2024`, `Mar 15, 2024` and date/time values. When a column's day/month order can't be determined, a value such as `03/04/2024` is reported as **Cannot compare reliably** rather than guessed.
- **Numbers**: thousands separators, currency symbols, `(250)` for negatives and percentages are understood. Exact by default; an absolute tolerance is supported in the engine (`analyze(..., { tolerance })`).
- **Other types**: yes/no values, phone numbers (last 9 digits), personal names (titles ignored), case and spacing, and mis-encoded text (`Ã©` for `é`).

Each cell is classified as **exact**, **format only** (equal after normalisation), **value conflict**, **placeholder** (e.g. "Other"), **garbled text**, **cannot compare reliably**, **blank in source**, **blank in comparison**, or **both blank**. Blank, uncomparable and garbled values are never counted as matches. Original values are kept and shown in every view and report, along with the reason for the classification.

## Reports

**Excel** (every sheet has frozen headers, filters and sized columns; empty sections are left out):

- *Summary*
- *Comparisons*, one row per pair
- *Column Mapping*: confidence, lead over the next candidate, closest alternative and evidence
- *Unmatched Columns*
- *Value Discrepancies*
- *Missing Records* and *Extra Records*
- *Duplicate Keys*
- *Errors & Warnings*
- A side-by-side *Cn Records* sheet per comparison, for runs of up to 12 comparisons

**HTML**: one self-contained file that works offline. It has:

- an executive summary with an overall status;
- summary cards;
- a comparisons table;
- an expandable section per comparison, with mapping evidence and unmatched columns;
- searchable, filterable, sortable and paged tables of discrepancies and of missing and extra records.

To keep the file usable, it shows at most 25,000 discrepancies and 10,000 missing or extra records. The Excel report always has every row.

**Traceability.** Every discrepancy row carries:

- the comparison ID;
- the original record key;
- source file, worksheet, column and Excel row;
- comparison file, worksheet, column and Excel row;
- both original values;
- the issue and its reason.

Rows are matched by key, never by position. Excel row numbers come from the sheet itself, so they stay correct when there are title rows above the header or blank rows.

## Limits and deployment

**Vercel's role.** The deployment is static. Vercel only serves the files, so Vercel function time, memory and request-size limits do not apply to the analysis. The real limits are the user's browser memory and the browser's main thread.

**Measured performance.** These timings come from Node on a sandbox machine; expect browsers to be similar or somewhat slower.

| Rows × columns | Prepare | Find key | Match columns | Compare values | Total |
|---|---|---|---|---|---|
| 10,000 × 39 | 0.7 s | 0.3 s | 0.9 s | 0.4 s | about 2.4 s |
| 50,000 × 39 | 0.4 s | 1.6 s | 1.4 s | 2.8 s | about 6.4 s |

The previous engine took 13.9 s for 10,000 rows × 39 columns. Column matching now samples up to 3,000 joined records per comparison, so its cost no longer grows with file size.

**Browser responsiveness.** The page yields between files, worksheets and comparisons and shows progress. Each single analysis still runs on the main thread, so the page pauses for a few seconds on very large sheets.

**Above about 100,000 rows per worksheet or about 50 MB per file:**
- move analysis into a Web Worker (the engine has no DOM dependencies, so this is mechanical); or
- run the same `engine.js` in Node on a machine with more memory.

Do **not** move processing into Vercel serverless functions. Request bodies are capped (4.5 MB), execution time is limited, and the workbooks would leave the user's machine.

**Other limits:**
- **One record per key.** If the comparison file has duplicate keys, the most complete row is compared and the duplicates are reported. One-to-many (transaction-level) matching is not supported.
- **Single-column keys only.** Composite keys are not supported yet; you can add a concatenated key column to both files as a workaround.
- **Formulas.** The values Excel last saved are used; formulas are not recalculated.
- **Synthetic benchmark.** The benchmark data is synthetic (see `HANDOVER.md`). Validate thresholds against a few of your own file pairs with confirmed mappings before relying on auto-acceptance.

## Run, test and deploy

```bash
npm install                 # dev dependencies for tests only; the app itself has no build step
npm test                    # 24 tests: comparison rules, matching, real .xlsx round trips, reports, UI (jsdom)
npm run benchmark           # column-matching benchmark: previous engine vs current engine
npm run build:standalone    # regenerate Reconciliation_Studio.html after changing index.html, engine.js or report.js
python -m http.server 8080  # or: vercel dev
```

**Deploying on Vercel:** use Framework Preset *Other*, with no build command and no output directory. `.vercelignore` keeps `tests/` and `scripts/` out of the deployment.

**Offline use.** The page loads SheetJS 0.18.5, Chart.js 4.4.1 and ExcelJS 4.4.0 from cdnjs. For offline or locked-down use, download those three files, serve them next to `index.html`, update the three `<script>` tags, and add a Content Security Policy.

## Privacy

- Workbook contents stay in the browser.
- Mapping memory stores only normalised column names and value types.
- No external AI service is used. If one is added later, it should be opt-in and should send column names and a handful of sample values at most, never whole workbooks (see `HANDOVER.md`).
- Use synthetic or anonymised data in test fixtures and demos.
