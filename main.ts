// Token Radar: the entry's program (Node 22, standard library only).
//
// What it does, in order:
//   1. reads the sealed snapshot (default /input/snapshot.json; --input <file|dir> overrides),
//   2. scores every launch candidate with the peer-anchored model in lib/model.ts and checks the
//      board against the gate's shape before anything is written,
//   3. writes the ranked board to /output/board.json and the dashboard's data to /output/data.js,
//   4. copies this repository's dashboard/ and screenshots/ into /output,
//   5. writes /output/dossier.json last, with buildDossier from vendor/makefun-board.ts, so the
//      dossier describes the exact bytes the rest of the run produced.
//
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <kit>/input/snapshot.json
// The program is deterministic: the same snapshot in, the same bytes out, every run.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const repoDir = fileURLToPath(new URL('.', import.meta.url));

/** The dossier's text cap and the screenshot/dashboard caps the gate enforces (they only refuse). */
const DOSSIER_TEXT_MAX = 65_536;
const DOSSIER_CAPS = {
  text_max_bytes: DOSSIER_TEXT_MAX,
  screenshots: { max: 4, max_bytes: 524_288 },
  dashboard: { max_files: 400, max_bytes: 4_194_304 },
};
/** A dossier image's name: letters, digits and . _ -, never opening with a dot or dash. */
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** Read `--name value` or `--name=value` from the arguments, else the fallback. */
function option(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq === undefined ? fallback : eq.slice(name.length + 3);
}

function fail(message: string): never {
  process.stderr.write(`token-radar: ${message}\n`);
  process.exit(1);
}

const inputArg = option('input', '/input');
const snapshotPath = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(snapshotPath)) fail(`no snapshot at ${snapshotPath}: pass --input <snapshot.json|directory> or mount the sealed /input`);
const outDir = option('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(snapshotPath, 'utf8'));
const { board, radar } = buildRadar(snapshot);
const issue = boardIssue(board, snapshot);
if (issue !== null) fail(`the model produced a board the gate refuses: ${issue}`);

// Fail before writing anything when the handed-in images are missing or misnamed: a run that
// cannot complete should not leave a half-written output behind.
const shotNames = existsSync(join(repoDir, 'screenshots'))
  ? readdirSync(join(repoDir, 'screenshots')).filter((n) => !n.startsWith('.')).sort()
  : [];
if (shotNames.length < 3 || shotNames.length > 4) fail(`screenshots/ holds ${shotNames.length} images: the entry hands in 3 (the board, a detail view, a filtered view)`);
for (const name of shotNames) {
  if (!IMAGE_NAME.test(name)) fail(`screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters`);
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(outDir, 'data.js'), dataScript(radar));

/** Copy a directory's regular files into place, skipping dotfiles; returns the names copied. */
function copyTree(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const names: string[] = [];
  for (const name of readdirSync(from).sort()) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    names.push(name);
  }
  return names;
}

const pageFiles = copyTree(join(repoDir, 'dashboard'), join(outDir, 'dashboard'));
if (!pageFiles.includes('index.html')) fail('dashboard/ holds no index.html');
const shots = copyTree(join(repoDir, 'screenshots'), join(outDir, 'screenshots'));
if (shots.length < 3 || shots.length > 4) fail(`screenshots/ holds ${shots.length} images: the entry hands in 3 (the board, a detail view, a filtered view)`);
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) fail(`screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters`);
}

// The dossier goes last on purpose: the gate rebuilds it from this output and compares bytes.
writeFileSync(join(outDir, 'dossier.json'), buildDossier(outDir, DOSSIER_CAPS));

process.stdout.write(
  `token-radar: scanned ${snapshot.protocols.length} protocols (${snapshot.watchlist.length} on the watchlist), ` +
    `ranked ${board.length} pre-token rows (${radar.early_size} early finds past the floor), set ${radar.live_size} trading protocols aside\n` +
    `token-radar: wrote board.json, data.js, dashboard/ (${pageFiles.length} files), screenshots/ (${shots.length} images) and dossier.json under ${outDir}\n`,
);
