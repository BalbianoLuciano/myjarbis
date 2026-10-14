/**
 * `org sync` — re-apply a pack to every project of an org.
 *
 * This is the operation that pays for the whole org-pack idea: changing one
 * cross-cutting rule used to mean visiting N projects by hand, which is
 * exactly why two of the three real projects measured had never received
 * that layer at all.
 *
 * Projects live in two places and both have to be visited:
 *   · shared projects, as rows in the global brain
 *   · silo projects, each in its own file, found through the registry
 *
 * Every project is applied independently and failures are collected rather
 * than thrown, so one broken project does not abandon the rest half-synced.
 */

import * as fs from 'fs';
import { ServerContext } from '../context.js';
import { MyJarbisDB } from '../db/index.js';
import { MyJarbisError, ErrorType } from '../types.js';
import { globalDbPath, siloDbPath } from '../resolve.js';
import { readRegistry } from './registry.js';
import { Pack, applyPack, readPack, PackApplyReport } from './pack.js';

export interface SyncTarget {
  name: string;
  path: string;
  isolation: 'silo' | 'shared';
  dbPath: string;
}

export interface SyncProjectResult {
  name: string;
  path: string;
  ok: boolean;
  skills?: number;
  materialized?: number;
  skipped?: string;
  error?: string;
}

export interface OrgSyncResult {
  org: string;
  rev: string;
  packPath: string;
  dryRun: boolean;
  projects: SyncProjectResult[];
  summary: { applied: number; skipped: number; failed: number };
}

/**
 * Projects that belong to `orgSlug`.
 *
 * A silo project only knows its own org, so the registry path has to be
 * opened to find out. Those that predate v4 are reported as skipped with a
 * reason rather than silently ignored — "sync said nothing about project X"
 * is the failure mode this whole command exists to remove.
 */
export function findOrgProjects(orgSlug: string): {
  targets: SyncTarget[];
  skipped: SyncProjectResult[];
} {
  const targets: SyncTarget[] = [];
  const skipped: SyncProjectResult[] = [];
  const seen = new Set<string>();

  // 1. Shared projects, from the global brain.
  const globalDb = MyJarbisDB.openExisting(globalDbPath());
  if (globalDb) {
    try {
      if (globalDb.schemaVersion >= 4) {
        globalDb.bindScope({ kind: 'all', reason: `org sync for "${orgSlug}"` });
        const org = globalDb.orgs.findBySlug(orgSlug);
        if (org) {
          for (const p of globalDb.orgs.projectsOf(org.id)) {
            seen.add(p.path);
            targets.push({
              name: p.name,
              path: p.path,
              isolation: 'shared',
              dbPath: globalDbPath(),
            });
          }
        }
      }
    } finally {
      globalDb.close();
    }
  }

  // 2. Silo projects, from the registry. Each file must be opened to learn
  //    which org it belongs to.
  for (const entry of readRegistry()) {
    if (seen.has(entry.path)) continue;
    const dbPath = siloDbPath(entry.path);
    if (!fs.existsSync(dbPath)) continue;

    const db = MyJarbisDB.openExisting(dbPath);
    if (!db) continue;
    try {
      if (db.schemaVersion < 4) {
        skipped.push({
          name: entry.name,
          path: entry.path,
          ok: false,
          skipped: `brain is at schema v${db.schemaVersion}; run \`myjarbis migrate\` there first`,
        });
        continue;
      }
      const project = db.projects.findByPath(entry.path);
      if (!project || project.org_id === null) continue;
      const org = db.orgs.findById(project.org_id);
      if (!org || org.slug !== orgSlug) continue;

      targets.push({
        name: project.name,
        path: project.path,
        isolation: 'silo',
        dbPath,
      });
    } finally {
      db.close();
    }
  }

  return { targets, skipped };
}

/**
 * Apply `pack` to every project of its org.
 *
 * Each project gets its own ServerContext, because applying a pack writes
 * skills to that project's `.claude/skills/` — materialisation is per
 * working tree, not per database.
 */
export function syncOrg(
  packPathOrSlug: string,
  opts: { dryRun?: boolean } = {},
): OrgSyncResult {
  const pack: Pack = readPack(packPathOrSlug);
  const { targets, skipped } = findOrgProjects(pack.slug);

  const results: SyncProjectResult[] = [...skipped];

  for (const t of targets) {
    try {
      // `t.dbPath` is already resolved per isolation by findOrgProjects.
      // Dropping it here opened a silo next to every shared project and then
      // reported 'project row not found in its own brain' for each one.
      const ctx = ServerContext.initializeForSeed(t.path, t.dbPath);
      try {
        if (!ctx.project) {
          results.push({
            name: t.name,
            path: t.path,
            ok: false,
            error: 'project row not found in its own brain',
          });
          continue;
        }
        const report: PackApplyReport = applyPack(ctx, pack, { dryRun: opts.dryRun });
        results.push({
          name: t.name,
          path: t.path,
          ok: true,
          skills: report.skills.length,
          materialized: report.materialized.count,
        });
      } finally {
        ctx.close();
      }
    } catch (err) {
      results.push({
        name: t.name,
        path: t.path,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (results.length === 0) {
    throw new MyJarbisError(
      ErrorType.ORG_NOT_FOUND,
      `No projects belong to org "${pack.slug}". Register one with ` +
        `\`myjarbis init --org=${pack.slug}\` in a project root.`,
      { org: pack.slug },
    );
  }

  return {
    org: pack.slug,
    rev: pack.rev,
    packPath: pack.packPath,
    dryRun: opts.dryRun === true,
    projects: results,
    summary: {
      applied: results.filter((r) => r.ok).length,
      skipped: results.filter((r) => r.skipped).length,
      failed: results.filter((r) => !r.ok && !r.skipped).length,
    },
  };
}
