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
const { deployK8sGitOps } = await import('../../../src/lib/deploy/k8s/gitops-deploy.js');

// biome-ignore lint/suspicious/noExplicitAny: parsed YAML
type Doc = any;

const RENDERER = 'carbon/scripts/render-tls-certificate.mjs';
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

  it('the standby role issues from the self-signed issuer; the real one rides the annotation', async () => {
    const vars = await seedFor('prod-standby', { role: 'standby' });
    expect(vars).toMatchObject({
      TLS_CERT_ISSUER: 'letsencrypt-staging-hetzner',
      TLS_CERT_EFFECTIVE_ISSUER: STANDBY_SELFSIGNED_ISSUER,
    });
  });
});

describe('configure cicd seeds each HA cluster by its current role', () => {
  it('passes role from ha.primary.stack, so a failed-over pair seeds the promoted side as primary', () => {
    const src = readFileSync('src/configure.js', 'utf8');
    const call = src.slice(src.indexOf('await deployK8sGitOps({'));
    expect(call.slice(0, call.indexOf('});'))).toMatch(/\brole: target\.role\b/);
    expect(src).toMatch(/envConfig\.ha\?\.primary\?\.stack \?\? `\$\{envName\}-primary`/);
  });
});
