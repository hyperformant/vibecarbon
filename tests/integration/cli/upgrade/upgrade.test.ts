/**
 * vibecarbon upgrade — file-mutation tests against a real project.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashContent } from '../../../../src/lib/checksum.js';
import { staleObservabilityTlsProblem } from '../../../../src/lib/deploy/k8s/one-certificate.js';
import { gitScrubbedEnv } from '../../../_shared/git-env.js';
import { createTempDir } from '../../../_shared/temp-dir.js';
import {
  assertExitWith,
  assertSuccess,
  destroyRealProject,
  type ExecStubs,
  installExecStubs,
  realProject,
  runCli,
} from '../../_harness/index.js';

describe('vibecarbon upgrade', () => {
  let project: string;
  beforeEach(() => {
    project = realProject();
  });
  afterEach(() => {
    destroyRealProject(project);
  });

  it('prints help', () => {
    const r = runCli('upgrade', ['-h'], { cwd: project });
    assertSuccess(r);
    assertExitWith(r, 0, 'Vibecarbon Upgrade');
  });

  it('-dry leaves package.json unchanged', () => {
    const before = readFileSync(join(project, 'package.json'), 'utf-8');
    const r = runCli('upgrade', ['-dry', '-y'], { cwd: project, timeoutMs: 60_000 });
    if (r.exitCode === null) throw new Error(`upgrade timed out:\n${r.stderr}`);
    const after = readFileSync(join(project, 'package.json'), 'utf-8');
    expect(after).toBe(before);
  });

  it('-force accepted by parser', () => {
    const r = runCli('upgrade', ['-force', '-y'], { cwd: project, timeoutMs: 60_000 });
    if (/unknown flag: -force/.test(r.stderr)) {
      throw new Error(`-force rejected:\n${r.stderr}`);
    }
  });

  it('on a fresh project, upgrade is idempotent (no diff to apply)', () => {
    const r = runCli('upgrade', ['-y'], { cwd: project, timeoutMs: 60_000 });
    // A freshly-created project should report nothing to upgrade.
    if (r.exitCode === null) throw new Error(`upgrade timed out`);
  });

  it('customer `git add -A` stays clean: upgrade leaves no untracked, un-ignored files', () => {
    // Generated-artifact hygiene (escape class, 2026-07-30): upgrade wrote
    // `.upgrade-backup` / `.upgrade-new` sidecars no .gitignore pattern
    // covered, so a customer's `git add -A` would commit them — and the
    // secret scanner only gates TRACKED content, so a backup carrying a
    // rendered secret would sail through. The class invariant, checked
    // BEHAVIORALLY rather than per-suffix: after a mutating CLI command,
    // every file left in the project is either tracked-by-intent or
    // gitignored. A future sidecar with a brand-new suffix fails here
    // without anyone having to remember to extend an inventory.
    // Git exports GIT_DIR (and friends) to every hook it runs, and the
    // pre-push hook runs this very suite. Under an inherited GIT_DIR, `cwd`
    // does NOT pick the repo — git operates on the REAL repo with the
    // fixture dir as its work tree, so the `git add -A` below would stage
    // the fixture's tree over the actual branch (this happened on
    // 2026-07-30: two `e2e@test.invalid` fixture commits landed on a
    // feature branch during `git push`). gitScrubbedEnv strips the
    // repo-targeting vars; isolateConfig pins global/system config to
    // /dev/null so nothing here can read or write an operator's identity
    // (the -c flags below supply the only identity git gets).
    const gitEnv = gitScrubbedEnv({ isolateConfig: true });
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@test.invalid', ...args], {
        cwd: project,
        encoding: 'utf-8',
        env: gitEnv,
      });

    // Simulate the customer: everything committed before the upgrade.
    git('add', '-A');
    if (git('status', '--porcelain').trim() !== '') {
      git('commit', '-m', 'baseline', '--no-verify', '--quiet');
    }

    // Locally modify a template-managed file so -force actually writes a
    // .upgrade-backup sidecar (fresh projects are byte-identical to the
    // template — without this the invariant below would pass vacuously).
    const target = join(project, 'docker-compose.yml');
    writeFileSync(target, `${readFileSync(target, 'utf-8')}\n# local drift\n`);
    git('add', '-A');
    git('commit', '-m', 'local drift', '--no-verify', '--quiet');

    const r = runCli('upgrade', ['-force', '-y'], { cwd: project, timeoutMs: 120_000 });
    if (r.exitCode === null) throw new Error(`upgrade timed out:\n${r.stderr}`);
    assertSuccess(r);

    // Positive control — the sidecar exists, so the assertion below is
    // exercised against a real artifact, not an empty run.
    expect(
      existsSync(`${target}.upgrade-backup`),
      'expected upgrade -force to back up the locally-modified docker-compose.yml — if the ' +
        'sidecar naming changed, update this test AND carbon/_gitignore together',
    ).toBe(true);

    // The invariant: every untracked-and-un-ignored file upgrade leaves
    // behind is a TEMPLATE file (upgrade legitimately materializes files the
    // template gained since the project was created — those are meant to be
    // committed). Anything else is an upgrade WORK ARTIFACT and must be
    // gitignored — a sidecar with a brand-new suffix has no carbon/
    // counterpart, so it fails here without a suffix inventory to maintain.
    const untracked = git('ls-files', '--others', '--exclude-standard')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const workArtifacts = untracked.filter(
      (rel) => !existsSync(join(process.cwd(), 'carbon', rel)),
    );
    expect(
      workArtifacts,
      'upgrade left non-template files a customer `git add -A` would commit — and the secret ' +
        'scanner only gates tracked content. Either gitignore the artifact (carbon/_gitignore + ' +
        'REQUIRED_IGNORES in tests/unit/security/gitignore-invariants.test.ts) or stop writing ' +
        'it into the project.',
    ).toEqual([]);
  });

  it('re-pins a stale packageManager to the host pnpm — and says so', () => {
    // The pin's SOURCE moved when the template went npm-based: carbon/ no
    // longer carries a `packageManager` field to re-take, so the host's
    // installed pnpm is what upgrade pins to — and it is also the pnpm that
    // regenerates the lockfile at the end of the same run, so pin, lockfile,
    // and pnpm config still travel together.
    //
    // What did NOT move is PR #214's rule: never silently. The customer must
    // see the old and new values, and must be able to get the old one back.
    // (The fixture is created with -skip-lockfile, so this stale field is
    // also what makes detectPackageManager report pnpm here.)
    const pkgPath = join(project, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    pkg.packageManager = 'pnpm@9.9.9';
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

    const r = runCli('upgrade', ['-force', '-y'], { cwd: project, timeoutMs: 120_000 });
    if (r.exitCode === null) throw new Error(`upgrade timed out:\n${r.stderr}`);
    assertSuccess(r);

    const after = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    expect(after.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+/);
    expect(after.packageManager).not.toBe('pnpm@9.9.9');
    // The announcement names the old value (clack may wrap the line, so
    // assert the tokens, not the whole sentence).
    const out = `${r.stdout}${r.stderr}`;
    expect(out).toContain('pnpm@9.9.9');
    expect(out).toContain('host pnpm pin');
    // Recoverability claim holds: the sidecar carries the old content.
    expect(readFileSync(`${pkgPath}.upgrade-backup`, 'utf-8')).toContain('pnpm@9.9.9');
  });

  it('keeps biome.json rooted after -force — carbon/biome.json ships "root": false for its own nested-monorepo reasons, but a scaffolded project has no parent config and Biome 2.x silently no-ops without one', () => {
    // create.js's makeBiomeConfigRoot() flips this at generation time
    // (fixture already has it true); upgrade re-pulls the raw template
    // content, which would silently undo the flip without its own fixup.
    const biomePath = join(project, 'biome.json');
    expect(JSON.parse(readFileSync(biomePath, 'utf-8')).root).toBe(true);

    const r = runCli('upgrade', ['-force', '-y'], { cwd: project, timeoutMs: 120_000 });
    if (r.exitCode === null) throw new Error(`upgrade timed out:\n${r.stderr}`);
    assertSuccess(r);

    expect(JSON.parse(readFileSync(biomePath, 'utf-8')).root).toBe(true);
  });

  it('leaves a customized file alone when the template has not changed it since the last upgrade — there is nothing to offer, so it must not be queued for review', () => {
    // Loop seen 2026-09-16 on vibecarbon-web: AGENTS.md and the .claude/agents
    // definitions were hand-reconciled after a 0.43.1 upgrade; 0.44.1 shipped
    // the identical template content, yet every upgrade re-queued them as
    // "modified by you" with Replace as the default and clobbered the
    // customization on enter-through. Restoring the file recorded nothing
    // new, so the next upgrade did it again. A file whose incoming template
    // hash equals the stored checksum has no upgrade to apply.
    const agentsPath = join(project, 'AGENTS.md');
    writeFileSync(agentsPath, `${readFileSync(agentsPath, 'utf-8')}\n## Site-specific notes\n`);

    const r = runCli('upgrade', ['-dry', '-y'], { cwd: project, timeoutMs: 60_000 });
    if (r.exitCode === null) throw new Error(`upgrade timed out:\n${r.stderr}`);
    assertSuccess(r);

    expect(r.stdout + r.stderr).not.toMatch(/AGENTS\.md/);
  });

  it('refuses outside a vibecarbon project', () => {
    const r = runCli('upgrade', ['-y'], { cwd: '/tmp', timeoutMs: 15_000 });
    assertExitWith(r, 1, /Not in a Vibecarbon project/i);
  });

  it('upgrades a legacy project with no PROJECT_DISPLAY_NAME recorded (titleize fallback)', () => {
    // Projects created before PROJECT_DISPLAY_NAME existed have no record of
    // it in .env.local; reconstructVariables must fall back to titleizing the
    // slug instead of crashing or substituting an empty string.
    const envPath = join(project, '.env.local');
    const env = readFileSync(envPath, 'utf-8');
    const stripped = env
      .split('\n')
      .filter((line) => !line.startsWith('PROJECT_DISPLAY_NAME='))
      .join('\n');
    expect(stripped).not.toBe(env);
    writeFileSync(envPath, stripped);

    const r = runCli('upgrade', ['-y'], { cwd: project, timeoutMs: 60_000 });
    if (r.exitCode === null) throw new Error(`upgrade timed out:\n${r.stderr}`);
    assertSuccess(r);
  });

  // The observability add-on as `vibecarbon add` wrote it before one
  // certificate per name: k8s files that issue grafana-tls for the app
  // domain, and a compose router that orders its own certificate. Upgrade
  // walked carbon/ only, so these never moved with the CLI.
  function installStaleObservability(
    dir: string,
    { recordChecksums }: { recordChecksums: boolean },
  ) {
    const SVC = join(process.cwd(), 'services', 'observability');
    const obs = join(dir, 'k8s', 'base', 'observability');
    mkdirSync(obs, { recursive: true });
    const stale: Record<string, string> = {
      'k8s/base/observability/kustomization.yaml': readFileSync(
        join(SVC, 'k8s', 'kustomization.yaml'),
        'utf-8',
      ).replace('  - ingressroute.yaml', '  - grafana-tls-certificate.yaml\n  - ingressroute.yaml'),
      'k8s/base/observability/ingressroute.yaml': readFileSync(
        join(SVC, 'k8s', 'ingressroute.yaml'),
        'utf-8',
      ).replace('  tls: {}', '  tls:\n    secretName: grafana-tls'),
      'k8s/base/observability/grafana-tls-certificate.yaml':
        'apiVersion: cert-manager.io/v1\nkind: Certificate\nmetadata:\n  name: grafana-tls\n',
      'docker-compose.observability.prod.yml': readFileSync(
        join(SVC, 'compose', 'docker-compose.prod.yml'),
        'utf-8',
      ).replace(
        '"traefik.http.routers.grafana.tls=true"',
        '"traefik.http.routers.grafana.tls.certresolver=letsencrypt"',
      ),
    };
    for (const [rel, text] of Object.entries(stale)) writeFileSync(join(dir, rel), text);
    const configPath = join(dir, '.vibecarbon.json');
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    config.services = { ...(config.services ?? {}), observability: { version: '1.0.0' } };
    if (recordChecksums) {
      config.fileChecksums = {
        ...(config.fileChecksums ?? {}),
        ...Object.fromEntries(Object.entries(stale).map(([rel, t]) => [rel, hashContent(t)])),
      };
    }
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    return SVC;
  }

  it("refreshes an installed add-on's k8s and compose files from the bundled add-on", () => {
    const SVC = installStaleObservability(project, { recordChecksums: true });
    expect(staleObservabilityTlsProblem(project)).not.toBeNull();

    const r = runCli('upgrade', ['-y'], { cwd: project, timeoutMs: 120_000 });
    if (r.exitCode === null) throw new Error(`upgrade timed out:\n${r.stderr}`);
    assertSuccess(r);

    for (const [rel, src] of [
      ['k8s/base/observability/kustomization.yaml', 'k8s/kustomization.yaml'],
      ['k8s/base/observability/ingressroute.yaml', 'k8s/ingressroute.yaml'],
      ['docker-compose.observability.prod.yml', 'compose/docker-compose.prod.yml'],
    ]) {
      expect(readFileSync(join(project, rel), 'utf-8'), rel).toBe(
        readFileSync(join(SVC, src), 'utf-8'),
      );
    }
    expect(staleObservabilityTlsProblem(project)).toBeNull();
    // Recorded, so the next upgrade can tell an unmodified add-on file.
    const after = JSON.parse(readFileSync(join(project, '.vibecarbon.json'), 'utf-8'));
    expect(after.fileChecksums['k8s/base/observability/ingressroute.yaml']).toBe(
      hashContent(readFileSync(join(SVC, 'k8s', 'ingressroute.yaml'), 'utf-8')),
    );
  });

  it('an add-on file with no recorded checksum is replaced by -y, with a backup', () => {
    // `vibecarbon add` recorded no checksums before, so every existing
    // project's add-on files have none. One `upgrade -y` must still clear
    // the deploy refusal; the previous content survives as .upgrade-backup.
    const SVC = installStaleObservability(project, { recordChecksums: false });
    const ingress = join(project, 'k8s', 'base', 'observability', 'ingressroute.yaml');
    const before = readFileSync(ingress, 'utf-8');

    const r = runCli('upgrade', ['-y'], { cwd: project, timeoutMs: 120_000 });
    if (r.exitCode === null) throw new Error(`upgrade timed out:\n${r.stderr}`);
    assertSuccess(r);

    expect(readFileSync(ingress, 'utf-8')).toBe(
      readFileSync(join(SVC, 'k8s', 'ingressroute.yaml'), 'utf-8'),
    );
    expect(readFileSync(`${ingress}.upgrade-backup`, 'utf-8')).toBe(before);
    expect(existsSync(`${ingress}.upgrade-new`)).toBe(false);
    expect(staleObservabilityTlsProblem(project)).toBeNull();
  });

  it('two consecutive -y runs never lose a customised file', () => {
    // A customised add-on file whose template moved: the first -y leaves it
    // and writes .upgrade-new. The checksum it records must not be the
    // customised content, or the second -y reads the file as unmodified and
    // replaces it with no backup.
    const SVC = installStaleObservability(project, { recordChecksums: true });
    const ingress = join(project, 'k8s', 'base', 'observability', 'ingressroute.yaml');
    const custom = `${readFileSync(ingress, 'utf-8')}# site-specific\n`;
    writeFileSync(ingress, custom);

    for (const run of [1, 2]) {
      const r = runCli('upgrade', ['-y'], { cwd: project, timeoutMs: 120_000 });
      if (r.exitCode === null) throw new Error(`upgrade ${run} timed out:\n${r.stderr}`);
      assertSuccess(r);
      const now = readFileSync(ingress, 'utf-8');
      const kept = now === custom;
      const backedUp =
        existsSync(`${ingress}.upgrade-backup`) &&
        readFileSync(`${ingress}.upgrade-backup`, 'utf-8') === custom;
      expect(kept || backedUp, `run ${run} lost the customised file`).toBe(true);
    }
    expect(readFileSync(ingress, 'utf-8')).toBe(custom);
    expect(readFileSync(`${ingress}.upgrade-new`, 'utf-8')).toBe(
      readFileSync(join(SVC, 'k8s', 'ingressroute.yaml'), 'utf-8'),
    );
  });

  it('two consecutive -y runs never lose a customised template file either', () => {
    // The same trap on a carbon/ file: a customised file with a stored hash
    // that no longer matches the template is left with .upgrade-new; the
    // recompute must keep the old stored hash, not record the customisation.
    const rel = 'docker-compose.prod.yml';
    const target = join(project, rel);
    const configPath = join(project, '.vibecarbon.json');
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    const olderTemplate = `${readFileSync(target, 'utf-8')}# older template\n`;
    config.fileChecksums = { ...(config.fileChecksums ?? {}), [rel]: hashContent(olderTemplate) };
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const custom = `${olderTemplate}# site-specific\n`;
    writeFileSync(target, custom);

    for (const run of [1, 2]) {
      const r = runCli('upgrade', ['-y'], { cwd: project, timeoutMs: 120_000 });
      if (r.exitCode === null) throw new Error(`upgrade ${run} timed out:\n${r.stderr}`);
      assertSuccess(r);
      expect(readFileSync(target, 'utf-8'), `run ${run}`).toBe(custom);
    }
  });

  it('never writes through a symlinked path inside the project', () => {
    installStaleObservability(project, { recordChecksums: true });
    // The add-on's k8s dir is replaced by a symlink to a directory outside
    // the project: upgrade must not write there.
    const outside = createTempDir('vc-upgrade-outside-');
    const obs = join(project, 'k8s', 'base', 'observability');
    for (const f of ['kustomization.yaml', 'ingressroute.yaml']) {
      writeFileSync(join(outside, f), 'outside\n');
    }
    rmSync(obs, { recursive: true, force: true });
    symlinkSync(outside, obs);

    const r = runCli('upgrade', ['-y'], { cwd: project, timeoutMs: 120_000 });
    if (r.exitCode === null) throw new Error(`upgrade timed out:\n${r.stderr}`);
    assertSuccess(r);

    expect(readdirSync(outside).sort()).toEqual(['ingressroute.yaml', 'kustomization.yaml']);
    for (const f of ['kustomization.yaml', 'ingressroute.yaml']) {
      expect(readFileSync(join(outside, f), 'utf-8')).toBe('outside\n');
    }
    expect(r.stdout + r.stderr).toMatch(/symlink/i);
  });

  describe('a sidecar path that is a symlink', () => {
    function plantSidecarLink(rel: string, suffix: '.upgrade-backup' | '.upgrade-new') {
      const outside = createTempDir('vc-upgrade-sidecar-');
      const target = join(outside, 'target');
      writeFileSync(target, 'outside\n');
      symlinkSync(target, join(project, `${rel}${suffix}`));
      return target;
    }

    it('-y skips an unrecorded add-on file whose .upgrade-backup is a symlink', () => {
      installStaleObservability(project, { recordChecksums: false });
      const rel = 'k8s/base/observability/ingressroute.yaml';
      const before = readFileSync(join(project, rel), 'utf-8');
      const target = plantSidecarLink(rel, '.upgrade-backup');
      const r = runCli('upgrade', ['-y'], { cwd: project, timeoutMs: 120_000 });
      assertSuccess(r);
      expect(readFileSync(target, 'utf-8')).toBe('outside\n');
      expect(readFileSync(join(project, rel), 'utf-8')).toBe(before);
      expect(r.stdout + r.stderr).toMatch(/symlink/i);
    });

    it('-force skips a modified file whose .upgrade-backup is a symlink', () => {
      const rel = 'docker-compose.yml';
      const custom = `${readFileSync(join(project, rel), 'utf-8')}\n# local drift\n`;
      writeFileSync(join(project, rel), custom);
      const target = plantSidecarLink(rel, '.upgrade-backup');
      const r = runCli('upgrade', ['-force', '-y'], { cwd: project, timeoutMs: 120_000 });
      assertSuccess(r);
      expect(readFileSync(target, 'utf-8')).toBe('outside\n');
      expect(readFileSync(join(project, rel), 'utf-8')).toBe(custom);
    });

    it('-y does not write a review file through a symlinked .upgrade-new', () => {
      installStaleObservability(project, { recordChecksums: true });
      const rel = 'k8s/base/observability/ingressroute.yaml';
      writeFileSync(join(project, rel), `${readFileSync(join(project, rel), 'utf-8')}# mine\n`);
      const target = plantSidecarLink(rel, '.upgrade-new');
      const r = runCli('upgrade', ['-y'], { cwd: project, timeoutMs: 120_000 });
      assertSuccess(r);
      expect(readFileSync(target, 'utf-8')).toBe('outside\n');
    });
  });

  it('-y skips a file whose .upgrade-backup path is a directory', () => {
    installStaleObservability(project, { recordChecksums: false });
    const rel = 'k8s/base/observability/ingressroute.yaml';
    const before = readFileSync(join(project, rel), 'utf-8');
    mkdirSync(join(project, `${rel}.upgrade-backup`));
    const r = runCli('upgrade', ['-y'], { cwd: project, timeoutMs: 120_000 });
    assertSuccess(r);
    expect(readFileSync(join(project, rel), 'utf-8')).toBe(before);
    expect(r.stdout + r.stderr).toMatch(/upgrade-backup/);
  });

  it('drops the checksums of files no longer shipped, keeps those of files still shipped but skipped', () => {
    installStaleObservability(project, { recordChecksums: true });
    const configPath = join(project, '.vibecarbon.json');
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    // A path neither the template nor an installed add-on ships any more.
    config.fileChecksums['retired/old-file.yml'] = hashContent('old\n');
    // A still-shipped template file left alone (customised over an older
    // template): its previous checksum must survive.
    const rel = 'docker-compose.prod.yml';
    const older = `${readFileSync(join(project, rel), 'utf-8')}# older template\n`;
    config.fileChecksums[rel] = hashContent(older);
    writeFileSync(join(project, rel), `${older}# site-specific\n`);
    // An installed add-on's integration doc (never upgraded, still shipped).
    config.fileChecksums['observability-integration.md'] = hashContent('doc\n');
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

    assertSuccess(runCli('upgrade', ['-y'], { cwd: project, timeoutMs: 120_000 }));

    const after = JSON.parse(readFileSync(configPath, 'utf-8')).fileChecksums;
    expect(after['retired/old-file.yml']).toBeUndefined();
    expect(after[rel]).toBe(hashContent(older));
    expect(after['observability-integration.md']).toBe(hashContent('doc\n'));
  });
});

// A project that ran `vibecarbon configure cicd` before the template moved
// Traefik's image to the version set. configure rewrote the Flux cluster
// files (and the app's image refs) to the real GitHub owner, so upgrade read
// them as edited by the user: `-y` only wrote .upgrade-new beside them, while
// k8s/base/traefik/deployment.yaml (untouched) was replaced with its
// `{{TRAEFIK_IMAGE}}` token. Flux then applied ./k8s/base with the old
// cluster files, which do not strip the Traefik Deployment, and shipped the
// literal placeholder.
describe('vibecarbon upgrade after configure cicd', () => {
  const OWNER = 'acme';
  const CLUSTERS = ['primary', 'standby'];
  const TRAEFIK = 'k8s/base/traefik/deployment.yaml';
  const fluxFile = (cluster: string) => `k8s/flux/clusters/${cluster}/vibecarbon.yaml`;
  const TRAEFIK_STRIP =
    / {4}# Traefik's image comes from[\s\S]*?\n {6}target:\n {8}kind: Deployment\n {8}name: traefik\n/;

  let project: string;
  let stubs: ExecStubs;
  beforeEach(() => {
    project = realProject();
    stubs = installExecStubs([
      { command: 'gh', matches: /^auth status/, respond: { exitCode: 0 } },
      {
        command: 'gh',
        matches: /^repo view/,
        respond: { stdout: JSON.stringify({ owner: { login: OWNER }, name: 'test-app' }) },
      },
    ]);
  });
  afterEach(() => {
    stubs.teardown();
    destroyRealProject(project);
  });

  const read = (rel: string) => readFileSync(join(project, rel), 'utf-8');
  /**
   * The current template's copy of a file as create lays it down (owner and
   * repo both the project name), then with the GitHub refs configure points
   * at the real owner: the image and clone URLs, not prose.
   */
  const shipped = (rel: string, owner: string) =>
    readFileSync(join(process.cwd(), 'carbon', rel), 'utf-8')
      .replaceAll('{{GITHUB_OWNER}}', 'test-app')
      .replaceAll('{{PROJECT_NAME}}', 'test-app')
      .replaceAll('github.com/test-app/test-app', `github.com/${owner}/test-app`)
      .replaceAll('ghcr.io/test-app/test-app', `ghcr.io/${owner}/test-app`);

  /**
   * Turn the fresh project into one created before the Traefik move: a literal
   * image in the base Deployment, Flux cluster files that do not strip it, and
   * the checksums that older create recorded for them.
   */
  function createdBeforeTheTraefikMove() {
    const aged: Record<string, string> = {
      [TRAEFIK]: read(TRAEFIK).replace('"{{TRAEFIK_IMAGE}}"', 'traefik:v3.6.11'),
    };
    for (const cluster of CLUSTERS) {
      aged[fluxFile(cluster)] = read(fluxFile(cluster)).replace(TRAEFIK_STRIP, '');
    }
    const configPath = join(project, '.vibecarbon.json');
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    for (const [rel, text] of Object.entries(aged)) {
      expect(text, `${rel} aged`).not.toBe(read(rel));
      writeFileSync(join(project, rel), text);
      config.fileChecksums[rel] = hashContent(text);
    }
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  }

  function configureCicd() {
    const r = runCli('configure', ['cicd'], { cwd: project, execStubs: stubs, timeoutMs: 60_000 });
    assertSuccess(r);
    for (const cluster of CLUSTERS) {
      expect(read(fluxFile(cluster))).toContain(`url: https://github.com/${OWNER}/test-app`);
    }
  }

  it('-y replaces the Flux cluster files configure rewrote, keeping the real owner', () => {
    createdBeforeTheTraefikMove();
    configureCicd();

    const r = runCli('upgrade', ['-y'], { cwd: project, timeoutMs: 120_000 });
    if (r.exitCode === null) throw new Error(`upgrade timed out:\n${r.stderr}`);
    assertSuccess(r);

    // The base moved to the version-set token, as it did before this fix...
    expect(read(TRAEFIK)).toContain('"{{TRAEFIK_IMAGE}}"');
    // ...and the Flux cluster files moved with it, so Flux strips the
    // Traefik Deployment instead of applying the literal token. The owner
    // configure found stays: a reverted github.com/test-app/test-app URL is
    // a GitRepository that 403s on every clone.
    for (const cluster of CLUSTERS) {
      expect(read(fluxFile(cluster)), cluster).toBe(shipped(fluxFile(cluster), OWNER));
      expect(existsSync(join(project, `${fluxFile(cluster)}.upgrade-new`)), cluster).toBe(false);
    }
    expect(read('k8s/base/app/deployment.yaml')).toContain(`image: ghcr.io/${OWNER}/test-app:main`);
  });

  it('a Flux file the user changed is offered with the real owner, and upgrade says Flux would apply the token', () => {
    createdBeforeTheTraefikMove();
    configureCicd();
    const primary = fluxFile('primary');
    const custom = `${read(primary)}# site-specific\n`;
    writeFileSync(join(project, primary), custom);

    const r = runCli('upgrade', ['-y'], { cwd: project, timeoutMs: 120_000 });
    if (r.exitCode === null) throw new Error(`upgrade timed out:\n${r.stderr}`);
    assertSuccess(r);

    // Kept as the user had it; the version on offer (what Replace writes)
    // points at the owner configure found, not github.com/test-app/test-app.
    expect(read(primary)).toBe(custom);
    expect(read(`${primary}.upgrade-new`)).toBe(shipped(primary, OWNER));
    // The other cluster file was the CLI's own, so it moved.
    expect(read(fluxFile('standby'))).toBe(shipped(fluxFile('standby'), OWNER));
    // The kept file still builds the Traefik Deployment with its token:
    // upgrade names the file, the token and the file to review.
    const out = (r.stdout + r.stderr).replace(/\s+/g, ' ');
    expect(out).toContain(`${TRAEFIK} would reach the cluster with {{TRAEFIK_IMAGE}}`);
    expect(out).toContain(`${primary}.upgrade-new`);
  });

  it('records the workflows configure installs, so the next upgrade can replace them', () => {
    configureCicd();
    const recorded = JSON.parse(read('.vibecarbon.json')).fileChecksums;
    for (const rel of ['.github/workflows/deploy.yml', '.github/workflows/vibecarbon-build.yml']) {
      expect(recorded[rel], rel).toBe(hashContent(read(rel)));
    }
    expect(JSON.parse(read('.vibecarbon.json')).github).toEqual({ owner: OWNER, repo: 'test-app' });
  });

  it('replaces a workflow configure installed before it recorded checksums, keeping a backup', () => {
    // Every project that ran configure cicd before this change has its
    // deploy.yml with no checksum. Left as it was, the workflow keeps
    // applying k8s/infra/traefik-crds raw, and upgrade just moved that file
    // to its {{TRAEFIK_VERSION}} token.
    configureCicd();
    const rel = '.github/workflows/deploy.yml';
    const older = read(rel).replace(/\n {6}- name: Install cert-manager[\s\S]*?\n\n/, '\n');
    expect(older).not.toBe(read(rel));
    writeFileSync(join(project, rel), older);
    const configPath = join(project, '.vibecarbon.json');
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    delete config.fileChecksums[rel];
    delete config.fileChecksums['.github/workflows/vibecarbon-build.yml'];
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const r = runCli('upgrade', ['-y'], { cwd: project, timeoutMs: 120_000 });
    if (r.exitCode === null) throw new Error(`upgrade timed out:\n${r.stderr}`);
    assertSuccess(r);

    expect(read(rel)).toBe(readFileSync(join(process.cwd(), 'carbon', rel), 'utf-8'));
    expect(read(`${rel}.upgrade-backup`)).toBe(older);
    expect(existsSync(join(project, `${rel}.upgrade-new`))).toBe(false);
  });
});

