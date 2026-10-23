/**
 * How an org note gets from one machine to another.
 *
 * The seam is here, with exactly one driver behind it today. That is
 * deliberate: the owner's intent is that the memory eventually travels in a
 * repository of its own, separate from the code, and the only way to make that
 * a later feature rather than a later migration is to decide NOW that nothing
 * above this interface knows how the bytes move.
 *
 * What the driver does NOT get to decide, because these are properties of the
 * feature and not of the transport:
 *
 *   · pull is ADDITIVE. It never deletes a local row. basic-memory shipped a
 *     destructive mirror sync, found it unusable for teams, and disabled it on
 *     team workspaces in favour of additive push/pull only. A deletion arrives
 *     as a status transition, which is a row like any other.
 *
 *   · identity is content_hash, never a row id and never a sequence number.
 *     Ids are local. A per-org counter cannot be allocated by two offline
 *     machines without a vector clock, and a UNIQUE on it would make a pull
 *     conflict on precisely the rows it exists to merge.
 *
 *   · nothing is committed. The driver writes files and names them; a person
 *     commits. `docs/CONVENTIONS.md` requires a Why/What for/Where body that
 *     no tool can write, and forbids `git add -A`. `brain export` set this
 *     precedent already.
 */

import { ServerContext } from '../../context.js';
import { OrgIdentity, resolveIdentity } from '../identity.js';

export interface PullResult {
  dir: string;
  org: { slug: string; name: string };
  /** Rows found in the files. */
  read: number;
  /** Rows that were not already in the local mirror. */
  added: number;
  /** Rows already present, by content hash. */
  duplicates: number;
  /** Rows present locally whose status/expiry/confidence the files updated. */
  governanceUpdated: number;
  /** True when this pull is what joined the project to the org. */
  orgRegistered: boolean;
  /**
   * Notes whose `project` field names a project this machine does not have.
   * Filed org-wide rather than dropped: a lesson from a project you have not
   * cloned is still a lesson, and dropping it silently would make the store
   * quietly different on every machine.
   */
  unknownProjects: string[];
  warnings: string[];
}

export interface PushResult {
  dir: string;
  filesWritten: string[];
  /** New lines added to the file. */
  appended: number;
  /** Existing lines rewritten because their governance half changed. */
  rewritten: number;
  bytes: number;
  changed: boolean;
  /** The exact command to hand the user. We never stage and never commit. */
  stageCommand: string;
}

export interface OrgMemoryTransport {
  /** For the report, and for a future `myjarbis org status` to name. */
  readonly kind: string;
  identity(projectPath: string): OrgIdentity;
  pull(ctx: ServerContext, opts?: { dir?: string }): PullResult;
  push(ctx: ServerContext, opts?: { dir?: string }): PushResult;
}

/**
 * The single switch point.
 *
 * One driver for now. When a dedicated org repository becomes a feature, it
 * becomes a second case here and nothing above this function changes — not the
 * tables, not the tools, not the slash commands.
 */
export function transportFor(_ctx: ServerContext): OrgMemoryTransport {
  return gitProjectDriver;
}

// Imported at the bottom to keep the interface above readable; the driver
// imports the types from here, so this also documents which direction the
// dependency runs.
import { gitProjectDriver } from './gitProjectDriver.js';

/** Shared by the drivers: the identity ladder is not a transport concern. */
export function identityFor(projectPath: string): OrgIdentity {
  return resolveIdentity(projectPath);
}
