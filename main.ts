// Token Radar — the entry point (Node 22, standard library only).
//
// The run, end to end: read the sealed snapshot (from /input/snapshot.json,
// or wherever --input points), score every pre-token protocol with the
// radar-3 model in lib/model.ts, and lay out /output — the ranked
// board.json, the dashboard's data.js (round 2: each category's comparable
// multiple now travels with its basis — how many live comparables set it,
// whether it fell back to the global median, and how crowded its field is),
// a copy of dashboard/ and screenshots/, and finally the dossier.json the
// sealed scorer rebuilds and compares byte for byte. Before the dossier is
// sealed, board.json and data.js are read back off the disk and checked
// against the board still in memory, so a truncated or altered write fails
// loudly here instead of quietly in the grader's sandbox.
//
// The grade runs this program twice and both runs must land the same bytes:
// the model is a pure function of the snapshot (multiples come from the
// snapshot itself, ties break by slug), so the output is deterministic.
//
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot, type BoardRow } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

// The folder this file lives in — dashboard/ and screenshots/ sit beside it.
const here = fileURLToPath(new URL('.', import.meta.url));

/** The scorer's caps, from reference/gate.json: the text cap shapes bytes, the rest refuse. */
const MAX_TEXT_BYTES = 65_536;
const SHOT_LIMITS = { max: 4, max_bytes: 524_288 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/**
 * Read a `--name value` or `--name=value` flag out of the arguments, falling back
 * when the flag is absent — or present with nothing after it.
 */
function readFlag(name: string, fallback: string): string {
  const argv = process.argv;
  const bare = argv.indexOf(`--${name}`);
  if (bare >= 0 && bare + 1 < argv.length) return argv[bare + 1]!;
  const joined = argv.find((a) => a.startsWith(`--${name}=`));
  return joined === undefined ? fallback : joined.slice(name.length + 3);
}

// Where the snapshot comes from: a file, or a directory holding snapshot.json.
const inputArg = readFlag('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`token radar: no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input\n`);
  process.exit(2);
}

// Where the output goes: --output wins, then the environment, then /output.
const out = readFlag('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

// Score the snapshot. A board the gate refuses never reaches the disk.
const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const { board, radar } = buildRadar(snapshot);
const issue = boardIssue(board, snapshot);
if (issue !== null) {
  process.stderr.write(`token radar: the model wrote a board the gate refuses: ${issue}\n`);
  process.exit(1);
}

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(out, 'data.js'), dataScript(radar));

/**
 * Copy one directory's regular files into `to`, skipping dotfiles, and report the
 * names copied. A missing source directory copies nothing at all.
 */
function copyPlainFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

const dash = copyPlainFiles(join(here, 'dashboard'), join(out, 'dashboard'));
const shots = copyPlainFiles(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3) {
  process.stderr.write(`token radar: screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'}: hand in 3, the board, a detail view and a filtered view\n`);
  process.exit(1);
}
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) {
    process.stderr.write(`token radar: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters\n`);
    process.exit(1);
  }
}

/**
 * Read board.json and data.js back off the disk and check them against the board in
 * memory, before the dossier seals them: a short write, a wrong row count or a
 * changed top value must fail here, not in the grader's sandbox. A board that came
 * back empty has nothing to seal. The round-2 comparable detail is checked too:
 * every board row's category must carry a detail entry, and each detail's multiple
 * must be the category multiple or the global one — so a data.js that lost the
 * transparency fields fails here instead of rendering a bare multiple.
 *
 * Round 3 adds: fit (n_comps=119), odds (5 buckets + base_rate + auc),
 * validation (ablation + walkforward + band_hold), per-row bands/ranks/econ,
 * verdict_counts (sums to 198), best_farms (≤5, net_per_hour>0).
 */

function parseDataJs(text: string): Record<string, unknown> {
  const cleaned = text.replace(/^window\.RADAR=/, '').replace(/;\n?$/, '');
  return JSON.parse(cleaned) as Record<string, unknown>;
}

