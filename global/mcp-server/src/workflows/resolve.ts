/**
 * Workflow resolution — org → project → user, flattened.
 *
 * The process used to live in prose, duplicated across a skill, a
 * project_context row and a second project-level skill, with nothing to say
 * which one won. The agent then had to reconcile three documents on every
 * session, and reconciled them differently each time.
 *
 * Here the three layers are rows, and resolution produces ONE ordered list.
 * Rules:
 *   · a step is identified by its `name` (unique per workflow row)
 *   · a more specific layer replaces a step of the same name
 *   · `disabled = 1` removes an inherited step rather than replacing it
 *   · `position` orders the result; a replacement keeps its own position
 *
 * `capability` stays abstract — 'tracker.comment', never a product name — so
 * the same org workflow serves a client on one tracker and a client on
 * another. Which tool that means is a `providers` row, resolved separately
 * and attached here for the agent's convenience.
 *
 * COMPOSITION, and the one ordering decision in this file.
 *
 * A step can carry `uses: <slug>`, meaning "run that workflow here". The
 * layers of each slug are resolved FIRST, and expansion happens afterwards,
 * over the already-resolved list. The other order is tempting and wrong:
 *
 *   expand first  → the child's steps land in the PARENT's name space before
 *                   the project and user layers key against it. Overriding one
 *                   child step would then mean writing it into the parent, once
 *                   per parent that invokes the child, and it would silently
 *                   stop applying the day a parent changed its `uses` target.
 *                   That is three copies of one rule — the exact condition
 *                   this table was created to end.
 *
 *   expand after  → each slug has ONE owner. `commit-ritual` is layered
 *                   org→project→user as itself, and every parent that invokes
 *                   it receives the same resolved child. A project turns the
 *                   push gate off in `commit-ritual`, once, and all three
 *                   parents inherit it.
 *
 * It is also the only arrangement that leaves the layer loop below untouched,
 * which is what keeps every workflow with no `uses` step resolving exactly as
 * it did before.
 *
 * The cost, stated plainly: a parent cannot disable one step of a child. The
 * escape hatch is designed — a parent-layer `disabled` row named
 * `child/step`, applied as a filter on the expanded list — and deliberately
 * not shipped, because it can be added the first time somebody needs it
 * instead of guessed at now.
 *
 * `extends` answers a different question and stays: it means "my steps start
 * from that workflow's steps", flattened under my own names. `uses` means "at
 * this position, run that workflow", namespaced and still owned by it.
 */

import { ServerContext } from '../context.js';
import { MyJarbisError, ErrorType } from '../types.js';
import { WorkflowRow, WorkflowStepRow, ProviderRole } from '../db/schema.js';
import { evaluateCondition, ConditionFacts, EvalResult } from './condition.js';

export interface ResolvedStep {
  /**
   * The step's position inside the workflow that OWNS it.
   *
   * Deliberately not renumbered over the flat list. It is the value
   * `set_workflow_step` inherits when overriding a step across layers — a rule
   * with its own postmortem, because numbering per layer once moved an
   * approval gate ahead of the tests it was meant to follow — and a flattened
   * number would be meaningless to write back. Use `order` for the sequence.
   */
  position: number;
  /** 1-based place in the flat, expanded list. This is the running order. */
  order: number;
  /** Namespaced as "child-slug/step-name" for a step from a child. */
  name: string;
  actor: string;
  gate: 'none' | 'approve' | 'on-request';
  capability: string | null;
  condition: string | null;
  notes: string | null;
  /** Which layer this step's final definition came from. */
  from: 'org' | 'project' | 'user';
  /**
   * Which WORKFLOW SLUG owns it — the parent's own slug for its own steps,
   * the child's for an expanded one.
   *
   * Separate from `from` because they answer different questions: `from` says
   * which of the three layers won, `fromWorkflow` says where to go to change
   * it. A namespaced step is overridden in its own workflow, not in the parent.
   */
  fromWorkflow: string;
  /** 0 for the parent's own steps, 1 for a child's, 2 for a grandchild's. */
  depth: number;
  /** The concrete provider behind `capability`, when the role is configured. */
  provider?: { role: string; kind: string } | null;
  /** Present when the step has a condition and facts were supplied. */
  applies?: boolean;
  why?: EvalResult['detail'];
}

export interface ResolvedWorkflow {
  slug: string;
  name: string;
  /** False when this workflow is only invocable from a parent. */
  standalone: boolean;
  layers: Array<{ scope: 'org' | 'project' | 'user'; scopeId: number; steps: number }>;
  steps: ResolvedStep[];
  /** Inherited steps switched off by a more specific layer. */
  suppressed: Array<{ name: string; disabledBy: 'org' | 'project' | 'user' }>;
  /** Child workflows pulled in, in invocation order. */
  expanded: Array<{ slug: string; viaStep: string; depth: number; steps: number }>;
  facts?: ConditionFacts;
}

