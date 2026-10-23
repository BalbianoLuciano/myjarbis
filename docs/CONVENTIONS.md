# MyJarbis conventions

Rules for working in this repository. Loaded into every session as
`project_context kind=convention`, which puts it at precedence #2 — above any
skill, and above whatever an agent would infer on its own.

Keep it short. A convention nobody can recite is not one.

## Language

**Everything written in this repository is in English.** Commit subjects,
commit bodies, code comments, documentation, test names, CLI output, CHANGELOG
entries. No exceptions.

This is not a style preference. The repository is public, and the `git log` is
the first thing a stranger reads.

**The log is English from v0.4.5 onwards.** Everything before that tag is mixed
and stays mixed: rewriting it would move SHAs that eight tags point at, which
is a real cost for no reader's benefit. **Do not read the older commits as
precedent** — an agent that samples the most recent subjects and generalises
will eventually conclude the opposite of this rule.

That is not a hypothetical. It happened twice.

The first breach was one session on 2026-10-14. The second was worse: fourteen
Spanish commits between 2026-10-20 and 2026-10-21, with this rule already
written. The cause was not inference — it was that the project-level
`myjarbis-commit-hygiene` skill said in writing that the body went «en español,
como el resto del historial», and the baseline `commit-hygiene` was itself
written in Spanish. The skills ordered the violation and the agent obeyed the
skills, which is the correct precedence; the defect was that a skill had an
opinion about something a convention owns.

Both were fixed on 2026-10-21: the skills no longer decide the language (the
baseline defers to this file, the override states English and cites it), and the
nineteen non-English messages after `v0.4.5` were rewritten, trees and topology
verified unchanged, no tag moved. The lesson worth keeping is the one about
authority, not the one about language: **a rule that justifies itself with the
repo's current state will ratify any drift the repo has.**

Conversation with the user is a separate matter: that follows
`interaction-style`, which is per-project and may be any language.

## Commits

```
<type>(<scope>): <imperative description, ≤72 chars, no trailing period>

Why: <the problem or motivation that triggers this change. If a story or
ticket exists, cite it.>

What for: <what changes or becomes possible after this commit. An
observable effect or a new invariant.>

Where: <the seam of the system the change lands in, and where the effect
shows up if that is somewhere else. Omit it when the change is local and
obvious — do not write filler.>
```

`Where:` is **not** the file list. The diff already says that, and repeating it
ages badly the moment a file is renamed. It earns its place when the change and
its consequence live apart: "written in the resolver, visible in every command
that opens a brain".

- **type**: `feat` | `fix` | `refactor` | `chore` | `docs` | `test` | `perf` | `style`
- **scope**: the subsystem — `hooks`, `cli`, `db`, `session`, `skills`, `update`, …

Hard rules:

- **Never** `Co-Authored-By: Claude`, or any Claude signature or trailer. The
  author is the user. Technical mentions of Claude Code in prose are fine.
- **Never** `--no-verify` or `--no-gpg-sign`. If a hook fails, fix the cause.
- **Never** `git add -A` or `git add .`. Stage by name.
- **Never** `--amend` after a push. Before a push it is fine.
- One commit = one logical change.

The older history uses `Por qué:` / `Para qué:` / `Dónde:` as headers, sometimes
with English prose. `Why:` / `What for:` / `Where:` is the form to use from here.

## Branches

The default branch is **`master`**. There is no `main`. A command or document
that says `main` is wrong about this repository.

**Work happens on a branch, never directly on `master`.** One branch per
session — the set of things a session sets out to do, not one per commit. It
gets merged when the work is verified and the user has tested it.

```
<type>/<what-the-session-is-about>
```

Same `type` vocabulary as the commits, kebab-case, English like everything
else. `fix/session-ownership-and-name-scrub`, not `fix/arreglos` and not
`braian-dev`.

