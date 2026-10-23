/**
 * MyJarbis v0.3 — SQLite + FTS5 schema
 *
 * Hierarchy:
 *   project
 *     └── project_context     (core: practices, deps, conventions, specs)
 *     └── modules             (verticales creadas explícitamente)
 *           └── module_context (workflow, plan, stories, AC del módulo)
 *           └── sessions       (sesión de trabajo en un módulo)
 *                 └── observations (decisions, gotchas, progress)
 *     └── skills              (project-level si module_id IS NULL,
 *                              module-level si module_id apunta a uno)
 *
 * FTS5 contentless indexes mirror the searchable columns of:
 *   project_context, module_context, skills, observations
 * Triggers keep the FTS5 tables in sync on INSERT/UPDATE/DELETE.
 *
 * `content_hash` (SHA-256) on context/skills rows enables idempotent
 * re-import: same path + same content = no-op; same path + new content
 * = UPDATE.
 *
 * Schema versioning lives in the `meta` table to support future
 * migrations without code-detection of structure.
 */

export const SCHEMA_VERSION = 5;

/**
 * Objects introduced in v5, declared ONCE and used twice: interpolated into
 * `SCHEMA_SQL` for a new file, and listed in `MIGRATIONS[5]` for an existing
 * one.
 *
 * Writing them out in both places is how a fresh database and a migrated one
 * drift apart, and the drift is invisible: v4 added `observations.project_id`
 * with `ON DELETE CASCADE` in `SCHEMA_SQL` and without it in the migration, so
 * every brain that upgraded has a weaker constraint than every brain that was
 * created. One declaration makes that class of difference unrepresentable.
 *
 * The corollary, and it is a constraint on what can be declared here: an object
 * must be expressible as a standalone statement that is valid on both paths.
 * SQLite has no `ALTER TABLE ... ADD CONSTRAINT`, so a rule that would need a
 * table-level CHECK on an existing table cannot live in the schema at all — it
 * lives in the repository that writes the row. "A step either delegates
 * (`uses`) or acts (`capability`), never both" is exactly such a rule.
 */
