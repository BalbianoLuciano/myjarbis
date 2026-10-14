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

### 4. Recap, briefly

Show them: which notes you saved (titles), the literal `next_session`
text, and one line offering to rewrite either of them if it reads wrong.

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
