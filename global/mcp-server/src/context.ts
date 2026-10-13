/**
 * MyJarbis v0.2 — ServerContext
 *
 * One MCP server process serves ONE project (the cwd it was launched from).
 * The ServerContext owns:
 *   - the resolved project path (cwd at startup)
 *   - the SQLite connection (MyJarbisDB)
 *   - the loaded ProjectRow (if `myjarbis init` already ran)
 *   - the ACTIVE session: which session_id and module_id are "current"
 *
 * Tools receive this context object and mutate the active session/module
 * fields when start_session / end_session run.
 */

import { MyJarbisDB } from './db/index.js';
import { ProjectRow, ModuleRow } from './db/schema.js';
import { migrateProject } from './db/migrate.js';
import { MyJarbisError, ErrorType } from './types.js';
import { resolveProject, Resolution } from './resolve.js';

export class ServerContext {
  /** The directory the process was launched from. */
  readonly cwd: string;

  /** Root of the resolved project, or cwd when nothing resolved. */
  readonly projectPath: string;

  readonly db: MyJarbisDB;

  /** Which resolution rule matched. Surfaced by `myjarbis status`. */
  readonly resolvedVia: Resolution['via'] | null;

  /** Cached project row; refreshed on demand if it appears mid-session. */
  private _project: ProjectRow | null = null;

  /** Active session set by start_session, cleared by end_session. */
  activeSessionId: number | null = null;
  activeModuleId: number | null = null;

  private constructor(
    cwd: string,
    projectPath: string,
    db: MyJarbisDB,
    project: ProjectRow | null,
    resolvedVia: Resolution['via'] | null,
  ) {
    this.cwd = cwd;
    this.projectPath = projectPath;
    this.db = db;
    this._project = project;
    this.resolvedVia = resolvedVia;
  }

  /**
   * Bootstraps the context for the current process.
   *
   * Nothing here creates a brain. `initialize` used to call
   * `MyJarbisDB.open(cwd)`, which materialises `.myjarbis/memory.db`
   * wherever it is called — so running any command outside a project left
   * a stray empty brain behind, and running one in a subdirectory of a real
   * project registered a second project pointing at the subdirectory.
   *
   * Creation is now `myjarbis init`'s job alone (see initializeForSeed).
   */
  static initialize(opts: { projectName?: string } = {}): ServerContext {
    const cwd = process.cwd();

    // Migrate a v0.1 layout if one is sitting here. Idempotent, and a no-op
    // when there is nothing to migrate.
    const migration = migrateProject(cwd);
    if (migration.migrated) {
      console.error(
        `[MyJarbis] Migrated project v0.1 → v0.2. Backup: ${migration.backupPath}`,
      );
    }

    const resolution = resolveProject({ cwd, projectName: opts.projectName });
    if (resolution) {
      return new ServerContext(
        cwd,
        resolution.project.path,
        resolution.db,
        resolution.project,
        resolution.via,
      );
    }

    // Nothing resolved. Hand back a context with an in-memory brain so that
    // `requireProject()` can produce the real error message, instead of
    // crashing on a null db or writing a file nobody asked for.
    const scratch = MyJarbisDB.openAtPath(':memory:');
    scratch.bindScope({ kind: 'all', reason: 'unresolved project: empty scratch brain' });
    return new ServerContext(cwd, cwd, scratch, null, null);
  }

  /**
   * Open (creating if needed) the brain for a project being initialised.
   * The one path allowed to bring a DB into existence.
   */
  static initializeForSeed(projectPath: string): ServerContext {
    const db = MyJarbisDB.open(projectPath);
    const project = db.projects.findByPath(projectPath);
    if (project) db.bindScope({ kind: 'project', id: project.id });
    return new ServerContext(projectPath, projectPath, db, project, 'path');
  }

  /** Read-only access; refreshes from DB if not cached. */
  get project(): ProjectRow | null {
    return this._project;
  }

  /**
   * Returns the project row, throwing PROJECT_NOT_FOUND if the project
   * has not been registered yet (i.e. `myjarbis init` was never run).
   */
  requireProject(): ProjectRow {
    const p = this.project;
    if (!p) {
      throw new MyJarbisError(
        ErrorType.PROJECT_NOT_FOUND,
        `No MyJarbis project resolved from ${this.cwd}. Tried: explicit --project, ` +
          `the git remote, and every parent directory. Run 'myjarbis init' in the ` +
          `project root to register it.`,
        { cwd: this.cwd },
      );
    }
    return p;
  }

  /**
   * Resolve a module by name in the current project. Throws
   * MODULE_NOT_FOUND if it doesn't exist.
   */
  requireModule(name: string): ModuleRow {
    const project = this.requireProject();
    const m = this.db.modules.findByName(project.id, name);
    if (!m) {
      throw new MyJarbisError(
        ErrorType.MODULE_NOT_FOUND,
        `Module "${name}" not found in project "${project.name}".`,
        { projectName: project.name, requestedModule: name },
      );
    }
    return m;
  }

  /**
   * Validate that there is an active session, returning the cached ids.
   * Used by save_observation and any tool that requires a live session.
   */
  requireActiveSession(): { sessionId: number; moduleId: number } {
    if (this.activeSessionId === null || this.activeModuleId === null) {
      throw new MyJarbisError(
        ErrorType.SESSION_NOT_ACTIVE,
        'No active session. Call start_session(module) first.',
      );
    }
    return { sessionId: this.activeSessionId, moduleId: this.activeModuleId };
  }

  /** Mark a session active (called from start_session). */
  setActiveSession(sessionId: number, moduleId: number): void {
    this.activeSessionId = sessionId;
    this.activeModuleId = moduleId;
  }

  /** Clear the active session (called from end_session). */
  clearActiveSession(): void {
    this.activeSessionId = null;
    this.activeModuleId = null;
  }

  /** Force re-load of project row from DB. */
  refreshProject(): void {
    const byPath = this.db.projects.findByPath(this.projectPath);
    if (byPath) {
      this._project = byPath;
      if (!this.db.boundScope) this.db.bindScope({ kind: 'project', id: byPath.id });
    }
  }

  close(): void {
    this.db.close();
  }
}