const V5_OBJECTS: string[] = [
  // ─────────────────────────────────────────────────────────────────
  // Org memory — the second, smaller memory, shared across an org.
  //
  // Separate tables rather than a flag on `observations`, because the
  // guarantee has to be structural. A flag is something somebody can flip;
  // a table with no column able to hold a transcript is a promise the
  // schema keeps on its own. There is deliberately no `session_id`, no
  // `summary`, no `next_session` and no free-text `content` here: the only
  // door into this table is promote_observation, which takes one note id.
  //
  // Split in two on purpose. The governance half is read by status, expiry
  // and author and is NOT mirrored into FTS; the content half is immutable
  // (keyed by its hash) and IS. That split is what lets a status change --
  // the most frequent UPDATE this feature has -- avoid touching the
  // contentless index at all, instead of firing a delete+insert against it
  // every time a note goes stale.
  // ─────────────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS org_notes (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id                INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  -- NULL means org-wide. SET NULL and never CASCADE: removing a project
  -- from this machine must not delete a lesson other people are reading.
  project_id            INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  -- The personal note this came from. A pointer into the local brain, so
  -- it is never exported.
  source_observation_id INTEGER REFERENCES observations(id) ON DELETE SET NULL,
  author_handle         TEXT    NOT NULL,
  author_email          TEXT,
  author_source         TEXT    NOT NULL
                        CHECK (author_source IN ('git', 'config', 'fallback')),
  created_at            TEXT    NOT NULL DEFAULT (datetime('now')),
  promoted_at           TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT,
  -- Lifecycle, never deletion. A wrong lesson has to stay readable with its
  -- provenance, or the next person re-learns it and records it again.
  status                TEXT    NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'stale', 'superseded', 'deleted')),
  supersedes_id         INTEGER REFERENCES org_notes(id),
  expires_at            TEXT,
  confidence            TEXT    NOT NULL DEFAULT 'assumed'
                        CHECK (confidence IN ('assumed', 'verified')),
  evidence              TEXT,
  -- JSON array of {path, blob_sha} captured at promotion. The blob shas are
  -- the baseline the drift signal compares against.
  code_refs             TEXT,
  content_hash          TEXT    NOT NULL,
  -- Local and monotonic per org, for incremental reads. NOT an identity and
  -- never exported: two machines cannot allocate from one counter without a
  -- vector clock. Identity is content_hash.
  seq                   INTEGER NOT NULL,
  -- Derived drift cache, local only. Refreshed by org pull/status, read by
  -- search. Exporting it would rewrite the committed file on every refresh.
  drift_checked_at      TEXT,
  drift_changed         INTEGER,
  -- The dedup guarantee, in the database. A check-then-insert in the
  -- application is the window that gives mem0 permanently duplicated
  -- memories under concurrency; a constraint has no window.
  UNIQUE(org_id, content_hash)
)`,
  `CREATE INDEX IF NOT EXISTS idx_org_notes_org     ON org_notes(org_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_org_notes_project ON org_notes(project_id)`,
  `CREATE INDEX IF NOT EXISTS idx_org_notes_seq     ON org_notes(org_id, seq)`,

  // The content half. Immutable: a change of wording is a different hash and
  // therefore a different note, which is what makes a pull idempotent and a
  // supersession explicit rather than silent.
  `CREATE TABLE IF NOT EXISTS org_note_content (
  note_id         INTEGER PRIMARY KEY REFERENCES org_notes(id) ON DELETE CASCADE,
  -- How another developer would phrase the search. Writing the question
  -- down is what makes the answer findable by someone who was not there.
  question        TEXT NOT NULL,
  answer          TEXT NOT NULL,
  working_example TEXT,
  -- When this applies. The field that stops a lesson that is true in one
  -- context from being applied everywhere.
  caveats         TEXT,
  tool_tags       TEXT,
  type_tags       TEXT,
  linked_ids      TEXT
)`,

  // ─────────────────────────────────────────────────────────────────
  // Workflow runs — where a ritual got to, and how long each step took.
  //
  // get_workflow answers "what is the process"; it has never been able to
  // answer "where was I in it". That answer lived in whatever prose the
  // agent happened to write into next_session, which is the same failure
  // the workflows table was created to end, one level up.
  // ─────────────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS workflow_runs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Denormalised for the same reason observations.project_id is: without
  -- it a run reaches its tenant only through a NULLABLE session_id, and a
  -- nullable join is too thin to be the only thing between two clients.
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  slug       TEXT    NOT NULL,
  session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
  started_at TEXT    NOT NULL DEFAULT (datetime('now')),
  ended_at   TEXT,
  status     TEXT    NOT NULL DEFAULT 'open'
             CHECK (status IN ('open', 'done', 'abandoned'))
)`,
  `CREATE INDEX IF NOT EXISTS idx_wfruns_project ON workflow_runs(project_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_wfruns_session ON workflow_runs(session_id)`,

  `CREATE TABLE IF NOT EXISTS workflow_run_steps (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id        INTEGER NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  position      INTEGER NOT NULL,
  -- Namespaced ("child-slug/step-name") when the step came from a workflow
  -- the parent invoked, which is why this is TEXT and not a step id: a run
  -- is a snapshot of a resolution, and the resolution has no row.
  step_name     TEXT    NOT NULL,
  from_workflow TEXT    NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'active', 'done', 'skipped', 'blocked')),
  started_at    TEXT,
  completed_at  TEXT,
  actor         TEXT,
  -- Why it was skipped. Required for 'skipped' by the repository: a run log
  -- that records what was skipped without why answers nothing later.
  note          TEXT,
  UNIQUE(run_id, step_name)
)`,
  `CREATE INDEX IF NOT EXISTS idx_wfrunsteps_run ON workflow_run_steps(run_id, position)`,

  // The FTS mirror of the content half, in the same shape as the other four.
  // `note_id` is an INTEGER PRIMARY KEY, so it is the rowid alias and works
  // as content_rowid. `linked_ids` is deliberately out of the index: it holds
  // hashes, and indexing them makes an identifier match a text search.
  `CREATE VIRTUAL TABLE IF NOT EXISTS org_note_content_fts USING fts5(
  question, answer, working_example, caveats, tool_tags, type_tags,
  content='org_note_content',
  content_rowid='note_id'
)`,
  `CREATE TRIGGER IF NOT EXISTS org_note_content_ai AFTER INSERT ON org_note_content BEGIN
  INSERT INTO org_note_content_fts(rowid, question, answer, working_example, caveats, tool_tags, type_tags)
  VALUES (new.note_id, new.question, new.answer, new.working_example, new.caveats, new.tool_tags, new.type_tags);
END`,
  `CREATE TRIGGER IF NOT EXISTS org_note_content_ad AFTER DELETE ON org_note_content BEGIN
  INSERT INTO org_note_content_fts(org_note_content_fts, rowid, question, answer, working_example, caveats, tool_tags, type_tags)
  VALUES('delete', old.note_id, old.question, old.answer, old.working_example, old.caveats, old.tool_tags, old.type_tags);
END`,
  // The content half is never UPDATEd by the application. This trigger exists
  // so that `brain import` and `merge`, which write rows directly, cannot
  // leave the index describing a row that no longer says what it says.
  `CREATE TRIGGER IF NOT EXISTS org_note_content_au AFTER UPDATE ON org_note_content BEGIN
  INSERT INTO org_note_content_fts(org_note_content_fts, rowid, question, answer, working_example, caveats, tool_tags, type_tags)
  VALUES('delete', old.note_id, old.question, old.answer, old.working_example, old.caveats, old.tool_tags, old.type_tags);
  INSERT INTO org_note_content_fts(rowid, question, answer, working_example, caveats, tool_tags, type_tags)
  VALUES (new.note_id, new.question, new.answer, new.working_example, new.caveats, new.tool_tags, new.type_tags);
END`,
];

/** Migration steps applied in order when bumping from one schema version to
 *  the next. Each entry is a LIST of individual statements run AFTER the base
 *  SCHEMA_SQL has been applied (for already-existing DBs at a lower version).
 *
 *  One statement per array element, deliberately: a multi-statement string
 *  passed to `exec` aborts at the first failure, so a re-run that hit an
 *  already-added column would silently skip every statement after it and
 *  leave the DB half-migrated while still bumping the version. Per-statement
 *  application lets us tolerate "duplicate column" on exactly the statement
 *  that is already satisfied and keep going. */
