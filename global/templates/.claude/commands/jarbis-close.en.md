# /jarbis-close — Close the session and leave it ready for the next one

The user typed this because the working block is over. **The command IS
the confirmation** — do not ask "are you sure you want to close?". Your
job is to leave the memory in a state the next session can use, then show
them in a few lines what you wrote so they can correct it.

It exists because the `SessionEnd` hook already closes the session on its
own if you forget — but it writes a synthetic summary (`[auto] ... 0
observations saved` plus the commit list). That is a record of activity,
not a handoff: it says three commits happened, not what to do tomorrow.
That difference is the whole value of this command.

---

## Order (it matters)

### 0. Before writing anything, look at the real state

Run `git status --short`. If the project has tests and you ran them this
session, say whether they are green; if you did **not** run them, say
that — do not assume it.

If there are uncommitted files or failing tests: **say so first and ask
whether to close anyway.** Never close silently over half-finished work;
the next startup has no way to find out.

### 1. Pending observations

For every decision, gotcha or piece of progress from this session you
have not saved yet: `save_observation` with the right `kind`, `content`
ordered WHY → WHAT → HOW, and `files`.

For anything that has a **current value** rather than a history (the state
of a topic, the way something is done), call `suggest_topic_key` first and
reuse the key it returns — that updates the note instead of adding a rival
to it. A one-off event goes without a `topic_key`.

Do not save one note per file touched. Save what would spare an hour to
whoever opens this in three weeks.

### 2. The living handoff — `set_project_state`

This is the first thing the next session reads, and it **replaces** the
previous content: write the whole picture, not a delta.

Include, in this order:
- where the work stands today;
- what is **verified** and what is not (if you ran the suite, the number;
  if you did not, say so);
- the concrete next action, and the ones after it if there are any;
- what is already measured and settled, so it is not re-litigated.

### 3. `end_session`

Two fields, and **you write both** from what happened in the session. Do
not ask the user to dictate them — being asked is exactly what this
command exists to avoid.

- `summary` — 1 to 3 retrospective bullets. No celebration.
- `next_session` — the "resume here". An **action**, not a diary: verb +
  path/branch/PR + the command to run if there is one. Anything left
  unverified belongs here; leaving it out is what makes the next session
  believe it was done. ≤ 10 lines.

### 3.5 If this project is in an org: offer what the team should have

`end_session` comes back with `promotionProposals` when the project
belongs to an org and this session produced something worth sharing. When
it does:

1. Print its `display` **verbatim**. It is rendered server-side and
   already names the org, marks what needs a rewrite, and states what can
   never travel. Rebuilding it costs tokens to produce something less
   consistent.
2. Ask which to promote. **Never promote without asking**, and never
   promote everything because it was all offered — roughly half of what
   gets offered to a shared store is already in it, and that is the
   filter working.
3. Per confirmation, call `promote_observation`. Supply `caveats` —
   WHEN this applies — because it is the field with no mechanical source
   and the most value, and the one that stops a lesson that is true here
   from being applied everywhere. Add `working_example` where there is
   one.
4. If it comes back `ORG_NOTE_UNSAFE`, the note carries something that
   must not leave this machine: a credential, a local path, an internal
   host or a real project name. **Show the offending line and the
   proposed rewrite and ask.** Do not route around the refusal, and do
   not re-word it yourself and promote quietly — the user is the one who
   knows whether that name matters.
5. Say that promoting writes to the local mirror only. `myjarbis org
   push` writes the files the team reads, and a person commits them.

If `promotionProposals` is absent, there is nothing to do here. Do not
mention the org memory.

### 4. Recap, briefly

Show them: which notes you saved (titles), the literal `next_session`
text, what (if anything) was promoted to the org, and one line offering
to rewrite any of them if it reads wrong.

---

## Rules

- **Do not invent progress.** If the session went nowhere, the summary says
  so. An optimistic summary is worse than the synthetic one, because it
  gets believed.
- **Do not commit or push** as part of closing unless the user asks.
  Closing is an act of memory, not of git.
- **If no session is open** (a hook already closed it, or none was ever
  started): say so, and still offer to write `set_project_state`, which is
  the part that survives either way.
- **If the user is closing in order to switch modules**, do not use this
  command on its own: close, then open the new session in the target
  module, confirming the target first.
- If the session was long and you may be missing context from its first
  half, say that in the summary instead of filling the gap in.
