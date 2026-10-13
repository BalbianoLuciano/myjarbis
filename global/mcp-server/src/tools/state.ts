/**
 * project_state — the living "resume here", as one row.
 *
 * Each session used to record where things stood by saving a brand new
 * observation titled "RESUME HERE", so the current state was whichever of N
 * notes happened to be newest. One real project had three such notes that
 * were all the same note, overwriting each other in intent but not in fact,
 * and the agent then had to guess which one was live. Titles like
 * "DEFINITIVE — supersedes notes 80 and 81" are the symptom.
 *
 * A single row that gets overwritten makes "current" unambiguous. History,
 * where it matters, is what observations are for.
 *
 * The lock is advisory and expires. One real next_session line read: "IF
 * ANOTHER SESSION IS OPEN: ask it what it ran before touching the tracker or
 * git" — a concurrency problem being managed by leaving a note for a human.
 * A lock with a TTL turns that into something the second session can see.
 */

import { z } from 'zod';
import { ServerContext } from '../context.js';
import { MyJarbisError, ErrorType } from '../types.js';

/** How long a held lock is believed, in seconds. Past this the holder is
 *  assumed dead: a lock with no expiry wedges the project shut the first
 *  time a process is killed, and the user has no way to tell a crashed
 *  session from a busy one. */
export const DEFAULT_LOCK_TTL_SECONDS = 900;

// ─────────────────────────────────────────────────────────────────────
// get_project_state
// ─────────────────────────────────────────────────────────────────────

export const getProjectStateInputSchema = {
  type: 'object' as const,
  properties: {},
};

export interface GetProjectStateResult {
  content: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
  lock: { heldBy: string; since: string; stale: boolean } | null;
  hint: string;
}

export function getProjectState(ctx: ServerContext): GetProjectStateResult {
  const project = ctx.requireProject();
  const row = ctx.db.projectState.get(project.id);

  if (!row) {
    return {
      content: null,
      updatedAt: null,
      updatedBy: null,
      lock: null,
      hint:
        'No living state recorded yet. Call set_project_state with where the ' +
        'work stands, so the next session does not have to reconstruct it.',
    };
  }

  let lock: GetProjectStateResult['lock'] = null;
  if (row.locked_by && row.locked_at) {
    const ageSeconds = Math.max(
      0,
      Math.floor((Date.now() - new Date(row.locked_at.replace(' ', 'T') + 'Z').getTime()) / 1000),
    );
    lock = {
      heldBy: row.locked_by,
      since: row.locked_at,
      stale: ageSeconds >= DEFAULT_LOCK_TTL_SECONDS,
    };
  }

  return {
    content: row.content || null,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
    lock,
    hint:
      lock && !lock.stale
        ? `Another session (${lock.heldBy}) is holding the state lock since ${lock.since}. ` +
          'Ask the user what that session has already done before touching shared ' +
          'resources, and do not overwrite the state without saying so.'
        : 'This is the current state. Overwrite it when it changes rather than ' +
          'adding a second note about the same thing.',
  };
}

// ─────────────────────────────────────────────────────────────────────
// set_project_state
// ─────────────────────────────────────────────────────────────────────

export const setProjectStateInputSchema = {
  type: 'object' as const,
  properties: {
    content: {
      type: 'string' as const,
      description:
        'Where the work stands and what the next action is. This REPLACES the ' +
        'previous state — write the whole picture, not a delta.',
    },
    session_tag: {
      type: 'string' as const,
      description:
        'Optional identifier for this session, used for the advisory lock so a ' +
        'second session can tell who is writing.',
    },
    force: {
      type: 'boolean' as const,
      description:
        'Write even though another session holds a live lock. Default false.',
    },
  },
  required: ['content'],
};

const setProjectStateArgsZ = z
  .object({
    content: z.string().min(1),
    session_tag: z.string().min(1).max(100).optional(),
    force: z.boolean().optional(),
  })
  .strict();

export interface SetProjectStateResult {
  updatedAt: string;
  updatedBy: string | null;
  previousLength: number | null;
  hint?: string;
}

export function setProjectState(
  ctx: ServerContext,
  rawArgs: unknown,
): SetProjectStateResult {
  const args = setProjectStateArgsZ.parse(rawArgs);
  const project = ctx.requireProject();
  const tag = args.session_tag ?? `session-${ctx.activeSessionId ?? 'adhoc'}`;

  const before = ctx.db.projectState.get(project.id);

  // Take the lock first, so a concurrent writer is detected rather than
  // discovered afterwards by the state being wrong.
  const lock = ctx.db.projectState.lock({
    projectId: project.id,
    sessionTag: tag,
    ttlSeconds: DEFAULT_LOCK_TTL_SECONDS,
  });

  if (!lock.acquired && !args.force) {
    throw new MyJarbisError(
      ErrorType.STATE_LOCKED,
      `Session "${lock.heldBy}" has held the project state lock since ${lock.heldSince}. ` +
        'Find out what it has already done before overwriting, or pass force=true ' +
        'if you know it is gone.',
      { heldBy: lock.heldBy, heldSince: lock.heldSince },
    );
  }

  const row = ctx.db.projectState.set({
    projectId: project.id,
    content: args.content,
    updatedBy: tag,
  });
  // Clear the lock we took. When we overrode someone else's, clear theirs
  // too: leaving it behind would make every later writer believe a session
  // that is already gone is still working.
  ctx.db.projectState.unlock(project.id, tag, !lock.acquired);

  return {
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
    previousLength: before?.content ? before.content.length : null,
    hint:
      !lock.acquired && args.force
        ? `Overwrote the state while "${lock.heldBy}" held the lock, because force=true.`
        : undefined,
  };
}