export const MIGRATIONS: Record<number, string[]> = {
  // v2 → v3: add `progress` column to module_context for relational
  // per-row state tracking (story status, smoke checkpoints, commit refs).
  // Mirrors the role of a "Smoke" / "Commit" column in a PROGRESS.md table
  // but lives next to the row it describes.
  3: [`ALTER TABLE module_context ADD COLUMN progress TEXT`],

  // v3 → v4: orgs, the context-kind catalogue, topic identity on notes,
  // typed external refs, the living-state singleton, workflows-as-data and
  // providers. Every statement here is additive: no column is dropped and no
  // existing row is rewritten except the project_id backfill, which fills a
  // value that was previously only reachable through a three-table join.
  4: [
    `ALTER TABLE projects ADD COLUMN org_id INTEGER REFERENCES orgs(id)`,
    `ALTER TABLE projects ADD COLUMN git_remote TEXT`,
    `ALTER TABLE projects ADD COLUMN isolation TEXT NOT NULL DEFAULT 'silo'`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_remote
       ON projects(git_remote) WHERE git_remote IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_projects_org ON projects(org_id)`,

    `ALTER TABLE project_context ADD COLUMN topic_key TEXT`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_pctx_topic
       ON project_context(project_id, topic_key) WHERE topic_key IS NOT NULL`,

    `ALTER TABLE observations ADD COLUMN project_id INTEGER REFERENCES projects(id)`,
    `ALTER TABLE observations ADD COLUMN topic_key TEXT`,
    `ALTER TABLE observations ADD COLUMN supersedes INTEGER REFERENCES observations(id)`,
    `ALTER TABLE observations ADD COLUMN updated_at TEXT`,

    // Rebuild the FTS index BEFORE the backfill below, and this is not
    // optional. The backfill is an UPDATE, which fires observations_au,
    // which issues a 'delete' op against the contentless FTS index for the
    // old row. For any row that is not actually in the index, that op
    // returns SQLITE_CORRUPT_VTAB — "database disk image is malformed" —
    // and the whole migration dies on a database that is in fact fine.
    //
    // Reproduced against a v3 file whose index was incomplete. Rebuilding
    // first makes the backfill safe and repairs a stale index as a side
    // effect, which is worth having on its own: a stale contentless index
    // returns hits that resolve to the wrong rows.
    `INSERT INTO observations_fts(observations_fts) VALUES('rebuild')`,

    // Backfill the denormalised project_id for rows written before v4.
    `UPDATE observations
        SET project_id = (
          SELECT m.project_id
            FROM sessions s JOIN modules m ON m.id = s.module_id
           WHERE s.id = observations.session_id
        )
      WHERE project_id IS NULL`,

    `CREATE UNIQUE INDEX IF NOT EXISTS idx_obs_topic
       ON observations(project_id, topic_key) WHERE topic_key IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_obs_project ON observations(project_id)`,
  ],

  // v4 → v5: the org memory (a second, smaller, shared store), workflow
  // composition, and workflow runs.
  //
  // Additive only. Four new tables, one virtual table, three triggers and two
  // new columns on tables that hold no rows in any brain yet — `workflows` and
  // `workflow_steps` are empty everywhere, which is why this migration can
  // extend them without a backfill.
  //
  // There is no `INSERT INTO ..._fts VALUES('rebuild')` here, and its absence
  // is deliberate rather than an omission: v4 needed one because it ran an
  // UPDATE over `observations`, and an UPDATE fires the _au trigger, whose
  // 'delete' op against a contentless index returns SQLITE_CORRUPT_VTAB for a
  // row the index does not hold. v5 updates no FTS-mirrored table, so there is
  // no such op to protect. A rebuild added "to be safe" would be a statement
  // nobody can justify, in the one place where every statement runs against
  // somebody's only copy of their memory.
  5: [
    // The ALTERs cannot be shared with SCHEMA_SQL — a new file declares these
    // columns inline in CREATE TABLE — so they are the one part written twice.
    `ALTER TABLE workflows ADD COLUMN standalone INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE workflow_steps ADD COLUMN uses TEXT`,

    ...V5_OBJECTS,
  ],
};

