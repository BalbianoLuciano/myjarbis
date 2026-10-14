/**
 * Context kinds — validation, listing, and migrating the labels in the wild.
 *
 * `project_context.kind` and `module_context.kind` were free text. Three
 * real projects produced three vocabularies for the same seven ideas
 * (`dominio/runbook/decision/gotcha` · `process/environment/decisions/
 * gotchas/stack/bitacora` · `stack/environment/gotchas/bitacora`), so no
 * query could assume a label existed. By contrast `observations.kind`, which
 * code fixes to a list, came out identical in all three — the divergence was
 * caused by the absence of a catalogue, not by the projects differing.
 *
 * With a fixed vocabulary, `load_project_core(kinds=[...])` becomes
 * trustworthy — before, no caller could assume a project used any
 * particular label — and a cross-project question about gotchas becomes
 * answerable at all.
 *
 * Note it does NOT mean the session hook preferentially loads some kinds:
 * start_session still loads every project_context row as an excerpt, as it
 * always has. The catalogue makes a kind-filtered read reliable; it does
 * not itself change what bootstrap reads.
 */

import { z } from 'zod';
import { ServerContext } from '../context.js';
import { MyJarbisError, ErrorType } from '../types.js';
import {
  CONTEXT_KIND_ALIASES,
  DEPRECATED_CONTEXT_KINDS,
  ContextKind,
} from '../db/schema.js';

/** Levenshtein distance, for "did you mean". Bounded inputs (slugs). */
function distance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i, ...Array(n).fill(0)];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[n];
}

/** The closest catalogue slug to `input`, if one is close enough to mean it. */
export function nearestKind(input: string, candidates: string[]): string | null {
  const needle = input.toLowerCase();
  let best: { slug: string; d: number } | null = null;
  for (const slug of candidates) {
    const d = distance(needle, slug);
    if (!best || d < best.d) best = { slug, d };
  }
  // A third of the length is a typo or an inflection; beyond that it is a
  // different word, and guessing would be worse than listing the options.
  if (best && best.d <= Math.max(2, Math.floor(needle.length / 3))) return best.slug;
  return null;
}

/**
 * Resolve a kind against the catalogue.
 *
 * Known aliases are mapped silently (`dominio` → `domain`) since they are
 * the same idea in another language. Anything else is rejected WITH the
 * nearest match and the full list, because accepting it is how the
 * vocabulary fragmented in the first place.
 */
export function resolveContextKind(ctx: ServerContext, kind: string): ContextKind {
  const project = ctx.project;
  const orgId = project?.org_id ?? null;
  const raw = kind.trim().toLowerCase();

  // Deprecated slugs first: they ARE in the catalogue (so rows already
  // written against them stay valid), which means the exists() check below
  // would accept them and the redirect would never fire.
  const replacement = DEPRECATED_CONTEXT_KINDS[raw];
  if (replacement && ctx.db.contextKinds.exists(replacement, orgId)) {
    return replacement;
  }

  if (ctx.db.contextKinds.exists(raw, orgId)) return raw;

  const alias = CONTEXT_KIND_ALIASES[raw];
  if (alias && ctx.db.contextKinds.exists(alias, orgId)) return alias;

  const all = ctx.db.contextKinds.list(orgId).map((k) => k.slug);
  const near = nearestKind(raw, all);
  throw new MyJarbisError(
    ErrorType.INVALID_CONTEXT_KIND,
    `Unknown context kind "${kind}".` +
      (near ? ` Did you mean "${near}"?` : '') +
      `\nAvailable: ${all.join(', ')}.` +
      `\nAn org pack can add its own via context-kinds.yml; it is not free text ` +
      `because three projects once invented three names for the same seven ideas.`,
    { given: kind, suggestion: near, available: all },
  );
}

// ─────────────────────────────────────────────────────────────────────
// list_context_kinds
// ─────────────────────────────────────────────────────────────────────

export const listContextKindsInputSchema = {
  type: 'object' as const,
  properties: {},
};

export interface ListContextKindsResult {
  kinds: Array<{
    slug: string;
    label: string;
    description: string | null;
    source: 'core' | 'org';
  }>;
  hint: string;
}

