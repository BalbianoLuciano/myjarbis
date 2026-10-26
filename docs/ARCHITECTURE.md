# MyJarbis Architecture

What MyJarbis is and what it is built with, as of **v0.5.0 (schema v5)**.

This file replaces a version that described v0.1 — MCP *resources* under
`myjarbis://{project}/memory/...` and three tools — an API removed in v0.2.
It had been loaded into every session as `kind=convention` since May, which
put a three-version-old design at precedence #2. It is `kind=stack` now,
because that is what the catalogue calls "what the project is and what it is
built with". Architecture is not a convention.

## The problem it solves

Claude Code forgets everything between sessions, and a flat memory file does
not scale: a project has verticals, and loading all of them to work on one
burns the context window on things that do not apply.

So MyJarbis is an MCP server that sits **on top of** Claude Code and provides
two things: memory that persists per project, and scope so only the relevant
slice rides the system prompt.

## The two layers

| Layer | Holds | Loaded when |
|---|---|---|
| **project** | conventions, stack, practices, specs — anything true across the whole repo | always, as an index of excerpts |
| **module** | one vertical (`auth`, `mcp-server`, `entrevistas`): its workflow, plan, stories, module-level skills | only the active one |

## The two memories

Separate from the two layers above, and the distinction is the point: the
layers are about SCOPE within one developer's brain, this is about who can
read a thing at all.

| | Holds | Travels |
|---|---|---|
| **personal** | everything: sessions, handoffs, observations, the living state | never. It is one file on one machine |
| **org** | only promoted notes — durable lessons with an author, an expiry and a confidence | yes, as files committed in the project repo |

The split is STRUCTURAL rather than a setting. `org_notes` has no
`session_id`, no `summary`, no `next_session` and no free-text body, and the
only door into it is `promote_observation`, which takes one observation id.
"A conversation cannot leak into the team memory" is therefore a property of
the schema, not a promise about behaviour.

Promotion is proposed and never automatic. SAP, who deployed the same idea
inside a large company, reported that 417 of 900 contributed learnings —
46.3% — produced no memory at all, nearly all because the knowledge was
already there. Roughly half of what gets offered should be refused, so an
agent promoting on its own judgement fills a shared store with the half
nobody needed.

A session is always open **in one module**. `search` defaults to
`scope=module`, which means the active module plus the project core; widening
to `scope=project` is an explicit act. This is the whole point: 23 projects
and 115 modules share one database, and a session reads a knowable slice of it.

## Storage

**SQLite + FTS5**, 35 tables counting the FTS shadow tables. The ones that
matter:

- `projects`, `modules` — the two layers.
- `project_context`, `module_context` — documents, typed by `kind` from a
  catalogue (`context_kinds`), not free text. Each has an FTS5 mirror.
- `observations` — what was learned, with `topic_key` + `supersedes` so saving
  again **updates** a note instead of adding a rival to it.
- `sessions` — one row per working block, with `summary` and `next_session`:
  the handoff.
- `project_state` — the living "resume here", a single row that gets
  overwritten, with an advisory lock that expires so a dead process cannot
  wedge the project.
- `skills`, `workflows`, `workflow_steps`, `providers`, `orgs`, `refs`.
- `org_notes` + `org_note_content` — the org memory, split in two so a status
  change (the most frequent write it has) never touches the contentless FTS
  index. Keyed by `UNIQUE(org_id, content_hash)`: deduplication is a
  constraint, not a check the application performs before inserting.
- `workflow_runs` + `workflow_run_steps` — where a ritual got to and how long
  each step took. `get_workflow` says what the process is; these say where you
  were in it, which used to live in whatever prose went into `next_session`.

Retrieval is pure FTS5 and stays that way. Hybrid/vector was measured and
rejected: at this scale the deciding axis is latency, not recall.

### Where the database lives

Two shapes, and resolution tries them in that order:

1. **silo** — `<project>/.myjarbis/memory.db`, one file per project.
2. **shared brain** — `~/.myjarbis/memory.db`, every project as rows.

`resolveProject()` (`global/mcp-server/src/resolve.ts`) matches a directory to
a project by, in order: an explicit name (`--project` or `MYJARBIS_PROJECT`),
the **git remote**, the **path**, or single-tenancy. The remote comes before
the path so a clone to a different directory still resolves. A silo next to
the project wins over the shared brain, so a project that never migrated keeps
working untouched.

`myjarbis migrate` upgrades a brain (backing it up first); `myjarbis merge`
moves a silo into the shared one. Neither is automatic — a schema change
should be something you chose, with a backup you know about.

## The MCP surface

**38 tools: 21 always loaded, 17 deferred.** Deferred tools are advertised by
name and their schemas are fetched on demand, which keeps the system prompt
small without hiding capability.

Two of the v0.5 tools are deliberately NOT deferred. `promote_observation` is
offered at a session close, and `start_workflow_run` matters most when the
context is already tight — a tool whose schema has to be fetched first is a
tool the agent skips at exactly those moments.

Always loaded — discovery, session lifecycle, read, write:

```
current_project · list_modules · start_session · end_session · resume
load_project_core · load_module · search
save_observation · update_progress · suggest_topic_key · update_observation
find_by_ref · add_ref · get_project_state · set_project_state
get_workflow · list_workflows
promote_observation · start_workflow_run · advance_workflow_step
```

Deferred: module/skill administration, imports, org packs, providers,
interaction style, and the three v0.1 legacy aliases (`search_code`,
`get_context`, `update_memory`).

The canonical read pattern is `search` first (cheap, returns snippets with row
ids), then `load_module(row_ids=[...])` for the one or two bodies that matter.
Loading a whole kind with `full=true` on a large module returns 100KB+ and
drowns the context.

## Sessions and the handoff

`start_session` opens a session in a module and returns the project index, the
module context, and the previous session's `next_session` — the "resume here".

A session can have **companion modules**: `start_session(module,
with_modules=[...])`, or `myjarbis module use cli,server` before opening
Claude. `.myjarbis/active` holds the list, primary on line one, which is where
the single-module reader already looked — so this is a file format change and
not a migration.

The asymmetry is the design. Everything that WRITES needs exactly one home:
`sessions.module_id` is a single column, and a handoff that exists in three
copies is three handoffs to reconcile. So companions are read-only — their
rows are searchable (`scope="module"` spans the open set and reports which
modules it searched) and they arrive at index depth, a row count and a last-
activity date rather than bodies. `save_observation` takes a `module` to file
one note under a companion; because a note reaches its module only through
`session_id`, that opens a sidecar session in the target, writes, and closes it
with no `next_session` — so it can never become that module's "resume here".

`end_session` closes it with a summary and the next handoff. The agent is
supposed to write both, which is what `/jarbis-close` exists to make reflexive.

If the agent never closes it, the **SessionEnd hook does**, with a synthetic
`[auto]` summary. That is a safety net, not a substitute: it records activity
("three commits happened") where a handoff states intent ("do this next").
Because a synthetic close is always the newest close, it used to bury the last
hand-written handoff; `start_session` and `resume` now also return
`curatedResume` when the newest close is machine-written, with its own
staleness clock and the count of closes burying it. Session recency is ordered
by `(ended_at, id)` — ids are not in close order.

That net closes only sessions it can establish do not belong to another running
editor. Claude Code starts the new process's `SessionStart` before the exiting
one's `SessionEnd`, so closing every open session in the project meant a restart
closed the session the user had just been given — and stamped a synthetic
"nothing was recorded" over it, which then buried the real handoff one level
deeper. Each hook receives Claude's own `session_id`, `SessionStart` writes a
claim for the sessions it opens under `~/.myjarbis/run/`, and `SessionEnd`
leaves claimed sessions to their owner. Unclaimed sessions are still closed,
which is the case the net was built for.

## Skills, commands, and how they reach a project

Two different artifacts with two different propagation paths. This is the
distinction most likely to bite:

| | Lives as | Seeded by | Propagated by |
|---|---|---|---|
| **skills** (11 baselines) | rows in the brain, materialised to `.claude/skills/myjarbis-*/` | `init` | `myjarbis skill reseed [--all]` |
| **workflows** (4 baselines) | rows, three layers deep | `init` | `myjarbis workflow reseed [--all]` |
| **org memory** | rows, mirrored from committed files | `org pull` | `org push` + a commit by a person |
| **slash commands** (`/jarbis`, `/jarbis-close`) | files in `.claude/commands/` | `init` | `myjarbis commands sync [--all]` |
| **org packs** | rows, from a directory you own | `org add` | `myjarbis org sync <org>` |

Baselines: `session-protocol`, `observation-protocol`, `bitacora-progress`,
`commit-hygiene`, `compact-protocol`, `module-orchestration`, `story-driven`,
`framework-detect`, `subagent-delegation`, `interaction-style`,
`workflow-driven`.

The last one exists because of a gap worth naming: for two releases nothing
told the agent that workflows existed. `get_workflow` was in the precedence
list and in no skill, no hook and no bootstrap payload. A capability nobody is
told about configures nothing, which is why `start_session` now also returns
the reachable slugs — names only, measured against the bootstrap budget.

The rule that both paths exist to enforce: **anything seeded by `init` reaches
new projects only.** Every per-project artifact needs a propagation path on day
one, or improving it silently helps nobody who already uses the tool.

Two guards worth knowing. `skill reseed` refuses `interaction-style`, which is
composed per project from the user's language and persona, so every project
legitimately differs from the baseline. `commands sync` refuses a command file
a human edited (`diverged`) and asks for `--force` instead of guessing — but it
no longer confuses that with a stale copy of its own template: a file matching
any version the repo has ever shipped is recognised by git object name
(`old-shipped-version`) and updated without asking. Conflating the two is how a
template fix once stayed unpropagated across 23 projects while reading as done
in git.

Every slash command starts with `jarbis`: the slash menu is a flat namespace
shared with every other plugin, and the prefix is the only thing marking a
command as ours.

## The hooks

Five, shipped in `global/templates/.claude-plugin/` and copied into each
project by `init`. Claude Code provides the attachment points; the logic is
MyJarbis's, and each script just delegates to `cli.js hook <name>`.