export const SCHEMA_SQL = `
-- ─────────────────────────────────────────────────────────────────
-- Pragmas
-- ─────────────────────────────────────────────────────────────────
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;

-- ─────────────────────────────────────────────────────────────────
-- Meta (schema version + arbitrary key/value metadata)
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ─────────────────────────────────────────────────────────────────
-- Orgs — the tenant root. An org owns a pack: the skills, workflows
-- and taxonomy that describe how one organization works. The pack
-- itself lives outside this repo; only the loader is here.
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS orgs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  slug       TEXT    NOT NULL UNIQUE,
  name       TEXT    NOT NULL,
  pack_path  TEXT,
  pack_rev   TEXT,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ─────────────────────────────────────────────────────────────────
-- Projects
--
-- "isolation" decides where this project's rows live:
--   'silo'   → its own <project>/.myjarbis/memory.db (pre-v0.3 behaviour)
--   'shared' → the global DB, discriminated by project_id
-- The column defaults to 'silo' on purpose: forgetting to set it keeps
-- a project isolated, which is the fail-safe direction.
--
-- "git_remote" is the normalised origin URL, used to resolve the project
-- from any working directory inside the repo.
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS projects (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL UNIQUE,
  path       TEXT    NOT NULL UNIQUE,
  framework  TEXT,
  org_id     INTEGER REFERENCES orgs(id),
  git_remote TEXT,
  isolation  TEXT    NOT NULL DEFAULT 'silo'
             CHECK (isolation IN ('silo', 'shared')),
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ─────────────────────────────────────────────────────────────────
-- Project context (core: practices, deps, conventions, specs)
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS project_context (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind         TEXT    NOT NULL,
  title        TEXT    NOT NULL,
  content      TEXT    NOT NULL,
  tags         TEXT,
  source_path  TEXT,
  content_hash TEXT    NOT NULL,
  -- Stable, human-readable identity of the TOPIC this row covers
  -- ('environment/local-setup'). Lets a re-import update the row that
  -- already covers the subject instead of adding a competing one.
  topic_key    TEXT,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, source_path, kind)
);
CREATE INDEX IF NOT EXISTS idx_project_context_project ON project_context(project_id);
CREATE INDEX IF NOT EXISTS idx_project_context_kind    ON project_context(kind);

-- ─────────────────────────────────────────────────────────────────
-- Context kinds — the taxonomy, as a catalogue instead of free text.
--
-- "kind" on project_context / module_context used to be any string the
-- agent felt like. Three projects produced three vocabularies for the
-- same seven ideas, so no query could assume a label existed. Rows here
-- are the allowed values; a pack may add its own with org_id set.
--
-- Not a CHECK constraint on purpose: SQLite would force a table rebuild
-- to add one label, which would make packs unable to extend it.
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS context_kinds (
  slug        TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  description TEXT,
  org_id      INTEGER REFERENCES orgs(id),   -- NULL = generic core kind
  position    INTEGER NOT NULL DEFAULT 100
);
CREATE INDEX IF NOT EXISTS idx_context_kinds_org ON context_kinds(org_id);

-- ─────────────────────────────────────────────────────────────────
-- Modules (verticales creadas explícitamente por el user)
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS modules (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT    NOT NULL,
  description TEXT,
  status      TEXT    NOT NULL DEFAULT 'active'
              CHECK (status IN ('active', 'paused', 'done')),
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, name)
);
CREATE INDEX IF NOT EXISTS idx_modules_project ON modules(project_id);

-- ─────────────────────────────────────────────────────────────────
-- Module context (workflow, plan, stories, AC, use cases)
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS module_context (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  module_id    INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  kind         TEXT    NOT NULL,
  title        TEXT    NOT NULL,
  content      TEXT    NOT NULL,
  tags         TEXT,
  source_path  TEXT,
  content_hash TEXT    NOT NULL,
  -- Free-form markdown the agent maintains per row to track current state
  -- (story status, smoke status, commit refs, dates). Independent of
  -- content (immutable post-import) and tags (FTS5-indexed labels).
  -- NULL until the agent writes via update_progress.
  progress     TEXT,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(module_id, source_path, kind, title)
);
CREATE INDEX IF NOT EXISTS idx_module_context_module ON module_context(module_id);
CREATE INDEX IF NOT EXISTS idx_module_context_kind   ON module_context(kind);

-- ─────────────────────────────────────────────────────────────────
-- Skills (project-level si module_id NULL, module-level si NOT NULL)
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS skills (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  module_id       INTEGER REFERENCES modules(id) ON DELETE CASCADE,
  name            TEXT    NOT NULL,
  description     TEXT,
  trigger_pattern TEXT,
  content         TEXT    NOT NULL,
  content_hash    TEXT    NOT NULL,
  enabled         INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, module_id, name)
);
CREATE INDEX IF NOT EXISTS idx_skills_project ON skills(project_id);
CREATE INDEX IF NOT EXISTS idx_skills_module  ON skills(module_id);
CREATE INDEX IF NOT EXISTS idx_skills_enabled ON skills(enabled);

-- ─────────────────────────────────────────────────────────────────
-- Sessions (siempre dentro de un módulo)
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sessions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  module_id    INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  started_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  ended_at     TEXT,
  summary      TEXT,
  next_session TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_module     ON sessions(module_id);
CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON sessions(started_at);

-- ─────────────────────────────────────────────────────────────────
-- Observations (decisions, gotchas, progress, ...)
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS observations (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id     INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  -- Denormalised on purpose. A note only reached its project through
  -- session_id → modules → projects, so every scoped read needed a
  -- three-table join on the hot path. With a global DB that join is also
  -- the only thing standing between two tenants, which is too thin.
  project_id     INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  kind           TEXT    NOT NULL,
  title          TEXT    NOT NULL,
  content        TEXT    NOT NULL,
  story_local_id TEXT,
  files          TEXT,
  tags           TEXT,
  -- Topic identity: save_observation with an existing topic_key updates
  -- that row instead of stacking a new one. Replaces the habit of writing
  -- "SUPERSEDES note 80" into the title.
  topic_key      TEXT,
  supersedes     INTEGER REFERENCES observations(id),
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_observations_session ON observations(session_id);
CREATE INDEX IF NOT EXISTS idx_observations_kind    ON observations(kind);
CREATE INDEX IF NOT EXISTS idx_observations_story   ON observations(story_local_id);

-- ─────────────────────────────────────────────────────────────────
-- Refs — typed links from a note to something outside the brain.
--
-- These used to live in prose ("already posted comments 4-29337..30341"),
-- which turns the memory into an idempotency ledger it has no structure
-- to be. "find_by_ref" answers "did I already do this?" with a row lookup.
--
-- The git log stays the source of truth for commits: we store the link,
-- never a copy of the message.
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS refs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  observation_id INTEGER NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
  kind           TEXT    NOT NULL,   -- commit | mr | ticket | comment | worklog
  provider       TEXT    NOT NULL,   -- 'git' | whatever the project configured
  external_id    TEXT    NOT NULL,
  url            TEXT,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(observation_id, provider, kind, external_id)
);
CREATE INDEX IF NOT EXISTS idx_refs_obs    ON refs(observation_id);
CREATE INDEX IF NOT EXISTS idx_refs_lookup ON refs(provider, kind, external_id);

-- ─────────────────────────────────────────────────────────────────
-- Project state — the living "resume here", as one row per project.
--
-- Previously each session wrote a brand new observation titled "RESUME
-- HERE", so the current state was whichever of N notes happened to be
-- newest. One row that gets overwritten makes "current" unambiguous.
--
-- locked_by/locked_at let a second session see that another one is
-- writing. The lock is advisory and expires: a lock without a TTL
-- wedges the project shut whenever a process dies holding it.
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS project_state (
  project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  content    TEXT    NOT NULL,
  updated_at TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_by TEXT,
  locked_by  TEXT,
  locked_at  TEXT
);

-- ─────────────────────────────────────────────────────────────────
-- Workflows — the process, as rows with inheritance.
--
-- The way work flows used to be prose, duplicated across a skill, a
-- project_context row and another skill, with no way to tell which one
-- won. Three consecutive decisions once contradicted each other about
-- when to stop and ask for approval: that is a field changing value,
-- written as three documents.
--
-- Resolution order: user overrides project overrides org.
-- "capability" is deliberately abstract ('tracker.comment', never the
-- name of a product): which tool that means is a providers row, so the
-- same org workflow serves a client on one tracker and a client on
-- another, and the core never learns a vendor's name.
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS workflows (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  slug       TEXT    NOT NULL,
  name       TEXT    NOT NULL,
  scope      TEXT    NOT NULL CHECK (scope IN ('org', 'project', 'user')),
  scope_id   INTEGER NOT NULL,
  extends    INTEGER REFERENCES workflows(id),
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  -- 0 = a child: invocable only from a parent's "uses" step, and hidden from
  -- the list a user picks from. A ritual that is only ever a fragment of
  -- another ritual should not be offered as one.
  --
  -- Declared LAST, after created_at, and that position is not cosmetic:
  -- ALTER TABLE ADD COLUMN can only append, so a brain that migrated has this
  -- column last. The brain dump writes each row's keys in PHYSICAL column
  -- order, so declaring it anywhere else would make a created brain and a
  -- migrated brain emit the same rows with the keys in a different order --
  -- a file that conflicts in git for no reason anybody can see.
  standalone INTEGER NOT NULL DEFAULT 1,
  UNIQUE(slug, scope, scope_id)
);
CREATE INDEX IF NOT EXISTS idx_workflows_slug ON workflows(slug);

CREATE TABLE IF NOT EXISTS workflow_steps (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id INTEGER NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  name        TEXT    NOT NULL,
  actor       TEXT    NOT NULL,   -- agent | human | a role name
  gate        TEXT    NOT NULL DEFAULT 'none'
              CHECK (gate IN ('none', 'approve', 'on-request')),
  capability  TEXT,
  -- Structured condition. Free text here would reintroduce exactly what
  -- this table exists to remove: process semantics the agent reinterprets
  -- differently every session. A gate has to be decidable, so it is
  -- expressed as "<field><op><value>" clauses (see workflows/condition.ts);
  -- anything advisory belongs in "notes".
  condition   TEXT,
  notes       TEXT,
  -- DEPRECATED, always NULL, no reader and no writer. A step overrides
  -- another by sharing its name in a more specific layer, which is what
  -- the resolver keys on; this column was a second way to say that and was
  -- never wired to anything.
  --
  -- Kept rather than dropped: DROP COLUMN would have to be tolerated in the
  -- migration runner, whose error filter currently swallows only "duplicate
  -- column" and "already exists". Teaching it to also swallow "no such
  -- column" would make every future migration with a mistyped column name
  -- fail silently instead of loudly. That is a bad trade for deleting a
  -- column that costs nothing.
  overrides   INTEGER REFERENCES workflow_steps(id),
  disabled    INTEGER NOT NULL DEFAULT 0,
  -- The slug of another workflow to run at this point. A step either
  -- delegates (uses) or acts (capability), never both -- a rule the
  -- repository enforces, because SQLite cannot add a table-level CHECK to an
  -- existing table and a constraint that only a new database has is worse
  -- than one nobody has.
  --
  -- This is invocation, not inheritance. "extends" says "my steps start from
  -- that workflow's steps", flattened under my own names; "uses" says "at
  -- this position, run that workflow", and its steps arrive namespaced and
  -- still owned by it.
  --
  -- Declared last for the same reason as workflows.standalone: ALTER TABLE
  -- can only append, and the brain dump writes keys in physical column order.
  uses        TEXT,
  UNIQUE(workflow_id, name)
);
CREATE INDEX IF NOT EXISTS idx_wfs_workflow ON workflow_steps(workflow_id, position);

-- ─────────────────────────────────────────────────────────────────
-- Providers — what a project actually talks to.
--
-- NEVER store a secret in "config". This table is exported by the brain
-- dump and can end up in a git repo; credentials stay in files outside
-- the DB with 0600 permissions. Writes go through a validator that
-- rejects secret-looking keys (see providers.ts).
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS providers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  role       TEXT    NOT NULL,   -- tracker | forge | ci
  kind       TEXT    NOT NULL,   -- the concrete provider's name
  config     TEXT,               -- JSON: base URL, wrapper command, ids
  UNIQUE(project_id, role)
);

-- ─────────────────────────────────────────────────────────────────
-- Seed the core taxonomy. INSERT OR IGNORE so this is a no-op on an
-- existing DB and so a pack's own kinds are never clobbered.
--
-- Two families, both generic — none of these names an organization, a
-- client or a product:
--   · subject kinds, which answer "what area is this about"
--   · document kinds, which answer "what sort of document is this"
-- The second family already existed as a TypeScript union and came out
-- uniform across projects precisely because code fixed it; it is listed
-- here so existing imports keep validating.
-- ─────────────────────────────────────────────────────────────────
INSERT OR IGNORE INTO context_kinds (slug, label, description, position) VALUES
  ('stack',               'Stack',               'What the project is and what it is built with',  10),
  ('environment',         'Environment',         'How to run it locally',                          20),
  ('domain',              'Domain',              'The business in ten minutes',                    30),
  ('process',             'Process',             'How work flows: cycle, gates, who does what',    40),
  ('decisions',           'Decisions',           'Decision log',                                   50),
  ('gotchas',             'Gotchas',             'Traps and non-obvious behaviour',                60),
  ('logbook',             'Logbook',             'Living state / where to resume',                 70),

  ('practice',            'Practice',            'A practice the project follows',                100),
  ('dependency',          'Dependency',          'A dependency and how it is used',               110),
  ('convention',          'Convention',          'Naming, layout and style conventions',          120),
  ('functional_spec',     'Functional spec',     'What the product must do',                      130),
  ('tracker_rules',      'Tracker rules',        'How issues are tracked and reported',           140),
  ('error_log',           'Error log',           'Known failures and their resolutions',          150),
  ('design_guideline',    'Design guideline',    'Visual and interaction rules',                  160),
  ('workflow',            'Workflow',            'A documented sequence of work steps',           170),
  ('plan',                'Plan',                'Roadmap or plan of record',                     180),
  ('functional_doc',      'Functional doc',      'Detailed behaviour of one area',                190),
  ('use_cases',           'Use cases',           'Use cases, typically one per screen',           200),
  ('acceptance_criteria', 'Acceptance criteria', 'Conditions a story must satisfy',               210),
  ('story',              'Story',                'A unit of work with a local id',                220),
  ('context',            'Context',              'Module-level background',                       230),

  ('other',              'Other',                'Does not fit another kind',                     900),
  ('misc',               'Misc',                 'Unclassified; migrated from an unknown label',  999),

  -- Deprecated: named a specific commercial tracker in a vocabulary that
  -- has to stay vendor-neutral. Still listed so rows already written
  -- against it remain valid; new writes are redirected to tracker_rules
  -- (see DEPRECATED_CONTEXT_KINDS). Which tracker a project uses lives in
  -- "providers", where it can differ per project.
  ('jira_rules',         'Tracker rules (legacy)',
   'Deprecated — use tracker_rules; the tracker itself belongs in providers', 141);

-- ─────────────────────────────────────────────────────────────────
-- FTS5 virtual tables (contentless, mirror searchable columns)
-- ─────────────────────────────────────────────────────────────────
CREATE VIRTUAL TABLE IF NOT EXISTS project_context_fts USING fts5(
  title, content, tags,
  content='project_context',
  content_rowid='id'
);

CREATE VIRTUAL TABLE IF NOT EXISTS module_context_fts USING fts5(
  title, content, tags,
  content='module_context',
  content_rowid='id'
);

CREATE VIRTUAL TABLE IF NOT EXISTS skills_fts USING fts5(
  name, description, content,
  content='skills',
  content_rowid='id'
);

CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
  title, content, tags, story_local_id,
  content='observations',
  content_rowid='id'
);

-- ─────────────────────────────────────────────────────────────────
-- Triggers: keep FTS5 tables in sync with main tables
-- ─────────────────────────────────────────────────────────────────
CREATE TRIGGER IF NOT EXISTS project_context_ai AFTER INSERT ON project_context BEGIN
  INSERT INTO project_context_fts(rowid, title, content, tags)
  VALUES (new.id, new.title, new.content, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS project_context_ad AFTER DELETE ON project_context BEGIN
  INSERT INTO project_context_fts(project_context_fts, rowid, title, content, tags)
  VALUES('delete', old.id, old.title, old.content, old.tags);
END;
CREATE TRIGGER IF NOT EXISTS project_context_au AFTER UPDATE ON project_context BEGIN
  INSERT INTO project_context_fts(project_context_fts, rowid, title, content, tags)
  VALUES('delete', old.id, old.title, old.content, old.tags);
  INSERT INTO project_context_fts(rowid, title, content, tags)
  VALUES (new.id, new.title, new.content, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS module_context_ai AFTER INSERT ON module_context BEGIN
  INSERT INTO module_context_fts(rowid, title, content, tags)
  VALUES (new.id, new.title, new.content, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS module_context_ad AFTER DELETE ON module_context BEGIN
  INSERT INTO module_context_fts(module_context_fts, rowid, title, content, tags)
  VALUES('delete', old.id, old.title, old.content, old.tags);
END;
CREATE TRIGGER IF NOT EXISTS module_context_au AFTER UPDATE ON module_context BEGIN
  INSERT INTO module_context_fts(module_context_fts, rowid, title, content, tags)
  VALUES('delete', old.id, old.title, old.content, old.tags);
  INSERT INTO module_context_fts(rowid, title, content, tags)
  VALUES (new.id, new.title, new.content, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS skills_ai AFTER INSERT ON skills BEGIN
  INSERT INTO skills_fts(rowid, name, description, content)
  VALUES (new.id, new.name, new.description, new.content);
END;
CREATE TRIGGER IF NOT EXISTS skills_ad AFTER DELETE ON skills BEGIN
  INSERT INTO skills_fts(skills_fts, rowid, name, description, content)
  VALUES('delete', old.id, old.name, old.description, old.content);
END;
CREATE TRIGGER IF NOT EXISTS skills_au AFTER UPDATE ON skills BEGIN
  INSERT INTO skills_fts(skills_fts, rowid, name, description, content)
  VALUES('delete', old.id, old.name, old.description, old.content);
  INSERT INTO skills_fts(rowid, name, description, content)
  VALUES (new.id, new.name, new.description, new.content);
END;

CREATE TRIGGER IF NOT EXISTS observations_ai AFTER INSERT ON observations BEGIN
  INSERT INTO observations_fts(rowid, title, content, tags, story_local_id)
  VALUES (new.id, new.title, new.content, new.tags, new.story_local_id);
END;
CREATE TRIGGER IF NOT EXISTS observations_ad AFTER DELETE ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, title, content, tags, story_local_id)
  VALUES('delete', old.id, old.title, old.content, old.tags, old.story_local_id);
END;
CREATE TRIGGER IF NOT EXISTS observations_au AFTER UPDATE ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, title, content, tags, story_local_id)
  VALUES('delete', old.id, old.title, old.content, old.tags, old.story_local_id);
  INSERT INTO observations_fts(rowid, title, content, tags, story_local_id)
  VALUES (new.id, new.title, new.content, new.tags, new.story_local_id);
END;

-- updated_at is touched explicitly by the application layer in the
-- corresponding UPSERT statements (db/index.ts). We avoid AFTER UPDATE
-- "touch" triggers here because they cascade with the FTS5 sync triggers
-- and can corrupt the contentless FTS5 index (SQLITE_CORRUPT_VTAB) when
-- the same row receives two UPDATEs in the same statement.

-- ─────────────────────────────────────────────────────────────────
-- v5 objects. Same declarations MIGRATIONS[5] applies to an existing
-- file, so the two paths cannot produce different schemas.
-- ─────────────────────────────────────────────────────────────────
${V5_OBJECTS.map((stmt) => `${stmt};`).join('\n\n')}
`;

