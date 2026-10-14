/**
 * Project resolution — which brain, and which tenant inside it.
 *
 * Before v0.3 this was one line: `MyJarbisDB.open(process.cwd())`, matching
 * `projects.path` exactly. Two things went wrong with that.
 *
 * `open` creates what it cannot find, so any command run in any directory
 * left a stray empty `.myjarbis/memory.db` behind — and because the match was
 * on the exact cwd, running `myjarbis` from a subdirectory of a registered
 * project did not find the project, it created a second one.
 *
 * And a repo cloned to a different path on a second machine was simply a
 * different project, even though the brain dump had just been imported from
 * the first. The git remote is the one identifier that survives both the path
 * and the machine, so it resolves ahead of the path.
 *
 * Resolution order, stopping at the first hit:
 *   1. an explicit project name (flag or MYJARBIS_PROJECT)
 *   2. the normalised git remote of the enclosing repository
 *   3. the nearest enclosing registered path (cwd, then each parent)
 *   4. fail — never create
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { MyJarbisDB, Scope } from './db/index.js';
import { ProjectRow } from './db/schema.js';
import { MyJarbisError, ErrorType } from './types.js';

/** Data directory holding the shared brain. Distinct from the install dir
 *  ($HOME/.myjarbis-global), which holds code rather than data. */
export function myjarbisHome(): string {
  return process.env.MYJARBIS_HOME || path.join(os.homedir(), '.myjarbis');
}

export function globalDbPath(): string {
  return path.join(myjarbisHome(), 'memory.db');
}

export function siloDbPath(projectPath: string): string {
  return path.join(projectPath, '.myjarbis', 'memory.db');
}

/**
 * Reduce a git remote URL to a stable identity.
 *
 * The same repository is written at least four ways
 * (`git@h:o/r.git`, `https://h/o/r.git`, `ssh://git@h/o/r`, `https://u@h/o/r`),
 * and a project resolved by raw string would be a different project depending
 * on how it happened to be cloned. Everything is reduced to `host/owner/repo`.
 */
export function normalizeRemote(raw: string): string | null {
  let s = raw.trim();
  if (!s) return null;

  // scp-like syntax: git@host:owner/repo(.git)
  const scp = /^[^/@]+@([^:/]+):(.+)$/.exec(s);
  if (scp) {
    s = `${scp[1]}/${scp[2]}`;
  } else {
    // URL syntax with any scheme, optional userinfo
    const url = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/i.exec(s);
    if (url) {
      const host = url[1].replace(/:\d+$/, ''); // drop an explicit port
      s = `${host}/${url[2]}`;
    } else if (/^\//.test(s) || /^file:/.test(s)) {
      // A local path remote is not a shared identity; treat it as absent.
      return null;
    }
  }

  s = s
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
    .toLowerCase();

  return s || null;
}

/** The normalised origin remote of the repo containing `cwd`, if any. */
export function detectRemote(cwd: string): string | null {
  try {
    const out = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return normalizeRemote(out);
  } catch {
    return null;
  }
}

/** The repository root containing `cwd`, if any. */
export function detectRepoRoot(cwd: string): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const p = out.trim();
    return p ? path.resolve(p) : null;
  } catch {
    return null;
  }
}

