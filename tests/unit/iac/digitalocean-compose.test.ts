import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load as loadYaml } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import {
  buildDigitalOceanComposeProgram,
  renderDoUserData,
  transliterateToAscii,
} from '../../../src/lib/iac/programs/digitalocean-compose.js';

const CLOUD_INIT_PATH = join(process.cwd(), 'carbon', 'cloud-init', 'docker-ce-setup.yaml');
const sharedCloudInit = readFileSync(CLOUD_INIT_PATH, 'utf-8');

// Step 1 (blocking) parity check: Hetzner's `docker-ce` image ships Docker
// preinstalled, so the shared cloud-init's `systemctl enable --now docker`
// runcmd step assumes docker.service already exists. DigitalOcean's
// `ubuntu-24-04-x64` image does not ship Docker, so renderDoUserData()
// must splice an official-Docker-apt-repo install block into `runcmd:`
// BEFORE that step, or the droplet would boot with no `docker` command and
// the first `docker compose up` would fail.
describe('renderDoUserData (cloud-init parity splice)', () => {
  it('produces syntactically valid cloud-config YAML', () => {
    const rendered = renderDoUserData(sharedCloudInit);
    expect(rendered.startsWith('#cloud-config')).toBe(true);
    // Throws if the splice broke YAML syntax (e.g. bad indentation/quoting).
    const parsed = loadYaml(rendered.replace(/^#cloud-config\n/, ''));
    expect(parsed).toBeTypeOf('object');
    expect(Array.isArray(parsed.runcmd)).toBe(true);
  });

  it('runs the Docker install steps BEFORE the shared files systemctl enable --now docker step', () => {
    const rendered = renderDoUserData(sharedCloudInit);
    const parsed = loadYaml(rendered.replace(/^#cloud-config\n/, ''));
    const runcmd = parsed.runcmd;

    const dockerEnableIdx = runcmd.findIndex(
      (step) => Array.isArray(step) && step.join(',') === 'systemctl,enable,--now,docker',
    );
    const aptRepoIdx = runcmd.findIndex(
      (step) =>
        Array.isArray(step) &&
        step[0] === 'sh' &&
        typeof step[2] === 'string' &&
        step[2].includes('download.docker.com'),
    );
    // Matched on the package list, not on `apt-get install -y docker-ce` as a
    // contiguous string: the invocation carries `-o DPkg::Lock::Timeout=…`
    // between the subcommand and the flags (see src/lib/deploy/apt.js), and
    // pinning the contiguous spelling made this assertion a tripwire for an
    // unrelated option rather than for the install step's presence/ordering,
    // which is what it exists to check.
    const aptInstallIdx = runcmd.findIndex(
      (step) =>
        Array.isArray(step) &&
        step[0] === 'sh' &&
        typeof step[2] === 'string' &&
        /apt-get\b.*\binstall\b.*\bdocker-ce\b/.test(step[2]),
    );

    expect(dockerEnableIdx).toBeGreaterThan(-1);
    expect(aptRepoIdx).toBeGreaterThan(-1);
    expect(aptInstallIdx).toBeGreaterThan(-1);
    expect(aptRepoIdx).toBeLessThan(dockerEnableIdx);
    expect(aptInstallIdx).toBeLessThan(dockerEnableIdx);
  });

  it('the apt lock timeout survives the ASCII transliteration onto the wire', () => {
    // The census (apt-lock-timeout-census.test.ts) pins the SOURCE. This pins
    // the rendered artifact DO actually receives: renderDoUserData runs the
    // spliced YAML through transliterateToAscii, which replaces any unmapped
    // non-ASCII with '?'. The option is pure ASCII so it round-trips, but the
    // whole point of the DO path is that what we wrote is not always what
    // ships — so assert on the shipped bytes, not on the intent.
    const rendered = renderDoUserData(sharedCloudInit);
    const parsed = loadYaml(rendered.replace(/^#cloud-config\n/, ''));
    const aptSteps = parsed.runcmd.filter(
      (step) => Array.isArray(step) && typeof step[2] === 'string' && /\bapt-get\s/.test(step[2]),
    );
    expect(aptSteps.length).toBeGreaterThanOrEqual(2); // update + install
    for (const step of aptSteps) {
      expect(step[2]).toContain('-o DPkg::Lock::Timeout=');
    }
  });

  it('preserves every step of the shared file untouched (ufw rules, marker file, final_message)', () => {
    const rendered = renderDoUserData(sharedCloudInit);
    expect(rendered).toMatch(/ufw, allow, '22\/tcp'/);
    expect(rendered).toMatch(/ufw, allow, '80\/tcp'/);
    expect(rendered).toMatch(/ufw, allow, '443\/tcp'/);
    expect(rendered).toContain('/var/lib/vibecarbon/ready');
    expect(rendered).toContain('final_message:');
    expect(rendered).toContain('package_update: true');
  });

  // d1 e2e RCA pin: a live DigitalOcean droplet received user-data with the
  // shared template's em-dash comments DOUBLE-ENCODED (UTF-8 bytes
  // reinterpreted as Latin-1, then re-encoded to UTF-8 — e.g. em-dash
  // `E2 80 94` arriving as `C3 A2 C2 80 C2 94`). Decoded, that sequence
  // contains U+0080, a C1 control character the YAML spec forbids anywhere,
  // including comments. DO's cloud-init (PyYAML) rejected the entire
  // #cloud-config part with SCHEMA_ERROR, silently dropping the Docker
  // install steps and the ready-marker, and the deploy timed out at
  // cloudInitReady. js-yaml (used by the structural test above) tolerates
  // C1 chars, so that test alone can't catch this class of regression.
  //
  // Investigation note: the double-encoding could NOT be reproduced at the
  // file-read/splice/Droplet-userData-input boundary in this repo (see
  // b257af8) — exercising both the pure splice function and the full
  // builder produced clean, single-encoded UTF-8 throughout. Since the
  // downstream mangler (the vendored @pulumi/digitalocean/terraform-bridge
  // marshaling layer, or DO's own user-data ingestion) isn't reachable or
  // fixable from this repo, the fix below is a sidestep that's correct
  // regardless of which layer is responsible: renderDoUserData() now
  // transliterates its output to pure ASCII (see ASCII_TRANSLITERATION_MAP
  // in the source module), so there are no non-ASCII bytes left for any
  // downstream layer to double-encode.
  it('renders pure ASCII, with no C1 control characters and no Unicode replacement characters (YAML-legality pin)', () => {
    const rendered = renderDoUserData(sharedCloudInit);
    // Not a regex range check (biome's noControlCharactersInRegex disallows
    // \x00-\x7F literals) — same codePointAt approach transliterateToAscii
    // itself uses to decide what needs transliterating.
    const isAscii = [...rendered].every((ch) => ch.codePointAt(0) <= 0x7f);
    expect(isAscii).toBe(true);
    expect(rendered).not.toMatch(/[\u0080-\u009F]/);
    expect(rendered).not.toContain('\uFFFD');
  });

  it('preserves the shared files non-splice content exactly, modulo the documented ASCII transliteration (round-trip fidelity pin)', () => {
    const rendered = renderDoUserData(sharedCloudInit);
    const anchor = '\nruncmd:\n';
    const idx = sharedCloudInit.indexOf(anchor);
    const insertAt = idx + anchor.length;
    // Transliterated the same way renderDoUserData transliterates its own
    // output — this pin is about the splice preserving content, not
    // about re-litigating the ASCII-only invariant covered above.
    const before = transliterateToAscii(sharedCloudInit.slice(0, insertAt));
    const after = transliterateToAscii(sharedCloudInit.slice(insertAt));

    // JS-string equality first (cheap, readable failure diff)...
    expect(rendered.startsWith(before)).toBe(true);
    expect(rendered.endsWith(after)).toBe(true);

    // ...then a byte-level check: a latin1-reinterpret-then-utf8-reencode
    // corruption changes byte length and content while still round-tripping
    // through JS string comparisons if BOTH sides went through the same bad
    // transform. Comparing against independently-encoded bytes closes that
    // gap.
    const beforeBytes = Buffer.from(before, 'utf-8');
    const afterBytes = Buffer.from(after, 'utf-8');
    const renderedBytes = Buffer.from(rendered, 'utf-8');
    expect(renderedBytes.subarray(0, beforeBytes.length).equals(beforeBytes)).toBe(true);
    expect(
      renderedBytes.subarray(renderedBytes.length - afterBytes.length).equals(afterBytes),
    ).toBe(true);
  });

  it('the "?" fallback never fires on the current shared template (transliterated output introduces no "?")', () => {
    const rendered = renderDoUserData(sharedCloudInit);
    // The shared template itself contains no literal '?' today, so any '?'
    // in the rendered output would mean ASCII_TRANSLITERATION_MAP is
    // missing an entry for typography actually in use — this should
    // never fire, but if it does, the map (not the '?' fallback) is the fix.
    expect(sharedCloudInit).not.toContain('?');
    expect(rendered).not.toContain('?');
  });

  it('throws (fail loud) if the runcmd anchor is missing from the input', () => {
    expect(() => renderDoUserData('#cloud-config\npackages:\n  - ufw\n')).toThrow(/runcmd/);
  });

  it('stays comfortably under DigitalOceans 64KiB user_data cap', () => {
    const rendered = renderDoUserData(sharedCloudInit);
    expect(Buffer.byteLength(rendered, 'utf-8')).toBeLessThan(32 * 1024);
  });

  it('docker apt-repo runcmd contains unescaped VERSION_CODENAME quotes (no backslash-quotes)', () => {
    const rendered = renderDoUserData(sharedCloudInit);
    const parsed = loadYaml(rendered.replace(/^#cloud-config\n/, ''));
    const runcmd = parsed.runcmd;

    // Find the apt-repo echo runcmd step (contains download.docker.com AND echo)
    const aptRepoStep = runcmd.find(
      (step) =>
        Array.isArray(step) &&
        step[0] === 'sh' &&
        typeof step[2] === 'string' &&
        step[2].includes('download.docker.com') &&
        step[2].includes('echo'),
    );

    expect(aptRepoStep).toBeDefined();
    expect(Array.isArray(aptRepoStep)).toBe(true);

    const runcmdString = aptRepoStep[2];

    // Assert the runcmd does NOT contain escaped quotes (\")
    expect(runcmdString).not.toContain('\\"$VERSION_CODENAME\\"');

    // Assert the runcmd contains unescaped quotes around $VERSION_CODENAME
    expect(runcmdString).toContain('echo "$VERSION_CODENAME"');
  });
});

describe('buildDigitalOceanComposeProgram', () => {
  const baseConfig = {
    projectName: 'proj',
    environment: 'prod',
    sshPublicKey: 'ssh-ed25519 AAAAtest test@example.com',
    location: 'nyc3',
    serverType: 's-2vcpu-4gb',
    allowedSshIps: ['203.0.113.5/32'],
  };

  it('throws synchronously when allowedSshIps is empty (no silent open-firewall default)', () => {
    expect(() => buildDigitalOceanComposeProgram({ ...baseConfig, allowedSshIps: [] })).toThrow(
      /allowedSshIps required/,
    );
  });

  it('throws synchronously when allowedSshIps is omitted entirely', () => {
    const { allowedSshIps: _drop, ...withoutIps } = baseConfig;
    expect(() => buildDigitalOceanComposeProgram(withoutIps)).toThrow(/allowedSshIps required/);
  });

  it('returns an async program function when config is valid (does not invoke Pulumi yet)', () => {
    const program = buildDigitalOceanComposeProgram(baseConfig);
    expect(typeof program).toBe('function');
    expect(program.constructor.name).toBe('AsyncFunction');
  });
});
