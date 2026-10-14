# Changelog

## v0.3.0

v0.2 gave the memory a schema. v0.3 is about what the memory was *still*
doing in prose, and about the layer MyJarbis actually is: something
installed on top of Claude Code that should guarantee its own bookkeeping
rather than hope the agent remembered.

Everything is additive. Existing projects keep working on their current
schema until you choose to run `myjarbis migrate`, which backs up first.

### Added

**Org packs.** Load how an organization works instead of teaching it to
each project. A pack is a directory — `skills/`, `overrides/`,
`context-kinds.yml`, `workflows/`, `providers.yml` — kept in your own
private repo. `overrides/` replaces a baseline skill of the same name;
applying always ends by materialising to `.claude/skills/`, because the
database alone configures nothing the agent can see. `myjarbis org sync`
re-applies to every project of the org in one command.

MyJarbis ships no pack. `examples/pack/` holds a fictional one so the
contract is readable.

**Workflows as data.** Process as rows with org → project → user
inheritance, resolved into one ordered list. Steps name an abstract
`capability` (`tracker.comment`), never a product — which tool that means
comes from the project's `providers` row, so one org workflow serves
clients on different trackers and the core never learns a vendor's name.
Conditions are decidable (`branch ~= release/*`), not free text.

**Notes with identity.** `topic_key` makes saving again *update* a note
instead of adding a rival to it. `refs` + `find_by_ref` answer "did I
already do this?" with a boolean. `update_observation` corrects in place.

**`project_state`.** The living "resume here" as a single row, with an
advisory lock that expires so a dead process cannot wedge the project.

**A context-kind catalogue.** `kind` is no longer free text. Unknown kinds
are rejected with the nearest match; known aliases fold silently.

**Sessions close themselves.** On `SessionEnd`, and again at the next
`start_session` for anything left open — so it survives a killed terminal,
a crash or a reboot. Generated text is labelled `[auto]` and the agent is
told it is machine-written.

**A shared brain, optional.** `~/.myjarbis/memory.db` with `project_id` as
the discriminator, for cross-cutting work. One database per project
(`isolation = silo`) remains the default.

**Resolution by git remote.** A project is found by its remote first, then
by the nearest enclosing registered path — so it resolves from any
subdirectory, and survives being cloned to a different path on another
machine.

**New commands.** `org`, `workflow`, `provider`, `state`, `kinds`,
`migrate`, `merge`, plus `brain export|import|status`. Nothing was
removed; `/jarbis` is still the only slash command.

**Twelve new MCP tools**, bringing the total to 32.

### Changed

- `/jarbis` now states its precedence explicitly: the user's instruction,
  then project conventions, then the resolved workflow and its gates, then
  pack skills, then baselines, and the agent's own defaults last. It does
  **not** override safety or destructiveness, and says so.
- `myjarbis status` reports how the project resolved, its org and pack
  revision, where the brain lives, and the schema version.
- `myjarbis update` was rewritten — see below.
- `myjarbis init` records the git remote and accepts `--org`, `--yes`,
  `--skip-memory` and `--isolation`.

### Fixed

Several of these were load-bearing failures that had gone unnoticed
because they fail silently.

- **`install.sh` wrote an invalid project registry.** A quoted heredoc
  left `$(date ...)` literal, and its inner quotes closed the JSON string
  early — so every fresh install shipped a registry that fails to parse,
  and the first `myjarbis init` died with `SyntaxError`. Installation was
  a hard blocker for anyone new.
- **`myjarbis update` never updated anything.** It ran `git pull` inside
  the install directory, which `install.sh` populates by copying — there
  was no remote, so it rebuilt the code already present and reported
  success. It also never copied `bin/` or `templates/`, so a new hook
  could not reach an existing installation even in principle.
- **Installing from a working checkout could overwrite your registry**
  with the developer's test projects, because `cp -r global/*` includes a
  gitignored `projects-registry.json` if one is present.
- **Re-running `install.sh` silently un-registered every project**, since
  the registry lives in the directory it removes. It now says so, offers
  `myjarbis update`, and preserves the registry anyway.
- **Any command created a database wherever it ran**, and running one in a
  subdirectory registered a *second* project pointing at that
  subdirectory. Only `init` creates a brain now.
- **Opening a brain migrated it.** Resolution touches every candidate
  database, so merely looking for a project could rewrite the schema of a
  file you never named. Migration is now `myjarbis migrate` alone.
- **The v4 migration could kill itself on a healthy database.** The
  backfill is an `UPDATE`, which fires the FTS sync trigger, which issues
  a `'delete'` op for a row that may not be in the contentless index —
  returning `SQLITE_CORRUPT_VTAB`, "database disk image is malformed". The
  migration now rebuilds the index first, which also repairs a stale one.
- **A multi-statement migration could half-apply** while still bumping the
  version, leaving a database that claims to be migrated but is missing
  columns.
- **`resume` could return the wrong session.** `ended_at` is second-
  granular, so two sessions closed in the same second tied and SQLite was
  free to return either. Automatic closing made that collision ordinary.
- **`skill edit` ignored `--content-from`**, making it unusable from a
  script.
- **`doctor` compared against a hardcoded schema version**, so every
  healthy project was reported as wrong.
- **`init` overwrote Claude Code's `MEMORY.md`**, destroying a running
  session's index of its own memories. It now appends.
- **`myjarbis update --projects` dropped its own flags** (`exec` without
  `"$@"`).
- `myjarbis status` printed `null closed` — `SUM()` over zero rows.
- The README documented `search` as a CLI verb; it is an MCP tool only.

### Security

- Reads are scoped to the connection, not to each query. A read with no
  scope **fails** rather than returning every project; passing another
  project's id is refused; crossing projects requires an explicit scope
  **and a stated reason**. Asserted five ways in `tests/v03-isolation.sh`.
- `providers.config` rejects anything that looks like a credential, both
  on write and again on export — the brain dump is meant to be committed.
  Pointer keys (`token_file`, `token_env`) are allowed; their values are
  still scanned.
- `brain export` is scoped to one project. Unscoped, it would have written
  every tenant's rows into one project's repository.
- `brain import` refuses a brain holding more than one project rather than
  deleting the others, and points at `myjarbis merge`.
- `jira_rules` was removed as a core context kind in favour of
  `tracker_rules`. A vendor's name has no place in the one vocabulary that
  has to be portable across clients.

### Testing

Nine E2E suites, 138 assertions, each generating its own fixture so they
run on any checkout — `tests/run-all.sh`. The three new ones cover tenant
isolation, migrate/merge against three synthetic projects (verifying row
counts arithmetically, that no foreign key crosses a project, that the
self-referential `supersedes` link survives the id remap, and that the
rebuilt FTS index resolves to the *right* rows), and the org pack.

`tests/v03-benchmark.sh` measures reading the brain against searching it.

### Known / deliberate

- Schema upgrades are never automatic. `myjarbis migrate --dry-run` first.
- A shared brain is opt-in; `silo` is still the default.
- `brain import` into a shared brain is unsupported by design; use `merge`.

## v0.2.0

SQLite + FTS5 backend, per-module sessions, a single `/jarbis` command,
git-like CLI, living draw.io diagrams, and the NDJSON brain dump.
