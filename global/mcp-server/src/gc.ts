/**
 * Collecting the litter MyJarbis leaves behind.
 *
 * Every one of these categories was found by hand on a real installation,
 * and each is the residue of a bug that is now fixed — which is exactly
 * why a command is needed: the fix stops new litter, it does not sweep up
 * the old. Measured on the machine this was written on: 198 dead MCP
 * registrations, 122 project directories in Claude Code's own config, and
 * ~150 MB of superseded brain backups.
 *
 * Two rules it does not break:
 *
 *   · Reporting is the default. `--apply` is required to delete anything,
 *     for the same reason `migrate` is not automatic.
 *   · It only removes things it can prove MyJarbis wrote. A generated
 *     MEMORY.md is identified by its header, not by living in a directory
 *     that looks disposable.
 *
 * It never touches a `memory.db`, and never the rollback copies a migration
 * or a merge left behind unless asked: those are somebody's way back.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readRegistryRaw, registryPath } from './org/registry.js';

export interface GcItem {
  kind: string;
  what: string;
  bytes: number;
  why: string;
}

export interface GcReport {
  applied: boolean;
  olderThanDays: number;
  items: GcItem[];
  totals: { count: number; bytes: number };
  errors: string[];
}

const GENERATED_MEMORY_HEADER = '# Auto-memory pointer';

function sizeOf(p: string): number {
  try {
    const st = fs.statSync(p);
    if (st.isFile()) return st.size;
    let n = 0;
    for (const e of fs.readdirSync(p)) n += sizeOf(path.join(p, e));
    return n;
  } catch {
    return 0;
  }
}

function ageDays(p: string): number {
  try {
    return (Date.now() - fs.statSync(p).mtimeMs) / 86_400_000;
  } catch {
    return 0;
  }
}

/** Superseded brain backups, by age. Rollback copies are excluded. */
function findStaleBackups(olderThanDays: number): GcItem[] {
  const out: GcItem[] = [];
  const dirs = new Set<string>([path.join(os.homedir(), '.myjarbis')]);
  for (const e of readRegistryRaw()) dirs.add(path.join(e.path, '.myjarbis'));

  // `.silo-retired-` and `.merged-` are deliberately absent: those are how
  // a project goes back to its own brain after a merge.
  const sweepable = /\.(pre-v\d+|pre-merge|bak)\.[0-9TZ:.-]+(-wal|-shm)?$/;
  const dryrun = /\.dryrun\.\d+(-wal|-shm)?$/;

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.startsWith('memory.db.')) continue;
      const full = path.join(dir, name);
      if (dryrun.test(name)) {
        out.push({
          kind: 'dryrun-leftover',
          what: full,
          bytes: sizeOf(full),
          why: 'a --dry-run copy that outlived its run',
        });
        continue;
      }
      if (!sweepable.test(name)) continue;
      const age = ageDays(full);
      if (age < olderThanDays) continue;
      out.push({
        kind: 'old-backup',
        what: full,
        bytes: sizeOf(full),
        why: `superseded backup, ${Math.floor(age)} days old`,
      });
    }
  }
  return out;
}

/** Registry rows whose directory is gone. */
function findDeadRegistry(): GcItem[] {
  return readRegistryRaw()
    .filter((e) => !fs.existsSync(e.path))
    .map((e) => ({
      kind: 'dead-registry',
      what: e.name,
      bytes: 0,
      why: `registered at ${e.path}, which no longer exists`,
    }));
}

function claudeConfigPath(): string {
  return path.join(os.homedir(), '.claude.json');
}

/** `mcpServers.myjarbis` entries pointing at directories that are gone. */
function findDeadMcp(): GcItem[] {
  const file = claudeConfigPath();
  if (!fs.existsSync(file)) return [];
  let cfg: { projects?: Record<string, { mcpServers?: Record<string, unknown> }> };
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return [];
  }
  const out: GcItem[] = [];
  for (const [p, v] of Object.entries(cfg.projects ?? {})) {
    if (!v?.mcpServers?.myjarbis) continue;
    if (fs.existsSync(p)) continue;
    out.push({
      kind: 'dead-mcp',
      what: p,
      bytes: 0,
      why: 'myjarbis registered in ~/.claude.json for a directory that is gone',
    });
  }
  return out;
}

