/**
 * The org memory, as files committed in the project's own repository.
 *
 * The transport is the repo the team already clones. No new repository, no
 * access to grant, no server: a dev who can check out the code can read what
 * the team learned, and `myjarbis org pull` after a clone is the whole
 * onboarding step.
 *
 *   <project>/.myjarbis/org/
 *     manifest.json          format, version, which org, counts
 *     org_notes.ndjson       the governance half, one row per line
 *     org_note_content.ndjson the searchable half
 *
 * WHY NOT just reuse `brain export`. That dump is a snapshot of a whole
 * project keyed by row id, meant to be replaced wholesale on import — see
 * `importBrain`, which DELETEs every tracked table first. This is the opposite
 * shape: a shared, append-mostly file that several people write, merged rather
 * than replaced, keyed by content so two machines agree about what is the same
 * note. Same file format, different contract.
 *
 * THREE DECISIONS THAT DECIDE WHETHER THIS CONFLICTS IN GIT.
 *
 * 1. Keys are hand-written, not read from `PRAGMA table_info`. The brain dump
 *    follows the physical column order because it is a table snapshot; this is
 *    a wire format, and a column added to `org_notes` must not silently change
 *    the file everybody else reads.
 *
 * 2. Local columns are not exported at all: `id` and `seq` are per-machine,
 *    `source_observation_id` points into somebody's personal brain, and
 *    `drift_changed` / `drift_checked_at` are a cache that would rewrite a
 *    line on every refresh. References travel as hashes (`supersedes_hash`)
 *    and the project as a NAME, the same way `brain export` sends
 *    `projects.path` as a sentinel.
 *
 * 3. Rows are ordered by `(promoted_at, content_hash)`, not by id and not by
 *    hash. Hash order inserts each new note in the MIDDLE of the file, so two
 *    people adding one note each conflict; promotion order makes the ordinary
 *    case a pure append, which git merges without asking. Measured elsewhere:
 *    agent-authored changes conflict textually about 28% of the time, and the
 *    mitigation everybody who survived it converged on is one record per line,
 *    appended.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ServerContext } from '../../context.js';
import { MyJarbisError, ErrorType } from '../../types.js';
import { SCHEMA_VERSION, OrgNoteStatus, OrgNoteConfidence } from '../../db/schema.js';
import { writeIfChanged, parseNdjson, toNdjson } from '../../ndjson.js';
import { OrgMemoryTransport, PullResult, PushResult, identityFor } from './transport.js';

/** Directory under `.myjarbis/` holding the shared memory. */
export const ORG_DIRNAME = 'org';

const MANIFEST = 'manifest.json';
const NOTES_FILE = 'org_notes.ndjson';
const CONTENT_FILE = 'org_note_content.ndjson';

/**
 * The wire format's own version, independent of the schema's.
 *
 * A schema change that does not alter these keys must not invalidate every
 * team's files, and a change to these keys must be refused by older clients
 * even when the schema version happens to match.
 */
const FORMAT = 'myjarbis-org-ndjson';
const FORMAT_VERSION = 1;

/** Exported keys, in order. Hand-written; see the module docstring. */
const NOTE_KEYS = [
  'content_hash',
  'project',
  'author_handle',
  'author_email',
  'author_source',
  'created_at',
  'promoted_at',
  'status',
  'supersedes_hash',
  'expires_at',
  'confidence',
  'evidence',
  'code_refs',
] as const;

const CONTENT_KEYS = [
  'content_hash',
  'question',
  'answer',
  'working_example',
  'caveats',
  'tool_tags',
  'type_tags',
  'linked_hashes',
] as const;

interface OrgManifest {
  format: string;
  formatVersion: number;
  schemaVersion: number;
  org: { slug: string; name: string };
  exportedAt: string;
  counts: { org_notes: number };
}

function orgDir(ctx: ServerContext, override?: string): string {
  return override ?? path.join(ctx.projectPath, '.myjarbis', ORG_DIRNAME);
}

/** The org of the bound project, as a row, or a refusal. */
function requireOrg(ctx: ServerContext): { id: number; slug: string; name: string } {
  const project = ctx.requireProject();
  // Read live, not from the cached project row: `org_id` is the one field on
  // it that changes mid-process, and a pull is what changes it.
  const orgId = ctx.db.scopedOrgId;
  if (orgId === null) {
    throw new MyJarbisError(
      ErrorType.NO_ORG,
      'This project belongs to no org. `myjarbis org pull` can join one if the ' +
        'repository already carries .myjarbis/org/, otherwise `myjarbis org add ' +
        '<slug> <pack-path>`.',
      { project: project.name },
    );
  }
  const org = ctx.db.orgs.findById(orgId);
  if (!org) {
    throw new MyJarbisError(
      ErrorType.ORG_NOT_FOUND,
      `This project references org ${orgId}, which is not in this brain.`,
    );
  }
  return { id: org.id, slug: org.slug, name: org.name };
}