/** Collect the facts a condition can be evaluated against. */
export function gatherFacts(
  ctx: ServerContext,
  opts: { branch?: string | null; module?: string | null } = {},
): ConditionFacts {
  const project = ctx.requireProject();
  const roleKind = (role: ProviderRole): string | null =>
    ctx.db.providers.findByRole(project.id, role)?.kind ?? null;

  let moduleName = opts.module ?? null;
  if (!moduleName && ctx.activeModuleId !== null) {
    moduleName = ctx.db.modules.findById(ctx.activeModuleId)?.name ?? null;
  }

  return {
    branch: opts.branch ?? null,
    module: moduleName,
    framework: project.framework,
    tracker: roleKind('tracker'),
    forge: roleKind('forge'),
    ci: roleKind('ci'),
  };
}

/**
 * Resolve one workflow slug for the current project.
 *
 * `facts` is optional: without it the steps come back unevaluated, which is
 * what listing a workflow wants. With it, each conditional step carries
 * `applies` and the per-clause reason, so a skipped step can say why.
 */
export function resolveWorkflow(
  ctx: ServerContext,
  slug: string,
  opts: {
    facts?: ConditionFacts;
    /** Default true. False returns the parent's own steps, `uses` intact. */
    expand?: boolean;
    /**
     * Slugs already being resolved further up, for the cycle guard. Carried as
     * a PATH rather than a set so the error can print `a → b → a`: "a cycle was
     * detected" leaves the reader to find it themselves.
     */
    chain?: string[];
  } = {},
): ResolvedWorkflow {
  const project = ctx.requireProject();
  const chain = opts.chain ?? [];
  if (chain.includes(slug)) {
    throw new MyJarbisError(
      ErrorType.INVALID_INPUT,
      `workflow "${slug}" invokes itself: ${[...chain, slug].join(' → ')}.`,
      { cycle: [...chain, slug] },
    );
  }
  // `scopedOrgId` and not `project.org_id`: the project row was read when the
  // connection was bound, and joining an org mid-process is exactly what
  // `org pull` does. The cached value made an org layer invisible for the rest
  // of the session.
  const layers = ctx.db.workflows.layersFor(slug, project.id, ctx.db.scopedOrgId);

  if (layers.length === 0) {
    const available = ctx.db.workflows.listSlugs(project.id, ctx.db.scopedOrgId);
    throw new MyJarbisError(
      ErrorType.WORKFLOW_NOT_FOUND,
      `No workflow "${slug}" reachable from project "${project.name}".` +
        (available.length
          ? ` Available: ${available.join(', ')}.`
          : ' This project has no workflows; load an org pack or define one.'),
      { slug, available },
    );
  }

  // layersFor already orders org → project → user, i.e. least to most
  // specific, so a later layer simply overwrites what an earlier one set.
  const byName = new Map<string, ResolvedStep>();
  const suppressed: ResolvedWorkflow['suppressed'] = [];
  const layerInfo: ResolvedWorkflow['layers'] = [];
  let displayName = slug;
  // The most specific layer decides whether this is a child. A project can
  // hide an org workflow from the menu without touching its steps.
  let standalone = true;
  const usesByStep = new Map<string, string>();

  for (const layer of layers) {
    const steps = stepsOf(ctx, layer);
    layerInfo.push({ scope: layer.scope, scopeId: layer.scope_id, steps: steps.length });
    displayName = layer.name || displayName;
    standalone = layer.standalone !== 0;

    for (const s of steps) {
      if (s.disabled === 1) {
        // Switch off an inherited step. Recorded rather than dropped
        // silently: "why did this step vanish" is otherwise unanswerable.
        byName.delete(s.name);
        usesByStep.delete(s.name);
        suppressed.push({ name: s.name, disabledBy: layer.scope });
        continue;
      }
      if (s.uses) usesByStep.set(s.name, s.uses);
      else usesByStep.delete(s.name);
      byName.set(s.name, {
        position: s.position,
        order: 0, // assigned over the flat list once expansion is done
        name: s.name,
        actor: s.actor,
        gate: s.gate,
        capability: s.capability,
        condition: s.condition,
        notes: s.notes,
        from: layer.scope,
        fromWorkflow: slug,
        depth: 0,
      });
    }
  }

  const own = [...byName.values()].sort(
    (a, b) => a.position - b.position || (a.name < b.name ? -1 : 1),
  );

  // ── expansion ──
  const expanded: ResolvedWorkflow['expanded'] = [];
  let steps: ResolvedStep[] = [];
  for (const s of own) {
    const childSlug = usesByStep.get(s.name);
    if (!childSlug || opts.expand === false) {
      steps.push(s);
      continue;
    }
    let child: ResolvedWorkflow;
    try {
      child = resolveWorkflow(ctx, childSlug, { facts: opts.facts, chain: [...chain, slug] });
    } catch (err) {
      // A missing child is reported against the step that invokes it. The
      // bare "no workflow X" would send the reader looking for a typo in
      // whatever they were running, not in the parent they have never opened.
      if (err instanceof MyJarbisError && err.type === ErrorType.WORKFLOW_NOT_FOUND) {
        throw new MyJarbisError(
          ErrorType.WORKFLOW_NOT_FOUND,
          `step "${s.name}" of workflow "${slug}" invokes "${childSlug}", which is ` +
            `not reachable from this project. ${err.message}`,
          { parent: slug, step: s.name, missing: childSlug },
        );
      }
      throw err;
    }
    expanded.push({
      slug: childSlug,
      viaStep: s.name,
      depth: 1,
      steps: child.steps.length,
    });
    for (const c of child.expanded) {
      expanded.push({ ...c, depth: c.depth + 1 });
    }
    for (const c of child.steps) {
      steps.push({
        ...c,
        // Prefixed with the child's slug ONLY at this level, so a grandchild
        // arrives already namespaced by its own parent and is not prefixed
        // twice. The name says which workflow owns the step, which is where
        // it has to be overridden.
        name: c.depth === 0 ? `${childSlug}/${c.name}` : c.name,
        depth: c.depth + 1,
      });
    }
  }

  // The list is already in running order by construction — the own steps were
  // sorted by position, and each child was spliced in where its step sat. So
  // `order` is just the index, and `position` is left alone.
  steps = steps.map((s, i) => ({ ...s, order: i + 1 }));

  // Attach the concrete provider for each abstract capability.
  for (const s of steps) {
    if (!s.capability) continue;
    const role = s.capability.split('.')[0] as ProviderRole;
    if (role === 'tracker' || role === 'forge' || role === 'ci') {
      const p = ctx.db.providers.findByRole(project.id, role);
      s.provider = p ? { role: p.role, kind: p.kind } : null;
    }
  }

  if (opts.facts) {
    for (const s of steps) {
      if (!s.condition) {
        s.applies = true;
        continue;
      }
      const r = evaluateCondition(s.condition, opts.facts);
      s.applies = r.matched;
      s.why = r.detail;
    }
  }

  return {
    slug,
    name: displayName,
    standalone,
    layers: layerInfo,
    steps,
    suppressed,
    expanded,
    facts: opts.facts,
  };
}

