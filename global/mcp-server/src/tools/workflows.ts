/**
 * MCP surface for workflows and providers.
 *
 * The agent asks "what is the process for closing a ticket" and gets one
 * ordered list back, instead of reading three prose documents and deciding
 * which applies. See workflows/resolve.ts for why that matters.
 */

import { z } from 'zod';
import { execFileSync } from 'child_process';
import { ServerContext } from '../context.js';
import { MyJarbisError, ErrorType } from '../types.js';
import { ProviderRole } from '../db/schema.js';
import { resolveWorkflow, listWorkflows, gatherFacts } from '../workflows/resolve.js';
import { assertCondition } from '../workflows/condition.js';
import { validateProviderConfig } from '../org/secrets.js';

const PROVIDER_ROLES = ['tracker', 'forge', 'ci'] as const;

/** Current git branch, so `branch` conditions can be evaluated. */
function currentBranch(cwd: string): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out && out !== 'HEAD' ? out : null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────
// list_workflows
// ─────────────────────────────────────────────────────────────────────

export const listWorkflowsInputSchema = { type: 'object' as const, properties: {} };

export function listWorkflowsTool(ctx: ServerContext): {
  workflows: Array<{
    slug: string;
    name: string;
    layers: string[];
    steps: number;
    standalone: boolean;
    uses: string[];
    error?: string;
  }>;
  broken?: Array<{ slug: string; error: string }>;
  hint: string;
} {
  const workflows = listWorkflows(ctx);
  const broken = workflows
    .filter((w) => w.error !== undefined)
    .map((w) => ({ slug: w.slug, error: w.error! }));
  return {
    workflows,
    broken: broken.length > 0 ? broken : undefined,
    hint:
      (workflows.length
        ? 'Call get_workflow(slug) for the resolved steps before starting that kind of work.'
        : 'No workflows reachable from this project. An org pack supplies them, or ' +
          'define project-level ones with set_workflow_step.') +
      (broken.length
        ? ` ${broken.length} workflow(s) do not resolve and are listed with their ` +
          'error: say so rather than treating them as missing.'
        : ''),
  };
}

// ─────────────────────────────────────────────────────────────────────
// get_workflow
// ─────────────────────────────────────────────────────────────────────

export const getWorkflowInputSchema = {
  type: 'object' as const,
  properties: {
    slug: { type: 'string' as const, description: 'e.g. "ticket-close".' },
    evaluate: {
      type: 'boolean' as const,
      description:
        'Default true: evaluate each step\'s condition against the current branch, ' +
        'module and configured providers, so you are told which steps apply now.',
    },
  },
  required: ['slug'],
};

const getWorkflowArgsZ = z
  .object({ slug: z.string().min(1), evaluate: z.boolean().optional() })
  .strict();

export function getWorkflow(ctx: ServerContext, rawArgs: unknown): unknown {
  const args = getWorkflowArgsZ.parse(rawArgs);
  const evaluate = args.evaluate !== false;

  const facts = evaluate
    ? gatherFacts(ctx, { branch: currentBranch(ctx.projectPath) })
    : undefined;

  const resolved = resolveWorkflow(ctx, args.slug, { facts });
  const applicable = resolved.steps.filter((s) => s.applies !== false);

  return {
    ...resolved,
    hint:
      `Resolved from ${resolved.layers.map((l) => l.scope).join(' → ')}. ` +
      (evaluate
        ? `${applicable.length} of ${resolved.steps.length} steps apply right now. ` +
          'A step with gate="approve" means stop and ask the user before doing it; ' +
          '"on-request" means only if they ask.'
        : 'Conditions were not evaluated.') +
      (resolved.suppressed.length
        ? ` Suppressed by a more specific layer: ${resolved.suppressed
            .map((s) => s.name)
            .join(', ')}.`
        : '') +
      (resolved.expanded.length
        ? ` Expanded ${resolved.expanded.length} child workflow(s): ${resolved.expanded
            .map((e) => e.slug)
            .join(', ')}. A step name with a "/" came from the workflow before ` +
          'the slash — the list is already flat and already in order, so do not ' +
          'go looking for the child. To change one of those steps, change it there.'
        : '') +
      (resolved.steps.length > 3
        ? ' More than three steps: open a run with start_workflow_run so "where was ' +
          'I" survives a compaction, and advance_workflow_step as each one completes.'
        : ''),
  };
}

