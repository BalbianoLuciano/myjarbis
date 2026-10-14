/**
 * Merging one project's brain into the shared one.
 *
 * This is the single most dangerous operation in MyJarbis, so it is written
 * to be verifiable rather than clever.
 *
 * THE CORE PROBLEM: every brain has its own AUTOINCREMENT counters, so
 * `id = 1` exists in all of them. Copying rows across therefore cannot
 * preserve ids — each row gets a new one, and every foreign key that
 * referenced the old one has to be rewritten to match: modules.project_id,
 * sessions.module_id, observations.session_id and .project_id and
 * .supersedes, project_context.project_id, module_context.module_id,
 * skills.project_id and .module_id, refs.observation_id,
 * project_state.project_id, providers.project_id, workflows.scope_id,
 * workflow_steps.workflow_id. Miss one and the brain is quietly wrong:
 * a note attached to somebody else's session.
 *
 * AND THE FTS INDEXES MUST BE REBUILT. They are contentless and keyed by
 * rowid, so after a remap they resolve to different rows than they indexed.
 * A stale FTS index is worse than no index, because the hit looks correct.
 *
 * Safeguards: a checkpointed backup of the destination first; everything in
 * one transaction so a failure leaves nothing behind; a row-count report
 * per table so correctness is checkable rather than assumed; idempotency by
 * refusing to import a project that is already there unless renamed.
 */

import * as fs from 'fs';
import { MyJarbisDB } from './index.js';
import { SCHEMA_VERSION } from './schema.js';
import { MyJarbisError, ErrorType } from '../types.js';
import { backupBrain, countRows, BackupResult, COUNTED_TABLES } from './upgrade.js';
import { normalizeRemote } from '../resolve.js';

export interface MergeReport {
  from: string;
  into: string;
  project: { sourceName: string; importedAs: string; newId: number };
  dryRun: boolean;
  backup?: BackupResult;
  /** Where the source brain was renamed to, when --retire-source was given. */
  retiredSourceTo?: string;
  /** Rows copied, per table. */
  copied: Record<string, number>;
  /** Destination counts before and after; after - before must equal copied. */
  destBefore: Record<string, number>;
  destAfter: Record<string, number>;
  /** Tables where after - before disagrees with copied. Must be empty. */
  mismatches: Array<{ table: string; expected: number; actual: number }>;
  integrity: string;
  foreignKeyViolations: number;
  ftsRebuilt: boolean;
  ftsProbe?: { query: string; hitsBefore: number; hitsAfter: number };
  warnings: string[];
}

interface IdMap {
  modules: Map<number, number>;
  sessions: Map<number, number>;
  observations: Map<number, number>;
  workflows: Map<number, number>;
}

/**
 * Merge the single project in `fromPath` into `intoPath`.
 *
 * `asName` renames the project on the way in, which is how a name collision
 * is resolved: project names are unique per brain, and two clients can
 * reasonably both have a project called "api".
 */
