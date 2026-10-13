/**
 * A deliberately small YAML reader, for pack manifests only.
 *
 * MyJarbis ships with two runtime dependencies and the pack contract needs
 * about six YAML features, so pulling in a full parser would roughly double
 * the dependency surface to read a handful of config files. The alternative
 * failure mode — a hand-rolled parser that *guesses* at syntax it does not
 * understand — is worse than either, because a silently mis-parsed manifest
 * produces a project configured differently from what its author wrote.
 *
 * So this parser implements an explicit subset and REFUSES everything else
 * with the line number and a reason. Supported:
 *
 *   key: value              scalars: string, number, true/false, null/~
 *   key:                    nested map, by two-space indentation
 *     nested: value
 *   key:                    list of scalars
 *     - one
 *     - two
 *   key:                    list of maps
 *     - name: a
 *       actor: agent
 *   key: |                  block scalars, with - and + chomping
 *     literal text
 *   key: >-                 folded: newlines become spaces
 *     wrapped prose
 *   # comments, blank lines
 *   'single' and "double" quoted strings
 *
 * Block scalars are in rather than out because `notes:` on a workflow step
 * is prose, and `>-` is what anybody writing prose in YAML reaches for
 * first. Leaving them out meant the very first manifest written against
 * this contract — the example pack in this repository — was rejected.
 *
 * Explicitly rejected (so they cannot be misread): anchors and aliases
 * (& * <<), multiple documents, flow collections ({} and []), and tabs
 * used for indentation.
 *
 * JSON is accepted as an alternative for every manifest, so an author who
 * needs more than this subset has a way out.
 */

export type YamlValue = string | number | boolean | null | YamlValue[] | YamlMap;
export interface YamlMap {
  [key: string]: YamlValue;
}

export class YamlError extends Error {
  constructor(
    message: string,
    public line: number,
  ) {
    super(`line ${line}: ${message}`);
    this.name = 'YamlError';
  }
}

interface Line {
  /** 1-based, as it appears in the file. */
  no: number;
  indent: number;
  text: string;
  /** 0-based index into the raw split, so block scalars can read the
   *  original lines back — `scan` drops blanks and comments, which a
   *  literal block has to preserve. */
  rawIndex: number;
}

interface Scanned {
  lines: Line[];
  raw: string[];
}

const REJECTED: Array<{ test: RegExp; why: string }> = [
  { test: /^[&*]/, why: 'anchors and aliases are not supported; write the value out' },
  { test: /^<</, why: 'merge keys (<<) are not supported; write the keys out' },
];

/** A block scalar header: `|`, `>`, with optional chomping and indent. */
const BLOCK_HEADER_RE = /^([|>])([+-]?)(\d*)\s*$/;

function scan(src: string): Scanned {
  const out: Line[] = [];
  const raw = src.split(/\r?\n/);

  // Line ranges owned by a block scalar: their content is data, not
  // structure, so indentation and blank-line rules must not apply to them.
  const blockRanges: Array<[number, number]> = [];
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i];
    const m = /^( *)[^:#]*:\s*([|>][+-]?\d*)\s*$/.exec(line);
    if (!m) continue;
    const keyIndent = m[1].length;
    let j = i + 1;
    while (j < raw.length) {
      if (/^\s*$/.test(raw[j])) {
        j++;
        continue;
      }
      const ind = raw[j].length - raw[j].replace(/^[ \t]+/, '').length;
      if (ind <= keyIndent) break;
      j++;
    }
    blockRanges.push([i + 1, j - 1]);
  }
  const inBlock = (i: number): boolean =>
    blockRanges.some(([a, b]) => i >= a && i <= b);

  for (let i = 0; i < raw.length; i++) {
    const no = i + 1;
    const line = raw[i];

    if (inBlock(i)) continue;
    if (/^\s*$/.test(line)) continue;
    if (/^\s*#/.test(line)) continue;
    if (/^---\s*$/.test(line) || /^\.\.\.\s*$/.test(line)) {
      // A lone --- at the top is harmless; anywhere else it is a second
      // document, which would mean silently dropping content.
      if (out.length === 0) continue;
      throw new YamlError('multiple YAML documents are not supported', no);
    }
    if (/^\t/.test(line) || /^ *\t/.test(line)) {
      throw new YamlError('tabs cannot be used for indentation', no);
    }

    const indent = line.length - line.replace(/^ +/, '').length;
    if (indent % 2 !== 0) {
      throw new YamlError(`indentation must be a multiple of 2 (got ${indent})`, no);
    }
    out.push({ no, indent, text: line.trim(), rawIndex: i });
  }
  return { lines: out, raw };
}