/** `dir` and every parent up to the filesystem root. */
export function ancestors(dir: string): string[] {
  const out: string[] = [];
  let cur = path.resolve(dir);
  for (;;) {
    out.push(cur);
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return out;
}

/** The nearest enclosing directory holding a silo brain. */
export function findSiloRoot(cwd: string): string | null {
  for (const dir of ancestors(cwd)) {
    if (fs.existsSync(siloDbPath(dir))) return dir;
  }
  return null;
}

export interface Resolution {
  db: MyJarbisDB;
  project: ProjectRow;
  scope: Scope;
  /** Which rule matched, for diagnostics and for `myjarbis status`. */
  via: 'explicit' | 'remote' | 'path' | 'single-tenant';
  /** Set when the remote and the path disagree about which project this is. */
  conflict?: { byRemote: string; byPath: string };
}

export interface ResolveOptions {
  cwd?: string;
  /** Explicit project name: a --project flag, or MYJARBIS_PROJECT. */
  projectName?: string;
}

/**
 * Resolve the project for a command, without ever creating a brain.
 *
 * Returns null when nothing matches, so the caller can print the right
 * "run myjarbis init" message instead of silently seeding a DB in whatever
 * directory the user happened to be standing in.
 */
export function resolveProject(opts: ResolveOptions = {}): Resolution | null {
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  const explicitName = opts.projectName ?? process.env.MYJARBIS_PROJECT ?? undefined;

  // Candidate brains, nearest first: a silo next to the project wins over
  // the shared one, so an existing v0.2 project keeps working untouched.
  const siloRoot = findSiloRoot(cwd);
  const candidates: Array<{ db: MyJarbisDB; isSilo: boolean }> = [];

  if (siloRoot) {
    const db = MyJarbisDB.openExisting(siloDbPath(siloRoot));
    if (db) candidates.push({ db, isSilo: true });
  }
  const globalDb = MyJarbisDB.openExisting(globalDbPath());
  if (globalDb) candidates.push({ db: globalDb, isSilo: false });

  if (candidates.length === 0) return null;

  const remote = detectRemote(cwd);
  const repoRoot = detectRepoRoot(cwd);
  const searchPaths = repoRoot ? [repoRoot, ...ancestors(cwd)] : ancestors(cwd);

  for (const { db, isSilo } of candidates) {
    // 1. Explicit name.
    if (explicitName) {
      const byName = db.projects.findByName(explicitName);
      if (byName) {
        return finish(db, byName, 'explicit', candidates);
      }
      // An explicit name that exists nowhere is a user error, not a reason
      // to fall through and silently pick something else.
      continue;
    }

    // 2. Git remote.
    const byRemote = remote ? db.projects.findByRemote(remote) : null;

    // 3. Nearest registered path.
    let byPath: ProjectRow | null = null;
    for (const dir of searchPaths) {
      byPath = db.projects.findByPath(dir);
      if (byPath) break;
    }

    if (byRemote && byPath && byRemote.id !== byPath.id) {
      // Do not guess. Switching tenant silently is the failure this whole
      // resolution chain exists to prevent.
      throw new MyJarbisError(
        ErrorType.AMBIGUOUS_PROJECT,
        `This directory resolves to "${byPath.name}" by path but "${byRemote.name}" ` +
          `by git remote. Pass --project to say which one you mean.`,
        { byPath: byPath.name, byRemote: byRemote.name, remote },
      );
    }

    const hit = byRemote ?? byPath;
    if (hit) {
      return finish(db, hit, byRemote ? 'remote' : 'path', candidates);
    }

    // 4. A silo brain holds exactly one project. If we opened one and it
    // has a single project, that is the project — this is what lets a
    // repo cloned to a new path keep working before its row is updated.
    if (isSilo) {
      const all = db.projects.listAll('resolving the single tenant of a silo brain');
      if (all.length === 1) {
        return finish(db, all[0], 'single-tenant', candidates);
      }
    }
  }

  for (const c of candidates) c.db.close();
  return null;
}

function finish(
  db: MyJarbisDB,
  project: ProjectRow,
  via: Resolution['via'],
  candidates: Array<{ db: MyJarbisDB }>,
): Resolution {
  // Close the brains we are not going to use; leaving them open holds a
  // WAL lock and, in the MCP server, leaks a handle per request.
  for (const c of candidates) if (c.db !== db) c.db.close();

  const scope: Scope = { kind: 'project', id: project.id };
  db.bindScope(scope);
  return { db, project, scope, via };
}

/**
 * Open the shared brain with an explicit cross-project scope.
 *
 * The reason is mandatory and recorded: a read that spans tenants should be
 * a deliberate, nameable act. Returns null when there is no shared brain yet.
 */
export function openAllProjects(reason: string): MyJarbisDB | null {
  const db = MyJarbisDB.openExisting(globalDbPath());
  if (!db) return null;
  db.bindScope({ kind: 'all', reason });
  return db;
}