/**
 * Claude Code project directories holding nothing but a MEMORY.md this
 * tool generated, for a path that no longer exists.
 *
 * Three conditions, all required: the project path is gone, the directory
 * contains no session transcript, and the MEMORY.md carries the header
 * `init` writes. Anything with a `.jsonl` in it is somebody's conversation
 * and is never touched.
 */
function findOrphanClaudeProjects(): GcItem[] {
  const root = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(root)) return [];
  const out: GcItem[] = [];
  for (const slug of fs.readdirSync(root)) {
    const dir = path.join(root, slug);
    let stack: string[];
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
      stack = fs.readdirSync(dir);
    } catch {
      continue;
    }
    if (stack.length !== 1 || stack[0] !== 'memory') continue;

    const memDir = path.join(dir, 'memory');
    let files: string[];
    try {
      files = fs.readdirSync(memDir);
    } catch {
      continue;
    }
    const onlyMemory = files.every((f) => f === 'MEMORY.md' || f.startsWith('MEMORY.md.bak.'));
    if (!onlyMemory || !files.includes('MEMORY.md')) continue;

    let head = '';
    try {
      head = fs.readFileSync(path.join(memDir, 'MEMORY.md'), 'utf-8').slice(0, 80);
    } catch {
      continue;
    }
    if (!head.startsWith(GENERATED_MEMORY_HEADER)) continue;

    // The slug is the path with separators replaced, which is not reversible
    // without ambiguity. Only act when the leading segment makes it certain
    // this was a throwaway directory.
    if (!slug.startsWith('-tmp-')) continue;

    out.push({
      kind: 'orphan-claude-project',
      what: dir,
      bytes: sizeOf(dir),
      why: 'only a generated MEMORY.md, no transcript, temp path',
    });
  }
  return out;
}

function pruneRegistry(names: string[], errors: string[]): void {
  const file = registryPath();
  if (!fs.existsSync(file) || names.length === 0) return;
  try {
    fs.copyFileSync(file, `${file}.bak-${Date.now()}`);
    const cfg = JSON.parse(fs.readFileSync(file, 'utf-8'));
    for (const n of names) delete cfg.projects?.[n];
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
  } catch (e) {
    errors.push(`registry: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function pruneClaudeConfig(paths: string[], errors: string[]): void {
  const file = claudeConfigPath();
  if (!fs.existsSync(file) || paths.length === 0) return;
  try {
    // This file belongs to Claude Code and holds far more than our entries.
    // Back it up, remove only `mcpServers.myjarbis`, and leave the project
    // entry itself if anything else lives under it.
    fs.copyFileSync(file, `${file}.bak-${Date.now()}`);
    const cfg = JSON.parse(fs.readFileSync(file, 'utf-8'));
    for (const p of paths) {
      const entry = cfg.projects?.[p];
      if (!entry?.mcpServers?.myjarbis) continue;
      delete entry.mcpServers.myjarbis;
      const noServersLeft = Object.keys(entry.mcpServers).length === 0;
      const noOtherKeys = Object.keys(entry).every(
        (k) => k === 'mcpServers' || (Array.isArray(entry[k]) && entry[k].length === 0),
      );
      if (noServersLeft && noOtherKeys) delete cfg.projects[p];
    }
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
  } catch (e) {
    errors.push(`~/.claude.json: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function runGarbageCollect(opts: { apply?: boolean; olderThanDays?: number }): GcReport {
  const olderThanDays = opts.olderThanDays ?? 30;
  const errors: string[] = [];

  const items = [
    ...findDeadRegistry(),
    ...findDeadMcp(),
    ...findStaleBackups(olderThanDays),
    ...findOrphanClaudeProjects(),
  ];

  if (opts.apply) {
    pruneRegistry(
      items.filter((i) => i.kind === 'dead-registry').map((i) => i.what),
      errors,
    );
    pruneClaudeConfig(
      items.filter((i) => i.kind === 'dead-mcp').map((i) => i.what),
      errors,
    );
    for (const i of items) {
      if (i.kind !== 'old-backup' && i.kind !== 'dryrun-leftover' && i.kind !== 'orphan-claude-project') {
        continue;
      }
      try {
        fs.rmSync(i.what, { recursive: true, force: true });
      } catch (e) {
        errors.push(`${i.what}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  return {
    applied: Boolean(opts.apply),
    olderThanDays,
    items,
    totals: { count: items.length, bytes: items.reduce((a, i) => a + i.bytes, 0) },
    errors,
  };
}