// ─────────────────────────────────────────────────────────────────────
// set_workflow_step
// ─────────────────────────────────────────────────────────────────────

export const setWorkflowStepInputSchema = {
  type: 'object' as const,
  properties: {
    slug: { type: 'string' as const, description: 'Workflow to modify or create.' },
    name: {
      type: 'string' as const,
      description:
        'Step identity. Using an existing name at a more specific scope REPLACES ' +
        'that step; that is how overriding works.',
    },
    scope: {
      type: 'string' as const,
      enum: ['project', 'user'],
      description:
        'Which layer to write to. "project" applies to everyone on this project, ' +
        '"user" only to you. Org-scope steps come from a pack, not from here.',
    },
    position: { type: 'number' as const, description: 'Sort order. Defaults to the end.' },
    actor: { type: 'string' as const, description: 'agent | human | a role name.' },
    gate: {
      type: 'string' as const,
      enum: ['none', 'approve', 'on-request'],
      description: 'approve = stop and ask before this step.',
    },
    capability: {
      type: 'string' as const,
      description:
        'Abstract capability, e.g. "tracker.comment". NOT a product name — which ' +
        'tool it means comes from the project provider for that role.',
    },
    condition: {
      type: 'string' as const,
      description:
        'When this step applies, over branch/module/framework/tracker/forge/ci ' +
        'and has_* — e.g. "branch ~= release/* && has_tracker == true". Must be ' +
        'decidable; guidance belongs in notes.',
    },
    notes: { type: 'string' as const, description: 'Free-form guidance for this step.' },
    uses: {
      type: 'string' as const,
      description:
        'Slug of another workflow to run at this point, instead of doing ' +
        'something here. Mutually exclusive with `capability`: a step either ' +
        'delegates or acts. The child\'s steps arrive namespaced ' +
        '("child-slug/step-name") and keep being owned by the child, so they ' +
        'are overridden in the child and not from here.',
    },
    workflow_name: {
      type: 'string' as const,
      description:
        'Display name for the workflow, when creating it. Omit to inherit the ' +
        'name the broader layer already gave it.',
    },
    standalone: {
      type: 'boolean' as const,
      description:
        'Default true. False marks this workflow as a CHILD: hidden from the ' +
        'list of rituals a user picks from, still invocable from a parent.',
    },
    disabled: {
      type: 'boolean' as const,
      description: 'Switch off a step inherited from a broader layer.',
    },
  },
  required: ['slug', 'name', 'scope'],
};

const setWorkflowStepArgsZ = z
  .object({
    slug: z.string().min(1).max(60),
    name: z.string().min(1).max(60),
    scope: z.enum(['project', 'user']),
    position: z.number().int().optional(),
    actor: z.string().min(1).max(40).optional(),
    gate: z.enum(['none', 'approve', 'on-request']).optional(),
    capability: z.string().min(1).max(80).optional(),
    condition: z.string().min(1).max(300).optional(),
    notes: z.string().max(2000).optional(),
    uses: z.string().min(1).max(60).optional(),
    workflow_name: z.string().min(1).max(120).optional(),
    standalone: z.boolean().optional(),
    disabled: z.boolean().optional(),
  })
  .strict();

