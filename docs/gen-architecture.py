#!/usr/bin/env python3
"""
Generate docs/myjarbis-architecture.drawio.

The diagram used to be hand-authored XML — 79 cells with hand-placed
coordinates — which is exactly why it drifted: nobody edits 79 cells to
reflect a change, so it kept describing v0.2 long after v0.2 was gone.
Describing it as data and generating the file means the next change is a
line here, not an afternoon in draw.io.

    python3 docs/gen-architecture.py

Same philosophy as docs/media/gen.py (README mockups) and the living
module diagrams the MCP server emits at runtime. All example data is
fictional.
"""

import html
import os

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "myjarbis-architecture.drawio")

# ── visual language: minimalist, black on white, one accent ──────────
INK, MUTED, ACCENT = "#000000", "#6B6E78", "#8B1A1A"
CARD = "fillColor=none;strokeColor=#000000;fontColor=#000000"
NOTE = "fillColor=#F6F6F8;strokeColor=#D7D9E0;fontColor=#1C1D22"
HILITE = "fillColor=#FBEAEA;strokeColor=#8B1A1A;fontColor=#1C1D22"

W = 1180
GAP = 26


def esc(s):
    """Escape TEXT for the HTML that draw.io renders inside a cell."""
    return html.escape(s, quote=True)


def xml_value(markup):
    """Escape composed HTML for an XML attribute.

    There are genuinely two layers, and `&` has to be escaped in BOTH or the
    inner one is lost. The text went through `esc` first, so "<project>" is
    already "&lt;project&gt;"; a pass that skipped "&" here would leave that
    entity in the attribute, the XML parser would decode it back to a raw
    "<project>", and draw.io would then eat it as an unknown tag — the text
    would simply vanish from the diagram.

    Escaping everything means:
      <b>            -> &lt;b&gt;      -> draw.io sees <b>            -> bold
      &lt;project&gt -> &amp;lt;...    -> draw.io sees &lt;project&gt -> text
      &#8226;        -> &amp;#8226;    -> draw.io sees &#8226;        -> bullet
    """
    return html.escape(markup, quote=True)


def rich(title, body=None, lines=None):
    """draw.io renders a subset of HTML inside a cell value."""
    out = f"<b>{esc(title)}</b>"
    if body:
        out += "<br><br>" + esc(body)
    if lines:
        rendered = []
        for l in lines:
            if not l.strip():
                rendered.append("")          # a spacer, not an empty bullet
            elif l.startswith("  "):
                rendered.append("&#160;&#160;&#160;" + esc(l.strip()))
            else:
                rendered.append("&#8226;&#160;" + esc(l))
        out += "<br><br>" + "<br>".join(rendered)
    return out