function assertBoardMatchesDisk(writtenRows: unknown[], expectedCount: number, topImplied: number): void {
  const rowsOnDisk = Array.isArray(writtenRows) ? writtenRows.length : -1;
  if (rowsOnDisk !== expectedCount) {
    process.stderr.write(`token radar: board.json on disk holds ${rowsOnDisk < 0 ? 'no' : rowsOnDisk} rows, the model wrote ${expectedCount}\n`);
    process.exit(1);
  }
  if (expectedCount === 0 || (writtenRows[0] as { implied_value_usd?: unknown })?.implied_value_usd !== topImplied) {
    process.stderr.write('token radar: board.json on disk disagrees with the board in memory on rank 1\n');
    process.exit(1);
  }
}

function assertDataJsCarriesBoard(parsedData: Record<string, unknown>, expectedCount: number): void {
  if (!Array.isArray(parsedData.rows) || parsedData.rows.length !== expectedCount) {
    process.stderr.write('token radar: data.js on disk does not carry the board\n');
    process.exit(1);
  }
}

function assertComparableDetailPresent(detail: Record<string, unknown>): void {
  if (typeof detail !== 'object' || detail === null || Object.keys(detail).length === 0) {
    process.stderr.write('token radar: data.js on disk carries no comparable detail\n');
    process.exit(1);
  }
}

function assertEveryCategoryHasDetail(board: BoardRow[], detail: Record<string, unknown>): void {
  for (const row of board) {
    const cat = row.category ?? 'Other';
    if (detail[cat] === undefined) {
      process.stderr.write(`token radar: data.js on disk has no comparable detail for ${cat}\n`);
      process.exit(1);
    }
  }
}

function assertDetailMultipleMatches(board: BoardRow[], parsedData: Record<string, unknown>, detail: Record<string, unknown>): void {
  for (const row of board) {
    const cat = row.category ?? 'Other';
    const entry = detail[cat] as { multiple?: unknown };
    const priced = (parsedData.comp_by_category as Record<string, unknown> | undefined)?.[cat];
    const expected = priced !== undefined ? priced : parsedData.comp_global;
    if (entry.multiple !== expected) {
      process.stderr.write(`token radar: data.js on disk disagrees with the board on the comparable multiple for ${cat}\n`);
      process.exit(1);
    }
  }
}

function assertFitPresent(fit: unknown): void {
  const f = fit as Record<string, unknown> | undefined;
  if (!f || typeof f !== 'object') {
    process.stderr.write('token radar: data.js on disk missing fit object\n');
    process.exit(1);
  }
  if (f.n_comps !== 119) {
    process.stderr.write(`token radar: data.js fit.n_comps is ${f.n_comps}, expected 119\n`);
    process.exit(1);
  }
}

function assertOddsPresent(odds: unknown): void {
  const o = odds as { buckets?: unknown[]; base_rate?: unknown; auc?: unknown } | undefined;
  if (!o || typeof o !== 'object') {
    process.stderr.write('token radar: data.js on disk missing odds object\n');
    process.exit(1);
  }
  if (!Array.isArray(o.buckets) || o.buckets.length !== 5) {
    process.stderr.write(`token radar: data.js odds.buckets has ${Array.isArray(o.buckets) ? o.buckets.length : 'no'} entries, expected 5\n`);
    process.exit(1);
  }
  if (typeof o.base_rate !== 'number' || typeof o.auc !== 'number') {
    process.stderr.write('token radar: data.js odds missing base_rate or auc\n');
    process.exit(1);
  }
}

function assertValidationPresent(validation: unknown): void {
  const v = validation as { ablation?: unknown; walkforward?: unknown; band_hold?: unknown } | undefined;
  if (!v || typeof v !== 'object') {
    process.stderr.write('token radar: data.js on disk missing validation object\n');
    process.exit(1);
  }
  if (!Array.isArray(v.ablation) || v.ablation.length === 0) {
    process.stderr.write('token radar: data.js validation.ablation missing or empty\n');
    process.exit(1);
  }
  if (!v.walkforward || typeof v.walkforward !== 'object') {
    process.stderr.write('token radar: data.js validation.walkforward missing\n');
    process.exit(1);
  }
  if (!v.band_hold || typeof v.band_hold !== 'object') {
    process.stderr.write('token radar: data.js validation.band_hold missing\n');
    process.exit(1);
  }
}

