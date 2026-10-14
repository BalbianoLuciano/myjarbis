/**
 * Secret guard for providers.config.
 *
 * `providers.config` holds the base URL, the name of a wrapper command and
 * non-sensitive identifiers. It must never hold a credential, because this
 * table is included in the brain dump — and the whole point of the dump is
 * that it goes into a git repository and travels between machines. A token
 * written here ends up committed, and once committed it is in the history
 * even after it is deleted.
 *
 * The guard is a write-time rejection rather than a lint, because the only
 * reliable moment to stop a secret is before it is stored. It errs toward
 * refusing: a false positive costs the user a rename, a false negative
 * costs them a leaked credential.
 */

import { MyJarbisError, ErrorType } from '../types.js';

/** Key names that may not appear anywhere in a config object. */
const SECRET_KEY_RE =
  /(^|[_.-])(token|secret|password|passwd|pwd|apikey|api_key|bearer|cookie|credential|private_key|privatekey|client_secret)([_.-]|$)/i;

/**
 * Keys that NAME where a credential lives rather than containing one.
 * `{"token_file": "~/.config/acme/token"}` is the shape this module's own
 * guidance tells people to use, so rejecting it would make the advice
 * impossible to follow. Checked before SECRET_KEY_RE.
 */
const POINTER_KEY_RE = /_(file|path|env|var|name|location|ref|id)$/i;

/**
 * Deliberately NOT in SECRET_KEY_RE: `auth`, `session`, `login`. They are
 * ordinary configuration words ({"auth": {"mode": "oauth"}}), and matching
 * them rejected the whole subtree while reporting the parent instead of the
 * actual offending key. The nested credential is caught precisely instead.
 */

/**
 * Values that look like a credential regardless of their key name, so that
 * `config: { note: "use ghp_abc..." }` is caught too. Kept narrow and
 * anchored on recognisable prefixes and structures rather than "long
 * random-looking string", which would reject ordinary ids.
 */
const SECRET_VALUE_PATTERNS: Array<{ re: RegExp; what: string }> = [
  { re: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/, what: 'a GitHub token' },
  { re: /\bglpat-[A-Za-z0-9_-]{16,}\b/, what: 'a GitLab personal access token' },
  { re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/, what: 'a Slack token' },
  { re: /\bsk-[A-Za-z0-9]{16,}\b/, what: 'an API secret key' },
  { re: /\bAKIA[0-9A-Z]{16}\b/, what: 'an AWS access key id' },
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, what: 'a JWT' },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, what: 'a private key' },
  // Credentials embedded in a URL: scheme://user:pass@host
  { re: /[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i, what: 'credentials inside a URL' },
];

export interface SecretFinding {
  /** Dotted path to the offending entry, e.g. "auth.token". */
  path: string;
  reason: string;
}

/** Walk a parsed config object and report everything that looks sensitive. */
export function findSecrets(config: unknown, basePath = ''): SecretFinding[] {
  const findings: SecretFinding[] = [];

  const walk = (node: unknown, path: string): void => {
    if (node === null || node === undefined) return;

    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${path}[${i}]`));
      return;
    }

    if (typeof node === 'object') {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        const here = path ? `${path}.${k}` : k;
        // A pointer to a credential is the supported pattern, not a leak.
        // Still scan its value, so token_file: "ghp_..." is not a loophole.
        if (POINTER_KEY_RE.test(k)) {
          walk(v, here);
          continue;
        }
        if (SECRET_KEY_RE.test(k)) {
          findings.push({
            path: here,
            reason: `the key "${k}" names a credential`,
          });
          // Do not descend: whatever is under a secret-named key is also out.
          continue;
        }
        walk(v, here);
      }
      return;
    }

    if (typeof node === 'string') {
      for (const p of SECRET_VALUE_PATTERNS) {
        if (p.re.test(node)) {
          findings.push({ path: path || '(value)', reason: `the value looks like ${p.what}` });
          break;
        }
      }
    }
  };

  walk(config, basePath);
  return findings;
}

/** Where credentials are supposed to live, quoted in every rejection. */
export const SECRET_GUIDANCE =
  'Credentials do not belong in the brain: providers.config is included in ' +
  '`myjarbis brain export`, which is meant to be committed to a git repo. ' +
  'Keep the secret in a file outside the DB with 0600 permissions (or in your ' +
  'shell environment) and put only its location here — for example ' +
  '{"token_file": "~/.config/acme/token"}.';

/**
 * Parse and validate a provider config, returning the JSON to store.
 *
 * Throws SECRET_IN_CONFIG listing every offending path, so the user fixes
 * the whole object in one go rather than one rejection at a time.
 */
export function validateProviderConfig(raw: string | object | null | undefined): string | null {
  if (raw === null || raw === undefined || raw === '') return null;

  let parsed: unknown;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new MyJarbisError(
        ErrorType.INVALID_INPUT,
        `provider config must be valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else {
    parsed = raw;
  }

  const findings = findSecrets(parsed);
  if (findings.length > 0) {
    throw new MyJarbisError(
      ErrorType.SECRET_IN_CONFIG,
      `Refusing to store ${findings.length} secret-looking ${
        findings.length === 1 ? 'entry' : 'entries'
      } in provider config:\n` +
        findings.map((f) => `  · ${f.path} — ${f.reason}`).join('\n') +
        `\n\n${SECRET_GUIDANCE}`,
      { findings },
    );
  }

  return JSON.stringify(parsed);
}
