/**
 * Schema upgrades, with a backup you can actually restore from.
 *
 * THE THING THAT WILL BITE YOU: these databases run in WAL mode, and real
 * ones were found carrying 3–4 MB of un-checkpointed WAL — larger than the
 * .db file itself. A backup that copies only `memory.db` therefore loses
 * everything recent, and loses it silently, which is the worst possible
 * shape for a backup to fail in. So every backup here checkpoints first and
 * then copies all three files.
 *
 * Opening a brain no longer migrates it (see MyJarbisDB.openExisting). That
 * is deliberate: resolution touches every candidate brain, so an implicit
 * migration would upgrade files the user never named. Upgrading is this
 * module's job and it always announces itself.
 */

import * as fs from 'fs';
import * as path from 'path';
import { MyJarbisDB } from './index.js';
import { SCHEMA_VERSION } from './schema.js';
import { MyJarbisError, ErrorType } from '../types.js';

/** Tables whose row counts are compared before and after. FTS shadow
 *  tables are excluded: they are derived, and rebuilt on purpose. */
export const COUNTED_TABLES = [
  'orgs',
  'projects',
  'project_context',
  'context_kinds',
  'modules',
  'module_context',
  'skills',
  'sessions',
  'observations',
  'refs',
  'project_state',
  'workflows',
  'workflow_steps',
  'providers',
] as const;

export interface BackupResult {
  dbPath: string;
  backupPath: string;
  files: string[];
  bytes: number;
  walCheckpointed: boolean;
}

/**
 * Copy a brain aside before touching it.
 *
 * Checkpoints the WAL into the main file first, then copies whatever of the
 * three files still exist. Both halves matter: without the checkpoint a
 * -wal-only copy can be unreadable, and without copying -wal a reader that
 * blocked the checkpoint would leave recent rows behind.
 */