/**
 * Every FTS5 mirror in the schema, declared once.
 *
 * It was spelled out three times — `MyJarbisDB.rebuildFts`, `importBrain`'s
 * post-import pass, and `mergeBrain`'s post-remap pass — and a new index added
 * to two of the three would have been invisible: a contentless FTS table that
 * nobody rebuilds after rows are re-inserted with explicit ids still answers
 * queries, it just resolves hits to the wrong rows. The hit looks legitimate.
 *
 * So the list is data, and adding a mirror updates every rebuild at once.
 */
export const FTS_TABLES = [
  'project_context_fts',
  'module_context_fts',
  'skills_fts',
  'observations_fts',
  'org_note_content_fts',
] as const;

// ───────────────────────────────────────────────────────────────────
// TypeScript row types (1:1 with table columns)
// ───────────────────────────────────────────────────────────────────

export interface OrgRow {
  id: number;
  slug: string;
  name: string;
  pack_path: string | null;
  pack_rev: string | null;
  created_at: string;
}

/** Where a project's rows live. 'silo' = its own file (pre-v0.3 default),
 *  'shared' = the global DB discriminated by project_id. */
export type Isolation = 'silo' | 'shared';

export interface ProjectRow {
  id: number;
  name: string;
  path: string;
  framework: string | null;
  org_id: number | null;
  git_remote: string | null;
  isolation: Isolation;
  created_at: string;
}

