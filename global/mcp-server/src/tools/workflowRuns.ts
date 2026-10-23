/**
 * Running a workflow, as opposed to reading one.
 *
 * `get_workflow` has always answered "what is the process". It has never been
 * able to answer "where was I in it" — that answer lived in whatever prose the
 * agent happened to write into `next_session`, which is the same failure the
 * workflows table was built to end, one level up: process state as a document
 * somebody reinterprets.
 *
 * A run is a SNAPSHOT of a resolution. Steps are stored by name together with
 * the workflow that owned them, because the resolution itself has no row: it
 * is computed from three layers plus any `uses` expansion, and it can
 * legitimately change while a ritual is half done. A run holding step ids would
 * quietly re-point at a different process.
 *
 * Why this matters beyond tidiness: a compaction keeps roughly none of the
 * commands an agent ran. Measured elsewhere on a comparable system, an agent's
 * own summary retained 77% of its decisions and 0.2% of its commands. "I have
 * done steps one through four" is exactly the kind of sentence that does not
 * survive, and it is the kind a row survives perfectly.
 */

import { z } from 'zod';
import { ServerContext } from '../context.js';
import { MyJarbisError, ErrorType } from '../types.js';
// AUTO_MARKER from its own home rather than re-exported through autoClose:
// autoClose imports the reconciliation below, and taking the constant from
// there would close a cycle between the two modules for a string.
import { WorkflowRunStepRow, AUTO_MARKER } from '../db/schema.js';
import { resolveWorkflow, gatherFacts } from '../workflows/resolve.js';

// ─────────────────────────────────────────────────────────────────────
// start_workflow_run
// ─────────────────────────────────────────────────────────────────────

export const startWorkflowRunInputSchema = {
  type: 'object' as const,
  properties: {
    slug: { type: 'string' as const, description: 'The workflow to start.' },
    session_id: {
      type: 'number' as const,
      description: 'Defaults to the active session. The run is abandoned if it dies.',
    },
  },
  required: ['slug'],
};

const startArgsZ = z
  .object({ slug: z.string().min(1).max(60), session_id: z.number().int().positive().optional() })
  .strict();

export interface WorkflowRunView {
  runId: number;
  slug: string;
  status: string;
  startedAt: string;
  steps: Array<{
    order: number;
    name: string;
    fromWorkflow: string;
    status: string;
    actor: string | null;
    note: string | null;
    seconds: number | null;
  }>;
  current: { name: string; fromWorkflow: string; actor: string | null } | null;
  totalSeconds: number;
  display: string;
  hint: string;
}

/** Rendered here for the same reason the module menu is: it is read at a
 *  decision point, and an agent rebuilding it spends tokens to produce
 *  something less consistent. */
function renderRun(view: Omit<WorkflowRunView, 'display' | 'hint'>): string {
  const mark: Record<string, string> = {
    done: '[x]',
    skipped: '[~]',
    blocked: '[!]',
    active: '[>]',
    pending: '[ ]',
  };
  const lines = [`workflow ${view.slug} · run #${view.runId} · ${view.status}`, ''];
  for (const s of view.steps) {
    const time = s.seconds === null ? '' : `  ${Math.round(s.seconds / 60)}m`;
    lines.push(`  ${mark[s.status] ?? '[ ]'} ${s.name}${time}`);
    if (s.note) lines.push(`        ${s.note}`);
  }
  if (view.totalSeconds > 0) {
    lines.push('', `  ${Math.round(view.totalSeconds / 60)}m recorded so far`);
  }
  return lines.join('\n');
}

function viewOf(ctx: ServerContext, runId: number): WorkflowRunView {
  const run = ctx.db.workflowRuns.findById(runId)!;
  const timings = ctx.db.workflowRunSteps.timings(runId);
  const rows = ctx.db.workflowRunSteps.listByRun(runId);
  const secondsByName = new Map(timings.map((t) => [t.stepName, t.seconds]));

  const steps = rows.map((r: WorkflowRunStepRow, i: number) => ({
    order: i + 1,
    name: r.step_name,
    fromWorkflow: r.from_workflow,
    status: r.status,
    actor: r.actor,
    note: r.note,
    seconds: secondsByName.get(r.step_name) ?? null,
  }));
  const cur = ctx.db.workflowRunSteps.current(runId);
  const totalSeconds = steps.reduce((acc, s) => acc + (s.seconds ?? 0), 0);

  const base = {
    runId,
    slug: run.slug,
    status: run.status,
    startedAt: run.started_at,
    steps,
    current: cur
      ? { name: cur.step_name, fromWorkflow: cur.from_workflow, actor: cur.actor }
      : null,
    totalSeconds,
  };

  const remaining = steps.filter((s) => s.status === 'pending' || s.status === 'active').length;
  return {
    ...base,
    display: renderRun(base),
    hint: cur
      ? `Next: "${cur.step_name}"${
          cur.from_workflow !== run.slug ? ` (from ${cur.from_workflow})` : ''
        }. Call advance_workflow_step when it is done, or with status "skipped" ` +
        'and a reason if it does not apply here.'
      : remaining === 0
        ? 'Every step is accounted for. close_workflow_run records the ritual as done.'
        : 'No step is active. close_workflow_run, or advance one by name.',
  };
}

