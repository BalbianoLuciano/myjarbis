/**
 * Promotion: the one door from the personal memory into the org's.
 *
 * The door is deliberately narrow. `promote_observation` takes ONE observation
 * id and nothing else — there is no path that takes a session, a summary, a
 * handoff or a span of conversation, and there is no column on `org_notes` that
 * could hold one. "A conversation cannot leak into the team memory" is true
 * because of the shape of the schema and the shape of this signature, not
 * because of a setting somebody could flip.
 *
 * WHO DECIDES. The agent proposes and the user confirms. That split is not
 * politeness: SAP deployed this exact pipeline inside a large company and
 * reported that of 900 contributed learnings, 417 — 46.3% — yielded no memory
 * at all, almost all of them because the knowledge was already there. Roughly
 * half of everything offered should be refused, and an agent that promotes on
 * its own judgement is an agent filling a shared store with the half nobody
 * needed. The gate is also where the only honest review of wording happens.
 *
 * WHAT IS PROPOSED is decided in code, not by inference:
 *
 *   gotcha, error          always — these are what a team re-learns otherwise
 *   decision               only when it touches a convention or architecture
 *   progress, discovery    never proposed; promotable by explicit id
 *
 * A `progress` note is "story SHOP-S1.4 is done", which is true for exactly
 * one project on exactly one day. A `discovery` is usually a fact about this
 * codebase. Neither travels. The user can still promote either by naming its
 * id, because a rule that cannot be overridden is a rule that will be wrong
 * about something.
 */

import { z } from 'zod';
import { execFileSync } from 'child_process';
import { ServerContext } from '../context.js';
import { MyJarbisError, ErrorType } from '../types.js';
import { ObservationKind, ObservationRow, OrgNoteRow } from '../db/schema.js';
import { resolveIdentity, identityWarning } from '../org/identity.js';
import { scrubOrgNote, renderScrubFindings, ScrubFinding, ScrubContext } from '../org/scrub.js';
import { readRegistryRaw } from '../org/registry.js';

// ─────────────────────────────────────────────────────────────────────
// Which notes are worth offering
// ─────────────────────────────────────────────────────────────────────

/**
 * A `decision` is proposed only when its subject is something the whole team
 * is bound by. Matched on `topic_key` first, because that field exists exactly
 * to name a subject, and on tags second for notes written before topic keys
 * were a habit.
 */
const TEAM_WIDE_TOPIC_RE = /^(architecture|conventions?|process|stack|tooling|security)\//;
const TEAM_WIDE_TAG_RE = /\b(convention|architecture|adr|process|security)\b/i;

export type PromotionReason = 'gotcha' | 'error' | 'decision-convention' | 'asked-for';

