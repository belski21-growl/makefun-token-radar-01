// Token Radar — entry point, second draft (Node 22, standard library only).
//
// What one run does, in order: read the sealed snapshot (from
// /input/snapshot.json, or wherever --input points), score every pre-token
// protocol with the radar-3f model in lib/model.ts — the size curve fitted
// to the snapshot's own traded tokens while the run is happening, plus the
// three small growth / maturity / breadth terms — and lay out the output
// directory: the ranked board.json, the dashboard's data.js, a copy of
// dashboard/ and screenshots/, and finally the dossier.json the sealed
// scorer rebuilds and compares byte for byte. Before the dossier is sealed,
// board.json and data.js are read back off the disk and checked against the
// board still in memory, so a truncated or altered write fails loudly here
// instead of quietly in the grader's sandbox.
//
// The grade runs this program twice and both runs must land the same bytes:
// the model is a pure function of the snapshot (the curve is fitted from the
// snapshot itself, ties break by slug), so the output is deterministic.
//
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

// The folder this file lives in — dashboard/ and screenshots/ sit beside it.
const repoRoot = fileURLToPath(new URL('.', import.meta.url));

/** The scorer's caps, from reference/gate.json: the text cap shapes bytes, the rest refuse. */
const MAX_TEXT_BYTES = 65_536;
const SHOT_LIMITS = { max: 4, max_bytes: 524_288 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/**
 * Pull a `--name value` or `--name=value` flag out of the arguments, falling
 * back when the flag is absent — or present with nothing after it.
 */
function flagOf(name: string, fallback: string): string {
  const args = process.argv;
  const bare = `--${name}`;
  const joined = `${bare}=`;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === bare && i + 1 < args.length) return args[i + 1]!;
  }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith(joined)) return a.slice(joined.length);
  }
  return fallback;
}

// Where the snapshot comes from: a file, or a directory holding snapshot.json.
const inputGiven = flagOf('input', '/input');
const snapshotFile = inputGiven.endsWith('.json') ? inputGiven : join(inputGiven, 'snapshot.json');
if (!existsSync(snapshotFile)) {
  process.stderr.write(`token radar: no snapshot at ${snapshotFile}: pass --input <snapshot.json|directory> or mount the sealed /input\n`);
  process.exit(2);
}

// Where the output goes: --output wins, then the environment, then /output.
const outDir = flagOf('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

// Score the snapshot. A board the gate refuses never reaches the disk.
const snap = parseSnapshot(readFileSync(snapshotFile, 'utf8'));
const { board, radar, fit } = buildRadar(snap);
const gateIssue = boardIssue(board, snap);
if (gateIssue !== null) {
  process.stderr.write(`token radar: the model wrote a board the gate refuses: ${gateIssue}\n`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(outDir, 'data.js'), dataScript(radar));

/**
 * Copy one directory's regular files into `to`, skipping dotfiles, and
 * report the names copied. A missing source directory copies nothing at all.
 */
function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const names: string[] = [];
  const listed = readdirSync(from);
  for (let i = 0; i < listed.length; i++) {
    const name = listed[i]!;
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    names.push(name);
  }
  return names;
}

const dashboardFiles = copyFiles(join(repoRoot, 'dashboard'), join(outDir, 'dashboard'));
const shotFiles = copyFiles(join(repoRoot, 'screenshots'), join(outDir, 'screenshots'));
if (shotFiles.length < 3) {
  process.stderr.write(`token radar: screenshots/ holds ${shotFiles.length} image${shotFiles.length === 1 ? '' : 's'}: hand in 3, the board, a detail view and a filtered view\n`);
  process.exit(1);
}
for (let i = 0; i < shotFiles.length; i++) {
  const name = shotFiles[i]!;
  if (!IMAGE_NAME.test(name)) {
    process.stderr.write(`token radar: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters\n`);
    process.exit(1);
  }
}

/**
 * Read board.json and data.js back off the disk and check them against the
 * board in memory, before the dossier seals them: a short write, a wrong row
 * count or a changed top value must fail here, not in the grader's sandbox.
 * A board that came back empty has nothing to seal.
 */
function checkWrittenBoard(): void {
  const onDisk = JSON.parse(readFileSync(join(outDir, 'board.json'), 'utf8')) as { rows?: unknown[] };
  const diskRows = Array.isArray(onDisk.rows) ? onDisk.rows.length : -1;
  if (diskRows !== board.length) {
    process.stderr.write(`token radar: board.json on disk holds ${diskRows < 0 ? 'no' : diskRows} rows, the model wrote ${board.length}\n`);
    process.exit(1);
  }
  const diskFirst = (onDisk.rows as { implied_value_usd?: unknown }[])[0];
  if (board.length === 0 || diskFirst?.implied_value_usd !== board[0]!.implied_value_usd) {
    process.stderr.write('token radar: board.json on disk disagrees with the board in memory on rank 1\n');
    process.exit(1);
  }
  const dataRaw = readFileSync(join(outDir, 'data.js'), 'utf8');
  const dataPayload = dataRaw.replace(/^window\.RADAR=/, '').replace(/;\n?$/, '');
  const dataParsed = JSON.parse(dataPayload) as { rows?: unknown[] };
  if (!Array.isArray(dataParsed.rows) || dataParsed.rows.length !== board.length) {
    process.stderr.write('token radar: data.js on disk does not carry the board\n');
    process.exit(1);
  }
}
checkWrittenBoard();

// The dossier is written last: the scorer rebuilds it from this /output and compares bytes.
writeFileSync(join(outDir, 'dossier.json'), buildDossier(outDir, { text_max_bytes: MAX_TEXT_BYTES, screenshots: SHOT_LIMITS, dashboard: { max_files: 400, max_bytes: 4_194_304 } }));

process.stdout.write(
  `token radar: ${snap.protocols.length} protocols, ${snap.watchlist.length} on the watchlist, ${board.length} rows scored (${radar.early_size} early, ${radar.live_size} live set aside)\n` +
    `token radar: fitted curve log10(mcap) = ${fit.intercept.toFixed(4)} + ${fit.slope.toFixed(4)} * log10(TVL), R² = ${fit.r_squared.toFixed(4)}, n = ${fit.n_comps} comps (${fit.zero_mcap_excluded} zero-mcap excluded)\n` +
    `token radar: wrote ${join(outDir, 'board.json')}, ${join(outDir, 'data.js')}, ${join(outDir, 'dashboard')} (${dashboardFiles.length} files), ${join(outDir, 'screenshots')} (${shotFiles.length} images) and ${join(outDir, 'dossier.json')}\n`,
);
