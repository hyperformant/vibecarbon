/**
 * Stale Pulumi stacks in the state bucket. The e2e sweeps delete a run's
 * cloud resources but never the stack that recorded them, so dead stacks
 * piled up: on 2026-11-13 five abandoned CI stacks were removed by hand, each
 * only after every resource it recorded returned 404 by id. This is that
 * check, done by the sweep.
 *
 * A stack is `.pulumi/stacks/<project>/<stack>.json` plus a `.json.bak`.
 *
 * Rules:
 * - Only projects the caller owns (the lifecycle sweep passes the run's own
 *   project, the CI sweep the `citest-` prefix). Anything else is not ours.
 * - Decide on the `.json` when it exists, else on an orphan `.bak`, and read
 *   it just before deciding: a listing is minutes old by the time a run
 *   finishes, and a stack another run is writing must be judged as it is now.
 * - Delete only when that file reads and every resource it recorded probes
 *   `gone` (a 404 by id). Zero recorded resources counts as gone. A resource
 *   that still answers, one that errors, one with no probe for its type, an
 *   unreadable file and an incomplete listing all keep the stack, with one
 *   log line naming why. A wrong delete orphans live cloud resources; a wrong
 *   keep costs one S3 object.
 * - Delete history and locks first and the stack file last, so a half-done
 *   delete leaves a stack the next sweep finds and finishes.
 * - Never a failed sweep. Stacks cost nothing, so every failure is a warning.
 */

export interface StateStoreApi {
  /** Keys under a prefix; complete=false when a page was unreadable. */
  list(prefix: string): Promise<{ keys: string[]; complete: boolean }>;
  /** Parsed JSON of one key, null when it is missing or unreadable. */
  read(key: string): Promise<unknown | null>;
  /** Delete keys; returns the ones now gone (deleted now, or already absent). */
  remove(keys: string[]): Promise<string[]>;
}

export interface RecordedResource {
  type: string;
  id: string;
  urn?: string;
  inputs?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
}

export type ProbeResult = 'gone' | 'present' | 'unknown';
export type ResourceProbe = (r: RecordedResource) => Promise<ProbeResult>;

const STACKS = '.pulumi/stacks/';
const PROBE_CONCURRENCY = 4;

/**
 * The resources a stack file records, from `checkpoint.latest.resources`.
 * Type and id stay plain JSON even when other fields are secrets, so no
 * passphrase is needed. Pulumi's own `pulumi:*` types (the stack, providers)
 * and resources without an id (never created) are dropped. An absent
 * `latest` is an empty stack.
 */
export function recordedResources(stackFile: unknown): RecordedResource[] {
  const resources = (stackFile as { checkpoint?: { latest?: { resources?: unknown } } } | null)
    ?.checkpoint?.latest?.resources;
  if (!Array.isArray(resources)) return [];
  return resources.filter(
    (r): r is RecordedResource =>
      r != null &&
      typeof r.type === 'string' &&
      !r.type.startsWith('pulumi:') &&
      typeof r.id === 'string' &&
      r.id !== '',
  );
}

interface StackKeys {
  project: string;
  stack: string;
  json?: string;
  bak?: string;
}

function groupStacks(keys: string[], ownsProject: (p: string) => boolean): StackKeys[] {
  const byName = new Map<string, StackKeys>();
  for (const key of keys) {
    if (!key.startsWith(STACKS)) continue;
    const parts = key.slice(STACKS.length).split('/');
    if (parts.length !== 2) continue;
    const [project, file] = parts;
    const isBak = file.endsWith('.json.bak');
    if (!isBak && !file.endsWith('.json')) continue;
    if (!ownsProject(project)) continue;
    const stack = file.slice(0, file.length - (isBak ? '.json.bak'.length : '.json'.length));
    const id = `${project}/${stack}`;
    const entry = byName.get(id) ?? { project, stack };
    if (isBak) entry.bak = key;
    else entry.json = key;
    byName.set(id, entry);
  }
  return [...byName.values()];
}

async function probeAll(
  resources: RecordedResource[],
  probe: ResourceProbe,
  warn: (msg: string) => void,
): Promise<ProbeResult[]> {
  const results: ProbeResult[] = new Array(resources.length);
  let next = 0;
  const worker = async () => {
    while (next < resources.length) {
      const i = next++;
      try {
        results[i] = await probe(resources[i]);
      } catch (e) {
        warn(`probe of ${resources[i].type} ${resources[i].id} threw: ${errText(e)}`);
        results[i] = 'unknown';
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, resources.length) }, worker));
  return results;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Delete the owned stacks whose every recorded resource is gone. Never throws. */
export async function sweepRunStacks(
  tag: string,
  ownsProject: (pulumiProject: string) => boolean,
  store: StateStoreApi,
  probe: ResourceProbe,
): Promise<{ deleted: string[]; kept: string[] }> {
  const deleted: string[] = [];
  const kept: string[] = [];
  let stacks: StackKeys[];
  try {
    const listing = await store.list(STACKS);
    if (!listing.complete) {
      console.warn(
        `${tag} [sweep] State listing incomplete; stacks past the last readable page stay`,
      );
    }
    stacks = groupStacks(listing.keys, ownsProject);
  } catch (e) {
    console.warn(`${tag} [sweep] Stack cleanup skipped: ${errText(e)}`);
    return { deleted, kept };
  }

  for (const s of stacks) {
    const name = `${s.project}/${s.stack}`;
    const keep = (why: string) => {
      kept.push(name);
      console.log(`${tag} [sweep] Stack ${name} kept: ${why}`);
    };
    const warn = (msg: string) => console.warn(`${tag} [sweep] Stack ${name}: ${msg}`);
    try {
      const decidedOn = s.json ?? (s.bak as string);
      const file = await store.read(decidedOn);
      if (file == null) {
        keep(`could not read ${decidedOn}`);
        continue;
      }
      const resources = recordedResources(file);
      const results = await probeAll(resources, probe, warn);
      const blocker = results.findIndex((r) => r !== 'gone');
      if (blocker !== -1) {
        const r = resources[blocker];
        keep(
          results[blocker] === 'present'
            ? `${r.type} ${r.id} still exists`
            : `${r.type} ${r.id} could not be confirmed gone`,
        );
        continue;
      }
      const history = await store.list(`.pulumi/history/${s.project}/${s.stack}/`);
      const locks = await store.list(`.pulumi/locks/organization/${s.project}/${s.stack}/`);
      if (!history.complete || !locks.complete) {
        keep('history or lock listing incomplete');
        continue;
      }
      const aux = [...history.keys, ...locks.keys];
      const auxGone = aux.length === 0 ? [] : await store.remove(aux);
      if (aux.some((k) => !auxGone.includes(k))) {
        keep('history or lock delete incomplete');
        continue;
      }
      const files = [s.bak, s.json].filter((k): k is string => k !== undefined);
      const filesGone = await store.remove(files);
      if (files.some((k) => !filesGone.includes(k))) {
        keep('stack file delete incomplete');
        continue;
      }
      deleted.push(name);
    } catch (e) {
      warn(`left alone: ${errText(e)}`);
      if (!kept.includes(name)) kept.push(name);
    }
  }
  if (deleted.length > 0) {
    console.log(`${tag} [sweep] Deleted ${deleted.length} stale stack(s): ${deleted.join(', ')}`);
  }
  return { deleted, kept };
}