/**
 * Read a block scalar that starts after `raw[keyIndex]`.
 *
 * `|` keeps newlines, `>` folds them into spaces (a blank line still means
 * a newline). Chomping: `-` strips the trailing newline, `+` keeps them all,
 * bare clips to exactly one.
 */
function readBlockScalar(
  raw: string[],
  keyIndex: number,
  keyIndent: number,
  header: string,
): { text: string; lastRawIndex: number } {
  const m = BLOCK_HEADER_RE.exec(header);
  if (!m) throw new YamlError(`malformed block scalar header "${header}"`, keyIndex + 1);
  const [, style, chomp, explicitIndent] = m;

  const body: string[] = [];
  let i = keyIndex + 1;
  let contentIndent = explicitIndent ? keyIndent + parseInt(explicitIndent, 10) : -1;

  for (; i < raw.length; i++) {
    const line = raw[i];
    if (/^\s*$/.test(line)) {
      body.push('');
      continue;
    }
    const ind = line.length - line.replace(/^ +/, '').length;
    if (ind <= keyIndent) break;
    if (contentIndent < 0) contentIndent = ind;
    body.push(line.slice(Math.min(contentIndent, ind)));
  }
  const lastRawIndex = i - 1;

  // Trailing blank lines are chomping's business, not content's.
  while (body.length > 0 && body[body.length - 1] === '') body.pop();

  let text: string;
  if (style === '|') {
    text = body.join('\n');
  } else {
    const parts: string[] = [];
    let current = '';
    for (const l of body) {
      if (l === '') {
        parts.push(current);
        current = '';
        parts.push('\n');
      } else if (current === '') {
        current = l;
      } else {
        current += ' ' + l;
      }
    }
    parts.push(current);
    text = parts.join('').replace(/\n+/g, '\n');
  }

  if (chomp === '-') {
    text = text.replace(/\n+$/, '');
  } else if (chomp === '+') {
    text += '\n';
  } else {
    text = text.replace(/\n*$/, '\n');
  }

  return { text, lastRawIndex };
}

/**
 * Read the value for `key:` where `rest` is whatever followed the colon.
 *
 * Block-scalar lines were excluded from `lines` by `scan`, so there is no
 * index to advance here: the next structural line already sits past the
 * block. That is why the ranges are computed up front.
 */
function readInlineValue(
  rest: string,
  keyLine: Line,
  raw: string[],
): YamlValue {
  if (BLOCK_HEADER_RE.test(rest)) {
    return readBlockScalar(raw, keyLine.rawIndex, keyLine.indent, rest).text;
  }
  return parseScalar(rest, keyLine.no);
}

/** Strip a trailing `# comment`, honouring quotes. */
function stripComment(s: string): string {
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) {
      return s.slice(0, i).trimEnd();
    }
  }
  return s;
}

function parseScalar(raw: string, no: number): YamlValue {
  const s = stripComment(raw).trim();
  if (s === '') return null;

  for (const r of REJECTED) {
    if (r.test.test(s)) throw new YamlError(r.why, no);
  }
  if (/^[[{]/.test(s)) {
    throw new YamlError(
      'inline flow collections ([] and {}) are not supported; use block style or JSON',
      no,
    );
  }

  if (
    (s.startsWith('"') && s.endsWith('"') && s.length >= 2) ||
    (s.startsWith("'") && s.endsWith("'") && s.length >= 2)
  ) {
    const body = s.slice(1, -1);
    // Only the escapes a config file realistically needs.
    return s[0] === '"' ? body.replace(/\\n/g, '\n').replace(/\\"/g, '"') : body;
  }

  if (s === 'true' || s === 'yes') return true;
  if (s === 'false' || s === 'no') return false;
  if (s === 'null' || s === '~') return null;
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d*\.\d+$/.test(s)) return parseFloat(s);
  return s;
}

/** Split `key: rest` at the first colon that is not inside quotes. */
function splitKey(text: string, no: number): { key: string; rest: string } | null {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === ':' && (i + 1 === text.length || /[\s]/.test(text[i + 1]))) {
      let key = text.slice(0, i).trim();
      if (
        (key.startsWith('"') && key.endsWith('"')) ||
        (key.startsWith("'") && key.endsWith("'"))
      ) {
        key = key.slice(1, -1);
      }
      if (!key) throw new YamlError('empty key', no);
      return { key, rest: text.slice(i + 1).trim() };
    }
  }
  return null;
}