Why a branch and not a direct commit: the point is being able to see what a
session did as one unit, and to drop it as one unit if it turns out wrong.
`master` staying clean and pushed is also what lets `project_state` say
"master at <sha>, clean" and have that mean something.

## Reading across projects

One brain holds twenty-three projects, and the only thing separating them when
you enter through SQL is the `WHERE` clause you happen to write. The MCP tools
enforce the module scope; a `node -e` against `~/.myjarbis/memory.db` does not.

**Read across projects only when the user asks for it explicitly.** Otherwise
stay inside the open module set and answer with the scoped tools. When a direct
query is the right instrument, filter by `project_id` in the query itself
rather than in the reading afterwards.

This was earned on 2026-10-22: asked whether a handoff was the latest, the
agent answered correctly with `resume()` and `git log`, then went to the DB
with `SELECT ... FROM sessions WHERE id >= 484` to explain a gap in the ids.
`sessions` has no `project_id` — it hangs off `modules` — so a query by id
range returns every project in the file, and another project's rows were
surfaced unasked. Observation 1558.

## Where a process rule lives

Now that `workflows` holds rows, a rule about HOW work is done has three
possible homes, and picking the wrong one is how the subsystem ended up unused:

- **a workflow step** — anything with a sequence, a gate, or a condition.
  "Ask before pushing" is a step with `gate: approve`, not a sentence in a
  skill.
- **`project_context` kind=`convention`** — a fact about this repository that
  owns its subject. The language of the log is a convention; no workflow step
  decides it.
- **a skill** — how to USE the tools, and when to reach for them. A skill may
  cite a convention or a workflow; it must not re-decide what either one says.

The failure this prevents has already happened twice. A skill that stated the
commit language "as the rest of the history does" overrode the convention that
owned it and ratified the drift it had itself caused. A rule in two places is a
rule that will disagree with itself.

## Registering a new table

Seven places, and two of them are not obvious because they fail silently:

1. `db/schema.ts` → `SCHEMA_SQL`, for a new file.
2. `db/schema.ts` → `MIGRATIONS[n]`, for an existing one. Declare the objects
   ONCE and use them in both — v4 wrote `observations.project_id` in both
   places with different `ON DELETE` clauses, so every upgraded brain carries a
   weaker constraint than every created one.
3. `db/upgrade.ts` → `COUNTED_TABLES`, so `migrate` reconciles its row count.
4. `tools/brain.ts` → `DUMP_TABLES`, in FK order, with a project scope clause.
5. `db/merge.ts` → the id remap, the copy loop, the second pass for
   self-references, **and the docstring that enumerates them**.
6. `db/schema.ts` → `FTS_TABLES`, if it has an FTS mirror.
7. The ALTERs that `MIGRATIONS` can only append must be declared LAST in
   `SCHEMA_SQL` too. `ALTER TABLE` cannot insert a column in the middle, and
   the brain dump writes keys in physical column order — declared anywhere
   else, a created brain and a migrated one emit identical rows with the keys
   in a different order, and the file conflicts in git for no visible reason.

Places 3, 4 and 6 are asserted by `tests/v050-schema-v5.sh`, which diffs all
three lists against `sqlite_master`. "Remember to add it everywhere" is not a
mechanism; a failing assertion is.

And the invariant behind it: **anything `MIGRATIONS[n]` cannot express must
not appear in `SCHEMA_SQL`.** SQLite has no `ALTER TABLE ... ADD CONSTRAINT`,
so a rule needing a table-level CHECK on an existing table lives in the
repository that writes the row — a constraint only new databases have is worse
than one nobody has.

## Verifying a fix

Two rules earned the hard way, both recorded in `project_state`:

- **Validate every new test by reverting the fix.** A test that passes against
  the bug is not a test. If reverting the change does not turn it red, it
  asserts nothing.
- **Checking that an artifact exists does not check that it works.** `doctor`
  passed green for months on hooks that never ran, because it asserted
  `hooks.json` was present rather than that anything read it. Assert the
  effect, not the file.
