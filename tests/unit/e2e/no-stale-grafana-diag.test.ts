import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('verification failure diagnostics', () => {
  it('no longer prints a grafana= line probing grafana.<domain>', () => {
    // That probe was written for the compose route; k8s serves Grafana at
    // /admin/grafana and both routes sit behind admin auth, so the line
    // printed a misleading code. feature-observability.ts checks Grafana for real.
    const src = readFileSync(join(__dirname, '../../e2e/scenarios/_run-lifecycle.ts'), 'utf-8');
    expect(src).not.toMatch(/grafana=\$\{/);
  });
});
