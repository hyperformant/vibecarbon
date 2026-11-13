/**
 * Empty per-run tags, for the providers whose API keeps a tag as an account
 * object (DigitalOcean, Linode). Tagging a resource creates the tag, and it
 * stays after the last resource carrying it is deleted. Every e2e run tags
 * its servers `project:<run>` (and on Linode `cluster:<run>-<env>`), so each
 * run left those behind: 24 on DigitalOcean in a week, 78 project and 7
 * cluster tags on Linode since August (2026-11-13). Vultr and Scaleway keep
 * tags as strings on each resource, so there is nothing to leave behind
 * there (pinned by sweep-run-tags-census.test.ts).
 *
 * Rules:
 * - Only the run's own tag keys, matched by name prefix (the lifecycle sweep
 *   passes the run's project name, the CI sweep the `citest-` prefix). Shared
 *   tags (`role:db`, `environment:d1`, `managed-by:vibecarbon`) are reused by
 *   every deploy and are a small fixed set, so they stay.
 * - Only at a resource count of exactly 0, read just before the delete.
 *   Deleting a tag removes it from every resource that carries it, and the
 *   project tag is how the sweep attributes a CSI volume to its run.
 * - Never a failed sweep. A tag costs nothing, so a tag that could not be
 *   listed, read or deleted is a warning; `enumFailed` stays about billable
 *   residue only.
 */

export interface RunTagApi {
  /** Every tag on the account; complete=false when a page was unreadable. */
  list(): Promise<{ names: string[]; complete: boolean }>;
  /** How many resources carry the tag (0 when it is gone); null when unreadable. */
  resourceCount(name: string): Promise<number | null>;
  /** Delete the tag; true once it is gone (deleted now, or already absent). */
  remove(name: string): Promise<boolean>;
}

/** Hex digits of the hash a squeezed Linode tag ends with (`-` + 8 hex). */
const SQUEEZE_HASH = /-[0-9a-f]{8}$/;

/**
 * A predicate for the tags one run (or one name prefix) wrote under `keys`.
 * `encode` is the provider's own encodeLabel, so the prefix has the
 * characters the tag has. `squeezeMax` is for Linode, which squeezes a tag
 * over 50 characters to its first 41, `-` and an 8-hex hash
 * (src/lib/providers/linode.js encodeLabel): such a tag no longer starts with
 * a long project name, so its first 41 characters are compared instead.
 */
export function runTagOwner(
  projectName: string,
  keys: readonly string[],
  encode: (key: string, value: string) => string,
  opts: { squeezeMax?: number } = {},
): (tag: string) => boolean {
  const prefixes = keys.map((key) => encode(key, projectName));
  const { squeezeMax } = opts;
  return (tag) =>
    prefixes.some((prefix) => {
      if (tag.startsWith(prefix)) return true;
      if (squeezeMax === undefined || tag.length !== squeezeMax || !SQUEEZE_HASH.test(tag)) {
        return false;
      }
      const kept = tag.slice(0, squeezeMax - 9);
      return prefix.startsWith(kept);
    });
}

/** Delete the run's tags that no resource carries any more. Never throws. */
export async function sweepRunTags(
  tag: string,
  ownsTag: (name: string) => boolean,
  api: RunTagApi,
): Promise<{ deleted: string[]; kept: string[] }> {
  const deleted: string[] = [];
  const kept: string[] = [];
  let names: string[];
  try {
    const listing = await api.list();
    if (!listing.complete) {
      console.warn(`${tag} [sweep] Tag list incomplete; run tags past the last readable page stay`);
    }
    names = listing.names.filter(ownsTag);
  } catch (e) {
    console.warn(`${tag} [sweep] Tag cleanup skipped: ${e instanceof Error ? e.message : e}`);
    return { deleted, kept };
  }
  for (const name of names) {
    let count: number | null;
    try {
      count = await api.resourceCount(name);
    } catch {
      count = null;
    }
    if (count !== 0) {
      kept.push(name);
      console.log(
        count === null
          ? `${tag} [sweep] Tag ${name} kept: could not read what carries it`
          : `${tag} [sweep] Tag ${name} kept: still on ${count} resource(s)`,
      );
      continue;
    }
    let gone: boolean;
    try {
      gone = await api.remove(name);
    } catch {
      gone = false;
    }
    if (gone) deleted.push(name);
    else {
      kept.push(name);
      console.warn(`${tag} [sweep] Tag ${name} delete failed`);
    }
  }
  if (deleted.length > 0) {
    console.log(`${tag} [sweep] Deleted ${deleted.length} empty run tag(s): ${deleted.join(', ')}`);
  }
  return { deleted, kept };
}
