/**
 * Image pulls must fail LOUDLY with the pull's own stderr.
 *
 * 2026-08-23, matrix 32614839037 + rerun 32620565774 (linode compose-ha
 * scale): `pullComposeImages` ran with FOUR silencing layers — three `||`
 * fallbacks ending `|| true` inside the remote command, plus
 * `ignoreError: true` on the SSH wrapper. When the pull died on the new
 * node, nothing recorded why; the failure surfaced two steps later as a
 * wall of `Error response from daemon: No such image: grafana/loki:3.3.0`
 * from `docker compose up` — downstream noise with the true cause
 * (rate limit? DNS? timeout?) permanently lost.
 *
 * That is the exact stacked-mitigation pattern this repo's mitigation
 * policy bans: an absorber that fires silently hides the regression it
 * should be surfacing.
 *
 * Contract pinned here:
 *   - a failing pull REJECTS (no ignoreError), carrying the remote stderr
 *   - the remote command has NO `|| true` / fallback-chain silencers
 *   - `--ignore-buildable` stays (db/app are built, never pulled)
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/lib/command.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, runCommandAsync: vi.fn() };
});

const { runCommandAsync } = await import('../../../src/lib/command.js');
const { pullComposeImages, stackPullCommand } = await import(
  '../../../src/lib/deploy/compose/index.js'
);
const { mirroredPackageNames } = await import('../../../src/lib/images.js');

/** The shape runCommandAsync rejects with: the remote command's `2>&1` puts docker's words in stdout. */
function pullFailure(stdout: string) {
  const err = new Error(
    'Command failed: ssh -o BatchMode=yes root@1.1.1.1 cd /opt/p && docker compose pull',
  );
  Object.assign(err, { stdout, stderr: '', status: 18 });
  return err;
}

describe('pullComposeImages failure contract', () => {
  it('source: the remote pull command carries no silencing layers', async () => {
    // Structural pin on the source, not the mock: `|| true` and chained
    // `|| docker compose` fallbacks are the four-deep silencer this test
    // exists to keep dead.
    const src = readFileSync('src/lib/deploy/compose/index.js', 'utf-8');
    // The command builder and its caller, read as one region.
    const fnStart = src.indexOf('export function stackPullCommand');
    const callStart = src.indexOf('export async function pullComposeImages');
    expect(fnStart).toBeGreaterThan(-1);
    expect(callStart).toBeGreaterThan(fnStart);
    const fnBody = src.slice(fnStart, src.indexOf('\n}', callStart));
    expect(fnBody, 'pull must not end in || true').not.toMatch(/\|\|\s*true/);
    expect(fnBody, 'pull must not chain fallback pulls').not.toMatch(/pull[^\n]*\|\|[^\n]*pull/);
    expect(fnBody, 'pull must not use ignoreError').not.toMatch(/ignoreError:\s*true/);
    expect(fnBody, 'buildable images are built, never pulled').toMatch(/--ignore-buildable/);
    // prod.yml resets app's build:, so --ignore-buildable does NOT cover it;
    // its local-only tag aborts a plain `compose pull` and interrupts every
    // sibling image (linode 32640636398, fifteen `Interrupted` lines). The
    // pull must enumerate services minus app.
  });
});