export function setWorkflowStep(ctx: ServerContext, rawArgs: unknown): unknown {
  const args = setWorkflowStepArgsZ.parse(rawArgs);
  const project = ctx.requireProject();

  if (args.condition) {
    assertCondition(args.condition, `step "${args.name}"`);
  }

  // A step either delegates or acts. Enforced here rather than as a CHECK
  // because SQLite cannot add a table-level constraint to an existing table,
  // and a constraint only new databases have is worse than one nobody has.
  if (args.uses && args.capability) {
    throw new MyJarbisError(
      ErrorType.INVALID_INPUT,
      `step "${args.name}" has both uses="${args.uses}" and capability=` +
        `"${args.capability}". A step either runs another workflow or does ` +
        'something itself, never both: split it into two steps.',
    );
  }
  if (args.uses === args.slug) {
    throw new MyJarbisError(
      ErrorType.INVALID_INPUT,
      `step "${args.name}" would make "${args.slug}" invoke itself.`,
    );
  }

  // A namespaced name is the RESOLVED name of a step that belongs to a child
  // workflow, not an address anybody can write to. Accepting it would create a
  // step literally called "commit-ritual/push" in the parent, which looks like
  // an override, resolves as a second unrelated step, and has to be found by
  // somebody wondering why their override does nothing.
  if (args.name.includes('/')) {
    throw new MyJarbisError(
      ErrorType.INVALID_INPUT,
      `"${args.name}" is a resolved name, not a writable one: the part before ` +
        `the slash is the workflow that owns the step. Override it there — ` +
        `set_workflow_step({ slug: "${args.name.split('/')[0]}", name: ` +
        `"${args.name.split('/').slice(1).join('/')}", ... }).`,
    );
  }

  // 'user' scope is keyed by project too: there is no user table, and a
  // per-user layer that leaked across projects would be worse than none.
  const scopeId = project.id;

  // The display name is INHERITED when not given.
  //
  // This used to be `name: args.slug` unconditionally, so adding one step at
  // project scope to an org workflow called "Closing a ticket (Acme)" silently
  // renamed it to "ticket-close" — the project layer is the more specific one,
  // and the resolver takes its name. The user saw their org's workflow lose
  // its name as a side effect of changing a gate.
  const existingLayers = ctx.db.workflows.layersFor(args.slug, project.id, ctx.db.scopedOrgId);
  const inheritedName = existingLayers[0]?.name;

  const wf = ctx.db.workflows.upsert({
    slug: args.slug,
    name: args.workflow_name ?? inheritedName ?? args.slug,
    scope: args.scope,
    scopeId,
    standalone: args.standalone,
  });

  // Position has to be inherited from the step being overridden, across
  // layers — not restarted per layer. Numbering from this layer's own step
  // count put an override of the org's third step at position 10, which
  // silently moved an approval gate ahead of the tests it was meant to
  // follow. For a workflow that is a correctness bug, not a cosmetic one.
  const sameLayer = ctx.db.workflowSteps.listByWorkflow(wf.id);
  let position = args.position ?? sameLayer.find((s) => s.name === args.name)?.position;

  if (position === undefined) {
    let inheritedMax = 0;
    for (const layer of ctx.db.workflows.layersFor(args.slug, project.id, ctx.db.scopedOrgId)) {
      for (const s of ctx.db.workflowSteps.listByWorkflow(layer.id)) {
        if (s.name === args.name && position === undefined) position = s.position;
        if (s.position > inheritedMax) inheritedMax = s.position;
      }
    }
    // A genuinely new step goes to the end of the RESOLVED list.
    position ??= inheritedMax + 10;
  }

  const step = ctx.db.workflowSteps.upsert({
    workflowId: wf.id,
    position,
    name: args.name,
    actor: args.actor ?? 'agent',
    gate: args.gate ?? 'none',
    capability: args.capability,
    uses: args.uses,
    condition: args.condition,
    notes: args.notes,
    disabled: args.disabled,
  });

  // The resolution is for the RESPONSE, not for validation, so it must not be
  // able to fail the write. Writing a step that invokes a workflow which does
  // not exist yet is the normal way a parent gets authored — you write the
  // ritual, then you write its parts — and throwing here made that impossible:
  // the row was already saved and the call reported an error anyway.
  //
  // The graph is checked where it is actually needed: at `get_workflow`, which
  // names the offending parent step, and at pack load, where the whole set of
  // slugs is known at once.
  let resolvedSteps: string[] = [];
  let unresolved: string | undefined;
  try {
    const resolved = resolveWorkflow(ctx, args.slug);
    resolvedSteps = resolved.steps.map((s) => `${s.order}:${s.name} (${s.from})`);
  } catch (err) {
    unresolved = err instanceof MyJarbisError ? err.message : String(err);
  }

  return {
    workflow: { slug: args.slug, scope: args.scope, id: wf.id },
    step: { id: step.id, name: step.name, position: step.position, gate: step.gate },
    resolvedSteps,
    hint:
      `Saved at ${args.scope} scope. user overrides project, project overrides org.` +
      (unresolved
        ? ` The step is stored, but the workflow does not resolve yet: ${unresolved}`
        : '') +
      (args.uses
        ? ` It invokes "${args.uses}", whose steps arrive namespaced as ` +
          `"${args.uses}/<step>" and are overridden in "${args.uses}", not here.`
        : ''),
  };
}

