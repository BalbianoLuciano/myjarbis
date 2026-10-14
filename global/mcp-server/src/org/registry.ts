/**
 * The projects registry — the only index of where every project lives.
 *
 * `~/.myjarbis-global/projects-registry.json` is written by `myjarbis init`
 * and maps a project name to its path. It is what makes cross-project work
 * possible for silo projects: their rows live in their own files, so there
 * is no single table to query, and the registry is how we find the files.
 *
 * It is treated as a hint, not as truth: entries go stale when a project is
 * moved or deleted, so every consumer re-checks the path exists and skips
 * what is gone rather than failing the whole run.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface RegistryEntry {
  name: string;
  path: string;
  framework?: string;
  initialized?: string;
}

/**
 * `MYJARBIS_REGISTRY` overrides the location outright. The registry
 * otherwise lives next to the install, which is also where the build lives
 * — so a test that needs its own registry would have to relocate the build
 * too, and would end up sharing one registry across runs. Cross-project
 * commands (`org sync`, `migrate --all`) then operate on leftovers from
 * previous runs, which is exactly the sort of non-hermetic test that stops
 * meaning anything.
 */
export function registryPath(): string {
  if (process.env.MYJARBIS_REGISTRY) return path.resolve(process.env.MYJARBIS_REGISTRY);
  const installDir =
    process.env.MYJARBIS_INSTALL_DIR || path.join(os.homedir(), '.myjarbis-global');
  return path.join(installDir, 'projects-registry.json');
}

/** Every registered project whose path still exists. */
export function readRegistry(): RegistryEntry[] {
  const file = registryPath();
  if (!fs.existsSync(file)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    // A corrupt registry must not take down every command that consults it.
    // install.sh validates what it writes; this is the read-side guard.
    return [];
  }
  const projects =
    parsed && typeof parsed === 'object'
      ? ((parsed as { projects?: Record<string, RegistryEntry> }).projects ?? {})
      : {};

  return Object.entries(projects)
    .map(([name, v]) => ({ ...v, name: v?.name ?? name }))
    .filter((e): e is RegistryEntry => typeof e.path === 'string' && e.path.length > 0)
    .filter((e) => fs.existsSync(e.path));
}
