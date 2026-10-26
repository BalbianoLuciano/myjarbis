/**
 * NDJSON on disk: read it, and write it only when it changed.
 *
 * Both halves were private to `tools/brain.ts` until the org memory needed the
 * same file format for the same reason — a text projection of rows that git
 * can diff and merge line by line, instead of a binary nobody can.
 *
 * Extracted rather than copied. The error message below is the one piece of
 * this code a user ever sees, and it has to keep saying "or a merge conflict
 * was left unresolved", because that is what it usually is: two people pushed
 * and somebody committed the markers.
 */

import * as fs from 'fs';
import * as path from 'path';
import { MyJarbisError, ErrorType } from './types.js';

/**
 * Write only if the bytes differ, and report whether anything was written.
 *
 * Not an optimisation. Rewriting an identical file updates its mtime, and a
 * tool that touches every file on every run makes `git status` useless and
 * every export look like work to commit.
 */
export function writeIfChanged(file: string, contents: string): boolean {
  if (fs.existsSync(file)) {
    const current = fs.readFileSync(file, 'utf-8');
    if (current === contents) return false;
  }
  fs.writeFileSync(file, contents, 'utf-8');
  return true;
}

/** One object per line. A missing file is zero rows, not an error. */
export function parseNdjson(file: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, 'utf-8');
  const out: Array<Record<string, unknown>> = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      throw new MyJarbisError(
        ErrorType.INVALID_INPUT,
        `${path.basename(file)}:${i + 1} is not valid JSON — the dump is corrupt or a merge conflict was left unresolved.`,
        { file, line: i + 1, snippet: line.slice(0, 120) },
      );
    }
  }
  return out;
}

/** Serialise rows as NDJSON with a trailing newline, in the given key order. */
export function toNdjson(
  rows: Array<Record<string, unknown>>,
  keys: readonly string[],
): string {
  const lines = rows.map((row) => {
    // Rebuilt key by key rather than stringified as-is, so the field order in
    // the file is the declared one and not whatever order the object happens
    // to have. A file whose keys reorder between machines conflicts in git on
    // every hand-off while saying exactly the same thing.
    const ordered: Record<string, unknown> = {};
    for (const k of keys) ordered[k] = row[k] ?? null;
    return JSON.stringify(ordered);
  });
  return lines.length > 0 ? lines.join('\n') + '\n' : '';
}