/** Parse the block of lines at `indent`, starting at `i`. */
function parseBlock(
  lines: Line[],
  i: number,
  indent: number,
  raw: string[],
): { value: YamlValue; next: number } {
  if (i >= lines.length) return { value: null, next: i };

  // A list, if the block starts with a dash.
  if (lines[i].text.startsWith('- ') || lines[i].text === '-') {
    const items: YamlValue[] = [];
    let k = i;
    while (k < lines.length && lines[k].indent === indent && /^-( |$)/.test(lines[k].text)) {
      const head = lines[k].text.replace(/^-\s*/, '');
      const keyLine = lines[k];
      const no = keyLine.no;
      k++;

      const kv = head ? splitKey(head, no) : null;
      if (kv) {
        // `- key: value`: a map item, whose remaining keys are indented to
        // align with the text after the dash.
        const map: YamlMap = {};
        if (kv.rest) {
          map[kv.key] = readInlineValue(kv.rest, keyLine, raw);
        } else {
          const sub = parseBlock(lines, k, indent + 4, raw);
          map[kv.key] = sub.value;
          k = sub.next;
        }
        while (k < lines.length && lines[k].indent === indent + 2) {
          const inner = splitKey(lines[k].text, lines[k].no);
          if (!inner) {
            throw new YamlError(`expected "key: value" inside a list item`, lines[k].no);
          }
          const innerLine = lines[k];
          k++;
          if (inner.rest) {
            map[inner.key] = readInlineValue(inner.rest, innerLine, raw);
          } else {
            const sub = parseBlock(lines, k, indent + 4, raw);
            map[inner.key] = sub.value;
            k = sub.next;
          }
        }
        items.push(map);
      } else if (head) {
        items.push(parseScalar(head, no));
      } else {
        const sub = parseBlock(lines, k, indent + 2, raw);
        items.push(sub.value);
        k = sub.next;
      }
    }
    return { value: items, next: k };
  }

  // Otherwise a map.
  const map: YamlMap = {};
  let k = i;
  while (k < lines.length && lines[k].indent === indent) {
    const kv = splitKey(lines[k].text, lines[k].no);
    if (!kv) {
      throw new YamlError(`expected "key: value", got "${lines[k].text}"`, lines[k].no);
    }
    const keyLine = lines[k];
    k++;
    if (kv.rest) {
      map[kv.key] = readInlineValue(kv.rest, keyLine, raw);
    } else if (k < lines.length && lines[k].indent > indent) {
      const sub = parseBlock(lines, k, lines[k].indent, raw);
      map[kv.key] = sub.value;
      k = sub.next;
    } else {
      map[kv.key] = null;
    }
  }
  if (k < lines.length && lines[k].indent > indent) {
    throw new YamlError(`unexpected indentation`, lines[k].no);
  }
  return { value: map, next: k };
}

export function parseYaml(src: string): YamlValue {
  const { lines, raw } = scan(src);
  if (lines.length === 0) return {};
  const { value, next } = parseBlock(lines, 0, lines[0].indent, raw);
  if (next < lines.length) {
    throw new YamlError('could not parse to end of document', lines[next].no);
  }
  return value;
}

/**
 * Read a manifest that may be YAML or JSON. `.json` is parsed as JSON;
 * anything else goes through the subset parser above. Offering JSON means
 * the subset is never a dead end for a pack author.
 */
export function parseManifest(filename: string, src: string): YamlValue {
  if (/\.json$/i.test(filename)) {
    try {
      return JSON.parse(src) as YamlValue;
    } catch (err) {
      throw new Error(
        `${filename}: invalid JSON — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  try {
    return parseYaml(src);
  } catch (err) {
    if (err instanceof YamlError) {
      throw new Error(
        `${filename}: ${err.message}. This reader supports a documented YAML ` +
          `subset; rename to .json and use JSON if you need more.`,
      );
    }
    throw err;
  }
}

/**
 * Split `---`-delimited frontmatter from a markdown body.
 *
 * Returns an empty map when there is no frontmatter, so a skill file
 * without one is still usable (its name comes from the filename).
 */
export function parseFrontmatter(src: string): { data: YamlMap; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(src);
  if (!m) return { data: {}, body: src };
  const parsed = parseYaml(m[1]);
  const data =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as YamlMap) : {};
  return { data, body: m[2] };
}

// ─────────────────────────────────────────────────────────────────────
// Typed accessors — so callers read a manifest without casting
// ─────────────────────────────────────────────────────────────────────

export function asMap(v: YamlValue, what: string): YamlMap {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as YamlMap;
  throw new Error(`${what}: expected a mapping`);
}

export function asList(v: YamlValue, what: string): YamlValue[] {
  if (Array.isArray(v)) return v;
  if (v === null || v === undefined) return [];
  throw new Error(`${what}: expected a list`);
}

export function asString(v: YamlValue, what: string): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  throw new Error(`${what}: expected a string`);
}

export function optString(v: YamlValue | undefined): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return undefined;
}

export function optNumber(v: YamlValue | undefined): number | undefined {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return parseInt(v, 10);
  return undefined;
}

export function optBool(v: YamlValue | undefined): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return undefined;
}