export function listContextKinds(ctx: ServerContext): ListContextKindsResult {
  const orgId = ctx.project?.org_id ?? null;
  const kinds = ctx.db.contextKinds.list(orgId).map((k) => ({
    slug: k.slug,
    label: k.label,
    description: k.description,
    source: (k.org_id === null ? 'core' : 'org') as 'core' | 'org',
  }));
  return {
    kinds,
    hint:
      'Use one of these as `kind` when importing or saving context. ' +
      '"logbook" is living state and "gotchas" is traps; both are reliable ' +
      'targets for load_project_core(kinds=[...]) now that every project ' +
      'uses the same vocabulary. A slug marked "(legacy)" still works for ' +
      'existing rows but new writes are redirected to its replacement.',
  };
}

// ─────────────────────────────────────────────────────────────────────
// migrate_kinds — fold the labels already on disk into the catalogue
// ─────────────────────────────────────────────────────────────────────

const migrateKindsArgsZ = z.object({ dry_run: z.boolean().optional() }).strict();

export interface KindMigrationResult {
  dryRun: boolean;
  projectContext: Array<{ from: string; to: string; rows: number; reason: string }>;
  moduleContext: Array<{ from: string; to: string; rows: number; reason: string }>;
  unmapped: string[];
  totalRewritten: number;
}

/**
 * Rewrite existing `kind` values onto catalogue slugs.
 *
 * Unmapped labels go to `misc`, deliberately NOT to `gotchas`. `gotchas` is
 * the kind a reader reaches for first when asking "what should I know before
 * touching this", so filling it with unclassified rows would degrade the one
 * label most worth trusting. `misc` is inert and sorts last, and every
 * rewrite is reported so the leftovers can be triaged by hand.
 */
export function migrateKinds(ctx: ServerContext, rawArgs: unknown): KindMigrationResult {
  const args = migrateKindsArgsZ.parse(rawArgs ?? {});
  const dryRun = args.dry_run === true;
  const project = ctx.requireProject();
  const orgId = project.org_id;

  const result: KindMigrationResult = {
    dryRun,
    projectContext: [],
    moduleContext: [],
    unmapped: [],
    totalRewritten: 0,
  };

  const target = (kind: string): { to: string; reason: string } | null => {
    const raw = kind.trim().toLowerCase();
    const deprecated = DEPRECATED_CONTEXT_KINDS[raw];
    if (deprecated && ctx.db.contextKinds.exists(deprecated, orgId)) {
      return { to: deprecated, reason: 'deprecated vendor-specific slug' };
    }
    if (ctx.db.contextKinds.exists(raw, orgId)) return null; // already valid
    const alias = CONTEXT_KIND_ALIASES[raw];
    if (alias && ctx.db.contextKinds.exists(alias, orgId)) {
      return { to: alias, reason: 'known alias' };
    }
    const near = nearestKind(raw, ctx.db.contextKinds.list(orgId).map((k) => k.slug));
    if (near) return { to: near, reason: `closest catalogue slug to "${raw}"` };
    result.unmapped.push(raw);
    return { to: 'misc', reason: 'no catalogue match; parked in misc for review' };
  };

  const apply = (): void => {
    for (const { kind, n } of ctx.db.projectContext.distinctKinds(project.id)) {
      const t = target(kind);
      if (!t) continue;
      result.projectContext.push({ from: kind, to: t.to, rows: n, reason: t.reason });
      result.totalRewritten += n;
      if (!dryRun) {
        for (const row of ctx.db.projectContext.listByProject(project.id)) {
          if (row.kind === kind) ctx.db.projectContext.setKind(row.id, t.to);
        }
      }
    }

    for (const mod of ctx.db.modules.listByProject(project.id)) {
      for (const { kind, n } of ctx.db.moduleContext.distinctKinds(mod.id)) {
        const t = target(kind);
        if (!t) continue;
        result.moduleContext.push({ from: kind, to: t.to, rows: n, reason: t.reason });
        result.totalRewritten += n;
        if (!dryRun) {
          for (const row of ctx.db.moduleContext.listByModule(mod.id)) {
            if (row.kind === kind) ctx.db.moduleContext.setKind(row.id, t.to);
          }
        }
      }
    }
  };

  if (dryRun) {
    apply();
  } else {
    ctx.db.tx(apply);
  }

  result.unmapped = [...new Set(result.unmapped)];
  return result;
}
