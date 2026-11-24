// Token Radar — the entry point (Node 22, standard library only).
//
// The run, end to end: read the sealed snapshot (from /input/snapshot.json, or wherever
// --input points), score every pre-token protocol with the radar-3 model in lib/model.ts,
// and lay out /output — the ranked board.json, the dashboard's data.js, a copy of
// dashboard/ and screenshots/, and finally the dossier.json the sealed scorer rebuilds
// and compares byte for byte. Before the dossier is sealed, board.json and data.js are
// read back off the disk and checked against the board still in memory, so a truncated
// or altered write fails loudly here instead of quietly in the grader's sandbox.
//
// The grade runs this program twice and both runs must land the same bytes: the model is
// a pure function of the snapshot (multiples come from the snapshot itself, ties break
// by slug), so the output is deterministic.
//
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRadar, parseSnapshot, boardIssue, dataScript } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

// The folder this file lives in — dashboard/ and screenshots/ sit beside it.
const repoRoot = fileURLToPath(new URL('.', import.meta.url));

/** The scorer's caps, from reference/gate.json: the text cap shapes bytes, the rest refuse. */
const TEXT_CAP = 65_536;
const SHOT_CAPS = { max: 4, max_bytes: 524_288 };
const IMAGE_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/**
 * Read a `--name value` or `--name=value` flag out of the arguments, falling back
 * when the flag is absent — or present with nothing after it.
 */
function readFlag(name: string, fallback: string): string {
  const argv = process.argv;
  const bare = argv.indexOf('--' + name);
  if (bare >= 0 && bare + 1 < argv.length) return argv[bare + 1] as string;
  const prefix = '--' + name + '=';
  const joined = argv.find((a) => a.startsWith(prefix));
  if (joined === undefined) return fallback;
  return joined.slice(prefix.length);
}

// Where the snapshot comes from: a file, or a directory holding snapshot.json.
const inputGiven = readFlag('input', '/input');
const snapshotPath = inputGiven.endsWith('.json') ? inputGiven : join(inputGiven, 'snapshot.json');
if (!existsSync(snapshotPath)) {
  process.stderr.write('token radar: no snapshot at ' + snapshotPath + ': pass --input <snapshot.json|directory> or mount the sealed /input\n');
  process.exit(2);
}

// Where the output goes: --output wins, then the environment, then /output.
const outDir = readFlag('output', process.env.MAKEFUN_OUTPUT_DIR === undefined ? '/output' : process.env.MAKEFUN_OUTPUT_DIR);

// Score the snapshot. A board the gate refuses never reaches the disk.
const snap = parseSnapshot(readFileSync(snapshotPath, 'utf8'));
const scored = buildRadar(snap);
const board = scored.board;
const radar = scored.radar;
const problem = boardIssue(board, snap);
if (problem !== null) {
  process.stderr.write('token radar: the model wrote a board the gate refuses: ' + problem + '\n');
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'board.json'), JSON.stringify({ rows: board }) + '\n');
writeFileSync(join(outDir, 'data.js'), dataScript(radar));

/**
 * Copy one directory's regular files into `to`, skipping dotfiles, and report the
 * names copied. A missing source directory copies nothing at all.
 */
function copyDirFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  const names = readdirSync(from);
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

const dash = copyDirFiles(join(repoRoot, 'dashboard'), join(outDir, 'dashboard'));
const shots = copyDirFiles(join(repoRoot, 'screenshots'), join(outDir, 'screenshots'));
if (shots.length < 3) {
  const plural = shots.length === 1 ? '' : 's';
  process.stderr.write('token radar: screenshots/ holds ' + shots.length + ' image' + plural + ': hand in 3, the board, a detail view and a filtered view\n');
  process.exit(1);
}
for (const name of shots) {
  if (!IMAGE_RE.test(name)) {
    process.stderr.write('token radar: screenshots/' + name + ': a name is letters, digits and . _ -, 1 to 128 characters\n');
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
  const written = JSON.parse(readFileSync(join(outDir, 'board.json'), 'utf8')) as { rows?: unknown[] };
  const rowsOnDisk = Array.isArray(written.rows) ? written.rows.length : -1;
  if (rowsOnDisk !== board.length) {
    const shown = rowsOnDisk < 0 ? 'no' : String(rowsOnDisk);
    process.stderr.write('token radar: board.json on disk holds ' + shown + ' rows, the model wrote ' + board.length + '\n');
    process.exit(1);
  }
  const first = (written.rows as { implied_value_usd?: unknown }[])[0];
  const topMatches = board.length > 0 && first !== undefined && first.implied_value_usd === board[0]?.implied_value_usd;
  if (!topMatches) {
    process.stderr.write('token radar: board.json on disk disagrees with the board in memory on rank 1\n');
    process.exit(1);
  }
  const dataText = readFileSync(join(outDir, 'data.js'), 'utf8');
  const dataJson = dataText.replace(/^window\.RADAR=/, '').replace(/;\n?$/, '');
  const parsedData = JSON.parse(dataJson) as { rows?: unknown[] };
  const dataOk = Array.isArray(parsedData.rows) && parsedData.rows.length === board.length;
  if (!dataOk) {
    process.stderr.write('token radar: data.js on disk does not carry the board\n');
    process.exit(1);
  }
}
verifyWrittenBoard();

// The dossier is written last: the scorer rebuilds it from this /output and compares bytes.
writeFileSync(
  join(outDir, 'dossier.json'),
  buildDossier(outDir, { text_max_bytes: TEXT_CAP, screenshots: SHOT_CAPS, dashboard: { max_files: 400, max_bytes: 4_194_304 } }),
);

const summaryLine =
  'token radar: ' + snap.protocols.length + ' protocols, ' + snap.watchlist.length + ' on the watchlist, ' +
  board.length + ' rows scored (' + radar.early_size + ' early, ' + radar.live_size + ' live set aside)\n';
const wroteLine =
  'token radar: wrote ' + join(outDir, 'board.json') + ', ' + join(outDir, 'data.js') + ', ' +
  join(outDir, 'dashboard') + ' (' + dash.length + ' files), ' + join(outDir, 'screenshots') +
  ' (' + shots.length + ' images) and ' + join(outDir, 'dossier.json') + '\n';
process.stdout.write(summaryLine + wroteLine);

// Out-of-sample validation, printed only: the model is never fed its own read-out.
const validation = radar.validation;
const looLine =
  'token radar: OOS validation — LOO n=' + validation.loo.n +
  ' median miss x' + validation.loo.median_miss.toFixed(2) +
  ' (mean x' + validation.loo.mean_miss.toFixed(2) +
  ', within-3x ' + validation.loo.within_3x_pct.toFixed(1) + '%)\n';
const wfLine =
  'token radar: OOS validation — walk-forward split ' + validation.walk_forward.split_date +
  ' train n=' + validation.walk_forward.n_train +
  ' test n=' + validation.walk_forward.n +
  ' median miss x' + validation.walk_forward.median_miss.toFixed(2) +
  ' (within-3x ' + validation.walk_forward.within_3x_pct.toFixed(1) +
  '%, ' + validation.walk_forward.excluded_no_date + ' no-date excluded)\n';
process.stdout.write(looLine + wfLine);
