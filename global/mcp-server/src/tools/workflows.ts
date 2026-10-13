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
  workflows: Array<{ slug: string; name: string; layers: string[]; steps: number }>;
  hint: string;
} {
  const workflows = listWorkflows(ctx);
  return {
    workflows,
    hint: workflows.length
      ? 'Call get_workflow(slug) for the resolved steps before starting that kind of work.'
      : 'No workflows reachable from this project. An org pack supplies them, or ' +
        'define project-level ones with set_workflow_step.',
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
    disabled: z.boolean().optional(),
  })
  .strict();

export function setWorkflowStep(ctx: ServerContext, rawArgs: unknown): unknown {
  const args = setWorkflowStepArgsZ.parse(rawArgs);
  const project = ctx.requireProject();

  if (args.condition) {
    assertCondition(args.condition, `step "${args.name}"`);
  }

  // 'user' scope is keyed by project too: there is no user table, and a
  // per-user layer that leaked across projects would be worse than none.
  const scopeId = project.id;

  const wf = ctx.db.workflows.upsert({
    slug: args.slug,
    name: args.slug,
    scope: args.scope,
    scopeId,
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
    for (const layer of ctx.db.workflows.layersFor(args.slug, project.id, project.org_id)) {
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
    condition: args.condition,
    notes: args.notes,
    disabled: args.disabled,
  });

  const resolved = resolveWorkflow(ctx, args.slug);
  return {
    workflow: { slug: args.slug, scope: args.scope, id: wf.id },
    step: { id: step.id, name: step.name, position: step.position, gate: step.gate },
    resolvedSteps: resolved.steps.map((s) => `${s.position}:${s.name} (${s.from})`),
    hint: `Saved at ${args.scope} scope. user overrides project, project overrides org.`,
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
