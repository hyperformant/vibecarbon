/**
 * Every node this project provisions must configure sshd for the connection
 * concurrency the tooling legitimately generates.
 *
 * 2026-08-23, linode: THREE independent subsystems died in one leg with
 * `kex_exchange_identification: read: Connection reset by peer` — BuildKit's
 * dial-stdio (run 32640636398), the admin-user SSH tunnel, and the supavisor
 * check's own probe (run 32642715052). That error is sshd REFUSING connections
 * at the door: Ubuntu's default `MaxStartups 10:30:100` starts probabilistically
 * dropping unauthenticated connects at 10 concurrent, and a deploy fans
 * builds, pulls, tunnels, and probes across nodes at exactly that scale. Slow
 * provider links widen each connection's unauthenticated window, which is why
 * linode/vultr lost a race hetzner/DO mostly won.
 *
 * These are OUR nodes. The fix is to provision sshd for the workload, not to
 * throttle the tooling around a default nobody chose. Every cloud-init surface
 * must install the sshd concurrency drop-in; this census walks them all so a
 * new provider's init script cannot silently ship without it.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const CLOUD_INIT_DIR = join(process.cwd(), 'carbon', 'cloud-init');

function allInitFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...allInitFiles(p));
    else if (/\.(yaml|yml|sh)$/.test(name)) out.push(p);
  }
  return out;
}

describe('sshd concurrency provisioning census', () => {
  const files = allInitFiles(CLOUD_INIT_DIR);

  it('walks a non-trivial surface (never vacuously green)', () => {
    expect(files.length).toBeGreaterThanOrEqual(5);
  });

  // _private-net-guard.sh is a sourced fragment, not a node init entrypoint.
  const entrypoints = files.filter((f) => !f.includes('_private-net-guard'));

  it.each(entrypoints.map((f) => [f.slice(CLOUD_INIT_DIR.length + 1)]))(
    '%s raises sshd MaxStartups for the deploy’s connection fan-out',
    (rel) => {
      const text = readFileSync(join(CLOUD_INIT_DIR, rel), 'utf-8');
      expect(text, `${rel}: no MaxStartups provisioning`).toMatch(/MaxStartups\s+\d+:\d+:\d+/);
      // The drop-in is worthless unless sshd re-reads it.
      expect(text, `${rel}: sshd never reloaded`).toMatch(
        /reload.+ssh|restart.+ssh|systemctl (reload|restart) (ssh|sshd)/,
      );
    },
  );
});