export interface ContextKindRow {
  slug: string;
  label: string;
  description: string | null;
  org_id: number | null;
  position: number;
}

export type RefKind = 'commit' | 'mr' | 'ticket' | 'comment' | 'worklog';

export interface RefRow {
  id: number;
  observation_id: number;
  kind: RefKind;
  provider: string;
  external_id: string;
  url: string | null;
  created_at: string;
}

export interface ProjectStateRow {
  project_id: number;
  content: string;
  updated_at: string;
  updated_by: string | null;
  locked_by: string | null;
  locked_at: string | null;
}

export type WorkflowScope = 'org' | 'project' | 'user';

export interface WorkflowRow {
  id: number;
  slug: string;
  name: string;
  scope: WorkflowScope;
  scope_id: number;
  extends: number | null;
  /** 0 = invocable only from a parent's `uses` step, hidden from the list. */
  standalone: number;
  created_at: string;
}

export type StepGate = 'none' | 'approve' | 'on-request';

export interface WorkflowStepRow {
  id: number;
  workflow_id: number;
  position: number;
  name: string;
  actor: string;
  gate: StepGate;
  capability: string | null;
  /** Slug of a workflow to run here. Mutually exclusive with `capability`. */
  uses: string | null;
  condition: string | null;
  notes: string | null;
  /** @deprecated Always NULL. See the column comment in SCHEMA_SQL. */
  overrides: number | null;
  disabled: number;
}

