#!/bin/bash
#
# E2E test: schema v5 — the org memory tables, workflow composition columns
# and workflow runs — reaches an EXISTING brain and not just a new one.
#
# Why this suite exists at all, given that v4 migrated fine:
#
# v4 added `observations.project_id` twice. `SCHEMA_SQL` declares it with
# `ON DELETE CASCADE`; `MIGRATIONS[4]` adds it without. Both paths "work", and
# every brain that was created has a stronger constraint than every brain that
# was upgraded — a difference nobody can see until a project is deleted and one
# population keeps orphaned notes. Writing a table's DDL in two places is what
# produced that, so v5 declares its objects ONCE (`V5_OBJECTS`) and uses the
# same strings on both paths. This suite is what keeps that true.
#
# What it pins:
#
#   · a brain at v4 reaches v5 with every pre-existing row intact
#   · a brain created fresh and a brain migrated have the SAME schema —
#     same tables, same columns, same triggers, same indexes
#   · the migration is idempotent: walking MIGRATIONS[5] twice is not an error
#   · a governance UPDATE on org_notes does not touch the contentless FTS
#     index, which is the whole reason the content half is a separate table
#   · every non-FTS table is registered in COUNTED_TABLES and in DUMP_TABLES,
#     and every FTS mirror is in FTS_TABLES — asserted, not remembered
#
# Exits 0 on success, non-zero on the first failed assertion.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export MYJARBIS_INSTALL_DIR="${MYJARBIS_INSTALL_DIR:-$REPO_ROOT/global}"
B="$MYJARBIS_INSTALL_DIR/mcp-server/build"

if [ ! -f "$B/db/index.js" ]; then
  echo "✗ build not found at $B — run: cd $MYJARBIS_INSTALL_DIR/mcp-server && npm run build"
  exit 1
fi

WORK="$(mktemp -d -t myjarbis-schema5-XXXXXX)"
trap 'cd /; rm -rf "$WORK"' EXIT
echo "→ work dir: $WORK"
# Pinned so the suite cannot touch the real home, the real brain or the real
# registry — three suites were once found writing into the live 23-project brain.
export HOME="$WORK/fakehome"; mkdir -p "$HOME"
export MYJARBIS_HOME="$WORK/brain"
export MYJARBIS_REGISTRY="$WORK/projects-registry.json"

FAILED=0
pass() { echo "    ✓ $1"; }
oops() { echo "    ✗ $1" >&2; FAILED=$((FAILED + 1)); }

# Assertions from a node block are read back through a FILE, never a pipe:
# `cmd | while read ... oops` runs the loop in a subshell, so every
# FAILED=$((FAILED+1)) is discarded on exit and the suite reports success
# while printing ✗ lines.
ASSERTS="$WORK/asserts.out"
read_asserts() {
  while IFS='|' read -r st msg; do
    [ "$st" = "PASS" ] && pass "$msg" || oops "$msg"
  done < "$ASSERTS"
}

# ─────────────────────────────────────────────────────────────────────
# The v4 fixture.
#
# There is no previous build to create one with, so it is made by taking a v5
# file back to the v4 shape: drop what v5 adds, reset the version marker. That
# is a fair fixture precisely because `MIGRATIONS[5]` is the only thing that
# can put those objects back.
# ─────────────────────────────────────────────────────────────────────
echo "→ [1] a v4 brain reaches v5 with its rows intact"
node --input-type=module -e "
import { MyJarbisDB } from '$B/db/index.js';
const out = [];
const t = (c, m) => out.push((c ? 'PASS|' : 'FAIL|') + m);

