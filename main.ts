// Token Radar — the entry point (Node 22, standard library only).
//
// The run, end to end: read the sealed snapshot (from /input/snapshot.json, or wherever
// --input points), score every pre-token protocol with the radar-3f model in lib/model.ts —
// the size curve fitted to the snapshot's own traded tokens at run time, plus the three
// small growth / maturity / breadth terms — and lay out /output: the ranked board.json, the
// dashboard's data.js, a copy of dashboard/ and screenshots/, and finally the dossier.json
// the sealed scorer rebuilds and compares byte for byte. Before the dossier is sealed,
// board.json and data.js are read back off the disk and checked against the board still in
// memory, so a truncated or altered write fails loudly here instead of quietly in the
// grader's sandbox.
//
// The grade runs this program twice and both runs must land the same bytes: the model is a
// pure function of the snapshot (the curve is fitted from the snapshot itself, ties break by
// slug), so the output is deterministic.
//
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
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
function flagValue(name: string, fallback: string): string {
  const argv = process.argv;
  const bare = argv.indexOf(`--${name}`);
  if (bare >= 0 && bare + 1 < argv.length) return argv[bare + 1]!;
  const joined = argv.find((a) => a.startsWith(`--${name}=`));
  return joined === undefined ? fallback : joined.slice(name.length + 3);
}

// Where the snapshot comes from: a file, or a directory holding snapshot.json.
const inputArg = flagValue('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`token radar: no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input\n`);
  process.exit(2);
}

// Where the output goes: --output wins, then the environment, then /output.
const out = flagValue('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

// Score the snapshot. A board the gate refuses never reaches the disk.
const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const { board, radar, fit } = buildRadar(snapshot);
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
function copyDirFiles(from: string, to: string): string[] {
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

const dash = copyDirFiles(join(here, 'dashboard'), join(out, 'dashboard'));
const shots = copyDirFiles(join(here, 'screenshots'), join(out, 'screenshots'));
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
 * back empty has nothing to seal.
 */
function verifyWrittenBoard(): void {
  const written = JSON.parse(readFileSync(join(out, 'board.json'), 'utf8')) as { rows?: unknown[] };
  const rowsOnDisk = Array.isArray(written.rows) ? written.rows.length : -1;
  if (rowsOnDisk !== board.length) {
    process.stderr.write(`token radar: board.json on disk holds ${rowsOnDisk < 0 ? 'no' : rowsOnDisk} rows, the model wrote ${board.length}\n`);
    process.exit(1);
  }
  const first = (written.rows as { implied_value_usd?: unknown }[])[0];
  if (board.length === 0 || first?.implied_value_usd !== board[0]!.implied_value_usd) {
    process.stderr.write('token radar: board.json on disk disagrees with the board in memory on rank 1\n');
    process.exit(1);
  }
  const dataText = readFileSync(join(out, 'data.js'), 'utf8');
  const dataJson = dataText.replace(/^window\.RADAR=/, '').replace(/;\n?$/, '');
  const parsedData = JSON.parse(dataJson) as { rows?: unknown[] };
  if (!Array.isArray(parsedData.rows) || parsedData.rows.length !== board.length) {
    process.stderr.write('token radar: data.js on disk does not carry the board\n');
    process.exit(1);
  }
}
verifyWrittenBoard();

// The dossier is written last: the scorer rebuilds it from this /output and compares bytes.
writeFileSync(join(out, 'dossier.json'), buildDossier(out, { text_max_bytes: MAX_TEXT_BYTES, screenshots: SHOT_LIMITS, dashboard: { max_files: 400, max_bytes: 4_194_304 } }));

process.stdout.write(
  `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows scored (${radar.early_size} early, ${radar.live_size} live set aside)\n` +
    `token radar: fitted curve log10(mcap) = ${fit.intercept.toFixed(4)} + ${fit.slope.toFixed(4)} * log10(TVL), R² = ${fit.r_squared.toFixed(4)}, n = ${fit.n_comps} comps (${fit.zero_mcap_excluded} zero-mcap excluded)\n` +
    `token radar: wrote ${join(out, 'board.json')}, ${join(out, 'data.js')}, ${join(out, 'dashboard')} (${dash.length} files), ${join(out, 'screenshots')} (${shots.length} images) and ${join(out, 'dossier.json')}\n`,
);