// ─────────────────────────────────────────────────────────────────────
// providers
// ─────────────────────────────────────────────────────────────────────

export const setProviderInputSchema = {
  type: 'object' as const,
  properties: {
    role: {
      type: 'string' as const,
      enum: [...PROVIDER_ROLES],
      description: 'Which role this tool fills for the project.',
    },
    kind: {
      type: 'string' as const,
      description: 'The provider\'s own name, as you refer to it.',
    },
    config: {
      type: 'string' as const,
      description:
        'JSON with the base URL, wrapper command and non-sensitive ids. NEVER a ' +
        'credential: this is included in the brain dump, which is meant to be ' +
        'committed. Store the location of a secret instead, e.g. ' +
        '{"token_file": "~/.config/x/token"}.',
    },
  },
  required: ['role', 'kind'],
};

const setProviderArgsZ = z
  .object({
    role: z.enum(PROVIDER_ROLES),
    kind: z.string().min(1).max(60),
    config: z.string().optional(),
  })
  .strict();

export function setProvider(ctx: ServerContext, rawArgs: unknown): unknown {
  const args = setProviderArgsZ.parse(rawArgs);
  const project = ctx.requireProject();

  const config = validateProviderConfig(args.config ?? null);
  const row = ctx.db.providers.upsert({
    projectId: project.id,
    role: args.role,
    kind: args.kind,
    config,
  });

  return {
    role: row.role,
    kind: row.kind,
    config: row.config ? JSON.parse(row.config) : null,
    hint:
      `Workflow steps with capability "${args.role}.*" now resolve to "${args.kind}". ` +
      'The workflow itself stays abstract, so it keeps working for a project on a ' +
      'different tool.',
  };
}

export const listProvidersInputSchema = { type: 'object' as const, properties: {} };

export function listProviders(ctx: ServerContext): unknown {
  const project = ctx.requireProject();
  const rows = ctx.db.providers.listByProject(project.id);
  return {
    providers: rows.map((r) => ({
      role: r.role,
      kind: r.kind,
      config: r.config ? JSON.parse(r.config) : null,
    })),
    missing: PROVIDER_ROLES.filter((r) => !rows.some((x) => x.role === r)),
    hint:
      'A step whose capability names an unconfigured role resolves with ' +
      'provider=null, which is the signal to ask the user rather than to guess.',
  };
}

export function requireProviderRole(role: string): ProviderRole {
  if (!(PROVIDER_ROLES as readonly string[]).includes(role)) {
    throw new MyJarbisError(
      ErrorType.INVALID_INPUT,
      `Unknown provider role "${role}". Expected one of ${PROVIDER_ROLES.join(', ')}.`,
    );
  }
  return role as ProviderRole;
}