// ───────────────────────────────────────────────────────────────────
// Org memory (v5)
// ───────────────────────────────────────────────────────────────────

/** Where a note is in its life. There is no row removal: a wrong lesson
 *  has to stay readable with its provenance, or it gets re-learned and
 *  re-recorded by the next person. */
export type OrgNoteStatus = 'active' | 'stale' | 'superseded' | 'deleted';

/** `verified` requires `evidence` — a commit, a merge request or a path
 *  somebody can open. Without one the note is `assumed` and is reachable by
 *  search but never surfaced proactively. */
export type OrgNoteConfidence = 'assumed' | 'verified';

/** How the author's handle was obtained, so a fallback is visibly a
 *  fallback rather than a name somebody chose. */
export type AuthorSource = 'git' | 'config' | 'fallback';

export interface OrgNoteRow {
  id: number;
  org_id: number;
  /** NULL = the note applies across the org, not to one project. */
  project_id: number | null;
  source_observation_id: number | null;
  author_handle: string;
  author_email: string | null;
  author_source: AuthorSource;
  created_at: string;
  promoted_at: string;
  updated_at: string | null;
  status: OrgNoteStatus;
  supersedes_id: number | null;
  expires_at: string | null;
  confidence: OrgNoteConfidence;
  evidence: string | null;
  /** JSON: Array<{ path: string; blob_sha: string }> */
  code_refs: string | null;
  content_hash: string;
  /** Local, monotonic per org. Not an identity; see the column comment. */
  seq: number;
  drift_checked_at: string | null;
  drift_changed: number | null;
}

export interface OrgNoteContentRow {
  note_id: number;
  question: string;
  answer: string;
  working_example: string | null;
  caveats: string | null;
  tool_tags: string | null;
  type_tags: string | null;
  linked_ids: string | null;
}

// ───────────────────────────────────────────────────────────────────
// Workflow runs (v5)
// ───────────────────────────────────────────────────────────────────

export type WorkflowRunStatus = 'open' | 'done' | 'abandoned';

/** `blocked` is what a step becomes when the session died under it: not
 *  done, not skipped on purpose, and not still waiting. */
