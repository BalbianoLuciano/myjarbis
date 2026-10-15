/**
 * set_interaction_style — change the language and/or persona of the
 * project's interaction-style skill from inside Claude (no CLI needed).
 *
 * The skill content is composed via personas.composeInteractionStyle,
 * the same function `myjarbis init` calls. Either field is optional;
 * the other is preserved. Re-materializes the skill to disk so the
 * effect persists across reopens (current Claude session may need a
 * fresh start_session for the change to take full effect, since
 * skills are loaded by Claude Code at startup).
 */

import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { ServerContext } from '../context.js';
import { MyJarbisError, ErrorType } from '../types.js';
import {
  composeInteractionStyle,
  parseLanguage,
  parsePersona,
  personaLabel,
  Language,
  Persona,
} from '../personas.js';
import { materializeSkills } from './skills.js';

export const setInteractionStyleInputSchema = {
  type: 'object' as const,
  properties: {
    language: {
      type: 'string' as const,
      description:
        'Optional. EN | ES | PT. If omitted, the current language is preserved.',
    },
    persona: {
      type: 'string' as const,
      description:
        'Optional. concise | pair | mentor | reviewer (or numeric 1-4). If omitted, the current persona is preserved.',
    },
  },
  required: [],
};

const argsZ = z
  .object({
    language: z.string().optional(),
    persona: z.string().optional(),
  })
  .strict()
  .refine((v) => !!v.language || !!v.persona, {
    message: 'Provide at least one of `language` or `persona`.',
  });

export interface SetInteractionStyleResult {
  language: Language;
  persona: Persona;
  persona_label: string;
  status: 'inserted' | 'updated' | 'unchanged';
  materialized: boolean;
  hint: string;
}

const SKILL_NAME = 'interaction-style';

/** Best-effort recover of the current language/persona from the
 *  existing skill content (composeInteractionStyle markers). Falls
 *  back to EN+concise if the skill is missing or hand-edited beyond
 *  recognition. Exported so the CLI (myjarbis config list) can reuse it. */
export function inferCurrent(content: string | null): {
  language: Language;
  persona: Persona;
} {
  let language: Language = 'EN';
  let persona: Persona = 'concise';
  if (!content) return { language, persona };

  if (/\*\*Español \(Argentina\)\*\*/.test(content)) language = 'ES';
  else if (/\*\*português \(Brazil\)\*\*/.test(content)) language = 'PT';
  else if (/\*\*English \(United States\)\*\*/.test(content)) language = 'EN';

  // Persona blocks all open with `## Persona: <name>`. Match the name.
  const m = content.match(/##\s*Persona:\s*([A-Za-z ]+)/);
  if (m) {
    const tag = m[1].trim().toLowerCase();
    if (tag.startsWith('concise')) persona = 'concise';
    else if (tag.startsWith('pair')) persona = 'pair';
    else if (tag.startsWith('mentor')) persona = 'mentor';
    else if (tag.startsWith('critical') || tag.startsWith('reviewer'))
      persona = 'reviewer';
  }

  return { language, persona };
}

/**
 * The SessionStart hook renders the module menu from
 * `.myjarbis/config/settings.json`, not from the skill, because it runs
 * before the agent exists and cannot ask anyone. So the language lives in
 * two places and both have to be written.
 *
 * This used to be bolted onto the CLI path only (`myjarbis config
 * language`), which meant changing the language by TALKING to the agent —
 * the documented way — updated the skill and left the hook printing the
 * old language forever. Writing it here covers every caller.
 *
 * Unknown keys survive through the spread rather than an allow-list: the
 * v0.2 settings bump ate `language` and `brain.auto_export_on_session_end`
 * by rebuilding the object from a template, and that is not repeated here.
 */
function persistLanguageToSettings(projectPath: string, language: Language): void {
  const settingsPath = path.join(projectPath, '.myjarbis', 'config', 'settings.json');
  let existing: Record<string, unknown>;
  try {
    existing = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    // No settings file (or unreadable) — the hook has nothing to read from,
    // so there is nothing to keep in step. Not an error worth failing a
    // language change over.
    return;
  }
  const next = { ...existing, language: language.toLowerCase() };
  fs.writeFileSync(settingsPath, JSON.stringify(next, null, 2) + '\n', 'utf-8');
}

/** Shared core: compose new interaction-style content + upsert into DB
 *  + re-materialize to disk. Used by the MCP tool AND the CLI
 *  `myjarbis config language|persona` command. */
export function applyInteractionStyle(
  ctx: ServerContext,
  args: { language?: string; persona?: string },
): SetInteractionStyleResult {
  const project = ctx.requireProject();

  const existing = ctx.db.skills.findByName(project.id, null, SKILL_NAME);
  const current = inferCurrent(existing?.content ?? null);

  const language: Language = args.language
    ? parseLanguage(args.language)
    : current.language;
  const persona: Persona = args.persona
    ? parsePersona(args.persona)
    : current.persona;

  // Before the `unchanged` branch on purpose: the drift this fixes is a
  // skill that already says EN while settings.json still says es, which is
  // exactly the case where the skill upsert reports no change. Writing the
  // same value twice is harmless; skipping it leaves the hook wrong.
  persistLanguageToSettings(ctx.projectPath, language);

  const content = composeInteractionStyle(language, persona);

  const r = ctx.db.skills.upsert({
    projectId: project.id,
    moduleId: null,
    name: SKILL_NAME,
    description: 'Language + persona for this project (composed at init, editable later)',
    content,
  });

  if (r.status === 'unchanged') {
    return {
      language,
      persona,
      persona_label: personaLabel(persona),
      status: 'unchanged',
      materialized: false,
      hint: 'No change — language + persona already set to the requested values.',
    };
  }

  // Re-render the skill to .claude/skills/myjarbis-interaction-style/SKILL.md
  // so the change persists across Claude reopens.
  const moduleId = ctx.activeModuleId ?? undefined;
  const moduleName = moduleId
    ? ctx.db.modules.findById(moduleId)?.name
    : undefined;
  try {
    materializeSkills(ctx, { module: moduleName });
  } catch (err) {
    throw new MyJarbisError(
      ErrorType.DB_ERROR,
      `Skill upserted but materialize_skills failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return {
    language,
    persona,
    persona_label: personaLabel(persona),
    status: r.status,
    materialized: true,
    hint:
      'Updated. The change applies to the next Claude response. ' +
      'Skills materialized are loaded by Claude Code at session start, ' +
      'so close and reopen Claude to fully refresh — or just continue ' +
      'this session, the agent will follow the new style on the next reply.',
  };
}

export function setInteractionStyle(
  ctx: ServerContext,
  rawArgs: unknown,
): SetInteractionStyleResult {
  const args = argsZ.parse(rawArgs);
  return applyInteractionStyle(ctx, args);
}
