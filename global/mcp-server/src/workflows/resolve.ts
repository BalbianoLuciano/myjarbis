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
 */

import { ServerContext } from '../context.js';
import { MyJarbisError, ErrorType } from '../types.js';
import { WorkflowRow, WorkflowStepRow, ProviderRole } from '../db/schema.js';
import { evaluateCondition, ConditionFacts, EvalResult } from './condition.js';

export interface ResolvedStep {
  position: number;
  name: string;
  actor: string;
  gate: 'none' | 'approve' | 'on-request';
  capability: string | null;
  condition: string | null;
  notes: string | null;
  /** Which layer this step's final definition came from. */
  from: 'org' | 'project' | 'user';
  /** The concrete provider behind `capability`, when the role is configured. */
  provider?: { role: string; kind: string } | null;
  /** Present when the step has a condition and facts were supplied. */
  applies?: boolean;
  why?: EvalResult['detail'];
}

export interface ResolvedWorkflow {
  slug: string;
  name: string;
  layers: Array<{ scope: 'org' | 'project' | 'user'; scopeId: number; steps: number }>;
  steps: ResolvedStep[];
  /** Inherited steps switched off by a more specific layer. */
  suppressed: Array<{ name: string; disabledBy: 'org' | 'project' | 'user' }>;
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
  opts: { facts?: ConditionFacts } = {},
): ResolvedWorkflow {
  const project = ctx.requireProject();
  const layers = ctx.db.workflows.layersFor(slug, project.id, project.org_id);

  if (layers.length === 0) {
    const available = ctx.db.workflows.listSlugs(project.id, project.org_id);
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

  for (const layer of layers) {
    const steps = stepsOf(ctx, layer);
    layerInfo.push({ scope: layer.scope, scopeId: layer.scope_id, steps: steps.length });
    displayName = layer.name || displayName;

    for (const s of steps) {
      if (s.disabled === 1) {
        // Switch off an inherited step. Recorded rather than dropped
        // silently: "why did this step vanish" is otherwise unanswerable.
        byName.delete(s.name);
        suppressed.push({ name: s.name, disabledBy: layer.scope });
        continue;
      }
      byName.set(s.name, {
        position: s.position,
        name: s.name,
        actor: s.actor,
        gate: s.gate,
        capability: s.capability,
        condition: s.condition,
        notes: s.notes,
        from: layer.scope,
      });
    }
  }

  const steps = [...byName.values()].sort(
    (a, b) => a.position - b.position || (a.name < b.name ? -1 : 1),
  );

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
    layers: layerInfo,
    steps,
    suppressed,
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

/** Every workflow slug reachable from the current project. */
export function listWorkflows(ctx: ServerContext): Array<{
  slug: string;
  name: string;
  layers: string[];
  steps: number;
}> {
  const project = ctx.requireProject();
  return ctx.db.workflows.listSlugs(project.id, project.org_id).map((slug) => {
    const resolved = resolveWorkflow(ctx, slug);
    return {
      slug,
      name: resolved.name,
      layers: resolved.layers.map((l) => l.scope),
      steps: resolved.steps.length,
    };
  });
}