export type RunStepStatus = 'pending' | 'active' | 'done' | 'skipped' | 'blocked';

export interface WorkflowRunRow {
  id: number;
  project_id: number;
  slug: string;
  session_id: number | null;
  started_at: string;
  ended_at: string | null;
  status: WorkflowRunStatus;
}

export interface WorkflowRunStepRow {
  id: number;
  run_id: number;
  position: number;
  /** Namespaced (`child-slug/step-name`) for a step that came from a child. */
  step_name: string;
  from_workflow: string;
  status: RunStepStatus;
  started_at: string | null;
  completed_at: string | null;
  actor: string | null;
  note: string | null;
}

export type ProviderRole = 'tracker' | 'forge' | 'ci';

export interface ProviderRow {
  id: number;
  project_id: number;
  role: ProviderRole;
  kind: string;
  config: string | null;
}

/** Slugs seeded into `context_kinds` by SCHEMA_SQL. Listed for
 *  autocomplete and for the migration mapping; the authoritative set is
 *  the table, because a pack may add to it. */
export type KnownContextKind =
  // subject kinds: what area is this about
  | 'stack'
  | 'environment'
  | 'domain'
  | 'process'
  | 'decisions'
  | 'gotchas'
  | 'logbook'
  // document kinds: what sort of document is this
  | 'practice'
  | 'dependency'
  | 'convention'
  | 'functional_spec'
  | 'tracker_rules'
  /** @deprecated vendor-specific; use 'tracker_rules'. Kept so rows
   *  already written against it still type-check. */
  | 'jira_rules'
  | 'error_log'
  | 'design_guideline'
  | 'workflow'
  | 'plan'
  | 'functional_doc'
  | 'use_cases'
  | 'acceptance_criteria'
  | 'story'
  | 'context'
  | 'other'
  | 'misc';

/** A context kind is validated against `context_kinds` at write time, not
 *  by the type system: packs extend the catalogue, so a closed union here
 *  would make a valid pack kind a compile error. `(string & {})` keeps
 *  autocomplete on the known slugs while accepting the rest. */
export type ContextKind = KnownContextKind | (string & {});

/** Labels seen in the wild, mapped onto catalogue slugs. Anything absent
 *  here and absent from the catalogue migrates to 'misc' — deliberately
 *  NOT to 'gotchas', which is read on every session start: dumping
 *  unclassified rows there would poison the one kind that is always read. */
export const CONTEXT_KIND_ALIASES: Record<string, KnownContextKind> = {
  dominio: 'domain',
  runbook: 'environment',
  entorno: 'environment',
  decision: 'decisions',
  gotcha: 'gotchas',
  bitacora: 'logbook',
  'bitácora': 'logbook',
  logbok: 'logbook',
  proceso: 'process',
  stack_tecnologico: 'stack',
};

/**
 * Slugs that still exist in the catalogue, for rows already written against
 * them, but that NEW writes get redirected away from. Checked before the
 * catalogue lookup, which is the only way a redirect can fire for a slug
 * that is itself still valid.
 *
 * `jira_rules` is the case this exists for. It named a specific commercial
 * tracker inside the one vocabulary that is supposed to be vendor-neutral —
 * the same mistake the `capability` design avoids by saying
 * `tracker.comment` instead of naming a product. Which tracker a project
 * actually uses belongs in `providers`, where it can differ per project;
 * baking one vendor into a shared label makes the taxonomy un-portable the
 * moment a second client uses something else.
 */
export const DEPRECATED_CONTEXT_KINDS: Record<string, KnownContextKind> = {
  jira_rules: 'tracker_rules',
};

export interface ProjectContextRow {
  id: number;
  project_id: number;
  kind: ContextKind;
  title: string;
  content: string;
  tags: string | null;
  source_path: string | null;
  content_hash: string;
  topic_key: string | null;
  created_at: string;
  updated_at: string;
}

export type ModuleStatus = 'active' | 'paused' | 'done';

export interface ModuleRow {
  id: number;
  project_id: number;
  name: string;
  description: string | null;
  status: ModuleStatus;
  created_at: string;
}

export interface ModuleContextRow {
  id: number;
  module_id: number;
  kind: ContextKind;
  title: string;
  content: string;
  tags: string | null;
  source_path: string | null;
  content_hash: string;
  progress: string | null;
  created_at: string;
  updated_at: string;
}

export interface SkillRow {
  id: number;
  project_id: number;
  module_id: number | null;
  name: string;
  description: string | null;
  trigger_pattern: string | null;
  content: string;
  content_hash: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface SessionRow {
  id: number;
  module_id: number;
  started_at: string;
  ended_at: string | null;
  summary: string | null;
  next_session: string | null;
}

/**
 * Prefix stamped on every machine-written `summary` / `next_session`.
 *
 * It lives here rather than beside the code that writes it (tools/autoClose)
 * because the db layer has to tell a generated resume point from a curated one
 * in SQL — `sessions.findLastCuratedByModule` filters on it — and the db layer
 * must not import from tools/. `tools/autoClose.ts` re-exports it, so
 * `import { AUTO_MARKER } from './autoClose.js'` keeps working.
 */
export const AUTO_MARKER = '[auto]';

export type ObservationKind =
  | 'decision'
  | 'gotcha'
  | 'progress'
  | 'error'
  | 'discovery';

export interface ObservationRow {
  id: number;
  session_id: number;
  project_id: number | null;
  kind: ObservationKind;
  title: string;
  content: string;
  story_local_id: string | null;
  files: string | null;
  tags: string | null;
  topic_key: string | null;
  supersedes: number | null;
  created_at: string;
  updated_at: string | null;
}

export interface MetaRow {
  key: string;
  value: string;
}