// The same trap from `vibecarbon add`: it lists the add-on in
// k8s/base/kustomization.yaml, so upgrade read the file as the user's once
// the template moved, and Replace (the interactive default) wrote the
// template's copy without the entry. Flux prunes what leaves its build, so
// the add-on went with it.
describe('vibecarbon upgrade after vibecarbon add', () => {
  const REL = 'k8s/base/kustomization.yaml';
  let project: string;
  beforeEach(() => {
    project = realProject();
  });
  afterEach(() => {
    destroyRealProject(project);
  });

  it('-y replaces a base kustomization only add edited, and keeps the add-on entry', () => {
    assertSuccess(runCli('add', ['redis', '-y'], { cwd: project, timeoutMs: 30_000 }));
    const path = join(project, REL);
    expect(readFileSync(path, 'utf-8')).toContain('  - redis/\n');

    // As if the project came from an older template: the stored checksum is
    // of that older file, and add's entry sits on top of it.
    const older = (text: string) => text.replace('labels:', '# older template\nlabels:');
    writeFileSync(path, older(readFileSync(path, 'utf-8')));
    const configPath = join(project, '.vibecarbon.json');
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    config.fileChecksums[REL] = hashContent(
      older(readFileSync(join(process.cwd(), 'carbon', REL), 'utf-8')),
    );
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const r = runCli('upgrade', ['-y'], { cwd: project, timeoutMs: 120_000 });
    if (r.exitCode === null) throw new Error(`upgrade timed out:\n${r.stderr}`);
    assertSuccess(r);

    const after = readFileSync(path, 'utf-8');
    expect(after).not.toContain('# older template');
    expect(after).toContain('  - traefik/\n  - redis/\n\nlabels:');
    expect(existsSync(`${path}.upgrade-new`)).toBe(false);
    // Recorded without add's entry, like create recorded it.
    expect(JSON.parse(readFileSync(configPath, 'utf-8')).fileChecksums[REL]).toBe(
      hashContent(readFileSync(join(process.cwd(), 'carbon', REL), 'utf-8')),
    );
  });
});
