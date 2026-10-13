/**
 * Closing a session without being asked.
 *
 * `sessions.summary` came back NULL on 2 of 2 sessions in one real project
 * and 2 of 10 in another. A session that never closes costs more than a
 * missing paragraph: `resume` returns nothing, `list_modules` reports
 * `hasNextSession: false` and `lastSessionEndedAt: null` for every module,
 * and the signal the agent uses to pick up where it left off — or even to
 * choose which module to open — is simply absent. This repository's own
 * brain is in that state: five modules, three sessions, none closed.
 *
 * The previous mitigation was a Stop hook that printed a reminder for the
 * agent to call end_session. That is the wrong layer. MyJarbis is installed
 * ON TOP of Claude Code precisely so that this kind of bookkeeping is not
 * left to whether the agent remembered, so the close happens here, in code,
 * by default.
 *
 * It runs from two places, deliberately:
 *
 *   1. the SessionEnd hook, which fires when the session actually ends
 *      (NOT the Stop hook — Stop fires after every single turn)
 *   2. start_session, which closes any session still open in that module
 *      before opening a new one
 *
 * (2) exists because (1) cannot be relied on. A killed terminal, a crashed
 * process, a machine that reboots — no hook fires for any of those. Closing
 * retroactively on the next open means the guarantee holds regardless.
 *
 * A generated summary is always LABELLED as generated. A synthetic
 * "resume here" that reads like a curated one is worse than none, because
 * the next session would follow it as an instruction rather than reading it
 * as a trace of what happened.
 */

import { execFileSync } from 'child_process';
import { ServerContext } from '../context.js';
import { ObservationRow, SessionRow } from '../db/schema.js';

/** Marks a summary or next_session as machine-written. */
export const AUTO_MARKER = '[auto]';

export interface AutoCloseResult {
  sessionId: number;
  module: string;
  observations: number;
  durationMinutes: number;
  summary: string;
  nextSession: string;
  /** Where the "resume here" text came from. */
  nextSessionSource: 'project_state' | 'progress_note' | 'latest_note' | 'none';
}

/** Minutes between a stored timestamp and now. */
function minutesSince(sqlTimestamp: string): number {
  const started = new Date(`${sqlTimestamp.replace(' ', 'T')}Z`).getTime();
  if (!Number.isFinite(started)) return 0;
  return Math.max(0, Math.round((Date.now() - started) / 60000));
}

