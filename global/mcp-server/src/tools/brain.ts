/**
 * MyJarbis — brain export / import (NDJSON)
 *
 * WHY
 * ---
 * `memory.db` is SQLite. Versioning the binary in git has two failure modes:
 *
 *   1. `git checkout` / `pull` replaces the file's inode while processes hold
 *      it open (MCP server, dashboards). The open handles keep writing to the
 *      deleted inode and the brain splits in two. This already happened once
 *      and had to be recovered from /proc.
 *   2. Two machines that both commit produce a binary conflict git cannot
 *      merge. You pick one side and silently lose the other side's brain.
 *
 * The fix is to invert what git tracks: the `.db` becomes a local build
 * artifact (gitignored) and git tracks a deterministic text dump instead.
 *
 *   memory.db        →  gitignored, runtime, single writer
 *   brain/*.ndjson   →  tracked, diffable, line-mergeable
 *
 * Hazard (1) disappears by construction — git never touches the .db again.
 * Hazard (2) degrades from "unrecoverable" to "a merge conflict you can read".
 * As a bonus, git stores line deltas instead of a fresh ~1 MB blob per commit.
 *
 * FORMAT
 * ------
 * One file per table, one JSON object per line, keys in physical column order,
 * rows ordered by primary key. Determinism is not cosmetic: without a stable
 * order every export rewrites every line and we are back to blob-sized diffs.
 *
 * The FTS5 tables (`*_fts`, `*_fts_data`, …) are NOT exported. They are a
 * derived index, rebuilt by the schema triggers as rows are re-inserted. That
 * alone drops more than half the byte count.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ServerContext } from '../context.js';
import { MyJarbisError, ErrorType } from '../types.js';
import { SCHEMA_VERSION } from '../db/schema.js';

/** Directory name under `.myjarbis/` holding the dump. */
export const BRAIN_DIRNAME = 'brain';

/**
 * Tables to dump, in foreign-key dependency order (parents first).
 * Import inserts in this order and deletes in reverse.
 *
 * `meta` is listed first because it carries schema_version, which the import
 * guard reads before touching anything else.
 */
const TABLES: ReadonlyArray<{ name: string; orderBy: string }> = [
  { name: 'meta', orderBy: 'key' },
  { name: 'projects', orderBy: 'id' },
  { name: 'modules', orderBy: 'id' },
  { name: 'project_context', orderBy: 'id' },
  { name: 'module_context', orderBy: 'id' },
  { name: 'skills', orderBy: 'id' },
  { name: 'sessions', orderBy: 'id' },
  { name: 'observations', orderBy: 'id' },
];

/** meta keys that describe the *local install*, not the brain. Restoring these
 *  from a dump would let an old dump silently downgrade the schema marker of a
 *  DB that a newer myjarbis has already migrated. */
const META_KEYS_NOT_RESTORED = new Set(['schema_version']);

const MANIFEST = 'manifest.json';

/**
 * `projects.path` is an absolute filesystem path. Writing it verbatim would
 * make the dump machine-specific: laptop A commits `/home/a/dev/twin`, laptop B
 * imports, re-exports as `/home/b/dev/twin`, and `projects.ndjson` flips on
 * every hand-off — noise in git, and a merge conflict on the one row that must
 * never conflict.
 *
 * So the row that describes *this* checkout is dumped as a sentinel and
 * expanded back to the local path on import. The dump stays byte-identical
 * across machines.
 */
const SELF_PATH = '.';

export interface BrainManifest {
  format: 'myjarbis-brain-ndjson';
  formatVersion: 1;
  schemaVersion: number;
  exportedAt: string;
  counts: Record<string, number>;
}

export interface ExportResult {
  dir: string;
  counts: Record<string, number>;
  filesWritten: string[];
  bytes: number;
  changed: boolean;
}

export interface ImportResult {
  dir: string;
  counts: Record<string, number>;
  schemaVersion: number;
  exportedAt: string;
  /** Set when the dump's project path was rewritten to this checkout — see
   *  the rebase step in importBrain. */
  rebasedFrom?: string;
}