let db = MyJarbisDB.openAtPath('$WORK/m.db');
db.db.exec(\"INSERT INTO projects (name, path, isolation) VALUES ('p','/tmp/p','shared')\");
db.db.exec(\"INSERT INTO modules (project_id, name) VALUES (1,'m')\");
db.db.exec(\"INSERT INTO sessions (module_id) VALUES (1)\");
db.db.exec(\"INSERT INTO observations (session_id, project_id, kind, title, content) VALUES (1,1,'gotcha','a kept note','its body')\");
db.db.exec(\"INSERT INTO workflows (slug,name,scope,scope_id) VALUES ('w','W','project',1)\");
db.db.exec(\"INSERT INTO workflow_steps (workflow_id,position,name,actor) VALUES (1,10,'s','agent')\");

// The fresh schema, captured before stripping it back to v4.
//
// Compared SEMANTICALLY and not as DDL text, because the two paths can never
// produce the same text: ALTER TABLE appends a column to the CREATE statement
// SQLite has stored, which is the v4 statement, comments and all. What must
// match is what the schema MEANS -- and column ORDER is part of that, because
// the brain dump writes each row's keys in physical order.
const shapeOf = (h) => {
  const objs = h.db
    .prepare(\"SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name\")
    .all();
  const lines = [];
  for (const o of objs) {
    if (o.type !== 'table') { lines.push(o.type + ' ' + o.name); continue; }
    const cols = h.db.prepare('PRAGMA table_info(' + o.name + ')').all()
      .map((c) => c.cid + ':' + c.name + ':' + c.type + ':' + c.notnull + ':' + String(c.dflt_value) + ':' + c.pk)
      .join(' | ');
    lines.push('table ' + o.name + ' => ' + cols);
  }
  return lines.join('\n');
};
const freshShape = shapeOf(db);

for (const x of ['org_note_content_fts','workflow_run_steps','workflow_runs','org_note_content','org_notes'])
  db.db.exec('DROP TABLE IF EXISTS ' + x);
for (const x of ['org_note_content_ai','org_note_content_ad','org_note_content_au'])
  db.db.exec('DROP TRIGGER IF EXISTS ' + x);
db.db.exec('ALTER TABLE workflows DROP COLUMN standalone');
db.db.exec('ALTER TABLE workflow_steps DROP COLUMN uses');
db.db.exec(\"UPDATE meta SET value='4' WHERE key='schema_version'\");
db.close();

db = MyJarbisDB.openExisting('$WORK/m.db');
t(db.schemaVersion === 4 && db.needsMigration === true, 'the fixture reads as v4 and wants migrating');
db.migrateInPlace();
t(db.schemaVersion === 5, 'migrateInPlace lands on v5');

const one = (s) => db.db.prepare(s).get();
t(one('SELECT COUNT(*) c FROM observations').c === 1, 'the pre-existing observation survived');
t(one(\"SELECT title FROM observations WHERE id=1\").title === 'a kept note', 'and still says what it said');
t(one('SELECT COUNT(*) c FROM workflows').c === 1 && one('SELECT COUNT(*) c FROM workflow_steps').c === 1,
  'the pre-existing workflow and its step survived');

const cols = (tbl) => db.db.prepare('PRAGMA table_info(' + tbl + ')').all().map((c) => c.name);
t(cols('workflows').includes('standalone'), 'workflows.standalone was added');
t(one('SELECT standalone FROM workflows WHERE id=1').standalone === 1,
  'and an existing workflow defaults to standalone, not to hidden');
t(cols('workflow_steps').includes('uses'), 'workflow_steps.uses was added');
for (const tbl of ['org_notes','org_note_content','workflow_runs','workflow_run_steps'])
  t(!!one(\"SELECT 1 x FROM sqlite_master WHERE name='\" + tbl + \"'\"), 'table ' + tbl + ' was created');

t(db.db.pragma('integrity_check')[0].integrity_check === 'ok', 'integrity_check is ok after migrating');
t(db.db.pragma('foreign_key_check').length === 0, 'foreign_key_check reports no violations');

// ── the invariant this suite exists for ──
const migratedShape = shapeOf(db);
if (migratedShape !== freshShape) {
  const a = freshShape.split('\n'), b = migratedShape.split('\n');
  const diff = a.filter((l, i) => b[i] !== l).slice(0, 2).join(' /// ');
  t(false, 'a migrated brain differs from a fresh one: ' + diff);
} else {
  t(true, 'a migrated brain has the SAME schema as a fresh one, column for column');
}

// ── idempotency ──
db.db.exec(\"UPDATE meta SET value='4' WHERE key='schema_version'\");
let threw = null;
try { db.migrateInPlace(); } catch (e) { threw = e; }
t(threw === null, 'walking MIGRATIONS[5] a second time is not an error');
t(db.schemaVersion === 5, 'and the version marker is still 5');
db.close();

console.log(out.join('\n'));
" > "$ASSERTS" 2>"$WORK/err1" || { echo "    ✗ node block crashed"; cat "$WORK/err1" >&2; FAILED=$((FAILED + 1)); }
read_asserts

# ─────────────────────────────────────────────────────────────────────
echo "→ [2] a status change does not touch the contentless FTS index"
#
# This is why the note is two tables. `org_notes` holds the governance half and
# is NOT mirrored into FTS; `org_note_content` holds the searchable half and is.
# A note going stale is the most frequent UPDATE this feature has, and with one
# table it would fire a delete+insert against a contentless index on every one
# of them — the exact operation that returns SQLITE_CORRUPT_VTAB when the index
# does not hold the row.
node --input-type=module -e "
import { MyJarbisDB } from '$B/db/index.js';
const out = [];
const t = (c, m) => out.push((c ? 'PASS|' : 'FAIL|') + m);

const db = MyJarbisDB.openAtPath('$WORK/fts.db');
db.db.exec(\"INSERT INTO orgs (slug, name) VALUES ('acme','Acme')\");
const insNote = db.db.prepare(\"INSERT INTO org_notes (org_id, author_handle, author_source, content_hash, seq) VALUES (1, 'tester', 'git', 'hash' || ?, ?)\");
const insBody = db.db.prepare(\"INSERT INTO org_note_content (note_id, question, answer) VALUES (?, 'why does zebraword fail', 'because of thing ' || ?)\");
for (let i = 1; i <= 3; i++) { insNote.run(i, i); insBody.run(i, i); }
const hits = () => db.db
  .prepare(\"SELECT COUNT(*) c FROM org_note_content_fts WHERE org_note_content_fts MATCH 'zebraword'\")
  .get().c;
t(hits() === 3, 'the three notes are in the FTS index');

db.db.exec(\"UPDATE org_notes SET status='stale', updated_at=datetime('now')\");
t(db.db.pragma('integrity_check')[0].integrity_check === 'ok',
  'a governance UPDATE over every row leaves the database intact');
t(hits() === 3, 'and the index still answers, untouched by it');

let threw = null;
try { db.db.exec(\"INSERT INTO org_note_content_fts(org_note_content_fts) VALUES('rebuild')\"); }
catch (e) { threw = e; }
t(threw === null && hits() === 3, 'an explicit rebuild succeeds and finds the same three');

// And the hazard itself, reproduced on purpose, so the reason the content half
// is a separate table is a fact in this file and not a claim in a comment.
//
// A touch trigger on the governance half that writes the mirrored half fires
// the FTS _au trigger, whose 'delete' op against a contentless index that does
// not hold the row returns SQLITE_CORRUPT_VTAB -- reported as 'database disk
// image is malformed' on a database whose integrity_check says 'ok'. That
// combination is what makes it so expensive to diagnose.
db.db.exec(\"CREATE TRIGGER org_notes_touch AFTER UPDATE ON org_notes BEGIN UPDATE org_note_content SET question = question WHERE note_id = old.id; END\");
db.db.exec(\"INSERT INTO org_note_content_fts(org_note_content_fts) VALUES('delete-all')\");
let cascadeErr = null;
try { db.db.exec(\"UPDATE org_notes SET status='active'\"); } catch (e) { cascadeErr = e.message; }
t(cascadeErr !== null && /malformed/.test(cascadeErr),
  'a touch trigger that cascades into the mirrored half DOES corrupt the index -- which is why there is no such trigger');
t(db.db.pragma('integrity_check')[0].integrity_check === 'ok',
  'and integrity_check still says ok, which is why it is hard to find');
db.db.exec('DROP TRIGGER org_notes_touch');
db.close();

console.log(out.join('\n'));
" > "$ASSERTS" 2>"$WORK/err2" || { echo "    ✗ node block crashed"; cat "$WORK/err2" >&2; FAILED=$((FAILED + 1)); }
read_asserts

# ─────────────────────────────────────────────────────────────────────
echo "→ [3] every table is registered everywhere it has to be"
#
# A new table has to appear in COUNTED_TABLES (so `migrate` reconciles its row
# count), in DUMP_TABLES (so `brain export` does not silently omit it), and
# every FTS mirror has to appear in FTS_TABLES (so the three rebuild passes
# cover it). "Remember to add it in all of them" is not a mechanism. This is.
node --input-type=module -e "
import { MyJarbisDB } from '$B/db/index.js';
import { COUNTED_TABLES } from '$B/db/upgrade.js';
import { DUMP_TABLES } from '$B/tools/brain.js';
import { FTS_TABLES } from '$B/db/schema.js';
const out = [];
const t = (c, m) => out.push((c ? 'PASS|' : 'FAIL|') + m);

const db = MyJarbisDB.openAtPath('$WORK/reg.db');
const all = db.db
  .prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'\")
  .all()
  .map((r) => r.name);

// The shadow tables an FTS5 virtual table creates for itself are not ours.
const isShadow = (n) => /_fts(_data|_idx|_content|_docsize|_config)$/.test(n);
const real = all.filter((n) => !isShadow(n) && !n.endsWith('_fts'));
const mirrors = all.filter((n) => n.endsWith('_fts'));

const missingCounted = real.filter((n) => !COUNTED_TABLES.includes(n) && n !== 'meta');
const dumped = DUMP_TABLES.map((d) => d.name);
const missingDumped = real.filter((n) => !dumped.includes(n));
const missingFts = mirrors.filter((n) => !FTS_TABLES.includes(n));

t(missingCounted.length === 0, 'every table is in COUNTED_TABLES' +
  (missingCounted.length ? ' (missing: ' + missingCounted.join(', ') + ')' : ''));
t(missingDumped.length === 0, 'every table is in DUMP_TABLES' +
  (missingDumped.length ? ' (missing: ' + missingDumped.join(', ') + ')' : ''));
t(missingFts.length === 0, 'every FTS mirror is in FTS_TABLES' +
  (missingFts.length ? ' (missing: ' + missingFts.join(', ') + ')' : ''));

// DUMP_TABLES is consumed in FK-dependency order: importBrain inserts in this
// order and deletes in reverse. A child listed before its parent breaks both.
const pos = (n) => dumped.indexOf(n);
t(pos('org_notes') > pos('orgs') && pos('org_notes') > pos('observations'),
  'org_notes is dumped after the orgs and observations it points at');
t(pos('org_note_content') > pos('org_notes'), 'and its content half after it');
t(pos('workflow_run_steps') > pos('workflow_runs'), 'run steps are dumped after their run');
db.close();

console.log(out.join('\n'));
" > "$ASSERTS" 2>"$WORK/err3" || { echo "    ✗ node block crashed"; cat "$WORK/err3" >&2; FAILED=$((FAILED + 1)); }
read_asserts

if [ "$FAILED" -gt 0 ]; then
  echo
  echo "✗ $FAILED assertion(s) failed"
  exit 1
fi
echo "✓ v050-schema-v5 E2E PASSED"