class Page:
    def __init__(self, name):
        self.name = name
        self.cells = []
        self.n = 1

    def _id(self, prefix):
        self.n += 1
        return f"{prefix}{self.n}"

    def box(self, x, y, w, h, value, style=CARD, font=12, align="left"):
        cid = self._id("c")
        st = (
            f"rounded=0;whiteSpace=wrap;html=1;{style};align={align};"
            f"verticalAlign=top;spacingLeft=14;spacingRight=14;spacingTop=10;"
            f"fontSize={font};"
        )
        self.cells.append(
            f'<mxCell id="{cid}" value="{xml_value(value)}" style="{st}" vertex="1" parent="1">'
            f'<mxGeometry x="{x}" y="{y}" width="{w}" height="{h}" as="geometry"/></mxCell>'
        )
        return cid

    def title(self, x, y, text, sub=None, size=22):
        val = f"<b>{esc(text)}</b>"
        if sub:
            val += f'<br><font style="font-size: 12px; color: {MUTED}">{esc(sub)}</font>'
        cid = self._id("t")
        st = (
            f"text;html=1;align=left;verticalAlign=top;fontSize={size};"
            f"fontColor={INK};spacingLeft=0;"
        )
        self.cells.append(
            f'<mxCell id="{cid}" value="{xml_value(val)}" style="{st}" vertex="1" parent="1">'
            f'<mxGeometry x="{x}" y="{y}" width="{W - 80}" height="56" as="geometry"/></mxCell>'
        )
        return cid

    def arrow(self, src, dst, label=""):
        cid = self._id("e")
        st = (
            "edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;"
            f"strokeColor={INK};endArrow=block;endFill=1;fontSize=10;"
            f"fontColor={MUTED};"
        )
        self.cells.append(
            f'<mxCell id="{cid}" value="{xml_value(esc(label))}" style="{st}" '
            f'edge="1" parent="1" source="{src}" target="{dst}">'
            f'<mxGeometry relative="1" as="geometry"/></mxCell>'
        )

    def xml(self):
        body = "\n        ".join(self.cells)
        return (
            f'  <diagram name="{esc(self.name)}">\n'
            f'    <mxGraphModel dx="1400" dy="900" grid="0" gridSize="10" guides="1" '
            f'tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" '
            f'pageWidth="{W}" pageHeight="1700" math="0" shadow="0">\n'
            f"      <root>\n"
            f'        <mxCell id="0"/>\n'
            f'        <mxCell id="1" parent="0"/>\n'
            f"        {body}\n"
            f"      </root>\n"
            f"    </mxGraphModel>\n"
            f"  </diagram>"
        )


# ═════════════════════════════════════════════════════════════════════
# Page 1 — the layers
# ═════════════════════════════════════════════════════════════════════
p1 = Page("1 · Architecture")
p1.title(40, 30, "MyJarbis — architecture",
         "A memory + process layer over MCP. Installed on top of Claude Code, "
         "and an explicit override of it.")

y = 110
dev = p1.box(40, y, W - 80, 68, rich(
    "DEVELOPER",
    "Types `myjarbis start`, or `claude` then `/jarbis`. After that it is "
    "natural language — there is only one slash command."))

y += 68 + GAP
harness = p1.box(40, y, W - 80, 108, rich(
    "CLAUDE CODE  (harness)",
    "Fires hooks and loads skills from .claude/skills/. MyJarbis does not "
    "replace it; it sits above it and outranks its defaults.",
    [
        "SessionStart — resolve project, resume the module, materialise skills",
        "UserPromptSubmit — optional nudges",
        "Stop — fires EVERY turn (reminder only; it does not close anything)",
        "SessionEnd — closes any open session automatically",
    ]))

y += 108 + GAP
mcp = p1.box(40, y, W - 80, 150, rich(
    "MCP SERVER  (Node + TypeScript, stdio)",
    "32 tools. 20 are always in the prompt; 12 admin-shaped ones ship only a "
    "name and load their schema on demand, so they cost nothing when unused.",
    [
        "memory:    save_observation · update_observation · suggest_topic_key",
        "           add_ref · find_by_ref · search · load_project_core · load_module",
        "state:     get_project_state · set_project_state · resume",
        "process:   get_workflow · list_workflows · set_workflow_step",
        "setup:     list/set_provider · list_context_kinds · *_skills · import_*",
    ]))

y += 150 + GAP
scope = p1.box(40, y, W - 80, 98, rich(
    "SCOPE  —  the tenant boundary, in code",
    "Bound to the CONNECTION, never passed per query. Before v0.3 isolation "
    "was the filesystem's job (one file per project); a shared brain removes "
    "that, and one forgotten parameter would widen a read across clients.",
    [
        "{ kind: 'project', id }  —  the only rows this connection can see",
        "{ kind: 'all', reason }  —  crossing projects, with a stated reason",
        "No scope bound → the read FAILS. Another project's id → REFUSED.",
    ]), style=HILITE)