export function mergeBrain(opts: {
  from: string;
  into: string;
  asName?: string;
  dryRun?: boolean;
  skipBackup?: boolean;
  /** Which project to take, when the source holds more than one. */
  sourceProject?: string;
  /**
   * Rename the source brain aside once the merge is verified, so the project
   * actually starts using the destination.
   *
   * Without this a merge has no observable effect: resolution prefers a silo
   * over the shared brain unconditionally, so the source file keeps winning
   * and the copied rows are never read. Renaming rather than deleting keeps
   * the rollback a `mv`.
   */
  retireSource?: boolean;
}): MergeReport {
  const dryRun = opts.dryRun === true;
  const warnings: string[] = [];

  if (!fs.existsSync(opts.from)) {
    throw new MyJarbisError(ErrorType.DB_ERROR, `Source brain not found: ${opts.from}`);
  }
  if (fs.realpathSync(opts.from) === (fs.existsSync(opts.into) ? fs.realpathSync(opts.into) : '')) {
    throw new MyJarbisError(ErrorType.INVALID_INPUT, 'Source and destination are the same file.');
  }

  // ─── open and validate both sides ───
  const src = MyJarbisDB.openExisting(opts.from);
  if (!src) throw new MyJarbisError(ErrorType.DB_ERROR, `Cannot open ${opts.from}`);

  if (src.schemaVersion !== SCHEMA_VERSION) {
    src.close();
    throw new MyJarbisError(
      ErrorType.DB_ERROR,
      `Source is at schema v${src.schemaVersion}, this build expects v${SCHEMA_VERSION}. ` +
        `Run \`myjarbis migrate\` against it first — merging across versions would ` +
        `drop whatever columns the older file lacks.`,
    );
  }

  src.bindScope({ kind: 'all', reason: `merging ${opts.from} into ${opts.into}` });
  const sourceProjects = src.projects.listAll('enumerating the source brain for a merge');

  if (sourceProjects.length === 0) {
    src.close();
    throw new MyJarbisError(ErrorType.DB_ERROR, `${opts.from} contains no projects.`);
  }

  const chosen = opts.sourceProject
    ? sourceProjects.find((p) => p.name === opts.sourceProject)
    : sourceProjects.length === 1
      ? sourceProjects[0]
      : undefined;

  if (!chosen) {
    const names = sourceProjects.map((p) => p.name).join(', ');
    src.close();
    throw new MyJarbisError(
      ErrorType.AMBIGUOUS_PROJECT,
      `${opts.from} holds ${sourceProjects.length} projects (${names}). ` +
        `Pass --source-project to say which one to merge.`,
    );
  }

  // The destination may not exist yet; create it at the current schema.
  const destExisted = fs.existsSync(opts.into);
  const backup =
    destExisted && !dryRun && !opts.skipBackup ? backupBrain(opts.into, 'pre-merge') : undefined;
  if (backup && !backup.walCheckpointed) {
    warnings.push(
      'the destination WAL could not be checkpointed before the backup; the -wal ' +
        'file was copied alongside, so the backup is still complete.',
    );
  }

  // In a dry run, operate on a throwaway copy of the destination. The report
  // then comes from the real code path instead of a parallel prediction.
  let destPath = opts.into;
  const scratch: string[] = [];
  if (dryRun) {
    destPath = `${opts.into}.dryrun.${Date.now()}`;
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(`${opts.into}${suffix}`)) {
        fs.copyFileSync(`${opts.into}${suffix}`, `${destPath}${suffix}`);
        scratch.push(`${destPath}${suffix}`);
      }
    }
  }

  // Set when the source is closed early to be renamed, so the finally below
  // does not close it twice.
  let srcClosed = false;

  const dest = MyJarbisDB.openAtPath(destPath);
  if (!dryRun && destExisted && dest.schemaVersion !== SCHEMA_VERSION) {
    dest.close();
    src.close();
    throw new MyJarbisError(
      ErrorType.DB_ERROR,
      `Destination is at schema v${dest.schemaVersion}; migrate it before merging.`,
    );
  }
  dest.bindScope({ kind: 'all', reason: `merging ${opts.from} into ${opts.into}` });

  const destBefore = countRows(dest);
  const importedAs = opts.asName ?? chosen.name;

  // Idempotency: refuse rather than silently duplicate. Running the merge
  // twice should not give you two copies of a project.
  if (dest.projects.findByName(importedAs)) {
    dest.close();
    src.close();
    for (const f of scratch) fs.existsSync(f) && fs.unlinkSync(f);
    throw new MyJarbisError(
      ErrorType.INVALID_INPUT,
      `Destination already has a project named "${importedAs}". ` +
        `Pass --as <name> to import it under a different name, or it is already merged.`,
    );
  }
  if (dest.projects.findByPath(chosen.path)) {
    dest.close();
    src.close();
    for (const f of scratch) fs.existsSync(f) && fs.unlinkSync(f);
    throw new MyJarbisError(
      ErrorType.INVALID_INPUT,
      `Destination already has a project at path "${chosen.path}" — this brain ` +
        `looks already merged.`,
    );
  }

  const copied: Record<string, number> = Object.fromEntries(COUNTED_TABLES.map((t) => [t, 0]));
  const ids: IdMap = {
    modules: new Map(),
    sessions: new Map(),
    observations: new Map(),
    workflows: new Map(),
  };
  let newProjectId = 0;
  let ftsProbe: MergeReport['ftsProbe'];

  // A known-good search run before and after, to prove the rebuilt index
  // actually resolves. Counting rows does not catch a broken FTS index.
  const probeQuery = pickProbeQuery(src);

  try {
    dest.tx(() => {
      // ─── org ───
      let destOrgId: number | null = null;
      if (chosen.org_id !== null) {
        const srcOrg = src.orgs.findById(chosen.org_id);
        if (srcOrg) {
          const before = dest.orgs.findBySlug(srcOrg.slug);
          const o = dest.orgs.upsert({
            slug: srcOrg.slug,
            name: srcOrg.name,
            packPath: srcOrg.pack_path,
            packRev: srcOrg.pack_rev,
          });
          destOrgId = o.id;
          if (!before) copied.orgs++;
        }
      }

      // ─── context_kinds owned by that org ───
      for (const k of src.contextKinds.list(chosen.org_id)) {
        if (k.org_id === null) continue; // core kinds already exist
        if (!dest.contextKinds.exists(k.slug, destOrgId)) {
          dest.contextKinds.upsert({
            slug: k.slug,
            label: k.label,
            description: k.description,
            orgId: destOrgId,
            position: k.position,
          });
          copied.context_kinds++;
        }
      }

      // ─── project ───
      const remote = chosen.git_remote ? normalizeRemote(chosen.git_remote) : null;
      if (remote && dest.projects.findByRemote(remote)) {
        throw new MyJarbisError(
          ErrorType.INVALID_INPUT,
          `Destination already has a project with git remote "${remote}". ` +
            `That is the same repository under a different name.`,
        );
      }
      const newProject = dest.projects.create({
        name: importedAs,
        path: chosen.path,
        framework: chosen.framework ?? undefined,
        orgId: destOrgId,
        gitRemote: remote,
        // The point of merging is to stop being a separate file.
        isolation: 'shared',
      });
      newProjectId = newProject.id;
      copied.projects++;

      // Rebind both scopes to the new project so the ordinary scoped
      // accessors can be used for the rest of the copy.
      const dw = dest.db;

      // ─── project_context ───
      for (const row of src.projectContext.listByProject(chosen.id)) {
        dw.prepare(
          `INSERT INTO project_context
             (project_id, kind, title, content, tags, source_path, content_hash,
              topic_key, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          newProjectId,
          row.kind,
          row.title,
          row.content,
          row.tags,
          row.source_path,
          row.content_hash,
          row.topic_key,
          row.created_at,
          row.updated_at,
        );
        copied.project_context++;
      }

      // ─── modules (id map) ───
      for (const m of src.modules.listByProject(chosen.id)) {
        const info = dw
          .prepare(
            `INSERT INTO modules (project_id, name, description, status, created_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(newProjectId, m.name, m.description, m.status, m.created_at);
        ids.modules.set(m.id, Number(info.lastInsertRowid));
        copied.modules++;
      }

      // ─── module_context ───
      for (const [oldModuleId, newModuleId] of ids.modules) {
        for (const row of src.moduleContext.listByModule(oldModuleId)) {
          dw.prepare(
            `INSERT INTO module_context
               (module_id, kind, title, content, tags, source_path, content_hash,
                progress, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            newModuleId,
            row.kind,
            row.title,
            row.content,
            row.tags,
            row.source_path,
            row.content_hash,
            row.progress,
            row.created_at,
            row.updated_at,
          );
          copied.module_context++;
        }
      }

      // ─── skills (project-level and module-level) ───
      for (const s of src.skills.listByProject(chosen.id)) {
        const mappedModule = s.module_id === null ? null : (ids.modules.get(s.module_id) ?? null);
        if (s.module_id !== null && mappedModule === null) {
          warnings.push(`skill "${s.name}" referenced an unknown module; imported as project-level`);
        }
        dw.prepare(
          `INSERT INTO skills
             (project_id, module_id, name, description, trigger_pattern, content,
              content_hash, enabled, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          newProjectId,
          mappedModule,
          s.name,
          s.description,
          s.trigger_pattern,
          s.content,
          s.content_hash,
          s.enabled,
          s.created_at,
          s.updated_at,
        );
        copied.skills++;
      }

      // ─── sessions (id map) ───
      for (const [oldModuleId, newModuleId] of ids.modules) {
        const rows = src.db
          .prepare('SELECT * FROM sessions WHERE module_id = ? ORDER BY id')
          .all(oldModuleId) as Array<{
          id: number;
          started_at: string;
          ended_at: string | null;
          summary: string | null;
          next_session: string | null;
        }>;
        for (const s of rows) {
          const info = dw
            .prepare(
              `INSERT INTO sessions (module_id, started_at, ended_at, summary, next_session)
               VALUES (?, ?, ?, ?, ?)`,
            )
            .run(newModuleId, s.started_at, s.ended_at, s.summary, s.next_session);
          ids.sessions.set(s.id, Number(info.lastInsertRowid));
          copied.sessions++;
        }
      }

      // ─── observations (id map; `supersedes` is self-referential) ───
      const srcObs = src.db
        .prepare('SELECT * FROM observations WHERE project_id = ? OR project_id IS NULL ORDER BY id')
        .all(chosen.id) as Array<{
        id: number;
        session_id: number;
        project_id: number | null;
        kind: string;
        title: string;
        content: string;
        story_local_id: string | null;
        files: string | null;
        tags: string | null;
        topic_key: string | null;
        supersedes: number | null;
        created_at: string;
        updated_at: string | null;
      }>;

      for (const o of srcObs) {
        const newSession = ids.sessions.get(o.session_id);
        if (newSession === undefined) {
          // Belongs to a session outside this project. Skipping is correct:
          // importing it would attach the note to the wrong session.
          warnings.push(
            `observation ${o.id} ("${o.title.slice(0, 40)}") referenced session ` +
              `${o.session_id}, which is not part of this project; skipped`,
          );
          continue;
        }
        const info = dw
          .prepare(
            `INSERT INTO observations
               (session_id, project_id, kind, title, content, story_local_id, files,
                tags, topic_key, supersedes, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
          )
          .run(
            newSession,
            newProjectId,
            o.kind,
            o.title,
            o.content,
            o.story_local_id,
            o.files,
            o.tags,
            o.topic_key,
            o.created_at,
            o.updated_at,
          );
        ids.observations.set(o.id, Number(info.lastInsertRowid));
        copied.observations++;
      }

      // Second pass for `supersedes`: the target may be a row we inserted
      // later, so it cannot be resolved during the first pass.
      for (const o of srcObs) {
        if (o.supersedes === null) continue;
        const self = ids.observations.get(o.id);
        const target = ids.observations.get(o.supersedes);
        if (self === undefined || target === undefined) continue;
        dw.prepare('UPDATE observations SET supersedes = ? WHERE id = ?').run(target, self);
      }

      // ─── refs ───
      for (const [oldObsId, newObsId] of ids.observations) {
        const rows = src.db
          .prepare('SELECT * FROM refs WHERE observation_id = ? ORDER BY id')
          .all(oldObsId) as Array<{
          kind: string;
          provider: string;
          external_id: string;
          url: string | null;
          created_at: string;
        }>;
        for (const r of rows) {
          dw.prepare(
            `INSERT INTO refs (observation_id, kind, provider, external_id, url, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          ).run(newObsId, r.kind, r.provider, r.external_id, r.url, r.created_at);
          copied.refs++;
        }
      }

      // ─── project_state ───
      const state = src.projectState.get(chosen.id);
      if (state) {
        dw.prepare(
          `INSERT INTO project_state (project_id, content, updated_at, updated_by)
           VALUES (?, ?, ?, ?)`,
        ).run(newProjectId, state.content, state.updated_at, state.updated_by);
        copied.project_state++;
      }

      // ─── providers ───
      for (const p of src.providers.listByProject(chosen.id)) {
        dw.prepare(
          `INSERT INTO providers (project_id, role, kind, config) VALUES (?, ?, ?, ?)`,
        ).run(newProjectId, p.role, p.kind, p.config);
        copied.providers++;
      }

      // ─── workflows at project and user scope (org ones came with the org) ───
      const srcWorkflows = src.db
        .prepare(
          `SELECT * FROM workflows WHERE scope IN ('project','user') AND scope_id = ? ORDER BY id`,
        )
        .all(chosen.id) as Array<{
        id: number;
        slug: string;
        name: string;
        scope: string;
        extends: number | null;
        created_at: string;
      }>;
      for (const w of srcWorkflows) {
        const info = dw
          .prepare(
            `INSERT INTO workflows (slug, name, scope, scope_id, extends, created_at)
             VALUES (?, ?, ?, ?, NULL, ?)`,
          )
          .run(w.slug, w.name, w.scope, newProjectId, w.created_at);
        ids.workflows.set(w.id, Number(info.lastInsertRowid));
        copied.workflows++;
      }
      for (const w of srcWorkflows) {
        if (w.extends === null) continue;
        const self = ids.workflows.get(w.id);
        const target = ids.workflows.get(w.extends);
        if (self === undefined || target === undefined) continue;
        dw.prepare('UPDATE workflows SET extends = ? WHERE id = ?').run(target, self);
      }
      for (const [oldWfId, newWfId] of ids.workflows) {
        for (const s of src.workflowSteps.listByWorkflow(oldWfId)) {
          dw.prepare(
            `INSERT INTO workflow_steps
               (workflow_id, position, name, actor, gate, capability, condition,
                notes, overrides, disabled)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
          ).run(
            newWfId,
            s.position,
            s.name,
            s.actor,
            s.gate,
            s.capability,
            s.condition,
            s.notes,
            s.disabled,
          );
          copied.workflow_steps++;
        }
      }
    });

    // ─── rebuild FTS and prove it resolves ───
    const hitsBefore = probeQuery ? countHits(src, probeQuery, chosen.id) : 0;
    dest.rebuildFts();
    const hitsAfter = probeQuery ? countHits(dest, probeQuery, newProjectId) : 0;
    if (probeQuery) {
      ftsProbe = { query: probeQuery, hitsBefore, hitsAfter };
      if (hitsAfter < hitsBefore) {
        warnings.push(
          `FTS probe "${probeQuery}" found ${hitsBefore} rows in the source but ` +
            `${hitsAfter} after the merge. The index may not have rebuilt correctly.`,
        );
      }
    }

    const destAfter = countRows(dest);
    const integrity = (dest.db.pragma('integrity_check') as Array<{ integrity_check: string }>)[0]
      .integrity_check;
    const fk = (dest.db.pragma('foreign_key_check') as unknown[]).length;

    const mismatches: MergeReport['mismatches'] = [];
    for (const t of COUNTED_TABLES) {
      const expected = (destBefore[t] ?? 0) + (copied[t] ?? 0);
      const actual = destAfter[t] ?? 0;
      if (expected !== actual) mismatches.push({ table: t, expected, actual });
    }
    if (mismatches.length > 0) {
      warnings.push(
        'row counts do not add up (see mismatches). The merge is NOT verified; ' +
          `restore from ${backup?.backupPath ?? 'your own backup'} before relying on it.`,
      );
    }

    // Retire the source only once the merge is verified — a mismatch or a
    // failed integrity check means the destination is not trustworthy yet,
    // and moving the original away would be the worst possible moment.
    let retiredSourceTo: string | undefined;
    const healthy = mismatches.length === 0 && integrity === 'ok' && fk === 0;
    if (!dryRun && opts.retireSource && healthy) {
      src.close();
      srcClosed = true;
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      retiredSourceTo = `${opts.from}.merged-${ts}`;
      for (const suffix of ['', '-wal', '-shm']) {
        if (fs.existsSync(`${opts.from}${suffix}`)) {
          fs.renameSync(`${opts.from}${suffix}`, `${retiredSourceTo}${suffix}`);
        }
      }
      warnings.push(
        `source renamed to ${retiredSourceTo} — the project now resolves to ` +
          `${opts.into}. To undo, rename it back.`,
      );
    } else if (!dryRun && !opts.retireSource) {
      // Say it loudly: without this step the merge looks successful and
      // changes nothing the user can observe.
      warnings.push(
        `the source brain is still at ${opts.from}, and resolution prefers a ` +
          `silo over the shared brain — so this project still reads its old ` +
          `file and the rows just copied will go stale. Re-run with ` +
          `--retire-source, or rename the file aside yourself.`,
      );
    }

    return {
      from: opts.from,
      into: opts.into,
      project: { sourceName: chosen.name, importedAs, newId: newProjectId },
      dryRun,
      backup,
      retiredSourceTo,
      copied,
      destBefore,
      destAfter,
      mismatches,
      integrity,
      foreignKeyViolations: fk,
      ftsRebuilt: true,
      ftsProbe,
      warnings: dryRun
        ? [...warnings, 'dry run — the destination was not modified']
        : warnings,
    };
  } finally {
    dest.close();
    if (!srcClosed) src.close();
    for (const f of scratch) {
      try {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      } catch {
        /* best effort */
      }
    }
  }
}

/** A term that actually occurs in the source, to probe FTS with. */
function pickProbeQuery(src: MyJarbisDB): string | null {
  const row = src.db
    .prepare(
      `SELECT title FROM observations WHERE length(title) > 8
        UNION ALL SELECT title FROM project_context WHERE length(title) > 8
        LIMIT 1`,
    )
    .get() as { title: string } | undefined;
  if (!row) return null;
  const word = row.title
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter((w) => w.length > 4)[0];
  return word ?? null;
}

function countHits(db: MyJarbisDB, query: string, projectId: number): number {
  try {
    const bound = db.boundScope;
    // countHits runs on an 'all'-scoped connection during a merge, so the
    // project filter is passed explicitly here rather than taken from scope.
    void bound;
    const a = db.db
      .prepare(
        `SELECT COUNT(*) AS n FROM observations_fts
           JOIN observations o ON o.id = observations_fts.rowid
          WHERE observations_fts MATCH ? AND o.project_id = ?`,
      )
      .get(`"${query}"`, projectId) as { n: number };
    const b = db.db
      .prepare(
        `SELECT COUNT(*) AS n FROM project_context_fts
           JOIN project_context pc ON pc.id = project_context_fts.rowid
          WHERE project_context_fts MATCH ? AND pc.project_id = ?`,
      )
      .get(`"${query}"`, projectId) as { n: number };
    return a.n + b.n;
  } catch {
    return 0;
  }
}