/** Why this note is being offered, or null when it would not be. */
export function promotionReason(obs: ObservationRow): PromotionReason | null {
  if (obs.kind === 'gotcha') return 'gotcha';
  if (obs.kind === 'error') return 'error';
  if (obs.kind === 'decision') {
    if (obs.topic_key && TEAM_WIDE_TOPIC_RE.test(obs.topic_key)) return 'decision-convention';
    if (obs.tags && TEAM_WIDE_TAG_RE.test(obs.tags)) return 'decision-convention';
    return null;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────
// Deriving the draft
// ─────────────────────────────────────────────────────────────────────

const TYPE_TAG_BY_KIND: Record<ObservationKind, string> = {
  gotcha: 'gotcha',
  error: 'bug',
  decision: 'decision',
  discovery: 'learning',
  progress: 'learning',
};

export interface OrgNoteDraft {
  question: string;
  answer: string;
  workingExample?: string | null;
  caveats?: string | null;
  toolTags?: string | null;
  typeTags?: string | null;
  linkedIds?: string | null;
}

/**
 * The first draft, derived mechanically from the observation.
 *
 * `question` starts as the title because a title in this repo is already
 * written as a claim ("A backtick inside a node block is executed by bash"),
 * which is close to what somebody would search for. The agent is expected to
 * improve it — and `caveats`, which has no mechanical source at all, is the
 * field worth the most and the one it has to supply.
 */
export function draftFromObservation(obs: ObservationRow): OrgNoteDraft {
  return {
    question: obs.title,
    answer: obs.content,
    toolTags: obs.tags,
    typeTags: TYPE_TAG_BY_KIND[obs.kind],
  };
}

/** HEAD of the repo, for the drift baseline. Null outside a repository. */
function headCommit(cwd: string): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/**
 * `code_refs` for the files an observation touched, each pinned to the blob
 * it had at promotion time.
 *
 * The blob sha, not the commit: a file that was reformatted carries a new blob
 * even when the commit touched a hundred others, and "has this file changed
 * since the lesson was written" is a question about the file. Paths git does
 * not know are dropped silently — an observation's `files` list is written by
 * hand and routinely names something that moved.
 */
export function codeRefsFor(cwd: string, files: string | null): string | null {
  if (!files) return null;
  const refs: Array<{ path: string; blob_sha: string }> = [];
  for (const raw of files.split(',')) {
    const p = raw.trim();
    if (!p) continue;
    try {
      const sha = execFileSync('git', ['rev-parse', `HEAD:${p}`], {
        cwd,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (sha) refs.push({ path: p, blob_sha: sha });
    } catch {
      // Not tracked at this commit. Nothing to compare against later, so it
      // contributes nothing to the drift signal and is left out.
    }
  }
  return refs.length > 0 ? JSON.stringify(refs) : null;
}

// ─────────────────────────────────────────────────────────────────────
// The scrub context, built from this machine
// ─────────────────────────────────────────────────────────────────────

/**
 * What the scrub needs to know in order to recognise a leak.
 *
 * The other-projects list comes from the registry, with each project's module
 * count read from the brain so the replacement can say "the 18-module project"
 * instead of merely "<another project>". `readRegistryRaw` rather than
 * `readRegistry`: a project whose directory was deleted is still a client
 * whose name must not travel.
 */
export function scrubContextFor(ctx: ServerContext): ScrubContext {
  const project = ctx.requireProject();
  const others: Array<{ name: string; modules: number }> = [];
  try {
    for (const entry of readRegistryRaw()) {
      if (entry.name === project.name) continue;
      let modules = 0;
      try {
        const row = ctx.db.db
          .prepare(
            'SELECT COUNT(*) AS c FROM modules WHERE project_id = (SELECT id FROM projects WHERE name = ?)',
          )
          .get(entry.name) as { c: number } | undefined;
        modules = row?.c ?? 0;
      } catch {
        modules = 0;
      }
      others.push({ name: entry.name, modules });
    }
  } catch {
    // No registry is not a reason to skip the scrub: the path, host and
    // secret rules do not depend on it, and they are the ones that matter
    // most. A missing registry weakens the gate; it must not disable it.
  }
  return {
    homeDir: process.env.HOME ?? '',
    projectPath: ctx.projectPath,
    selfProjectName: project.name,
    otherProjects: others,
  };
}

// ─────────────────────────────────────────────────────────────────────
// propose_promotions
// ─────────────────────────────────────────────────────────────────────

export interface PromotionProposal {
  observationId: number;
  kind: ObservationKind;
  title: string;
  reason: PromotionReason;
  draft: OrgNoteDraft;
  /** Non-empty when this note cannot be promoted as written. */
  findings: ScrubFinding[];
  /** True when an identical lesson is already in the org memory. */
  alreadyThere: boolean;
}

export interface ProposePromotionsResult {
  org: { slug: string; name: string } | null;
  proposals: PromotionProposal[];
  /** Rendered here and printed verbatim. See the comment at renderProposals. */
  display: string;
  hint: string;
}

/**
 * Rendered server-side, like the module menu.
 *
 * The menu learned this the expensive way: handed structured data at a
 * decision point, the agent rebuilt the text itself and spent most of a
 * bootstrap doing it. This block is read at the end of a session, when the
 * user wants to answer and stop — so it arrives finished.
 */
function renderProposals(
  orgSlug: string | null,
  proposals: PromotionProposal[],
  identityNote: string | null,
): string {
  if (!orgSlug) return '';
  if (proposals.length === 0) return '';

  const lines: string[] = [];
  lines.push(`Promote to the "${orgSlug}" memory?`);
  lines.push('');
  for (const p of proposals) {
    const mark = p.alreadyThere ? '[=]' : p.findings.length > 0 ? '[!]' : '[ ]';
    // Clipped, not truncated in the data: the proposal carries the whole
    // title, the VIEW is what is bounded. Same rule as the module menu.
    const title = p.title.length > 68 ? p.title.slice(0, 67) + '…' : p.title;
    lines.push(`  ${mark} #${p.observationId} ${p.kind.padEnd(8)} ${title}`);
    if (p.alreadyThere) lines.push('        already in the org memory — nothing to do');
    else if (p.findings.length > 0) {
      lines.push(
        `        ${p.findings.length} thing${p.findings.length === 1 ? '' : 's'} would leak; ` +
          'a rewrite is proposed',
      );
    }
  }
  lines.push('');
  lines.push('  never promoted: the handoff, the session summary, the conversation');
  if (identityNote) {
    lines.push('');
    lines.push(`  note: ${identityNote}`);
  }
  return lines.join('\n');
}

/**
 * The candidates from a session (or an explicit list), already scrubbed.
 *
 * Scrubbed here rather than at promotion time, so the user is told which notes
 * need a rewrite BEFORE choosing. Being asked to confirm and then refused is
 * two interruptions where one would do.
 */
export function proposePromotions(
  ctx: ServerContext,
  opts: { sessionId?: number; observationIds?: number[] } = {},
): ProposePromotionsResult {
  const project = ctx.requireProject();
  const org = project.org_id === null ? null : ctx.db.orgs.findById(project.org_id);

  if (!org) {
    return {
      org: null,
      proposals: [],
      display: '',
      hint:
        'This project belongs to no org, so there is nothing to promote to. ' +
        '`myjarbis org add <slug> <pack-path>` or `myjarbis org pull` joins one.',
    };
  }

  let candidates: ObservationRow[] = [];
  if (opts.observationIds && opts.observationIds.length > 0) {
    for (const id of opts.observationIds) {
      const row = ctx.db.observations.findById(id);
      if (row) candidates.push(row);
    }
  } else if (opts.sessionId !== undefined) {
    candidates = ctx.db.observations.listBySession(opts.sessionId);
  }

  const scrubCtx = scrubContextFor(ctx);
  const explicit = (opts.observationIds?.length ?? 0) > 0;
  const proposals: PromotionProposal[] = [];

  for (const obs of candidates) {
    const reason = promotionReason(obs);
    // An explicitly named id is offered whatever its kind: the rules are a
    // default, and a default that cannot be overridden is wrong about
    // something sooner or later.
    if (reason === null && !explicit) continue;

    const draft = draftFromObservation(obs);
    const { findings } = scrubOrgNote(
      { question: draft.question, answer: draft.answer },
      scrubCtx,
    );
    const hash = ctx.db.orgNotes.hashOf({
      orgSlug: org.slug,
      projectName: project.name,
      draft,
    });
    proposals.push({
      observationId: obs.id,
      kind: obs.kind,
      title: obs.title,
      reason: reason ?? 'asked-for',
      draft,
      findings,
      alreadyThere: ctx.db.orgNotes.findByHash(org.id, hash) !== null,
    });
  }

  const identityNote = identityWarning(resolveIdentity(ctx.projectPath));
  const open = proposals.filter((p) => !p.alreadyThere);

  return {
    org: { slug: org.slug, name: org.name },
    proposals,
    display: renderProposals(org.slug, proposals, identityNote),
    hint:
      open.length === 0
        ? proposals.length === 0
          ? 'Nothing in this session is a candidate for the org memory. That is the ' +
            'normal case: roughly half of what gets offered to a shared store is ' +
            'already in it.'
          : 'Every candidate is already in the org memory. Nothing to do.'
        : `Print the display VERBATIM and ask which to promote. Then call ` +
          `promote_observation per confirmation. Do NOT promote without asking, and ` +
          `do not promote around a refusal: a note that would leak comes back with ` +
          `the offending line and a rewrite, and the user decides.`,
  };
}

// ─────────────────────────────────────────────────────────────────────
// promote_observation
// ─────────────────────────────────────────────────────────────────────

export const promoteObservationInputSchema = {
  type: 'object' as const,
  properties: {
    observation_id: {
      type: 'number' as const,
      description: 'The personal note to promote. The only way in.',
    },
    question: {
      type: 'string' as const,
      description:
        'How another developer would phrase the search that should find this. ' +
        'Defaults to the note\'s title; rewriting it is usually worth doing.',
    },
    answer: {
      type: 'string' as const,
      description: 'The lesson itself. Defaults to the note\'s content.',
    },
    working_example: {
      type: 'string' as const,
      description: 'The smallest thing somebody can copy. Strongly recommended.',
    },
    caveats: {
      type: 'string' as const,
      description:
        'WHEN this applies, and when it does not. The field with no mechanical ' +
        'source and the most value: it is what stops a lesson that is true in ' +
        'one context from being applied everywhere.',
    },
    tool_tags: { type: 'string' as const, description: 'Comma-separated: sqlite, fts5, git…' },
    type_tags: {
      type: 'string' as const,
      description: 'Comma-separated: gotcha | learning | bug | decision | convention.',
    },
    confidence: {
      type: 'string' as const,
      enum: ['assumed', 'verified'],
      description:
        '"verified" requires `evidence` and means somebody OBSERVED this, not ' +
        'that they believe it. Default "assumed".',
    },
    evidence: {
      type: 'string' as const,
      description: 'A commit, a merge request or a path somebody can open.',
    },
    scope: {
      type: 'string' as const,
      enum: ['project', 'org'],
      description:
        '"project" (default) files it under this project. "org" means it is true ' +
        'across every project of the org — use it for conventions, not for ' +
        'findings about one codebase.',
    },
    expires_in_days: {
      type: 'number' as const,
      description: 'Default 180. Knowledge about infrastructure rots.',
    },
    supersedes_id: {
      type: 'number' as const,
      description:
        'An org note this one replaces. The old one is marked superseded and ' +
        'kept, never deleted.',
    },
    apply_rewrites: {
      type: 'boolean' as const,
      description:
        'Accept the rewrites the scrub proposed and promote. Only pass this ' +
        'after the user has seen them.',
    },
  },
  required: ['observation_id'],
};

const promoteArgsZ = z
  .object({
    observation_id: z.number().int().positive(),
    question: z.string().min(1).max(500).optional(),
    answer: z.string().min(1).optional(),
    working_example: z.string().min(1).optional(),
    caveats: z.string().min(1).optional(),
    tool_tags: z.string().min(1).max(300).optional(),
    type_tags: z.string().min(1).max(300).optional(),
    confidence: z.enum(['assumed', 'verified']).optional(),
    evidence: z.string().min(1).max(500).optional(),
    scope: z.enum(['project', 'org']).optional(),
    expires_in_days: z.number().int().positive().max(3650).optional(),
    supersedes_id: z.number().int().positive().optional(),
    apply_rewrites: z.boolean().optional(),
  })
  .strict();

export interface PromoteResult {
  orgNoteId: number;
  org: { slug: string; name: string };
  status: 'inserted' | 'duplicate';
  author: { handle: string; source: string };
  confidence: string;
  scope: 'project' | 'org';
  expiresAt: string | null;
  /** Set when the stored text differs from what was passed in. */
  rewritten?: boolean;
  supersededNoteId?: number;
  hint: string;
}

export function promoteObservation(ctx: ServerContext, rawArgs: unknown): PromoteResult {
  const args = promoteArgsZ.parse(rawArgs);
  const project = ctx.requireProject();

  if (project.org_id === null) {
    throw new MyJarbisError(
      ErrorType.NO_ORG,
      'This project belongs to no org, so there is no org memory to promote into. ' +
        'Join one with `myjarbis org add <slug> <pack-path>` or `myjarbis org pull`.',
      { project: project.name },
    );
  }
  const org = ctx.db.orgs.findById(project.org_id);
  if (!org) {
    throw new MyJarbisError(
      ErrorType.ORG_NOT_FOUND,
      `This project references org ${project.org_id}, which is not in this brain.`,
    );
  }

  const obs = ctx.db.observations.findById(args.observation_id);
  if (!obs) {
    throw new MyJarbisError(
      ErrorType.RESOURCE_NOT_FOUND,
      `No observation with id ${args.observation_id} in this project.`,
    );
  }

  if (args.confidence === 'verified' && !args.evidence) {
    throw new MyJarbisError(
      ErrorType.INVALID_INPUT,
      '`verified` means somebody observed this, so it requires `evidence`: a commit, ' +
        'a merge request or a path. Without one the note is `assumed`, which is not a ' +
        'lesser note — it is an honest one.',
    );
  }

  const base = draftFromObservation(obs);
  const draft: OrgNoteDraft = {
    question: args.question ?? base.question,
    answer: args.answer ?? base.answer,
    workingExample: args.working_example ?? null,
    caveats: args.caveats ?? null,
    toolTags: args.tool_tags ?? base.toolTags ?? null,
    typeTags: args.type_tags ?? base.typeTags ?? null,
  };

  // ── the gate ──
  const scrubCtx = scrubContextFor(ctx);
  const first = scrubOrgNote(
    {
      question: draft.question,
      answer: draft.answer,
      working_example: draft.workingExample ?? undefined,
      caveats: draft.caveats ?? undefined,
      evidence: args.evidence,
    },
    scrubCtx,
  );

  let finalDraft = draft;
  let finalEvidence = args.evidence ?? null;
  let rewritten = false;

  if (first.findings.length > 0) {
    if (args.apply_rewrites !== true) {
      throw new MyJarbisError(
        ErrorType.ORG_NOTE_UNSAFE,
        renderScrubFindings(first.findings) +
          '\nNothing was promoted. Show the user these lines and the proposed rewrites. ' +
          'If they accept, call again with apply_rewrites: true. If they would rather ' +
          'word it differently, pass the corrected text instead.',
        { findings: first.findings, rewritten: first.rewritten },
      );
    }
    finalDraft = {
      ...draft,
      question: first.rewritten.question ?? draft.question,
      answer: first.rewritten.answer ?? draft.answer,
      workingExample: first.rewritten.working_example ?? draft.workingExample,
      caveats: first.rewritten.caveats ?? draft.caveats,
    };
    finalEvidence = first.rewritten.evidence ?? null;
    rewritten = true;

    // A rewrite that still leaks is still a refusal. Rules can overlap — a
    // path inside a project name inside a sentence — and one pass is not a
    // proof that the next one is clean.
    const second = scrubOrgNote(
      {
        question: finalDraft.question,
        answer: finalDraft.answer,
        working_example: finalDraft.workingExample ?? undefined,
        caveats: finalDraft.caveats ?? undefined,
        evidence: finalEvidence ?? undefined,
      },
      scrubCtx,
    );
    if (second.findings.length > 0) {
      throw new MyJarbisError(
        ErrorType.ORG_NOTE_UNSAFE,
        'The proposed rewrite still carries something that must not travel:\n\n' +
          renderScrubFindings(second.findings) +
          '\nNothing was promoted. This needs wording by a person, not another pass.',
        { findings: second.findings },
      );
    }
  }

  // ── the write ──
  const identity = resolveIdentity(ctx.projectPath);
  const asOrgWide = args.scope === 'org';
  const projectName = asOrgWide ? null : project.name;

  const hash = ctx.db.orgNotes.hashOf({
    orgSlug: org.slug,
    projectName,
    draft: finalDraft,
  });

  const added = ctx.db.orgNotes.add({
    orgId: org.id,
    projectId: asOrgWide ? null : project.id,
    sourceObservationId: obs.id,
    author: identity,
    draft: finalDraft,
    contentHash: hash,
    confidence: args.confidence ?? 'assumed',
    evidence: finalEvidence,
    codeRefs: codeRefsFor(ctx.projectPath, obs.files),
    atCommit: headCommit(ctx.projectPath),
    expiresInDays: args.expires_in_days,
  });

  let supersededNoteId: number | undefined;
  if (args.supersedes_id !== undefined && added.status === 'inserted') {
    ctx.db.orgNotes.setStatus(args.supersedes_id, 'superseded', added.row.id);
    supersededNoteId = args.supersedes_id;
  }

  const identityNote = identityWarning(identity);

  return {
    orgNoteId: added.row.id,
    org: { slug: org.slug, name: org.name },
    status: added.status,
    author: { handle: identity.handle, source: identity.source },
    confidence: added.row.confidence,
    scope: asOrgWide ? 'org' : 'project',
    expiresAt: added.row.expires_at,
    rewritten: rewritten || undefined,
    supersededNoteId,
    hint:
      (added.status === 'duplicate'
        ? `Somebody had already recorded this lesson (note #${added.row.id}, by ` +
          `${added.row.author_handle}). Nothing was added — say so rather than ` +
          `reporting a promotion.`
        : `Promoted as note #${added.row.id}. It is in the local mirror; ` +
          `\`myjarbis org push\` writes it to the files the team reads, and those ` +
          `files still have to be committed by a person.`) +
      (rewritten ? ' The text was rewritten by the scrub before storing.' : '') +
      (identityNote ? ` Warning: ${identityNote}` : ''),
  };
}

// ─────────────────────────────────────────────────────────────────────
// list_org_notes
// ─────────────────────────────────────────────────────────────────────

export const listOrgNotesInputSchema = {
  type: 'object' as const,
  properties: {
    status: {
      type: 'array' as const,
      items: { type: 'string' as const, enum: ['active', 'stale', 'superseded', 'deleted'] },
      description: 'Default active + stale. Superseded and deleted are hidden unless asked for.',
    },
    limit: { type: 'number' as const, description: 'Default 50.' },
  },
};

export interface ListOrgNotesResult {
  org: { slug: string; name: string } | null;
  count: number;
  notes: Array<{
    id: number;
    question: string;
    author: string;
    promotedAt: string;
    status: string;
    confidence: string;
    expired: boolean;
    orgWide: boolean;
    drift: number | null;
  }>;
  hint?: string;
}

export function listOrgNotes(ctx: ServerContext, rawArgs: unknown = {}): ListOrgNotesResult {
  const args = z
    .object({
      status: z.array(z.enum(['active', 'stale', 'superseded', 'deleted'])).optional(),
      limit: z.number().int().positive().max(500).optional(),
    })
    .strict()
    .parse(rawArgs ?? {});

  const project = ctx.requireProject();
  if (project.org_id === null) {
    return { org: null, count: 0, notes: [], hint: 'This project belongs to no org.' };
  }
  const org = ctx.db.orgs.findById(project.org_id)!;
  const rows = ctx.db.orgNotes.listByOrg(org.id, {
    projectId: project.id,
    status: args.status ?? ['active', 'stale'],
    limit: args.limit ?? 50,
  });
  const now = Date.now();
  return {
    org: { slug: org.slug, name: org.name },
    count: rows.length,
    notes: rows.map((n: OrgNoteRow & { question: string }) => ({
      id: n.id,
      question: n.question,
      author: n.author_handle,
      promotedAt: n.promoted_at,
      status: n.status,
      confidence: n.confidence,
      expired: n.expires_at !== null && Date.parse(n.expires_at + 'Z') < now,
      orgWide: n.project_id === null,
      drift: n.drift_checked_at === null ? null : (n.drift_changed ?? 0),
    })),
  };
}
