/**
 * What must not cross the machine boundary.
 *
 * A personal observation is written for one reader on one machine, so it says
 * `/home/braian/dev-own/acme-portal/src/x.ts` and it names the client. An org
 * note is committed to a repository other people clone, and the two are not
 * the same kind of sentence. Promotion is the only moment where that change of
 * audience happens, so it is the only moment the check can be made.
 *
 * It BLOCKS rather than warns, and the asymmetry is the reason: a false
 * positive costs the user one keystroke to accept a rewrite, while a false
 * negative is committed to every clone the team has and stays in the history
 * after it is deleted. The same argument `org/secrets.ts` already makes about
 * `providers.config`.
 *
 * The project-name rule is not hypothetical here. Commit `d342442` scrubbed
 * three real client names out of this repository's tracked files and left them
 * in the commit messages, on the reasoning that rewriting history was out of
 * scope — and the history was rewritten anyway, two releases later, partly for
 * that. A name that travels is expensive to recall.
 *
 * Every rule is deterministic: a regex and a literal list, no model, no
 * network, no judgement. A gate whose verdict depends on an inference is a
 * gate that answers differently on Tuesday.
 */

import * as os from 'os';
import { findSecretsInText } from './secrets.js';

export type ScrubRule = 'secret' | 'home_path' | 'internal_host' | 'project_name';

/** The fields of a draft that are scanned. Prose only — tags are vocabulary. */
export const SCRUBBED_FIELDS = [
  'question',
  'answer',
  'working_example',
  'caveats',
  'evidence',
] as const;

export type ScrubbedField = (typeof SCRUBBED_FIELDS)[number];

export interface ScrubFinding {
  rule: ScrubRule;
  field: ScrubbedField;
  /** 1-based, within that field. */
  line: number;
  /** The exact offending text, so the user can find it. */
  excerpt: string;
  /** What it would become. */
  rewrite: string;
}

export interface ScrubContext {
  homeDir: string;
  /** Absolute path of the project being promoted from. */
  projectPath: string;
  /** Its name in the brain, replaced by a neutral placeholder. */
  selfProjectName: string;
  /**
   * Every OTHER project this machine knows about, with its module count.
   * The count is what makes the replacement useful rather than merely
   * anonymous: "the 18-module project" is still a sentence somebody can
   * reason about, which is how `d342442`'s own scrub was worded.
   */
  otherProjects: Array<{ name: string; modules: number }>;
}

/** The subset of a draft this module reads. */
export type ScrubbableDraft = Partial<Record<ScrubbedField, string | null | undefined>>;

/**
 * Words that are project names on this machine AND ordinary English.
 *
 * Without this list a project called `api` turns every sentence containing the
 * word "api" into a finding, and a gate that fires on everything is a gate
 * people route around. Matched case-insensitively against the whole name.
 */
const COMMON_WORD_NAMES = new Set([
  'api',
  'app',
  'apps',
  'web',
  'core',
  'docs',
  'test',
  'tests',
  'demo',
  'site',
  'main',
  'data',
  'util',
  'utils',
  'admin',
  'client',
  'server',
  'backend',
  'frontend',
  'project',
  'shared',
  'common',
  'scripts',

  // The words this module puts INTO the text. A project genuinely called
  // `repo` would otherwise make every promotion fail: the first pass rewrites
  // a path to `<repo>`, the second pass sees the project name inside its own
  // replacement, and `promote_observation` refuses with "this needs wording by
  // a person" about a note that was already clean.
  //
  // Skipping them costs the one thing it sounds like it costs — a project
  // actually named `repo` or `machine` is not caught by name — and the path,
  // host and secret rules still cover every way such a project would normally
  // appear. A gate that fails closed on correct input is a gate people turn
  // off, and this is the only input that could make it do that.
  'repo',
  'home',
  'machine',
  'redacted',
  'internal',
  'another',
]);

/** Shortest name worth matching. Below this, false positives dominate. */
const MIN_NAME_LENGTH = 4;

const INTERNAL_HOST_RE = /\b[a-z0-9][a-z0-9-]*\.(?:local|internal|intranet|corp|lan|home|test)\b/gi;

/**
 * RFC1918 and friends. Deliberately NOT matching every dotted quad: a public
 * address in a note is usually documentation, and 127.0.0.1 is universal.
 */
const PRIVATE_IP_RE =
  /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g;

/** Escape a literal for use inside a RegExp. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 1-based line number of an offset inside a string. */
function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') line++;
  return line;
}

interface Replacement {
  rule: ScrubRule;
  re: RegExp;
  /** Either a literal replacement or a function of the match. */
  to: string | ((m: string) => string);
}

/**
 * Build the ordered rule list for one context.
 *
 * ORDER IS LOAD-BEARING. The project path is replaced before the home
 * directory, and the home directory before the generic `/home/<user>` shape:
 * each is a prefix of the next, so running them the other way round would
 * leave `<home>/dev-own/acme-portal` — anonymous about the developer and still
 * naming the client.
 */
/**
 * Compiled rules, memoised per context object.
 *
 * `scrubOrgNote` is called once per candidate note, and a session close can
 * offer several. Rebuilding the rule list each time means compiling one RegExp
 * per project per note — fifty projects and six candidates is three hundred
 * regex compilations to say the same thing six times.
 *
 * A WeakMap keyed on the context: the caller builds one per promotion, so the
 * cache lives exactly as long as it is valid and nothing has to invalidate it.
 */
const rulesCache = new WeakMap<ScrubContext, Replacement[]>();

function rulesFor(ctx: ScrubContext): Replacement[] {
  const cached = rulesCache.get(ctx);
  if (cached) return cached;
  const built = buildRules(ctx);
  rulesCache.set(ctx, built);
  return built;
}