/** Commit subjects made in the project since `sqlTimestamp`. */
function commitsSince(projectPath: string, sqlTimestamp: string): string[] {
  try {
    const out = execFileSync(
      'git',
      ['log', '--since', `${sqlTimestamp} UTC`, '--format=%s', '--no-merges', '-20'],
      { cwd: projectPath, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return out
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    // Not a repo, or git unavailable. The summary is just less specific.
    return [];
  }
}

function truncate(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length <= n ? one : `${one.slice(0, n - 1)}…`;
}

/**
 * Build a summary out of what the session actually did.
 *
 * Only facts: how long, what was saved, what was committed. It does not
 * attempt to characterise the work, because guessing at intent is how a
 * generated note ends up misleading.
 */
export function composeSummary(params: {
  moduleName: string;
  session: SessionRow;
  observations: ObservationRow[];
  commits: string[];
}): string {
  const { moduleName, session, observations, commits } = params;
  const mins = minutesSince(session.started_at);
  const duration = mins >= 60 ? `${Math.floor(mins / 60)}h${mins % 60}m` : `${mins}m`;

  const lines: string[] = [
    `${AUTO_MARKER} Session closed automatically on exit (the agent did not call ` +
      `end_session, so this is a record of activity rather than a written summary).`,
    '',
    `Module: ${moduleName} · open for ${duration} · ${observations.length} ` +
      `observation${observations.length === 1 ? '' : 's'} saved.`,
  ];

  if (observations.length > 0) {
    const byKind = new Map<string, number>();
    for (const o of observations) byKind.set(o.kind, (byKind.get(o.kind) ?? 0) + 1);
    lines.push(
      '',
      'Saved: ' +
        [...byKind.entries()].map(([k, n]) => `${n} ${k}`).join(', ') +
        '.',
    );
    for (const o of observations.slice(-6)) {
      lines.push(`  · ${o.kind}: ${truncate(o.title, 90)}`);
    }
  }

  if (commits.length > 0) {
    lines.push('', `Commits during the session (${commits.length}):`);
    for (const c of commits.slice(0, 6)) lines.push(`  · ${truncate(c, 90)}`);
  }

  if (observations.length === 0 && commits.length === 0) {
    lines.push(
      '',
      'Nothing was recorded and nothing was committed — most likely a session ' +
        'that was opened and closed without work, or work that was never saved.',
    );
  }

  return lines.join('\n');
}

/**
 * Pick the best available "resume here".
 *
 * project_state first: it is the one field whose entire purpose is to say
 * where things stand, and if it is set it was written on purpose. The note
 * fallbacks are a trace, and say so.
 */
export function composeNextSession(params: {
  projectState: string | null;
  observations: ObservationRow[];
}): { text: string; source: AutoCloseResult['nextSessionSource'] } {
  const { projectState, observations } = params;

  if (projectState && projectState.trim()) {
    return {
      text:
        `${AUTO_MARKER} Taken from the project's living state, which was set ` +
        `deliberately — treat it as current:\n\n${projectState.trim()}`,
      source: 'project_state',
    };
  }

  const progress = [...observations].reverse().find((o) => o.kind === 'progress');
  if (progress) {
    return {
      text:
        `${AUTO_MARKER} No living state was set. The last progress note was:\n\n` +
        `${truncate(progress.title, 120)}\n\n` +
        `Read observation ${progress.id} in full, and confirm with the user where ` +
        `things actually stand before continuing — this was not written as an ` +
        `instruction for you.`,
      source: 'progress_note',
    };
  }

  const latest = observations[observations.length - 1];
  if (latest) {
    return {
      text:
        `${AUTO_MARKER} No living state and no progress note. The last thing ` +
        `recorded was:\n\n${latest.kind}: ${truncate(latest.title, 120)}\n\n` +
        `Ask the user what they were doing; do not infer a plan from this.`,
      source: 'latest_note',
    };
  }

  return {
    text:
      `${AUTO_MARKER} The previous session closed with nothing recorded. There is ` +
      `no resume point — ask the user what they want to work on.`,
    source: 'none',
  };
}

/**
 * Close one open session, writing a generated summary and next_session.
 *
 * Returns null when the session has no module we can resolve, which would
 * leave the summary meaningless.
 */
export function autoCloseSession(
  ctx: ServerContext,
  session: SessionRow,
): AutoCloseResult | null {
  const project = ctx.requireProject();
  const moduleRow = ctx.db.modules.findById(session.module_id);
  if (!moduleRow) return null;

  const observations = ctx.db.observations.listBySession(session.id);
  const commits = commitsSince(ctx.projectPath, session.started_at);
  const state = ctx.db.projectState.get(project.id);

  const summary = composeSummary({
    moduleName: moduleRow.name,
    session,
    observations,
    commits,
  });
  const next = composeNextSession({
    projectState: state?.content ?? null,
    observations,
  });

  ctx.db.sessions.end(session.id, summary, next.text);

  return {
    sessionId: session.id,
    module: moduleRow.name,
    observations: observations.length,
    durationMinutes: minutesSince(session.started_at),
    summary,
    nextSession: next.text,
    nextSessionSource: next.source,
  };
}

/**
 * Close every session still open in this project.
 *
 * Used by the SessionEnd hook. More than one can be open when sessions were
 * started in different modules and never closed — which, without this, is
 * exactly how they accumulate.
 */
export function autoCloseAll(ctx: ServerContext): AutoCloseResult[] {
  const project = ctx.project;
  if (!project) return [];

  const results: AutoCloseResult[] = [];
  for (const session of ctx.db.sessions.listOpenByProject(project.id)) {
    const r = autoCloseSession(ctx, session);
    if (r) results.push(r);
  }
  return results;
}

/**
 * Close a stale open session in ONE module, before a new one opens there.
 *
 * The safety net for every case where no hook fires: a killed terminal, a
 * crash, a reboot. Without it the guarantee depends on a clean exit, and a
 * guarantee that depends on a clean exit is not one.
 */
export function autoCloseStaleInModule(
  ctx: ServerContext,
  moduleId: number,
): AutoCloseResult | null {
  const open = ctx.db.sessions.findActiveByModule(moduleId);
  if (!open) return null;
  return autoCloseSession(ctx, open);
}