y += 98 + GAP
db = p1.box(40, y, W - 80, 176, rich(
    "SQLite  —  better-sqlite3 + FTS5   (schema v4)",
    "One file per project by default. The shared brain is opt-in and exists "
    "so a cross-cutting change is one action instead of N visits.",
    [
        "<project>/.myjarbis/memory.db     isolation = silo    (default)",
        "~/.myjarbis/memory.db             isolation = shared  (opt-in)",
        "",
        "orgs → projects → project_context · modules · skills",
        "                → project_state · providers · workflows → workflow_steps",
        "modules → module_context → sessions → observations → refs",
        "context_kinds — the taxonomy, a catalogue rather than free text",
    ]))

p1.arrow(dev, harness, "/jarbis")
p1.arrow(harness, mcp, "MCP over stdio")
p1.arrow(mcp, scope, "every read")
p1.arrow(scope, db, "scoped SQL")

y += 176 + GAP
p1.box(40, y, W - 80, 92, rich(
    "Resolving “which project is this?”",
    "In order, stopping at the first hit. It NEVER creates a brain — only "
    "`myjarbis init` does, which is why a command run in a stray directory no "
    "longer leaves an empty database behind.",
    [
        "1. explicit --project / MYJARBIS_PROJECT",
        "2. the normalised git remote  (survives a different path on another machine)",
        "3. the nearest enclosing registered path  (so subdirectories work)",
        "4. fail with a clear message",
    ]), style=NOTE, font=11)


# ═════════════════════════════════════════════════════════════════════
# Page 2 — a session, start to finish
# ═════════════════════════════════════════════════════════════════════
p2 = Page("2 · A session")
p2.title(40, 30, "A session, start to finish",
         "What actually happens between opening the terminal and the brain "
         "being ready for tomorrow.")

steps = [
    ("1 · Open", "`myjarbis start`, or `claude` + `/jarbis`.", [
        "SessionStart resolves the project by git remote, then by path.",
        "If a module is already active it resumes straight into it.",
    ]),
    ("2 · start_session(module)", "One call returns everything bootstrap needs.", [
        "projectContext + moduleContext as ~240-char excerpts (the catalogue)",
        "stories as localIds only — no bodies, or one module would flood context",
        "previousSession.nextSession IN FULL — the actual resume point",
        "Any session left open in this module is closed first, retroactively.",
    ]),
    ("3 · Skills materialise", "Rows become files Claude Code can read.", [
        "project-level + the active module's skills → .claude/skills/myjarbis-*/",
        "Inserting into the DB is not enough: the agent reads the directory.",
    ]),
    ("4 · Work — natural language", "The agent calls tools; you talk.", [
        "a decision / gotcha / closed story → save_observation",
        "something with a CURRENT VALUE → topic_key, so saving again UPDATES it",
        "about to repeat an outward action → find_by_ref first",
        "“what is the process here?” → get_workflow, resolved org→project→user",
    ]),
    ("5 · Gates", "A step with gate=approve is a stop, not a hint.", [
        "capability is abstract (tracker.comment) — the provider row names the tool",
        "Conditions are decidable (branch ~= release/*), never free text",
    ]),
    ("6 · Close", "Curated if you say so; automatic either way.", [
        "end_session(summary, next_session) — always better, it says what you MEANT",
        "otherwise SessionEnd writes a generated summary from observations + commits",
        "the resume point prefers project_state, then the last progress note",
        "generated text is prefixed [auto] and the next agent is told so",
    ]),
]

y = 110
prev = None
for title, body, lines in steps:
    h = 56 + 16 * len(lines) + (30 if body else 0)
    cid = p2.box(40, y, W - 80, h, rich(title, body, lines),
                 style=HILITE if title.startswith("6") else CARD, font=11)
    if prev:
        p2.arrow(prev, cid)
    prev = cid
    y += h + GAP

p2.box(40, y, W - 80, 86, rich(
    "Why the close matters more than it looks",
    "`summary` was NULL on 2 of 2 sessions in one real project and 2 of 10 in "
    "another. A session that never closes makes `resume` return nothing AND "
    "strips hasNextSession / lastSessionEndedAt from every module — which is "
    "the signal used to choose which module to open. It fails silently.",
    [
        "So it closes in TWO places: SessionEnd, and the next start_session.",
        "A killed terminal fires no hook — a guarantee that needs a clean exit is not one.",
    ]), style=NOTE, font=11)