export function startWorkflowRun(ctx: ServerContext, rawArgs: unknown): WorkflowRunView {
  const args = startArgsZ.parse(rawArgs);
  const project = ctx.requireProject();

  // Clean up before refusing, or a run left behind by a dead session makes
  // every later ritual unstartable.
  reconcileOrphanedRuns(ctx);

  const existing = ctx.db.workflowRuns.findOpen(project.id, args.slug);
  if (existing) {
    // The refusal IS the resumability contract: asking to start something
    // already in progress is answered with where it got to, not with a second
    // run that splits the history in two.
    const view = viewOf(ctx, existing.id);
    return {
      ...view,
      hint:
        `This ritual is already in progress (run #${existing.id}, started ` +
        `${existing.started_at}). ${view.hint}`,
    };
  }

  const facts = gatherFacts(ctx);
  const resolved = resolveWorkflow(ctx, args.slug, { facts });

  // Only the steps that apply are snapshotted. A run holding steps that were
  // never going to run would report a ritual as incomplete forever, and the
  // condition was already evaluated against this branch and these providers.
  const applicable = resolved.steps.filter((s) => s.applies !== false);
  if (applicable.length === 0) {
    throw new MyJarbisError(
      ErrorType.INVALID_INPUT,
      `No step of "${args.slug}" applies here, so there is nothing to run. ` +
        `Conditions were evaluated against branch "${facts.branch ?? 'none'}" ` +
        `and module "${facts.module ?? 'none'}".`,
      { slug: args.slug, facts },
    );
  }

  const sessionId = args.session_id ?? ctx.activeSessionId ?? null;
  const { run } = ctx.db.workflowRuns.open({
    projectId: project.id,
    slug: args.slug,
    sessionId,
    steps: applicable.map((s) => ({
      position: s.order,
      name: s.name,
      fromWorkflow: s.fromWorkflow,
      actor: s.actor,
    })),
  });

  return viewOf(ctx, run.id);
}

// ─────────────────────────────────────────────────────────────────────
// advance_workflow_step
// ─────────────────────────────────────────────────────────────────────

export const advanceWorkflowStepInputSchema = {
  type: 'object' as const,
  properties: {
    run_id: { type: 'number' as const, description: 'Defaults to the open run of this project.' },
    step_name: {
      type: 'string' as const,
      description: 'Defaults to the step currently active. Namespaced names are fine here.',
    },
    status: {
      type: 'string' as const,
      enum: ['done', 'skipped', 'blocked'],
      description:
        'Default "done". "skipped" REQUIRES a note — a log that records what was ' +
        'skipped without why cannot be read later. "blocked" means it needs the ' +
        'user and could not proceed.',
    },
    note: { type: 'string' as const, description: 'Why, for skipped and blocked.' },
    actor: { type: 'string' as const, description: 'Who did it, when not the agent.' },
  },
};

const advanceArgsZ = z
  .object({
    run_id: z.number().int().positive().optional(),
    step_name: z.string().min(1).max(130).optional(),
    status: z.enum(['done', 'skipped', 'blocked']).optional(),
    note: z.string().min(1).max(500).optional(),
    actor: z.string().min(1).max(40).optional(),
  })
  .strict();

export function advanceWorkflowStep(ctx: ServerContext, rawArgs: unknown): WorkflowRunView {
  const args = advanceArgsZ.parse(rawArgs ?? {});
  const project = ctx.requireProject();

  const runId = args.run_id ?? ctx.db.workflowRuns.findOpen(project.id)?.id;
  if (runId === undefined) {
    throw new MyJarbisError(
      ErrorType.RESOURCE_NOT_FOUND,
      'No workflow run is open in this project. start_workflow_run first.',
    );
  }

  const stepName = args.step_name ?? ctx.db.workflowRunSteps.current(runId)?.step_name;
  if (stepName === undefined) {
    throw new MyJarbisError(
      ErrorType.INVALID_INPUT,
      `Run #${runId} has no active step, so there is nothing to advance. Name the ` +
        'step explicitly, or close the run.',
    );
  }

  ctx.db.workflowRunSteps.advance({
    runId,
    stepName,
    status: args.status ?? 'done',
    note: args.note,
    actor: args.actor,
  });

  return viewOf(ctx, runId);
}

// ─────────────────────────────────────────────────────────────────────
// close_workflow_run
// ─────────────────────────────────────────────────────────────────────

