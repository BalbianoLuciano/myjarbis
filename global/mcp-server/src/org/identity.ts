/**
 * Who wrote this.
 *
 * Until now nothing in MyJarbis recorded an author, and it did not need to:
 * one brain, one developer, every row implicitly his. The org memory breaks
 * that assumption — a lesson crossing to another machine without a name on it
 * is a lesson nobody can ask about, and "recorded by @ana, verified against
 * commit abc123" is both a trust signal and the reason anyone bothers to
 * contribute a second time.
 *
 * The one attribution-shaped thing that already existed is a warning rather
 * than a precedent: `project_state.updated_by` is a free-text tool argument
 * the agent invents per session, and the live brain holds three different
 * conventions in three rows — `session-484-cli`, `s485-close-21oct`,
 * `session-adhoc`. A field anybody can fill with anything is not an identity.
 *
 * So resolution is a fixed ladder, and the source travels WITH the handle:
 *
 *   1. config   — `myjarbis config dev <handle>`, the explicit override
 *   2. git      — `user.name` / `user.email` of this repository
 *   3. fallback — $USER@hostname
 *
 * `config` beats `git` because someone who set it meant it. `git` is second
 * because it is the identity the developer already configured to sign the
 * commit that the lesson will cite, so the note and the commit agree without
 * anyone maintaining two things. A `fallback` handle is reported as such
 * everywhere it appears, because `braianaxeltroncosodeveloper@wsl-legion` is
 * not a name a team should have to read — and `doctor` says so.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
// The column's type, not a copy of it: `org_notes.author_source` is the
// consumer, and two declarations of the same three strings is one of them
// quietly gaining a fourth.
import { AuthorSource } from '../db/schema.js';

export type { AuthorSource };

export interface OrgIdentity {
  handle: string;
  email: string | null;
  source: AuthorSource;
}

/** `.myjarbis/config/settings.json` for a project, or `{}`. */
function readDevSettings(projectPath: string): { handle?: string; email?: string } {
  const p = path.join(projectPath, '.myjarbis', 'config', 'settings.json');
  if (!fs.existsSync(p)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf-8')) as { dev?: { handle?: string; email?: string } };
    return parsed.dev ?? {};
  } catch {
    // A settings file nobody can parse is a settings file with nothing in it.
    // Refusing to resolve an identity because of a stray comma would block a
    // promotion for a reason the user cannot connect to what they were doing.
    return {};
  }
}

/** One `git config --get` that never throws. */
function gitConfig(cwd: string, key: string): string | null {
  try {
    const out = execFileSync('git', ['config', '--get', key], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/**
 * The developer behind a write, resolved from the project at `projectPath`.
 *
 * Never throws and never returns null: there is always an answer, and the
 * `source` says how much it is worth.
 */
export function resolveIdentity(projectPath: string): OrgIdentity {
  const configured = readDevSettings(projectPath);
  if (configured.handle) {
    return {
      handle: configured.handle,
      // An explicit handle with no explicit email still gets git's, because
      // the email is only ever used to tell two people with the same handle
      // apart — there is no reason to discard a known one.
      email: configured.email ?? gitConfig(projectPath, 'user.email'),
      source: 'config',
    };
  }

  const gitName = gitConfig(projectPath, 'user.name');
  if (gitName) {
    return { handle: gitName, email: gitConfig(projectPath, 'user.email'), source: 'git' };
  }

  const user = process.env.USER ?? process.env.USERNAME ?? 'unknown';
  return { handle: `${user}@${os.hostname()}`, email: null, source: 'fallback' };
}

/**
 * Persist the override, merging into the existing settings.
 *
 * Merged rather than written, for the same reason the hook installer merges
 * into `settings.local.json`: this file carries language, scope defaults and
 * the brain switches, and a feature that replaces it wholesale takes somebody
 * else's configuration with it.
 */
export function setIdentity(projectPath: string, handle: string, email?: string): OrgIdentity {
  const trimmed = handle.trim();
  if (!trimmed) throw new Error('a dev handle cannot be empty');

  const p = path.join(projectPath, '.myjarbis', 'config', 'settings.json');
  let existing: Record<string, unknown> = {};
  if (fs.existsSync(p)) {
    try {
      existing = JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, unknown>;
    } catch {
      // Refuse rather than overwrite. This file also carries the project's
      // language and search defaults; replacing an unparseable one silently
      // discards whatever a human was in the middle of editing.
      throw new Error(
        `${p} is not valid JSON. Fix it before setting a dev handle — ` +
          'overwriting it would discard the rest of the project settings.',
      );
    }
  }

  const dev: { handle: string; email?: string } = { handle: trimmed };
  const resolvedEmail = email?.trim() || gitConfig(projectPath, 'user.email') || undefined;
  if (resolvedEmail) dev.email = resolvedEmail;

  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ ...existing, dev }, null, 2) + '\n', 'utf-8');

  return { handle: trimmed, email: resolvedEmail ?? null, source: 'config' };
}

/**
 * What to tell the user when the identity is a guess.
 *
 * Returned rather than printed so the caller decides whether it is a warning
 * line in `doctor`, a note under a promotion, or nothing at all.
 */
export function identityWarning(id: OrgIdentity): string | null {
  if (id.source !== 'fallback') return null;
  return (
    `the developer identity is a fallback (${id.handle}): this repository has no ` +
    'git user.name and no `myjarbis config dev <handle>`. Org notes promoted from ' +
    'here would carry that string as their author.'
  );
}