function readManifest(dir: string): OrgManifest | null {
  const p = path.join(dir, MANIFEST);
  if (!fs.existsSync(p)) return null;
  let parsed: OrgManifest;
  try {
    parsed = JSON.parse(fs.readFileSync(p, 'utf-8')) as OrgManifest;
  } catch (err) {
    throw new MyJarbisError(
      ErrorType.INVALID_INPUT,
      `${p} is not valid JSON: ${err instanceof Error ? err.message : String(err)}. ` +
        'If this is a merge conflict, resolve it before pulling.',
    );
  }
  if (parsed.format !== FORMAT) {
    throw new MyJarbisError(
      ErrorType.INVALID_INPUT,
      `${p} says format "${parsed.format}"; this build reads "${FORMAT}".`,
    );
  }
  if (parsed.formatVersion > FORMAT_VERSION) {
    throw new MyJarbisError(
      ErrorType.INVALID_INPUT,
      `${p} was written by a newer MyJarbis (format version ${parsed.formatVersion}, ` +
        `this build reads ${FORMAT_VERSION}). Update before pulling, rather than ` +
        'reading it as if the fields meant what they used to.',
    );
  }
  return parsed;
}

// ─────────────────────────────────────────────────────────────────────
// push
// ─────────────────────────────────────────────────────────────────────

function push(ctx: ServerContext, opts: { dir?: string } = {}): PushResult {
  const org = requireOrg(ctx);
  const dir = orgDir(ctx, opts.dir);
  fs.mkdirSync(dir, { recursive: true });

  // Everything the org has that this machine can see, including the org-wide
  // notes: a note with no project belongs to the org, and whichever project
  // pushes is the one that carries it. Narrowing to this project's notes
  // would mean an org-wide note never reaches anybody.
  const rows = ctx.db.orgNotes.listByOrg(org.id, { limit: 100000 });

  // hash → project name, for notes filed under a project this machine has.
  const projectNameById = new Map<number, string>();
  for (const r of rows) {
    if (r.project_id !== null && !projectNameById.has(r.project_id)) {
      const p = ctx.db.projects.findById(r.project_id);
      if (p) projectNameById.set(r.project_id, p.name);
    }
  }
  const hashById = new Map<number, string>(rows.map((r) => [r.id, r.content_hash]));

  const noteRows = rows.map((r) => ({
    content_hash: r.content_hash,
    project: r.project_id === null ? null : (projectNameById.get(r.project_id) ?? null),
    author_handle: r.author_handle,
    author_email: r.author_email,
    author_source: r.author_source,
    created_at: r.created_at,
    promoted_at: r.promoted_at,
    status: r.status,
    // A reference by hash, not by id: ids are local, and the note it points at
    // may not even be in this file yet.
    supersedes_hash: r.supersedes_id === null ? null : (hashById.get(r.supersedes_id) ?? null),
    expires_at: r.expires_at,
    confidence: r.confidence,
    evidence: r.evidence,
    code_refs: r.code_refs,
  }));

  const contentRows = rows.map((r) => ({
    content_hash: r.content_hash,
    question: r.question,
    answer: r.answer,
    working_example: r.working_example,
    caveats: r.caveats,
    tool_tags: r.tool_tags,
    type_tags: r.type_tags,
    linked_hashes: r.linked_ids,
  }));

  // Ordered by promotion time so a new note lands at the END of the file.
  const byPromotion = (a: { promoted_at: string; content_hash: string }, b: typeof a) =>
    a.promoted_at < b.promoted_at
      ? -1
      : a.promoted_at > b.promoted_at
        ? 1
        : a.content_hash < b.content_hash
          ? -1
          : 1;
  noteRows.sort(byPromotion);
  const order = new Map(noteRows.map((n, i) => [n.content_hash, i]));
  contentRows.sort((a, b) => (order.get(a.content_hash)! - order.get(b.content_hash)!));

  // Count what changed against what is already on disk, so the report can say
  // "appended 1" rather than "wrote 2 files" — which is the difference between
  // a user knowing what to commit and guessing.
  const before = new Map<string, string>();
  for (const row of parseNdjson(path.join(dir, NOTES_FILE))) {
    before.set(String(row.content_hash), JSON.stringify(row));
  }
  let appended = 0;
  let rewritten = 0;
  for (const n of noteRows) {
    const prev = before.get(n.content_hash);
    if (prev === undefined) appended++;
    else {
      const ordered: Record<string, unknown> = {};
      for (const k of NOTE_KEYS) ordered[k] = (n as Record<string, unknown>)[k] ?? null;
      if (JSON.stringify(ordered) !== prev) rewritten++;
    }
  }

  const notesText = toNdjson(noteRows as Array<Record<string, unknown>>, NOTE_KEYS);
  const contentText = toNdjson(contentRows as Array<Record<string, unknown>>, CONTENT_KEYS);
  const manifest: OrgManifest = {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    schemaVersion: SCHEMA_VERSION,
    org: { slug: org.slug, name: org.name },
    exportedAt: new Date().toISOString(),
    counts: { org_notes: noteRows.length },
  };

  const filesWritten: string[] = [];
  if (writeIfChanged(path.join(dir, NOTES_FILE), notesText)) filesWritten.push(NOTES_FILE);
  if (writeIfChanged(path.join(dir, CONTENT_FILE), contentText)) filesWritten.push(CONTENT_FILE);

  // The manifest carries a timestamp, so writing it unconditionally would make
  // every push look like a change and leave something to commit after a no-op.
  // Written only when the content files moved, or when it does not exist yet.
  const manifestPath = path.join(dir, MANIFEST);
  if (filesWritten.length > 0 || !fs.existsSync(manifestPath)) {
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
    filesWritten.push(MANIFEST);
  }

  const rel = path.relative(ctx.projectPath, dir) || '.myjarbis/org';
  return {
    dir,
    filesWritten,
    appended,
    rewritten,
    bytes: notesText.length + contentText.length,
    changed: filesWritten.length > 0,
    // Named explicitly rather than `git add -A`, which CONVENTIONS.md forbids.
    stageCommand: `git add ${rel}/${MANIFEST} ${rel}/${NOTES_FILE} ${rel}/${CONTENT_FILE}`,
  };
}

