import fs from 'node:fs/promises';
import type { HostMaintenance, HostServer } from '../../shared/host-maintenance';
import { k8sGetJson } from './k8s-api';
import { isDocker as runtimeIsDocker, isKubernetes as runtimeIsKubernetes } from './runtime-env';

export type { HostMaintenance, HostServer };

/** The reporter's node annotation (src/lib/host-state.js HOST_STATE_ANNOTATION). */
const HOST_STATE_ANNOTATION = 'vibecarbon.dev/host-state';
/** The compose host dir, bind-mounted read-only. */
const COMPOSE_STATE_DIR = '/host-status';
const COMPOSE_STATE_FILE = `${COMPOSE_STATE_DIR}/state.json`;

const MAX_PACKAGES = 20;
// The parser is the trust boundary: a k8s node's own credential can rewrite its
// annotation, and what passes here reaches HTML and email. These limits are
// identical to the CLI's parser (src/lib/host-state.js); keep them in step.
const MAX_TEXT_LENGTH = 16384;
const HOST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;
const SINCE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const PACKAGE_PATTERN = /^[a-z0-9][a-z0-9+.-]{0,127}(:[a-z0-9-]{1,32})?$/;
const ENV_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;

export type HostState = {
  host: string;
  rebootRequired: boolean;
  since: string | null;
  packages: string[];
};

/** Port of parseHostState in src/lib/host-state.js. null for anything invalid. */
export function parseHostState(text: string): HostState | null {
  if (typeof text !== 'string' || text.length > MAX_TEXT_LENGTH) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1) return null;
  if (typeof r.host !== 'string' || typeof r.rebootRequired !== 'boolean') return null;
  if (!HOST_PATTERN.test(r.host)) return null;
  if (
    r.since !== null &&
    (typeof r.since !== 'string' ||
      !SINCE_PATTERN.test(r.since) ||
      Number.isNaN(Date.parse(r.since)))
  ) {
    return null;
  }
  if (!Array.isArray(r.packages) || !r.packages.every((p) => typeof p === 'string')) return null;
  return {
    host: r.host,
    rebootRequired: r.rebootRequired,
    since: r.since,
    packages: (r.packages as string[])
      .filter((p) => PACKAGE_PATTERN.test(p))
      .slice(0, MAX_PACKAGES),
  };
}

export type HostMaintenanceDeps = {
  isKubernetes?: boolean;
  isDocker?: boolean;
  readFile?: (path: string) => Promise<string>;
  /** Size in bytes of state.json; rejects ENOENT when it does not exist. */
  fileSize?: (path: string) => Promise<number>;
  /** Whether /host-status exists (the compose bind mount). */
  dirExists?: () => Promise<boolean>;
  getNodes?: () => Promise<{ items: unknown[] }>;
};

const isMissing = (err: unknown) =>
  typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT';

const notReporting = (name: string): HostServer => ({
  name,
  reporting: false,
  rebootRequired: false,
  since: null,
  packages: [],
});

function serverFromState(name: string, state: HostState | null): HostServer {
  if (!state) return notReporting(name);
  return {
    name,
    reporting: true,
    rebootRequired: state.rebootRequired,
    since: state.since,
    packages: state.packages,
  };
}

function envName(): string | null {
  const v = process.env.VIBECARBON_ENV;
  return v && ENV_NAME_PATTERN.test(v) ? v : null;
}

function summarize(runtime: HostMaintenance['runtime'], servers: HostServer[]): HostMaintenance {
  const due = servers.filter((s) => s.rebootRequired);
  const sinces = due.map((s) => s.since).filter((s): s is string => s !== null);
  return {
    runtime,
    envName: envName(),
    rebootRequired: due.length > 0,
    // The fixed-width UTC format sorts the same as the dates it names.
    since: sinces.length > 0 ? [...sinces].sort()[0] : null,
    servers,
  };
}

async function dirExists(): Promise<boolean> {
  try {
    return (await fs.stat(COMPOSE_STATE_DIR)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Which servers need a restart, read from what the host reporter published.
 * A read that fails REJECTS: "could not read" must never look like "not due".
 */
export async function readHostMaintenance(
  deps: HostMaintenanceDeps = {}
): Promise<HostMaintenance> {
  const kubernetes = deps.isKubernetes ?? runtimeIsKubernetes;
  const docker = deps.isDocker ?? runtimeIsDocker;

  if (kubernetes) {
    const getNodes = deps.getNodes ?? (() => k8sGetJson<{ items: unknown[] }>('/api/v1/nodes'));
    const { items } = await getNodes();
    const servers = items.map((item) => {
      const node = item as {
        metadata?: { name?: string; annotations?: Record<string, string> };
      };
      const text = node.metadata?.annotations?.[HOST_STATE_ANNOTATION];
      const state = typeof text === 'string' ? parseHostState(text) : null;
      return serverFromState(node.metadata?.name ?? 'unknown', state);
    });
    return summarize('kubernetes', servers);
  }

  if (docker) {
    const readFile = deps.readFile ?? ((p: string) => fs.readFile(p, 'utf-8'));
    try {
      // An injected readFile with no fileSize is a test double with no real file.
      const fileSize =
        deps.fileSize ??
        (deps.readFile ? async () => 0 : async (p: string) => (await fs.stat(p)).size);
      // A file over the parser's limit is never read in full: it is treated
      // like an unparseable one.
      const text =
        (await fileSize(COMPOSE_STATE_FILE)) > MAX_TEXT_LENGTH
          ? ''
          : await readFile(COMPOSE_STATE_FILE);
      const state = parseHostState(text);
      return summarize('compose', [serverFromState(state?.host ?? 'this server', state)]);
    } catch (err) {
      if (!isMissing(err)) throw err;
      // No file: with the directory it is a server that has not reported yet;
      // without the directory there is no bind mount (local dev).
      if (await (deps.dirExists ?? dirExists)()) {
        return summarize('compose', [notReporting('this server')]);
      }
      return summarize('none', []);
    }
  }

  return summarize('none', []);
}
