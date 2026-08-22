import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load as loadYaml } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import {
  loadScalewayComposeUserData,
  renderScalewayUserData,
} from '../../../src/lib/iac/programs/scaleway-compose.js';

const CLOUD_INIT_PATH = join(process.cwd(), 'carbon', 'cloud-init', 'docker-ce-setup.yaml');
const PROGRAM_PATH = join(process.cwd(), 'src', 'lib', 'iac', 'programs', 'scaleway-compose.js');
const sharedCloudInit = readFileSync(CLOUD_INIT_PATH, 'utf-8');
const programSource = readFileSync(PROGRAM_PATH, 'utf-8');

// Same parity check as the DO/Linode/Vultr splices: `ubuntu_noble` ships no
// Docker (the Docker InstantApp's base OS is unpinnable — audit), so the
// Docker-CE install must land in `runcmd:` BEFORE the shared file's
// `systemctl enable --now docker` step.
describe('renderScalewayUserData (cloud-init parity splice)', () => {
  it('produces syntactically valid cloud-config YAML', () => {
    const rendered = renderScalewayUserData(sharedCloudInit);
    expect(rendered.startsWith('#cloud-config')).toBe(true);
    const parsed = loadYaml(rendered.replace(/^#cloud-config\n/, '')) as {
      runcmd: unknown[];
    };
    expect(parsed).toBeTypeOf('object');
    expect(Array.isArray(parsed.runcmd)).toBe(true);
  });

  it('runs the Docker install steps BEFORE the shared file’s systemctl enable --now docker step', () => {
    const rendered = renderScalewayUserData(sharedCloudInit);
    const parsed = loadYaml(rendered.replace(/^#cloud-config\n/, '')) as {
      runcmd: unknown[][];
    };
    const runcmd = parsed.runcmd;
    const dockerEnableIdx = runcmd.findIndex(
      (step) => Array.isArray(step) && step.join(',') === 'systemctl,enable,--now,docker',
    );
    const installIdx = runcmd.findIndex(
      (step) => Array.isArray(step) && String(step.at(-1)).includes('docker-ce'),
    );
    expect(installIdx).toBeGreaterThanOrEqual(0);
    expect(dockerEnableIdx).toBeGreaterThan(installIdx);
  });

  it('fails loudly when the shared file loses its runcmd anchor', () => {
    expect(() => renderScalewayUserData('#cloud-config\npackages: []\n')).toThrow(/runcmd/);
  });
});

describe('loadScalewayComposeUserData (wire-encoding guard)', () => {
  it('renders ASCII-clean output — the plain-text wire contract holds today', () => {
    // Scaleway user data crosses the wire as PLAIN TEXT (no base64 leg,
    // gzip unsupported) — assertAsciiCloudInit inside the loader throws on
    // any non-ASCII byte, so a green run IS the byte-fidelity proof for
    // the current template.
    const rendered = loadScalewayComposeUserData();
    // biome-ignore lint/suspicious/noControlCharactersInRegex: byte-range check is the point
    expect(/[^\x00-\x7F]/.test(rendered)).toBe(false);
  });
});

// Source pins for wire-shape decisions that can't execute in a unit test
// (constructing Pulumi resources needs a live stack). Each pin names the
// failure it prevents; the audit is the source for every literal.
describe('scaleway-compose.js source pins', () => {
  it('pins deleteOnTermination: true EXPLICITLY on the SBS root volume (terminate only detaches sbs_volume)', () => {
    expect(programSource).toContain('deleteOnTermination: true');
  });

  it('spells volumeType with a provider ENUM VALUE, not a camelCased one', () => {
    // This pin previously asserted `volumeType: 'sbsVolume'` — it locked in a
    // typo and reported green while every Scaleway provision failed at the
    // API: "expected volume_type to be one of [...], got sbsVolume"
    // (CI run 31706718048). A source pin that only echoes the source proves
    // nothing; assert against the provider's ACCEPTED SET instead, so the
    // test can disagree with the code.
    //
    // Pulumi camelCases property NAMES (volume_type -> volumeType) but passes
    // enum VALUES through untouched, which is exactly why `sbsVolume` looked
    // right sitting next to `sizeInGb`.
    const ACCEPTED = ['l_ssd', 'b_ssd', 'unified', 'scratch', 'sbs_volume', 'sbs_snapshot'];
    const match = /volumeType:\s*'([^']+)'/.exec(programSource);
    expect(match, 'no volumeType literal found in scaleway-compose.js').not.toBeNull();
    const value = match?.[1] ?? '';
    expect(ACCEPTED, `volumeType '${value}' is not a value the provider accepts`).toContain(value);
    // The root volume must specifically be SBS — see the module header on why
    // terminate semantics differ per volume type.
    expect(value).toBe('sbs_volume');
  });

  it('pins the marketplace LABEL as the image (UUIDs are per-zone and per-volume-type)', () => {
    // Same independent-opinion rule as volumeType above: assert the SHAPE the
    // provider requires, not the literal the source happens to hold. Scaleway
    // marketplace labels are lowercase snake_case `distro_codename`
    // (`ubuntu_jammy`, `ubuntu_noble`) — a camelCased or hyphenated spelling is
    // rejected at provision time, and a bare UUID is wrong for a different
    // reason (UUIDs are per-zone AND per-volume-type, so a pinned one breaks
    // the moment either changes).
    const match = /image:\s*'([^']+)'/.exec(programSource);
    expect(match, 'no image literal found in scaleway-compose.js').not.toBeNull();
    const value = match?.[1] ?? '';

    expect(value, `image '${value}' is not a marketplace label`).toMatch(
      /^[a-z][a-z0-9]*_[a-z0-9_]+$/,
    );
    expect(value, `image '${value}' looks like a UUID, not a label`).not.toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-/i,
    );
    // Ubuntu LTS is the only base the cloud-init in this program is written
    // for (apt/`VERSION_CODENAME`/docker-ce repo layout).
    expect(value).toMatch(/^ubuntu_/);
    expect(value).toBe('ubuntu_noble');
  });

  it('delivers cloud-init under the `cloud-init` user-data key (the key-value store contract)', () => {
    expect(programSource).toContain("userData: { 'cloud-init': userData }");
  });

  it('uses the NAMESPACED exports with the audited casings (SshKey not SSHKey; Ip not IP)', () => {
    expect(programSource).toContain('new scaleway.iam.SshKey(');
    expect(programSource).toContain('new scaleway.instance.SecurityGroup(');
    expect(programSource).toContain('new scaleway.instance.Server(');
    expect(programSource).toContain('new scaleway.instance.Ip(');
    // The deprecated flat aliases must never be CONSTRUCTED (the module
    // doc mentions them by name to warn against them, so this pins the
    // constructor-call shape, not the bare token).
    expect(programSource).not.toContain('new scaleway.InstanceServer(');
    expect(programSource).not.toContain('new scaleway.IamSshKey(');
    expect(programSource).not.toContain('new scaleway.AccountSshKey(');
  });

  it('pins stateful: true and drop/accept default policies on the security group', () => {
    expect(programSource).toContain('stateful: true');

    // Provider ENUM VALUES — `inbound_default_policy` / `outbound_default_policy`
    // accept exactly `accept` or `drop` (Scaleway provider schema for
    // scaleway_instance_security_group). Asserting membership first means a
    // future edit to `'DROP'`, `'deny'`, or `'dropped'` fails HERE with a
    // readable message instead of at provision time — the volumeType lesson.
    const ACCEPTED = ['accept', 'drop'];
    const policies = {
      inboundDefaultPolicy: /inboundDefaultPolicy:\s*'([^']+)'/.exec(programSource)?.[1] ?? '',
      outboundDefaultPolicy: /outboundDefaultPolicy:\s*'([^']+)'/.exec(programSource)?.[1] ?? '',
    };
    for (const [field, value] of Object.entries(policies)) {
      expect(ACCEPTED, `${field} '${value}' is not a value the provider accepts`).toContain(value);
    }

    // And the SECURITY posture on top of validity: inbound is default-deny,
    // outbound is open. Reversing these would still be provider-valid, which
    // is exactly why validity alone is not enough of an opinion.
    expect(policies.inboundDefaultPolicy).toBe('drop');
    expect(policies.outboundDefaultPolicy).toBe('accept');
  });

  it('strips zoned composite ids to bare UUIDs for the frozen outputs', () => {
    // Zoned Pulumi resources carry `{zone}/{uuid}` ids; the REST paths the
    // outputs feed (destroy/scale/status) speak bare UUIDs.
    expect(programSource).toContain("String(id).split('/').pop()");
  });
});
