import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * deployK3s cannot be driven in a unit test (it provisions a cluster), so this
 * pins the one ordering that makes the k8s app image build free: it starts
 * BEFORE the Pulumi up and is handed to deliverAppImage afterwards. On the DO
 * e2e of 2026-10-31 the build ran after k3s was Ready, adding its whole
 * duration to the deploy; the up alone took 78 s, longer than a cold build.
 * startAppImageBuild / deliverAppImage behaviour: k3s-standby-image-delivery.test.ts.
 */
const SRC = readFileSync(join(__dirname, '../../../src/lib/deploy/k8s/k3s.js'), 'utf-8');

function functionBody(name: string) {
  const start = SRC.indexOf(`export async function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const next = SRC.indexOf('\nexport ', start + 1);
  return SRC.slice(start, next === -1 ? undefined : next);
}

describe('deployK3s starts the app image build before provisioning', () => {
  const body = functionBody('deployK3s');

  it('calls startAppImageBuild before the Pulumi up', () => {
    const start = body.indexOf('startAppImageBuild(');
    const up = body.indexOf('upStack(');
    expect(start).toBeGreaterThan(-1);
    expect(up).toBeGreaterThan(-1);
    expect(start).toBeLessThan(up);
  });

  it('hands the in-flight build to deliverAppImage', () => {
    const deliver = body.slice(body.indexOf('deliverAppImage({'));
    expect(deliver).toMatch(/^deliverAppImage\(\{[\s\S]*?earlyBuild[\s\S]*?\}\)/);
  });
});