/**
 * Steps of one workflow row, following `extends` first.
 *
 * `extends` lets a project-scope workflow build on a specific other
 * workflow row rather than only on the layer above it. Guarded against
 * cycles, which would otherwise hang the resolver.
 */
function stepsOf(ctx: ServerContext, wf: WorkflowRow, seen = new Set<number>()): WorkflowStepRow[] {
  if (seen.has(wf.id)) {
    throw new MyJarbisError(
      ErrorType.INVALID_INPUT,
      `workflow "${wf.slug}" extends itself (cycle through id ${wf.id}).`,
    );
  }
  seen.add(wf.id);

  const inherited: WorkflowStepRow[] = [];
  if (wf.extends !== null) {
    const parent = ctx.db.workflows.findById(wf.extends);
    if (parent) inherited.push(...stepsOf(ctx, parent, seen));
  }
  return [...inherited, ...ctx.db.workflowSteps.listByWorkflow(wf.id)];
}

/**
 * Every workflow a user can start, with what it expands into.
 *
 * Non-standalone workflows are absent: they are fragments, and offering one as
 * a ritual of its own is how somebody runs half a process. They remain fully
 * resolvable by slug, which is how a parent's `uses` step reaches them.
 */
export function listWorkflows(
  ctx: ServerContext,
  opts: { includeNonStandalone?: boolean } = {},
): Array<{
  slug: string;
  name: string;
  layers: string[];
  steps: number;
  standalone: boolean;
  uses: string[];
  /** Why this one cannot be resolved, when it cannot. */
  error?: string;
}> {
  const project = ctx.requireProject();
  return ctx.db.workflows
    .listSlugs(project.id, ctx.db.scopedOrgId, {
      includeNonStandalone: opts.includeNonStandalone,
    })
    .map((slug) => {
      // Resilient per slug, and that is a requirement rather than caution.
      // Listing resolves EVERY workflow, so one broken definition — a cycle,
      // a `uses` pointing at something that was deleted — used to take the
      // whole list with it, and an agent that cannot list any workflow cannot
      // find the healthy ones either. The broken one is reported as broken.
      try {
        const resolved = resolveWorkflow(ctx, slug);
        return {
          slug,
          name: resolved.name,
          layers: resolved.layers.map((l) => l.scope),
          steps: resolved.steps.length,
          standalone: resolved.standalone,
          uses: resolved.expanded.filter((e) => e.depth === 1).map((e) => e.slug),
        };
      } catch (err) {
        const unexpanded = (() => {
          try {
            return resolveWorkflow(ctx, slug, { expand: false });
          } catch {
            return null;
          }
        })();
        return {
          slug,
          name: unexpanded?.name ?? slug,
          layers: unexpanded?.layers.map((l) => l.scope) ?? [],
          steps: unexpanded?.steps.length ?? 0,
          standalone: unexpanded?.standalone ?? true,
          uses: [],
          error: err instanceof MyJarbisError ? err.message : String(err),
        };
      }
    });
}