export interface BrainStatusResult {
  dir: string;
  dumpExists: boolean;
  inSync: boolean;
  db: Record<string, number>;
  dump: Record<string, number> | null;
  drift: string[];
}

// ───────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────

export function brainDir(ctx: ServerContext, override?: string): string {
  if (override) return path.resolve(override);
  return path.join(ctx.projectPath, '.myjarbis', BRAIN_DIRNAME);
}

/** Physical column names of a table, in declaration order. */
function columnsOf(ctx: ServerContext, table: string): string[] {
  const rows = ctx.db.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

function tableExists(ctx: ServerContext, table: string): boolean {
  const row = ctx.db.db
    .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table) as { ok: number } | undefined;
  return Boolean(row);
}

/**
 * Serialize a row with keys in `cols` order. Column order — not
 * `Object.keys()` order — is what makes two exports of the same data
 * byte-identical.
 */
function serializeRow(row: Record<string, unknown>, cols: string[]): string {
  const ordered: Record<string, unknown> = {};
  for (const col of cols) ordered[col] = row[col] ?? null;
  return JSON.stringify(ordered);
}

/** Write only when the bytes differ, so untouched tables keep their mtime and
 *  git sees no spurious change. Returns true when the file was rewritten. */
function writeIfChanged(file: string, contents: string): boolean {
  if (fs.existsSync(file)) {
    const current = fs.readFileSync(file, 'utf-8');
    if (current === contents) return false;
  }
  fs.writeFileSync(file, contents, 'utf-8');
  return true;
}

function parseNdjson(file: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, 'utf-8');
  const out: Array<Record<string, unknown>> = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      throw new MyJarbisError(
        ErrorType.INVALID_INPUT,
        `${path.basename(file)}:${i + 1} is not valid JSON — the dump is corrupt or a merge conflict was left unresolved.`,
        { file, line: i + 1, snippet: line.slice(0, 120) },
      );
    }
  }
  return out;
}

function countsOf(ctx: ServerContext): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const t of TABLES) {
    if (!tableExists(ctx, t.name)) continue;
    const row = ctx.db.db.prepare(`SELECT COUNT(*) AS n FROM ${t.name}`).get() as { n: number };
    counts[t.name] = row.n;
  }
  return counts;
}

// ───────────────────────────────────────────────────────────────────
// Export
// ───────────────────────────────────────────────────────────────────

export function exportBrain(
  ctx: ServerContext,
  opts: { dir?: string; now?: string } = {},
): ExportResult {
  const dir = brainDir(ctx, opts.dir);
  fs.mkdirSync(dir, { recursive: true });

  // Flush the WAL so the dump reflects committed state even if another
  // process wrote recently. TRUNCATE also keeps the sidecar files small.
  try {
    ctx.db.db.pragma('wal_checkpoint(TRUNCATE)');
  } catch {
    // A concurrent reader can block a TRUNCATE checkpoint. We still read our
    // own connection's consistent view below, so this is not fatal.
  }

  const counts: Record<string, number> = {};
  const filesWritten: string[] = [];
  let bytes = 0;

  for (const t of TABLES) {
    if (!tableExists(ctx, t.name)) continue;
    const cols = columnsOf(ctx, t.name);
    let rows = ctx.db.db
      .prepare(`SELECT * FROM ${t.name} ORDER BY ${t.orderBy}`)
      .all() as Array<Record<string, unknown>>;

    if (t.name === 'projects') {
      rows = rows.map((r) => (r.path === ctx.projectPath ? { ...r, path: SELF_PATH } : r));
    }

    const body = rows.map((r) => serializeRow(r, cols)).join('\n');
    // Trailing newline: makes the last row a normal line for git and for
    // line-oriented merge drivers.
    const contents = rows.length > 0 ? `${body}\n` : '';

    const file = path.join(dir, `${t.name}.ndjson`);
    if (writeIfChanged(file, contents)) filesWritten.push(path.basename(file));
    counts[t.name] = rows.length;
    bytes += Buffer.byteLength(contents, 'utf-8');
  }

  const manifest: BrainManifest = {
    format: 'myjarbis-brain-ndjson',
    formatVersion: 1,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: opts.now ?? new Date().toISOString(),
    counts,
  };

  // The manifest carries a timestamp, so writing it unconditionally would
  // dirty the dump on every run even when no row changed. Only refresh it
  // when the data actually moved.
  const manifestFile = path.join(dir, MANIFEST);
  const prev = fs.existsSync(manifestFile)
    ? (JSON.parse(fs.readFileSync(manifestFile, 'utf-8')) as BrainManifest)
    : null;
  const dataChanged =
    filesWritten.length > 0 ||
    prev === null ||
    prev.schemaVersion !== manifest.schemaVersion ||
    JSON.stringify(prev.counts) !== JSON.stringify(manifest.counts);

  if (dataChanged) {
    fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
    filesWritten.push(MANIFEST);
  }

  return { dir, counts, filesWritten, bytes, changed: dataChanged };
}