function buildRules(ctx: ScrubContext): Replacement[] {
  const rules: Replacement[] = [];

  if (ctx.projectPath) {
    rules.push({ rule: 'home_path', re: new RegExp(escapeRe(ctx.projectPath), 'g'), to: '<repo>' });
  }
  if (ctx.homeDir) {
    rules.push({ rule: 'home_path', re: new RegExp(escapeRe(ctx.homeDir), 'g'), to: '<home>' });
  }
  // Someone else's home, or this one under a different spelling.
  rules.push({ rule: 'home_path', re: /(?:\/home|\/Users)\/[^/\s"'`)]+/g, to: '<home>' });

  rules.push({ rule: 'internal_host', re: INTERNAL_HOST_RE, to: '<internal-host>' });
  rules.push({ rule: 'internal_host', re: PRIVATE_IP_RE, to: '<internal-ip>' });

  // This machine's hostname: it identifies the developer's box as surely as
  // the home directory does, and it is what the identity fallback produces.
  const host = os.hostname();
  if (host && host.length >= MIN_NAME_LENGTH && !COMMON_WORD_NAMES.has(host.toLowerCase())) {
    rules.push({ rule: 'internal_host', re: new RegExp('\\b' + escapeRe(host) + '\\b', 'gi'), to: '<machine>' });
  }

  if (
    ctx.selfProjectName &&
    ctx.selfProjectName.length >= MIN_NAME_LENGTH &&
    !COMMON_WORD_NAMES.has(ctx.selfProjectName.toLowerCase())
  ) {
    rules.push({
      rule: 'project_name',
      re: new RegExp('\\b' + escapeRe(ctx.selfProjectName) + '\\b', 'gi'),
      to: '<repo>',
    });
  }

  // Longest first, so a project called "acme" does not partially rewrite
  // "acme-portal" and leave "<another project>-portal" behind.
  const others = [...ctx.otherProjects]
    .filter(
      (p) => p.name.length >= MIN_NAME_LENGTH && !COMMON_WORD_NAMES.has(p.name.toLowerCase()),
    )
    .sort((a, b) => b.name.length - a.name.length);

  for (const p of others) {
    rules.push({
      rule: 'project_name',
      re: new RegExp('\\b' + escapeRe(p.name) + '\\b', 'gi'),
      to: p.modules > 0 ? `the ${p.modules}-module project` : '<another project>',
    });
  }

  return rules;
}

export interface ScrubResult {
  findings: ScrubFinding[];
  /** The draft with every rule applied. Equal to the input when clean. */
  rewritten: ScrubbableDraft;
}

/**
 * Scan and rewrite one draft.
 *
 * Returns both halves rather than throwing, so the caller decides: the tool
 * refuses with the findings attached, and the same findings become the diff
 * the user is shown before accepting. One pass, two uses.
 */
export function scrubOrgNote(draft: ScrubbableDraft, ctx: ScrubContext): ScrubResult {
  const rules = rulesFor(ctx);
  const findings: ScrubFinding[] = [];
  const rewritten: ScrubbableDraft = { ...draft };

  for (const field of SCRUBBED_FIELDS) {
    const original = draft[field];
    if (typeof original !== 'string' || original === '') continue;

    let text = original;

    // Secrets are reported against the ORIGINAL text, so the line numbers the
    // user is shown match what they wrote, not an intermediate state.
    for (const s of findSecretsInText(original)) {
      findings.push({
        rule: 'secret',
        field,
        line: lineOf(original, s.index),
        excerpt: s.match,
        rewrite: `<redacted: ${s.what}>`,
      });
    }
    for (const s of findSecretsInText(original)) {
      text = text.split(s.match).join(`<redacted: ${s.what}>`);
    }

    for (const r of rules) {
      // Reset lastIndex: these regexes are global and reused across fields.
      r.re.lastIndex = 0;
      let m: RegExpExecArray | null;
      const hits: Array<{ match: string; index: number }> = [];
      while ((m = r.re.exec(text)) !== null) {
        hits.push({ match: m[0], index: m.index });
        if (m[0].length === 0) break;
      }
      if (hits.length === 0) continue;

      for (const h of hits) {
        const to = typeof r.to === 'string' ? r.to : r.to(h.match);
        findings.push({
          rule: r.rule,
          field,
          line: lineOf(text, h.index),
          excerpt: h.match,
          rewrite: to,
        });
      }
      r.re.lastIndex = 0;
      text = text.replace(r.re, (matched) => (typeof r.to === 'string' ? r.to : r.to(matched)));
    }

    rewritten[field] = text;
  }

  return { findings, rewritten };
}

/**
 * The findings as something a person reads.
 *
 * Rendered here rather than by the agent for the same reason the module menu
 * is: this text is printed at a decision point, and an agent rebuilding it
 * from structured data spends tokens to produce something less consistent.
 */
export function renderScrubFindings(findings: ScrubFinding[]): string {
  if (findings.length === 0) return '';
  const label: Record<ScrubRule, string> = {
    secret: 'a credential',
    home_path: 'a local path',
    internal_host: 'an internal host',
    project_name: 'a real project name',
  };
  const lines = findings.map(
    (f) =>
      `  ${f.field} line ${f.line}  ${label[f.rule]}: ${f.excerpt}\n` +
      `  ${' '.repeat(String(f.field).length)}            → ${f.rewrite}`,
  );
  return (
    `This note would carry ${findings.length} thing${findings.length === 1 ? '' : 's'} ` +
    `that should not leave this machine:\n\n${lines.join('\n')}\n`
  );
}
