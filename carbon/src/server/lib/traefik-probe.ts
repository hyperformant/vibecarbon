/**
 * The app's one check that Traefik answers, shared by the admin
 * Infrastructure page (services-status) and the performance page.
 *
 * Where Traefik is, seen from the app:
 * - k8s: Traefik runs in the app's namespace (carbon/k8s/base/traefik) with
 *   `--ping` on its `traefik` entrypoint, published by the
 *   `traefik-dashboard` Service on 8080. `/ping` answers 200.
 * - Docker (compose): the `traefik` service on the shared network, port 80.
 *   Compose runs no ping entrypoint, so any HTTP answer counts: no router
 *   matches the bare service name (404), and in production the web
 *   entrypoint redirects to HTTPS (3xx).
 * - Local dev: the app runs on the host and Traefik is published on
 *   DEV_TRAEFIK_PORT (80 + DEV_PORT_OFFSET by default, the logic of
 *   scripts/docker-up.js).
 *
 * Redirects are never followed: a 3xx IS Traefik's answer. Following it
 * would chase the public HTTPS URL and report a running Traefik as down.
 */

const isKubernetes = !!process.env.KUBERNETES_SERVICE_HOST;
const isDocker =
  !isKubernetes && (process.env.NODE_ENV === 'production' || process.env.DOCKER === 'true');

function devTraefikPort(): number {
  const explicit = process.env.DEV_TRAEFIK_PORT;
  if (explicit) return Number.parseInt(explicit, 10);
  return 80 + Number.parseInt(process.env.DEV_PORT_OFFSET || '0', 10);
}

export const TRAEFIK_HEALTH_URL = isKubernetes
  ? 'http://traefik-dashboard:8080/ping'
  : isDocker
    ? 'http://traefik:80/'
    : `http://localhost:${devTraefikPort()}/`;

export type TraefikProbe =
  | { ok: true; latencyMs: number }
  | { ok: false; latencyMs: number; error: string };

/** Whether an HTTP status is Traefik answering (see the module comment). */
export function isTraefikAnswer(status: number): boolean {
  return status === 404 || (status >= 200 && status < 400);
}

/** GET Traefik once, giving up after `timeoutMs`. Never throws. */
export async function probeTraefik(timeoutMs: number): Promise<TraefikProbe> {
  const start = Date.now();
  try {
    const res = await fetch(TRAEFIK_HEALTH_URL, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const latencyMs = Date.now() - start;
    if (isTraefikAnswer(res.status)) return { ok: true, latencyMs };
    return { ok: false, latencyMs, error: `HTTP ${res.status}` };
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    const timedOut = name === 'TimeoutError' || name === 'AbortError';
    return {
      ok: false,
      latencyMs: Date.now() - start,
      error: timedOut ? 'Timeout' : 'Not running',
    };
  }
}