// ───────────────────────────────────────────────────────────────────
// Import
// ───────────────────────────────────────────────────────────────────

export function importBrain(ctx: ServerContext, opts: { dir?: string } = {}): ImportResult {
  const dir = brainDir(ctx, opts.dir);
  const manifestFile = path.join(dir, MANIFEST);

  if (!fs.existsSync(manifestFile)) {
    throw new MyJarbisError(
      ErrorType.INVALID_INPUT,
      `No brain dump at ${dir} (missing ${MANIFEST}). Run 'myjarbis brain export' first.`,
      { dir },
    );
  }

  let manifest: BrainManifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf-8')) as BrainManifest;
  } catch {
    throw new MyJarbisError(
      ErrorType.INVALID_INPUT,
      `${MANIFEST} is not valid JSON — likely an unresolved merge conflict.`,
      { file: manifestFile },
    );
  }

  // Refuse to load a dump produced by a newer schema: its rows would carry
  // columns this build does not know about, and silently dropping them would
  // lose brain. Upgrading myjarbis is the fix.
  if (manifest.schemaVersion > SCHEMA_VERSION) {
    throw new MyJarbisError(
      ErrorType.INVALID_INPUT,
      `Dump is schema v${manifest.schemaVersion} but this myjarbis speaks v${SCHEMA_VERSION}. Run 'myjarbis update' before importing.`,
      { dumpSchemaVersion: manifest.schemaVersion, localSchemaVersion: SCHEMA_VERSION },
    );
  }

  // Parse and validate everything BEFORE deleting a single row: a dump that
  // fails halfway would otherwise leave the DB truncated.
  const parsed = new Map<string, Array<Record<string, unknown>>>();
  for (const t of TABLES) {
    if (!tableExists(ctx, t.name)) continue;
    const rows = parseNdjson(path.join(dir, `${t.name}.ndjson`));
    const cols = new Set(columnsOf(ctx, t.name));
    for (const row of rows) {
      for (const key of Object.keys(row)) {
        if (!cols.has(key)) {
          throw new MyJarbisError(
            ErrorType.INVALID_INPUT,
            `Column "${key}" in ${t.name}.ndjson does not exist in table ${t.name}. The dump and this build disagree on the schema.`,
            { table: t.name, column: key },
          );
        }
      }
    }
    parsed.set(t.name, rows);
  }

  const counts: Record<string, number> = {};
  let rebasedFrom: string | undefined;

  ctx.db.tx(() => {
    // Foreign keys are ON: children first on the way out, parents first on the
    // way in. Deferring instead would let a bad dump land half-applied.
    for (const t of [...TABLES].reverse()) {
      if (!tableExists(ctx, t.name)) continue;
      if (t.name === 'meta') {
        ctx.db.db
          .prepare(
            `DELETE FROM meta WHERE key NOT IN (${[...META_KEYS_NOT_RESTORED]
              .map(() => '?')
              .join(', ')})`,
          )
          .run(...META_KEYS_NOT_RESTORED);
        continue;
      }
      ctx.db.db.prepare(`DELETE FROM ${t.name}`).run();
    }

    for (const t of TABLES) {
      const rows = parsed.get(t.name);
      if (!rows) continue;

      let inserted = 0;
      for (const row of rows) {
        if (t.name === 'meta' && META_KEYS_NOT_RESTORED.has(String(row.key))) continue;
        // Expand the portable sentinel back to where this checkout actually is.
        if (t.name === 'projects' && row.path === SELF_PATH) row.path = ctx.projectPath;
        const keys = Object.keys(row);
        if (keys.length === 0) continue;
        const sql = `INSERT INTO ${t.name}(${keys.join(', ')}) VALUES (${keys
          .map(() => '?')
          .join(', ')})`;
        ctx.db.db.prepare(sql).run(...keys.map((k) => row[k] as never));
        inserted++;
      }
      counts[t.name] = inserted;
    }

    // Re-inserting with explicit ids leaves AUTOINCREMENT counters at whatever
    // the last INSERT set. SQLite bumps sqlite_sequence to max(seq, rowid) on
    // insert, so the counters are already correct — but a table emptied by
    // this import would keep a stale high-water mark, which is harmless and
    // deliberately left alone (ids must never be reused).

    // `projects.path` is an absolute path baked into the dump by whichever
    // machine exported it. Everything resolves the project by cwd
    // (findByPath), so a clone under a different path — a second laptop, a
    // different $HOME, a worktree — would import a full brain and then fail
    // with PROJECT_NOT_FOUND. Rebase it onto this checkout.
    //
    // Only when the dump holds exactly one project, which is the design (one
    // DB per project). With more than one we cannot tell which row is "here",
    // so we leave them alone rather than corrupt the wrong one.
    const projectRows = ctx.db.db.prepare('SELECT id, path FROM projects').all() as Array<{
      id: number;
      path: string;
    }>;
    if (projectRows.length === 1 && projectRows[0].path !== ctx.projectPath) {
      rebasedFrom = projectRows[0].path;
      ctx.db.db
        .prepare('UPDATE projects SET path = ? WHERE id = ?')
        .run(ctx.projectPath, projectRows[0].id);
    }
  });

  // FTS5 mirrors are rebuilt by the schema triggers during the inserts above.
  // Ask SQLite to verify rather than trusting it.
  for (const ftsTable of ['project_context_fts', 'module_context_fts', 'observations_fts', 'skills_fts']) {
    if (!tableExists(ctx, ftsTable)) continue;
    try {
      ctx.db.db.prepare(`INSERT INTO ${ftsTable}(${ftsTable}) VALUES ('rebuild')`).run();
    } catch {
      // 'rebuild' is unsupported on some FTS5 builds; the triggers already
      // populated the index, so this is a belt-and-braces step only.
    }
  }

  try {
    ctx.db.db.pragma('wal_checkpoint(TRUNCATE)');
  } catch {
    // Non-fatal: a concurrent reader can block the checkpoint.
  }

  return {
    dir,
    counts,
    schemaVersion: manifest.schemaVersion,
    exportedAt: manifest.exportedAt,
    rebasedFrom,
  };
}

// ───────────────────────────────────────────────────────────────────
// Status
// ───────────────────────────────────────────────────────────────────

/** Compare live DB against the on-disk dump without writing anything. */
export function brainStatus(ctx: ServerContext, opts: { dir?: string } = {}): BrainStatusResult {
  const dir = brainDir(ctx, opts.dir);
  const manifestFile = path.join(dir, MANIFEST);
  const db = countsOf(ctx);

  if (!fs.existsSync(manifestFile)) {
    return { dir, dumpExists: false, inSync: false, db, dump: null, drift: ['no dump on disk'] };
  }

  const dump: Record<string, number> = {};
  for (const t of TABLES) {
    dump[t.name] = parseNdjson(path.join(dir, `${t.name}.ndjson`)).length;
  }

  const drift: string[] = [];
  for (const t of TABLES) {
    const a = db[t.name] ?? 0;
    const b = dump[t.name] ?? 0;
    if (a !== b) drift.push(`${t.name}: db=${a} dump=${b}`);
  }

  return { dir, dumpExists: true, inSync: drift.length === 0, db, dump, drift };
}