describe('the stack pull never asks a registry for the app image', () => {
  // prod.yml resets the app's `build:`, so --ignore-buildable does not cover
  // it, and compose pull ignores `pull_policy: never`. Its local-only tag
  // aborts a plain `compose pull` and interrupts every sibling image (linode
  // 32640636398). app-migrate (#234) runs the same image, and excluding only
  // the service named `app` broke every compose-ha deploy (DO e2e,
  // 2026-10-31). The pull must skip every service whose image is the app's.
  function runPull(services: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), 'vc-stack-pull-'));
    const pulled = join(dir, 'pulled');
    const map = Object.entries(services)
      .map(([svc, img]) => `${svc}) echo '${img}' ;;`)
      .join('\n      ');
    writeFileSync(
      join(dir, 'docker'),
      `#!/bin/sh
shift # compose
while [ "$1" = "-f" ]; do shift 2; done
if [ "$1 $2" = "config --services" ]; then
  printf '%s\\n' ${Object.keys(services).join(' ')}
elif [ "$1 $2" = "config --images" ]; then
  case "$3" in
      ${map}
  esac
elif [ "$1" = "pull" ]; then
  shift
  for a; do case "$a" in --*) ;; missing) ;; *) echo "$a" >> "${pulled}" ;; esac; done
fi
`,
    );
    chmodSync(join(dir, 'docker'), 0o755);
    const cmd = stackPullCommand(dir, '-f a.yml -f b.yml');
    const r = spawnSync('sh', ['-c', cmd], {
      encoding: 'utf-8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    });
    const out = existsSync(pulled) ? readFileSync(pulled, 'utf-8').trim().split('\n').sort() : [];
    rmSync(dir, { recursive: true, force: true });
    return { status: r.status, pulled: out };
  }

  it('skips app and every other service on the app image (app-migrate)', () => {
    const r = runPull({
      app: 'demo-app:local',
      'app-migrate': 'demo-app:local',
      db: 'ghcr.io/hyperformant/postgres:17',
      traefik: 'ghcr.io/hyperformant/traefik:v3',
    });
    expect(r.status).toBe(0);
    expect(r.pulled).toEqual(['db', 'traefik']);
  });

  it('pulls every service when none shares the app image', () => {
    const r = runPull({ app: 'demo-app:local', db: 'pg:17', redis: 'redis:7' });
    expect(r.pulled).toEqual(['db', 'redis']);
  });
});

describe('pullComposeImages names what failed to pull', () => {
  it("rethrows with the pull's own output tail and a next step, not the bare ssh line", async () => {
    const out = [
      ...Array.from({ length: 30 }, (_, i) => `noise line ${i}`),
      ' traefik Pulling',
      'Error response from daemon: toomanyrequests: You have reached your pull rate limit.',
    ].join('\n');
    vi.mocked(runCommandAsync).mockRejectedValueOnce(pullFailure(out));
    const err = await pullComposeImages('1.1.1.1', '/k', 'p').catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/^stack image pull failed on 1\.1\.1\.1/);
    expect(err.message).toContain('toomanyrequests: You have reached your pull rate limit.');
    expect(err.message).toContain(' traefik Pulling');
    // The tail, not the whole log.
    expect(err.message).not.toContain('noise line 0\n');
    expect(err.message).toContain('noise line 29');
    expect(err.message).toMatch(/set Docker Hub credentials \(dockerhub-login\) or retry/);
    // A private ghcr mirror package fails the same pull: the message names the
    // packages that must be public.
    expect(err.message).toMatch(/ghcr\.io\/hyperformant mirror, its package may still be private/);
    for (const pkg of mirroredPackageNames()) expect(err.message).toContain(pkg);
    expect(err.cause).toBeInstanceOf(Error);
  });

  it('masks anything token-shaped in the quoted output', async () => {
    vi.mocked(runCommandAsync).mockRejectedValueOnce(
      pullFailure(
        'Get https://user:hunter2@registry.example/v2/: denied\nAuthorization: Bearer abc.def\nDOCKER_TOKEN=dckr_pat_xyz',
      ),
    );
    const err = await pullComposeImages('1.1.1.1', '/k', 'p').catch((e) => e);
    expect(err.message).not.toContain('hunter2');
    expect(err.message).not.toContain('abc.def');
    expect(err.message).not.toContain('dckr_pat_xyz');
    expect(err.message).toContain('<redacted>');
  });

  it('falls back to the original message when the pull printed nothing', async () => {
    vi.mocked(runCommandAsync).mockRejectedValueOnce(pullFailure(''));
    const err = await pullComposeImages('1.1.1.1', '/k', 'p').catch((e) => e);
    expect(err.message).toContain('Command failed: ssh');
    expect(err.message).toMatch(/or retry/);
  });
});