export const closeWorkflowRunInputSchema = {
  type: 'object' as const,
  properties: {
    run_id: { type: 'number' as const, description: 'Defaults to the open run.' },
    status: {
      type: 'string' as const,
      enum: ['done', 'abandoned'],
      description:
        'Default "done", which is refused while steps are unfinished. ' +
        '"abandoned" is always allowed and is the honest answer when the ritual ' +
        'was not completed.',
    },
  },
};

const closeArgsZ = z
  .object({
    run_id: z.number().int().positive().optional(),
    status: z.enum(['done', 'abandoned']).optional(),
  })
  .strict();

export function closeWorkflowRun(ctx: ServerContext, rawArgs: unknown): WorkflowRunView {
  const args = closeArgsZ.parse(rawArgs ?? {});
  const project = ctx.requireProject();

  const runId = args.run_id ?? ctx.db.workflowRuns.findOpen(project.id)?.id;
  if (runId === undefined) {
    throw new MyJarbisError(
      ErrorType.RESOURCE_NOT_FOUND,
      'No workflow run is open in this project.',
    );
  }
  const status = args.status ?? 'done';

  if (status === 'done') {
    const unfinished = ctx.db.workflowRunSteps
      .listByRun(runId)
      .filter((s) => s.status === 'pending' || s.status === 'active');
    if (unfinished.length > 0) {
      // Refused rather than fudged. A ritual recorded as done with steps
      // nobody did is worse than one recorded as abandoned, because the
      // record is what a later reader trusts.
      throw new MyJarbisError(
        ErrorType.INVALID_INPUT,
        `Run #${runId} still has ${unfinished.length} unfinished step(s): ` +
          `${unfinished.map((s) => s.step_name).join(', ')}. Advance or skip them, ` +
          'or close with status "abandoned", which is the honest record.',
        { unfinished: unfinished.map((s) => s.step_name) },
      );
    }
  }

  ctx.db.workflowRuns.close(runId, status);
  return viewOf(ctx, runId);
}

// ─────────────────────────────────────────────────────────────────────
// get_workflow_run
// ─────────────────────────────────────────────────────────────────────

export const getWorkflowRunInputSchema = {
  type: 'object' as const,
  properties: {
    run_id: { type: 'number' as const, description: 'Defaults to the open run of this project.' },
  },
};

export function getWorkflowRun(ctx: ServerContext, rawArgs: unknown): WorkflowRunView | null {
  const args = z
    .object({ run_id: z.number().int().positive().optional() })
    .strict()
    .parse(rawArgs ?? {});
  const project = ctx.requireProject();
  const runId = args.run_id ?? ctx.db.workflowRuns.findOpen(project.id)?.id;
  if (runId === undefined) return null;
  return viewOf(ctx, runId);
}

// ─────────────────────────────────────────────────────────────────────
// Reconciliation
// ─────────────────────────────────────────────────────────────────────

/**
 * Close runs whose session is gone, marking the step they died on.
 *
 * The session dying is the ordinary way a ritual ends unfinished: the editor
 * was closed, the machine slept, a hook closed the session. Left alone, the
 * run stays 'open' forever and the next `start_workflow_run` answers "already
 * in progress" to a ritual nobody is running — a wedged process rather than a
 * recorded one.
 *
 * Marked with the same `[auto]` marker the synthetic session close uses. One
 * marker meaning "a machine wrote this, read it as a trace and not as intent"
 * is worth more than two conventions for the same thing.
 */
export function reconcileOrphanedRuns(ctx: ServerContext): number {
  const project = ctx.requireProject();
  let closed = 0;
  for (const run of ctx.db.workflowRuns.listOrphaned(project.id)) {
    const active = ctx.db.workflowRunSteps.current(run.id);
    if (active) {
      ctx.db.db
        .prepare(
          `UPDATE workflow_run_steps
              SET status = 'blocked', completed_at = datetime('now'),
                  note = COALESCE(note, ?)
            WHERE id = ?`,
        )
        .run(`${AUTO_MARKER} the session closed without completing this step`, active.id);
    }
    ctx.db.workflowRuns.close(run.id, 'abandoned');
    closed++;
  }
  return closed;
}

/** Same, for one session, called from the auto-close path. */
export function reconcileRunsForSession(ctx: ServerContext, sessionId: number): number {
  const project = ctx.requireProject();
  let closed = 0;
  for (const run of ctx.db.workflowRuns.listByProject(project.id, { status: ['open'] })) {
    if (run.session_id !== sessionId) continue;
    const active = ctx.db.workflowRunSteps.current(run.id);
    if (active) {
      ctx.db.db
        .prepare(
          `UPDATE workflow_run_steps
              SET status = 'blocked', completed_at = datetime('now'),
                  note = COALESCE(note, ?)
            WHERE id = ?`,
        )
        .run(`${AUTO_MARKER} the session closed without completing this step`, active.id);
    }
    ctx.db.workflowRuns.close(run.id, 'abandoned');
    closed++;
  }
  return closed;
}
