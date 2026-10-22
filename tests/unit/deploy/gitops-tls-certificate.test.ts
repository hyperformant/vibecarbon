/**
 * The vibecarbon-tls Certificate is deploy-owned on BOTH deploy paths. Flux's
 * vibecarbon-base drops it (k8s/flux/clusters/*), so:
 *
 * - the CLI deploy renders it into the base copy (renderK8sBase);
 * - the GitOps deploy workflow renders it with the same script
 *   (scripts/render-tls-certificate.mjs) from the GitHub Environment vars
 *   `vibecarbon configure cicd` seeds, and applies it after cert-manager's
 *   CRDs are installed.
 *
 * Parallel to the backup CronJob census (backup-config-reaches-runtime-census).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  renderTlsCertificateManifest,
  tlsCertificateFromVars,
  tlsCertificateVars,
} from '../../../carbon/scripts/render-tls-certificate.mjs';
import { gitSafeEnv } from '../../../src/lib/command.js';
import {
  PROMOTE_ISSUER_ANNOTATION,
  STANDBY_SELFSIGNED_ISSUER,
} from '../../../src/lib/deploy/k8s/acme-issuer-policy.js';

vi.mock('../../../src/lib/github-environments.js', () => ({
  seedOrgSecrets: vi.fn(async () => {}),
  seedEnvironmentSecrets: vi.fn(async () => {}),
  uploadKubeconfig: vi.fn(async () => {}),
  triggerDeployWorkflow: vi.fn(async () => {}),
  waitForLatestWorkflowRun: vi.fn(async () => ({ runId: 1 })),
}));

const { seedEnvironmentSecrets } = await import('../../../src/lib/github-environments.js');
const { deployK8sGitOps, gitopsTargets, refreshGitopsTlsVars } = await import(
  '../../../src/lib/deploy/k8s/gitops-deploy.js'
);

// biome-ignore lint/suspicious/noExplicitAny: parsed YAML
type Doc = any;

const RENDERER = 'carbon/scripts/render-tls-certificate.mjs';
const NO_DOMAIN = 'the TLS Certificate needs a domain, and this environment has none';
const WF = readFileSync('carbon/.github/workflows/deploy.yml', 'utf8');
const TLS = {
  dnsNames: ['app.example.test', '*.app.example.test'],
  issuerName: 'letsencrypt-prod-hetzner',
  effectiveIssuer: 'letsencrypt-prod-hetzner',
};

const work = mkdtempSync(join(tmpdir(), 'vc-gitops-tls-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe('the shared Certificate renderer', () => {
  it('uses the same annotation and standby issuer names as the CLI', () => {
    const doc = load(
      renderTlsCertificateManifest({ ...TLS, effectiveIssuer: STANDBY_SELFSIGNED_ISSUER }),
    ) as Doc;
    expect(doc.metadata.annotations[PROMOTE_ISSUER_ANNOTATION]).toBe(TLS.issuerName);
    expect(doc.spec.issuerRef.name).toBe(STANDBY_SELFSIGNED_ISSUER);
  });

  it('vars round-trip to the same settings', () => {
    const vars = tlsCertificateVars(TLS);
    expect(vars).toEqual({
      TLS_CERT_ISSUER: 'letsencrypt-prod-hetzner',
      TLS_CERT_EFFECTIVE_ISSUER: 'letsencrypt-prod-hetzner',
      TLS_CERT_DNS_NAMES: 'app.example.test,*.app.example.test',
    });
    expect(tlsCertificateFromVars(vars)).toEqual(TLS);
  });

  it.each([
    [{ issuerName: 'letsencrypt-prod-hetzner"\nx: y' }, /issuer/],
    [{ issuerName: 'some-issuer' }, /issuer/],
    [{ effectiveIssuer: 'letsencrypt-prod-hetzner; rm' }, /issuer/],
    [{ dnsNames: ['app.example.test\n- evil'] }, /DNS name/],
    [{ dnsNames: ['app example.test'] }, /DNS name/],
    [{ dnsNames: [] }, /dnsNames/],
  ])('refuses an unvalidated value (%j)', (over, pattern) => {
    expect(() => renderTlsCertificateManifest({ ...TLS, ...over })).toThrow(pattern);
    expect(() => tlsCertificateVars({ ...TLS, ...over })).toThrow(pattern);
  });

  it('as a script, renders from the vars, and refuses without them naming the fix', () => {
    const dir = join(work, 'script');
    mkdirSync(dir, { recursive: true });
    cpSync(RENDERER, join(dir, 'render.mjs'));
    const run = (env: Record<string, string>) =>
      spawnSync('node', [join(dir, 'render.mjs')], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '', ...env },
      });
    const ok = run(tlsCertificateVars(TLS));
    expect(ok.status).toBe(0);
    expect(ok.stdout).toBe(renderTlsCertificateManifest(TLS));
    const none = run({});
    expect(none.status).toBe(1);
    expect(none.stdout).toBe('');
    expect(none.stderr).toMatch(/`vibecarbon configure cicd <env>`/);
    const bad = run({ ...tlsCertificateVars(TLS), TLS_CERT_DNS_NAMES: 'a b' });
    expect(bad.status).toBe(1);
    expect(bad.stdout).toBe('');
  });
});

describe('deploy.yml applies Certificate/vibecarbon-tls (deploy-owned, not Flux)', () => {
  const bootstrap = WF.slice(
    WF.indexOf('\n  bootstrap-flux:'),
    WF.indexOf('\n  trigger-reconcile:'),
  );
  const step = bootstrap.slice(bootstrap.indexOf('- name: Render and apply the TLS Certificate'));

  it('renders from the environment vars to a file, then applies it server-side', () => {
    expect(bootstrap.indexOf('- name: Render and apply the TLS Certificate')).toBeGreaterThan(
      bootstrap.indexOf('- name: Install cert-manager + Traefik CRDs'),
    );
    for (const v of ['TLS_CERT_ISSUER', 'TLS_CERT_EFFECTIVE_ISSUER', 'TLS_CERT_DNS_NAMES']) {
      expect(step).toContain(`${v}: \${{ vars.${v} }}`);
    }
    expect(step).toContain(
      'node scripts/render-tls-certificate.mjs > "$RUNNER_TEMP/certificate.yaml"',
    );
    expect(step).toMatch(
      /kubectl apply --server-side --field-manager=github-actions-deploy[^\n]*\\\n[^\n]*-f "\$RUNNER_TEMP\/certificate\.yaml"/,
    );
    // Never forced over a Certificate the CLI deploy or a failover set.
    expect(step.slice(0, step.indexOf('\n      - name:', 10))).not.toContain('--force-conflicts');
  });

  it('a conflicting apply fails with one error line naming the repair, and no secret', () => {
    const body = step.slice(0, step.indexOf('\n      - name:', 10));
    expect(body).toContain(
      '-f "$RUNNER_TEMP/certificate.yaml" || { echo "::error::the TLS Certificate apply conflicted. Run vibecarbon deploy <env> (or vibecarbon configure cicd <env> if the roles changed), then re-run this workflow"; exit 1; }',
    );
    expect(body).not.toMatch(/secrets\./);
  });

  it('the workflow carries no apostrophe in the step (embedded-shell rule)', () => {
    expect(step.slice(0, step.indexOf('\n      - name:', 10))).not.toContain("'");
  });
});

describe('deployK8sGitOps seeds the Certificate vars', () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, env: gitSafeEnv(), encoding: 'utf-8' }).trim();

  async function seedFor(name: string, extra: Record<string, unknown>) {
    const origin = join(work, `${name}-origin.git`);
    const project = join(work, `${name}-project`);
    mkdirSync(origin, { recursive: true });
    git(origin, 'init', '--bare', '-b', 'main');
    mkdirSync(project, { recursive: true });
    git(project, 'init', '-b', 'main');
    git(project, 'config', 'user.email', 't@example.test');
    git(project, 'config', 'user.name', 'T');
    git(project, 'remote', 'add', 'origin', origin);
    cpSync('carbon/k8s/base/config', join(project, 'k8s/base/config'), { recursive: true });
    writeFileSync(
      join(project, '.env.local'),
      'ACME_CA_SERVER=https://acme-staging-v02.api.letsencrypt.org/directory\n',
    );
    vi.mocked(seedEnvironmentSecrets).mockClear();
    await deployK8sGitOps({
      projectDir: project,
      environment: name,
      domain: 'app.example.test',
      projectName: 'proj',
      kubeconfigPath: join(project, 'kubeconfig'),
      networkId: '',
      dnsProvider: 'hetzner',
      providerCreds: {},
      appStorage: { accessKey: 'a', secretKey: 'b' },
      githubOwner: 'acme',
      ...extra,
    });
    const [, , vars] = vi.mocked(seedEnvironmentSecrets).mock.calls[0];
    return vars as Record<string, string>;
  }

  it('the primary role seeds the issuer it issues from, and the DNS-01 names', async () => {
    const vars = await seedFor('prod', {});
    expect(vars).toMatchObject({
      TLS_CERT_ISSUER: 'letsencrypt-staging-hetzner',
      TLS_CERT_EFFECTIVE_ISSUER: 'letsencrypt-staging-hetzner',
      TLS_CERT_DNS_NAMES: 'app.example.test,*.app.example.test',
    });
  });

  it('refuses to seed without a domain instead of rendering a localhost Certificate', async () => {
    await expect(seedFor('nodomain', { domain: null })).rejects.toThrow(NO_DOMAIN);
    expect(seedEnvironmentSecrets).not.toHaveBeenCalled();
  });

  it('the standby role issues from the self-signed issuer; the real one rides the annotation', async () => {
    const vars = await seedFor('prod-standby', { role: 'standby' });
    expect(vars).toMatchObject({
      TLS_CERT_ISSUER: 'letsencrypt-staging-hetzner',
      TLS_CERT_EFFECTIVE_ISSUER: STANDBY_SELFSIGNED_ISSUER,
    });
  });
});

describe('configure cicd seeds each HA cluster by its current role', () => {
  it('passes each target role from gitopsTargets', () => {
    const src = readFileSync('src/configure.js', 'utf8');
    const call = src.slice(src.indexOf('await deployK8sGitOps({'));
    expect(call.slice(0, call.indexOf('});'))).toMatch(/\brole: target\.role\b/);
    expect(src).toMatch(/const targets = gitopsTargets\(envName, envConfig\)/);
  });

  it('gitopsTargets reads the roles from ha.primary.stack, so a failed-over pair seeds the promoted side as primary', () => {
    expect(gitopsTargets('prod', { deployMode: 'k8s-ha' })).toEqual([
      { suffix: 'primary', envName: 'prod-primary', role: 'primary' },
      { suffix: 'standby', envName: 'prod-standby', role: 'standby' },
    ]);
    expect(
      gitopsTargets('prod', { deployMode: 'k8s-ha', ha: { primary: { stack: 'prod-standby' } } }),
    ).toEqual([
      { suffix: 'primary', envName: 'prod-primary', role: 'standby' },
      { suffix: 'standby', envName: 'prod-standby', role: 'primary' },
    ]);
    expect(gitopsTargets('dev', { deployMode: 'k8s' })).toEqual([
      { suffix: null, envName: 'dev', role: 'primary' },
    ]);
  });
});

describe('refreshGitopsTlsVars (after a k8s-ha failover)', () => {
  const project = join(work, 'refresh-project');
  mkdirSync(project, { recursive: true });
  writeFileSync(
    join(project, '.env.local'),
    'ACME_CA_SERVER=https://acme-staging-v02.api.letsencrypt.org/directory\n',
  );
  // After the failover: the old standby stack is primary.
  const swapped = {
    environments: {
      prod: {
        deployMode: 'k8s-ha',
        domain: 'app.example.test',
        dnsProvider: 'hetzner',
        ha: { primary: { stack: 'prod-standby' }, standby: { stack: 'prod-primary' } },
      },
    },
  };

  it('re-seeds each GitOps-managed environment for its new role', async () => {
    const seed = vi.fn(async () => {});
    const listVars = vi.fn(async () => ['SITE_URL', 'TLS_CERT_ISSUER']);
    const r = await refreshGitopsTlsVars({
      envName: 'prod',
      projectDir: project,
      deps: { loadConfig: () => swapped, listVars, seed },
    });
    expect(r).toEqual({ ok: true, refreshed: ['prod-primary', 'prod-standby'] });
    const byEnv = Object.fromEntries(seed.mock.calls.map((c) => [c[0], c]));
    expect(byEnv['prod-primary'][1]).toEqual({});
    expect(byEnv['prod-primary'][2]).toEqual({
      TLS_CERT_ISSUER: 'letsencrypt-staging-hetzner',
      TLS_CERT_EFFECTIVE_ISSUER: STANDBY_SELFSIGNED_ISSUER,
      TLS_CERT_DNS_NAMES: 'app.example.test,*.app.example.test',
    });
    expect(byEnv['prod-standby'][2]).toMatchObject({
      TLS_CERT_EFFECTIVE_ISSUER: 'letsencrypt-staging-hetzner',
    });
    // Every gh call is bounded.
    expect(byEnv['prod-standby'][3]).toEqual({ timeout: expect.any(Number) });
    expect(listVars).toHaveBeenCalledWith('prod-primary', { timeout: expect.any(Number) });
  });

  it('reports a missing domain as the reason and seeds nothing', async () => {
    const seed = vi.fn(async () => {});
    const noDomain = structuredClone(swapped) as { environments: { prod: { domain?: string } } };
    delete noDomain.environments.prod.domain;
    const r = await refreshGitopsTlsVars({
      envName: 'prod',
      projectDir: project,
      deps: { loadConfig: () => noDomain, listVars: async () => ['TLS_CERT_ISSUER'], seed },
    });
    expect(r).toEqual({ ok: false, reason: NO_DOMAIN });
    expect(seed).not.toHaveBeenCalled();
  });

  it('leaves an environment without the TLS vars alone (not GitOps-managed)', async () => {
    const seed = vi.fn(async () => {});
    const r = await refreshGitopsTlsVars({
      envName: 'prod',
      projectDir: project,
      deps: {
        loadConfig: () => swapped,
        listVars: async (env: string) => (env === 'prod-primary' ? [] : ['TLS_CERT_ISSUER']),
        seed,
      },
    });
    expect(r).toEqual({ ok: true, refreshed: ['prod-standby'] });
    expect(seed).toHaveBeenCalledTimes(1);
  });

  it('holds an overall deadline: each call is bounded by what is left, and a spent deadline stops', async () => {
    let clock = 0;
    const timeouts: number[] = [];
    const r = await refreshGitopsTlsVars({
      envName: 'prod',
      projectDir: project,
      deps: {
        loadConfig: () => swapped,
        now: () => clock,
        listVars: async (_env: string, { timeout }: { timeout: number }) => {
          timeouts.push(timeout);
          clock += 50_000;
          return ['TLS_CERT_ISSUER'];
        },
        seed: async (_e: string, _s: unknown, _v: unknown, { timeout }: { timeout: number }) => {
          timeouts.push(timeout);
          clock += 5_000;
        },
      },
    });
    // 60s overall: 20s, then the 10s left, then the 5s left, then nothing.
    expect(timeouts).toEqual([20_000, 10_000, 5_000]);
    expect(r).toEqual({ ok: false, reason: 'GitHub did not answer in time' });
  });

  it('never throws: a gh failure or timeout is a reason', async () => {
    const failing = await refreshGitopsTlsVars({
      envName: 'prod',
      projectDir: project,
      deps: {
        loadConfig: () => swapped,
        listVars: async () => {
          throw new Error('Command failed: gh variable list\nHTTP 502');
        },
      },
    });
    expect(failing).toEqual({ ok: false, reason: 'Command failed: gh variable list' });
    const slow = await refreshGitopsTlsVars({
      envName: 'prod',
      projectDir: project,
      deps: {
        loadConfig: () => swapped,
        listVars: async () => ['TLS_CERT_ISSUER'],
        seed: async () => {
          throw Object.assign(new Error('Command failed: gh variable set'), { timedOut: true });
        },
      },
    });
    expect(slow).toEqual({ ok: false, reason: 'GitHub did not answer in time' });
  });
});
