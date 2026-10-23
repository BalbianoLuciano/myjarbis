/**
 * The workflows every project starts with.
 *
 * Shipped rather than left empty, and the reason is the state this subsystem
 * was found in: built in v0.3, tested, documented — and holding zero rows in
 * every brain that exists, including its author's. `health.ts` exists partly to
 * shame features with no adoption; a composition feature with no data is a
 * composition feature in which nobody will ever find a bug.
 *
 * They are also the fixture the composition tests want: `session-close` uses
 * `commit-ritual`, `commit-ritual` uses `pre-push-checks`, and
 * `branch-per-session` uses it too. That is a three-level chain and one shared
 * child, with real content rather than a `foo → bar` invention.
 *
 * SCOPE IS 'project', not 'org'. Every project on this machine has
 * `org_id = NULL`, so an org-scope baseline would be unreachable from all of
 * them — which is exactly the mistake that left `examples/pack` as the only
 * workflow definition in the repository for two releases.
 *
 * The content is this repository's own conventions, taken from
 * `docs/CONVENTIONS.md` and the close ritual. A baseline that described a
 * generic process would be the thing the convention documents warn about: a
 * rule justified by nothing, which ratifies whatever drift it meets.
 */

import { StepGate } from '../db/schema.js';

export interface BaselineWorkflowStep {
  name: string;
  actor: string;
  gate: StepGate;
  /** A child workflow to run here. Excludes `capability`. */
  uses?: string;
  capability?: string;
  condition?: string;
  notes: string;
}

export interface BaselineWorkflow {
  slug: string;
  name: string;
  /** False = a fragment, hidden from the list a user picks from. */
  standalone: boolean;
  steps: BaselineWorkflowStep[];
}

export const BASELINE_WORKFLOWS: BaselineWorkflow[] = [
  {
    slug: 'pre-push-checks',
    name: 'Before anything leaves this machine',
    // A fragment by design: two parents invoke it, and offering it on its own
    // would let somebody "run the checks" as if that were a unit of work.
    standalone: false,
    steps: [
      {
        name: 'run-the-suite',
        actor: 'agent',
        gate: 'none',
        capability: 'ci.run',
        notes:
          'Run the project suite and report the number. "The tests pass" without a ' +
          'count is a claim; a count is a fact. If you did not run them, say that ' +
          'instead of implying you did.',
      },
      {
        name: 'confirm-green',
        actor: 'human',
        gate: 'approve',
        notes:
          'Red suite, or a suite you could not run: stop and say so. Pushing over a ' +
          'failure is how the failure becomes somebody else\'s.',
      },
    ],
  },
  {
    slug: 'commit-ritual',
    name: 'Commit one logical change',
    standalone: true,
    steps: [
      {
        name: 'stage-by-name',
        actor: 'agent',
        gate: 'none',
        notes:
          'Name every path. Never `git add -A` or `git add .`: staging by pattern is ' +
          'how a secret, a build artefact or somebody else\'s half-finished edit gets ' +
          'committed by accident.',
      },
      {
        name: 'write-the-subject',
        actor: 'agent',
        gate: 'none',
        notes:
          '<type>(<scope>): <imperative>, 72 characters or fewer, no trailing period. ' +
          'type is feat | fix | refactor | chore | docs | test | perf | style.',
      },
      {
        name: 'write-the-body',
        actor: 'agent',
        gate: 'none',
        notes:
          'Why: the problem that triggered this. What for: what becomes possible or ' +
          'true afterwards. Where: the seam it lands in, when the change and its ' +
          'effect live apart — omit it rather than write filler. Never a ' +
          'Co-Authored-By trailer or any signature: the author is the user.',
      },
      {
        name: 'checks',
        actor: 'agent',
        gate: 'none',
        uses: 'pre-push-checks',
        notes: 'Nothing is pushed over a red or unrun suite.',
      },
      {
        name: 'push',
        actor: 'human',
        gate: 'approve',
        notes:
          'Ask first, every time. Never --no-verify and never --no-gpg-sign: a hook ' +
          'that fails is a thing to fix, not to bypass. No --amend after a push.',
      },
    ],
  },
  {
    slug: 'branch-per-session',
    name: 'Open and close a branch for this session',
    standalone: true,
    steps: [
      {
        name: 'confirm-the-base',
        actor: 'agent',
        gate: 'none',
        notes:
          'Check which branch the work starts from and that it is clean. A command ' +
          'or a document that assumes `main` is wrong about this repository if its ' +
          'default is `master` — read it rather than assuming either.',
      },
      {
        name: 'create-the-branch',
        actor: 'agent',
        gate: 'none',
        condition: 'branch != none',
        notes:
          '<type>/<what-the-session-is-about>, kebab-case. One branch per session — ' +
          'the set of things the session sets out to do, not one per commit. The ' +
          'point is being able to see what a session did as one unit, and to drop ' +
          'it as one unit if it turns out wrong.',
      },
      {
        name: 'merge-back',
        actor: 'human',
        gate: 'approve',
        notes:
          'Merged when the work is verified AND the user has tested it. Those are two ' +
          'conditions, and the second one is not yours to decide.',
      },
    ],
  },
  {
    slug: 'session-close',
    name: 'Close the session so the next one can start',
    standalone: true,
    steps: [
      {
        name: 'look-at-the-real-state',
        actor: 'agent',
        gate: 'none',
        notes:
          '`git status --short`, and whether the suite was run. Uncommitted work or a ' +
          'red suite: say so FIRST and ask whether to close anyway. The next startup ' +
          'has no way to find out on its own.',
      },
      {
        name: 'save-the-observations',
        actor: 'agent',
        gate: 'none',
        notes:
          'Every decision, gotcha and piece of progress not yet saved. Not one note ' +
          'per file touched — what would spare an hour to whoever opens this in three ' +
          'weeks. Anything with a current value rather than a history gets a ' +
          'topic_key, so it updates instead of competing.',
      },
      {
        name: 'commit-what-is-ready',
        actor: 'agent',
        gate: 'on-request',
        uses: 'commit-ritual',
        notes:
          'Only if the user asks. Closing is an act of memory, not of git.',
      },
      {
        name: 'write-the-living-state',
        actor: 'agent',
        gate: 'none',
        notes:
          '`set_project_state` REPLACES: write the whole picture, not a delta. Where ' +
          'the work stands, what is verified and what is not, the concrete next ' +
          'action, and what is already settled so it is not re-litigated.',
      },
      {
        name: 'offer-the-team-what-is-theirs',
        actor: 'agent',
        gate: 'on-request',
        notes:
          'When the project is in an org, `end_session` returns promotionProposals. ' +
          'Print it verbatim, ask, and promote only what the user confirms.',
      },
      {
        name: 'end-the-session',
        actor: 'agent',
        gate: 'none',
        notes:
          'summary: one to three retrospective bullets, no celebration. ' +
          'next_session: an ACTION — verb, path or branch, and the command to run. ' +
          'Anything left unverified belongs there; leaving it out is what makes the ' +
          'next session believe it was done.',
      },
    ],
  },
];
