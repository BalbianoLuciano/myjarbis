/**
 * Step conditions — decidable, not prose.
 *
 * A workflow step can be conditional. The obvious design is to let the
 * condition be free text and have the agent judge it, but that reintroduces
 * exactly what workflows-as-data exists to remove: process semantics that
 * get reinterpreted differently each session. The evidence for that is three
 * consecutive decision notes in one real brain that contradict each other
 * about when to stop and ask for approval — a field changing value, written
 * as three documents.
 *
 * So a `condition` is a small expression over facts MyJarbis can actually
 * look up, and anything advisory goes in `notes` instead, where it is
 * clearly advice rather than a gate.
 *
 *   branch == main
 *   tracker != none && branch ~= release/*
 *   framework in [laravel, express]
 *   has_forge == true
 *
 * Grammar:
 *   condition := clause ("&&" clause)*
 *   clause    := field op value
 *   op        := "==" | "!=" | "~=" | "in"
 *   value     := bare-word | "quoted string" | [a, b, c]   (for `in`)
 *
 * There is no `||` by design: two alternatives are two steps, which keeps
 * the resolved workflow a flat readable list. `~=` is a glob (`*` only).
 */

import { MyJarbisError, ErrorType } from '../types.js';

/** The facts a condition may test. A closed set: an unknown field is an
 *  error at pack-load time rather than something that silently never
 *  matches, which would skip a gate without anybody noticing. */
export const CONDITION_FIELDS = [
  'branch',
  'module',
  'framework',
  'tracker',
  'forge',
  'ci',
  'has_tracker',
  'has_forge',
  'has_ci',
] as const;

export type ConditionField = (typeof CONDITION_FIELDS)[number];

export type ConditionOp = '==' | '!=' | '~=' | 'in';

export interface Clause {
  field: ConditionField;
  op: ConditionOp;
  /** Single value, or the list for `in`. */
  values: string[];
}

/** Everything a condition can be evaluated against. Absent facts are
 *  'none', so `tracker != none` reads naturally. */
export interface ConditionFacts {
  branch?: string | null;
  module?: string | null;
  framework?: string | null;
  tracker?: string | null;
  forge?: string | null;
  ci?: string | null;
}

const CLAUSE_RE = /^\s*([a-z_]+)\s*(==|!=|~=|\bin\b)\s*(.+?)\s*$/;

function unquote(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

export function parseCondition(src: string): Clause[] {
  const clauses: Clause[] = [];

  for (const part of src.split('&&')) {
    const raw = part.trim();
    if (!raw) continue;

    if (/\|\|/.test(raw)) {
      throw new MyJarbisError(
        ErrorType.INVALID_INPUT,
        `"||" is not supported in a condition. Two alternatives should be two ` +
          `steps, so the resolved workflow stays a flat list. Got: ${raw}`,
      );
    }

    const m = CLAUSE_RE.exec(raw);
    if (!m) {
      throw new MyJarbisError(
        ErrorType.INVALID_INPUT,
        `cannot parse condition clause "${raw}". Expected "<field> <op> <value>" ` +
          `with op one of ==, !=, ~=, in.`,
      );
    }

    const field = m[1] as ConditionField;
    if (!CONDITION_FIELDS.includes(field)) {
      throw new MyJarbisError(
        ErrorType.INVALID_INPUT,
        `unknown condition field "${field}". Known fields: ${CONDITION_FIELDS.join(', ')}. ` +
          `If the rule cannot be expressed over these, it is guidance rather than ` +
          `a gate — put it in the step's notes.`,
      );
    }

    const op = (m[2] === 'in' ? 'in' : m[2]) as ConditionOp;
    const rhs = m[3].trim();

    let values: string[];
    if (op === 'in') {
      const list = /^\[(.*)\]$/.exec(rhs);
      if (!list) {
        throw new MyJarbisError(
          ErrorType.INVALID_INPUT,
          `"in" needs a bracketed list, e.g. framework in [laravel, express]. Got: ${rhs}`,
        );
      }
      values = list[1]
        .split(',')
        .map((v) => unquote(v))
        .filter((v) => v.length > 0);
      if (values.length === 0) {
        throw new MyJarbisError(ErrorType.INVALID_INPUT, `empty list in condition "${raw}"`);
      }
    } else {
      if (/^\[/.test(rhs)) {
        throw new MyJarbisError(
          ErrorType.INVALID_INPUT,
          `a list needs the "in" operator, not "${op}". Got: ${raw}`,
        );
      }
      values = [unquote(rhs)];
    }

    clauses.push({ field, op, values });
  }

  if (clauses.length === 0) {
    throw new MyJarbisError(ErrorType.INVALID_INPUT, 'condition is empty');
  }
  return clauses;
}

/** Parse for validation only, prefixing errors with where they came from. */
export function assertCondition(src: string, where: string): void {
  try {
    parseCondition(src);
  } catch (err) {
    throw new MyJarbisError(
      ErrorType.PACK_ERROR,
      `${where}: invalid condition — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Glob match supporting `*` only, anchored at both ends. */
function globMatch(pattern: string, value: string): boolean {
  const re = new RegExp(
    '^' +
      pattern
        .split('*')
        .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*') +
      '$',
  );
  return re.test(value);
}

function factValue(field: ConditionField, facts: ConditionFacts): string {
  switch (field) {
    case 'branch':
      return facts.branch ?? 'none';
    case 'module':
      return facts.module ?? 'none';
    case 'framework':
      return facts.framework ?? 'none';
    case 'tracker':
      return facts.tracker ?? 'none';
    case 'forge':
      return facts.forge ?? 'none';
    case 'ci':
      return facts.ci ?? 'none';
    case 'has_tracker':
      return facts.tracker ? 'true' : 'false';
    case 'has_forge':
      return facts.forge ? 'true' : 'false';
    case 'has_ci':
      return facts.ci ? 'true' : 'false';
  }
}

export interface EvalResult {
  matched: boolean;
  /** Per-clause outcome, so a skipped step can explain itself. */
  detail: Array<{ clause: string; actual: string; matched: boolean }>;
}

export function evaluateCondition(src: string, facts: ConditionFacts): EvalResult {
  const clauses = parseCondition(src);
  const detail: EvalResult['detail'] = [];
  let all = true;

  for (const c of clauses) {
    const actual = factValue(c.field, facts);
    let ok: boolean;
    switch (c.op) {
      case '==':
        ok = actual === c.values[0];
        break;
      case '!=':
        ok = actual !== c.values[0];
        break;
      case '~=':
        ok = globMatch(c.values[0], actual);
        break;
      case 'in':
        ok = c.values.includes(actual);
        break;
    }
    detail.push({
      clause: `${c.field} ${c.op} ${c.op === 'in' ? `[${c.values.join(', ')}]` : c.values[0]}`,
      actual,
      matched: ok,
    });
    if (!ok) all = false;
  }

  return { matched: all, detail };
}
