/**
 * `loadCloudInit()` include-directive resolution.
 *
 * The three Hetzner k3s role scripts (master/supabase/worker) each carry a
 * block that must be IDENTICAL across all three — the containerd registry
 * mirror already is, by hand-copied duplication, with a comment conceding
 * that "extracting a shared snippet would require restructuring the
 * renderScript() pipeline".
 *
 * The private-NIC guard (RCA 2026-08-05) is ~150 lines of that same
 * three-way-identical shape, which is too much to keep in sync by hand. So
 * loadCloudInit() now resolves a `# @include <file>` directive at load time.
 * Doing it in loadCloudInit — rather than as a renderScript var — is the
 * whole point: EVERY consumer of these templates goes through loadCloudInit
 * (hetzner-k8s.js's Pulumi render, the HetznerProvider/DigitalOceanProvider
 * user-data statics, and renderCarbonAutoscalerConfig's node template), so
 * no call site can forget to supply it. A `${placeholder}` would have to be
 * plumbed to each one, and the one that forgot would ship a literal
 * `${private_ip}` into a `set -u` script — a fatal unbound-variable abort on
 * a node nobody is watching.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadCloudInit, resolveIncludes } from '../../../src/lib/iac/cloud-init.js';

const tmpDirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vc-cloud-init-'));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

describe('loadCloudInit include directive', () => {
  it("replaces a `# @include <file>` line with that file's contents", () => {
    const dir = scratch();
    writeFileSync(join(dir, 'snippet.sh'), 'echo shared\n');
    writeFileSync(join(dir, 'role.sh'), 'echo before\n# @include snippet.sh\necho after\n');
    expect(resolveIncludes('role.sh', dir)).toBe('echo before\necho shared\necho after\n');
  });

  it('resolves every occurrence, not just the first', () => {
    const dir = scratch();
    writeFileSync(join(dir, 'snippet.sh'), 'X\n');
    writeFileSync(join(dir, 'role.sh'), '# @include snippet.sh\nmid\n# @include snippet.sh\n');
    expect(resolveIncludes('role.sh', dir)).toBe('X\nmid\nX\n');
  });

  it('tolerates a missing trailing newline in the included snippet (no line-joining)', () => {
    const dir = scratch();
    writeFileSync(join(dir, 'snippet.sh'), 'X');
    writeFileSync(join(dir, 'role.sh'), '# @include snippet.sh\nafter\n');
    expect(resolveIncludes('role.sh', dir)).toBe('X\nafter\n');
  });

  it('throws naming both files when the included snippet does not exist', () => {
    const dir = scratch();
    writeFileSync(join(dir, 'role.sh'), '# @include nope.sh\n');
    expect(() => resolveIncludes('role.sh', dir)).toThrow(/nope\.sh/);
    expect(() => resolveIncludes('role.sh', dir)).toThrow(/role\.sh/);
  });

  it('rejects a directive that escapes the cloud-init directory (path traversal)', () => {
    const dir = scratch();
    writeFileSync(join(dir, 'role.sh'), '# @include ../../../etc/passwd\n');
    // SECURITY: the directive is repo-authored, not user input, but a
    // basename-only contract keeps it that way by construction.
    expect(() => resolveIncludes('role.sh', dir)).toThrow(/basename|traversal|invalid/i);
  });

  it('leaves a script with no directive byte-identical', () => {
    const dir = scratch();
    writeFileSync(join(dir, 'role.sh'), '#!/bin/bash\necho hi\n');
    expect(resolveIncludes('role.sh', dir)).toBe('#!/bin/bash\necho hi\n');
  });

  it('every shipped k3s template loads with all directives resolved', () => {
    for (const name of [
      'master-init.sh',
      'supabase-init.sh',
      'worker-init.sh',
      'do-master-init.sh',
      'do-supabase-init.sh',
      'do-worker-init.sh',
    ]) {
      expect(loadCloudInit(name), name).not.toMatch(/^#\s*@include\b/m);
    }
  });
});