export function backupBrain(dbPath: string, label = 'bak'): BackupResult {
  if (!fs.existsSync(dbPath)) {
    throw new MyJarbisError(ErrorType.DB_ERROR, `No database at ${dbPath}`);
  }

  let walCheckpointed = false;
  const db = MyJarbisDB.openExisting(dbPath);
  if (db) {
    try {
      db.db.pragma('wal_checkpoint(TRUNCATE)');
      walCheckpointed = true;
    } catch {
      // A concurrent reader can block a TRUNCATE checkpoint. Copying the
      // -wal file below still captures everything in that case.
    } finally {
      db.close();
    }
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${dbPath}.${label}.${ts}`;
  const files: string[] = [];
  let bytes = 0;

  for (const suffix of ['', '-wal', '-shm']) {
    const src = `${dbPath}${suffix}`;
    if (!fs.existsSync(src)) continue;
    const dst = `${backupPath}${suffix}`;
    fs.copyFileSync(src, dst);
    files.push(path.basename(dst));
    bytes += fs.statSync(dst).size;
  }

  return { dbPath, backupPath, files, bytes, walCheckpointed };
}

export function countRows(db: MyJarbisDB): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of COUNTED_TABLES) {
    try {
      out[t] = (db.db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: number }).n;
    } catch {
      // Table does not exist yet at this schema version.
      out[t] = 0;
    }
  }
  return out;
}

export interface UpgradeReport {
  dbPath: string;
  fromVersion: number;
  toVersion: number;
  alreadyCurrent: boolean;
  dryRun: boolean;
  backup?: BackupResult;
  before: Record<string, number>;
  after: Record<string, number>;
  /** Tables whose count changed. Only the backfill should appear here. */
  changed: Array<{ table: string; before: number; after: number }>;
  integrity: string;
  foreignKeyViolations: number;
  warnings: string[];
}

/**
 * Bring one brain up to the current schema version.
 *
 * Idempotent: a database already at SCHEMA_VERSION reports
 * `alreadyCurrent` and is not touched, not even to back it up.
 */
export function upgradeBrain(
  dbPath: string,
  opts: { dryRun?: boolean; skipBackup?: boolean } = {},
): UpgradeReport {
  const dryRun = opts.dryRun === true;

  const probe = MyJarbisDB.openExisting(dbPath);
  if (!probe) {
    throw new MyJarbisError(ErrorType.DB_ERROR, `No database at ${dbPath}`);
  }
  const fromVersion = probe.schemaVersion;
  const before = countRows(probe);
  probe.close();

  const warnings: string[] = [];

  if (fromVersion >= SCHEMA_VERSION) {
    return {
      dbPath,
      fromVersion,
      toVersion: SCHEMA_VERSION,
      alreadyCurrent: true,
      dryRun,
      before,
      after: before,
      changed: [],
      integrity: 'ok',
      foreignKeyViolations: 0,
      warnings: [`already at schema v${fromVersion}; nothing to do`],
    };
  }

  if (fromVersion === 0) {
    warnings.push(
      'this file records no schema version; treating it as pre-v1 and applying ' +
        'every migration. Check the row counts in this report before trusting it.',
    );
  }

  if (dryRun) {
    // Upgrade a COPY, so the report is produced by the real code path
    // rather than by a prediction that can drift from it, and the original
    // is not opened for writing at all.
    const tmp = `${dbPath}.dryrun.${Date.now()}`;
    const copied: string[] = [];
    try {
      for (const suffix of ['', '-wal', '-shm']) {
        if (fs.existsSync(`${dbPath}${suffix}`)) {
          fs.copyFileSync(`${dbPath}${suffix}`, `${tmp}${suffix}`);
          copied.push(`${tmp}${suffix}`);
        }
      }
      const db = MyJarbisDB.openExisting(tmp)!;
      db.migrateInPlace();
      const after = countRows(db);
      const integrity = (db.db.pragma('integrity_check') as Array<{ integrity_check: string }>)[0]
        .integrity_check;
      const fk = (db.db.pragma('foreign_key_check') as unknown[]).length;
      db.close();

      return {
        dbPath,
        fromVersion,
        toVersion: SCHEMA_VERSION,
        alreadyCurrent: false,
        dryRun: true,
        before,
        after,
        changed: diffCounts(before, after),
        integrity,
        foreignKeyViolations: fk,
        warnings: [...warnings, 'dry run — the original file was not modified'],
      };
    } finally {
      for (const f of copied) {
        try {
          fs.unlinkSync(f);
        } catch {
          /* best effort */
        }
      }
    }
  }

  const backup = opts.skipBackup ? undefined : backupBrain(dbPath, 'pre-v' + SCHEMA_VERSION);
  if (backup && !backup.walCheckpointed) {
    warnings.push(
      'the WAL could not be checkpointed before the backup (a reader held it); ' +
        'the -wal file was copied alongside, so the backup is still complete.',
    );
  }

  const db = MyJarbisDB.openExisting(dbPath)!;
  let after: Record<string, number>;
  let integrity: string;
  let fk: number;
  try {
    db.migrateInPlace();
    after = countRows(db);
    integrity = (db.db.pragma('integrity_check') as Array<{ integrity_check: string }>)[0]
      .integrity_check;
    fk = (db.db.pragma('foreign_key_check') as unknown[]).length;
  } finally {
    db.close();
  }

  if (integrity !== 'ok') {
    warnings.push(
      `integrity_check returned "${integrity}". The pre-upgrade backup is at ` +
        `${backup?.backupPath ?? '(not taken)'}.`,
    );
  }

  return {
    dbPath,
    fromVersion,
    toVersion: SCHEMA_VERSION,
    alreadyCurrent: false,
    dryRun: false,
    backup,
    before,
    after,
    changed: diffCounts(before, after),
    integrity,
    foreignKeyViolations: fk,
    warnings,
  };
}

function diffCounts(
  before: Record<string, number>,
  after: Record<string, number>,
): Array<{ table: string; before: number; after: number }> {
  const out: Array<{ table: string; before: number; after: number }> = [];
  for (const t of COUNTED_TABLES) {
    if ((before[t] ?? 0) !== (after[t] ?? 0)) {
      out.push({ table: t, before: before[t] ?? 0, after: after[t] ?? 0 });
    }
  }
  return out;
}