// ─────────────────────────────────────────────────────────────────────
// pull
// ─────────────────────────────────────────────────────────────────────

function pull(ctx: ServerContext, opts: { dir?: string } = {}): PullResult {
  const project = ctx.requireProject();
  const dir = orgDir(ctx, opts.dir);
  const warnings: string[] = [];

  const manifest = readManifest(dir);
  if (!manifest) {
    throw new MyJarbisError(
      ErrorType.RESOURCE_NOT_FOUND,
      `No org memory at ${dir}. Nothing has been pushed to this repository yet, ` +
        'or you are in the wrong checkout.',
      { dir },
    );
  }

  // Joining the org is part of pulling: a dev who clones and pulls should not
  // also have to be told which org this is.
  let orgRegistered = false;
  const org = ctx.db.orgs.upsert({ slug: manifest.org.slug, name: manifest.org.name });
  const currentOrgId = ctx.db.scopedOrgId;
  if (currentOrgId === null) {
    ctx.db.projects.setOrg(project.id, org.id);
    orgRegistered = true;
  } else if (currentOrgId !== org.id) {
    const current = ctx.db.orgs.findById(currentOrgId);
    throw new MyJarbisError(
      ErrorType.ORG_NOT_FOUND,
      `This project belongs to org "${current?.slug ?? currentOrgId}" but ${dir} ` +
        `carries "${manifest.org.slug}". Refusing to move a project between orgs ` +
        'as a side effect of a pull.',
      { current: current?.slug ?? null, incoming: manifest.org.slug },
    );
  }
  // Re-resolve: the connection cached the project row before setOrg.
  const projectNow = ctx.db.projects.findById(project.id)!;

  const noteRows = parseNdjson(path.join(dir, NOTES_FILE));
  const contentRows = parseNdjson(path.join(dir, CONTENT_FILE));
  const contentByHash = new Map<string, Record<string, unknown>>();
  for (const c of contentRows) contentByHash.set(String(c.content_hash), c);

  const unknownProjects = new Set<string>();
  let added = 0;
  let duplicates = 0;
  let governanceUpdated = 0;

  // Two passes. The first inserts every note; the second resolves
  // `supersedes_hash`, because the note a row supersedes may be a row that
  // appears later in the same file.
  const insertedByHash = new Map<string, number>();

  // Both passes in ONE transaction. A pull that died mid-file used to leave a
  // partially merged mirror with no record of where it stopped — and because
  // pull is idempotent by content hash, the next attempt would silently finish
  // the job, which sounds fine until the file was mid-merge and half of it was
  // somebody else's conflict markers. All of it, or none of it.
  ctx.db.tx(() => {
  for (const n of noteRows) {
    const hash = String(n.content_hash ?? '');
    if (!hash) {
      warnings.push('a row with no content_hash was skipped: it has no identity.');
      continue;
    }
    const content = contentByHash.get(hash);
    if (!content) {
      warnings.push(
        `note ${hash.slice(0, 8)} has no matching row in ${CONTENT_FILE} and was skipped. ` +
          'The two files are out of step — usually a half-resolved merge.',
      );
      continue;
    }

    // A note filed under a project name this machine does not have becomes
    // org-wide rather than vanishing.
    let projectId: number | null = null;
    const projectName = n.project === null || n.project === undefined ? null : String(n.project);
    if (projectName !== null) {
      if (projectName === projectNow.name) projectId = projectNow.id;
      else {
        unknownProjects.add(projectName);
        projectId = null;
      }
    }

    const existing = ctx.db.orgNotes.findByHash(org.id, hash);
    if (existing) {
      duplicates++;
      insertedByHash.set(hash, existing.id);
      // ADDITIVE, but not frozen: the governance half is what a teammate
      // changes when a lesson goes stale or gets superseded, and a pull that
      // ignored it would leave every machine with its own idea of the
      // lifecycle. The CONTENT is immutable by hash, so there is nothing to
      // reconcile there.
      const incomingStatus = String(n.status ?? 'active') as OrgNoteStatus;
      const incomingConfidence = String(n.confidence ?? 'assumed') as OrgNoteConfidence;
      const incomingExpiry = n.expires_at === null ? null : String(n.expires_at);
      if (
        existing.status !== incomingStatus ||
        existing.confidence !== incomingConfidence ||
        existing.expires_at !== incomingExpiry
      ) {
        ctx.db.db
          .prepare(
            `UPDATE org_notes
                SET status = ?, confidence = ?, expires_at = ?, updated_at = datetime('now')
              WHERE id = ?`,
          )
          .run(incomingStatus, incomingConfidence, incomingExpiry, existing.id);
        governanceUpdated++;
      }
      continue;
    }

    const result = ctx.db.orgNotes.add({
      orgId: org.id,
      projectId,
      author: {
        handle: String(n.author_handle ?? 'unknown'),
        email: n.author_email === null ? null : String(n.author_email),
        source:
          n.author_source === 'git' || n.author_source === 'config' ? n.author_source : 'fallback',
      },
      draft: {
        question: String(content.question ?? ''),
        answer: String(content.answer ?? ''),
        workingExample: content.working_example === null ? null : String(content.working_example),
        caveats: content.caveats === null ? null : String(content.caveats),
        toolTags: content.tool_tags === null ? null : String(content.tool_tags),
        typeTags: content.type_tags === null ? null : String(content.type_tags),
        linkedIds: content.linked_hashes === null ? null : String(content.linked_hashes),
      },
      // The hash comes from the FILE and is not recomputed. Recomputing it
      // would make a note's identity depend on the local project name, so the
      // same lesson would be a different row on every machine — and the
      // deduplication this whole format rests on would never fire.
      contentHash: hash,
      createdAt: n.created_at === null ? undefined : String(n.created_at),
      promotedAt: n.promoted_at === null ? undefined : String(n.promoted_at),
      status: String(n.status ?? 'active') as OrgNoteStatus,
      expiresAt: n.expires_at === null ? null : String(n.expires_at),
      confidence: String(n.confidence ?? 'assumed') as OrgNoteConfidence,
      evidence: n.evidence === null ? null : String(n.evidence),
      codeRefs: n.code_refs === null ? null : String(n.code_refs),
    });
    if (result.status === 'inserted') added++;
    else duplicates++;
    insertedByHash.set(hash, result.row.id);
  }

  // `prep` and not the raw handle: the statement is cached, so this is one
  // prepare for the whole file rather than one per row.
  for (const n of noteRows) {
    const hash = String(n.content_hash ?? '');
    const supersedes = n.supersedes_hash;
    if (!hash || supersedes === null || supersedes === undefined) continue;
    const self = insertedByHash.get(hash);
    const target = insertedByHash.get(String(supersedes));
    if (self === undefined || target === undefined) continue;
    ctx.db.orgNotes.setSupersedes(self, target);
  }
  });

  if (unknownProjects.size > 0) {
    warnings.push(
      `${unknownProjects.size} note(s) name a project this machine does not have ` +
        `(${[...unknownProjects].join(', ')}). Filed as org-wide rather than dropped.`,
    );
  }

  return {
    dir,
    org: { slug: org.slug, name: org.name },
    read: noteRows.length,
    added,
    duplicates,
    governanceUpdated,
    orgRegistered,
    unknownProjects: [...unknownProjects],
    warnings,
  };
}

export const gitProjectDriver: OrgMemoryTransport = {
  kind: 'in-project-git',
  identity: identityFor,
  pull,
  push,
};