# ═════════════════════════════════════════════════════════════════════
# Page 3 — what v0.3 added
# ═════════════════════════════════════════════════════════════════════
p3 = Page("3 · What v0.3 added")
p3.title(40, 30, "v0.3 — the habits, and what replaced them",
         "Each change exists because a measurable habit had formed in real "
         "brains: 138 observations, 15 context rows, 12 sessions, 3 projects.")

changes = [
    ("Org pack", "Two of three real projects never received the org layer at all — "
     "one re-learned and re-documented a gotcha already written in a skill that was "
     "never materialised there.",
     ["skills/ + overrides/ + context-kinds.yml + workflows/ + providers.yml",
      "overrides/ REPLACES a baseline; applied after it, then materialised to disk",
      "org sync — one command re-applies to every project of the org"]),
    ("Taxonomy", "Three projects invented three vocabularies for the same seven "
     "ideas. observations.kind, which code fixes, came out identical in all three.",
     ["context_kinds is a catalogue; an unknown kind is rejected WITH the nearest match",
      "a pack adds its own; no vendor name belongs here (tracker_rules, not a product)"]),
    ("topic_key + refs", "Notes were corrected by retitling: \"CORRECTS note 80\", "
     "\"DEFINITIVE — supersedes 80 and 81\". Six of those in one brain.",
     ["topic_key — saving again updates that note instead of competing with it",
      "refs + find_by_ref — \"did I already post this?\" as a boolean, not a re-read"]),
    ("project_state", "Three notes in one project were the same note, each "
     "announcing it replaced the last.",
     ["one row, overwritten; history is what observations are for",
      "an advisory lock with a TTL — no TTL wedges the project when a process dies"]),
    ("Resolution by git remote", "cwd-exact matching meant a subdirectory "
     "registered a SECOND project, and a clone at another path was a new project.",
     ["--project → git remote → nearest registered path → fail",
      "never creates a brain; `init` alone does"]),
    ("Brain sync", "Versioning the binary .db split the brain once already.",
     ["deterministic NDJSON per table, scoped to ONE project",
      "export refuses if providers.config carries anything credential-shaped"]),
    ("Workflows as data", "Three consecutive decisions contradicted each other "
     "about when to stop for approval — a field changing value, written as "
     "three documents.",
     ["rows with org → project → user inheritance, resolved into ONE list",
      "abstract capability + providers, so the core never learns a vendor's name",
      "decidable conditions; anything advisory goes in notes"]),
]

y = 110
for title, why, lines in changes:
    h = 56 + 16 * len(lines) + 44
    p3.box(40, y, W - 80, h, rich(title, why, lines), font=11)
    y += h + 14

p3.box(40, y + 10, W - 80, 104, rich(
    "The condition that ordered all of it",
    "The core learns MECHANISMS, never CONTENT. If a change needs to know the "
    "name of a company, a client or a commercial tool, it is either designed "
    "wrong or it belongs in a private pack.",
    [
        "the loader is here — the pack's contents are not",
        "`tracker.comment` is here — which tracker is a providers row",
        "the taxonomy mechanism is here — an org's extra labels are not",
        "verified: `git grep` for org / client / tracker names returns nothing",
    ]), style=HILITE, font=11)


# ═════════════════════════════════════════════════════════════════════
doc = (
    '<mxfile host="app.diagrams.net" type="device">\n'
    + "\n".join(p.xml() for p in (p1, p2, p3))
    + "\n</mxfile>\n"
)

with open(OUT, "w", encoding="utf-8") as fh:
    fh.write(doc)

print(f"✓ {os.path.relpath(OUT)}  ({len(doc):,} bytes, 3 pages)")
