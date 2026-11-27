/**
 * What the provider says about every server of a scenario, for the failure
 * bundle (the `provider view: servers of <project>` section).
 *
 * WHY (CI run 45994716507, vultr/k8s, step scale, 2026-11-27): `scale`
 * resized three nodes in place. worker-1 went NotReady two minutes in and was
 * still NotReady 57 minutes later; the step read only `Scale exited with code
 * 1.` The bundle held kubectl state and ssh into the master and db, and
 * nothing of what Vultr said about the worker. The rig is destroyed at
 * teardown, so the provider's view is read here or never.
 *
 * The servers are the project's own, by the sweeps' ownership rule
 * (sweep-core.ts: Hetzner by its `project` label, the others by name prefix),
 * listed by the provider class's own listServersDetailed. Each is read with
 * the provider's describeServerForDiagnosis, which takes only named fields
 * (Vultr's instance read carries a default_password and a kvm URL that must
 * never reach a log), and this module writes only named fields of that view
 * too, never the object. Diagnosis only: nothing here retries, repairs or
 * throws into the writer, and the whole section is bounded.
 */
import { redactHostDiagnostics } from './host-diagnostics.js';
import { assertSweepableProjectName, hetznerServerLabels, sweepOwnsServer } from './sweep-core.js';

/** The whole section, listing and reads together. */
export const PROVIDER_VIEW_BOUND_MS = 30_000;

/** What the view carries (BaseProvider's ServerProviderView), as read here. */
interface ServerView {
  id?: string | number | null;
  name?: string | null;
  status?: string | null;
  detail?: string | null;
  created?: string | null;
  location?: string | null;
  plan?: string | null;
  publicIp?: string | null;
  privateIp?: string | null;
  privateIpNote?: string;
  events?: Array<{
    action?: string | null;
    status?: string | null;
    started?: string | null;
    finished?: string | null;
    error?: string | null;
  }>;
  eventsNote?: string;
  eventsError?: string;
}

type ListedServer = { id: string | number; name?: string | null; label?: string | null };

export interface ProviderViewProvider {
  listServersDetailed(
    labels?: Record<string, string>,
  ): Promise<{ items: unknown[]; complete: boolean; status?: number }>;
  describeServerForDiagnosis(id: string | number): Promise<unknown>;
}

const TIMED_OUT = Symbol('timed out');

/** One value as text: a string, a number, or `?`; never an object. */
const scalar = (v: unknown): string =>
  typeof v === 'string' && v ? v.slice(0, 200) : typeof v === 'number' ? String(v) : '?';

function viewLine(view: ServerView, listedAs: string): string {
  const parts = [
    `${listedAs}: id ${scalar(view.id)}`,
    `status ${scalar(view.status)}`,
    ...(view.detail ? [scalar(view.detail)] : []),
    `plan ${scalar(view.plan)}`,
    `region ${scalar(view.location)}`,
    `created ${scalar(view.created)}`,
    `public ${scalar(view.publicIp)}`,
    `private ${scalar(view.privateIp)}`,
  ];
  if (view.privateIpNote) parts.push(`(private: ${scalar(view.privateIpNote)})`);
  const events = (Array.isArray(view.events) ? view.events : []).slice(0, 5).map((e) => {
    const at = scalar(e?.started);
    const err = e?.error ? ` (${scalar(e.error)})` : '';
    return `${scalar(e?.action)} ${scalar(e?.status)} ${at}${err}`;
  });
  if (events.length > 0) parts.push(`recent actions: ${events.join('; ')}`);
  if (view.eventsNote) parts.push(`(${scalar(view.eventsNote)})`);
  if (view.eventsError) parts.push(`(actions unreadable: ${scalar(view.eventsError)})`);
  return parts.join(', ');
}

const reason = (err: unknown): string =>
  (err instanceof Error ? err.message : String(err)).split('\n')[0].slice(0, 300);

/**
 * The section: a [label, text] pair for the failure bundle. Never throws.
 * `boundMs` covers the listing and every read together; a read still pending
 * at the bound is named as not read.
 */
export async function collectProviderView({
  provider: providerArg,
  providerId,
  projectName,
  boundMs = PROVIDER_VIEW_BOUND_MS,
}: {
  /** Or a function that builds it, so a construction failure is a line here too. */
  provider: ProviderViewProvider | (() => ProviderViewProvider);
  providerId: string;
  projectName: string;
  boundMs?: number;
}): Promise<[string, string]> {
  const label = `provider view: servers of ${projectName}`;
  const finish = (lines: string[]): [string, string] => [
    label,
    redactHostDiagnostics(lines.join('\n')),
  ];
  let timer: NodeJS.Timeout | undefined;
  try {
    assertSweepableProjectName(providerId, projectName);
    const provider = typeof providerArg === 'function' ? providerArg() : providerArg;
    const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), boundMs);
      timer.unref?.();
    });
    const within = <T>(p: Promise<T>): Promise<T | typeof TIMED_OUT> => Promise.race([p, deadline]);

    // Hetzner's API filters on the project label; the others list the whole
    // account and are filtered here by the sweeps' prefix rule.
    const byLabel = providerId === 'hetzner';
    let listing:
      | Awaited<ReturnType<ProviderViewProvider['listServersDetailed']>>
      | typeof TIMED_OUT;
    try {
      listing = await within(
        provider.listServersDetailed(byLabel ? hetznerServerLabels(projectName) : undefined),
      );
    } catch (err) {
      return finish([`(could not list ${providerId} servers: ${reason(err)})`]);
    }
    if (listing === TIMED_OUT) {
      return finish([
        `(could not list ${providerId} servers: no answer within ${Math.round(boundMs / 1000)} s)`,
      ]);
    }
    const servers = (listing.items as ListedServer[]).filter(
      (s) => byLabel || sweepOwnsServer(s, projectName),
    );
    const lines: string[] = [];
    if (!listing.complete) {
      lines.push(
        `(listing incomplete${listing.status ? `, status ${listing.status}` : ''}: servers may be missing below)`,
      );
    }
    if (servers.length === 0) lines.push(`(no ${providerId} servers listed for ${projectName})`);

    const reads = await Promise.all(
      servers.map(async (s): Promise<string> => {
        const listedAs = String(s.label ?? s.name ?? s.id);
        try {
          const view = await within(provider.describeServerForDiagnosis(s.id));
          if (view === TIMED_OUT) {
            return `${listedAs}: id ${scalar(s.id)}, not read within ${Math.round(boundMs / 1000)} s`;
          }
          return viewLine((view ?? {}) as ServerView, listedAs);
        } catch (err) {
          return `${listedAs}: id ${scalar(s.id)}, view could not be read: ${reason(err)}`;
        }
      }),
    );
    return finish([...lines, ...reads]);
  } catch (err) {
    return finish([`(provider view failed: ${reason(err)})`]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