| Hook | Fires | Does |
|---|---|---|
| `SessionStart` | Claude opens (`startup`/`clear`) | prints project, modules and the last handoff — in the project's language, read from `settings.json` because no agent exists yet |
| `SessionStart` | after `/compact` | re-surfaces the pre-compaction snapshot |
| `UserPromptSubmit` | every prompt | the memory-preference reminder, optional nudges |
| `Stop` | after **every** agent turn | nudges for a real summary; optional module-skill cleanup |
| `SessionEnd` | Claude actually closes | auto-closes any open session it does not find claimed by another running editor |

`Stop` firing per turn rather than at exit is why "remind the agent to close
the session" never worked, and why the real close lives in `SessionEnd`.

## Workflows: composition, and running one

A step can carry `uses: <slug>`, meaning "run that workflow here".
`get_workflow` still returns ONE flat ordered list; the child's steps arrive
namespaced (`commit-ritual/push`), each reporting which workflow owns it and
at what depth.

The ordering is the decision worth knowing, because it will look arbitrary in
six months: **layers resolve first, expansion happens over the resolved
list.** Expanding first would put the child's steps into the parent's name
space before the project and user layers key against it — so overriding one
child step would mean writing it into every parent that invokes the child,
three copies of one rule, which is the exact condition this table was created
to end. Resolving per slug keeps one owner per workflow: a project turns the
push gate off in `commit-ritual` once, and all three parents inherit it.

The cost is real: a parent cannot disable one step of a child. The escape
hatch — a parent-layer `disabled` row named `child/step`, applied as a filter
on the expanded list — is designed and deliberately unshipped, because it can
be added the first time somebody needs it instead of guessed at now.

`extends` answers a different question and stays: it means "my steps start
from that workflow's steps", flattened under my own names.

Four baselines ship, seeded by `init` at **project** scope — not org scope,
because a new project has `org_id = NULL` and an org-scope baseline would be
unreachable from every project on the machine. That is how this table came to
be fully implemented, tested, documented and empty in every brain for two
releases.

### How they get attached

Copying `.claude-plugin/` into a project does **not** attach anything. Claude
Code reads a plugin's `hooks/hooks.json` only for plugins installed from a
marketplace (`claude plugin install`), and never auto-discovers a
`.claude-plugin/` directory sitting in the working tree. For a long stretch
every project `init` touched had all five events dead — the scripts ran
correctly by hand, and `doctor` passed green because it checked that the files
existed, not that anything ran them.

What attaches them is a `hooks` block that `init` writes into
`.claude/settings.local.json` (`myjarbis hook install claude`, re-asserted by
`myjarbis update --projects`). That file is chosen deliberately: `init` already
gitignores it as per-developer state, so the wiring leaves nothing to commit in
a user's repo — the same reason `.claude-plugin/` itself stays untracked.

The write merges. Unrelated keys, and hooks the user added themselves, survive;
only MyJarbis's own entries — recognised by their command pointing into
`.claude-plugin/scripts/` — are replaced on a re-run. Malformed JSON is refused
rather than overwritten, because that file also carries the permission
allowlist. `myjarbis hook install claude --check` reports without writing, and
is what `doctor` now calls.

`hooks.json` is kept as the plugin manifest for a future marketplace install.
It is inert today.

## Precedence

MyJarbis replaces Claude Code's defaults rather than negotiating with them.
Strongest first:

1. What the user just said.
2. `project_context` kind=`convention`/`practice` for this project.
3. `get_workflow(slug)` — resolved steps and their gates.
4. Org pack skills (`overrides/` has already replaced the baselines).
5. The 11 baseline skills.
6. Claude Code defaults — only where MyJarbis said nothing.

The limit, in the other direction: none of it overrides safety. A workflow does
not authorise deleting without a backup, pushing unasked, or skipping a
confirmation the user would want.

## Layout

```
bin/                      bash entry points: myjarbis, -init, -doctor, -update, -start
global/mcp-server/src/    the server
  index.ts                tool declarations (always-loaded vs deferred)
  cli.ts                  every CLI subcommand
  resolve.ts              directory → project, and which brain holds it
  context.ts              ServerContext: the handle tools receive
  ndjson.ts               the text projection both the brain dump and the org
                          memory are written as
  db/                     schema, migrations, per-table repositories
  tools/                  one module per tool group
  org/                    packs, registry, fleet sync
    identity.ts           who wrote this: config → git → $USER@host
    scrub.ts              what must not cross to a shared repo
    memory/               the org memory's transport, behind one interface
  workflows/              resolve.ts, condition.ts, baseline.ts
  health.ts gc.ts review.ts commands.ts
global/templates/         .claude-plugin (hooks) + .claude/commands (es/en/pt)
tests/                    35 E2E suites, 849 assertions — bash, own fixtures
```

Tests build their own fixtures and run on any checkout: `bash
tests/run-all.sh`. A suite is only trusted once the fix it covers has been
reverted on purpose and the assertion confirmed red — the harness once could
not fail at all, and that is how it was found.