function assertRowsHaveBandsAndRanksAndEcon(rows: unknown[]): void {
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] as Record<string, unknown>;
    const required = ['band_lo', 'band_hi', 'band_lo90', 'band_hi90', 'rank_lo', 'rank_hi', 'econ'];
    for (const field of required) {
      if (!(field in r) || r[field] === undefined || r[field] === null) {
        process.stderr.write(`token radar: data.js row ${i} (${r.slug ?? 'unknown'}) missing ${field}\n`);
        process.exit(1);
      }
    }
    const econ = r.econ as Record<string, unknown>;
    if (!econ || typeof econ !== 'object' || econ.verdict === undefined) {
      process.stderr.write(`token radar: data.js row ${i} (${r.slug ?? 'unknown'}) econ missing verdict\n`);
      process.exit(1);
    }
  }
}

function assertVerdictCounts(vc: unknown): void {
  const counts = vc as Record<string, number> | undefined;
  if (!counts || typeof counts !== 'object') {
    process.stderr.write('token radar: data.js missing verdict_counts\n');
    process.exit(1);
  }
  const keys = ['farm', 'thin', 'marginal', 'skip', 'robust'];
  for (const k of keys) {
    if (typeof counts[k] !== 'number') {
      process.stderr.write(`token radar: data.js verdict_counts.${k} missing\n`);
      process.exit(1);
    }
  }
  const sum = keys.reduce((acc, k) => acc + (counts[k] ?? 0), 0);
  if (sum !== 198) {
    process.stderr.write(`token radar: data.js verdict_counts sums to ${sum}, expected 198\n`);
    process.exit(1);
  }
}

function assertBestFarms(bf: unknown): void {
  const farms = bf as Array<{ net_per_hour: number }> | undefined;
  if (!Array.isArray(farms)) {
    process.stderr.write('token radar: data.js best_farms missing or not an array\n');
    process.exit(1);
  }
  if (farms.length > 5) {
    process.stderr.write(`token radar: data.js best_farms has ${farms.length} entries, expected at most 5\n`);
    process.exit(1);
  }
  for (let i = 0; i < farms.length; i++) {
    if (typeof farms[i]?.net_per_hour !== 'number' || farms[i].net_per_hour <= 0) {
      process.stderr.write(`token radar: data.js best_farms[${i}] has net_per_hour ${farms[i]?.net_per_hour}, expected > 0\n`);
      process.exit(1);
    }
  }
}

function checkWrittenOutputs(): void {
  const written = JSON.parse(readFileSync(join(out, 'board.json'), 'utf8')) as { rows?: unknown[] };
  assertBoardMatchesDisk(written.rows ?? [], board.length, board[0]?.implied_value_usd ?? 0);

  const dataText = readFileSync(join(out, 'data.js'), 'utf8');
  const parsedData = parseDataJs(dataText);

  assertDataJsCarriesBoard(parsedData, board.length);

  const detail = parsedData.comp_by_category_detail as Record<string, unknown> | undefined;
  assertComparableDetailPresent(detail ?? {});
  assertEveryCategoryHasDetail(board, detail ?? {});
  assertDetailMultipleMatches(board, parsedData, detail ?? {});

  assertFitPresent(parsedData.fit);
  assertOddsPresent(parsedData.odds);
  assertValidationPresent(parsedData.validation);
  assertRowsHaveBandsAndRanksAndEcon(parsedData.rows as unknown[]);
  assertVerdictCounts(parsedData.verdict_counts);
  assertBestFarms(parsedData.best_farms);
}
checkWrittenOutputs();

// The dossier is written last: the scorer rebuilds it from this /output and compares bytes.
writeFileSync(join(out, 'dossier.json'), buildDossier(out, { text_max_bytes: MAX_TEXT_BYTES, screenshots: SHOT_LIMITS, dashboard: { max_files: 400, max_bytes: 4_194_304 } }));

process.stdout.write(
  `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows scored (${radar.early_size} early, ${radar.live_size} live set aside)\n` +
    `token radar: wrote ${join(out, 'board.json')}, ${join(out, 'data.js')}, ${join(out, 'dashboard')} (${dash.length} files), ${join(out, 'screenshots')} (${shots.length} images) and ${join(out, 'dossier.json')}\n`,
);
