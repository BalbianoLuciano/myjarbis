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

export const SCHEMA_VERSION = 4;

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
  overrides   INTEGER REFERENCES workflow_steps(id),
  disabled    INTEGER NOT NULL DEFAULT 0,
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
  ('jira_rules',          'Tracker rules',       'How issues are tracked and reported',           140),
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
  ('misc',               'Misc',                 'Unclassified; migrated from an unknown label',  999);

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
`;

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
  condition: string | null;
  notes: string | null;
  overrides: number | null;
  disabled: number;
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
 *  NOT to 'gotchas', which the session hook loads on every start: dumping
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
